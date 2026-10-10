// 🎬 Монтаж: кліпи (і фото) з медіатеки → вертикальне відео 9:16 із субтитрами - сторіс чи рілс.
//
// Звідки текст на відео (voice):
//  - none   - без голосу: підписи, які дав автор чи Claude до кожного кліпу; звук кліпів лишається;
//  - clips  - говорить сам кліп: розшифровуємо його звук і показуємо субтитри слово в слово;
//  - audio  - окремий запис голосу (голосове з Telegram, диктофон): він - озвучка, кліпи під нього;
//  - tts    - AI-голос (ElevenLabs, запасний Azure) читає текст кожного кліпу або весь сценарій.
// Субтитри - караоке (поточне слово кольором) там, де є час слів, інакше - підписи шматками.
//
// Сервер спільний з іншими проєктами, тож ffmpeg іде з nice і двома потоками, а монтаж - по одному:
// черга до 4 робіт, решті - «спробуй за кілька хвилин».
import { actorId, mayAutoApprove } from "./actor.js";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { q, one } from "./db.js";
import { env } from "./env.js";
import { MEDIA_DIR, probeVideo, probeAudio, saveMediaFile, saveMedia, deleteMediaAsset } from "./media.js";
import { transcribeWords } from "./stt.js";
import { synthesizeAll, composeMusic } from "./tts.js";
import { chat, extractJsonObject } from "./openrouter.js";
import { getSettingText } from "./settings.js";
import { startJob, type JobRow } from "./jobs.js";
import { setPostMediaOrder, setPostVideo, dropUnusedDerived, postMediaList } from "./slides.js";
import { logEvent } from "./log.js";
import * as P from "./montage-plan.js";

export type MontageClipIn = { id: string; from?: number | null; to?: number | null; text?: string | null; seconds?: number | null };
export type VoiceMode = "none" | "clips" | "audio" | "tts";
export type SubMode = "karaoke" | "lines" | "none";
export type MontageFormat = "story" | "reel";
export type MontageOpts = {
  clips: MontageClipIn[];
  voice: VoiceMode;
  audio?: string | null;       // id запису голосу (voice: audio)
  script?: string | null;      // увесь текст озвучки одним шматком (voice: tts) - замість text кліпів
  voiceId?: string | null;     // голос ElevenLabs
  subtitles?: SubMode | null;
  keepSound?: boolean | null;  // звук кліпів тихо під озвучкою
  format: MontageFormat;
  lang?: string | null;        // код мови; без нього - мова контенту кабінету
  // voice: clips, а мови в кліпах не чути - AI пише підписи з кадрів (режим бота «як вийде»)
  autoCaptions?: boolean | null;
  transition?: P.TransitionMode | null;  // переходи між кадрами (типово - плавні)
  smart?: boolean | null;                // шукати в кліпах найкращі моменти (типово так); false - середина кліпу
  music?: string | null;                 // фонова музика: id треку з медіатеки
  musicMood?: P.MusicMood | null;        // або AI-музика ElevenLabs під настрій (платно, ~$0.15/хв)
  // 🎬 v3
  template?: P.TemplateId | null;        // 🧩 шаблон: standard (типово) | before_after | talking | process
  hook?: string | boolean | null;        // 🪝 гачок: свій текст, true/"auto" - AI з тексту ролика, false - без; типово - як у стилі бренду
  endCard?: boolean | string | null;     // 🏁 фінальна картка: true - з налаштувань бренду, рядок - свій текст, false - без
  cutPauses?: boolean | null;            // ✂️ вирізати паузи й «еее» в кліпах, де говорять (voice: clips; типово так)
  subStyle?: P.SubPreset | null;         // 🔤 стиль субтитрів (типово - стиль бренду)
  subPos?: P.SubPos | null;              // низ | центр
  color?: string | null;                 // колір бренду (#RRGGBB) - плашка гачка, «після», слово в субтитрах
  beforeCount?: number | null;           // ↔️ скільки перших кліпів - «до» (типово половина)
  // 🔤 мовні версії: мови субтитрів, яких треба ще (крім мови, якою говорять). Не задано - мови мереж зі
  // «Стилю відео» бренду; [] - без версій
  subLangs?: string[] | null;
};
export type MontageVideo = { id: string; filename: string; duration: number };
export type MontageVariant = { lang: string; videos: MontageVideo[] };
export type MontageResult = {
  videos: MontageVideo[]; duration: number; transcript: string; subtitles: SubMode; voice: VoiceMode;
  provider?: string; warnings: string[]; clips: number; postId?: string | null;
  transition?: P.TransitionMode; music?: string; smart?: number;   // що зроблено: переходи, музика, скільки кліпів «розумно» обрізано
  template?: P.TemplateId; hook?: string; endCard?: boolean; style?: P.SubPreset;
  cut?: { clips: number; saved: number };              // ✂️ з кількох кліпів вирізано паузи і скільки секунд
  cover?: { id: string; filename: string } | null;     // 🖼 обкладинка рілса (кадр із гачком)
  lang?: string | null;                                // 🔤 мова субтитрів оригіналу (null - тексту на відео нема)
  variants?: MontageVariant[];                         // 🔤 ті самі відео з субтитрами іншими мовами
};
export class MontageError extends Error {}

// Робоча тека - на тому ж томі, що й медіатека: готове відео ПЕРЕНОСИТЬСЯ в медіатеку (rename), а
// між /tmp контейнера і томом Docker rename не працює (різні файлові системи).
const WORK_DIR = join(MEDIA_DIR, "tmp", "montage");
/** Теки монтажу, що лишились після падіння процесу посеред роботи, - геть (старші за 3 год). */
export async function sweepMontageTmp(maxAgeMs = 3 * 3600_000): Promise<number> {
  let n = 0;
  for (const f of await readdir(WORK_DIR).catch(() => [] as string[])) {
    const p = join(WORK_DIR, f);
    try { if (Date.now() - (await stat(p)).mtimeMs > maxAgeMs) { await rm(p, { recursive: true, force: true }); n++; } } catch { /* уже нема */ }
  }
  return n;
}

export const MONTAGE_MAX_CLIPS = 20;
export const MONTAGE_MAX_SEC = 180;
export const STORY_PART_SEC = 59.5;
// більше кадрів - це вже не монтаж, а одна секунда відео по колу хвилину: краще сказати людині
const MONTAGE_MAX_SHOTS = 200;
const secs = (x: number) => x < 60 ? `${Math.round(x)} с` : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
const W = 1080, H = 1920, FPS = 30;

// ---- запуск ffmpeg ----
function spawnRun(cmd: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; let err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd}: не вклався в ${Math.round(timeoutMs / 1000)} с`)); }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d) => { err = (err + d).slice(-800); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} ${code}: ${err.trim().slice(-500)}`)); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}
let niceOk: boolean | null = null;
async function ff(args: string[], cwd?: string, timeoutMs = 600000): Promise<Buffer> {
  if (niceOk === null) niceOk = await spawnRun("nice", ["-n", "10", "true"], undefined, 5000).then(() => true, () => false);
  const base = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args];
  return niceOk ? spawnRun("nice", ["-n", "10", "ffmpeg", ...base], cwd, timeoutMs) : spawnRun("ffmpeg", base, cwd, timeoutMs);
}

// ---- черга: один монтаж за раз ----
let busy = false;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) {
    if (waiters.length >= 4) throw new MontageError("Сервер зараз монтує інші відео - спробуй за кілька хвилин");
    await new Promise<void>((r) => waiters.push(r));
  }
  busy = true;
  try { return await fn(); }
  finally { const next = waiters.shift(); if (next) next(); else busy = false; }
}

// ---- джерела ----
// path - файл не з медіатеки, а з робочої теки монтажу (кліп із вирізаними паузами)
type Src = { id: string; filename: string; kind: "video" | "image"; duration: number; width: number; height: number; audio: boolean; name: string; path?: string };
const shortId = (id: string) => "#" + String(id).slice(0, 8);
const srcPath = (s: Src) => s.path || join(MEDIA_DIR, s.filename);

async function loadSources(ws: string, ids: string[]): Promise<Src[]> {
  const rows = await q<{ id: string; filename: string; kind: string; original_name: string | null }>(
    `select id, filename, kind, original_name from media_asset where workspace_id=$1 and id = any($2::uuid[])`, [ws, [...new Set(ids)]]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Src[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) throw new MontageError(`Файлу ${shortId(id)} у медіатеці цього кабінету немає.`);
    if (r.kind === "audio") throw new MontageError(`${shortId(id)} - це запис голосу: передай його як озвучку (audio), а не як кліп.`);
    const path = join(MEDIA_DIR, r.filename);
    if (r.kind === "video") {
      const v = await probeVideo(path);
      if (!v || !(v.duration > 0.2)) throw new MontageError(`Відео ${shortId(id)} не читається - перезалий його.`);
      out.push({ id, filename: r.filename, kind: "video", duration: v.duration, width: v.width, height: v.height, audio: !!v.acodec, name: r.original_name || "" });
    } else {
      const m = await sharp(path).rotate().metadata().catch(() => null);
      if (!m?.width || !m?.height) throw new MontageError(`Фото ${shortId(id)} не читається - перезалий його.`);
      // після rotate() метадані дають розмір ДО повороту - EXIF 5-8 міняють сторони місцями
      const swap = (m.orientation || 1) >= 5;
      out.push({ id, filename: r.filename, kind: "image", duration: Infinity, width: swap ? m.height : m.width, height: swap ? m.width : m.height, audio: false, name: r.original_name || "" });
    }
  }
  return out;
}

