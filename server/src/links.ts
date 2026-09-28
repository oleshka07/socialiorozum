// 🔗 Короткі посилання з UTM і лічильником переходів + сторінка «посилання в біо» (п.7 дорожньої карти).
// Чисті помічники (посилання в тексті, UTM, коди, боти, HTML сторінки) - linkutil.ts.
//
// Головні рішення:
//  • Скорочення в постах - лише коли людина ввімкнула (текст поста змінюється: у мережі видно адресу
//    Holos, а не свою). Instagram - ніколи: там посилання в підписі й коментарях не клікаються.
//  • Одне коротке посилання на пост × мережу × адресу: повторна публікація, повтор хіта чи коментар
//    дають те саме посилання, а кліки видно по мережах.
//  • Рахуємо лише людей: боти-прев'юшники (Telegram, Facebook, LinkedIn…) і HEAD - ні. IP й інших
//    даних відвідувача не зберігаємо - лише скільки переходів за день.
//  • Будь-який збій скорочення - текст іде як був: посилання в пості важливіше за лічильник.
import { q, one } from "./db.js";
import { env } from "./env.js";
import { getSetting, setSetting } from "./settings.js";
import { findUrls, replaceUrls, withUtm, safeTarget, newCode, isCode, normSlug, bioHtml, type BioLink, type BioTile } from "./linkutil.js";

export type LinkSettings = { auto: boolean; utm: boolean };
export async function linkSettings(ws: string): Promise<LinkSettings> {
  const r = await getSetting<any>(ws, "links", {});
  return { auto: r?.auto === true, utm: r?.utm !== false };
}
export async function saveLinkSettings(ws: string, patch: Partial<LinkSettings>): Promise<LinkSettings> {
  const cur = await linkSettings(ws);
  const next = { auto: typeof patch.auto === "boolean" ? patch.auto : cur.auto, utm: typeof patch.utm === "boolean" ? patch.utm : cur.utm };
  await setSetting(ws, "links", next);
  return next;
}

const ourHost = () => { try { return new URL(env.appBaseUrl).host; } catch { return ""; } };
export const shortUrl = (code: string) => `${env.appBaseUrl}/s/${code}`;

type Kind = "post" | "bio" | "manual";
/** Коротке посилання: те саме на ту саму адресу (пост × мережа × адреса; біо й ручні - за адресою). */
export async function shortFor(ws: string, source: string, o: { postId?: string | null; network?: string | null; kind: Kind; title?: string | null; utm?: Record<string, string> | null }): Promise<string | null> {
  const clean = safeTarget(source);
  if (!clean) return null;
  const url = o.utm ? withUtm(clean, o.utm) : clean;
  const key = [ws, o.kind, o.postId || "", o.network || "", source];
  const find = () => one<{ code: string; url: string }>(
    `select code, url from short_link where workspace_id=$1 and kind=$2 and coalesce(post_id::text,'')=$3 and coalesce(network,'')=$4 and source_url=$5`, key);
  const ex = await find();
  if (ex) {
    // UTM увімкнули чи вимкнули - посилання те саме, веде вже по-новому
    if (ex.url !== url) await q(`update short_link set url=$2 where code=$1`, [ex.code, url]);
    return ex.code;
  }
  for (let i = 0; i < 5; i++) {
    const r = await one<{ code: string }>(
      `insert into short_link(code, workspace_id, url, source_url, post_id, network, kind, title) values($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict do nothing returning code`, [newCode(), ws, url, source, o.postId || null, o.network || null, o.kind, o.title ? String(o.title).slice(0, 120) : null]);
    if (r) return r.code;
    const raced = await find();                     // той самий ключ щойно вставив паралельний запит
    if (raced) return raced.code;
  }
  return null;
}

// Жорсткі межі поста, за якими мережа відбиває публікацію (Telegram довгий підпис шле окремим
// повідомленням, Facebook приймає десятки тисяч знаків - там межі нема)
export const LINK_HARD_MAX: Record<string, number> = { threads: 500, linkedin: 3000 };

