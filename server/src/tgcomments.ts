// 💬 Коментарі людей у боті (відгук Олега 30.09: «коменти можна зробити щоб вони в бота приходили і
// десь була кнопка з кількістю коментарів без відповіді»).
//
// Джерело правди - те саме вікно «💬 Коменти» (inbox.ts): ті самі коментарі без відповіді, ті самі
// AI-чернетки (6 год памʼяті), відповідь від того акаунта, під чиїм постом коментар. Тут лише доставка:
//  • воркер раз на 20 хв: кожній людині з привʼязаним Telegram - по кожному її бренду нові коментарі
//    одним живим повідомленням (картка найновішого, «1 з N»), без нічних сповіщень (22:00-08:00 за поясом бренду);
//  • перший прохід по бренду - без лавини: наявні коментарі стають «показаними», а людині - один рядок
//    «у бренді N коментарів без відповіді» з кнопкою;
//  • картка: мережа, акаунт, автор, текст, під яким постом, чернетка → «↩ Надіслати чернетку»,
//    «✍ Свій текст», «Пропустити», «Далі ›»; «🔕» вимикає сповіщення бренду (увімкнути - у вікні коментарів);
//  • /comments і кнопка «💬 Коменти» в меню бота - та сама картка на вимогу.
// Кнопки несуть номер рядка comment_notice: id коментаря Facebook не влазить у 64 байти callback_data,
// а рядок заодно каже, КОМУ показали коментар (натиснути може лише ця людина).
import { q, one } from "./db.js";
import { env } from "./env.js";
import * as tg from "./telegram.js";
import { collectInbox, inboxDrafts, replyToComment, skipComment, type Inbox, type InboxItem, type InboxNet } from "./inbox.js";
import { getSettingText, setSetting } from "./settings.js";
import { listWorkspaces, isMember } from "./workspaces.js";
import { can, normRole } from "./roles.js";
import { logEvent } from "./log.js";
import { liveSend, wsBotToken } from "./tgbot.js";

const TICK_MS = Number(process.env.COMMENT_NOTIFY_MS ?? 20 * 60_000);        // 0 - без фону
const FIRST_MS = Number(process.env.COMMENT_NOTIFY_FIRST_MS ?? 90_000);    // перший прохід після старту
const QUIET_FROM = 22, QUIET_TO = 8;              // тихі години за поясом бренду
const NET: Record<InboxNet, string> = { instagram: "📸 Instagram", facebook: "📘 Facebook", threads: "🧵 Threads" };
const CAT = "comments";                           // живе повідомлення бота: нова картка гасить попередню
// живе повідомлення - своє в кожної людини: tg_message тримає одне на (кабінет, категорію), і з однією
// категорією картка Кості перезаписала б запис картки Олега - стара картка Олега вже не прибиралась би
const catFor = (chatId: string) => `${CAT}:${chatId}`;
// бот не зміг написати людині (заблокувала бота, не запускала власного бота бренду, чат зник): пауза для
// пари «людина × бренд», інакше кожні 20 хв - той самий збій у журналі; показане відкочується, щоб ці
// коментарі прийшли після паузи, а не загубились
const BACKOFF_MS = Number(process.env.COMMENT_NOTIFY_BACKOFF_MS ?? 6 * 3600_000);
const backoff = new Map<string, number>();

type Owner = { tg_user_id: string; chat_id: string; user_id: string | null; workspace_id: string };
type Notice = { id: string; workspace_id: string; tg_user_id: string; network: InboxNet; comment_id: string; status: string };
export type Card = { text: string; buttons: tg.TgButton[][]; pending: number };

/** Сповіщення про коментарі бренду ввімкнено? (типово так; вимикає «🔕» у боті чи вікно коментарів) */
export async function notifyOn(ws: string): Promise<boolean> {
  return (await getSettingText(ws, "comment_notify").catch(() => "")) !== "off";
}
export async function setNotify(ws: string, on: boolean): Promise<void> {
  await setSetting(ws, "comment_notify", on ? "on" : "off");
}

