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
async function overlayHeadline(buf: Buffer, headline: string): Promise<{ buffer: Buffer; mime: string }> {
  // беремо реальні розміри зображення (щоб не кропити 4:5 / 16:9 до квадрата)
  let W = 1024, H = 1024;
  try { const meta = await sharp(buf).metadata(); if (meta.width && meta.height) { W = meta.width; H = meta.height; } } catch { /* дефолт 1024² */ }
  const base = sharp(buf);
  const scale = W / 1024; // масштабуємо типографіку відносно ширини
  const words = headline.split(/\s+/); const lines: string[] = []; let cur = "";
  const maxChars = Math.max(10, Math.round(16 * (W / 1024)));
  for (const w of words) { if ((cur + " " + w).trim().length > maxChars) { if (cur) lines.push(cur.trim()); cur = w; } else cur = (cur + " " + w).trim(); }
  if (cur) lines.push(cur);
  const fs = Math.round(66 * scale), lh = Math.round(80 * scale), pad = Math.round(56 * scale); const blockH = lines.length * lh + pad;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.78"/></linearGradient></defs><rect x="0" y="${H - blockH - 40}" width="${W}" height="${blockH + 40}" fill="url(#g)"/>${lines.map((ln, i) => `<text x="${pad}" y="${H - pad - (lines.length - 1 - i) * lh}" font-family="'Segoe UI',Arial,sans-serif" font-size="${fs}" font-weight="800" fill="#fff">${escXml(ln)}</text>`).join("")}</svg>`;
  const out = await base.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
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
export async function overlayForPost(ws: string, postId: string, headline: string, overlayOn: boolean): Promise<string> {
  const post = await one<{ image_base: string | null }>(
    `select p.image_base from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post?.image_base) throw new Error("Спершу згенеруй зображення");
  const baseBuf = await readFile(join(MEDIA_DIR, post.image_base));
  const hl = (headline || "").trim();
  let buf: Buffer, mime = "image/jpeg";
  if (overlayOn && hl) { const r = await overlayHeadline(baseBuf, hl); buf = r.buffer; mime = r.mime; }
  else { buf = await sharp(baseBuf).jpeg({ quality: 88 }).toBuffer(); }
  const saved = await saveMedia(ws, { buffer: buf, mime, name: "ai.jpg", source: "ai" });
  await q(`update post set media_id=$2, headline=$3 where id=$1`, [postId, saved.id, overlayOn ? (hl || null) : null]);
  return saved.filename;
}
