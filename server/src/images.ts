// Генерація зображень для постів. Перемикач провайдерів (per-workspace): openai | fal | gemini | cloudflare.
//  - openai: gpt-image-1 (quality=low) — реюзає OPENAI_API_KEY
//  - fal:    FLUX.1 [schnell] через fal.ai — найдешевше з платних (FAL_KEY)
//  - gemini: Gemini 2.5 Flash Image «Nano Banana» (GEMINI_API_KEY)
//  - cloudflare: FLUX.2 [klein] через Workers AI — ~100 на день БЕЗКОШТОВНО (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "./env.js";
import { q, one } from "./db.js";
import { saveMedia, MEDIA_DIR } from "./media.js";
import { appendPostMedia, dropUnusedDerived, MAX_SLIDES } from "./slides.js";
import { chat, extractJsonArray } from "./openrouter.js";
import { assertSpend, assertRate, noteSpend } from "./spend.js";
import { logEvent } from "./log.js";

export type ImgProvider = "openai" | "fal" | "gemini" | "cloudflare";
export type Aspect = "1:1" | "4:5" | "16:9" | "9:16";   // 9:16 - сторіс
type Img = { buffer: Buffer; mime: string };
// cloudflare = 0: у межах безкоштовного денного ліміту рахунку немає, а понад нього Free-план просто
// відмовляє (не списує), тож у стелю витрат кабінету тут іде нуль
const COSTS: Record<ImgProvider, number> = { openai: 0.011, fal: 0.003, gemini: 0.039, cloudflare: 0 };

export function normAspect(a?: string): Aspect { return a === "4:5" || a === "16:9" || a === "9:16" ? a : "1:1"; }
// цільові пропорції картинки для sharp-оверлея (ширина×висота у пікселях базового полотна)
export const ASPECT_DIM: Record<Aspect, { w: number; h: number }> = { "1:1": { w: 1024, h: 1024 }, "4:5": { w: 1024, h: 1280 }, "16:9": { w: 1280, h: 720 }, "9:16": { w: 1080, h: 1920 } };
// gpt-image-1 підтримує лише 1024x1024 / 1024x1536 / 1536x1024
const OPENAI_SIZE: Record<Aspect, string> = { "1:1": "1024x1024", "4:5": "1024x1536", "16:9": "1536x1024", "9:16": "1024x1536" };
// fal FLUX schnell — іменовані формати
const FAL_SIZE: Record<Aspect, string> = { "1:1": "square_hd", "4:5": "portrait_4_3", "16:9": "landscape_16_9", "9:16": "portrait_16_9" };

export function imageProviders(): Record<ImgProvider, boolean> {
  return { openai: !!env.openai.apiKey, fal: !!env.fal.apiKey, gemini: !!env.gemini.apiKey,
           cloudflare: !!(env.cloudflare.accountId && env.cloudflare.apiToken) };
}

// Скільки коштує ОДНЕ зображення в кожного з наших провайдерів - щоб рішення «міняти чи ні»
// приймалось за цифрою, а не за відчуттям. Ціни фіксовані в COSTS (вендори публікують їх сторінкою,
// а не API), тож тут лише розкриваємо їх людською мовою.
const IMG_LABELS: Record<ImgProvider, { label: string; note: string }> = {
  openai: { label: "OpenAI gpt-image-1", note: "quality=low; найкраще тримає текст і композицію" },
  fal: { label: "FLUX.1 schnell (fal.ai)", note: "найдешевше і найшвидше; деталі слабші" },
  gemini: { label: "Gemini 2.5 Flash Image (Nano Banana)", note: "сильний у фотореалізмі й правках за описом" },
  cloudflare: { label: "Cloudflare Workers AI (FLUX.2 klein)", note: "безкоштовно ~100 зображень на день (Free-план Cloudflare); понад ліміт - до наступної доби" },
};
export function imageCosts(): { id: string; label: string; note: string; usd: number; available: boolean }[] {
  const avail = imageProviders();
  return (Object.keys(COSTS) as ImgProvider[]).map((p) => ({
    id: p, label: IMG_LABELS[p].label, note: IMG_LABELS[p].note, usd: COSTS[p], available: avail[p],
  })).sort((a, b) => a.usd - b.usd);
}