// ---- 1. сегмент на кліп: 1080×1920, 30 к/с, стерео 48 кГц ----
const coverChain = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
// горизонтальний кадр не ріжемо навпіл: він стоїть посередині на розмитому тлі з себе самого
const padChain = (inLabel: string, outLabel: string) =>
  `${inLabel}split=2[bg0][fg0];[bg0]${coverChain},boxblur=luma_radius=40:luma_power=2,eq=brightness=-0.06[bg];[fg0]scale=${W}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${outLabel}`;
const isPortrait = (s: Src) => s.height > 0 && s.width / s.height <= 0.8;

// ✨ вхід кадру переходом: із ОСТАННЬОГО кадру попереднього сегмента (frame) - xfade name тривалістю d
type Enter = { name: string; d: number; frame: string };
const still2 = (enter?: Enter | null): string[] => enter ? ["-loop", "1", "-framerate", String(FPS), "-t", enter.d.toFixed(3), "-i", enter.frame] : [];
const withEnter = (graph: string, idx: number, enter?: Enter | null): string => !enter ? graph
  : graph.replace(/\[v\]$/, "[vn]") + `;[${idx}:v]scale=${W}:${H},fps=${FPS},format=yuv420p,setsar=1,settb=AVTB[pv];[vn]settb=AVTB[vn2];[pv][vn2]xfade=transition=${enter.name}:duration=${enter.d.toFixed(3)}:offset=0[v]`;

