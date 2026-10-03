// 🔎 Пошуковики: IndexNow і чесна дата <lastmod> у sitemap.
//
// Google сюди не входить: про holos.rozum.one він дізнається з Search Console, де домен rozum.one
// підтверджено DNS-записом (TXT google-site-verification) ще з травня - усі піддомени вже під ним,
// туди лишається подати sitemap. IndexNow ж одним запитом каже Bing (і тим, хто бере його індекс:
// DuckDuckGo, Yahoo, ChatGPT-пошук, Copilot), Seznam, Yandex, Naver і Yep, що сторінка з'явилась чи
// змінилась - без кабінетів вебмайстра.
//
// Сторінка змінилась, коли змінився відбиток її вмісту (sha256 того, що віддаємо). Тоді в неї нова
// дата lastmod, і IndexNow отримує саме її; незмінене вдруге не шлемо (протокол просить не повторювати
// те саме). Ключ IndexNow - не секрет: протокол вимагає віддавати його файлом /<ключ>.txt, щоб пошуковик
// переконався, що запит від власника сайту. Лише прод: бета закрита (PIN, robots «Disallow: /»).
import { createHash, randomBytes } from "node:crypto";
import { q, one } from "./db.js";
import { logEvent } from "./log.js";

export type SeoPage = { hash: string; at: string; pinged?: string };
export type SeoPing = { at: string; status: number; urls: string[]; error?: string };
export type SeoState = { key: string; pages: Record<string, SeoPage>; ping?: SeoPing };

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** Новий ключ IndexNow: 32 шістнадцяткові знаки (протокол: від 8 до 128 знаків a-z, A-Z, 0-9 і «-»). */
export const newIndexNowKey = (): string => randomBytes(16).toString("hex");
export const isIndexNowKey = (k: unknown): k is string => typeof k === "string" && /^[A-Za-z0-9-]{8,128}$/.test(k);
export const pageHash = (content: string): string => createHash("sha256").update(content).digest("hex").slice(0, 20);

/**
 * Звести свіжі відбитки сторінок зі збереженими: де вміст змінився - нова дата `today`, решта як була.
 * `changed` - чий вміст змінився саме зараз; `pending` - про що IndexNow ще не знає (змінене зараз або
 * минулого разу не прийняте). Сторінки, якої більше нема серед відбитків, нема й у результаті.
 */
export function reconcilePages(prev: Record<string, SeoPage> | undefined, hashes: Record<string, string>, today: string)
  : { pages: Record<string, SeoPage>; changed: string[]; pending: string[] } {
  const pages: Record<string, SeoPage> = {};
  const changed: string[] = [];
  for (const [path, hash] of Object.entries(hashes)) {
    const old = prev?.[path];
    if (old && old.hash === hash && old.at) { pages[path] = old; continue; }
    pages[path] = { hash, at: today, ...(old?.pinged ? { pinged: old.pinged } : {}) };
    changed.push(path);
  }
  const pending = Object.keys(pages).filter((p) => pages[p].pinged !== pages[p].hash);
  return { pages, changed, pending };
}

/** Чи слати IndexNow: лише відкритий інстанс на справжній https-адресі. `INDEXNOW=0` - вимкнути. */
export function indexNowEnabled(baseUrl: string, closed: boolean, flag?: string): boolean {
  if (closed) return false;
  if (flag && /^(0|off|false|no)$/i.test(flag.trim())) return false;
  let u: URL;
  try { u = new URL(baseUrl); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h.endsWith(".localhost") || h.endsWith(".local")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return false;
  return true;
}

/** Тіло запиту IndexNow: хост, ключ, де лежить файл ключа, і повні адреси сторінок. */
export function indexNowBody(baseUrl: string, key: string, paths: string[]): { host: string; key: string; keyLocation: string; urlList: string[] } {
  const base = baseUrl.replace(/\/$/, "");
  return { host: new URL(base).host, key, keyLocation: `${base}/${key}.txt`, urlList: paths.map((p) => base + p) };
}

/** Відповідь IndexNow людською мовою - для журналу й адмінки. */
export function indexNowText(status: number): string {
  switch (status) {
    case 200: return "прийнято";
    case 202: return "прийнято, ключ ще перевіряють";
    case 400: return "невірний запит";
    case 403: return "ключ не прийнято: файл ключа недоступний або не збігається";
    case 422: return "адреси не з цього сайту або ключ не за протоколом";
    case 429: return "забагато запитів, повторимо пізніше";
    default: return status ? `код ${status}` : "немає відповіді";
  }
}

// ---------- стан сервісу (app_setting 'seo') ----------
let S: SeoState | null = null;
let on = false;
let base = "";
let endpoint = INDEXNOW_ENDPOINT;
let timer: ReturnType<typeof setInterval> | null = null;

/** Адреса файлу ключа IndexNow («/<ключ>.txt») - лише коли IndexNow увімкнено. */
export const indexNowKeyPath = (): string | null => (S && on ? `/${S.key}.txt` : null);
export const indexNowKey = (): string => S?.key || "";

/** Дати для sitemap: коли вміст кожної сторінки востаннє змінився. */
export function sitemapDates(): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [p, v] of Object.entries(S?.pages || {})) o[p] = v.at;
  return o;
}