// Помилка провайдера зображень - людською. Спіймано живцем: fal відповів
// 403 {"detail":"User is locked. Reason: TOP_UP."} (на рахунку скінчились гроші), і людина бачила
// цей JSON як є - без підказки, що робити. Невідоме лишаємо сирим: вгадувати гірше, ніж показати.
export function humanImageError(provider: ImgProvider, status: number, body: string): string {
  const name = IMG_LABELS[provider]?.label || provider;
  const b = String(body || "");
  if (provider === "cloudflare") {
    // 4006: безкоштовний денний ліміт. Це НЕ «поповни рахунок»: на Free-плані платити нема куди,
    // ліміт просто оновиться наступної доби
    if (/\b4006\b|daily free allocation|neurons/i.test(b))
      return "Безкоштовний денний ліміт Cloudflare (~100 зображень) на сьогодні вичерпано. Він оновиться вночі (00:00 UTC); до того обери інший провайдер у Бренд → Візуал.";
    if (/\b7003\b|could not route|object identifier/i.test(b))
      return "Cloudflare не знайшов акаунт: перевір Account ID у Налаштування → Профіль → Ключі провайдерів.";
    if (status === 401 || status === 403 || /\b10000\b|authentication error/i.test(b))
      return "Cloudflare не прийняв токен: потрібен API Token із правами Workers AI (Read і Edit). Перевір його в Налаштування → Профіль → Ключі провайдерів.";
  }
  // «locked» лише цілим словом: інакше «moderation_blocked» (відмова за безпекою) читався б як «нема грошей»
  if (/\blocked\b|top_?up|balance|insufficient|billing|quota|exhausted|credits?\b|depleted|payment/i.test(b))
    return `На рахунку ${name} скінчились кошти або квота: провайдер не приймає запити до поповнення. Поповни рахунок у провайдера або обери інший у Бренд → Візуал.`;
  if (status === 401 || status === 403)
    return `${name} не прийняв ключ (HTTP ${status}). Перевір ключ у Налаштування → Профіль → Ключі провайдерів.`;
  if (status === 429) return `${name} просить зачекати: забагато запитів. Спробуй за хвилину.`;
  if (/safety|moderation|content[_ ]policy|blocked|prohibited/i.test(b))
    return `${name} відхилив опис сцени за своїми правилами безпеки. Переформулюй опис.`;
  if (status >= 500) return `${name} тимчасово недоступний (HTTP ${status}). Спробуй за хвилину або обери інший провайдер.`;
  return `${name} ${status}: ${b.slice(0, 200)}`;
}

async function genOpenAI(prompt: string, aspect: Aspect): Promise<Img> {
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: OPENAI_SIZE[aspect], quality: "low", n: 1 }),
  });
  if (!r.ok) throw new Error(humanImageError("openai", r.status, await r.text()));
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
  if (!r.ok) throw new Error(humanImageError("fal", r.status, await r.text()));
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
  if (!r.ok) throw new Error(humanImageError("gemini", r.status, await r.text()));
  const j: any = await r.json();
  const parts = j.candidates?.[0]?.content?.parts || [];
  const inline = parts.map((p: any) => p.inlineData || p.inline_data).find((x: any) => x?.data);
  if (!inline?.data) throw new Error("Gemini: немає зображення у відповіді");
  return { buffer: Buffer.from(inline.data, "base64"), mime: inline.mimeType || inline.mime_type || "image/png" };
}

// ---- ☁️ Cloudflare Workers AI ----
// Основна модель - FLUX.2 [klein] 4B: свіжа (2026), одразу малює потрібну пропорцію (4:5 без
// обрізання), запит multipart. Запасна - FLUX.1 [schnell]: старша, лише квадрат 1024 (обрізаємо під
// формат), запит JSON. Формати взято з офіційних схем моделей у репозиторії cloudflare-docs.
export const CF_KLEIN = "@cf/black-forest-labs/flux-2-klein-4b";
export const CF_SCHNELL = "@cf/black-forest-labs/flux-1-schnell";
// Розміри для klein: кратні 16 (вимога моделі) і не більше 2×2 плиток 512×512 - так кадр коштує
// ~$0.0012 (~104 «нейрони»), і безкоштовних 10 000 на добу вистачає приблизно на 100 зображень.
export const CF_KLEIN_SIZE: Record<Aspect, { w: number; h: number }> = {
  "1:1": { w: 1024, h: 1024 }, "4:5": { w: 768, h: 960 }, "16:9": { w: 1024, h: 576 }, "9:16": { w: 576, h: 1024 },
};

