// 💬 Перший коментар (п.4 дорожньої карти): одразу після того, як пост вийшов у мережу, під ним
// зʼявляється коментар від імені автора. Так роблять, коли в самому тексті щось заважає: у LinkedIn і
// Facebook посилання в пості ріже охоплення (у коментарі - ні), в Instagram хештеги захаращують підпис,
// у Threads заклик окремою відповіддю не рве думку.
//
// Головні рішення:
//  • Коментар ніколи не валить публікацію: пост уже в мережі, тож збій коментаря - окремий стан поруч
//    (видно в композері й конекторі), а не «помилка публікації».
//  • Один коментар на пост і мережу - unique у таблиці. Повтор публікації, автопостер і кнопка
//    «надіслати ще раз» не можуть дати два коментарі.
//  • Тимчасові збої (ліміт, таймаут, мережа ще «не бачить» пост) повторюємо до 3 разів через 10/20 хв.
//    Відмова в дозволі - постійна: повтор не допоможе, поки людина не дасть дозвіл, тож кажемо, що
//    саме натиснути.
//  • Telegram - без коментарів: коментарі каналу живуть в окремій групі обговорення, і бот туди не
//    пише. Сторіс коментарів не мають.
import { q, one } from "./db.js";
import * as meta from "./meta.js";
import * as threads from "./threads.js";
import * as linkedin from "./linkedin.js";
import { logEvent } from "./log.js";
import { thValidToken } from "./publisher.js";

export const COMMENT_NETS = ["instagram", "facebook", "linkedin", "threads"];
// межа довжини коментаря в мережі (знаків): відповідь у Threads - це такий самий пост на 500
export const COMMENT_MAX: Record<string, number> = { instagram: 2200, facebook: 8000, linkedin: linkedin.LI_COMMENT_MAX, threads: 500 };
// дозвіл Meta, без якого коментар не піде (у Threads і LinkedIn вистачає того, що вже є)
export const COMMENT_PERM: Record<string, string> = { instagram: "instagram_manage_comments", facebook: "pages_manage_engagement" };
const NET_UA: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", threads: "Threads", telegram: "Telegram" };
const MAX_ATTEMPTS = 3;

/** Текст першого коментаря для мережі: свій у channels.<мережа>.first_comment (порожній = без
 *  коментаря в цій мережі) або спільний post.first_comment. Порожній рядок - коментаря нема. */
export function commentFor(post: { first_comment?: string | null; channels?: any; format?: string | null }, net: string): string {
  if (!COMMENT_NETS.includes(net) || post.format === "story") return "";
  const own = post.channels && typeof post.channels === "object" ? post.channels[net]?.first_comment : undefined;
  return String(typeof own === "string" ? own : post.first_comment || "").trim();
}

export type CommentState = { network: string; status: "pending" | "sending" | "sent" | "failed"; error?: string | null; attempts?: number; due_at?: string | null };

class CommentFail extends Error { constructor(msg: string, public permanent: boolean) { super(msg); } }

// Тимчасове = є сенс повторити. Загальна відмова Meta (коди 1/2: «An unexpected error has occurred.
// Please retry your request later») і ліміт LinkedIn (429, «throttle») - теж тимчасові: без них такий
// збій вважався б остаточним, і коментар не дослався б, хоча за 10 хв пройшов би сам.
const TRANSIENT = /timeout|timed out|зачекати|temporar|try again|retry|rate limit|request limit|throttl|too many|HTTP 429|HTTP 5\d\d|fetch failed|ECONN|ENOTFOUND|socket hang|not available|unexpected error|unknown error|тимчасово/i;

/** Людська причина збою і чи є сенс повторювати. Відмова в дозволі й протухлий доступ - постійні. */
export function humanCommentError(net: string, msg: string): { text: string; permanent: boolean } {
  const m = String(msg || "невідома помилка");
  const name = NET_UA[net] || net;
  if ((net === "instagram" || net === "facebook") && /дозволу|permission/i.test(m))
    return { permanent: true, text: `${name} не дав застосунку дозволу на коментарі. Налаштування → Канали → Facebook + Instagram → «💬 Дозволити коментарі», потім у пості «↻ Надіслати коментар».` };
  if (/втрачено|протух|expired|invalid.?token|401/i.test(m))
    return { permanent: true, text: `${name}: доступ втрачено - перепідключи мережу в Налаштування → Канали, потім у пості «↻ Надіслати коментар».` };
  if (net === "linkedin" && /403|ACCESS_DENIED|not enough permissions|permission/i.test(m))
    return { permanent: true, text: "LinkedIn не дав застосунку дозволу коментувати від імені профілю. Коментар можна додати руками під постом." };
  if (/не підключено/i.test(m)) return { permanent: true, text: m };
  // ліміт, таймаут, 5xx, мережа ще «не бачить» пост - повторимо; решта (пост видалено, кривий
  // параметр) повтором не лікується, тож кажемо одразу, а людина повторить сама кнопкою
  return { permanent: !TRANSIENT.test(m), text: m.slice(0, 300) };
}

