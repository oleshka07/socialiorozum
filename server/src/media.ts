// Спільна логіка медіа-сховища: файли на диску (Docker-volume) + метадані в media_asset.
// Використовують і аплоад (server.ts), і Google Drive поллер.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { writeFile, unlink, readFile, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import heicConvert from "heic-convert";
import sharp from "sharp";
import { q, one } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = join(__dirname, "..", "media");
mkdirSync(MEDIA_DIR, { recursive: true });
const THUMB_DIR = join(MEDIA_DIR, "thumbs");
mkdirSync(THUMB_DIR, { recursive: true });

// Мініатюра (≤400px, JPEG) з диск-кешем — щоб бібліотека/сітки не вантажили повні зображення.
export async function getThumb(name: string): Promise<Buffer | null> {
  const safe = (name || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe.includes("..")) return null;
  const out = join(THUMB_DIR, safe + ".jpg");
  try { return await readFile(out); } catch { /* ще нема — генеруємо */ }
  try {
    await stat(join(MEDIA_DIR, safe)); // переконатися, що оригінал існує
    const buf = await sharp(join(MEDIA_DIR, safe)).resize(400, 400, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
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
  const ext = (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
  const id = randomUUID();
  const filename = `${id}.${ext}`;
  await writeFile(join(MEDIA_DIR, filename), buffer);
  const kind = sniffed.kind;
  await q(
    `insert into media_asset(id, workspace_id, kind, mime, original_name, filename, size, source, external_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ws, kind, mime, String(opts.name || "").slice(0, 200), filename, buffer.length, opts.source || "upload", opts.externalId || hash]
  );
  return { id, filename, kind };
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