export function cfUrl(model: string): string {
  return `${env.cloudflare.apiBase}/accounts/${encodeURIComponent(env.cloudflare.accountId)}/ai/run/${model}`;
}

// Конверт Workers AI: {result:{image:<base64>}, success, errors:[{code,message}]}; помилка - у ньому ж.
export function cfImageB64(j: any): string | null {
  const img = j?.result?.image ?? j?.image;
  return typeof img === "string" && img.length > 100 ? img : null;
}

// Ліміт, ключ і акаунт однакові для обох моделей - з такими відмовами на запасну йти марно.
export function cfShouldFallback(status: number, body: string): boolean {
  if (status === 401 || status === 403) return false;
  return !/\b4006\b|daily free allocation|neurons|\b10000\b|authentication error|\b7003\b|could not route|object identifier/i.test(body);
}

export function sniffImageMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return "image/png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "image/jpeg";
}

type CfRes = { ok: true; b64: string; model: string } | { ok: false; status: number; text: string; model: string };

async function cfGenerate(model: string, prompt: string, aspect: Aspect): Promise<CfRes> {
  const headers: Record<string, string> = { Authorization: `Bearer ${env.cloudflare.apiToken}` };
  let body: string | FormData;
  if (model === CF_SCHNELL) {
    // схема schnell: лише prompt (до 2048) і steps (до 8), зайве поле модель відхиляє. 4 кроки -
    // ~58 «нейронів» на кадр: якість майже та сама, а безкоштовних кадрів удвічі більше, ніж на 8
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ prompt: prompt.slice(0, 2048), steps: 4 });
  } else {
    // FLUX.2 приймає multipart; boundary у заголовок ставить сам fetch
    const d = CF_KLEIN_SIZE[aspect];
    body = new FormData();
    body.append("prompt", prompt.slice(0, 2048));
    body.append("width", String(d.w));
    body.append("height", String(d.h));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    const r = await fetch(cfUrl(model), { method: "POST", headers, body, signal: ctl.signal });
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* не JSON - віддамо текст як є */ }
    const b64 = r.ok ? cfImageB64(j) : null;
    if (b64) return { ok: true, b64, model };
    return { ok: false, status: r.ok ? 502 : r.status, text: r.ok ? `немає зображення у відповіді: ${text.slice(0, 200)}` : text.slice(0, 600), model };
  } catch (e: any) {
    return { ok: false, status: 504, text: e?.name === "AbortError" ? "Cloudflare не відповів за 90 секунд" : String(e?.message || e), model };
  } finally { clearTimeout(timer); }
}

// klein відмовив НЕ через ліміт і не через ключ (модель недоступна акаунту, змінився формат, збій)
// → той самий безкоштовний ліміт, але schnell. Памʼятаємо на 30 хв, щоб поки klein лежить, кожен
// кадр не платив зайвим запитом і секундами очікування.
let cfPrimaryDownUntil = 0;
export function resetCloudflareFallback(): void { cfPrimaryDownUntil = 0; }

async function genCloudflare(prompt: string, aspect: Aspect): Promise<Img> {
  // англійська приписка: FLUX.1 читає промт англійською, а напис на картинці - найчастіший брак FLUX
  const p = `${prompt} No text, no letters, no watermark.`;
  const primary = env.cloudflare.imageModel || CF_KLEIN;
  let r: CfRes;
  if (primary !== CF_SCHNELL && Date.now() >= cfPrimaryDownUntil) {
    r = await cfGenerate(primary, p, aspect);
    if (!r.ok && cfShouldFallback(r.status, r.text)) {
      cfPrimaryDownUntil = Date.now() + 30 * 60_000;
      await logEvent("warn", "images", `Cloudflare ${primary} не спрацював (HTTP ${r.status}), беру FLUX.1 schnell: ${r.text.slice(0, 200)}`);
      r = await cfGenerate(CF_SCHNELL, p, aspect);
    }
  } else r = await cfGenerate(CF_SCHNELL, p, aspect);
  if (!r.ok) throw new Error(humanImageError("cloudflare", r.status, r.text));
  const buffer = Buffer.from(r.b64, "base64");
  // schnell малює лише квадрат: обрізаємо під формат, тримаючи в кадрі найцікавіше
  if (r.model === CF_SCHNELL && aspect !== "1:1") {
    const meta = await sharp(buffer).metadata();
    const side = Math.min(meta.width || 1024, meta.height || 1024);
    const [tw, th] = aspect === "4:5" ? [Math.round(side * 4 / 5), side] : aspect === "9:16" ? [Math.round(side * 9 / 16), side] : [side, Math.round(side * 9 / 16)];
    return { buffer: await sharp(buffer).resize(tw, th, { fit: "cover", position: "attention" }).jpeg({ quality: 90 }).toBuffer(), mime: "image/jpeg" };
  }
  return { buffer, mime: sniffImageMime(buffer) };
}

