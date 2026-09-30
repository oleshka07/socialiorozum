// 💬 Коментарі в одному місці (п.8 дорожньої карти, 28.09). Свіжі коментарі ЛЮДЕЙ під постами бренду в
// Instagram, Facebook і Threads - з усіх акаунтів бренду (особистий і компанії) - у списку, де на кожен
// можна відповісти (з AI-чернеткою, з кабінету чи конектором Claude) або пропустити.
//
// Головні рішення:
//  • Instagram і Facebook читаються з самої мережі (останні дописи акаунта), а не лише з того, що
//    вийшло через Holos: людина відповідає на коментарі під усіма своїми постами в одному місці.
//    Threads - за нашими публікаціями (API Threads не віддає стрічку акаунта з коментарями так дешево).
//  • Відповідає той акаунт, під чиїм постом коментар: інший акаунт бренду чужого поста не бачить.
//  • Свої коментарі (будь-якого акаунта бренду) і ті, під якими бренд уже відповів у самій мережі, не
//    показуються; відповідь і «пропустити» з Holos памʼятаються в comment_reply.
//  • Дозвіл, якого нема (Meta його не дала), - не помилка всього списку: мережа пропускається, а
//    відповідь каже, яку кнопку натиснути. Мережу навіть не смикаємо, якщо з granted видно, що дозволу нема.
//  • Коротка памʼять (3 хв) на кабінет: лічильник на «Сьогодні» і відкриття списку не множать запити до
//    мереж (Instagram рахує ліміт на акаунт).
import { q, one } from "./db.js";
import * as meta from "./meta.js";
import * as threads from "./threads.js";
import { metaPages, threadsAccounts, threadsAccountForRow, metaAccountFor, threadsAccountFor, type MetaPage } from "./accounts.js";
import { suggestCommentReplies } from "./pipeline.js";

export type InboxNet = "instagram" | "facebook" | "threads";
export const INBOX_NETS: InboxNet[] = ["instagram", "facebook", "threads"];
export const isInboxNet = (n: string): n is InboxNet => (INBOX_NETS as string[]).includes(n);
export type InboxItem = {
  net: InboxNet; account: string; accountName: string; commentId: string; username: string; comment: string;
  postTitle: string; postText: string; permalink: string | null; timestamp: string;
};
// чого бракує, щоб мережа потрапила в список (кнопка в Каналах): read - читати, reply - відповідати
export type InboxNeed = { net: InboxNet; perm: "comments" | "inbox" | "threads"; text: string };
// accounts - скільки акаунтів мережі в бренді: назву акаунта біля коментаря показуємо, коли їх кілька
export type Inbox = { items: InboxItem[]; needs: InboxNeed[]; errors: string[]; connected: InboxNet[]; accounts: Partial<Record<InboxNet, number>> };

export const WINDOW_DAYS = 14;   // коментарі під дописами останніх двох тижнів
const POSTS_PER_ACCOUNT = 12;
const MAX_ITEMS = 60;
const CACHE_MS = 3 * 60 * 1000;
const cache = new Map<string, { at: number; inbox: Inbox }>();

