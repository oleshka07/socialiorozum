// 🗣 Озвучка для монтажу відео: текст → голос + час кожного слова (для караоке-субтитрів).
//
// Два провайдери. ElevenLabs - живий голос (і клон голосу автора), і він сам каже, коли звучить кожна
// літера, тож субтитри лягають точно під голос. Azure Speech - запасний: голос простіший, а часу слів
// його REST не віддає, тож слова розкладаються по тривалості (для речень досить, караоке - грубіше).
// Провайдер обирається на ВЕСЬ ролик: якщо ElevenLabs впав на третьому кліпі, переозвучуємо все
// Azure - інакше в одному ролику говорили б два різні голоси.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { env } from "./env.js";
import { logEvent } from "./log.js";
import { wordsFromAlignment, wordsEvenly, type Word } from "./montage-plan.js";

export type TtsProvider = "elevenlabs" | "azure";
// Стандартний голос ElevenLabs, доступний кожному акаунту (і безкоштовному), - поки автор не обрав свій
export const ELEVEN_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";

export function ttsAvailable(): Record<TtsProvider, boolean> {
  return { elevenlabs: !!env.elevenlabs.apiKey, azure: !!env.azure.speechKey };
}
export const ttsReady = (): boolean => { const a = ttsAvailable(); return a.elevenlabs || a.azure; };

/** Технічна відмова ElevenLabs → що робити людині. */
export function humanElevenError(status: number, body: any): string {
  const d = body?.detail;
  const code = String((d && typeof d === "object" ? d.status || d.code : "") || "");
  const msg = String((d && typeof d === "object" ? d.message : d) || body?.message || "");
  if (code === "quota_exceeded" || /quota|credits? (are|is) (exhausted|insufficient)/i.test(msg))
    return "ElevenLabs: на рахунку скінчились символи - поповни тариф або озвуч голосовим повідомленням";
  if (code === "missing_permissions") return "ElevenLabs: у ключа нема права Text to Speech - створи ключ із цим правом (Developers → API Keys)";
  if (code === "invalid_api_key" || (status === 401 && !msg)) return "ElevenLabs: ключ не прийнято - перевір його в Налаштування → Профіль → Ключі провайдерів";
  if (code === "voice_not_found" || status === 404) return "ElevenLabs: такого голосу немає - перевір Voice ID (ElevenLabs → Voices → ⋯ → Copy voice ID)";
  if (status === 402 || code === "payment_required" || /upgrade|paid plan|subscription/i.test(msg))
    return "ElevenLabs: цей голос доступний лише на платному тарифі - обери стандартний голос або онови тариф";
  if (status === 401) return `ElevenLabs: доступ заборонено - ${msg.slice(0, 140)}`;
  if (status === 429) return "ElevenLabs: забагато запитів одночасно - спробуй за хвилину";
  if (status >= 500) return "ElevenLabs тимчасово недоступний - спробуй за хвилину";
  return `ElevenLabs: ${(msg || `HTTP ${status}`).slice(0, 160)}`;
}

// Azure: голос під мову ролика (для чеського бренду український голос звучав би дико)
const AZURE_VOICES: Record<string, [string, string]> = {
  uk: ["uk-UA", ""], cs: ["cs-CZ", "cs-CZ-VlastaNeural"], sk: ["sk-SK", "sk-SK-ViktoriaNeural"], pl: ["pl-PL", "pl-PL-ZofiaNeural"],
  de: ["de-DE", "de-DE-KatjaNeural"], en: ["en-US", "en-US-JennyNeural"], es: ["es-ES", "es-ES-ElviraNeural"],
  fr: ["fr-FR", "fr-FR-DeniseNeural"], it: ["it-IT", "it-IT-ElsaNeural"], ru: ["ru-RU", "ru-RU-SvetlanaNeural"],
};
export function azureVoice(lang: string): { locale: string; voice: string } {
  const [locale, voice] = AZURE_VOICES[lang] || AZURE_VOICES.uk;
  return { locale, voice: voice || env.azure.voice };
}
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function probeSec(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); resolve(0); }, 20000);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => { clearTimeout(t); resolve(parseFloat(out.trim()) || 0); });
    p.on("error", () => { clearTimeout(t); resolve(0); });
  });
}

