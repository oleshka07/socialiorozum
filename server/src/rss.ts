// Власний RSS 2.0 / Atom парсер на регексах — без зовнішніх залежностей.
export type RssItem = { externalId: string; title: string; content: string; link: string };

function decode(s: string): string {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
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