/** Чиста функція: чи зараз тихі години (22:00-08:00) у поясі tz. */
export function quietNow(tz: string, now = new Date()): boolean {
  let h: number;
  try { h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Europe/Kyiv", hour: "2-digit", hour12: false }).format(now)) % 24; }
  catch { h = now.getUTCHours(); }
  return h >= QUIET_FROM || h < QUIET_TO;
}

async function brandTitle(ws: string): Promise<string> {
  const r = await one<{ t: string }>(`select coalesce(nullif(btrim(title),''), replace(name,'user:','')) t from workspace where id=$1`, [ws]);
  return r?.t || "бренд";
}
/** Бренди людини, куди бот може їй писати: усі, де вона учасник (стара привʼязка без акаунта - лише свій). */
// 👥 лише бренди, де людина може відповідати людям від імені бренду (редактор і вище): автору чи
// «Перегляду» картка з «↩ Надіслати чернетку» була б кнопкою, яка все одно відмовить
async function brandsFor(o: Owner): Promise<string[]> {
  if (!o.user_id) return [o.workspace_id];          // давня привʼязка без акаунта - власник свого кабінету
  return (await listWorkspaces(o.user_id)).filter((w) => can(normRole(w.role), "publish")).map((w) => w.id);
}
/** Рядки comment_notice для коментарів без відповіді (нові - одразу «показані», якщо не сказано інше). */
async function ensureNotices(ws: string, tgUser: string, items: InboxItem[], status = "shown"): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const it of items) {
    const r = await one<{ id: string }>(
      `insert into comment_notice(workspace_id, tg_user_id, network, comment_id, status) values($1,$2,$3,$4,$5)
       on conflict (workspace_id, tg_user_id, network, comment_id) do update set network=excluded.network returning id`,
      [ws, tgUser, it.net, it.commentId, status]);
    if (r) out.set(`${it.net}:${it.commentId}`, String(r.id));
  }
  return out;
}

/** Картка коментаря для людини tgUser у бренді ws: noticeId - саме цей (якщо ще без відповіді), after - наступний за ним. */
export async function commentCard(ws: string, tgUser: string, opts: { noticeId?: string | null; after?: boolean; header?: string } = {}): Promise<Card> {
  const inbox = await collectInbox(ws);
  const items = inbox.items;
  const brand = await brandTitle(ws);
  if (!items.length) {
    const none = inbox.connected.length ? `✅ У бренді «${brand}» коментарів без відповіді нема.` : `У бренді «${brand}» не підключено Instagram, Facebook чи Threads - коментарів тут не буде.`;
    return { text: (opts.header ? opts.header + "\n\n" : "") + none, buttons: [], pending: 0 };
  }
  const ids = await ensureNotices(ws, tgUser, items);
  let idx = 0;
  if (opts.noticeId) {
    const n = await one<{ network: string; comment_id: string }>(`select network, comment_id from comment_notice where id=$1`, [opts.noticeId]);
    const at = n ? items.findIndex((it) => it.net === n.network && it.commentId === n.comment_id) : -1;
    if (at >= 0) idx = opts.after ? (at + 1) % items.length : at;
  }
  const it = items[idx];
  const id = ids.get(`${it.net}:${it.commentId}`) || "";
  await q(`update comment_notice set status='shown' where id=$1 and status='new'`, [id]);
  const draft = (await inboxDrafts(ws, [it]).catch(() => ({} as Record<string, string>)))[it.commentId] || "";
  const multi = (inbox.accounts[it.net] || 0) > 1;
  const text = [
    ...(opts.header ? [opts.header, ""] : []),
    `💬 **Коментар ${idx + 1} з ${items.length}** · 🏢 ${brand}`,
    `${NET[it.net]}${multi && it.accountName ? " · " + it.accountName : ""}`,
    "",
    `**${it.username || "хтось"}**: ${it.comment.slice(0, 700)}`,
    `під постом «${(it.postTitle || "…").slice(0, 80)}»`,
    "",
    draft ? `✨ Чернетка відповіді:\n${draft}` : "✨ Чернетки нема - напиши свою.",
  ].join("\n");
  const rows: tg.TgButton[][] = [];
  rows.push([...(draft ? [{ text: "↩ Надіслати чернетку", data: `cm:r:${id}` }] : []), { text: "✍ Свій текст", data: `cm:w:${id}` }]);
  rows.push([{ text: "Пропустити", data: `cm:k:${id}` }, ...(items.length > 1 ? [{ text: "Далі ›", data: `cm:n:${id}` }] : [])]);
  rows.push([...(it.permalink ? [{ text: "↗ Пост", url: it.permalink }] : []), { text: "🌐 Усі в кабінеті", url: `${env.appBaseUrl}/app#/comments` }]);
  rows.push([{ text: "🔕 Не надсилати коментарі бренду", data: `cm:off:${ws.slice(0, 8)}` }]);
  return { text, buttons: rows, pending: items.length };
}