async function viaEleven(text: string, dest: string, voiceId: string): Promise<{ duration: number; words: Word[] }> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 120000);
  let res: Response;
  try {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST", signal: c.signal,
      headers: { "xi-api-key": env.elevenlabs.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ text, model_id: env.elevenlabs.model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
  } catch (e: any) {
    throw new Error(e?.name === "AbortError" ? "ElevenLabs не відповів за 2 хв - спробуй коротший текст" : "ElevenLabs недоступний - спробуй за хвилину");
  } finally { clearTimeout(t); }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(humanElevenError(res.status, j));
  const b64 = String(j?.audio_base64 || "");
  if (!b64) throw new Error("ElevenLabs повернув порожній звук");
  await writeFile(dest, Buffer.from(b64, "base64"));
  const duration = await probeSec(dest);
  let words = wordsFromAlignment(j?.alignment || j?.normalized_alignment);
  if (!words.length) words = wordsEvenly(text, 0, duration || text.length / 14);
  return { duration: duration || (words.length ? words[words.length - 1].e + 0.2 : 0), words };
}

async function viaAzure(text: string, dest: string, lang: string): Promise<{ duration: number; words: Word[] }> {
  const v = azureVoice(lang);
  const ssml = `<speak version='1.0' xml:lang='${v.locale}'><voice name='${v.voice}'>${xml(text)}</voice></speak>`;
  const res = await fetch(`https://${env.azure.speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": env.azure.speechKey, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3", "User-Agent": "Holos-montage" },
    body: ssml,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("Azure Speech: ключ не прийнято - перевір AZURE_SPEECH_KEY і регіон");
    if (res.status === 429) throw new Error("Azure Speech: вичерпано ліміт - спробуй за хвилину");
    throw new Error(`Azure Speech ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  const duration = await probeSec(dest);
  return { duration, words: wordsEvenly(text, 0.05, Math.max(0.3, duration - 0.1)) };
}

/**
 * Озвучити кілька шматків (кожен кліп - свій текст) ОДНИМ провайдером. dests[i] - куди покласти mp3.
 * Порожній текст - null (кліп без озвучки).
 */
export async function synthesizeAll(texts: string[], dests: string[], o: { lang: string; voiceId?: string | null }):
  Promise<{ provider: TtsProvider; parts: Array<{ duration: number; words: Word[] } | null> }> {
  const avail = ttsAvailable();
  const order: TtsProvider[] = (["elevenlabs", "azure"] as TtsProvider[]).filter((p) => avail[p]);
  if (!order.length) throw new Error("AI-голос не підключено: адмін додає ключ ElevenLabs (або Azure Speech) у Налаштування → Профіль → Ключі провайдерів. Або озвуч сам - голосовим повідомленням.");
  const voiceId = String(o.voiceId || env.elevenlabs.voiceId || ELEVEN_DEFAULT_VOICE).trim();
  let first = "";
  for (const p of order) {
    try {
      const parts: Array<{ duration: number; words: Word[] } | null> = [];
      for (let i = 0; i < texts.length; i++) {
        const t = String(texts[i] || "").trim();
        parts.push(t ? (p === "elevenlabs" ? await viaEleven(t, dests[i], voiceId) : await viaAzure(t, dests[i], o.lang)) : null);
      }
      if (first) await logEvent("warn", "tts", `ElevenLabs не впорався (${first}) - озвучено Azure`).catch(() => {});
      return { provider: p, parts };
    } catch (e: any) {
      if (!first) first = String(e?.message || e).slice(0, 200);
    }
  }
  // обидва впали - причина ПЕРШОГО: його обрали свідомо (ключ ElevenLabs), і саме про нього треба знати
  throw new Error(first || "озвучка не вдалась");
}