async function resolveProvider(ws: string): Promise<ImgProvider | null> {
  const row = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='image_provider'`, [ws]);
  const avail = imageProviders();
  const pref = (row?.content as ImgProvider) || "openai";
  if (avail[pref]) return pref;
  // обраний недоступний → спершу безкоштовний, далі платні від дешевшого
  for (const p of ["cloudflare", "fal", "openai", "gemini"] as ImgProvider[]) if (avail[p]) return p;
  return null;
}

export async function generateImage(ws: string, prompt: string, providerOverride?: ImgProvider, aspect?: Aspect): Promise<Img> {
  const avail = imageProviders();
  const p = (providerOverride && avail[providerOverride]) ? providerOverride : await resolveProvider(ws);
  if (!p) throw new Error("Не налаштовано жодного провайдера зображень - адміністратор має додати ключ у Налаштування → Профіль → Ключі провайдерів.");
  // 💸 зображення - найдорожча одиниця ($0.04), стеля обовʼязкова. Безкоштовний Cloudflare грошову
  // стелю не зачіпає (блокувати його «вичерпаним бюджетом» було б неправдою), а частотну - так
  if (p === "cloudflare") assertRate(ws); else await assertSpend(ws);
  const a = normAspect(aspect);
  // gemini не має параметра розміру — підказуємо пропорції в промті
  const gemPrompt = a === "1:1" ? prompt : `${prompt} Формат зображення: ${a === "4:5" ? "вертикальний 4:5" : a === "9:16" ? "вертикальний 9:16 (сторіс)" : "горизонтальний 16:9"}.`;
  let img = p === "openai" ? await genOpenAI(prompt, a) : p === "fal" ? await genFal(prompt, a)
    : p === "cloudflare" ? await genCloudflare(prompt, a) : await genGemini(gemPrompt);
  // сторіс: жоден провайдер не малює рівно 9:16 (OpenAI - 2:3) - доводимо кадр до 1080×1920,
  // тримаючи в кадрі найцікавіше, інакше сторіс показувалась би з полями
  if (a === "9:16") img = { buffer: await sharp(img.buffer).rotate().resize(1080, 1920, { fit: "cover", position: "attention" }).jpeg({ quality: 90 }).toBuffer(), mime: "image/jpeg" };
  try { await q(`insert into llm_usage(workspace_id, step, model, cost) values($1,'image',$2,$3)`, [ws, p, COSTS[p] || 0]); noteSpend(ws, COSTS[p] || 0); } catch { /* облік не критичний */ }
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
export function charFrac(c: string, mono: boolean): number {
  if (mono) return 0.64;
  if (/[ \-–.,:;!'’|()іїІЇjl]/.test(c)) return 0.36; // вузькі (І/Ї вузькі навіть ВЕЛИКІ) + пробіл/пунктуація
  if (/[МШЩЮЖФMW]/.test(c)) return 0.98;             // найширші ВЕЛИКІ
  if (/[мшщюжфmw]/.test(c)) return 0.82;             // широкі рядкові
  if (/[A-ZА-ЯЄҐ0-9]/.test(c)) return 0.8;           // решта ВЕЛИКИХ + цифри
  return 0.66;                                       // рядкові
}
// піксельна ширина рядка тексту для даного font-size
export function textPx(s: string, fs: number, mono: boolean): number {
  let w = 0; for (const c of s) w += charFrac(c, mono); return w * fs;
}
// перенос по ПІКСЕЛЯХ: слово додається, лише якщо рядок реально влазить у maxW
export function wrapPx(words: { t: string; a: boolean }[], fs: number, maxW: number, mono: boolean): { t: string; a: boolean }[][] {
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
export async function generateImageForPost(ws: string, postId: string, opts?: { headline?: string; provider?: ImgProvider; aspect?: Aspect | string; prompt?: string; append?: boolean }): Promise<string> {
  const post = await one<{ content: string; image_prompt: string | null }>(
    `select p.content, p.image_prompt from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post) throw new Error("пост не знайдено");
  const base = (opts?.prompt || "").trim() || (post.image_prompt || "").trim() || `Зображення для соцмереж за темою: ${(post.content || "").split("\n")[0].slice(0, 200)}`;
  // стиль зображень бренду (аналог tone of voice для картинок) — задається в Налаштуваннях
  const styleRow = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='image_style'`, [ws]);
  const style = (styleRow?.content || "").trim() || "чисте, сучасне, мінімалістичне, привабливе";
  const prompt = `${base}. Стиль бренду: ${style}. Без жодного тексту, написів чи літер на зображенні.`;
  // новий кадр каруселі - у пропорції каруселі, а не дефолтній
  const aspect = opts?.append && !opts?.aspect ? await postAspect(postId) : normAspect(opts?.aspect);
  if (opts?.append) {
    const cnt = (await one<{ n: number }>(`select (case when media_id is null then 0 else 1 end) + (select count(*)::int from post_slide where post_id=$1) as n from post where id=$1`, [postId]))?.n || 0;
    if (cnt >= MAX_SLIDES) throw new Error(`У каруселі вже ${MAX_SLIDES} кадрів - більше Instagram і Telegram не приймають.`);
  }
  const img = await generateImage(ws, prompt, opts?.provider, aspect);
  if (opts?.append) {
    // кадр каруселі: обкладинку, її базу й напис не чіпаємо
    const slide = await saveMedia(ws, { buffer: img.buffer, mime: img.mime, name: `ai.${img.mime.includes("png") ? "png" : "jpg"}`, source: "ai" });
    await appendPostMedia(ws, postId, [slide.id]);
    return slide.filename;
  }
  // зберігаємо БАЗОВЕ зображення (без тексту) окремо — щоб дешево перенакладати текст потім
  const baseSaved = await saveMedia(ws, { buffer: img.buffer, mime: img.mime, name: `ai-base.${img.mime.includes("png") ? "png" : "jpg"}`, source: "ai-base" });
  const headline = (opts?.headline || "").trim();
  let buf = img.buffer, mime = img.mime;
  if (headline) { try { const r = await overlayHeadline(buf, headline); buf = r.buffer; mime = r.mime; } catch { /* оверлей не критичний */ } }
  const saved = await saveMedia(ws, { buffer: buf, mime, name: `ai.${mime.includes("png") ? "png" : "jpg"}`, source: "ai" });
  const prevG = await prevMedia(postId);
  await q(`update post set media_id=$2, image_base=$3, headline=$4 where id=$1`, [postId, saved.id, baseSaved.filename, headline || null]);
  cleanupDerivedMedia(ws, postId, prevG).catch(() => { /* зачистка не критична */ });
  return saved.filename;
}

// Підміна фото поста БЕЗ засмічення галереї (фідбек: «після кожної зміни тексту зберігаються
// великими пачками»): старе ПОХІДНЕ медіа поста (ai/crop/pexels/ai-base) видаляється, якщо воно
// ніде більше не стоїть - ні обкладинкою чи базою іншого поста, ні КАДРОМ каруселі (до каруселей
// перевірялись лише обкладинки, і заміна обкладинки стерла б кадр, який стоїть в іншому пості).
// Юзерські завантаження (upload/gdrive/diary/broll) не чіпаємо ніколи.
async function cleanupDerivedMedia(ws: string, postId: string, prev: { media_id: string | null; image_base: string | null } | null): Promise<void> {
  if (!prev) return;
  const cur = await one<{ media_id: string | null; image_base: string | null }>(`select media_id, image_base from post where id=$1`, [postId]);
  const gone: Array<{ id?: string | null; filename?: string | null }> = [];
  if (prev.media_id && prev.media_id !== cur?.media_id) gone.push({ id: prev.media_id });
  if (prev.image_base && prev.image_base !== cur?.image_base) gone.push({ filename: prev.image_base });
  await dropUnusedDerived(ws, gone);
}
const prevMedia = (postId: string) => one<{ media_id: string | null; image_base: string | null }>(`select media_id, image_base from post where id=$1`, [postId]);

// перенакласти текст на ВЖЕ згенероване базове зображення (дешево, без нової генерації)
export async function overlayForPost(ws: string, postId: string, headline: string, overlayOn: boolean, style?: OverlayStyle): Promise<string> {
  const post = await one<{ image_base: string | null }>(
    `select p.image_base from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post?.image_base) throw new Error("Спершу додай або згенеруй зображення");
  // базове фото могли стерти з медіатеки - тоді кажемо, що робити, а не «ENOENT: no such file»
  const baseBuf = await readFile(join(MEDIA_DIR, post.image_base)).catch(() => {
    throw new Error("Фото, на яке накладався текст, прибрано з медіатеки - обери фото заново (← Інше фото)");
  });
  const hl = (headline || "").trim();
  let buf: Buffer, mime = "image/jpeg";
  if (overlayOn && hl) { const r = await overlayHeadline(baseBuf, hl, style); buf = r.buffer; mime = r.mime; }
  else { buf = await sharp(baseBuf).jpeg({ quality: 88 }).toBuffer(); }
  const saved = await saveMedia(ws, { buffer: buf, mime, name: "ai.jpg", source: "ai" });
  const prevO = await prevMedia(postId);
  await q(`update post set media_id=$2, headline=$3 where id=$1`, [postId, saved.id, overlayOn ? (hl || null) : null]);
  cleanupDerivedMedia(ws, postId, prevO).catch(() => { /* зачистка не критична */ });
  return saved.filename;
}

