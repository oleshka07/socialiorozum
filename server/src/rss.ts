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

// тягне сторінку статті (з редіректами) і повертає текст; "" якщо не вдалося (сайт закритий/JS-only)
export async function fetchArticleText(link: string): Promise<string> {
  if (!/^https?:\/\//i.test(link || "")) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(link, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; socialio/1.0; +https://socialio.rozum.one)", Accept: "text/html" },
      redirect: "follow", signal: controller.signal,
    });
    if (!res.ok) return "";
    const html = (await res.text()).slice(0, 800_000);
    // Google News інколи віддає проміжну сторінку-редірект: витягаємо цільовий лінк видавця і йдемо за ним
    if (/news\.google\.com/i.test(res.url || link)) {
      const m = html.match(/href=["'](https?:\/\/(?!news\.google\.com|accounts\.google|support\.google)[^"']+)["']/i);
      if (m) { clearTimeout(timer); return fetchArticleText(m[1]); }
    }
    return extractParagraphs(html);
  } catch { return ""; }
  finally { clearTimeout(timer); }
}
