// Генерація зображень для постів. Перемикач провайдерів (per-workspace): openai | fal | gemini.
//  - openai: gpt-image-1 (quality=low) — реюзає OPENAI_API_KEY
//  - fal:    FLUX.1 [schnell] через fal.ai — найдешевше (FAL_KEY)
//  - gemini: Gemini 2.5 Flash Image «Nano Banana» (GEMINI_API_KEY)
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

// згенерувати зображення для поста (за його image_prompt або з тексту) і прикріпити (post.media_id)
export async function generateImageForPost(ws: string, postId: string): Promise<string> {
  const post = await one<{ content: string; image_prompt: string | null }>(
    `select p.content, p.image_prompt from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post) throw new Error("пост не знайдено");
  const base = (post.image_prompt || "").trim() || `Зображення для соцмереж за темою: ${(post.content || "").split("\n")[0].slice(0, 200)}`;
  const prompt = `${base}. Стиль: чисте, сучасне, мінімалістичне, привабливе; без тексту на зображенні.`;
  const img = await generateImage(ws, prompt);
  const ext = img.mime.includes("png") ? "png" : "jpg";
  const saved = await saveMedia(ws, { buffer: img.buffer, mime: img.mime, name: `ai.${ext}`, source: "ai" });
  await q(`update post set media_id=$2 where id=$1`, [postId, saved.id]);
  return saved.filename;
}
