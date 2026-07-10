// Резолвер джерел-стрічок: перетворює «те, що ввів користувач» у валідний feed URL + прев'ю.
// Флоу «Додати джерело»: resolve (цей модуль, нічого не зберігає) → юзер бачить прев'ю → підтверджує → POST /sources/rss.
// Типи: 'news' (Google News за темою або готовий RSS-URL), 'rss' (прямий URL з автопошуком фіда),
// 'telegram' (публічний канал через self-hosted RSSHub /telegram/channel/:user - без API і логіну).
import { env } from "./env.js";
import { fetchFeedRaw, parseFeed, parseFeedTitle } from "./rss.js";

export type SourceType = "news" | "rss" | "telegram";
export type ResolveResult = {
  feedUrl: string;
  title: string;
  preview: { title: string; link: string }[]; // 3-5 останніх айтемів — юзер підтверджує, що бачить те джерело
  note?: string;
};

// Google News RSS: пошук за ключовими словами, мова/регіон через hl/gl/ceid (безкоштовно, без ключа)
function googleNewsUrl(queryRaw: string, lang: string): string {
  const query = queryRaw.trim().slice(0, 200);
  const loc = lang === "en"
    ? "hl=en-US&gl=US&ceid=US:en"
    : lang === "cs" ? "hl=cs&gl=CZ&ceid=CZ:cs" : "hl=uk&gl=UA&ceid=UA:uk";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${loc}`;
}

// людські повідомлення замість HTTP-статусів
function humanError(e: any): Error {
  const m = String(e?.message || e);
  if (/timeout/i.test(m)) return new Error("Джерело зараз недоступне (не відповідає). Спробуй ще раз за хвилину.");
  if (/HTTP 40[34]/.test(m)) return new Error("Не бачу стрічку за цим посиланням. Профіль може бути приватним або посилання невірне.");
  if (/HTTP 4\d\d/.test(m)) return new Error("Джерело відхилило запит. Перевір посилання.");
  if (/HTTP 5\d\d/.test(m)) return new Error("На боці джерела помилка. Спробуй пізніше.");
  return new Error("Не вдалося прочитати стрічку: " + m.slice(0, 120));
}

// перевіряє URL як фід і збирає прев'ю; кидає якщо це не валідна стрічка з айтемами
async function validateFeed(feedUrl: string): Promise<ResolveResult> {
  let xml: string;
  try { xml = await fetchFeedRaw(feedUrl); } catch (e) { throw humanError(e); }
  const items = parseFeed(xml);
  if (!items.length) throw new Error("Стрічка порожня - постів не бачу. Перевір посилання або спробуй іншу тему.");
  return {
    feedUrl,
    title: parseFeedTitle(xml) || feedUrl,
    preview: items.slice(0, 5).map((it) => ({ title: (it.title || it.content || "").slice(0, 140), link: it.link })),
  };
}

// прямий URL: якщо сама сторінка не фід - пробуємо типові шляхи (/feed, /rss, …), як роблять читалки
async function resolveDirectUrl(input: string): Promise<ResolveResult> {
  const base = input.replace(/\/+$/, "");
  const candidates = [input, `${base}/feed`, `${base}/rss`, `${base}/feed.xml`, `${base}/rss.xml`, `${base}/atom.xml`];
  let lastErr: Error | null = null;
  for (const url of candidates) {
    try { return await validateFeed(url); } catch (e: any) { if (!lastErr) lastErr = e; }
  }
  throw lastErr || new Error("Не знайшов RSS за цим посиланням.");
}

export async function resolveSource(type: SourceType, inputRaw: string, lang?: string): Promise<ResolveResult> {
  const input = (inputRaw || "").trim();
  if (!input) throw new Error("Введи тему або посилання.");
  if (type === "telegram") {
    // приймаємо будь-який формат: https://t.me/durov · t.me/s/durov · @durov · durov
    const m = input.match(/(?:t\.me\/(?:s\/)?|@)?([A-Za-z0-9_]{4,32})\/?$/);
    if (!m) throw new Error("Не схоже на Telegram-канал. Встав @назву або посилання t.me/канал.");
    const user = m[1];
    let r: ResolveResult;
    try { r = await validateFeed(`${env.rsshub.baseUrl}/telegram/channel/${user}`); }
    catch (e: any) {
      if (/HTTP 40|порожня|Не бачу/i.test(String(e.message))) throw new Error(`Не бачу канал @${user}. Він існує і публічний? Приватні канали підключити не можна.`);
      throw e;
    }
    return { ...r, title: r.title || `TG: @${user}`, note: "Telegram-канал" };
  }
  if (type === "news") {
    // авто-детект: посилання → як прямий фід; текст → пошук Google News за темою
    if (/^https?:\/\//i.test(input)) return resolveDirectUrl(input);
    const r = await validateFeed(googleNewsUrl(input, lang || "uk"));
    return { ...r, title: `Новини: ${input.slice(0, 120)}`, note: "Google News, оновлюється автоматично" };
  }
  if (!/^https?:\/\//i.test(input)) throw new Error("Для RSS-стрічки потрібне посилання (https://…). Для пошуку за темою обери «Новини за темою».");
  return resolveDirectUrl(input);
}
