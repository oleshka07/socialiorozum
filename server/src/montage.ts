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
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { q, one } from "./db.js";
import { env } from "./env.js";
import { MEDIA_DIR, probeVideo, probeAudio, saveMediaFile } from "./media.js";
import { transcribeWords } from "./stt.js";
import { synthesizeAll } from "./tts.js";
import { chat, extractJsonObject } from "./openrouter.js";
import { getSettingText } from "./settings.js";
import { startJob, type JobRow } from "./jobs.js";
import { setPostMediaOrder, setPostVideo } from "./slides.js";
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
};
export type MontageVideo = { id: string; filename: string; duration: number };
export type MontageResult = {
  videos: MontageVideo[]; duration: number; transcript: string; subtitles: SubMode; voice: VoiceMode;
  provider?: string; warnings: string[]; clips: number; postId?: string | null;
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
type Src = { id: string; filename: string; kind: "video" | "image"; duration: number; width: number; height: number; audio: boolean; name: string };
const shortId = (id: string) => "#" + String(id).slice(0, 8);

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

async function renderSegment(dir: string, i: number, src: Src, fit: { offset: number; take: number; speed: number; freeze: number }, dur: number, withSound: boolean): Promise<string> {
  const out = `seg${i}.mp4`;
  const d = dur.toFixed(3);
  const enc = ["-t", d, "-r", String(FPS), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-g", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-threads", "2", out];
  if (src.kind === "image") {
    // орієнтацію з EXIF ffmpeg для фото не застосовує - нормалізуємо sharp-ом
    const still = `still${i}.jpg`;
    await sharp(join(MEDIA_DIR, src.filename)).rotate().resize(2160, 3840, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(join(dir, still));
    const frames = Math.max(1, Math.round(dur * FPS));
    const graph = isPortrait(src)
      // вертикальне фото - повільне наближення (Ken Burns): статичний кадр у відео виглядає як зависання
      ? `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='min(zoom+0.0006,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p,setsar=1[v]`
      : `${padChain("[0:v]", "")},format=yuv420p,setsar=1[v]`;
    const input = isPortrait(src) ? ["-i", still] : ["-loop", "1", "-framerate", String(FPS), "-t", d, "-i", still];
    await ff([...input, "-f", "lavfi", "-t", d, "-i", "anullsrc=r=48000:cl=stereo", "-filter_complex", graph, "-map", "[v]", "-map", "1:a", ...enc], dir);
    return out;
  }
  const pre = fit.speed !== 1 ? `setpts=${fit.speed}*PTS,` : "";
  const tail = `fps=${FPS},format=yuv420p,setsar=1${fit.freeze > 0 ? `,tpad=stop_mode=clone:stop_duration=${fit.freeze.toFixed(3)}` : ""}[v]`;
  const vg = isPortrait(src) ? `[0:v]${pre}${coverChain},${tail}` : `${padChain(`[0:v]${pre}`, ",")}${tail}`.replace(",,", ",");
  // звук кліпу - лише коли він іде у звичайній швидкості (сповільнений голос звучить як зі старого магнітофона)
  const sound = withSound && src.audio && fit.speed === 1;
  const ag = sound ? `;[0:a]aresample=48000,aformat=channel_layouts=stereo,apad[a]` : "";
  const args = ["-ss", fit.offset.toFixed(3), "-t", fit.take.toFixed(3), "-i", join(MEDIA_DIR, src.filename)];
  if (!sound) args.push("-f", "lavfi", "-t", d, "-i", "anullsrc=r=48000:cl=stereo");
  await ff([...args, "-filter_complex", vg + ag, "-map", "[v]", "-map", sound ? "[a]" : "1:a", ...enc], dir);
  return out;
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

async function extractSpeech(dir: string, input: string | string[]): Promise<Buffer> {
  await ff([...(Array.isArray(input) ? input : ["-i", input]), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", "speech.m4a"], dir);
  return readFile(join(dir, "speech.m4a"));
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
      const b = await sharp(join(MEDIA_DIR, s.filename)).rotate().resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer().catch(() => null);
      if (b) shots.push(b);
    } else {
      for (const k of [0.2, 0.5, 0.8]) { const b = await frameAt(join(MEDIA_DIR, s.filename), s.duration * k, 384); if (b) shots.push(b); }
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
    const lang = P.langCode(await getSettingText(ws, "output_language"));
    const r = await transcribeWords(buf, "speech.m4a", ws, lang);
    if (!r) return null;
    const words = r.provider === "whisper" ? P.restorePunct(r.words, r.text) : r.words;
    const cues = P.groupCues(words, { maxChars: 60, maxWords: 14, maxDur: 5 });
    return { lines: cues.map((c) => `[${fmtT(c.start)}] ${c.words.map((w) => w.w).join(" ")}`), text: r.text || P.wordsText(words) };
  } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// ---- 5. повний монтаж ----
export async function buildMontage(ws: string, o: MontageOpts): Promise<MontageResult> {
  if (!o.clips?.length) throw new MontageError("Дай хоча б один кліп.");
  if (o.clips.length > MONTAGE_MAX_CLIPS) throw new MontageError(`До ${MONTAGE_MAX_CLIPS} кліпів за раз.`);
  const srcs = await loadSources(ws, o.clips.map((c) => c.id));
  const lang = o.lang || P.langCode(await getSettingText(ws, "output_language"));
  const warnings: string[] = [];

  // обрізка кожного кліпу
  const trims = o.clips.map((c, i) => {
    const s = srcs[i];
    if (s.kind === "image") return { from: 0, avail: Infinity, fromGiven: false };
    const from = Math.min(Math.max(0, Number(c.from) || 0), Math.max(0, s.duration - 0.3));
    const to = c.to != null && Number(c.to) > from + 0.2 ? Math.min(Number(c.to), s.duration) : s.duration;
    return { from, avail: Math.max(0.3, to - from), fromGiven: c.from != null && Number(c.from) > 0 };
  });
  const slots: P.Slot[] = o.clips.map((c, i) => ({ avail: trims[i].avail, want: c.seconds != null && Number(c.seconds) > 0 ? Number(c.seconds) : null, still: srcs[i].kind === "image" }));
  const clipTexts = o.clips.map((c) => String(c.text || "").replace(/\s+/g, " ").trim());

  await mkdir(WORK_DIR, { recursive: true });
  sweepMontageTmp().catch(() => {});
  const dir = await mkdtemp(join(WORK_DIR, "m-"));
  try {
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

    // сегменти
    const withVoice = voiceParts.length > 0;
    const segs: string[] = [];
    const starts: number[] = [];
    let t = 0;
    for (let i = 0; i < srcs.length; i++) {
      const fit = srcs[i].kind === "image" ? { offset: 0, take: durs[i], speed: 1, freeze: 0 } : P.fitClip(trims[i].avail, durs[i], trims[i].fromGiven);
      if (srcs[i].kind === "video") fit.offset = Math.round((trims[i].from + fit.offset) * 1000) / 1000;
      starts.push(t);
      segs.push(await renderSegment(dir, i, srcs[i], fit, durs[i], o.voice !== "tts" || o.keepSound !== false));
      t += durs[i];
    }
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
        else if (!warnings.length) warnings.push("розшифровку голосу не підключено (Deepgram чи OpenAI) - субтитрів із мовлення не буде");
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
    if (!words.length) for (let i = 0; i < srcs.length; i++) captions.push(...P.captionChunks(clipTexts[i], starts[i] + 0.1, starts[i] + durs[i] - 0.05));
    let sub: SubMode = o.subtitles || (words.length ? "karaoke" : captions.length ? "lines" : "none");
    if (sub !== "none" && !words.length && !captions.length) sub = "none";
    const cues = words.length ? P.groupCues(words) : [];
    let ass = "";
    if (sub !== "none") ass = words.length ? P.karaokeAss(cues, {}, sub === "karaoke") : P.captionsAss(captions);
    if (sub === "karaoke" && !words.length) sub = "lines";
    if (ass) await writeFile(join(dir, "subs.ass"), ass);

    // голосова доріжка
    let voiceFile = "";
    if (withVoice) voiceFile = await buildVoiceTrack(dir, voiceParts, total);

    // де різати довгу сторіс
    const cuts = o.format === "story" ? P.splitPoints(total, starts.slice(1), sub === "none" ? [] : (cues.length ? cues : captions), STORY_PART_SEC) : [];

    // фінал
    const keep = o.keepSound === false ? 0 : 0.18;
    const vChain = ass ? "[0:v]ass=subs.ass[v]" : "[0:v]null[v]";
    const aChain = withVoice ? `[0:a]volume=${keep}[b];[1:a]anull[vo];[b][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,aresample=48000[a]` : "[0:a]anull[a]";
    await ff([...CAT, ...(withVoice ? ["-i", voiceFile] : []), "-filter_complex", `${vChain};${aChain}`, "-map", "[v]", "-map", "[a]",
      "-t", total.toFixed(3), "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "6M", "-bufsize", "12M",
      "-profile:v", "high", "-pix_fmt", "yuv420p", "-g", String(FPS * 2),
      ...(cuts.length ? ["-force_key_frames", cuts.map((c) => c.toFixed(2)).join(",")] : []),
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-threads", "2", "out.mp4"], dir, 900000);

    let files = ["out.mp4"];
    if (cuts.length) {
      // ключовий кадр стає на найближчий кадр - буває й на кадр РАНІШЕ за момент різу (43,97 замість 44), і
      // без запасу сегментатор різав би аж на наступному ключовому, через 2 с
      await ff(["-i", "out.mp4", "-map", "0", "-c", "copy", "-f", "segment", "-segment_times", cuts.map((c) => c.toFixed(2)).join(","),
        "-segment_time_delta", "0.05", "-reset_timestamps", "1", "-segment_format_options", "movflags=+faststart", "part%02d.mp4"], dir);
      files = Array.from({ length: cuts.length + 1 }, (_, k) => `part${String(k).padStart(2, "0")}.mp4`);
    }
    const videos: MontageVideo[] = [];
    for (let k = 0; k < files.length; k++) {
      const name = files.length > 1 ? `montage-${k + 1}-of-${files.length}.mp4` : "montage.mp4";
      const m = await saveMediaFile(ws, join(dir, files[k]), { name, source: "montage" });
      const d = (await one<{ duration: number | null }>(`select duration from media_asset where id=$1`, [m.id]))?.duration || 0;
      videos.push({ id: m.id, filename: m.filename, duration: Math.round(Number(d) * 10) / 10 });
    }
    const transcript = words.length ? P.wordsText(words) : clipTexts.filter(Boolean).join(" ");
    await logEvent("info", "montage", `змонтовано ${srcs.length} кліпів → ${videos.length} відео, ${Math.round(total)} с (${o.voice}, ${sub})`, { ws });
    return { videos, duration: total, transcript, subtitles: sub, voice: o.voice, provider, warnings, clips: srcs.length };
  } finally {
    // MONTAGE_KEEP_TMP=1 - лишити робочу теку (налагодження: сегменти, субтитри, проміжні файли)
    if (process.env.MONTAGE_KEEP_TMP === "1") console.log("[montage] робоча тека:", dir);
    else rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- 6. куди покласти результат ----
/** Змонтоване - у пост: сторіс - кадрами (частина за частиною), інакше - одним відео (рілс). */
export async function attachMontage(ws: string, postId: string, format: MontageFormat, videoIds: string[]): Promise<void> {
  if (format === "story") await setPostMediaOrder(ws, postId, videoIds);
  else await setPostVideo(ws, postId, videoIds[0]);
}

/** Новий пост під змонтоване відео (затверджений - лишається обрати час). */
export async function montagePost(ws: string, format: MontageFormat, nets: string[], text: string, videoIds: string[]): Promise<string> {
  const body = text.trim() || (format === "story" ? "🎬 Змонтована сторіс" : "🎬 Змонтований рілс");
  const src = await one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,'montage',$2,$3) returning id`, [ws, body.slice(0, 90), body]);
  const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
  const ch: Record<string, any> = {};
  for (const n of nets) ch[n] = { on: true };
  // одна мережа - текст іде дослівно (як і в create_draft конектора)
  if (nets.length === 1) Object.assign(ch, { manual_adapt: true, native: nets[0] });
  const post = await one<{ id: string }>(
    `insert into post(run_id, stage, content, channels, format, review) values($1,'final',$2,$3,$4,'approved') returning id`,
    [run!.id, body, JSON.stringify(ch), format]);
  await attachMontage(ws, post!.id, format, videoIds);
  return post!.id;
}

export type MontageTarget = {
  postId?: string | null;
  create?: { nets: string[]; text: string } | null;
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
      if (postId) await attachMontage(ws, postId, o.format, ids);
      // текст нового поста - свій, інакше те, що звучить чи написано на відео (у сторіс його не видно,
      // але в кабінеті й Студії він каже, що це за ролик; для рілса - готовий підпис)
      else if (target.create) postId = await montagePost(ws, o.format, target.create.nets, target.create.text || r.transcript || "", ids);
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