const NET_UA: Record<InboxNet, string> = { instagram: "Instagram", facebook: "Facebook", threads: "Threads" };
const firstLine = (t: string) => String(t || "").split("\n").map((x) => x.trim()).find(Boolean)?.slice(0, 70) || "";
const fresh = (ts: string, now = Date.now()) => { const t = Date.parse(ts); return !Number.isFinite(t) || now - t <= WINDOW_DAYS * 864e5; };
const noPerm = (m: string) => /дозволу|permission|\(#10\)|\(#200\)/i.test(m);

/** Коментарі, на які вже відповіли чи які пропустили: «мережа:id». */
async function doneSet(ws: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of await q<{ network: string; comment_id: string }>(`select network, comment_id from comment_reply where workspace_id=$1`, [ws]))
    out.add(`${r.network}:${r.comment_id}`);
  // давній список реплай-коуча Threads
  const legacy = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='th_replied'`, [ws]);
  try { for (const id of JSON.parse(legacy?.content || "[]") || []) out.add(`threads:${id}`); } catch { /* зіпсований - ігноруємо */ }
  return out;
}

/** Чисте правило: чи показувати коментар (не свій, не оброблений, бренд ще не відповів під ним у мережі). */
export function keepComment(c: { net: InboxNet; id: string; author: string; replyAuthors: string[] }, own: Set<string>, done: Set<string>): boolean {
  const norm = (x: string) => String(x || "").trim().replace(/^@/, "").toLowerCase();
  if (!c.id) return false;
  if (own.has(norm(c.author))) return false;                 // свій коментар (будь-який акаунт бренду)
  if (done.has(`${c.net}:${c.id}`)) return false;           // відповіли чи пропустили з Holos
  if (c.replyAuthors.some((a) => own.has(norm(a)))) return false; // бренд уже відповів у самій мережі
  return true;
}

function metaNeed(granted: string | null, perm: string): boolean {
  return granted != null && !granted.split(",").includes(perm);
}

async function collectInstagram(ws: string, pages: MetaPage[], granted: string | null, done: Set<string>, out: Inbox): Promise<void> {
  const igPages = pages.filter((p) => p.igUserId);
  if (!igPages.length) return;
  out.connected.push("instagram");
  out.accounts.instagram = igPages.length;
  if (metaNeed(granted, "instagram_manage_comments")) {
    out.needs.push({ net: "instagram", perm: "comments", text: "Instagram: дай дозвіл на коментарі - Налаштування → Канали → Facebook + Instagram → «💬 Дозволити коментарі»" });
    return;
  }
  const own = new Set(igPages.map((p) => String(p.igUsername || "").toLowerCase()).filter(Boolean));
  for (const p of igPages) {
    try {
      const media = (await meta.igRecentMedia(p.igUserId!, p.pageToken, POSTS_PER_ACCOUNT)).filter((m) => m.comments > 0 && fresh(m.timestamp));
      for (const m of media) {
        for (const c of await meta.igComments(m.id, p.pageToken)) {
          if (!keepComment({ net: "instagram", id: c.id, author: c.username, replyAuthors: c.replyUsers }, own, done)) continue;
          out.items.push({ net: "instagram", account: p.igUserId!, accountName: p.igUsername ? "@" + p.igUsername : p.igUserId!, commentId: c.id, username: c.username,
            comment: c.text, postTitle: firstLine(m.caption), postText: m.caption, permalink: m.permalink, timestamp: c.timestamp });
        }
      }
    } catch (e: any) {
      const m = String(e?.message || e);
      if (noPerm(m)) { if (!out.needs.some((n) => n.net === "instagram")) out.needs.push({ net: "instagram", perm: "comments", text: "Instagram: Meta не дає читати коментарі - «💬 Дозволити коментарі» в Налаштування → Канали → Facebook + Instagram" }); }
      else out.errors.push(`Instagram @${p.igUsername || p.igUserId}: ${m.slice(0, 160)}`);
    }
  }
}

async function collectFacebook(ws: string, pages: MetaPage[], granted: string | null, done: Set<string>, out: Inbox): Promise<void> {
  if (!pages.length) return;
  out.connected.push("facebook");
  out.accounts.facebook = pages.length;
  // читати коментарі людей під дописами Сторінки - окремий дозвіл Meta
  if (metaNeed(granted, "pages_read_user_content")) {
    out.needs.push({ net: "facebook", perm: "inbox", text: "Facebook: щоб бачити коментарі під дописами Сторінки, дай дозвіл - Налаштування → Канали → Facebook + Instagram → «📥 Дозволити читати коментарі»" });
    return;
  }
  const pageIds = new Set(pages.map((p) => p.pageId));
  for (const p of pages) {
    try {
      const posts = (await meta.pageRecentPosts(p.pageId, p.pageToken, POSTS_PER_ACCOUNT)).filter((x) => x.comments > 0 && fresh(x.timestamp));
      for (const post of posts) {
        for (const c of await meta.fbComments(post.id, p.pageToken)) {
          // свій = від будь-якої Сторінки бренду; «бренд уже відповів» = серед відповідей є Сторінка бренду
          if (!keepComment({ net: "facebook", id: c.id, author: c.fromId || "", replyAuthors: c.replyFromIds }, pageIds, done)) continue;
          out.items.push({ net: "facebook", account: p.pageId, accountName: p.pageName, commentId: c.id, username: c.fromName,
            comment: c.text, postTitle: firstLine(post.message), postText: post.message, permalink: c.permalink || post.permalink, timestamp: c.timestamp });
        }
      }
    } catch (e: any) {
      const m = String(e?.message || e);
      if (noPerm(m)) { if (!out.needs.some((n) => n.net === "facebook")) out.needs.push({ net: "facebook", perm: "inbox", text: "Facebook: Meta не дає читати коментарі під дописами Сторінки - «📥 Дозволити читати коментарі» в Налаштування → Канали → Facebook + Instagram" }); }
      else out.errors.push(`Facebook «${p.pageName}»: ${m.slice(0, 160)}`);
    }
  }
}

async function collectThreads(ws: string, done: Set<string>, out: Inbox): Promise<void> {
  const accs = await threadsAccounts(ws);
  if (!accs.length) return;
  out.connected.push("threads");
  out.accounts.threads = accs.length;
  // власні відповіді - будь-якого акаунта бренду (особистий відповідає під постом компанії - теж «свій»)
  const own = new Set(accs.map((a) => a.username.toLowerCase()).filter(Boolean));
  const posts = await q<{ media_id: string; content: string; account_id: string | null; account_name: string | null; permalink: string | null }>(
    `select tp.media_id, p.content, tp.account_id, tp.account_name, tp.permalink from threads_publish tp join post p on p.id=tp.post_id
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and tp.status='sent' and tp.media_id is not null
       and tp.created_at > now() - make_interval(days => $2::int) order by tp.created_at desc limit $3`, [ws, WINDOW_DAYS, POSTS_PER_ACCOUNT * Math.max(1, accs.length)]);
  // акаунти, чий токен ще без дозволу читати відповіді (увійшли до 01.10, коли його почали просити):
  // їхні пости не смикаємо вдруге, а людині - хто саме має увійти ще раз
  const lacking = new Map<string, string>();
  for (const p of posts) {
    let who = "";
    try {
      // коментарі під постом бачить (і відповідає на них) лише акаунт, яким пост опубліковано
      const acc = await threadsAccountForRow(ws, p);
      if (!acc.ok) { if (!out.errors.includes(acc.error)) out.errors.push(acc.error); continue; }
      who = acc.acc.userId;
      if (lacking.has(who)) continue;
      for (const r of await threads.mediaReplies(acc.acc.token, p.media_id)) {
        if (!keepComment({ net: "threads", id: r.id, author: r.username, replyAuthors: [] }, own, done)) continue;
        out.items.push({ net: "threads", account: acc.acc.userId, accountName: acc.acc.username ? "@" + acc.acc.username : acc.acc.userId, commentId: r.id, username: r.username,
          comment: r.text, postTitle: firstLine(p.content), postText: p.content || "", permalink: p.permalink, timestamp: r.timestamp });
      }
    } catch (e: any) {
      const m = String(e?.message || e);
      if (noPerm(m) && who) lacking.set(who, accs.find((a) => a.userId === who)?.username || "");
      else if (!out.errors.some((x) => x.startsWith("Threads"))) out.errors.push(`Threads: ${m.slice(0, 160)}`);
    }
  }
  if (lacking.size) out.needs.push({ net: "threads", perm: "threads", text: threadsNeedText([...lacking.values()], accs.length) });
}

/** Хто з акаунтів Threads має увійти ще раз, щоб у токені зʼявився дозвіл читати відповіді. */
export function threadsNeedText(names: string[], total: number): string {
  const list = names.map((n) => (n ? "@" + n : "акаунт без ніка")).join(" і ");
  const how = total > 1
    ? " Основний - «Підключити», інший - «＋ Додати акаунт», щоразу увійшовши в Threads саме ним: доступ лише оновиться, пости й налаштування лишаються."
    : " Доступ лише оновиться, пости й налаштування лишаються.";
  return `Threads: щоб читати й відповідати на коментарі, увійди ще раз ${list} - Налаштування → Канали → Threads. Дозвіл на читання відповідей діє лише після повторного входу.${how}`;
}

/** Свіжі коментарі людей без відповіді, новіші першими. nets - лише ці мережі; fresh - не брати з памʼяті. */
export async function collectInbox(ws: string, opts: { nets?: InboxNet[]; fresh?: boolean } = {}): Promise<Inbox> {
  const nets = opts.nets && opts.nets.length ? opts.nets : INBOX_NETS;
  const key = `${ws}|${[...nets].sort().join(",")}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.inbox;
  const out: Inbox = { items: [], needs: [], errors: [], connected: [], accounts: {} };
  const done = await doneSet(ws);
  const [pages, cfg] = await Promise.all([
    nets.some((n) => n !== "threads") ? metaPages(ws) : Promise.resolve([] as MetaPage[]),
    one<{ granted: string | null }>(`select granted from meta_config where workspace_id=$1`, [ws]),
  ]);
  const granted = cfg?.granted ?? null;
  await Promise.all([
    nets.includes("instagram") ? collectInstagram(ws, pages, granted, done, out) : null,
    nets.includes("facebook") ? collectFacebook(ws, pages, granted, done, out) : null,
    nets.includes("threads") ? collectThreads(ws, done, out) : null,
  ]);
  out.items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  out.items = out.items.slice(0, MAX_ITEMS);
  out.connected = INBOX_NETS.filter((n) => out.connected.includes(n));
  cache.set(key, { at: Date.now(), inbox: out });
  return out;
}

