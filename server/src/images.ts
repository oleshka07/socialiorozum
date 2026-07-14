// Генерація зображень для постів. Перемикач провайдерів (per-workspace): openai | fal | gemini.
//  - openai: gpt-image-1 (quality=low) — реюзає OPENAI_API_KEY
//  - fal:    FLUX.1 [schnell] через fal.ai — найдешевше (FAL_KEY)
//  - gemini: Gemini 2.5 Flash Image «Nano Banana» (GEMINI_API_KEY)
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "./env.js";
import { q, one } from "./db.js";
import { saveMedia, MEDIA_DIR } from "./media.js";
import { chat, extractJsonArray } from "./openrouter.js";

export type ImgProvider = "openai" | "fal" | "gemini";
export type Aspect = "1:1" | "4:5" | "16:9";
type Img = { buffer: Buffer; mime: string };
const COSTS: Record<ImgProvider, number> = { openai: 0.011, fal: 0.003, gemini: 0.039 };

function normAspect(a?: string): Aspect { return a === "4:5" || a === "16:9" ? a : "1:1"; }
// цільові пропорції картинки для sharp-оверлея (ширина×висота у пікселях базового полотна)
const ASPECT_DIM: Record<Aspect, { w: number; h: number }> = { "1:1": { w: 1024, h: 1024 }, "4:5": { w: 1024, h: 1280 }, "16:9": { w: 1280, h: 720 } };
// gpt-image-1 підтримує лише 1024x1024 / 1024x1536 / 1536x1024
const OPENAI_SIZE: Record<Aspect, string> = { "1:1": "1024x1024", "4:5": "1024x1536", "16:9": "1536x1024" };
// fal FLUX schnell — іменовані формати
const FAL_SIZE: Record<Aspect, string> = { "1:1": "square_hd", "4:5": "portrait_4_3", "16:9": "landscape_16_9" };

export function imageProviders(): Record<ImgProvider, boolean> {
  return { openai: !!env.openai.apiKey, fal: !!env.fal.apiKey, gemini: !!env.gemini.apiKey };
}

async function genOpenAI(prompt: string, aspect: Aspect): Promise<Img> {
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: OPENAI_SIZE[aspect], quality: "low", n: 1 }),
  });
  if (!r.ok) throw new Error(`OpenAI image ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI: порожня відповідь");
  return { buffer: Buffer.from(b64, "base64"), mime: "image/png" };
}

async function genFal(prompt: string, aspect: Aspect): Promise<Img> {
  const r = await fetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: { Authorization: `Key ${env.fal.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, image_size: FAL_SIZE[aspect], num_images: 1 }),
  });
  if (!r.ok) throw new Error(`fal ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const im = j.images?.[0];
  if (!im?.url) throw new Error("fal: порожня відповідь");
  const ab = await (await fetch(im.url)).arrayBuffer();
  return { buffer: Buffer.from(ab), mime: im.content_type || "image/jpeg" };
}

async function genGemini(prompt: string): Promise<Img> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${env.gemini.apiKey}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!r.ok) throw new Error(`Gemini image ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const parts = j.candidates?.[0]?.content?.parts || [];
  const inline = parts.map((p: any) => p.inlineData || p.inline_data).find((x: any) => x?.data);
  if (!inline?.data) throw new Error("Gemini: немає зображення у відповіді");
  return { buffer: Buffer.from(inline.data, "base64"), mime: inline.mimeType || inline.mime_type || "image/png" };
}