/**
 * Посилання в тексті поста для мережі → короткі з UTM (коли людина це ввімкнула). Instagram - ні: там
 * посилання в підписі й коментарях не клікаються. Власні адреси Holos не чіпаємо.
 * max - межа мережі: коротке посилання (~33 знаки) довше за коротку адресу (t.me/x), і текст на межі
 * перевалив би її. Тоді скорочуються лише адреси, що від заміни коротшають, а не влазить і так - текст
 * як був: пост, що не вийшов, гірший за пост без лічильника.
 */
export async function linkify(ws: string, postId: string, net: string, text: string, max: number | undefined = LINK_HARD_MAX[net]): Promise<string> {
  if (!text || net === "instagram") return text;
  const s = await linkSettings(ws);
  if (!s.auto) return text;
  const host = ourHost();
  const urls = findUrls(text).filter((u) => { try { return new URL(u).host !== host; } catch { return false; } });
  if (!urls.length) return text;
  // довжину міряємо ДО створення кодів: посилання, яке в текст не піде, не має висіти в статистиці
  const shortLen = shortUrl(newCode()).length;
  const lenWith = (set: string[]) => replaceUrls(text, new Map(set.map((u) => [u, "x".repeat(shortLen)]))).length;
  const fits = (set: string[]) => { const n = lenWith(set); return !max || n <= max || n <= text.length; };
  let pick = urls;
  if (!fits(pick)) pick = urls.filter((u) => shortLen <= u.length);
  if (!pick.length || !fits(pick)) return text;
  const map = new Map<string, string>();
  for (const u of pick) {
    const code = await shortFor(ws, u, { postId, network: net, kind: "post",
      utm: s.utm ? { utm_source: net, utm_medium: "social", utm_campaign: "holos", utm_content: postId.slice(0, 8) } : null });
    if (code) map.set(u, shortUrl(code));
  }
  return replaceUrls(text, map);
}
/** Те саме, але без права зламати публікацію: збій - текст як був. */
export async function linkifySafe(ws: string, postId: string, net: string, text: string, max?: number): Promise<string> {
  try { return await linkify(ws, postId, net, text, max ?? LINK_HARD_MAX[net]); } catch { return text; }
}

// ---------- перехід ----------
export async function resolveShort(code: string): Promise<string | null> {
  if (!isCode(code)) return null;
  const r = await one<{ url: string }>(`select url from short_link where code=$1`, [code]);
  return r?.url || null;
}
export async function countClick(code: string): Promise<void> {
  await q(`update short_link set clicks=clicks+1, last_click_at=now() where code=$1`, [code]);
  await q(`insert into short_link_day(code, day, clicks) values($1, (now() at time zone 'UTC')::date, 1)
           on conflict (code, day) do update set clicks=short_link_day.clicks+1`, [code]);
}