async function renderSegment(dir: string, i: number, src: Src, fit: { offset: number; take: number; speed: number; freeze: number }, dur: number, withSound: boolean, enter?: Enter | null): Promise<string> {
  const out = `seg${i}.mp4`;
  const d = dur.toFixed(3);

  const enc = ["-t", d, "-r", String(FPS), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-g", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-threads", "2", out];
  if (src.kind === "image") {
    // орієнтацію з EXIF ffmpeg для фото не застосовує - нормалізуємо sharp-ом
    const still = `still${i}.jpg`;
    await sharp(srcPath(src)).rotate().resize(2160, 3840, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(join(dir, still));
    const frames = Math.max(1, Math.round(dur * FPS));
    const graph = isPortrait(src)
      // вертикальне фото - повільне наближення (Ken Burns): статичний кадр у відео виглядає як зависання
      ? `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='min(zoom+0.0006,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p,setsar=1[v]`
      : `${padChain("[0:v]", "")},format=yuv420p,setsar=1[v]`;
    const input = isPortrait(src) ? ["-i", still] : ["-loop", "1", "-framerate", String(FPS), "-t", d, "-i", still];
    await ff([...input, "-f", "lavfi", "-t", d, "-i", "anullsrc=r=48000:cl=stereo", ...still2(enter), "-filter_complex", withEnter(graph, 2, enter), "-map", "[v]", "-map", "1:a", ...enc], dir);
    return out;
  }
  const pre = fit.speed !== 1 ? `setpts=${fit.speed}*PTS,` : "";
  // запас стоп-кадру: навіть якщо відеопотік кліпу коротший, ніж каже контейнер, сегмент рівно dur (-t
  // обрізає), і наступний кліп стає на своє місце на таймлайні
  const tail = `fps=${FPS},format=yuv420p,setsar=1,tpad=stop_mode=clone:stop_duration=${(fit.freeze + 0.5).toFixed(3)}[v]`;
  const vg = isPortrait(src) ? `[0:v]${pre}${coverChain},${tail}` : `${padChain(`[0:v]${pre}`, ",")}${tail}`.replace(",,", ",");
  // звук кліпу - лише коли він іде у звичайній швидкості (сповільнений голос звучить як зі старого магнітофона)
  const sound = withSound && src.audio && fit.speed === 1;
  // мʼякі краї звуку (20-40 мс): на стику кліпів не клацає
  const ag = sound ? `;[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${d},afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, dur - 0.04).toFixed(3)}:d=0.04[a]` : "";
  const args = ["-ss", fit.offset.toFixed(3), "-t", fit.take.toFixed(3), "-i", srcPath(src)];
  if (!sound) args.push("-f", "lavfi", "-t", d, "-i", "anullsrc=r=48000:cl=stereo");
  await ff([...args, ...still2(enter), "-filter_complex", withEnter(vg, sound ? 1 : 2, enter) + ag, "-map", "[v]", "-map", sound ? "[a]" : "1:a", ...enc], dir);
  return out;
}

/** Останній кадр сегмента - з нього заходить перехід наступного. */
async function lastFrame(dir: string, seg: string, i: number | string): Promise<string> {
  const out = `last${i}.jpg`;
  await ff(["-sseof", "-0.4", "-i", seg, "-an", "-update", "1", "-q:v", "2", out], dir, 60000);
  return out;
}

// ---- 🎯 найкращі моменти: 4 кадри на секунду - різкість, світло, рух (див. P.momentScores) ----
const STAT_STEP = 0.25;
async function analyzeClip(dir: string, src: Src, from: number, avail: number, i: number): Promise<number[] | null> {
  const out = `stats${i}.txt`;
  try {
    await ff(["-ss", from.toFixed(3), "-t", avail.toFixed(3), "-i", srcPath(src), "-an", "-threads", "2",
      "-vf", `fps=${1 / STAT_STEP},scale=270:-2,signalstats,blurdetect,metadata=print:file=${out}`, "-f", "null", "-"], dir, 180000);
    const stats = P.parseFrameStats(await readFile(join(dir, out), "utf8"));
    const sc = P.momentScores(stats, avail);
    return sc.length >= 3 ? sc : null;
  } catch { return null; }   // аналіз - покращення, не умова: не вийшов - беремо середину, як раніше
}

// ---- 2. голос: доріжка рівно на тривалість ролику ----
const LOUD = "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000";   // loudnorm віддає 192 кГц - повертаємо 48
async function buildVoiceTrack(dir: string, parts: Array<{ file: string; at: number }>, total: number): Promise<string> {
  const out = "voice.wav";
  const inputs = parts.flatMap((p) => ["-i", p.file]);
  const chains = parts.map((p, k) => `[${k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)}[p${k}]`);
  const mix = parts.length > 1
    ? `${parts.map((_, k) => `[p${k}]`).join("")}amix=inputs=${parts.length}:duration=longest:dropout_transition=0:normalize=0,`
    : `[p0]`;
  const graph = `${chains.join(";")};${mix}${parts.length > 1 ? "" : "anull,"}apad,atrim=0:${total.toFixed(3)},${LOUD}[a]`;
  await ff([...inputs, "-filter_complex", graph, "-map", "[a]", "-c:a", "pcm_s16le", out], dir);
  return out;
}

async function extractSpeech(dir: string, input: string | string[], out = "speech.m4a"): Promise<Buffer> {
  await ff([...(Array.isArray(input) ? input : ["-i", input]), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", out], dir);
  return readFile(join(dir, out));
}

// ---- 3. AI-текст із кадрів (коли тексту не дав ні автор, ні Claude) ----
async function frameAt(file: string, t: number, width: number): Promise<Buffer | null> {
  try {
    const buf = await spawnRun("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", Math.max(0, t).toFixed(2), "-i", file, "-frames:v", "1",
      "-vf", `scale=${width}:-2`, "-f", "image2pipe", "-vcodec", "mjpeg", "-"], undefined, 30000);
    return buf.length > 100 ? buf : null;
  } catch { return null; }
}

/**
 * Підписи (captions) або закадровий текст (voiceover) до кожного кліпу - з того, що видно в кадрах,
 * мовою контенту кабінету. Дешева модель, що бачить картинки: 3 кадри на відео, 1 на фото.
 */
export async function aiClipTexts(ws: string, srcs: Src[], durs: number[], mode: "captions" | "voiceover", hint = ""): Promise<string[]> {
  const images: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < srcs.length; i++) {
    const s = srcs[i];
    const shots: Buffer[] = [];
    if (s.kind === "image") {
      const b = await sharp(srcPath(s)).rotate().resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer().catch(() => null);
      if (b) shots.push(b);
    } else {
      for (const k of [0.2, 0.5, 0.8]) { const b = await frameAt(srcPath(s), s.duration * k, 384); if (b) shots.push(b); }
    }
    const from = images.length + 1;
    for (const b of shots) images.push("data:image/jpeg;base64," + b.toString("base64"));
    const words = Math.max(3, Math.round(durs[i] * 2.4));
    lines.push(`Кліп ${i + 1}: ${durs[i].toFixed(1)} с, кадри ${from}-${images.length}${mode === "voiceover" ? `, ≈${words} слів` : ""}`);
  }
  const lang = (await getSettingText(ws, "output_language")) || "Українська";
  const ctx = ((await getSettingText(ws, "marketing_context")) || "").slice(0, 500);
  const tone = ((await getSettingText(ws, "tone_of_voice_derived")) || (await getSettingText(ws, "tone_of_voice")) || "").slice(0, 300);
  const what = mode === "captions"
    ? "короткий підпис на екран до КОЖНОГО кліпу: до 42 символів, одна думка, можна одне емодзі на весь ролик"
    : "текст закадрового голосу до КОЖНОГО кліпу: розмовно, як людина розповідає другові, стільки слів, скільки вказано для кліпу";
  const system = `Ти монтажер коротких вертикальних відео (сторіс, рілс) для соцмереж бренду. Бачиш кадри кожного кліпу по порядку. Напиши ${what}. Мова тексту: ${lang}. Лише те, що видно в кадрі, і загальні знання ніші: жодних вигаданих цін, цифр, імен, дат, адрес. Перший кліп - гачок, що чіпляє увагу; останній - мʼякий заклик (написати, зберегти, подивитись), якщо він доречний. Без хештегів і лапок. Поверни JSON {"texts": ["…"]} - рівно ${srcs.length} рядків, по одному на кліп, по порядку.`;
  const user = [ctx ? `Бренд: ${ctx}` : "", tone ? `Голос бренду: ${tone}` : "", hint ? `Побажання автора: ${hint.slice(0, 500)}` : "", "", ...lines].filter((x) => x !== undefined).join("\n");
  const model = env.cheapModel.startsWith("claude-cli/") ? "openai/gpt-4o-mini" : env.cheapModel;
  const raw = await chat(model, system, user, { workspaceId: ws, step: "montage_text", json: true, maxTokens: 300 + srcs.length * 120, images });
  let texts: string[] = [];
  try { const j = extractJsonObject<{ texts?: unknown }>(raw); texts = Array.isArray(j.texts) ? j.texts.map((x) => String(x ?? "").trim()) : []; } catch { /* нижче */ }
  if (!texts.some(Boolean)) throw new MontageError("AI не зміг написати текст до кадрів - спробуй ще раз або дай свій текст.");
  return srcs.map((_, i) => (texts[i] || "").slice(0, mode === "captions" ? 80 : 600));
}

// ---- 4. аркуш кадрів: подивитись відео, не дивлячись його ----
const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** n кадрів рівномірно по відео - сіткою з часом кожного кадру (для Claude й перевірки результату). */
export async function contactSheet(file: string, duration: number, n = 8, tile = 270): Promise<{ jpeg: Buffer; times: number[] } | null> {
  const count = Math.max(1, Math.min(12, Math.round(n)));
  const times = Array.from({ length: count }, (_, k) => Math.min(Math.max(0, duration - 0.15), duration * (k + 0.5) / count));
  const frames: Array<{ buf: Buffer; t: number }> = [];
  for (const t of times) { const b = await frameAt(file, t, tile); if (b) frames.push({ buf: b, t }); }
  if (!frames.length) return null;
  const meta = await sharp(frames[0].buf).metadata();
  const th = Math.max(120, Math.min(480, Math.round(tile * (meta.height || tile) / (meta.width || tile))));
  const cols = frames.length <= 4 ? frames.length : 4;
  const rows = Math.ceil(frames.length / cols);
  const gap = 4;
  const comps: sharp.OverlayOptions[] = [];
  for (let k = 0; k < frames.length; k++) {
    const x = (k % cols) * (tile + gap), y = Math.floor(k / cols) * (th + gap);
    comps.push({ input: await sharp(frames[k].buf).resize(tile, th, { fit: "cover" }).toBuffer(), left: x, top: y });
    const label = fmtT(frames[k].t);
    comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="70" height="30"><rect width="70" height="30" rx="6" fill="rgba(0,0,0,0.65)"/><text x="35" y="21" font-family="DejaVu Sans, sans-serif" font-size="17" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text></svg>`), left: x + 6, top: y + 6 });
  }
  const jpeg = await sharp({ create: { width: cols * tile + (cols - 1) * gap, height: rows * th + (rows - 1) * gap, channels: 3, background: "#111" } })
    .composite(comps).jpeg({ quality: 72 }).toBuffer();
  return { jpeg, times: frames.map((f) => f.t) };
}

/** Що говорять у відео - рядками з часом (для Claude, щоб текст збігався з мовою кадру). */
export async function clipSpeech(ws: string, file: string): Promise<{ lines: string[]; text: string } | null> {
  const dir = await mkdtemp(join(tmpdir(), "speech-"));
  try {
    const buf = await extractSpeech(dir, file).catch(() => null);
    if (!buf) return { lines: [], text: "" };
    // мова, якою говорять у кліпах (стиль відео бренду), інакше мова контенту бренду
    const lang = (await montageStyle(ws)).speech || P.langCode(await getSettingText(ws, "output_language"));
    const r = await transcribeWords(buf, "speech.m4a", ws, lang);
    if (!r) return null;
    const words = r.provider === "whisper" ? P.restorePunct(r.words, r.text) : r.words;
    const cues = P.groupCues(words, { maxChars: 60, maxWords: 14, maxDur: 5 });
    return { lines: cues.map((c) => `[${fmtT(c.start)}] ${c.words.map((w) => w.w).join(" ")}`), text: r.text || P.wordsText(words) };
  } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// ---- 5. v3: стиль бренду, вирізання пауз, кадр порівняння, фінальна картка, гачок, обкладинка ----

/** 🎨 Стиль відео бренду (Бренд → Візуал → «🎬 Стиль відео»): субтитри, колір, гачок, фінальна картка, паузи. */
export async function montageStyle(ws: string): Promise<P.MontageStyle> {
  let raw: unknown = null;
  try { raw = JSON.parse((await getSettingText(ws, "montage_style")) || "null"); } catch { raw = null; }
  return P.normMontageStyle(raw);
}

/** Текст фінальної картки: свій (стиль бренду чи виклик) або назва кабінету й нік в Instagram/Threads. */
export async function brandEndText(ws: string, custom?: string | null): Promise<P.EndText | null> {
  if (String(custom || "").trim()) return P.endCardText({ custom });
  const w = await one<{ title: string | null }>(`select title from workspace where id=$1`, [ws]);
  const m = await one<{ ig_username: string | null; page_name: string | null }>(`select ig_username, page_name from meta_config where workspace_id=$1`, [ws]);
  const th = await one<{ username: string | null }>(`select username from threads_config where workspace_id=$1`, [ws]);
  return P.endCardText({ title: w?.title || m?.page_name || "", handle: m?.ig_username || th?.username || "" });
}

const ENC = (d: string, out: string) => ["-t", d, "-r", String(FPS), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-g", String(FPS),
  "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-threads", "2", out];

/**
 * ✂️ Кліп без пауз і «еее»: лишаємо шматки keeps (секунди від from) і склеюємо їх. Кожен другий шматок
 * трохи ближче (×1,08) - стик тоді читається як зміна плану, а не як «стрибок» кадру (так монтують
 * блогери). Звук на кожному стику - з мʼякими краями 20-30 мс, щоб не клацало.
 */
async function tightenClip(dir: string, i: number, src: Src, from: number, keeps: P.Keep[]): Promise<string> {
  const out = `tight${i}.mp4`;
  const W0 = Math.max(2, src.width - (src.width % 2)), H0 = Math.max(2, src.height - (src.height % 2));
  const K = keeps.length;
  const g = [`[0:v]split=${K}${keeps.map((_, k) => `[s${k}]`).join("")}`, `[0:a]asplit=${K}${keeps.map((_, k) => `[t${k}]`).join("")}`];
  keeps.forEach(([a, b], k) => {
    const zoom = k % 2 === 1 ? `,scale=${Math.round(W0 * 1.08 / 2) * 2}:-2,crop=${W0}:${H0}` : "";
    g.push(`[s${k}]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS${zoom},scale=${W0}:${H0},setsar=1[v${k}]`);
    g.push(`[t${k}]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, b - a - 0.03).toFixed(3)}:d=0.03[a${k}]`);
  });
  g.push(keeps.map((_, k) => `[v${k}][a${k}]`).join("") + `concat=n=${K}:v=1:a=1[v][a]`);
  await ff(["-ss", from.toFixed(3), "-t", (keeps[K - 1][1] + 0.2).toFixed(3), "-i", srcPath(src), "-filter_complex", g.join(";"),
    "-map", "[v]", "-map", "[a]", "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-threads", "2", out], dir);
  return out;
}

/** Нерухомий кадр як сегмент із повільним наближенням: blur - тло фінальної картки (розмите й притемнене). */
async function stillSegment(dir: string, name: string, image: string, dur: number, blur: boolean, enter?: Enter | null): Promise<string> {
  const out = `${name}.mp4`, d = dur.toFixed(3);
  const frames = Math.max(1, Math.round(dur * FPS));
  const soft = blur ? "boxblur=luma_radius=26:luma_power=2,eq=brightness=-0.2:saturation=0.8," : "";
  const graph = `[0:v]scale=${W}:${H},${soft}zoompan=z='min(zoom+0.0005,1.04)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p,setsar=1[v]`;
  await ff(["-i", image, "-f", "lavfi", "-t", d, "-i", "anullsrc=r=48000:cl=stereo", ...still2(enter), "-filter_complex", withEnter(graph, 2, enter), "-map", "[v]", "-map", "1:a", ...ENC(d, out)], dir);
  return out;
}

/** ↔️ Кадр порівняння: середина кадру «до» зверху, «після» - знизу, між ними біла лінія. */
async function compareImage(dir: string, before: string, after: string): Promise<string> {
  const out = "compare.jpg", h2 = H / 2;
  await ff(["-i", before, "-i", after, "-filter_complex",
    `[0:v]scale=${W}:${H},crop=${W}:${h2}:0:${H / 4}[a];[1:v]scale=${W}:${H},crop=${W}:${h2}:0:${H / 4}[b];[a][b]vstack,drawbox=x=0:y=${h2 - 3}:w=${W}:h=6:color=white@0.9:t=fill[v]`,
    "-map", "[v]", "-frames:v", "1", "-q:v", "2", out], dir, 60000);
  return out;
}
export const COMPARE_SEC = 2.6;

/**
 * 🪝 Гачок з тексту ролика: 3-7 слів мовою самого тексту (чеський ролик в українському бренді - чеською),
 * дешевою моделлю. Не вийшло - перше речення тексту.
 */
