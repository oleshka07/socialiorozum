// ПРОТОТИП (бета): сценарій Reels → готове відео 1080x1920.
// Пайплайн: парсинг сценарію → укр. TTS (Azure, Полина/Остап) → стокові вертикальні кліпи (Pexels)
// → FFmpeg: сегменти → конкат → аудіо → вшиті субтитри (ASS, DejaVu Sans).
// Ключі: AZURE_SPEECH_KEY(+REGION) обовʼязково; PEXELS_API_KEY опційно (без нього - фон з картинки поста/градієнта).
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "./env.js";
import { q } from "./db.js";
import { chat, extractJsonArray } from "./openrouter.js";
import { MEDIA_DIR } from "./media.js";
import { logEvent } from "./log.js";

type Seg = { label: string; text: string; visual: string };
type Job = { status: "running" | "done" | "error"; filename?: string; error?: string; startedAt: number };
export const reelJobs = new Map<string, Job>();

// ---- утиліти ----
function run(cmd: string, args: string[], timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timeout`)); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-400)}`)); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}
async function probeDuration(file: string): Promise<number> {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], 20000);
  const d = parseFloat(out.trim());
  if (!isFinite(d) || d <= 0) throw new Error("ffprobe: не вдалося виміряти тривалість");
  return d;
}
async function download(url: string, dest: string, timeoutMs = 60000): Promise<void> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`download ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } finally { clearTimeout(t); }
}

// ---- 1. Парсинг сценарію Сценариста ----
export function parseReelScript(content: string): Seg[] {
  const lines = String(content || "").split("\n").map((l) => l.trim());
  const segs: Seg[] = [];
  let cur: Seg | null = null;
  for (const l of lines) {
    const head = l.match(/^(ХУК[^:]*|БІТ\s*\d+[^:]*|CTA[^:]*):\s*(.+)$/i);
    if (head) { if (cur && cur.text) segs.push(cur); cur = { label: head[1], text: head[2].trim(), visual: "" }; continue; }
    const vis = l.match(/^\[?\s*візуал\s*:\s*(.+?)\]?$/i);
    if (vis && cur) { cur.visual = vis[1].trim(); continue; }
    if (/^ТЕКСТ НА ЕКРАН/i.test(l)) { if (cur && cur.text) segs.push(cur); cur = null; continue; } // метадані титрів - не озвучка
    if (cur && l && !l.startsWith("🎬")) cur.text += " " + l; // перенесення рядка всередині біта
  }
  if (cur && cur.text) segs.push(cur);
  return segs.filter((s) => s.text).slice(0, 8).map((s) => ({ ...s, text: s.text.slice(0, 260) }));
}

// ---- 2. Azure TTS (укр.) ----
async function azureTts(text: string, dest: string): Promise<void> {
  const ssml = `<speak version='1.0' xml:lang='uk-UA'><voice name='${env.azure.voice}'><prosody rate='+8%'>${text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</prosody></voice></speak>`;
  const res = await fetch(`https://${env.azure.speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": env.azure.speechKey,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
      "User-Agent": "socialio-reels",
    },
    body: ssml,
  });
  if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

// ---- 3. Ключові слова для стоку (1 дешевий виклик на весь сценарій) ----
async function stockKeywords(ws: string, segs: Seg[]): Promise<string[]> {
  try {
    const raw = await chat(env.cheapModel,
      'Для кожного сегмента відео-сценарію дай 2-3 АНГЛІЙСЬКІ слова для пошуку стокового b-roll відео (конкретні візуальні обʼєкти/сцени, без абстракцій). Поверни ЛИШЕ валідний JSON-масив рядків, по одному на сегмент, у тому ж порядку.',
      segs.map((s, i) => `${i + 1}. ${s.visual || s.text}`).join("\n"), { workspaceId: ws, step: "reel_keywords" });
    const arr = extractJsonArray<any>(raw).map((x) => String(x || "").trim());
    return segs.map((_, i) => arr[i] || "abstract background");
  } catch { return segs.map((s) => "abstract background"); }
}

// ---- 3b. Персональна b-roll бібліотека: власні відео юзера (source='broll') ----
// 1-3 вставки з обличчям автора на ролик = персональність. Куди ставимо: ХУК (перший кадр - людина),
// середина, CTA. Кліп під сегмент обираємо випадково з бібліотеки без повторів.
async function brollPlan(ws: string, segCount: number): Promise<Map<number, string>> {
  const plan = new Map<number, string>();
  try {
    const rows = await q<{ filename: string }>(
      `select filename from media_asset where workspace_id=$1 and source='broll' and kind='video' order by random() limit 3`, [ws]);
    if (!rows.length) return plan;
    const slots = segCount <= 2 ? [0] : segCount <= 4 ? [0, segCount - 1] : [0, Math.floor(segCount / 2), segCount - 1];
    slots.slice(0, rows.length).forEach((slot, i) => plan.set(slot, rows[i].filename));
  } catch { /* без b-roll */ }
  return plan;
}