// Одразу після публікації мережа інколи кілька секунд ще «не бачить» пост (гілка Threads з тієї ж
// причини робить паузу між частинами). Такий збій - не привід чекати 10 хв до повтору воркера:
// пробуємо ще двічі через 3 і 6 с (як meta.commentOn), решту помилок віддаємо одразу.
const FRESH = /does not exist|not available|not found|HTTP 404|try again|temporar/i;
async function whenVisible<T>(fn: () => Promise<T>): Promise<T> {
  let last: any = null;
  for (let att = 0; att < 3; att++) {
    try { return await fn(); }
    catch (e: any) { last = e; if (att === 2 || !FRESH.test(String(e?.message || e))) throw e; await new Promise((r) => setTimeout(r, 3000 * (att + 1))); }
  }
  throw last;
}

// Одна спроба надіслати коментар у мережу. Вертає id коментаря в мережі.
async function deliver(ws: string, net: string, target: string, text: string): Promise<string> {
  const max = COMMENT_MAX[net] || 2000;
  if (text.length > max) throw new CommentFail(`${NET_UA[net]}: коментар довший за ${max} знаків (зараз ${text.length}) - скороти.`, true);
  if (net === "instagram" || net === "facebook") {
    const mt = await one<{ page_token: string | null; granted: string | null }>(`select page_token, granted from meta_config where workspace_id=$1`, [ws]);
    if (!mt?.page_token) throw new CommentFail(`${NET_UA[net]} не підключено - коментар нікуди надіслати.`, true);
    // якщо відомо, що дозволу нема, не смикаємо Meta даремно: відповідь буде та сама відмова
    if (mt.granted != null && !mt.granted.split(",").includes(COMMENT_PERM[net]))
      throw new CommentFail(humanCommentError(net, "permission").text, true);
    return (await meta.commentOn(target, mt.page_token, text)).id;
  }
  if (net === "linkedin") {
    const li = await one<{ access_token: string | null; member_urn: string | null; token_expires_at: string | null }>(
      `select access_token, member_urn, token_expires_at from linkedin_config where workspace_id=$1`, [ws]);
    if (!li?.access_token || !li.member_urn) throw new CommentFail("LinkedIn не підключено - коментар нікуди надіслати.", true);
    if (li.token_expires_at && new Date(li.token_expires_at).getTime() < Date.now()) throw new CommentFail("LinkedIn: токен протух", true);
    return (await whenVisible(() => linkedin.comment(li.access_token!, li.member_urn!, target, text))).id;
  }
  if (net === "threads") {
    const tok = await thValidToken(ws);
    if (!tok) throw new CommentFail("Threads не підключено - коментар нікуди надіслати.", true);
    // коментар у Threads - це відповідь автора під його ж постом
    return (await whenVisible(() => threads.publish(tok.token, tok.userId, text, undefined, target))).mediaId;
  }
  throw new CommentFail(`${NET_UA[net] || net}: коментарі через API не підтримуються`, true);
}

/** Надіслати один коментар із черги. Забирає рядок атомарно (pending або «зависле» sending, яке
 *  обірвав перезапуск), тож два процеси чи два натискання не надішлють його двічі. */
export async function sendComment(id: string): Promise<CommentState | null> {
  const row = await one<{ id: string; post_id: string; network: string; target_id: string; message: string; attempts: number; ws: string }>(
    `update post_comment pc set status='sending', attempts=pc.attempts+1, updated_at=now()
       from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where pc.id=$1 and p.id=pc.post_id
        and (pc.status='pending' or (pc.status='sending' and pc.updated_at < now() - interval '10 minutes'))
      returning pc.id, pc.post_id, pc.network, pc.target_id, pc.message, pc.attempts, s.workspace_id as ws`, [id]);
  if (!row) return null;
  try {
    const extId = await deliver(row.ws, row.network, row.target_id, row.message);
    await q(`update post_comment set status='sent', external_id=nullif($2,''), error=null, updated_at=now() where id=$1`, [id, extId || ""]);
    return { network: row.network, status: "sent", attempts: row.attempts };
  } catch (e: any) {
    const h = e instanceof CommentFail ? { text: e.message, permanent: e.permanent } : humanCommentError(row.network, String(e?.message || e));
    const retry = !h.permanent && row.attempts < MAX_ATTEMPTS;
    const due = retry ? new Date(Date.now() + 10 * 60e3 * row.attempts).toISOString() : null;
    await q(`update post_comment set status=$2, error=$3, due_at=coalesce($4::timestamptz, due_at), updated_at=now() where id=$1`,
      [id, retry ? "pending" : "failed", h.text.slice(0, 400), due]);
    await logEvent("warn", "comment", `${NET_UA[row.network] || row.network}: перший коментар не вийшов${retry ? " (повторимо)" : ""}: ${h.text}`, { postId: row.post_id });
    return { network: row.network, status: retry ? "pending" : "failed", error: h.text, attempts: row.attempts, due_at: due };
  }
}