// прикріпити фото з галереї/завантаження, ОБІТНУВШИ під обраний формат.
// crop (опційно) - РУЧНА рамка від користувача в нормованих координатах [0..1] вихідного фото;
// без нього - автоматичний центр-кроп зі smart-фокусом. Копія стає image_base поста.
export type CropRect = { x: number; y: number; w: number; h: number };
// Обітнута під формат КОПІЯ фото з медіатеки (оригінал лишається). Спільна для обкладинки й кадрів
// каруселі: кадри мусять мати ту саму пропорцію, бо Instagram ріже всю карусель під перший кадр.
export async function cropCopy(ws: string, mediaId: string, aspect?: Aspect | string, crop?: CropRect): Promise<{ id: string; filename: string }> {
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
  // кроп-копія памʼятає свій оригінал (external_id): з цього медіатека конектора знає, в яких
  // постах фото вже стоїть, і не підсуне те саме фото вдруге
  return saveMedia(ws, { buffer: out, mime: "image/jpeg", name: "crop.jpg", source: "crop", externalId: mediaId });
}

// прикріпити фото з галереї/завантаження ОБКЛАДИНКОЮ, обітнувши під обраний формат.
// crop (опційно) - РУЧНА рамка від користувача в нормованих координатах [0..1] вихідного фото;
// без нього - автоматичний центр-кроп зі smart-фокусом. Копія стає image_base поста.
export async function attachCroppedImage(ws: string, postId: string, mediaId: string, aspect?: Aspect | string, crop?: CropRect): Promise<{ id: string; filename: string }> {
  const saved = await cropCopy(ws, mediaId, aspect, crop);
  const prevC = await prevMedia(postId);
  await q(`update post set media_id=$2, image_base=$3, headline=null where id=$1`, [postId, saved.id, saved.filename]);
  cleanupDerivedMedia(ws, postId, prevC).catch(() => { /* зачистка не критична */ });
  return { id: saved.id, filename: saved.filename };
}

