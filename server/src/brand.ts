// 🏷 Назва продукту й адреси. Людина бачить «Holos» (повна назва - «Holos by Rozum»); внутрішнє ім'я
// коду й інфраструктури лишається socialio: репозиторій, compose-проєкт `socialio`, томи
// `socialio_pgdata` / `socialio_media`, /opt/socialio, назви змінних .env, ключі localStorage.
// Перейменування compose-проєкту підняло б сервіс з ПОРОЖНІМИ томами, а людині ці імена не видно.
// Чисті функції - під юнітами (test/brand.test.mjs).

export const BRAND = "Holos";
export const BRAND_FULL = "Holos by Rozum";

/**
 * Відправник листів. У .env серверів досі «socialio <noreply@rozum.one>» - таке ім'я підміняємо на
 * нову назву (адреса лишається: домен rozum.one у Resend підтверджено), будь-яке інше поважаємо.
 */
export function brandedFrom(from: string): string {
  const m = /^\s*"?socialio"?\s*<([^>]+)>\s*$/i.exec(from || "");
  return m ? `${BRAND} <${m[1]}>` : from;
}

/**
 * Звідки переїхав КОЖЕН інстанс: нова адреса → стара. Саме «цього інстансу», а не всі старі
 * адреси разом: за старою адресою ІНШОГО інстансу (прод ↔ бета) живуть його вебхуки, і перевести
 * їх на себе означало б украсти чужого бота.
 */
export const LEGACY_BY_HOST: Record<string, string[]> = {
  "holos.rozum.one": ["socialio.rozum.one"],
  "beta.holos.rozum.one": ["beta.socialio.rozum.one"],
};

export const hostOf = (url: string): string => {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
};

/**
 * Старі адреси цього інстансу: з LEGACY_HOSTS (через кому) або з LEGACY_BY_HOST за власною адресою.
 * До перемикання (APP_BASE_URL ще socialio) старих адрес нема - нічого не змінюється. Власна адреса
 * старою не буває ніколи.
 */
export function legacyHosts(baseUrl: string, raw?: string): Set<string> {
  const own = hostOf(baseUrl);
  const list = raw && raw.trim() ? raw.split(",") : (LEGACY_BY_HOST[own] || []);
  return new Set(list.map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter((h) => h && h !== own));
}

/**
 * Сторінки, які зі старої адреси перекидаються на нову (301 з тим самим шляхом і query; якір
 * `#/post/…` браузер переносить сам). Лише те, що людина відкриває в браузері. Усе інше на старій
 * адресі працює як було: вебхуки Telegram/Fireflies/Vymova, конектори Claude (`/mcp/…`) і разові
 * посилання на заливку, медіа й мініатюри в уже опублікованих постах, Mini App, `/api` (вкладка,
 * відкрита до перемикання, не падає), OAuth-повернення, почате на старій адресі (state-кукі там).
 * robots.txt і sitemap.xml теж переїжджають: пошуковик має бачити правила й карту НОВОЇ адреси.
 */
const LEGACY_PAGES = new Set(["/", "/index.html", "/app", "/b", "/B", "/login", "/register", "/forgot", "/reset", "/privacy", "/terms", "/data-deletion", "/api/auth/verify", "/robots.txt", "/sitemap.xml"]);

export function legacyRedirect(o: { host?: string; method?: string; url?: string; baseUrl: string; legacy: Set<string> }): string | null {
  const host = String(o.host || "").toLowerCase().replace(/:\d+$/, "");
  if (!host || !o.legacy.has(host)) return null;
  if (o.method !== "GET" && o.method !== "HEAD") return null;
  const url = String(o.url || "/");
  const path = url.split("?")[0];
  if (!LEGACY_PAGES.has(path)) return null;
  return o.baseUrl.replace(/\/$/, "") + url;
}

/**
 * Чи адреса вебхука власного бота дивиться на ЦЕЙ сервіс: на нову адресу чи на одну зі старих.
 * Такі переводимо на нову при старті; чужий інстанс (бета, інший сервер) не чіпаємо.
 */
export function isOurHookUrl(url: string, baseUrl: string, legacy: Set<string>): boolean {
  if (!url) return false;
  const path = "/api/webhooks/telegram/";
  if (url.startsWith(baseUrl.replace(/\/$/, "") + path)) return true;
  const h = hostOf(url);
  return !!h && legacy.has(h) && url.startsWith(`https://${h}${path}`);
}
