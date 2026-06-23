// Генерація зображень для постів. Перемикач провайдерів (per-workspace): openai | fal | gemini.
//  - openai: gpt-image-1 (quality=low) — реюзає OPENAI_API_KEY
//  - fal:    FLUX.1 [schnell] через fal.ai — найдешевше (FAL_KEY)
//  - gemini: Gemini 2.5 Flash Image «Nano Banana» (GEMINI_API_KEY)
import sharp from "sharp";
import { env } from "./env.js";
import { q, one } from "./db.js";
import { saveMedia } from "./media.js";

export type ImgProvider = "openai" | "fal" | "gemini";
type Img = { buffer: Buffer; mime: string };
const COSTS: Record<ImgProvider, number> = { openai: 0.011, fal: 0.003, gemini: 0.039 };

export function imageProviders(): Record<ImgProvider, boolean> {
  return { openai: !!env.openai.apiKey, fal: !!env.fal.apiKey, gemini: !!env.gemini.apiKey };
}

async function genOpenAI(prompt: string): Promise<Img> {
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024", quality: "low", n: 1 }),
  });
  if (!r.ok) throw new Error(`OpenAI image ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI: порожня відповідь");
  return { buffer: Buffer.from(b64, "base64"), mime: "image/png" };
}

async function genFal(prompt: string): Promise<Img> {
  const r = await fetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: { Authorization: `Key ${env.fal.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, image_size: "square_hd", num_images: 1 }),
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

export async function generateImage(ws: string, prompt: string): Promise<Img> {
  const p = await resolveProvider(ws);
  if (!p) throw new Error("Не налаштовано жодного провайдера зображень — додай ключ (OPENAI_API_KEY / FAL_KEY / GEMINI_API_KEY) у .env");
  const img = p === "openai" ? await genOpenAI(prompt) : p === "fal" ? await genFal(prompt) : await genGemini(prompt);
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
  const W = 1024, H = 1024;
  const base = sharp(buf).resize(W, H, { fit: "cover" });
  const words = headline.split(/\s+/); const lines: string[] = []; let cur = "";
  for (const w of words) { if ((cur + " " + w).trim().length > 16) { if (cur) lines.push(cur.trim()); cur = w; } else cur = (cur + " " + w).trim(); }
  if (cur) lines.push(cur);
  const fs = 66, lh = 80, pad = 56; const blockH = lines.length * lh + pad;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.78"/></linearGradient></defs><rect x="0" y="${H - blockH - 40}" width="${W}" height="${blockH + 40}" fill="url(#g)"/>${lines.map((ln, i) => `<text x="${pad}" y="${H - pad - (lines.length - 1 - i) * lh}" font-family="'Segoe UI',Arial,sans-serif" font-size="${fs}" font-weight="800" fill="#fff">${escXml(ln)}</text>`).join("")}</svg>`;
  const out = await base.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
  return { buffer: out, mime: "image/jpeg" };
}

// згенерувати зображення для поста (за його image_prompt або з тексту) + опційно накласти заголовок, прикріпити (post.media_id)
export async function generateImageForPost(ws: string, postId: string): Promise<string> {
  const post = await one<{ content: string; image_prompt: string | null }>(
    `select p.content, p.image_prompt from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post) throw new Error("пост не знайдено");
  const base = (post.image_prompt || "").trim() || `Зображення для соцмереж за темою: ${(post.content || "").split("\n")[0].slice(0, 200)}`;
  const prompt = `${base}. Стиль: чисте, сучасне, мінімалістичне, привабливе; без тексту на зображенні.`;
  const img = await generateImage(ws, prompt);
  let buf = img.buffer, mime = img.mime;
  const ov = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='image_overlay'`, [ws]);
  if ((ov?.content ?? "1") !== "0") {
    const hl = deriveHeadline(post.content);
    if (hl) { try { const r = await overlayHeadline(buf, hl); buf = r.buffer; mime = r.mime; } catch { /* оверлей не критичний */ } }
  }
  const ext = mime.includes("png") ? "png" : "jpg";
  const saved = await saveMedia(ws, { buffer: buf, mime, name: `ai.${ext}`, source: "ai" });
  await q(`update post set media_id=$2 where id=$1`, [postId, saved.id]);
  return saved.filename;
}