async function autoHook(ws: string, text: string, lang: string): Promise<string> {
  const src = String(text || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  if (!src) return "";
  const model = env.cheapModel.startsWith("claude-cli/") ? "openai/gpt-4o-mini" : env.cheapModel;
  const system = "Ти пишеш ГАЧОК - великий текст на перші 2 секунди вертикального відео (рілс чи сторіс), щоб людина не гортала далі. " +
    `3-7 слів. Мовою тексту ролика нижче - не перекладай (якщо мову не визначити - ${P.BA_WORDS[lang] ? lang : "uk"}). ` +
    "Конкретика з цього тексту: що відбувається, результат, цифра чи несподіванка; не загальні фрази й не кліше («Ви не повірите», «Дивись до кінця»). " +
    "Без лапок, хештегів, емодзі й крапки в кінці; жодних фактів, яких нема в тексті. Поверни JSON {\"hook\": \"...\"}.";
  try {
    const raw = await chat(model, system, src, { workspaceId: ws, step: "montage_hook", json: true, maxTokens: 80 });
    const h = P.cleanHook(extractJsonObject<{ hook?: unknown }>(raw).hook);
    if (h) return h;
  } catch { /* нижче - без моделі */ }
  return P.hookFallback(src);
}

// ---- 🔤 переклад субтитрів для мовної версії ----
/**
 * Рядки субтитрів (картки по черзі, речення може тягнутись через кілька карток) і гачок - іншою мовою,
 * рядок у рядок. Дешева модель, один виклик на мову. Модель повернула не стільки рядків - перекладаємо
 * текст цілим і ділимо пропорційно довжині карток (P.spreadByWeights): гірше, але жодна картка не лишається
 * мовою оригіналу.
 */
export async function translateSubs(ws: string, texts: string[], from: string, to: string): Promise<string[]> {
  const idx = texts.map((t, i) => (String(t || "").trim() ? i : -1)).filter((i) => i >= 0);
  const out = texts.map(() => "");
  if (!idx.length) return out;
  const items = idx.map((i) => String(texts[i]).replace(/\s+/g, " ").trim());
  const name = (l: string) => P.SUB_LANGS[l]?.label || l;
  const model = env.cheapModel.startsWith("claude-cli/") ? "openai/gpt-4o-mini" : env.cheapModel;
  const chars = items.reduce((a, t) => a + t.length, 0);
  const system = `Ти перекладаєш субтитри короткого вертикального відео (сторіс, рілс) з мови «${name(from)}» на «${name(to)}». ` +
    "Рядки - шматки мовлення по черзі (речення може тягнутись через кілька рядків), останній рядок може бути гачком-заголовком. " +
    `Переклади так, щоб разом вони читались природно мовою «${name(to)}», а кожен рядок передавав ту саму частину змісту, що й оригінал, ` +
    "і був не довшим за нього більш ніж на третину - субтитри треба встигнути прочитати. Розмовно, як людина говорить; не додавай і не " +
    "пропускай змісту, не обʼєднуй і не розбивай рядки. Імена, назви брендів, ніки (@…), адреси й цифри - як є. Без лапок навколо рядків. " +
    `Поверни JSON {"items": ["…"]} - рівно ${items.length} рядків по порядку.`;
  const user = items.map((t, k) => `${k + 1}. ${t}`).join("\n");
  const call = async (): Promise<string[] | null> => {
    const raw = await chat(model, system, user, { workspaceId: ws, step: "montage_translate", json: true, maxTokens: Math.min(6000, 200 + Math.ceil(chars * 1.4)) });
    try {
      const j = extractJsonObject<{ items?: unknown }>(raw);
      const arr = Array.isArray(j.items) ? j.items.map((x) => String(x ?? "").replace(/^\s*\d+[.)]\s*/, "").trim()) : [];
      return arr.length === items.length && arr.filter(Boolean).length >= Math.ceil(items.length * 0.8) ? arr : null;
    } catch { return null; }
  };
  let tr = await call();
  if (!tr) tr = await call();
  if (!tr) {
    // запасний шлях: цілим текстом і ділимо пропорційно довжині рядків
    const whole = await chat(model, `Переклади текст субтитрів відео з мови «${name(from)}» на «${name(to)}» розмовно, без пояснень, лапок і нумерації. Імена, назви, ніки й цифри - як є.`,
      items.join(" "), { workspaceId: ws, step: "montage_translate", maxTokens: Math.min(6000, 200 + Math.ceil(chars * 1.4)) });
    const t = String(whole || "").replace(/\s+/g, " ").trim();
    if (!t) throw new MontageError("модель не повернула перекладу");
    tr = P.spreadByWeights(t, items.map((x) => x.length));
  }
  idx.forEach((i, k) => { out[i] = tr![k] || items[k]; });
  return out;
}