// ---------------------------------------------------------------- воркер
/** Один бренд для однієї людини: нові коментарі - одне повідомлення; перший раз - лише підсумок. */
async function notifyBrand(o: Owner, ws: string, inboxOf: (ws: string) => Promise<Inbox>): Promise<void> {
  if (!(await notifyOn(ws))) return;
  const tz = (await getSettingText(ws, "timezone").catch(() => "")) || "Europe/Kyiv";
  if (quietNow(tz)) return;
  // бренд із ВЛАСНИМ ботом пише людині тим ботом; якщо людина працює з ним не через нього - не смикаємо
  if ((await wsBotToken(ws)) !== env.telegram.botToken && o.workspace_id !== ws) return;
  const inbox = await inboxOf(ws);
  if (!inbox.connected.length) return;
  const base = await one<{ n: number }>(`select count(*)::int n from comment_notice where workspace_id=$1 and tg_user_id=$2`, [ws, o.tg_user_id]);
  const seen = await one(`select 1 from settings_block where workspace_id=$1 and key=$2`, [ws, `comment_seen:${o.tg_user_id}`]);
  if (!seen && !(base?.n)) {
    // перше знайомство: наявні коментарі - «показані», людині - один рядок, а не лавина
    await ensureNotices(ws, o.tg_user_id, inbox.items);
    await setSetting(ws, `comment_seen:${o.tg_user_id}`, new Date().toISOString());
    if (inbox.items.length) {
      const brand = await brandTitle(ws);
      await sendOrPause(o, ws, `💬 У бренді «${brand}» ${inbox.items.length} ${plural(inbox.items.length, "коментар", "коментарі", "коментарів")} без відповіді (Instagram, Facebook, Threads). Відтепер нові надсилатиму сюди - відповідати можна просто з чату.`,
        [[{ text: `💬 Показати (${inbox.items.length})`, data: `cm:l:${ws.slice(0, 8)}` }], [{ text: "🔕 Не надсилати коментарі бренду", data: `cm:off:${ws.slice(0, 8)}` }]],
        async () => {   // знайомство не відбулось - після паузи почнемо його заново
          await q(`delete from comment_notice where workspace_id=$1 and tg_user_id=$2`, [ws, o.tg_user_id]);
          await q(`delete from settings_block where workspace_id=$1 and key=$2`, [ws, `comment_seen:${o.tg_user_id}`]);
        });
    }
    return;
  }
  if (!seen) await setSetting(ws, `comment_seen:${o.tg_user_id}`, new Date().toISOString());
  const known = new Set((await q<{ network: string; comment_id: string }>(
    `select network, comment_id from comment_notice where workspace_id=$1 and tg_user_id=$2`, [ws, o.tg_user_id])).map((r) => `${r.network}:${r.comment_id}`));
  const fresh = inbox.items.filter((it) => !known.has(`${it.net}:${it.commentId}`));
  if (!fresh.length) return;
  const ids = await ensureNotices(ws, o.tg_user_id, fresh, "new");
  const first = ids.get(`${fresh[0].net}:${fresh[0].commentId}`) || null;
  const card = await commentCard(ws, o.tg_user_id, { noticeId: first, header: `🔔 ${fresh.length === 1 ? "Новий коментар" : `Нових коментарів: ${fresh.length}`}` });
  // не дійшло - ці коментарі знову «нові»: прийдуть після паузи
  await sendOrPause(o, ws, card.text, card.buttons, () => q(`delete from comment_notice where id = any($1::bigint[])`, [[...ids.values()]]).then(() => {}));
}
async function sendOrPause(o: Owner, ws: string, text: string, buttons: tg.TgButton[][], undo: () => Promise<void>): Promise<void> {
  try { await liveSend(ws, o.chat_id, catFor(o.chat_id), text, buttons); }
  catch (e: any) {
    await undo().catch(() => {});
    backoff.set(`${o.tg_user_id}:${ws}`, Date.now() + BACKOFF_MS);
    await logEvent("warn", "comments-bot", `бот не зміг написати людині про коментарі бренду (наступна спроба за ${Math.max(1, Math.round(BACKOFF_MS / 3600_000))} год): ${String(e?.message || e).slice(0, 160)}`, { ws }).catch(() => {});
  }
}