// Пропорція каруселі = пропорція обкладинки (найближча з 1:1 / 4:5 / 16:9). Нові кадри ріжемо так
// само, інакше Instagram обріже їх під перший кадр сам - і, можливо, не там, де головне.
export async function postAspect(postId: string): Promise<Aspect> {
  const c = await one<{ filename: string }>(`select m.filename from post p join media_asset m on m.id=p.media_id where p.id=$1`, [postId]);
  if (!c) return "4:5";
  try {
    const meta = await sharp(join(MEDIA_DIR, c.filename)).metadata();
    const rot = (meta.orientation || 1) >= 5;
    const W = (rot ? meta.height : meta.width) || 0, H = (rot ? meta.width : meta.height) || 0;
    if (!W || !H) return "4:5";
    const r = W / H;
    const cands: Array<[Aspect, number]> = [["1:1", 1], ["4:5", 0.8], ["16:9", 16 / 9], ["9:16", 9 / 16]];
    return cands.reduce((best, c2) => (Math.abs(Math.log(r / c2[1])) < Math.abs(Math.log(r / best[1])) ? c2 : best))[0];
  } catch { return "4:5"; }
}

// Додати кадр каруселі з медіатеки: кроп-копія під пропорцію каруселі → у кінець списку кадрів
export async function appendCroppedSlide(ws: string, postId: string, mediaId: string, aspect?: Aspect | string, crop?: CropRect): Promise<{ id: string; filename: string }> {
  const a = aspect ? normAspect(aspect) : await postAspect(postId);
  const saved = await cropCopy(ws, mediaId, a, crop);
  try { await appendPostMedia(ws, postId, [saved.id]); }
  catch (e) { await dropUnusedDerived(ws, [{ id: saved.id }]); throw e; } // не влізло в карусель - копію не лишаємо
  return { id: saved.id, filename: saved.filename };
}