function forget(ws: string, net: string, commentId: string): void {
  for (const [k, v] of cache) if (k.startsWith(ws + "|")) v.inbox.items = v.inbox.items.filter((x) => !(x.net === net && x.commentId === commentId));
}

async function remember(ws: string, net: InboxNet, commentId: string, account: string, action: "replied" | "skipped", replyId: string | null, text: string | null): Promise<void> {
  await q(`insert into comment_reply(workspace_id, network, comment_id, account, action, reply_id, reply_text) values($1,$2,$3,$4,$5,$6,$7)
           on conflict (workspace_id, network, comment_id) do update set account=excluded.account, action=excluded.action,
             reply_id=coalesce(excluded.reply_id, comment_reply.reply_id), reply_text=coalesce(excluded.reply_text, comment_reply.reply_text), created_at=now()`,
    [ws, net, commentId, account, action, replyId, text]);
  forget(ws, net, commentId);
}

// AI-чернетки памʼятаються на 6 год: повторне відкриття вікна (і ↻) не платить моделі за ті самі коментарі
// ще раз - модель пише лише для нових. По 15 коментарів на виклик, виклики паралельно.
const DRAFT_TTL = 6 * 3600 * 1000;
const drafts = new Map<string, { at: number; text: string }>();
export async function inboxDrafts(ws: string, items: Pick<InboxItem, "net" | "commentId" | "postText" | "comment" | "username">[]): Promise<Record<string, string>> {
  const now = Date.now(), out: Record<string, string> = {};
  const key = (net: string, id: string) => `${ws}|${net}|${id}`;
  const need = items.filter((it) => { const c = drafts.get(key(it.net, it.commentId)); if (c && now - c.at < DRAFT_TTL) { out[it.commentId] = c.text; return false; } return true; });
  const chunks: (typeof need)[] = [];
  for (let i = 0; i < need.length; i += 15) chunks.push(need.slice(i, i + 15));
  const got = await Promise.all(chunks.map((ch) => suggestCommentReplies(ws, ch.map((it) => ({ commentId: it.commentId, net: it.net, postText: it.postText, comment: it.comment, username: it.username })))
    .catch(() => ({} as Record<string, string>))));    // без чернеток теж корисно - людина напише сама
  const netOf = new Map(need.map((it) => [it.commentId, it.net]));
  for (const r of got) for (const [id, text] of Object.entries(r)) { out[id] = text; drafts.set(key(netOf.get(id) || "", id), { at: now, text }); }
  if (drafts.size > 5000) for (const [k, v] of drafts) if (now - v.at > DRAFT_TTL) drafts.delete(k);
  return out;
}