async function resolveProvider(ws: string): Promise<ImgProvider | null> {
  const row = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='image_provider'`, [ws]);
  const avail = imageProviders();
  const pref = (row?.content as ImgProvider) || "openai";
  if (avail[pref]) return pref;
  for (const p of ["openai", "fal", "gemini"] as ImgProvider[]) if (avail[p]) return p;
  return null;
}

export async function generateImage(ws: string, prompt: string, providerOverride?: ImgProvider, aspect?: Aspect): Promise<Img> {
  const avail = imageProviders();
  const p = (providerOverride && avail[providerOverride]) ? providerOverride : await resolveProvider(ws);
  if (!p) throw new Error("Не налаштовано жодного провайдера зображень — додай ключ (OPENAI_API_KEY / FAL_KEY / GEMINI_API_KEY) у .env");
  const a = normAspect(aspect);
  // gemini не має параметра розміру — підказуємо пропорції в промті
  const gemPrompt = a === "1:1" ? prompt : `${prompt} Формат зображення: ${a === "4:5" ? "вертикальний 4:5" : "горизонтальний 16:9"}.`;
  const img = p === "openai" ? await genOpenAI(prompt, a) : p === "fal" ? await genFal(prompt, a) : await genGemini(gemPrompt);
  try { await q(`insert into llm_usage(workspace_id, step, model, cost) values($1,'image',$2,$3)`, [ws, p, COSTS[p] || 0]); } catch { /* облік не критичний */ }
  return img;
}

// ---- накладання заголовка на зображення (sharp + SVG) ----
function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// короткий заголовок із суті поста (перший рядок, без markdown, до ~7 слів)
function deriveHeadline(content: string): string {
  const first = (content || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  const clean = first.replace(/^[#*>\-\s]+/, "").replace(/[*_`#]/g, "").trim();
  let h = clean.split(/\s+/).slice(0, 7).join(" ");
  if (h.length > 48) h = h.slice(0, 46).trim() + "…";
  return h;
}
// Оверлей 2.0 - «редакторська обкладинка»: місце, шрифт, фон (градієнт/плашка/затемнення всього
// фото/без), вирівнювання, ВЕРХНІЙ РЕГІСТР, акцентний колір ключового слова (останнє слово або
// фрагмент у *зірочках*), надзаголовок-кікер і підзаголовок. Все - sharp + SVG, без залежностей.
export type OverlayStyle = {
  position?: "top" | "center" | "bottom";
  font?: "sans" | "serif" | "mono";
  bg?: "gradient" | "plate" | "none" | "tint";
  align?: "left" | "center";
  upper?: boolean;
  accent?: string;   // hex-колір акценту ('' = без акценту)
  kicker?: string;   // короткий надзаголовок («ЕСЕ · 5 ХВИЛИН»)
  subtitle?: string; // підзаголовок під головним текстом
  size?: "sm" | "md" | "lg";
};
const OVERLAY_FONTS: Record<string, string> = {
  sans: "'DejaVu Sans','Segoe UI',Arial,sans-serif",
  serif: "'DejaVu Serif',Georgia,serif",
  mono: "'DejaVu Sans Mono','Courier New',monospace",
};
// перенос слів у рядки за приблизною шириною символа
// Ширина символа в частках font-size (bold DejaVu, з запасом угору): константа 0.6 брехала для
// ALL-CAPS кирилиці (реально ~0.78) - заголовок вилазив за край на 4:5. Краще перенести раніше.
function charFrac(c: string, mono: boolean): number {
  if (mono) return 0.64;
  if (/[ \-–.,:;!'’|()іїІЇjl]/.test(c)) return 0.36; // вузькі (І/Ї вузькі навіть ВЕЛИКІ) + пробіл/пунктуація
  if (/[МШЩЮЖФMW]/.test(c)) return 0.98;             // найширші ВЕЛИКІ
  if (/[мшщюжфmw]/.test(c)) return 0.82;             // широкі рядкові
  if (/[A-ZА-ЯЄҐ0-9]/.test(c)) return 0.8;           // решта ВЕЛИКИХ + цифри
  return 0.66;                                       // рядкові
}
// піксельна ширина рядка тексту для даного font-size
function textPx(s: string, fs: number, mono: boolean): number {
  let w = 0; for (const c of s) w += charFrac(c, mono); return w * fs;
}
// перенос по ПІКСЕЛЯХ: слово додається, лише якщо рядок реально влазить у maxW
function wrapPx(words: { t: string; a: boolean }[], fs: number, maxW: number, mono: boolean): { t: string; a: boolean }[][] {
  const lines: { t: string; a: boolean }[][] = []; let cur: { t: string; a: boolean }[] = []; let w = 0;
  const sp = textPx(" ", fs, mono);
  for (const word of words) {
    const ww = textPx(word.t, fs, mono);
    if (cur.length && w + sp + ww > maxW) { lines.push(cur); cur = []; w = 0; }
    cur.push(word); w += (w ? sp : 0) + ww;
  }
  if (cur.length) lines.push(cur);
  return lines;
}
export async function overlayHeadline(buf: Buffer, headline: string, style?: OverlayStyle): Promise<{ buffer: Buffer; mime: string }> {
  let W = 1024, H = 1024;
  try { const meta = await sharp(buf).metadata(); if (meta.width && meta.height) { W = meta.width; H = meta.height; } } catch { /* дефолт 1024² */ }
  const pos = style?.position === "top" || style?.position === "center" ? style.position : "bottom";
  const fontKey = style?.font || "sans";
  const fontFam = OVERLAY_FONTS[fontKey] || OVERLAY_FONTS.sans;
  const bg = ["plate", "none", "tint"].includes(style?.bg || "") ? style!.bg! : "gradient";
  const align = style?.align === "center" ? "center" : "left";
  const accent = /^#[0-9a-f]{6}$/i.test(style?.accent || "") ? style!.accent! : "";
  const scale = W / 1024;
  const sizeMul = style?.size === "lg" ? 1.28 : style?.size === "sm" ? 0.8 : 1;
  let fs = Math.round(66 * scale * sizeMul), lh = Math.round(fs * 1.22);
  const pad = Math.round(56 * scale);
  const mono = fontKey === "mono";
  // акцент: фрагмент у *зірочках*, інакше останнє слово (якщо заданий колір акценту)
  let text = (headline || "").trim(); if (style?.upper) text = text.toUpperCase();
  let accentSet = new Set<number>();
  const starM = text.match(/\*(.+?)\*/);
  const rawWords = text.replace(/\*/g, "").split(/\s+/).filter(Boolean);
  if (accent) {
    if (starM) {
      const accWords = starM[1].trim().split(/\s+/).map((w) => (style?.upper ? w.toUpperCase() : w));
      // позначаємо ПЕРШЕ входження послідовності
      for (let i = 0; i <= rawWords.length - accWords.length; i++)
        if (accWords.every((w, k) => rawWords[i + k] === w)) { accWords.forEach((_, k) => accentSet.add(i + k)); break; }
    } else if (rawWords.length) accentSet.add(rawWords.length - 1);
  }
  const words = rawWords.map((t, i) => ({ t, a: accentSet.has(i) }));
  const usableW = (align === "center" ? W * 0.86 : W - 2 * pad) - Math.round(10 * scale);
  // перенос по РЕАЛЬНІЙ ширині символів; якщо найдовше слово/рядок все одно ширші за поле -
  // зменшуємо шрифт (shrink-to-fit), а не ріжемо текст краєм кадру
  let lines = wrapPx(words, fs, usableW, mono);
  for (let guard = 0; guard < 6; guard++) {
    const maxLnW = Math.max(...lines.map((ws) => textPx(ws.map((w) => w.t).join(" "), fs, mono)), 1);
    if (maxLnW <= usableW) break;
    fs = Math.max(Math.round(22 * scale), Math.floor(fs * Math.min(0.92, usableW / maxLnW)));
    lh = Math.round(fs * 1.22);
    lines = wrapPx(words, fs, usableW, mono);
  }
  // кікер і підзаголовок
  const kicker = (style?.kicker || "").trim().toUpperCase().slice(0, 60);
  const kfs = Math.round(fs * 0.34), klh = kicker ? Math.round(kfs * 2.1) : 0;
  const sfs = Math.round(fs * 0.42), slh = Math.round(sfs * 1.5);
  const subWords = (style?.subtitle || "").trim().slice(0, 200).split(/\s+/).filter(Boolean).map((t) => ({ t, a: false }));
  const subLines = subWords.length ? wrapPx(subWords, sfs, usableW, mono) : [];
  const gapSub = subLines.length ? Math.round(14 * scale) : 0;
  const blockH = klh + lines.length * lh + gapSub + subLines.length * slh;
  const yStart = pos === "top" ? Math.round(64 * scale)
    : pos === "center" ? Math.max(Math.round(40 * scale), Math.round((H - blockH) / 2))
    : H - blockH - Math.round(56 * scale);
  const xOf = align === "center" ? Math.round(W / 2) : pad;
  const anchor = align === "center" ? ' text-anchor="middle"' : "";
  const yHead = (i: number) => yStart + klh + fs + i * lh;         // базова лінія рядка заголовка
  const ySub = (i: number) => yStart + klh + lines.length * lh + gapSub + sfs + i * slh;
  // SVG колапсує пробіли МІЖ tspan-ами → групуємо сусідні слова одного кольору в один tspan
  // (пробіли всередині текстового вузла живуть), а на <text> ставимо xml:space="preserve"
  const lineTs = (ws: { t: string; a: boolean }[]) => {
    const runs: { t: string; a: boolean }[] = [];
    for (const w of ws) {
      const last = runs[runs.length - 1];
      if (last && last.a === w.a) last.t += " " + w.t; else runs.push({ ...w });
    }
    return runs.map((r, k) => `<tspan${r.a && accent ? ` fill="${accent}"` : ""}>${k ? " " : ""}${escXml(r.t)}</tspan>`).join("");
  };
  // фон
  let bgSvg = "";
  if (bg === "tint") {
    bgSvg = `<rect x="0" y="0" width="${W}" height="${H}" fill="#0b0e13" fill-opacity="0.45"/>`;
  } else if (bg === "gradient") {
    if (pos === "bottom") bgSvg = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.78"/></linearGradient></defs><rect x="0" y="${Math.max(0, yStart - Math.round(40 * scale))}" width="${W}" height="${H - yStart + Math.round(40 * scale)}" fill="url(#g)"/>`;
    else if (pos === "top") bgSvg = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.78"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs><rect x="0" y="0" width="${W}" height="${yStart + blockH + Math.round(40 * scale)}" fill="url(#g)"/>`;
    else bgSvg = `<rect x="0" y="${yStart - Math.round(24 * scale)}" width="${W}" height="${blockH + Math.round(48 * scale)}" fill="#000" fill-opacity="0.5"/>`;
  } else if (bg === "plate") {
    const maxLnW = Math.max(...lines.map((ws) => textPx(ws.map((w) => w.t).join(" "), fs, mono)), 1);
    const plW = Math.min(W - Math.round(16 * scale), Math.round(maxLnW) + Math.round(72 * scale));
    const plX = align === "center" ? Math.round((W - plW) / 2) : pad - Math.round(24 * scale);
    bgSvg = `<rect x="${plX}" y="${yStart - Math.round(18 * scale)}" width="${plW}" height="${blockH + Math.round(34 * scale)}" rx="${Math.round(18 * scale)}" fill="#000" fill-opacity="0.55"/>`;
  }
  // «без фону»/затемнення - тінь під текстом для читабельності
  const sh = Math.round(3 * scale);
  const needShadow = bg === "none" || bg === "tint";
  const shadow = needShadow ? lines.map((ws, i) =>
    `<text x="${xOf + sh}" y="${yHead(i) + sh}"${anchor} font-family="${fontFam}" font-size="${fs}" font-weight="800" fill="#000" fill-opacity="0.55">${escXml(ws.map((w) => w.t).join(" "))}</text>`).join("") : "";
  const kickerSvg = kicker ? `<text x="${xOf}" y="${yStart + kfs}"${anchor} font-family="${fontFam}" font-size="${kfs}" font-weight="700" letter-spacing="${Math.round(3 * scale)}" fill="${accent || "#ffffff"}" fill-opacity="0.95">${escXml(kicker)}</text>` : "";
  const headSvg = lines.map((ws, i) => `<text x="${xOf}" y="${yHead(i)}"${anchor} xml:space="preserve" font-family="${fontFam}" font-size="${fs}" font-weight="800" fill="#fff">${lineTs(ws)}</text>`).join("");
  const subSvg = subLines.map((ws, i) => `<text x="${xOf}" y="${ySub(i)}"${anchor} font-family="${fontFam}" font-size="${sfs}" font-weight="500" fill="#ffffff" fill-opacity="0.86">${escXml(ws.map((w) => w.t).join(" "))}</text>`).join("");
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${bgSvg}${shadow}${kickerSvg}${headSvg}${subSvg}</svg>`;
  const out = await sharp(buf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
  return { buffer: out, mime: "image/jpeg" };
}

// згенерувати зображення для поста (за його image_prompt або з тексту), прикріпити (post.media_id).
// Логіка тексту на зображенні: генерація ЗАВЖДИ чиста (без накладання) — заголовок юзер підтверджує
// в редакторі зображення і накладає окремо (дешевий /image-text). Виняток: явний opts.headline
// (кнопка «Згенерувати» в редакторі з заповненим полем) — тоді накладаємо одразу.
export async function generateImageForPost(ws: string, postId: string, opts?: { headline?: string; provider?: ImgProvider; aspect?: Aspect | string; prompt?: string }): Promise<string> {
  const post = await one<{ content: string; image_prompt: string | null }>(
    `select p.content, p.image_prompt from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post) throw new Error("пост не знайдено");
  const base = (opts?.prompt || "").trim() || (post.image_prompt || "").trim() || `Зображення для соцмереж за темою: ${(post.content || "").split("\n")[0].slice(0, 200)}`;
  // стиль зображень бренду (аналог tone of voice для картинок) — задається в Налаштуваннях
  const styleRow = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='image_style'`, [ws]);
  const style = (styleRow?.content || "").trim() || "чисте, сучасне, мінімалістичне, привабливе";
  const prompt = `${base}. Стиль бренду: ${style}. Без жодного тексту, написів чи літер на зображенні.`;
  const img = await generateImage(ws, prompt, opts?.provider, normAspect(opts?.aspect));
  // зберігаємо БАЗОВЕ зображення (без тексту) окремо — щоб дешево перенакладати текст потім
  const baseSaved = await saveMedia(ws, { buffer: img.buffer, mime: img.mime, name: `ai-base.${img.mime.includes("png") ? "png" : "jpg"}`, source: "ai-base" });
  const headline = (opts?.headline || "").trim();
  let buf = img.buffer, mime = img.mime;
  if (headline) { try { const r = await overlayHeadline(buf, headline); buf = r.buffer; mime = r.mime; } catch { /* оверлей не критичний */ } }
  const saved = await saveMedia(ws, { buffer: buf, mime, name: `ai.${mime.includes("png") ? "png" : "jpg"}`, source: "ai" });
  await q(`update post set media_id=$2, image_base=$3, headline=$4 where id=$1`, [postId, saved.id, baseSaved.filename, headline || null]);
  return saved.filename;
}

// перенакласти текст на ВЖЕ згенероване базове зображення (дешево, без нової генерації)
export async function overlayForPost(ws: string, postId: string, headline: string, overlayOn: boolean, style?: OverlayStyle): Promise<string> {
  const post = await one<{ image_base: string | null }>(
    `select p.image_base from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post?.image_base) throw new Error("Спершу додай або згенеруй зображення");
  const baseBuf = await readFile(join(MEDIA_DIR, post.image_base));
  const hl = (headline || "").trim();
  let buf: Buffer, mime = "image/jpeg";
  if (overlayOn && hl) { const r = await overlayHeadline(baseBuf, hl, style); buf = r.buffer; mime = r.mime; }
  else { buf = await sharp(baseBuf).jpeg({ quality: 88 }).toBuffer(); }
  const saved = await saveMedia(ws, { buffer: buf, mime, name: "ai.jpg", source: "ai" });
  await q(`update post set media_id=$2, headline=$3 where id=$1`, [postId, saved.id, overlayOn ? (hl || null) : null]);
  return saved.filename;
}

// прикріпити фото з галереї/завантаження, ОБІТНУВШИ під обраний формат.
// crop (опційно) - РУЧНА рамка від користувача в нормованих координатах [0..1] вихідного фото;
// без нього - автоматичний центр-кроп зі smart-фокусом. Копія стає image_base поста.
export type CropRect = { x: number; y: number; w: number; h: number };
export async function attachCroppedImage(ws: string, postId: string, mediaId: string, aspect?: Aspect | string, crop?: CropRect): Promise<{ id: string; filename: string }> {
  const m = await one<{ filename: string; kind: string }>(`select filename, kind from media_asset where id=$1 and workspace_id=$2`, [mediaId, ws]);
  if (!m) throw new Error("медіа не знайдено");
  if (m.kind !== "image") throw new Error("це не зображення");
  const a = normAspect(aspect);
  const { w, h } = ASPECT_DIM[a];
  const buf = await readFile(join(MEDIA_DIR, m.filename));
  // rotate() шанує EXIF-орієнтацію фото з телефона
  let img = sharp(buf).rotate();
  if (crop && crop.w > 0 && crop.h > 0) {
    const meta = await sharp(buf).metadata();
    // рамка юзера намальована по ВЖЕ поверненому фото (браузер шанує EXIF) → для orientation 5-8 сторони міняються місцями
    const rot = (meta.orientation || 1) >= 5;
    const W = (rot ? meta.height : meta.width) || 0, H = (rot ? meta.width : meta.height) || 0;
    if (W && H) {
      const left = Math.max(0, Math.min(W - 2, Math.round(crop.x * W)));
      const top = Math.max(0, Math.min(H - 2, Math.round(crop.y * H)));
      const cw = Math.max(2, Math.min(W - left, Math.round(crop.w * W)));
      const chh = Math.max(2, Math.min(H - top, Math.round(crop.h * H)));
      img = img.extract({ left, top, width: cw, height: chh });
    }
  }
  const out = await img.resize(w, h, crop ? { fit: "fill" } : { fit: "cover", position: "attention" }).jpeg({ quality: 90 }).toBuffer();
  const saved = await saveMedia(ws, { buffer: out, mime: "image/jpeg", name: "crop.jpg", source: "crop" });
  await q(`update post set media_id=$2, image_base=$3, headline=null where id=$1`, [postId, saved.id, saved.filename]);
  return { id: saved.id, filename: saved.filename };
}

// Instagram приймає ЛИШЕ JPEG із пропорціями 0.8 (4:5) … 1.91 (близько 16:9-широке).
// Наші AI-зображення без оверлея - PNG, а завантаження бувають будь-якими → перед IG-публікацією
// робимо сумісну копію: конвертація в JPEG + за потреби центр-кроп до найближчої допустимої пропорції.
export async function ensureIgSafeImage(ws: string, filename: string): Promise<string> {
  // ДЕДУП: сумісну копію для цього файлу вже робили (повторна публікація/адаптація) → реюзаємо,
  // а не плодимо дублі в медіатеці (external_id = ім'я оригіналу)
  const existing = await one<{ filename: string }>(
    `select filename from media_asset where workspace_id=$1 and source='ig-safe' and external_id=$2 order by created_at desc limit 1`,
    [ws, filename]);
  if (existing) {
    try { await readFile(join(MEDIA_DIR, existing.filename)); return existing.filename; }
    catch { /* файл стерли з диска - зробимо копію заново */ }
  }
  const buf = await readFile(join(MEDIA_DIR, filename));
  const meta = await sharp(buf).metadata();
  const W = meta.width || 0, H = meta.height || 0;
  if (!W || !H) throw new Error("не вдалося прочитати зображення");
  const ratio = W / H;
  const MIN = 0.8, MAX = 1.91;
  const okFormat = meta.format === "jpeg";
  const okRatio = ratio >= MIN && ratio <= MAX;
  if (okFormat && okRatio) return filename;
  let img = sharp(buf).rotate();
  if (!okRatio) {
    const target = Math.max(MIN, Math.min(MAX, ratio));
    // кропимо по центру до допустимої пропорції (зберігаючи максимум кадру)
    const cw = ratio > target ? Math.round(H * target) : W;
    const ch = ratio > target ? H : Math.round(W / target);
    img = img.extract({ left: Math.max(0, Math.round((W - cw) / 2)), top: Math.max(0, Math.round((H - ch) / 2)), width: Math.min(W, cw), height: Math.min(H, ch) });
  }
  const out = await img.jpeg({ quality: 90 }).toBuffer();
  const saved = await saveMedia(ws, { buffer: out, mime: "image/jpeg", name: "ig-safe.jpg", source: "ig-safe", externalId: filename });
  return saved.filename;
}

// ---- Стокові фото Pexels: 2-3 варіанти під тему поста (безкоштовна альтернатива AI-генерації) ----
export type StockPhoto = { url: string; thumb: string; photographer: string; alt: string };
export async function stockPhotoOptions(ws: string, postText: string, aspect?: string): Promise<StockPhoto[]> {
  if (!env.pexels.apiKey) throw new Error("Стокові фото недоступні (нема PEXELS_API_KEY)");
  // 1 дешевий виклик: тема поста → 2-3 англ. пошукові слова (конкретні візуальні обʼєкти, не абстракції)
  let query = "modern workspace";
  try {
    const raw = await chat(env.cheapModel,
      'Підбери пошуковий запит для стокового ФОТО під пост. 2-4 АНГЛІЙСЬКІ слова: конкретні візуальні обʼєкти/сцени (не абстракції на кшталт success чи growth). Поверни ЛИШЕ валідний JSON-масив з одним рядком.',
      (postText || "").slice(0, 1500), { workspaceId: ws, step: "stock_photo_query" });
    const arr = extractJsonArray<any>(raw);
    if (arr[0]) query = String(arr[0]).trim().slice(0, 80);
  } catch { /* фолбек-запит вище */ }
  const orient = aspect === "16:9" ? "landscape" : aspect === "1:1" ? "square" : "portrait";
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=${orient}&per_page=6`,
    { headers: { Authorization: env.pexels.apiKey } });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const j: any = await res.json();
  return (j.photos || []).slice(0, 3).map((p: any) => ({
    url: p.src?.large2x || p.src?.large || p.src?.original,
    thumb: p.src?.medium || p.src?.small,
    photographer: p.photographer || "",
    alt: p.alt || query,
  })).filter((p: StockPhoto) => p.url);
}

// обране стокове фото → медіатека (source='pexels') → кроп під формат → база поста (текст-оверлей працює)
export async function attachStockPhoto(ws: string, postId: string, url: string, aspect?: string): Promise<{ id: string; filename: string }> {
  if (!/^https:\/\/images\.pexels\.com\//.test(url)) throw new Error("дозволені лише фото з Pexels");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let buf: Buffer;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Pexels download ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(timer); }
  const saved = await saveMedia(ws, { buffer: buf, mime: "image/jpeg", name: "pexels.jpg", source: "pexels" });
  return attachCroppedImage(ws, postId, saved.id, aspect);
}