export async function commentState(postId: string, net: string): Promise<CommentState | null> {
  return one<CommentState>(`select network, status, error, attempts, due_at from post_comment where post_id=$1 and network=$2`, [postId, net]);
}
export async function commentStates(postId: string): Promise<CommentState[]> {
  return q<CommentState>(`select network, status, error, attempts, due_at from post_comment where post_id=$1 order by network`, [postId]);
}

/** Після того як пост вийшов у мережу: коментар у чергу й одразу спроба. null - для цієї мережі
 *  коментаря нема (не задано, Telegram, сторіс). */
export async function commentAfterPublish(postId: string, net: string, targetId: string): Promise<CommentState | null> {
  if (!targetId) return null;
  const post = await one<{ first_comment: string | null; channels: any; format: string | null }>(
    `select first_comment, channels, format from post where id=$1`, [postId]);
  if (!post) return null;
  const text = commentFor(post, net);
  if (!text) return null;
  const ins = await one<{ id: string }>(
    `insert into post_comment(post_id, network, target_id, message) values($1,$2,$3,$4)
     on conflict (post_id, network) do nothing returning id`, [postId, net, targetId, text]);
  if (!ins) return commentState(postId, net); // коментар уже є (попередня публікація) - не дублюємо
  return (await sendComment(ins.id)) || commentState(postId, net);
}

/**
 * «↻ Надіслати коментар»: для мереж, куди пост уже вийшов, а коментаря ще нема (його дописали після
 * публікації, не було дозволу, збій). Ставить у чергу з поточним текстом; надсилає processDue.
 */
export async function queueMissingComments(ws: string, postId: string): Promise<{ queued: string[]; sent: string[]; none: string[]; busy: string[] }> {
  const post = await one<{ first_comment: string | null; channels: any; format: string | null }>(
    `select p.first_comment, p.channels, p.format from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  const out = { queued: [] as string[], sent: [] as string[], none: [] as string[], busy: [] as string[] };
  if (!post) return out;
  const targets = await q<{ net: string; target: string }>(
    `select 'threads'::text as net, media_id as target from threads_publish where post_id=$1 and status='sent' and media_id is not null
     union all select channel, external_id from meta_publish where post_id=$1 and status='sent' and external_id is not null and position(',' in external_id)=0
     union all select 'linkedin', external_id from linkedin_publish where post_id=$1 and status='sent' and coalesce(external_id,'')<>''`, [postId]);
  for (const t of targets) {
    if (!COMMENT_NETS.includes(t.net)) continue;
    const text = commentFor(post, t.net);
    if (!text) { out.none.push(t.net); continue; }
    const cur = await commentState(postId, t.net);
    if (cur?.status === "sent") { out.sent.push(t.net); continue; }
    if (cur?.status === "sending") { out.busy.push(t.net); continue; }
    await q(
      `insert into post_comment(post_id, network, target_id, message) values($1,$2,$3,$4)
       on conflict (post_id, network) do update set message=excluded.message, target_id=excluded.target_id,
         status='pending', attempts=0, error=null, due_at=now(), updated_at=now()
       where post_comment.status in ('pending','failed')`, [postId, t.net, t.target, text]);
    out.queued.push(t.net);
  }
  return out;
}

/** Надіслати все, чому настав час (воркер і «надіслати зараз»). postId - лише коментарі цього поста. */
export async function processDue(postId?: string): Promise<CommentState[]> {
  const rows = await q<{ id: string }>(
    `select id from post_comment
      where ((status='pending' and due_at <= now()) or (status='sending' and updated_at < now() - interval '10 minutes'))
        ${postId ? "and post_id=$1" : ""}
      order by due_at limit 20`, postId ? [postId] : []);
  const out: CommentState[] = [];
  for (const r of rows) { const s = await sendComment(r.id); if (s) out.push(s); }
  return out;
}

let running = false;
export function startComments(): void {
  setInterval(async () => {
    if (running) return; running = true;
    try { await processDue(); } catch (e: any) { await logEvent("error", "comment", "tick: " + e.message); }
    finally { running = false; }
  }, 60 * 1000);
  console.log("[comments] воркер перших коментарів запущено");
}
