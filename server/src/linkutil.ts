// 🔗 Короткі посилання й сторінка «посилання в біо» - ЧИСТІ помічники (без БД): посилання в тексті,
// UTM-мітки, коди, боти-прев'юшники, адреса сторінки і її HTML. База й маршрути - links.ts.
import { randomBytes } from "node:crypto";

// посилання в тексті поста: до пробілу, лапок чи кутових дужок
const URL_RX = /https?:\/\/[^\s<>"'«»]+/gi;
/** Розділові знаки в кінці - частина речення, а не посилання («див. https://a.com/x.»). */
function trimUrl(raw: string): string {
  let u = raw.replace(/[.,!?:;…»"']+$/u, "");
  // закривальна дужка - з тексту, якщо в самому посиланні відкривальних менше («(див. https://a.com)»)
  while (u.endsWith(")") && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
  return u;
}
export function findUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || "").matchAll(URL_RX)) {
    const u = trimUrl(m[0]);
    if (u.length > 10 && !out.includes(u)) out.push(u);
  }
  return out;
}
/** Замінити посилання в тексті за мапою «як написано → коротке»; решта тексту (і розділові після посилання) - як були. */
export function replaceUrls(text: string, map: Map<string, string>): string {
  return String(text || "").replace(URL_RX, (m) => {
    const u = trimUrl(m);
    const s = map.get(u);
    return s ? s + m.slice(u.length) : m;
  });
}

/** UTM-мітки: лише ті, яких у посиланні ще нема (людина могла поставити свої), лише http(s). */
export function withUtm(url: string, utm: Record<string, string>): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return url;
  let changed = false;
  for (const [k, v] of Object.entries(utm)) if (v && !u.searchParams.has(k)) { u.searchParams.set(k, v); changed = true; }
  return changed ? u.toString() : url;
}
/** Куди можна вести коротке посилання: лише http(s) з нормальним хостом. */
export function safeTarget(url: string): string | null {
  let u: URL;
  try { u = new URL(String(url || "").trim()); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname.includes(".") || u.username || u.password) return null;
  return u.toString();
}

// код: без схожих символів (0/O, 1/l/I) - щоб людина могла переписати з картинки
const ALPH = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newCode(len = 7): string {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPH[b[i] % ALPH.length];
  return s;
}
export const isCode = (s: string) => /^[a-zA-Z0-9]{5,12}$/.test(String(s || ""));

// Боти, що тягнуть посилання для прев'ю (Telegram, Facebook, LinkedIn…), - не перехід людини.
// Свідомо НЕ «telegram» чи «instagram» цілком: це вбудовані браузери застосунків, там живі люди.
const BOT_RX = /(TelegramBot|facebookexternalhit|Facebot|LinkedInBot|Twitterbot|Slackbot|Discordbot|WhatsApp\/|Googlebot|bingbot|Applebot|YandexBot|DuckDuckBot|Baiduspider|Pinterestbot|redditbot|Embedly|Iframely|vkShare|SkypeUriPreview|Mastodon|Bluesky|HeadlessChrome|python-requests|curl\/|Wget|\bbot\b|crawler|spider)/i;
export const isBot = (ua: string | undefined) => !ua || BOT_RX.test(ua);

/** Адреса сторінки: holos.rozum.one/@<slug> - латиниця, цифри, крапка, дефіс, підкреслення; 3-30 символів. */
export function normSlug(s: string): string | null {
  const v = String(s || "").trim().toLowerCase().replace(/^@/, "");
  return /^[a-z0-9](?:[a-z0-9._-]{1,28})[a-z0-9]$/.test(v) && !/[._-]{2}/.test(v) ? v : null;
}

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export type BioLink = { title: string; href: string; emoji?: string };
export type BioTile = { title: string; href: string; img: string | null };
export type BioPageData = { title: string; bio: string; links: BioLink[]; tiles: BioTile[]; base: string; slug: string; ogImage: string | null; noindex: boolean };
function initials(t: string): string {
  const w = String(t || "").trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || "") + (w[1]?.[0] || "")).toUpperCase() || "•";
}
/** Сторінка «посилання в біо»: без скриптів, швидка на телефоні, світла й темна тема. */
export function bioHtml(d: BioPageData): string {
  const url = `${d.base}/@${d.slug}`;
  const desc = (d.bio || d.title).replace(/\s+/g, " ").slice(0, 200);
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.title)}</title><meta name="description" content="${esc(desc)}">${d.noindex ? '<meta name="robots" content="noindex">' : ""}
<link rel="canonical" href="${esc(url)}"><link rel="icon" href="/favicon.svg">
<meta property="og:type" content="profile"><meta property="og:title" content="${esc(d.title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}">${d.ogImage ? `<meta property="og:image" content="${esc(d.ogImage)}">` : ""}
<style>
:root{--bg:#fbf8f6;--ink:#1d1a1c;--muted:#6b6468;--card:#fff;--line:#e8e1e4;--acc:#c20f57;--av:#c20f57}
@media (prefers-color-scheme:dark){:root{--bg:#141013;--ink:#f3eef0;--muted:#a79ea3;--card:#1e181c;--line:#33292f;--acc:#ff5c93;--av:#d9145d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:36px 16px 28px;text-align:center}
.av{width:84px;height:84px;border-radius:50%;margin:0 auto 12px;display:grid;place-items:center;background:var(--av);color:#fff;font-weight:800;font-size:30px}
h1{font-size:22px;margin:0 0 6px}.bio{color:var(--muted);margin:0 0 22px;white-space:pre-line}
.links{display:flex;flex-direction:column;gap:10px;margin-bottom:28px}
.btn{display:block;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--ink);text-decoration:none;font-weight:650;overflow-wrap:anywhere}
.btn:hover,.btn:focus-visible{border-color:var(--acc);outline:none}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:28px}
.tile{position:relative;display:block;aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--card);border:1px solid var(--line);color:var(--ink);text-decoration:none}
.tile img{width:100%;height:100%;object-fit:cover;display:block}
.tile .cap{display:block;position:absolute;inset:auto 0 0 0;padding:14px 7px 6px;background:linear-gradient(transparent,rgba(0,0,0,.75))}
.tile .cap span{font-size:11.5px;line-height:1.25;text-align:left;color:#fff;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tile.txt .cap{position:static;background:none;padding:10px}
.tile.txt .cap span{color:var(--ink);font-size:12.5px;-webkit-line-clamp:6}
footer{font-size:12px;color:var(--muted)}footer a{color:var(--muted)}
</style></head><body><main>
<div class="av" aria-hidden="true">${esc(initials(d.title))}</div>
<h1>${esc(d.title)}</h1>${d.bio ? `<p class="bio">${esc(d.bio)}</p>` : ""}
${d.links.length ? `<nav class="links" aria-label="Посилання">${d.links.map((l) => `<a class="btn" href="${esc(l.href)}" rel="noopener">${l.emoji ? esc(l.emoji) + " " : ""}${esc(l.title)}</a>`).join("")}</nav>` : ""}
${d.tiles.length ? `<h2>Останні пости</h2><div class="grid">${d.tiles.map((t) => `<a class="tile${t.img ? "" : " txt"}" href="${esc(t.href)}" rel="noopener">${t.img ? `<img src="${esc(t.img)}" alt="" loading="lazy">` : ""}<span class="cap"><span>${esc(t.title)}</span></span></a>`).join("")}</div>` : ""}
<footer><a href="${esc(d.base)}/">Зроблено в Holos</a></footer>
</main></body></html>`;
}