let running = false;
export async function commentTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const owners = await q<Owner>(`select tg_user_id::text, chat_id, user_id, workspace_id from tg_owner where chat_id is not null`);
    // свіжий список (памʼять кабінету на 3 хв сховала б нові), але один на бренд за прохід, хоч би скільки людей його стерегло
    const fetched = new Map<string, Promise<Inbox>>();
    const inboxOf = (ws: string) => { let p = fetched.get(ws); if (!p) { p = collectInbox(ws, { fresh: true }); fetched.set(ws, p); } return p; };
    for (const o of owners) {
      for (const ws of await brandsFor(o).catch(() => [o.workspace_id])) {
        if ((backoff.get(`${o.tg_user_id}:${ws}`) || 0) > Date.now()) continue;
        try { await notifyBrand(o, ws, inboxOf); }
        catch (e: any) { await logEvent("warn", "comments-bot", `сповіщення про коментарі не вийшло: ${String(e?.message || e).slice(0, 180)}`, { ws }).catch(() => {}); }
      }
    }
  } finally { running = false; }
}
export function startCommentNotify(): void {
  if (!TICK_MS) return;
  setTimeout(() => { commentTick().catch(() => {}); }, FIRST_MS).unref?.();
  setInterval(() => { commentTick().catch(() => {}); }, TICK_MS).unref?.();
}

// ---------------------------------------------------------------- кнопки й відповіді з бота
// «✍ Свій текст»: наступне повідомлення людини - відповідь на цей коментар (15 хв; «-» - скасувати)
const awaiting = new Map<number, { noticeId: string; ws: string; at: number }>();
const AWAIT_MS = 15 * 60_000;

/** Рядок сповіщення, якщо він цієї людини й вона досі має доступ до бренду. */
async function noticeFor(fromId: number, id: string): Promise<Notice | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const n = await one<Notice>(`select id::text, workspace_id, tg_user_id::text, network, comment_id, status from comment_notice where id=$1`, [id]);
  if (!n || n.tg_user_id !== String(fromId)) return null;
  const o = await one<{ user_id: string | null; workspace_id: string }>(`select user_id, workspace_id from tg_owner where tg_user_id=$1`, [fromId]);
  if (!o) return null;
  if (o.user_id ? !(await isMember(o.user_id, n.workspace_id)) : o.workspace_id !== n.workspace_id) return null;
  // 👥 відповісти чи пропустити - лише поки людина редактор і вище (роль могли змінити після сповіщення)
  if (o.user_id) {
    const m = await one<{ role: string }>(`select role from workspace_member where user_id=$1 and workspace_id=$2`, [o.user_id, n.workspace_id]);
    if (!m || !can(normRole(m.role), "publish")) return null;
  }
  return n;
}
async function itemOf(n: Notice): Promise<InboxItem | null> {
  const inbox = await collectInbox(n.workspace_id);
  return inbox.items.find((it) => it.net === n.network && it.commentId === n.comment_id) || null;
}
async function brandByPrefix(fromId: number, short: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}$/.test(short)) return null;
  const o = await one<Owner>(`select tg_user_id::text, chat_id, user_id, workspace_id from tg_owner where tg_user_id=$1`, [fromId]);
  if (!o) return null;
  return (await brandsFor(o)).find((w) => w.startsWith(short)) || null;
}
async function show(ws: string, chatId: string, fromId: number, opts: { noticeId?: string | null; after?: boolean; header?: string } = {}): Promise<void> {
  const c = await commentCard(ws, String(fromId), opts);
  await liveSend(ws, chatId, catFor(chatId), c.text, c.buttons);
}

