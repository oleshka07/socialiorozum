// Власний RSS 2.0 / Atom парсер на регексах — без зовнішніх залежностей.
export type RssItem = { externalId: string; title: string; content: string; link: string };

export function cleanText(s: string): string { return decode(s); }
function decode(s: string): string {
  // ПОРЯДОК важливий: спершу розекранувати сутності, ПОТІМ зрізати теги. Google News віддає
  // description з екранованим HTML (&lt;a href…&gt;) - якщо різати теги до розекранування,
  // «тег» виживає і показується юзеру як сирий <a href=…> текст.
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    // другий прохід: подвійно екрановані сутності (&amp;nbsp; → &nbsp; після першого) - типово для Google News
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}
function atomLink(block: string): string {
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  return m ? m[1] : "";
}

export function parseFeed(xml: string): RssItem[] {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const out: RssItem[] = [];
  for (const b of blocks) {
    const link = decode(tag(b, "link")) || atomLink(b);
    const guid = decode(tag(b, "guid")) || decode(tag(b, "id")) || link;
    const title = decode(tag(b, "title"));
    const content = decode(tag(b, "content:encoded") || tag(b, "content") || tag(b, "description") || tag(b, "summary"));
    if (!guid && !link) continue;
    out.push({ externalId: guid || link, title, content, link });
  }
  return out;
}

// назва каналу/стрічки (з <channel><title> RSS або <feed><title> Atom) — для прев'ю при підключенні
export function parseFeedTitle(xml: string): string {
  const head = xml.replace(/<item[\s\S]*$/i, "").replace(/<entry[\s\S]*$/i, "");
  return decode(tag(head, "title")).slice(0, 200);
}

export async function fetchFeedRaw(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try { res = await fetch(url, { headers: { "User-Agent": "socialio/1.0 RSS Fetcher" }, signal: controller.signal }); }
  catch (e: any) { if (e && e.name === "AbortError") throw new Error("RSS timeout 15s"); throw e; }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  return res.text();
}

export async function fetchFeed(url: string): Promise<RssItem[]> {
  return parseFeed(await fetchFeedRaw(url));
}

// ---- догрузка тексту статті за посиланням (для «тонких» фідів: Google News дає лише заголовок+джерело) ----
// Легка readability-евристика без залежностей: og:description + найбільші <p>-абзаци.
function extractParagraphs(html: string): string {
  // прибираємо script/style/nav цілком, щоб їх текст не потрапив у «статтю»
  const clean = html.replace(/<(script|style|nav|header|footer|aside|form|noscript)[\s\S]*?<\/\1>/gi, " ");
  const ogd = clean.match(/property=["']og:description["'][^>]*content=["']([^"']{40,})["']/i)
    || clean.match(/content=["']([^"']{40,})["'][^>]*property=["']og:description["']/i);
  const ps = (clean.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [])
    .map((p) => decode(p))
    .filter((t) => t.length >= 60 && !/cookie|javascript|підпис(атися|уйся)|реклам/i.test(t));
  const body = ps.join("\n\n").slice(0, 6000);
  const og = ogd ? decode(ogd[1]) : "";
  return [og, body].filter(Boolean).join("\n\n").trim();
}

async function fetchWithTimeout(url: string, init?: RequestInit, ms = 15000): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  catch { return null; }
  finally { clearTimeout(timer); }
}
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Google News ховає URL видавця за JS-редіректом. Два обходи:
// старий формат id (CBMi… base64 з URL всередині) і новий (сторінка статті містить підпис
// data-n-a-sg/ts → внутрішній batchexecute повертає справжній URL). Обидва - best-effort.
async function resolveGoogleNewsUrl(link: string): Promise<string> {
  const m = link.match(/news\.google\.com\/(?:rss\/)?articles\/([^?/]+)/i);
  if (!m) return "";
  const id = m[1];
  try { // старий формат: URL лежить прямо в base64 id
    const raw = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const um = raw.match(/https?:\/\/[\x20-\x7e]+/);
    if (um && !/news\.google/.test(um[0])) return um[0].replace(/[^\x20-\x7e]+.*$/, "");
  } catch { /* не старий формат */ }
  try { // новий формат (AU_yq…)
    const pageRes = await fetchWithTimeout(`https://news.google.com/articles/${id}`, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } });
    if (!pageRes?.ok) return "";
    const page = await pageRes.text();
    const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sg || !ts) return "";
    const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`;
    const req = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);
    const res = await fetchWithTimeout("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": BROWSER_UA },
      body: "f.req=" + encodeURIComponent(req),
    });
    if (!res?.ok) return "";
    const txt = await res.text();
    const um = txt.match(/https?:\\?\/\\?\/(?!news\.google)[^"\\]+/);
    if (um) return um[0].replace(/\\\//g, "/").replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&");
  } catch { /* формат змінився - фолбек нижче */ }
  return "";
}

// тягне сторінку статті (з редіректами) і повертає текст; "" якщо не вдалося (сайт закритий/JS-only)
export async function fetchArticleText(link: string): Promise<string> {
  if (!/^https?:\/\//i.test(link || "")) return "";
  // Google News-посилання спершу розкодовуємо у справжній URL видавця
  if (/news\.google\.com/i.test(link)) {
    const real = await resolveGoogleNewsUrl(link);
    return real ? fetchArticleText(real) : "";
  }
  const res = await fetchWithTimeout(link, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" }, redirect: "follow" });
  if (!res?.ok) return "";
  try { return extractParagraphs((await res.text()).slice(0, 800_000)); } catch { return ""; }
}
