// Спільна логіка медіа-сховища: файли на диску (Docker-volume) + метадані в media_asset.
// Використовують і аплоад (server.ts), і Google Drive поллер.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, createReadStream } from "node:fs";
import { writeFile, unlink, readFile, stat, open, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import heicConvert from "heic-convert";
import sharp from "sharp";
import { q, one } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = join(__dirname, "..", "media");
mkdirSync(MEDIA_DIR, { recursive: true });
const THUMB_DIR = join(MEDIA_DIR, "thumbs");
mkdirSync(THUMB_DIR, { recursive: true });

// ---- 🎬 відео: ffprobe/ffmpeg (є в образі - apk ffmpeg; локально може не бути - тоді відео просто
// без мініатюри й тривалості, а не з помилкою) ----
function runTool(cmd: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; let err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd}: timeout`)); }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d) => { err = (err + d).slice(-400); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exit ${code}: ${err}`)); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

export type VideoInfo = { duration: number; width: number; height: number; vcodec: string; acodec: string | null };
// Тривалість і розмір кадру - так, як відео ПОКАЗУЄТЬСЯ: телефон пише вертикальне відео як
// горизонтальне з поміткою «повернути на 90°», тож без урахування повороту 9:16 читалось би як 16:9.
export async function probeVideo(file: string): Promise<VideoInfo | null> {
  try {
    const j = JSON.parse((await runTool("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], 20000)).toString("utf8"));
    const streams: any[] = j.streams || [];
    const v = streams.find((x) => x.codec_type === "video");
    if (!v) return null;
    const a = streams.find((x) => x.codec_type === "audio");
    let w = Number(v.width) || 0, h = Number(v.height) || 0;
    const sd = (v.side_data_list || []).find((x: any) => x && x.rotation != null);
    const rot = Math.abs(Number(v.tags?.rotate ?? sd?.rotation ?? 0)) % 180;
    if (rot === 90) [w, h] = [h, w];
    const duration = parseFloat(j.format?.duration ?? v.duration) || 0;
    return { duration: Math.round(duration * 100) / 100, width: w, height: h, vcodec: String(v.codec_name || ""), acodec: a ? String(a.codec_name || "") : null };
  } catch { return null; }
}

// ffprobe є? (в образі - так; локально може не бути). Без нього не міряємо й не бракуємо відео -
// інакше на машині без ffmpeg відкидалось би будь-яке відео.
let _probeOk: Promise<boolean> | null = null;
export const ffprobeAvailable = (): Promise<boolean> =>
  (_probeOk ??= runTool("ffprobe", ["-version"], 10000).then(() => true, () => false));
// Байти кажуть «відео», але ffprobe не знаходить у ньому відеопотоку - пошкоджений файл або щось
// інше під чужим заголовком. Такий файл упав би лише при публікації, через кілька хвилин обробки в
// мережі; відкидаємо одразу, людською мовою.
const BROKEN_VIDEO = "файл схожий на відео, але не читається (пошкоджений чи обрізаний) - перезбережи або експортуй його ще раз";

// кадр відео для мініатюри: 1-ша секунда (перший кадр часто чорний), коротке відео - нульова
// Кадр для мініатюри відео - не більше 2 ffmpeg одночасно: /thumb відкритий без входу (його тягнуть
// прев'ю Mini App і мережі), тож сотня запитів на різні відео не має запускати сотню процесів.
// Слот передається наступному в черзі напряму; задовга черга - одразу без кадру (плитка з заглушкою).
let framesBusy = 0;
const frameQueue: Array<() => void> = [];
async function withFrameSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (framesBusy >= 2) {
    if (frameQueue.length >= 50) return null;
    await new Promise<void>((r) => frameQueue.push(r));
  } else framesBusy++;
  try { return await fn(); }
  finally { const next = frameQueue.shift(); if (next) next(); else framesBusy--; }
}

function videoFrame(file: string): Promise<Buffer | null> {
  return withFrameSlot(() => videoFrameNow(file)).then((b) => b ?? null);
}
async function videoFrameNow(file: string): Promise<Buffer | null> {
  for (const ss of ["1", "0"]) {
    try {
      const buf = await runTool("ffmpeg", ["-v", "error", "-ss", ss, "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], 30000);
      if (buf.length > 100) return buf;
    } catch { /* пробуємо інший момент або здаємось */ }
  }
  return null;
}

export const VIDEO_FILE_RX = /\.(mp4|mov|m4v|webm|quick)$/i;
// розширення за mime: .mov/.mp4, а не обрізане «quick» - за розширенням /media/ віддає Content-Type,
// і Meta/Telegram тягнуть відео за адресою
const EXT_BY_MIME: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "image/jpeg": "jpeg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic" };
const extFor = (mime: string) => EXT_BY_MIME[mime] || (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";

// Мініатюра (≤400px, JPEG) з диск-кешем — щоб бібліотека/сітки не вантажили повні зображення.
// Для відео - кадр із ролика (ffmpeg), інакше в медіатеці й на картці замість відео була б дірка.
export async function getThumb(name: string): Promise<Buffer | null> {
  const safe = (name || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe.includes("..")) return null;
  const out = join(THUMB_DIR, safe + ".jpg");
  try { return await readFile(out); } catch { /* ще нема — генеруємо */ }
  try {
    const src = join(MEDIA_DIR, safe);
    await stat(src); // переконатися, що оригінал існує
    const input = VIDEO_FILE_RX.test(safe) ? await videoFrame(src) : src;
    if (!input) return null;
    const buf = await sharp(input).resize(400, 400, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    writeFile(out, buf).catch(() => {}); // кеш на диск, не блокуючи відповідь
    return buf;
  } catch { return null; }
}

// Магічні байти замість заявленого mime. Список короткий і свідомий: те, що реально показують
// мережі й обробляє sharp/ffmpeg. Усе інше - відмова з людською причиною.
export function sniffKind(b: Buffer): { kind: "image" | "video"; mime: string } | null {
  if (!b || b.length < 12) return null;
  const hex = (o: number, n: number) => b.subarray(o, o + n).toString("hex");
  const asc = (o: number, n: number) => b.subarray(o, o + n).toString("latin1");
  if (hex(0, 3) === "ffd8ff") return { kind: "image", mime: "image/jpeg" };
  if (hex(0, 8) === "89504e470d0a1a0a") return { kind: "image", mime: "image/png" };
  if (asc(0, 4) === "GIF8") return { kind: "image", mime: "image/gif" };
  if (asc(0, 4) === "RIFF" && asc(8, 4) === "WEBP") return { kind: "image", mime: "image/webp" };
  if (asc(4, 4) === "ftyp") {
    const brand = asc(8, 4).toLowerCase();
    if (/^(heic|heix|hevc|mif1|msf1|heim|heis)/.test(brand)) return { kind: "image", mime: "image/heic" };
    if (/^(qt)/.test(brand)) return { kind: "video", mime: "video/quicktime" };
    return { kind: "video", mime: "video/mp4" };   // isom, mp42, avc1, M4V тощо
  }
  if (hex(0, 4) === "1a45dfa3") return { kind: "video", mime: "video/webm" };
  return null;
}

export async function saveMedia(
  ws: string,
  opts: { buffer: Buffer; mime: string; name?: string; source?: string; externalId?: string; dedupe?: boolean }
): Promise<{ id: string; filename: string; kind: string; existed?: boolean }> {
  // dedupe: той самий файл удруге не зберігається - відбиток вмісту лягає в external_id, і за ним
  // знаходиться вже збережена копія. Без цього перезапуск заливки папки (обірвався інтернет, Claude
  // повторив команду) подвоював би медіатеку. Відбиток - від ОРИГІНАЛЬНИХ байтів, до конвертації
  // HEIC, тож однаковий файл збігається завжди; джерело теж у ключі, щоб фото з медіатеки не
  // «знаходилось» замість b-roll і навпаки.
  const hash = opts.dedupe ? "sha256:" + createHash("sha256").update(opts.buffer).digest("hex") : null;
  if (hash) {
    const had = await one<{ id: string; filename: string; kind: string }>(
      `select id, filename, kind from media_asset where workspace_id=$1 and source=$2 and external_id=$3 limit 1`,
      [ws, opts.source || "upload", hash]);
    if (had) return { ...had, existed: true };
  }
  let buffer = opts.buffer;
  let mime = opts.mime || "application/octet-stream";
  const nm = String(opts.name || "").toLowerCase();
  // iPhone HEIC/HEIF -> JPEG (браузер їх не показує, Meta не приймає)
  if (/heic|heif/.test(mime) || nm.endsWith(".heic") || nm.endsWith(".heif")) {
    try {
      const out = await heicConvert({ buffer, format: "JPEG", quality: 0.9 });
      buffer = Buffer.from(out as ArrayBuffer);
      mime = "image/jpeg";
    } catch { /* конвертація не вдалась — зберігаємо як є */ }
  }
  // Тип визначаємо ЗА ВМІСТОМ, а не за заявленим Content-Type: HTML під виглядом image/jpeg
  // зберігався як .jpeg і лежав у бібліотеці сміттям, а прев'ю на ньому падало (спіймано аудитом).
  // nosniff і правильний Content-Type рятували від XSS, але не від сміття й не від бінарників.
  const sniffed = sniffKind(buffer);
  if (!sniffed) throw new Error("Це не зображення і не відео - приймаємо JPG, PNG, WebP, GIF, HEIC, MP4, MOV, WebM");
  if (sniffed.mime !== mime) mime = sniffed.mime;   // довіряємо байтам, не заголовку
  const id = randomUUID();
  const filename = `${id}.${extFor(mime)}`;
  await writeFile(join(MEDIA_DIR, filename), buffer);
  const kind = sniffed.kind;
  const vi = kind === "video" ? await probeVideo(join(MEDIA_DIR, filename)) : null;
  if (kind === "video" && !vi && await ffprobeAvailable()) { await unlink(join(MEDIA_DIR, filename)).catch(() => {}); throw new Error(BROKEN_VIDEO); }
  await q(
    `insert into media_asset(id, workspace_id, kind, mime, original_name, filename, size, source, external_id, duration, width, height)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, ws, kind, mime, String(opts.name || "").slice(0, 200), filename, buffer.length, opts.source || "upload", opts.externalId || hash,
     vi?.duration ?? null, vi?.width ?? null, vi?.height ?? null]
  );
  return { id, filename, kind };
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve()).on("error", reject);
  });
  return h.digest("hex");
}

/**
 * Зберегти вже зібраний на диску файл (заливка частинами). Фото йде звичайним saveMedia (HEIC →
 * JPEG, розмір невеликий), а відео - переноситься без читання в памʼять: 500 МБ у буфері на кожну
 * заливку поклали б процес. Відбиток для дедупу рахується потоком і збігається з тим, що дав би
 * saveMedia на тих самих байтах, тож повтор тієї самої папки копій не робить незалежно від шляху.
 */
export const IMAGE_MAX_BYTES = 60 * 1024 * 1024;
export async function saveMediaFile(ws: string, path: string, opts: { name?: string; source?: string; dedupe?: boolean }):
  Promise<{ id: string; filename: string; kind: string; existed?: boolean }> {
  const head = Buffer.alloc(64);
  const fh = await open(path, "r");
  try { await fh.read(head, 0, 64, 0); } finally { await fh.close(); }
  const sniffed = sniffKind(head);
  if (!sniffed) { await unlink(path).catch(() => {}); throw new Error("Це не зображення і не відео - приймаємо JPG, PNG, WebP, GIF, HEIC, MP4, MOV, WebM"); }
  if (sniffed.kind === "image") {
    try {
      // фото обробляється в памʼяті (sharp, HEIC → JPEG), тож межа тут своя, а не 500 МБ від відео:
      // інакше «фото» на сотні МБ, зібране частинами, виїло б памʼять сервера
      if ((await stat(path)).size > IMAGE_MAX_BYTES) throw new Error(`Фото більше за ${IMAGE_MAX_BYTES / 1024 / 1024} МБ - стисни його або збережи як JPEG`);
      return await saveMedia(ws, { buffer: await readFile(path), mime: sniffed.mime, name: opts.name, source: opts.source, dedupe: opts.dedupe });
    }
    finally { await unlink(path).catch(() => {}); }
  }
  const source = opts.source || "upload";
  const hash = opts.dedupe ? "sha256:" + await sha256File(path) : null;
  if (hash) {
    const had = await one<{ id: string; filename: string; kind: string }>(
      `select id, filename, kind from media_asset where workspace_id=$1 and source=$2 and external_id=$3 limit 1`, [ws, source, hash]);
    if (had) { await unlink(path).catch(() => {}); return { ...had, existed: true }; }
  }
  const id = randomUUID();
  const filename = `${id}.${extFor(sniffed.mime)}`;
  const dest = join(MEDIA_DIR, filename);
  await rename(path, dest);
  const size = (await stat(dest)).size;
  const vi = await probeVideo(dest);
  if (!vi && await ffprobeAvailable()) { await unlink(dest).catch(() => {}); throw new Error(BROKEN_VIDEO); }
  await q(
    `insert into media_asset(id, workspace_id, kind, mime, original_name, filename, size, source, external_id, duration, width, height)
     values($1,$2,'video',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, ws, sniffed.mime, String(opts.name || "").slice(0, 200), filename, size, source, hash, vi?.duration ?? null, vi?.width ?? null, vi?.height ?? null]);
  return { id, filename, kind: "video" };
}

/**
 * Разово: відео, збережені раніше з обрізаним розширенням «.quick» (MOV), дістають «.mov» - за
 * розширенням /media/ віддає Content-Type, а Instagram/Facebook тягнуть відео саме за адресою.
 * І дописуємо тривалість/розмір кадру відео, яких тоді ще не міряли. Ідемпотентно.
 */
export async function fixLegacyVideos(): Promise<number> {
  let n = 0;
  const rows = await q<{ id: string; filename: string; duration: number | null }>(
    `select id, filename, duration from media_asset where kind='video' and (filename ilike '%.quick' or duration is null) limit 500`);
  for (const r of rows) {
    try {
      let fn = r.filename;
      if (/\.quick$/i.test(fn)) {
        const next = fn.replace(/\.quick$/i, ".mov");
        await rename(join(MEDIA_DIR, fn), join(MEDIA_DIR, next));
        await q(`update media_asset set filename=$2, mime='video/quicktime' where id=$1`, [r.id, next]);
        await q(`update post set reel_video=$2 where reel_video=$1`, [fn, next]).catch(() => {});
        fn = next; n++;
      }
      if (r.duration == null) {
        const vi = await probeVideo(join(MEDIA_DIR, fn));
        // не змогли виміряти (нема ffprobe / битий файл) - ставимо 0, щоб не пробувати щостарту
        await q(`update media_asset set duration=$2, width=$3, height=$4 where id=$1`, [r.id, vi?.duration ?? 0, vi?.width ?? null, vi?.height ?? null]);
      }
    } catch { /* файл зник - пропускаємо */ }
  }
  return n;
}

export async function deleteMediaFile(filename: string): Promise<void> {
  try { await unlink(join(MEDIA_DIR, filename)); } catch { /* файл міг бути вже видалений */ }
}

// Одноразова конвертація залишкових HEIC/HEIF -> JPEG (ідемпотентно: після неї HEIF не лишається).
export async function convertAllHeif(): Promise<number> {
  const rows = await q<{ id: string; filename: string }>(
    `select id, filename from media_asset where mime ilike '%hei%' or filename ilike '%.heif' or filename ilike '%.heic'`);
  let n = 0;
  for (const r of rows) {
    try {
      const buf = await readFile(join(MEDIA_DIR, r.filename));
      const out = Buffer.from(await heicConvert({ buffer: buf, format: "JPEG", quality: 0.9 }) as ArrayBuffer);
      const newName = `${randomUUID()}.jpeg`;
      await writeFile(join(MEDIA_DIR, newName), out);
      await q(`update media_asset set filename=$2, mime='image/jpeg', size=$3 where id=$1`, [r.id, newName, out.length]);
      try { await unlink(join(MEDIA_DIR, r.filename)); } catch { /* старий міг зникнути */ }
      n++;
    } catch { /* пропускаємо файл, який не вдалося прочитати/сконвертувати */ }
  }
  return n;
}