/** Кнопки cm:* (true - оброблено). Відповідь на натискання - одним рядком угорі екрана. */
export async function commentCallback(data: string, cbq: any, token: string): Promise<boolean> {
  if (!data.startsWith("cm:")) return false;
  const fromId = Number(cbq.from?.id); const chatId = String(cbq.message?.chat?.id ?? fromId);
  const [, act, arg] = data.split(":");
  const answer = (t?: string) => tg.answerCallbackQuery(token, cbq.id, t).catch(() => {});
  if (act === "l" || act === "off") {
    const ws = await brandByPrefix(fromId, arg);
    if (!ws) { await answer("Цього бренду в тебе нема"); return true; }
    if (act === "off") {
      await setNotify(ws, false);
      await answer("🔕 Більше не надсилатиму коментарі цього бренду");
      await liveSend(ws, chatId, catFor(chatId), `🔕 Коментарі бренду «${await brandTitle(ws)}» більше не надсилаю. Увімкнути знову: кабінет → «Сьогодні» → «💬 Коменти» → «🔔 Нові коментарі - в бот». Переглянути будь-коли - /comments.`);
      return true;
    }
    await answer();
    await show(ws, chatId, fromId);
    return true;
  }
  const n = await noticeFor(fromId, arg || "");
  if (!n) { await answer("Цей коментар уже не твій або бренд недоступний"); return true; }
  const ws = n.workspace_id;
  if (act === "n") { await answer(); await show(ws, chatId, fromId, { noticeId: n.id, after: true }); return true; }
  const it = await itemOf(n);
  if (!it) {
    await q(`update comment_notice set status='gone' where id=$1`, [n.id]);
    await answer("На цей коментар уже відповіли");
    await show(ws, chatId, fromId);
    return true;
  }
  if (act === "k") {
    await skipComment(ws, it.net, it.commentId);
    await q(`update comment_notice set status='skipped' where id=$1`, [n.id]);
    await answer("Пропущено");
    await show(ws, chatId, fromId);
    return true;
  }
  if (act === "w") {
    awaiting.set(fromId, { noticeId: n.id, ws, at: Date.now() });
    await answer();
    await liveSend(ws, chatId, catFor(chatId), `✍ Напиши відповідь для **${it.username || "автора"}** наступним повідомленням.\n\n«${it.comment.slice(0, 300)}»\n\n«-» - скасувати.`, [[{ text: "‹ Назад", data: `cm:b:${n.id}` }]]);
    return true;
  }
  if (act === "b") { awaiting.delete(fromId); await answer(); await show(ws, chatId, fromId, { noticeId: n.id }); return true; }
  if (act === "r") {
    const draft = (await inboxDrafts(ws, [it]).catch(() => ({} as Record<string, string>)))[it.commentId] || "";
    if (!draft) { await answer("Чернетки нема - «✍ Свій текст»"); return true; }
    await answer("Надсилаю…");
    await sendReply(ws, chatId, fromId, n, it, draft);
    return true;
  }
  await answer();
  return true;
}

async function sendReply(ws: string, chatId: string, fromId: number, n: Notice, it: InboxItem, text: string): Promise<void> {
  try {
    const r = await replyToComment(ws, it.net, it.commentId, text, it.account || null);
    await q(`update comment_notice set status='replied' where id=$1`, [n.id]);
    await show(ws, chatId, fromId, { header: `✅ Відповідь для ${it.username || "автора"} пішла${r.accountName ? ` від ${r.accountName}` : ""}.` });
  } catch (e: any) {
    await liveSend(ws, chatId, catFor(chatId), `⚠️ Відповідь не пішла: ${String(e?.message || e).slice(0, 300)}`, [[{ text: "‹ До коментаря", data: `cm:b:${n.id}` }]]);
  }
}

/** Текст після «✍ Свій текст» (true - це була відповідь на коментар). */
export async function commentText(fromId: number, chatId: string, text: string): Promise<boolean> {
  const w = awaiting.get(fromId);
  if (!w) return false;
  if (Date.now() - w.at > AWAIT_MS) { awaiting.delete(fromId); return false; }
  const t = String(text || "").trim();
  if (!t || t.startsWith("/")) return false;
  awaiting.delete(fromId);
  const n = await noticeFor(fromId, w.noticeId);
  if (!n) return true;
  if (t === "-") { await show(n.workspace_id, chatId, fromId, { noticeId: n.id }); return true; }
  const it = await itemOf(n);
  if (!it) { await show(n.workspace_id, chatId, fromId, { header: "На цей коментар уже відповіли." }); return true; }
  await sendReply(n.workspace_id, chatId, fromId, n, it, t);
  return true;
}

/** /comments і «💬 Коменти» в меню: поточний бренд, а коли там порожньо - перший бренд, де є що відповісти. */
export async function showComments(fromId: number, chatId: string, current: string): Promise<void> {
  const o = await one<Owner>(`select tg_user_id::text, chat_id, user_id, workspace_id from tg_owner where tg_user_id=$1`, [fromId]);
  const brands = o ? await brandsFor(o).catch(() => [current]) : [current];
  const order = [current, ...brands.filter((b) => b !== current)];
  for (const ws of order) {
    const inbox = await collectInbox(ws).catch(() => null);
    if (inbox && inbox.items.length) { await show(ws, chatId, fromId); return; }
  }
  await show(current, chatId, fromId);
}

/** Для ранкового зведення: скільки коментарів без відповіді (null - мереж із коментарями нема чи збій). */
export async function pendingCount(ws: string): Promise<number | null> {
  try { const inbox = await collectInbox(ws); return inbox.connected.length ? inbox.items.length : null; }
  catch { return null; }
}

function plural(n: number, one1: string, few: string, many: string): string {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one1;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