// ---- 4. Pexels: вертикальний кліп під сегмент ----
async function pexelsClip(query: string, dest: string): Promise<boolean> {
  if (!env.pexels.apiKey) return false;
  try {
    const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&size=medium&per_page=3`,
      { headers: { Authorization: env.pexels.apiKey } });
    if (!res.ok) return false;
    const j: any = await res.json();
    for (const v of j.videos || []) {
      const f = (v.video_files || []).filter((x: any) => x.width < x.height && x.height >= 1280)
        .sort((a: any, b: any) => a.height - b.height)[0];
      if (f?.link) { await download(f.link, dest); return true; }
    }
  } catch { /* фолбек нижче */ }
  return false;
}

// ---- 5. ASS-субтитри ----
const assTime = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
};
function buildAss(segs: { text: string; start: number; end: number }[]): string {
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,DejaVu Sans,58,&H00FFFFFF,&H00FFFFFF,&H00101014,&H80101014,-1,0,0,0,100,100,0,0,1,3,1,2,90,90,170,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const lines = segs.map((s) => `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Cap,,0,0,0,,${s.text.replace(/\n/g, "\\N").replace(/[{}]/g, "")}`);
  return head + lines.join("\n") + "\n";
}

// ---- 6. Повна збірка ----
export async function buildReelVideo(ws: string, postId: string, content: string, bgImage: string | null): Promise<string> {
  if (!env.azure.speechKey) throw new Error("Потрібен AZURE_SPEECH_KEY у .env (Azure Speech, безкоштовний тариф F0 підходить)");
  const segs = parseReelScript(content);
  if (segs.length < 2) throw new Error("Не розпізнав сценарій - потрібен пост формату «🎬 СЦЕНАРІЙ REELS» (ХУК/БІТи/CTA)");
  const dir = await mkdtemp(join(tmpdir(), "reel-"));
  try {
    // 6.1 озвучка + тривалості
    const durs: number[] = [];
    for (let i = 0; i < segs.length; i++) {
      await azureTts(segs[i].text, join(dir, `a${i}.mp3`));
      durs.push(Math.max(1.2, await probeDuration(join(dir, `a${i}.mp3`)) + 0.25)); // невелика пауза між бітами
    }
    // 6.2 відео-сегменти: власний b-roll (1-3 вставки з автором) → сток → фолбек картинка поста → градієнт
    const kws = await stockKeywords(ws, segs);
    const broll = await brollPlan(ws, segs.length);
    for (let i = 0; i < segs.length; i++) {
      const seg = join(dir, `v${i}.mp4`), clip = join(dir, `c${i}.mp4`);
      const d = durs[i].toFixed(2);
      const vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p";
      const personal = broll.get(i);
      if (personal) {
        await run("ffmpeg", ["-y", "-stream_loop", "-1", "-i", join(MEDIA_DIR, personal), "-t", d, "-an", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", seg], 180000);
      } else if (await pexelsClip(kws[i], clip)) {
        await run("ffmpeg", ["-y", "-stream_loop", "-1", "-i", clip, "-t", d, "-an", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", seg], 180000);
      } else if (bgImage) {
        await run("ffmpeg", ["-y", "-loop", "1", "-i", join(MEDIA_DIR, bgImage), "-t", d, "-an",
          "-vf", `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0008,1.12)':d=${Math.ceil(durs[i] * 30)}:s=1080x1920:fps=30,format=yuv420p`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", seg], 180000);
      } else {
        await run("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=0x14141c:s=1080x1920:d=${d}`, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", seg], 120000);
      }
    }
    // 6.3 конкат відео та аудіо
    await writeFile(join(dir, "vl.txt"), segs.map((_, i) => `file 'v${i}.mp4'`).join("\n"));
    await writeFile(join(dir, "al.txt"), segs.map((_, i) => `file 'a${i}.mp3'`).join("\n"));
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", join(dir, "vl.txt"), "-c", "copy", join(dir, "video.mp4")], 120000);
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", join(dir, "al.txt"), "-c", "copy", join(dir, "audio.mp3")], 60000);
    // 6.4 субтитри + фінальний мукс
    let t = 0;
    const subs = segs.map((s, i) => { const o = { text: s.text, start: t, end: t + durs[i] - 0.1 }; t += durs[i]; return o; });
    await writeFile(join(dir, "subs.ass"), buildAss(subs));
    const outName = `reel-${randomUUID().slice(0, 12)}.mp4`;
    await run("ffmpeg", ["-y", "-i", join(dir, "video.mp4"), "-i", join(dir, "audio.mp3"),
      "-vf", `ass=${join(dir, "subs.ass")}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", join(MEDIA_DIR, outName)], 300000);
    await logEvent("info", "reel", `зібрано відео ${outName} (${segs.length} сегментів, ~${Math.round(t)}с)`);
    return outName;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- 7. Фонова джоба (nginx-таймаути не страшні: старт → полінг статусу) ----
export function startReelJob(ws: string, postId: string, content: string, bgImage: string | null): void {
  reelJobs.set(postId, { status: "running", startedAt: Date.now() });
  buildReelVideo(ws, postId, content, bgImage)
    .then(async (filename) => {
      reelJobs.set(postId, { status: "done", filename, startedAt: Date.now() });
      // персист у пост - щоб рілс не загубився, навіть якщо юзер закрив сторінку/попап заблоковано
      await q(`update post set reel_video=$2 where id=$1`, [postId, filename]).catch(() => {});
    })
    .catch(async (e) => { reelJobs.set(postId, { status: "error", error: String(e.message).slice(0, 300), startedAt: Date.now() }); await logEvent("error", "reel", e.message); });
}