// ---------- сторінка в біо ----------
export type BioItem = { id: string; title: string; url: string; emoji: string };
export type Bio = { enabled: boolean; slug: string | null; title: string; bio: string; links: BioItem[]; showPosts: boolean; views: number; url: string | null };
const bioUrl = (slug: string | null) => slug ? `${env.appBaseUrl}/@${slug}` : null;
export async function bioOf(ws: string): Promise<Bio> {
  const r = await one<{ enabled: boolean; slug: string | null; title: string | null; bio: string | null; links: any; show_posts: boolean; views: number }>(
    `select enabled, slug, title, bio, links, show_posts, views from bio_page where workspace_id=$1`, [ws]);
  if (!r) {
    const w = await one<{ title: string | null }>(`select title from workspace where id=$1`, [ws]);
    return { enabled: false, slug: null, title: String(w?.title || "").includes("@") ? "" : String(w?.title || ""), bio: "", links: [], showPosts: true, views: 0, url: null };
  }
  return { enabled: r.enabled, slug: r.slug, title: r.title || "", bio: r.bio || "", links: Array.isArray(r.links) ? r.links : [], showPosts: r.show_posts, views: r.views, url: bioUrl(r.slug) };
}
export async function saveBio(ws: string, b: Partial<{ enabled: boolean; on: boolean; slug: string; title: string; bio: string; links: { title?: string; url?: string; emoji?: string }[]; showPosts: boolean }>): Promise<{ ok: true; bio: Bio } | { ok: false; error: string }> {
  const cur = await bioOf(ws);
  let slug = cur.slug;
  if (b.slug !== undefined) {
    const s = normSlug(b.slug);
    if (!s) return { ok: false, error: "Адреса сторінки: 3-30 латинських літер чи цифр, можна «.», «-» і «_» посередині" };
    slug = s;
  }
  const title = b.title !== undefined ? String(b.title).trim().slice(0, 80) : cur.title;
  const bio = b.bio !== undefined ? String(b.bio).trim().slice(0, 300) : cur.bio;
  let links = cur.links;
  if (b.links !== undefined) {
    if (!Array.isArray(b.links)) return { ok: false, error: "links - це список {title, url}" };
    if (b.links.length > 20) return { ok: false, error: "До 20 посилань на сторінці" };
    links = [];
    for (const [i, l] of b.links.entries()) {
      const t = String(l?.title || "").trim().slice(0, 80);
      const u = safeTarget(String(l?.url || ""));
      if (!t && !String(l?.url || "").trim()) continue;                 // порожній рядок форми
      if (!u) return { ok: false, error: `Посилання «${t || i + 1}»: потрібна повна адреса з https://` };
      links.push({ id: (l as any)?.id && /^[a-z0-9]{4,12}$/i.test((l as any).id) ? (l as any).id : newCode(6), title: t || new URL(u).hostname, url: u, emoji: String(l?.emoji || "").trim().slice(0, 4) });
    }
  }
  const on = typeof b.enabled === "boolean" ? b.enabled : typeof b.on === "boolean" ? b.on : cur.enabled;
  if (on && !slug) return { ok: false, error: "Спершу обери адресу сторінки (holos.rozum.one/@…)" };
  if (on && !title) return { ok: false, error: "Назва на сторінці не може бути порожньою" };
  const showPosts = typeof b.showPosts === "boolean" ? b.showPosts : cur.showPosts;
  try {
    await q(`insert into bio_page(workspace_id, enabled, slug, title, bio, links, show_posts) values($1,$2,$3,$4,$5,$6::jsonb,$7)
             on conflict (workspace_id) do update set enabled=excluded.enabled, slug=excluded.slug, title=excluded.title, bio=excluded.bio,
               links=excluded.links, show_posts=excluded.show_posts, updated_at=now()`, [ws, on, slug, title, bio, JSON.stringify(links), showPosts]);
  } catch (e: any) {
    if (e?.code === "23505") return { ok: false, error: `Адреса @${slug} уже зайнята - обери іншу` };
    throw e;
  }
  return { ok: true, bio: await bioOf(ws) };
}