async function save(): Promise<void> {
  if (!S) return;
  await q(`insert into app_setting(name, value, updated_by) values('seo',$1,'system')
           on conflict (name) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`, [JSON.stringify(S)]);
}

/**
 * На старті: відбитки сторінок → дати lastmod (змінене сьогодні - сьогодні), ключ IndexNow (раз і назавжди).
 * `pages` - шлях сторінки → те, що вона зараз віддає.
 */
export async function initSeo(o: { baseUrl: string; closed: boolean; pages: Record<string, string>; flag?: string; endpoint?: string })
  : Promise<{ changed: string[]; pending: string[] }> {
  base = o.baseUrl.replace(/\/$/, "");
  on = indexNowEnabled(base, o.closed, o.flag);
  endpoint = o.endpoint || INDEXNOW_ENDPOINT;
  const row = await one<{ value: any }>(`select value from app_setting where name='seo'`).catch(() => null);
  const prev = (row?.value || {}) as Partial<SeoState>;
  const today = new Date().toISOString().slice(0, 10);
  const hashes = Object.fromEntries(Object.entries(o.pages).map(([p, c]) => [p, pageHash(c)]));
  const r = reconcilePages(prev.pages, hashes, today);
  S = { key: isIndexNowKey(prev.key) ? prev.key : newIndexNowKey(), pages: r.pages, ...(prev.ping ? { ping: prev.ping } : {}) };
  await save();
  if (r.changed.length) await logEvent("info", "seo", `вміст змінився: ${r.changed.join(", ")} - lastmod ${today}`);
  return { changed: r.changed, pending: on ? r.pending : [] };
}

/**
 * Повідомити IndexNow про те, чого він ще не знає. 200/202 - прийнято (сторінки позначаються);
 * інше - лишається на наступну спробу. Після відмови 400/403/422 (налаштування, а не мережа) автоматичні
 * спроби - не частіше разу на добу; перша спроба після старту (новий деплой міг полагодити) - завжди.
 */
export async function pingIndexNow(opts: { fromStart?: boolean } = {}): Promise<SeoPing | null> {
  if (!S || !on) return null;
  const st = S;
  const pending = Object.keys(st.pages).filter((p) => st.pages[p].pinged !== st.pages[p].hash);
  if (!pending.length) return null;
  const last = st.ping;
  if (!opts.fromStart && last && [400, 403, 422].includes(last.status) && Date.now() - Date.parse(last.at) < 24 * 3600_000) return null;
  const body = indexNowBody(base, st.key, pending);
  let status = 0;
  let error = "";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    if (status !== 200 && status !== 202) error = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
  } catch (e: any) {
    error = String(e?.message || e).slice(0, 200);
  }
  const ok = status === 200 || status === 202;
  if (ok) for (const p of pending) st.pages[p].pinged = st.pages[p].hash;
  st.ping = { at: new Date().toISOString(), status, urls: body.urlList, ...(error ? { error } : {}) };
  await save().catch(() => {});
  if (ok) await logEvent("info", "seo", `IndexNow: ${pending.length} стор. - ${indexNowText(status)} (${status})`);
  else await logEvent("warn", "seo", `IndexNow не прийняв ${pending.length} стор.: ${indexNowText(status)}${error ? " - " + error : ""}`);
  return st.ping;
}

/** Перша спроба - за кілька секунд після старту (файл ключа вже віддається), далі раз на 6 год, поки є неприйняте. */
export function startIndexNow(firstMs = 15_000): void {
  if (!on || timer) return;
  setTimeout(() => { pingIndexNow({ fromStart: true }).catch(() => {}); }, firstMs).unref?.();
  timer = setInterval(() => { pingIndexNow().catch(() => {}); }, 6 * 3600_000);
  timer.unref?.();
}

/** Для адмінки: чи працює IndexNow, файл ключа, остання відповідь і дати сторінок. */
export function seoView(): { indexNow: boolean; keyFile: string | null; ping: SeoPing | null; pages: { path: string; lastmod: string; notified: boolean }[] } {
  return {
    indexNow: on,
    keyFile: S && on ? `${base}/${S.key}.txt` : null,
    ping: S?.ping || null,
    pages: Object.entries(S?.pages || {}).map(([path, v]) => ({ path, lastmod: v.at, notified: v.pinged === v.hash })),
  };
}