// Instagram приймає ЛИШЕ JPEG із пропорціями 0.8 (4:5) … 1.91 (близько 16:9-широке).
// Наші AI-зображення без оверлея - PNG, а завантаження бувають будь-якими → перед IG-публікацією
// робимо сумісну копію: конвертація в JPEG + за потреби центр-кроп до найближчої допустимої пропорції.
// story: для сторіс пропорцію НЕ чіпаємо (9:16 - саме те, що треба, а кроп до 0.8 зрізав би пів
// кадру) - лише JPEG. Копія сторіс має свій ключ, щоб не сплутатись із кропом для стрічки.
export async function ensureIgSafeImage(ws: string, filename: string, opts?: { story?: boolean }): Promise<string> {
  const story = opts?.story === true;
  const key = story ? `story:${filename}` : filename;
  // ДЕДУП: сумісну копію для цього файлу вже робили (повторна публікація/адаптація) → реюзаємо,
  // а не плодимо дублі в медіатеці (external_id = ім'я оригіналу)
  const existing = await one<{ filename: string }>(
    `select filename from media_asset where workspace_id=$1 and source='ig-safe' and external_id=$2 order by created_at desc limit 1`,
    [ws, key]);
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
  const okRatio = story || (ratio >= MIN && ratio <= MAX);
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
  const saved = await saveMedia(ws, { buffer: out, mime: "image/jpeg", name: "ig-safe.jpg", source: "ig-safe", externalId: key });
  return saved.filename;
}

// ---- Стокові фото Pexels: 2-3 варіанти під тему поста (безкоштовна альтернатива AI-генерації) ----
export type StockPhoto = { url: string; thumb: string; photographer: string; alt: string };
export async function stockPhotoOptions(ws: string, postText: string, aspect?: string, givenQuery?: string): Promise<StockPhoto[]> {
  if (!env.pexels.apiKey) throw new Error("Стокові фото недоступні: немає ключа Pexels (адміністратор додає його в Налаштування → Профіль → Ключі провайдерів)");
  // Готовий запит (його дає Claude через конектор) - без виклику моделі, тобто безкоштовно.
  // Інакше 1 дешевий виклик: тема поста → 2-3 англ. пошукові слова (конкретні обʼєкти, не абстракції).
  let query = (givenQuery || "").trim().slice(0, 80) || "modern workspace";
  if (!(givenQuery || "").trim()) try {
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
export async function attachStockPhoto(ws: string, postId: string, url: string, aspect?: string, append?: boolean): Promise<{ id: string; filename: string }> {
  if (!/^https:\/\/images\.pexels\.com\//.test(url)) throw new Error("дозволені лише фото з Pexels");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let buf: Buffer;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; socialio/1.0)", Accept: "image/*" } });
    if (!res.ok) throw new Error(res.status === 404
      ? "Pexels не знайшов фото за цією адресою - візьми url саме з результатів пошуку стоку (find_stock_photos)"
      : `Pexels не віддав фото (HTTP ${res.status}) - спробуй інше фото або ще раз за хвилину`);
    buf = Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(timer); }
  const saved = await saveMedia(ws, { buffer: buf, mime: "image/jpeg", name: "pexels.jpg", source: "pexels" });
  if (append) {
    try { return await appendCroppedSlide(ws, postId, saved.id, aspect); }
    finally { await dropUnusedDerived(ws, [{ id: saved.id }]); } // лишається кроп-копія, сирий стоковий файл - ні
  }
  return attachCroppedImage(ws, postId, saved.id, aspect);
}