export const REPLY_MAX: Record<InboxNet, number> = { threads: 500, instagram: 2200, facebook: 8000 };

/** Відповісти на коментар від імені акаунта, під чиїм постом він стоїть (account - з collectInbox; нема - основний). */
export async function replyToComment(ws: string, net: InboxNet, commentId: string, text: string, account?: string | null): Promise<{ id: string; accountName: string }> {
  const t = String(text || "").trim();
  if (!commentId) throw new Error("не вказано коментар");
  if (!t) throw new Error("порожня відповідь");
  if (t.length > REPLY_MAX[net]) throw new Error(`${NET_UA[net]}: відповідь довша за ${REPLY_MAX[net]} знаків (зараз ${t.length}) - скороти`);
  // акаунт, під чиїм постом коментар, прибрали з бренду: інший акаунт цього коментаря не бачить
  const gone = (e: string) => new Error(account ? `${NET_UA[net]}: акаунт, під чиїм постом цей коментар, зараз не підключено до бренду - додай його знову (Налаштування → Канали), і відповідь піде від нього` : e);
  let id = "", name = "", acc = "";
  if (net === "threads") {
    const a = await threadsAccountFor(ws, account || null);
    if (!a.ok) throw gone(a.error);
    const r = await threads.publish(a.acc.token, a.acc.userId, t, undefined, commentId);
    id = r.mediaId; name = a.acc.username ? "@" + a.acc.username : a.acc.userId; acc = a.acc.userId;
  } else {
    const cfg = await one<{ granted: string | null }>(`select granted from meta_config where workspace_id=$1`, [ws]);
    const perm = net === "instagram" ? "instagram_manage_comments" : "pages_manage_engagement";
    if (metaNeed(cfg?.granted ?? null, perm))
      throw new Error(`${NET_UA[net]}: Meta ще не дала дозволу відповідати на коментарі - Налаштування → Канали → Facebook + Instagram → «💬 Дозволити коментарі»`);
    const a = await metaAccountFor(ws, net, account || null);
    if (!a.ok) throw gone(a.error);
    const r = net === "instagram" ? await meta.igReply(commentId, a.acc.pageToken, t) : await meta.commentOn(commentId, a.acc.pageToken, t);
    id = r.id; acc = net === "instagram" ? a.acc.igUserId || "" : a.acc.pageId;
    name = net === "instagram" ? (a.acc.igUsername ? "@" + a.acc.igUsername : acc) : a.acc.pageName;
  }
  await remember(ws, net, commentId, acc, "replied", id || null, t);
  return { id, accountName: name };
}

/** «Пропустити»: коментар більше не показується (відповідати не треба - спам, «дякую», уже відповіли деінде). */
export async function skipComment(ws: string, net: InboxNet, commentId: string): Promise<void> {
  if (!commentId) throw new Error("не вказано коментар");
  await remember(ws, net, commentId, "", "skipped", null, null);
}