// ---- 6. повний монтаж ----
export async function buildMontage(ws: string, o: MontageOpts): Promise<MontageResult> {
  if (!o.clips?.length) throw new MontageError("Дай хоча б один кліп.");
  if (o.clips.length > MONTAGE_MAX_CLIPS) throw new MontageError(`До ${MONTAGE_MAX_CLIPS} кліпів за раз.`);
  const tid = P.normTemplate(o.template);
  const tp = P.templatePlan(tid);
  const bs = await montageStyle(ws);
  const preset = o.subStyle ? P.normSubPreset(o.subStyle, bs.subtitle) : bs.subtitle;
  const look = P.subLook(preset, P.normHex(o.color) || bs.color, o.subPos ? P.normSubPos(o.subPos) : bs.position);
  const srcs = await loadSources(ws, o.clips.map((c) => c.id));
  const lang = o.lang || bs.speech || P.langCode(await getSettingText(ws, "output_language"));
  const warnings: string[] = [];
  const n = srcs.length;
  if (tid === "before_after" && n < 2) throw new MontageError("Для «до / після» потрібно щонайменше 2 кліпи: спершу «до», потім «після».");
  const baN = tid === "before_after" ? P.baSplit(n, o.beforeCount) : 0;

  // обрізка кожного кліпу
  const trims = o.clips.map((c, i) => {
    const s = srcs[i];
    if (s.kind === "image") return { from: 0, avail: Infinity, fromGiven: false };
    const from = Math.min(Math.max(0, Number(c.from) || 0), Math.max(0, s.duration - 0.3));
    const to = c.to != null && Number(c.to) > from + 0.2 ? Math.min(Number(c.to), s.duration) : s.duration;
    return { from, avail: Math.max(0.3, to - from), fromGiven: c.from != null && Number(c.from) > 0 };
  });
  const clipTexts = o.clips.map((c) => String(c.text || "").replace(/\s+/g, " ").trim());

  await mkdir(WORK_DIR, { recursive: true });
  sweepMontageTmp().catch(() => {});
  const dir = await mkdtemp(join(WORK_DIR, "m-"));
  try {
    // ✂️ паузи й «еее»: кожен кліп зі звуком розшифровуємо окремо; де говорять - вирізаємо паузи між
    // словами. Заодно знаємо, які кліпи «говорять»: у шаблоні «Говорю в камеру» вони йдуть цілком
    const speech = srcs.map(() => false);
    let cutClips = 0, cutSaved = 0;
    const wantCut = o.voice === "clips" && (o.cutPauses ?? (tp.cut && bs.cut));
    if (o.voice === "clips" && (wantCut || tp.wholeSpeech)) {
      let stt = true;
      for (let i = 0; i < n && stt; i++) {
        const s = srcs[i];
        if (s.kind !== "video" || !s.audio) continue;
        const buf = await extractSpeech(dir, ["-ss", trims[i].from.toFixed(3), "-t", trims[i].avail.toFixed(3), "-i", srcPath(s)], `sp${i}.m4a`).catch(() => null);
        if (!buf) continue;
        const r = await transcribeWords(buf, "speech.m4a", ws, lang).catch((e) => { warnings.push("паузи не вирізано: розшифровка не вдалась - " + String(e.message).slice(0, 120)); stt = false; return null; });
        if (!r) { if (stt) warnings.push("паузи не вирізано: розшифровку голосу не підключено (Deepgram чи OpenAI)"); stt = false; continue; }
        const words = r.provider === "whisper" ? P.restorePunct(r.words, r.text) : r.words;
        if (words.filter((w) => !P.isFiller(w.w)).length < 2) continue;
        speech[i] = true;
        if (!wantCut) continue;
        const keeps = P.speechKeeps(words, trims[i].avail);
        if (!keeps) continue;
        const f = await tightenClip(dir, i, s, trims[i].from, keeps)
          .catch((e) => { warnings.push(`паузи в кліпі ${i + 1} не вирізано: ` + String(e.message).slice(0, 100)); return ""; });
        if (!f) continue;
        const kept = P.keptSec(keeps);
        cutClips++; cutSaved += trims[i].avail - kept;
        srcs[i] = { ...s, path: join(dir, f), duration: kept };
        trims[i] = { from: 0, avail: kept, fromGiven: true };
      }
    }

    // скільки секунд кожному кліпу: свої seconds; у «Говорю в камеру» мова - цілком; у «Процесі» - короткі шматки
    const slots: P.Slot[] = o.clips.map((c, i) => {
      let want: number | null = c.seconds != null && Number(c.seconds) > 0 ? Number(c.seconds) : null;
      if (want == null && tp.wholeSpeech && speech[i]) want = trims[i].avail;
      if (want == null && tp.clipSec && !speech[i] && (o.voice === "none" || o.voice === "clips")) want = tp.clipSec;
      return { avail: trims[i].avail, want, still: srcs[i].kind === "image" };
    });

    let durs: number[];
    let words: P.Word[] = [];
    let voiceParts: Array<{ file: string; at: number }> = [];
    let provider: string | undefined;
    const LEAD = 0.15;

    if (o.voice === "tts") {
      const script = String(o.script || "").trim();
      if (!script && !clipTexts.some(Boolean)) throw new MontageError("Для AI-голосу потрібен текст: script (увесь текст озвучки) або text у кліпів.");
      if (script) {
        const r = await synthesizeAll([script], [join(dir, "tts0.mp3")], { lang, voiceId: o.voiceId });
        provider = r.provider;
        const part = r.parts[0]!;
        durs = P.allocate(slots, part.duration + LEAD + 0.5);
        voiceParts = [{ file: "tts0.mp3", at: LEAD }];
        words = part.words.map((w) => ({ ...w, s: w.s + LEAD, e: w.e + LEAD }));
      } else {
        const r = await synthesizeAll(clipTexts, clipTexts.map((_, i) => join(dir, `tts${i}.mp3`)), { lang, voiceId: o.voiceId });
        provider = r.provider;
        // кліп із текстом триває стільки, скільки звучить його текст (але не менше, ніж попросили)
        const wants = slots.map((s, i) => {
          const p = r.parts[i];
          return p ? { ...s, want: Math.max(p.duration + LEAD + 0.35, Number(s.want) || 0, 1) } : s;
        });
        durs = P.allocate(wants, null);
        let t = 0;
        for (let i = 0; i < durs.length; i++) {
          const p = r.parts[i];
          if (p) {
            voiceParts.push({ file: `tts${i}.mp3`, at: t + LEAD });
            words.push(...p.words.map((w) => ({ ...w, s: w.s + t + LEAD, e: w.e + t + LEAD })));
          }
          t += durs[i];
        }
      }
    } else if (o.voice === "audio") {
      if (!o.audio) throw new MontageError("Для озвучки своїм голосом передай audio - id запису голосу з медіатеки.");
      const a = await one<{ filename: string; kind: string }>(`select filename, kind from media_asset where id=$1 and workspace_id=$2`, [o.audio, ws]);
      if (!a) throw new MontageError(`Запису ${shortId(o.audio)} у медіатеці цього кабінету немає.`);
      const path = join(MEDIA_DIR, a.filename);
      const info = a.kind === "video" ? await probeVideo(path).then((v) => (v?.acodec ? { duration: v.duration } : null)) : await probeAudio(path);
      if (!info?.duration) throw new MontageError(`У ${shortId(o.audio)} нема звуку, який можна взяти за озвучку.`);
      durs = P.allocate(slots, info.duration + LEAD + 0.5);
      voiceParts = [{ file: path, at: LEAD }];
      const r = await transcribeWords(await readFile(path), a.filename, ws, lang).catch((e) => { warnings.push("розшифровка голосу не вдалась: " + String(e.message).slice(0, 120)); return null; });
      if (r) {
        provider = r.provider;
        const ws0 = r.provider === "whisper" ? P.restorePunct(r.words, r.text) : r.words;
        words = ws0.map((w) => ({ ...w, s: w.s + LEAD, e: w.e + LEAD }));
      } else if (!warnings.length) warnings.push("розшифровку голосу не підключено (Deepgram чи OpenAI) - субтитрів із голосу не буде");
    } else {
      durs = P.allocate(slots, null);
    }

    const total = Math.round(durs.reduce((a, b) => a + b, 0) * 100) / 100;
    if (total > MONTAGE_MAX_SEC) throw new MontageError(`Виходить ${Math.round(total)} с - максимум ${MONTAGE_MAX_SEC / 60} хв. Обріж кліпи (from/to) або коротше озвучку.`);
    // Instagram і Facebook приймають відео (і сторіс, і Reels) від 3 с
    if (total < 3) throw new MontageError(`Замало відео: ${total.toFixed(1)} с, а мережі приймають від 3 с - додай кліп чи візьми довший шматок.`);

    // кадри: кліпи по порядку, а коли відео коротше за голос - по колу, а не стоп-кадр на останньому кадрі
    // («до / після» - ніколи по колу: «після» не може йти перед «до»)
    const withVoice = voiceParts.length > 0;
    const continuous = !baN && (o.voice === "audio" || (o.voice === "tts" && !!String(o.script || "").trim())) && !slots.some((s) => s.want != null && s.want > 0);
    const shotClips: P.ShotClip[] = srcs.map((s, i) => ({ avail: trims[i].avail, still: s.kind === "image", fromGiven: trims[i].fromGiven,
      fast: tp.fast && s.kind === "video" && !speech[i] ? tp.fast : null }));
    let plan = P.planShots(shotClips, durs, continuous);
    // 🎯 кліп довший за свій шматок - є вибір, звідки брати: дивимось кадри й беремо найкращий шматок
    let smart = 0;
    if (o.smart ?? tp.smart) {
      for (let i = 0; i < n; i++) {
        const s = srcs[i];
        if (s.kind !== "video" || trims[i].fromGiven) continue;
        // вибір є, коли кліп довший за шматок, що з нього береться (і в звичайній швидкості, і прискорений)
        if (!plan.shots.some((sh) => sh.clip === i && sh.speed <= 1 && trims[i].avail > sh.take + 0.2)) continue;
        const sc = await analyzeClip(dir, s, trims[i].from, trims[i].avail, i);
        if (sc) { shotClips[i] = { ...shotClips[i], scores: sc, step: STAT_STEP }; smart++; }
      }
      if (smart) plan = P.planShots(shotClips, durs, continuous);
    }
    const trMode = o.transition ? P.normTransition(o.transition, tp.transition) : tp.transition;
    if (plan.shots.length > MONTAGE_MAX_SHOTS) throw new MontageError(`Відео замало для такої довгої озвучки: кліпи довелось би повторити ${plan.passes} разів. Додай ще кліпів або скороти текст.`);
    if (plan.passes > 1) {
      const foot = srcs.reduce((a, s, i) => a + (s.kind === "image" ? 0 : trims[i].avail), 0);
      warnings.push(`відео ${secs(foot)} на ${secs(total)} ${withVoice ? "озвучки" : "ролика"} - ${srcs.length === 1 ? "кліп пішов" : "кліпи пішли"} по колу (×${plan.passes}); щоб без повторів, додай ще кліпи`);
    }
    // ↔️ стик «до → після» - шторка
    const bAt = baN ? plan.shots.findIndex((s) => s.clip >= baN) : -1;
    const boundary = bAt > 0 && tp.boundary ? { at: bAt, name: tp.boundary } : null;
    const segs: string[] = [];
    const rendered = new Map<string, string>();   // однаковий кадр (повтор цілого кліпу) рендеримо раз
    const lastOf = new Map<string, string>();     // останній кадр сегмента - з нього заходить перехід наступного
    const frameOf = async (seg: string): Promise<string> => {
      let fr = lastOf.get(seg);
      if (!fr) { fr = await lastFrame(dir, seg, lastOf.size).catch(() => ""); if (fr) lastOf.set(seg, fr); }
      return fr;
    };
    let bIn = 0;   // скільки триває шторка на стику (мітка «після» зʼявляється після неї)
    for (let j = 0; j < plan.shots.length; j++) {
      const sh = plan.shots[j];
      const src = srcs[sh.clip];
      const fit = { offset: sh.offset, take: sh.take, speed: sh.speed, freeze: sh.freeze };
      if (src.kind === "video") fit.offset = Math.round((trims[sh.clip].from + fit.offset) * 1000) / 1000;
      // ✨ перехід: з останнього кадру попереднього сегмента (той самий кліп підряд - теж, це інший шматок)
      const tr = P.transitionFor(trMode, j, sh.dur, boundary);
      let enter: Enter | null = null;
      if (tr) {
        const fr = await frameOf(segs[j - 1]);
        if (fr) enter = { name: tr.name, d: tr.d, frame: fr };
        if (boundary && j === boundary.at) bIn = tr.d;
      }
      const key = [sh.clip, fit.offset, fit.take, fit.speed, sh.dur.toFixed(3), enter ? `${enter.name}<${segs[j - 1]}` : ""].join(":");
      let file = rendered.get(key);
      if (!file) {
        file = await renderSegment(dir, rendered.size, src, fit, sh.dur, o.voice !== "tts" || o.keepSound !== false, enter);
        rendered.set(key, file);
      }
      segs.push(file);
    }
    // де на екрані кожен кліп (перший його показ) - для підписів по кліпах
    const span = srcs.map((_, i) => {
      const a = plan.shots.findIndex((s) => s.clip === i);
      let b = a;
      while (b + 1 < plan.shots.length && plan.shots[b + 1].clip === i) b++;
      return { start: plan.shots[a].start, end: plan.shots[b].start + plan.shots[b].dur };
    });
    const bounds = plan.shots.slice(1).map((x) => x.start);
    // поверх відео тим самим фільтром ass, що й субтитри: мітки «до/після» (текст - мовою версії), фінальна
    // картка (назва й нік - однакові в усіх версіях) і гачок
    const labels: Array<{ before: boolean; start: number; end: number; y?: number }> = [];
    const endEv: string[] = [];

    // ↔️ мітки «до»/«після» і кадр порівняння
    let full = total;
    if (baN && tp.labels) {
      const bS = plan.shots.filter((s) => s.clip < baN), aS = plan.shots.filter((s) => s.clip >= baN);
      const endOf = (s: P.Shot) => s.start + s.dur;
      labels.push({ before: true, start: bS[0].start + 0.1, end: endOf(bS[bS.length - 1]) },
        { before: false, start: aS[0].start + bIn + 0.05, end: endOf(aS[aS.length - 1]) });
    }
    if (baN && tp.compare) {
      try {
        const lastB = plan.shots.map((s, j) => (s.clip < baN ? j : -1)).filter((j) => j >= 0).pop()!;
        const fb = await lastFrame(dir, segs[lastB], "B"), fa = await lastFrame(dir, segs[segs.length - 1], "A");
        const img = await compareImage(dir, fb, fa);
        segs.push(await stillSegment(dir, "compare", img, COMPARE_SEC, false, { name: "fade", d: 0.3, frame: fa }));
        labels.push({ before: true, start: full + 0.3, end: full + COMPARE_SEC, y: 300 },
          { before: false, start: full + 0.3, end: full + COMPARE_SEC, y: H / 2 + 60 });
        bounds.push(full);
        full += COMPARE_SEC;
      } catch (e: any) { warnings.push("кадр порівняння не вийшов: " + String(e.message).slice(0, 100)); }
    }
    // 🏁 фінальна картка: розмитий останній кадр, назва бренду й нік
    const endWanted = o.endCard === false ? false : typeof o.endCard === "string" ? true : (o.endCard ?? bs.end);
    const endText = endWanted ? await brandEndText(ws, typeof o.endCard === "string" ? o.endCard : bs.endText) : null;
    if (endText) {
      try {
        const fr = await lastFrame(dir, segs[segs.length - 1], "E");
        segs.push(await stillSegment(dir, "endcard", fr, P.END_SEC, true, { name: "fade", d: 0.35, frame: fr }));
        endEv.push(...P.endEvents(endText, full + 0.2, full + P.END_SEC, look.style.accent));
        bounds.push(full);
        full += P.END_SEC;
      } catch (e: any) { warnings.push("фінальна картка не вийшла: " + String(e.message).slice(0, 100)); }
    }
    full = Math.round(full * 100) / 100;

    // сегменти склеюються прямо на вході фінального кодування (concat-демуксер) - без проміжного
    // raw.mp4: на 3-хвилинному ролику це сотні МБ на спільному диску сервера
    await writeFile(join(dir, "list.txt"), segs.map((s) => `file '${s}'`).join("\n") + "\n");
    const CAT = ["-f", "concat", "-safe", "0", "-i", "list.txt"];

    // голос кліпів → слова
    if (o.voice === "clips") {
      if (!srcs.some((s) => s.audio)) warnings.push("у кліпів нема звуку - субтитрів із мовлення не буде");
      else {
        const r = await transcribeWords(await extractSpeech(dir, CAT), "speech.m4a", ws, lang)
          .catch((e) => { warnings.push("розшифровка звуку кліпів не вдалась: " + String(e.message).slice(0, 120)); return null; });
        if (r) { provider = r.provider; words = r.provider === "whisper" ? P.restorePunct(r.words, r.text) : r.words; }
        else if (!warnings.some((w) => /розшифровк/.test(w))) warnings.push("розшифровку голосу не підключено (Deepgram чи OpenAI) - субтитрів із мовлення не буде");
        if (r && !words.length && !o.autoCaptions) warnings.push("у кліпах не почуто мови - субтитрів із мовлення немає");
      }
      // мови не почули - підписи з кадрів (якщо так просили): сегменти вже готові, міняються лише субтитри
      if (!words.length && o.autoCaptions && !clipTexts.some(Boolean)) {
        try { (await aiClipTexts(ws, srcs, durs, "captions")).forEach((t, i) => { clipTexts[i] = t; }); }
        catch (e: any) { warnings.push("підписи з кадрів не вийшли: " + String(e.message).slice(0, 120)); }
      }
    }

    // субтитри
    const captions: P.Caption[] = [];
    if (!words.length) for (let i = 0; i < srcs.length; i++) captions.push(...P.captionChunks(clipTexts[i], span[i].start + 0.1, span[i].end - 0.05));
    let sub: SubMode = o.subtitles || (words.length ? "karaoke" : captions.length ? "lines" : "none");
    if (sub !== "none" && !words.length && !captions.length) sub = "none";
    const cues = words.length ? P.groupCues(words, look.cue) : [];
    const subEv = sub === "none" ? [] : words.length ? P.karaokeEvents(cues, look.style, sub === "karaoke" && look.highlight) : P.captionEvents(captions, look.style);
    if (sub === "karaoke" && !words.length) sub = "lines";
    const labelEv = (L: string) => {
      const bw = P.baWords(L);
      return P.labelEvents(labels.map((x) => ({ text: x.before ? bw.before : bw.after, start: x.start, end: x.end, after: !x.before, y: x.y })));
    };

    // 🪝 гачок: свій текст, інакше AI з того, що звучить чи написано на відео (у «до / після» без тексту - «До і після»)
    // o.hook: false - без; true чи "auto" - AI; свій рядок - він; порожньо чи не задано - як у стилі бренду
    const hs = typeof o.hook === "string" ? o.hook.trim() : "";
    const hookWanted = o.hook === false ? false : hs ? true : typeof o.hook === "boolean" ? o.hook : bs.hook;
    let hookText = hs && !/^(auto|true)$/i.test(hs) ? P.cleanHook(hs) : "";
    if (hookWanted && !hookText) {
      const basis = words.length ? P.wordsText(words) : [String(o.script || ""), ...clipTexts].join(" ").trim();
      hookText = basis ? await autoHook(ws, basis, lang) : baN ? P.baWords(lang).hook : "";
    }
    const hookEnd = P.hookSpan(total);
    const hookEv = (h: string) => (h ? P.hookEvents(h, 0.05, hookEnd) : []);
    const allEv = [...subEv, ...labelEv(lang), ...endEv, ...hookEv(hookText)];
    if (allEv.length) await writeFile(join(dir, "subs.ass"), P.assDoc(look.style, allEv));

    // 🔤 мовні версії: той самий текст іншою мовою - картки субтитрів у той самий час, гачок, мітки «до/після»
    const subTexts = sub === "none" ? [] : cues.length ? cues.map((c) => P.wordsText(c.words)) : captions.map((c) => c.text);
    const hasText = subTexts.some(Boolean) || !!hookText || labels.length > 0;
    const wanted = Array.isArray(o.subLangs) ? o.subLangs : Object.values(bs.langs);
    const vLangs = hasText ? P.variantLangs(lang, wanted) : [];
    const variantAss: Array<{ lang: string; file: string }> = [];
    for (const L of vLangs) {
      try {
        const baHook = !!baN && hookText === P.baWords(lang).hook;
        const tr = await translateSubs(ws, [...subTexts, baHook ? "" : hookText], lang, L);
        const tSubs = tr.slice(0, subTexts.length);
        const tHook = baHook ? P.baWords(L).hook : P.cleanHook(tr[subTexts.length] || "") || "";
        const se = sub === "none" ? [] : cues.length
          ? P.karaokeEvents(P.retextCues(cues, tSubs, look.cue.lineChars ?? 18), look.style, false)
          : P.captionEvents(captions.map((c, i) => ({ ...c, text: tSubs[i] || c.text })), look.style);
        const ev = [...se, ...labelEv(L), ...endEv, ...hookEv(hookText ? tHook || hookText : "")];
        const file = `subs_${L}.ass`;
        await writeFile(join(dir, file), P.assDoc(look.style, ev));
        variantAss.push({ lang: L, file });
      } catch (e: any) {
        warnings.push(`субтитри мовою ${P.SUB_LANGS[L]?.label || L} не вийшли: ${String(e?.message || e).slice(0, 140)}`);
      }
    }

    // голосова доріжка
    let voiceFile = "";
    if (withVoice) voiceFile = await buildVoiceTrack(dir, voiceParts, full);

    // 🎵 фонова музика: свій трек із медіатеки або AI-музика ElevenLabs під настрій
    let musicFile = "", musicNote = "";
    if (o.music) {
      const a = await one<{ filename: string; kind: string; original_name: string | null }>(`select filename, kind, original_name from media_asset where id=$1 and workspace_id=$2`, [o.music, ws]);
      if (!a) throw new MontageError(`Треку ${shortId(o.music)} у медіатеці цього кабінету немає.`);
      const path = join(MEDIA_DIR, a.filename);
      const info = a.kind === "video" ? await probeVideo(path).then((v) => (v?.acodec ? { duration: v.duration } : null)) : a.kind === "audio" ? await probeAudio(path) : null;
      if (!info?.duration) throw new MontageError(`У ${shortId(o.music)} нема звуку, який можна взяти за музику.`);
      musicFile = path;
      musicNote = a.original_name ? `свій трек «${a.original_name.slice(0, 60)}»` : "свій трек";
    } else if (o.musicMood && P.MUSIC_MOODS[o.musicMood]) {
      try {
        await composeMusic(P.musicPrompt(o.musicMood), Math.ceil(full) + 1, join(dir, "music.mp3"));
        musicFile = "music.mp3";
        musicNote = `AI-музика: ${P.MUSIC_MOODS[o.musicMood].label}`;
      } catch (e: any) {
        // ролик без музики - краще, ніж жодного: кажемо чому, і в журнал (звідти - адміну, якщо це ключ чи кошти)
        warnings.push("музику не згенеровано: " + String(e?.message || e).slice(0, 200));
        await logEvent("warn", "montage", "AI-музика не вийшла: " + String(e?.message || e).slice(0, 300), { ws }).catch(() => {});
      }
    }

    // де різати довгу сторіс
    const cuts = o.format === "story" ? P.splitPoints(full, bounds, sub === "none" ? [] : (cues.length ? cues : captions), STORY_PART_SEC) : [];

    // фінал
    // звук кліпів: під озвучкою - тихо (18%); з музикою без голосу - наполовину (фон кліпу, не мова); інакше як є
    // (або зовсім без, якщо так попросили). Музика притихає під голосом і під МОВОЮ в кліпах (voice: clips), а
    // під шумом кліпів (вітер, вулиця) - ні: інакше вона б не звучала зовсім
    const keep = o.keepSound === false ? 0 : withVoice ? 0.18 : musicFile && o.voice !== "clips" ? 0.5 : 1;
    const aChain = P.audioGraph({ total: full, voice: withVoice ? 1 : null, music: musicFile ? (withVoice ? 2 : 1) : null, keep,
      duckOnClips: !withVoice && o.voice === "clips" && keep > 0 && srcs.some((s) => s.audio) });
    // те саме кодування для оригіналу й кожної мовної версії - різниться лише файл субтитрів
    const encodeFinal = (ass: string | null, out: string) => ff([...CAT, ...(withVoice ? ["-i", voiceFile] : []), ...(musicFile ? ["-stream_loop", "-1", "-i", musicFile] : []),
      "-filter_complex", `${ass ? `[0:v]ass=${ass}[v]` : "[0:v]null[v]"};${aChain}`, "-map", "[v]", "-map", "[a]",
      "-t", full.toFixed(3), "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "6M", "-bufsize", "12M",
      "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", String(FPS * 2),
      ...(cuts.length ? ["-force_key_frames", cuts.map((c) => c.toFixed(2)).join(",")] : []),
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-threads", "2", out], dir, 900000);
    await encodeFinal(allEv.length ? "subs.ass" : null, "out.mp4");

    // 🖼 обкладинка рілса: кадр, де вже стоїть гачок (його ж і видно в сітці профілю), інакше - кадр на початку
    let cover: { id: string; filename: string } | null = null;
    if (o.format === "reel") {
      try {
        const at = hookText ? Math.max(0.6, Math.min(1.3, hookEnd - 0.5)) : Math.min(1, full / 3);
        await ff(["-ss", at.toFixed(2), "-i", "out.mp4", "-frames:v", "1", "-q:v", "2", "cover.jpg"], dir, 60000);
        const m = await saveMedia(ws, { buffer: await readFile(join(dir, "cover.jpg")), mime: "image/jpeg", name: "cover.jpg", source: "cover" });
        cover = { id: m.id, filename: m.filename };
      } catch (e: any) { warnings.push("обкладинку не зроблено: " + String(e.message).slice(0, 100)); }
    }

    // довга сторіс - частинами в тих самих місцях (і в оригіналі, і в кожній мовній версії)
    const splitParts = async (src: string, prefix: string): Promise<string[]> => {
      if (!cuts.length) return [src];
      // ключовий кадр стає на найближчий кадр - буває й на кадр РАНІШЕ за момент різу (43,97 замість 44), і
      // без запасу сегментатор різав би аж на наступному ключовому, через 2 с
      await ff(["-i", src, "-map", "0", "-c", "copy", "-f", "segment", "-segment_times", cuts.map((c) => c.toFixed(2)).join(","),
        "-segment_time_delta", "0.05", "-reset_timestamps", "1", "-segment_format_options", "movflags=+faststart", `${prefix}%02d.mp4`], dir);
      return Array.from({ length: cuts.length + 1 }, (_, k) => `${prefix}${String(k).padStart(2, "0")}.mp4`);
    };
    const files = await splitParts("out.mp4", "part");
    const saveParts = async (list: string[], source: string, tag: string): Promise<MontageVideo[]> => {
      const out: MontageVideo[] = [];
      for (let k = 0; k < list.length; k++) {
        const name = list.length > 1 ? `montage${tag}-${k + 1}-of-${list.length}.mp4` : `montage${tag}.mp4`;
        const m = await saveMediaFile(ws, join(dir, list[k]), { name, source });
        const d = (await one<{ duration: number | null }>(`select duration from media_asset where id=$1`, [m.id]))?.duration || 0;
        out.push({ id: m.id, filename: m.filename, duration: Math.round(Number(d) * 10) / 10 });
      }
      return out;
    };
    const videos = await saveParts(files, "montage", "");
    // 🖼 ролик знає, з чого зібраний: кліпи, голос і музика в медіатеці стають «використаними» разом із ним
    const madeFrom = [...new Set([...srcs.map((s) => s.id), o.voice === "audio" ? o.audio : null, o.music].filter((x): x is string => !!x))];
    if (madeFrom.length) await q(`update media_asset set made_from=$2::uuid[] where id = any($1::uuid[])`, [videos.map((v) => v.id), madeFrom]);
    // 🔤 мова субтитрів оригіналу (публікація порівнює її з мовою, яку хоче мережа)
    if (hasText) await q(`update media_asset set sub_lang=$2 where id = any($1::uuid[])`, [videos.map((v) => v.id), lang]);
    const variants: MontageVariant[] = [];
    for (const va of variantAss) {
      try {
        await encodeFinal(va.file, `out_${va.lang}.mp4`);
        const parts = await splitParts(`out_${va.lang}.mp4`, `v${va.lang}_`);
        if (parts.length !== files.length) throw new Error("частин вийшло інакше, ніж в оригіналі");
        const vids = await saveParts(parts, "montage-lang", `-${va.lang}`);
        // версія живе разом із частиною оригіналу: прибрали оригінал - зникає й вона (каскадом)
        for (let k = 0; k < vids.length; k++)
          await q(`update media_asset set variant_of=$2, sub_lang=$3 where id=$1`, [vids[k].id, videos[k].id, va.lang]);
        variants.push({ lang: va.lang, videos: vids });
      } catch (e: any) {
        warnings.push(`версія з субтитрами мовою ${P.SUB_LANGS[va.lang]?.label || va.lang} не вийшла: ${String(e?.message || e).slice(0, 140)}`);
      }
    }
    const transcript = words.length ? P.wordsText(words) : clipTexts.filter(Boolean).join(" ");
    const cut = cutClips ? { clips: cutClips, saved: Math.round(cutSaved * 10) / 10 } : undefined;
    await logEvent("info", "montage", `змонтовано ${srcs.length} кліпів → ${videos.length} відео, ${Math.round(full)} с (${P.TEMPLATES[tid].label.replace(/^\S+\s/, "")}, ${o.voice}, ${sub} ${preset}, переходи ${trMode}${smart ? `, найкращі моменти ${smart}` : ""}${cut ? `, паузи -${cut.saved} с у ${cut.clips}` : ""}${hookText ? ", гачок" : ""}${endText ? ", фінальна картка" : ""}${musicNote ? `, ${musicNote}` : ""}${variants.length ? `, мовою ${lang} + версії ${variants.map((v) => v.lang).join(", ")}` : ""})`, { ws });
    return { videos, duration: full, transcript, subtitles: sub, voice: o.voice, provider, warnings, clips: srcs.length, transition: trMode, music: musicNote || undefined, smart,
      template: tid, hook: hookText || undefined, endCard: !!endText, style: preset, cut, cover, lang: hasText ? lang : null, variants };
  } finally {
    // MONTAGE_KEEP_TMP=1 - лишити робочу теку (налагодження: сегменти, субтитри, проміжні файли)
    if (process.env.MONTAGE_KEEP_TMP === "1") console.log("[montage] робоча тека:", dir);
    else rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- 7. куди покласти результат ----
/** Змонтоване - у пост: сторіс - кадрами (частина за частиною), інакше - одним відео (рілс). */
export async function attachMontage(ws: string, postId: string, format: MontageFormat, videoIds: string[], coverId?: string | null): Promise<void> {
  if (format === "story") await setPostMediaOrder(ws, postId, videoIds);
  else {
    await setPostVideo(ws, postId, videoIds[0]);
    // 🖼 обкладинка Reels - кадр із гачком (у сторіс обкладинки нема)
    if (coverId) await q(`update post set reel_cover=$2 where id=$1 and exists (select 1 from media_asset where id=$2 and workspace_id=$3)`, [postId, coverId, ws]);
  }
}

/** Новий пост під змонтоване відео (затверджений - лишається обрати час). */
export async function montagePost(ws: string, format: MontageFormat, nets: string[], text: string, videoIds: string[], coverId?: string | null, aiVoice = false,
  subLangs: Record<string, string> = {}): Promise<string> {
  const body = text.trim() || (format === "story" ? "🎬 Змонтована сторіс" : "🎬 Змонтований рілс");
  const src = await one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,'montage',$2,$3) returning id`, [ws, body.slice(0, 90), body]);
  const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
  const ch: Record<string, any> = {};
  // 🔤 мова субтитрів мережі, обрана для цього монтажу ("" - як говорять), - на пості: публікація візьме версію цією мовою
  for (const n of nets) ch[n] = { on: true, ...(n in subLangs ? { sub_lang: P.normSubLang(subLangs[n]) || "" } : {}) };
  // одна мережа - текст іде дослівно (як і в create_draft конектора)
  if (nets.length === 1) Object.assign(ch, { manual_adapt: true, native: nets[0] });
  // 🗣 AI-голос - позначка «створено з AI» для YouTube і TikTok одразу (людина може зняти). Ставимо й
  // тоді, коли мережу ще не ввімкнено: «🌐 В усі мережі» потім лише вмикає її, позначка лишається.
  if (format === "reel" && aiVoice) for (const n of ["youtube", "tiktok"]) ch[n] = { ...(ch[n] || { on: false }), ai: true };
  const post = await one<{ id: string }>(
    // 👥 ролик автора не стає затвердженим сам - його затверджує редактор чи власник
    `insert into post(run_id, stage, content, channels, format, review, created_by) values($1,'final',$2,$3,$4,$6,$5) returning id`,
    [run!.id, body, JSON.stringify(ch), format, actorId(), mayAutoApprove() ? "approved" : null]);
  await attachMontage(ws, post!.id, format, videoIds, coverId);
  return post!.id;
}

export type MontageTarget = {
  postId?: string | null;
  create?: { nets: string[]; text: string; subLangs?: Record<string, string> } | null;
  // бот: сповістити людину, коли готово чи впало (помилку - людським текстом)
  notify?: (r: MontageResult | null, error?: string) => Promise<void>;
  // бот і кабінет: текст із кадрів AI дописує в роботі (а не до старту, щоб відповідь була миттєвою)
  aiText?: { mode: "captions" | "voiceover"; hint?: string } | null;
};

/** Фонова робота монтажу (1-3 хв): стан у таблиці job, результат - у медіатеці й пості. */
export function startMontage(ws: string, o: MontageOpts, target: MontageTarget = {}, key?: string): Promise<JobRow> {
  return startJob("montage", key || null, ws, async () => {
    try {
      const r = await withSlot(async () => {
        if (target.aiText) {
          const srcs = await loadSources(ws, o.clips.map((c) => c.id));
          const durs = P.allocate(o.clips.map((c, i) => ({ avail: srcs[i].kind === "image" ? Infinity : srcs[i].duration, still: srcs[i].kind === "image", want: c.seconds ?? null })), null);
          const texts = await aiClipTexts(ws, srcs, durs, target.aiText.mode, target.aiText.hint || "");
          o = { ...o, clips: o.clips.map((c, i) => ({ ...c, text: texts[i] })) };
        }
        return buildMontage(ws, o);
      });
      let postId = target.postId || null;
      const ids = r.videos.map((v) => v.id);
      if (postId) await attachMontage(ws, postId, o.format, ids, r.cover?.id);
      // текст нового поста - свій, інакше те, що звучить чи написано на відео (у сторіс його не видно,
      // але в кабінеті й Студії він каже, що це за ролик; для рілса - готовий підпис)
      else if (target.create) postId = await montagePost(ws, o.format, target.create.nets, target.create.text || r.transcript || "", ids, r.cover?.id, o.voice === "tts", target.create.subLangs || {});
      // обкладинка потрібна лише посту: монтаж «лише в медіатеку» сироти не лишає (свою поставить update_post)
      if (!postId && r.cover) { await dropUnusedDerived(ws, [{ id: r.cover.id }]).catch(() => {}); r.cover = null; }
      const out = { ...r, postId };
      if (target.notify) await target.notify(out).catch(() => {});
      return out;
    } catch (e: any) {
      // відмови провайдерів (ElevenLabs, розшифровка, модель) уже людською мовою - кажемо як є; збій
      // самого ffmpeg чи коду людині нічого не пояснить - ховаємо деталь у журнал
      const raw = String(e?.message || e);
      const tech = !(e instanceof MontageError) && (/^(nice|ffmpeg|ffprobe)\b/.test(raw) || e instanceof TypeError || e instanceof ReferenceError || /ENOENT|EACCES|EXDEV/.test(raw));
      const msg = tech ? "Монтаж не вдався через технічний збій - спробуй ще раз; якщо повториться, напиши адміну." : raw.slice(0, 400);
      await logEvent(tech ? "error" : "warn", "montage", raw.slice(0, 500), { ws });
      if (target.notify) await target.notify(null, msg).catch(() => {});
      throw new Error(msg);
    }
  });
}

// ---- 🔤 субтитри на готове відео поста (без монтажу) ----
/**
 * Відео поста ще без тексту (своє, зняте й залите як є): розшифровуємо мову й накладаємо субтитри - мовою,
 * якою говорять, і версіями мовами мереж зі «Стилю відео». Кожен відео-кадр - окремо, тим самим рушієм
 * монтажу, але без нічого зайвого (без гачка, картки, переходів, вирізання пауз - відео лишається як є).
 * Довгий кадр сторіс ділиться на частини до 60 с. Оригінал лишається в медіатеці.
 */
export function startPostSubtitles(ws: string, postId: string, subLangs?: string[] | null): Promise<JobRow> {
  return startJob("montage", `subs:${postId}`, ws, async () => {
    const p = await one<{ format: string | null }>(
      `select p.format from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
    if (!p) throw new MontageError("пост не знайдено");
    const frames = await postMediaList(postId);
    const todo = frames.filter((f) => f.kind === "video" && !f.sub_lang);
    if (!todo.length) throw new MontageError(frames.some((f) => f.kind === "video")
      ? "Відео цього поста вже з субтитрами. Інші мови - змонтуй ще раз (мови мереж - у Бренд → Візуал → «🎬 Стиль відео»)."
      : "У пості нема відео.");
    const format: MontageFormat = p.format === "story" ? "story" : "reel";
    const repl = new Map<string, string[]>();
    const warnings: string[] = [];
    let langs: string[] = [];
    let mainLang: string | null = null;
    for (const f of todo) {
      const r = await withSlot(() => buildMontage(ws, { clips: [{ id: f.id, seconds: Number(f.duration) || null }], voice: "clips", format,
        template: "talking", transition: "none", smart: false, hook: false, endCard: false, cutPauses: false, subLangs: subLangs ?? null }));
      warnings.push(...r.warnings);
      // тексту не вийшло (мови не почули) - готове відео без субтитрів нікому не потрібне: геть
      if (!r.lang) { for (const v of r.videos) await deleteMediaAsset(v.id, v.filename).catch(() => {}); continue; }
      repl.set(f.id, r.videos.map((v) => v.id));
      mainLang = r.lang;
      langs = [...new Set([...langs, ...(r.variants || []).map((v) => v.lang)])];
    }
    if (!repl.size) throw new MontageError(`Мови у відео не почуто - субтитрів не буде.${warnings.length ? " " + warnings.slice(0, 2).join("; ") : ""}`);
    const ids = frames.flatMap((f) => repl.get(f.id) || [f.id]);
    if (ids.length > 10) throw new MontageError("Після поділу довгого відео на частини кадрів вийшло більше 10 - вріж відео коротше.");
    await setPostMediaOrder(ws, postId, ids);
    await logEvent("info", "montage", `субтитри на відео поста: ${repl.size} ${repl.size === 1 ? "кадр" : "кадрів"}, мова ${mainLang}${langs.length ? `, версії ${langs.join(", ")}` : ""}`, { ws, postId });
    return { postId, frames: repl.size, lang: mainLang, variants: langs, warnings };
  });
}

// ---- 8. 🖼 обкладинка Reels: кадр відео поста чи фото з медіатеки ----
async function saveCover(ws: string, jpeg: Buffer): Promise<{ id: string; filename: string }> {
  const m = await saveMedia(ws, { buffer: jpeg, mime: "image/jpeg", name: "cover.jpg", source: "cover" });
  return { id: m.id, filename: m.filename };
}
/**
 * Поставити посту обкладинку: at - секунда його відео, media - фото з медіатеки (кроп 9:16 туди, де
 * «цікаве»), null - прибрати (Instagram тоді візьме кадр сам). Стара обкладинка, якщо вона ніде більше
 * не стоїть, прибирається. Вертає нову (або null).
 */
export async function setReelCover(ws: string, postId: string, pick: { at?: number | null; media?: string | null } | null): Promise<{ id: string; filename: string } | null> {
  const p = await one<{ media_id: string | null; reel_cover: string | null }>(
    `select p.media_id, p.reel_cover from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!p) throw new MontageError("пост не знайдено");
  const v = p.media_id ? await one<{ filename: string; kind: string; duration: number | null }>(`select filename, kind, duration from media_asset where id=$1`, [p.media_id]) : null;
  if (!v || v.kind !== "video") throw new MontageError("Обкладинка - для відео-поста (Reels): спершу прикріпи відео.");
  let next: { id: string; filename: string } | null = null;
  if (pick?.media) {
    const m = await one<{ filename: string; kind: string }>(`select filename, kind from media_asset where id=$1 and workspace_id=$2`, [pick.media, ws]);
    if (!m || m.kind !== "image") throw new MontageError("Фото не знайдено в медіатеці цього кабінету.");
    next = await saveCover(ws, await sharp(join(MEDIA_DIR, m.filename)).rotate().resize(W, H, { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 90 }).toBuffer());
  } else if (pick && pick.at != null) {
    const dur = Number(v.duration) || 0;
    const at = Math.max(0, Math.min(Number(pick.at) || 0, Math.max(0, dur - 0.1)));
    const jpg = await frameAt(join(MEDIA_DIR, v.filename), at, W);
    if (!jpg) throw new MontageError("Кадр із цього відео не читається - спробуй інший момент.");
    next = await saveCover(ws, await sharp(jpg).resize(W, H, { fit: "cover" }).jpeg({ quality: 90 }).toBuffer());
  }
  await q(`update post set reel_cover=$2 where id=$1`, [postId, next?.id || null]);
  if (p.reel_cover && p.reel_cover !== next?.id) await dropUnusedDerived(ws, [{ id: p.reel_cover }]);
  return next;
}
