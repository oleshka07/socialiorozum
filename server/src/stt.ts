// 🎙 Розшифровка голосу: Deepgram і Whisper як два взаємозамінні маршрути.
//
// Навіщо два. Голосове в щоденник - це єдиний спосіб, яким людина диктує живий матеріал на ходу,
// і якщо розшифровка не спрацювала, запис просто ВТРАЧЕНО: повторно надиктувати ту саму думку
// ніхто не буде. Один провайдер означає, що його збій (протух ключ, скінчилась квота, лежить API)
// коштує нам щоденника. Тому маршрутів два, і перемикання між ними автоматичне.
//
// Порядок задає налаштування кабінету (`stt_provider`: auto|deepgram|whisper), але відкат на
// другий провайдер відбувається ЗАВЖДИ - навіть якщо перший обраний явно. Вибір тут означає
// «кому віддати перевагу», а не «кого єдиного пробувати»: людині потрібен текст, а не вірність
// налаштуванню.
import { env } from "./env.js";
import { one } from "./db.js";
import { logEvent } from "./log.js";

export type SttProvider = "deepgram" | "whisper";
export type SttChoice = "auto" | SttProvider;

/** Який маршрут узагалі можливий (є ключ). */
export function sttAvailable(): Record<SttProvider, boolean> {
  return { deepgram: !!env.deepgram.apiKey, whisper: !!env.openai.apiKey };
}

/**
 * Порядок спроб. Чиста функція - саме тут найлегше зробити тиху помилку: залишити в черзі
 * провайдера без ключа (і витратити на нього спробу й час) або, навпаки, викинути відкат
 * при явному виборі (і втратити голосове через тимчасовий збій одного сервісу).
 */
export function sttOrder(choice: SttChoice, avail: Record<SttProvider, boolean>): SttProvider[] {
  const prefer: SttProvider[] = choice === "whisper" ? ["whisper", "deepgram"] : ["deepgram", "whisper"];
  return prefer.filter((p) => avail[p]);
}

/** Content-Type для Deepgram: він приймає сирі байти, тож тип беремо з розширення. */
export function audioMime(filename: string): string {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const map: Record<string, string> = {
    ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
    mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac",
    wav: "audio/wav", flac: "audio/flac", webm: "audio/webm", amr: "audio/amr",
  };
  return map[ext] || "audio/*";           // Deepgram сам визначить формат, якщо тип невідомий
}

/** Дістати текст із відповіді Deepgram, не падаючи на несподіваній формі. */
export function deepgramText(j: any): string {
  const alt = j?.results?.channels?.[0]?.alternatives?.[0];
  return String(alt?.transcript || "").trim();
}

/** Технічний статус → людське речення. Людина бачить це в чаті бота, а не в логах. */
export function humanSttError(provider: SttProvider, status: number, detail: string): string {
  const who = provider === "deepgram" ? "Deepgram" : "Whisper";
  if (status === 401 || status === 403) return `${who}: ключ не прийнято - перевір його в Налаштування → Профіль → Ключі провайдерів`;
  if (status === 402) return `${who}: на рахунку скінчились кошти`;
  if (status === 429) return `${who}: перевищено ліміт запитів - спробуй за хвилину`;
  if (status >= 500) return `${who} тимчасово недоступний - спробуй за хвилину`;
  return `${who}: ${detail.slice(0, 160)}`;
}

async function withTimeout<T>(ms: number, who: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fn(c.signal); }
  catch (e: any) { if (e?.name === "AbortError") throw new Error(`${who}: розшифровка затягнулась - спробуй коротше повідомлення`); throw e; }
  finally { clearTimeout(t); }
}

// ---- Deepgram: сирі байти в тілі, ключ у заголовку `Token` (не Bearer) ----
async function viaDeepgram(buffer: Buffer, filename: string): Promise<string> {
  const p = new URLSearchParams({ model: env.deepgram.model, smart_format: "true", punctuate: "true" });
  // «auto» вмикає визначення мови самим Deepgram - корисно, коли автор перемикається між мовами;
  // фіксована мова зазвичай точніша, тому вона й лишається дефолтом.
  if (env.deepgram.language === "auto") p.set("detect_language", "true");
  else p.set("language", env.deepgram.language);

  const res = await withTimeout(120000, "Deepgram", (signal) => fetch(`https://api.deepgram.com/v1/listen?${p}`, {
    method: "POST", signal,
    headers: { Authorization: `Token ${env.deepgram.apiKey}`, "Content-Type": audioMime(filename) },
    body: new Uint8Array(buffer),
  }));
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(humanSttError("deepgram", res.status, String(j?.err_msg || j?.error || `HTTP ${res.status}`)));
  const text = deepgramText(j);
  if (!text) throw new Error("Deepgram: порожня розшифровка");
  return text;
}

// ---- Whisper (OpenAI, ~$0.006/хв) ----
async function viaWhisper(buffer: Buffer, filename: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(buffer)], { type: audioMime(filename) }), filename || "voice.ogg");
  fd.append("model", "whisper-1");
  const res = await withTimeout(120000, "Whisper", (signal) => fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", signal, headers: { Authorization: `Bearer ${env.openai.apiKey}` }, body: fd,
  }));
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(humanSttError("whisper", res.status, String(j?.error?.message || `HTTP ${res.status}`)));
  const text = String(j.text || "").trim();
  if (!text) throw new Error("Whisper: порожня розшифровка");
  return text;
}

const RUN: Record<SttProvider, (b: Buffer, f: string) => Promise<string>> = { deepgram: viaDeepgram, whisper: viaWhisper };

/** Налаштування кабінету; невідоме значення трактуємо як auto, а не як помилку. */
export async function sttChoice(ws?: string): Promise<SttChoice> {
  if (!ws) return "auto";
  const r = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='stt_provider'`, [ws]).catch(() => null);
  const v = (r?.content || "").trim();
  return v === "deepgram" || v === "whisper" ? v : "auto";
}

/**
 * Голос → текст. Пробує провайдерів по черзі; повертає, ХТО саме впорався, щоб це було видно
 * і в журналі, і при потребі в інтерфейсі.
 */
export async function transcribeAudio(buffer: Buffer, filename: string, ws?: string): Promise<{ text: string; provider: SttProvider; fellBack: boolean }> {
  const order = sttOrder(await sttChoice(ws), sttAvailable());
  if (!order.length) throw new Error("розшифровка голосу тимчасово недоступна - напиши, будь ласка, текстом");
  const errors: string[] = [];
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    try {
      const text = await RUN[p](buffer, filename);
      if (i > 0) await logEvent("warn", "stt", `${order[0]} не впорався (${errors[0]}) - розшифровано через ${p}`, null, undefined).catch(() => {});
      return { text, provider: p, fellBack: i > 0 };
    } catch (e: any) {
      errors.push(String(e?.message || e).slice(0, 200));
    }
  }
  // Обидва впали - показуємо ПЕРШУ причину: вона про того провайдера, якого обрали свідомо.
  throw new Error(errors[0] || "не розчув - спробуй ще раз або напиши текстом");
}