const BIO_UTM = { utm_source: "bio", utm_medium: "social", utm_campaign: "holos" };
/** HTML сторінки за адресою (null - нема такої чи вимкнена). count - рахувати перегляд (людина, не бот). */
export async function renderBio(slugRaw: string, count: boolean): Promise<string | null> {
  const slug = normSlug(slugRaw);
  if (!slug) return null;
  const r = await one<{ workspace_id: string; title: string; bio: string | null; links: any; show_posts: boolean }>(
    `select workspace_id, title, bio, links, show_posts from bio_page where slug=$1 and enabled`, [slug]);
  if (!r) return null;
  const ws = r.workspace_id;
  const links: BioLink[] = [];
  for (const l of (Array.isArray(r.links) ? r.links : []) as BioItem[]) {
    const code = await shortFor(ws, l.url, { kind: "bio", network: "bio", title: l.title, utm: BIO_UTM });
    if (code) links.push({ title: l.title, emoji: l.emoji, href: `/s/${code}` });
  }
  const tiles: BioTile[] = [];
  let ogImage: string | null = null;
  if (r.show_posts) {
    // останні опубліковані пости (без повторів і сторіс): плитка веде на посилання з поста, а якщо
    // його нема - на сам пост у мережі
    const posts = await q<{ id: string; content: string; first_comment: string | null; filename: string | null; permalink: string | null }>(
      `with mine as (select p.id from post p join pipeline_run pr on pr.id=p.run_id join source s on s.id=pr.source_id
                      where s.workspace_id=$1 and p.repeat_of is null and coalesce(p.format,'post')<>'story'),
       sent as (
         select post_id, permalink, created_at from threads_publish where status='sent' and post_id in (select id from mine)
         union all select post_id, permalink, created_at from meta_publish where status='sent' and post_id in (select id from mine)
         union all select post_id, permalink, created_at from telegram_publish where status='sent' and post_id in (select id from mine)
         union all select post_id, permalink, created_at from linkedin_publish where status='sent' and post_id in (select id from mine)),
       per as (select post_id, min(created_at) as first_at, (array_agg(permalink order by created_at) filter (where permalink is not null))[1] as permalink from sent group by post_id)
       select p.id, p.content, p.first_comment, ma.filename, per.permalink
         from per join post p on p.id=per.post_id
         left join media_asset ma on ma.id=p.media_id and ma.kind='image'
        order by per.first_at desc limit 12`, [ws]);
    for (const p of posts) {
      if (tiles.length >= 9) break;
      const target = findUrls(p.content)[0] || findUrls(p.first_comment || "")[0] || p.permalink;
      if (!target) continue;
      const code = await shortFor(ws, target, { kind: "bio", network: "bio", postId: p.id, title: p.content.split("\n")[0], utm: BIO_UTM });
      if (!code) continue;
      const title = p.content.split("\n").map((x) => x.trim()).find(Boolean)?.slice(0, 90) || "Пост";
      tiles.push({ title, href: `/s/${code}`, img: p.filename ? `/thumb/${p.filename}` : null });
      if (!ogImage && p.filename) ogImage = `${env.appBaseUrl}/media/${p.filename}`;
    }
  }
  if (count) {
    await q(`update bio_page set views=views+1 where workspace_id=$1`, [ws]);
    await q(`insert into bio_page_day(workspace_id, day, views) values($1, (now() at time zone 'UTC')::date, 1)
             on conflict (workspace_id, day) do update set views=bio_page_day.views+1`, [ws]);
  }
  return bioHtml({ title: r.title, bio: r.bio || "", links, tiles, base: env.appBaseUrl, slug, ogImage, noindex: !!env.beta.pin });
}

// ---------- статистика для кабінету й конектора ----------
export type LinkRow = { code: string; short: string; url: string; source: string; title: string | null; network: string | null; kind: string; postId: string | null; postTitle: string | null; clicks: number; total: number };
export async function linkStats(ws: string, days = 30): Promise<{ days: number; total: number; byNet: Record<string, number>; top: LinkRow[]; bioViews: number }> {
  const d = Math.max(1, Math.min(365, Math.round(days) || 30));
  const rows = await q<{ code: string; url: string; source_url: string; title: string | null; network: string | null; kind: string; post_id: string | null; content: string | null; total: number; period: number }>(
    `select sl.code, sl.url, sl.source_url, sl.title, sl.network, sl.kind, sl.post_id, p.content, sl.clicks as total,
            coalesce((select sum(x.clicks) from short_link_day x where x.code=sl.code and x.day > (now() at time zone 'UTC')::date - $2::int), 0)::int as period
       from short_link sl left join post p on p.id=sl.post_id
      where sl.workspace_id=$1
      order by period desc, sl.clicks desc, sl.created_at desc limit 50`, [ws, d]);
  const byNet: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { total += r.period; if (r.period) byNet[r.network || "інше"] = (byNet[r.network || "інше"] || 0) + r.period; }
  const bv = await one<{ n: number }>(`select coalesce(sum(views),0)::int n from bio_page_day where workspace_id=$1 and day > (now() at time zone 'UTC')::date - $2::int`, [ws, d]);
  return {
    days: d, total, byNet, bioViews: bv?.n || 0,
    top: rows.map((r) => ({ code: r.code, short: shortUrl(r.code), url: r.url, source: r.source_url, title: r.title, network: r.network, kind: r.kind,
      postId: r.post_id, postTitle: r.content ? r.content.split("\n").map((x) => x.trim()).find(Boolean)?.slice(0, 90) || null : null, clicks: r.period, total: r.total })),
  };
}
