// 👥 Команда бренду: додати людину за поштою з рівнем доступу, змінити роль, прибрати, покинути бренд,
// запрошення для тих, кого в сервісі ще нема, і сповіщення навколо затвердження постів.
//
// Людина з акаунтом отримує доступ ОДРАЗУ (бренд зʼявляється в перемикачі, лист і повідомлення в бот).
// Людини без акаунта сервіс не створює на льоту - вона отримує лист-запрошення, і бренд зʼявляється в неї,
// щойно вона зареєструється з цією поштою. Прийняти запрошення можна лише перевіреною поштою: підтвердження
// листом, вхід через Google або посилання з самого запрошення (воно прийшло в цю скриньку). Простий вхід
// паролем запрошень не забирає: пошту акаунта можна змінити без підтвердження нової адреси.
import { createHash, randomBytes } from "node:crypto";
import { q, one } from "./db.js";
import { env } from "./env.js";
import { logEvent } from "./log.js";
import { workspaceTitle } from "./workspaces.js";
import { normRole, isAssignable, ROLE_LABEL, ROLE_ICON, ROLE_HINT, can, type Role } from "./roles.js";
import { sendTeamInviteEmail, sendTeamAddedEmail, sendReviewRequestEmail, sendReviewResultEmail } from "./email.js";
import { cabinetPostLink } from "./permalink.js";

export const INVITE_DAYS = 14;
const MAX_OPEN_INVITES = 50;
const hashToken = (t: string) => createHash("sha256").update(String(t)).digest("hex");
export const isInviteToken = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);
const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 254;
const roleLine = (r: Role) => `${ROLE_ICON[r]} ${ROLE_LABEL[r]}`;
const brandLink = (wsId: string) => `${env.appBaseUrl}/app?ws=${wsId}`;

/** Роль людини в бренді (null - не учасник). */
export async function roleIn(userId: string | null | undefined, wsId: string): Promise<Role | null> {
  if (!userId) return null;
  const r = await one<{ role: string }>(`select role from workspace_member where user_id=$1 and workspace_id=$2`, [userId, wsId]);
  return r ? normRole(r.role) : null;
}

export type TeamMember = { user_id: string; email: string; role: Role; since: string; added_by_email: string | null };
export type TeamInvite = { id: string; email: string; role: Role; created_at: string; expires_at: string; invited_by_email: string | null; expired: boolean };

export async function teamOf(wsId: string): Promise<{ members: TeamMember[]; invites: TeamInvite[] }> {
  const [members, invites] = await Promise.all([
    q<{ user_id: string; email: string; role: string; since: string; added_by_email: string | null }>(
      `select m.user_id, u.email, m.role, m.created_at as since, a.email as added_by_email
         from workspace_member m join app_user u on u.id=m.user_id left join app_user a on a.id=m.added_by
        where m.workspace_id=$1 and u.deleted_at is null
        order by case m.role when 'owner' then 0 when 'admin' then 1 when 'member' then 1 when 'editor' then 2 when 'author' then 3 else 4 end, u.email`, [wsId]),
    q<{ id: string; email: string; role: string; created_at: string; expires_at: string; invited_by_email: string | null; expired: boolean }>(
      `select i.id, i.email, i.role, i.created_at, i.expires_at, a.email as invited_by_email, (i.expires_at < now()) as expired
         from workspace_invite i left join app_user a on a.id=i.invited_by
        where i.workspace_id=$1 and i.accepted_at is null order by i.created_at desc`, [wsId]),
  ]);
  return {
    members: members.map((m) => ({ ...m, role: normRole(m.role) })),
    invites: invites.map((i) => ({ ...i, role: normRole(i.role) })),
  };
}

// ---------------------------------------------------------------- сповіщення людині
/** Повідомлення в Telegram усім чатам людини з ботом (тим ботом, що обслуговує її поточний бренд). true - дійшло. */
export async function notifyPerson(userId: string, text: string, buttons?: { text: string; url?: string; data?: string }[][]): Promise<boolean> {
  try {
    const rows = await q<{ chat_id: string; workspace_id: string }>(`select chat_id, workspace_id from tg_owner where user_id=$1 and chat_id is not null`, [userId]);
    if (!rows.length) return false;
    const { wsBotToken } = await import("./tgbot.js");
    const tg = await import("./telegram.js");
    let ok = false;
    for (const r of rows) {
      const token = await wsBotToken(r.workspace_id).catch(() => "");
      if (!token) continue;
      try { await tg.sendMessage(token, r.chat_id, text, buttons as any); ok = true; } catch { /* заблокували бота - лишається пошта */ }
    }
    return ok;
  } catch { return false; }
}
const emailOf = async (userId: string) => (await one<{ email: string }>(`select email from app_user where id=$1 and deleted_at is null`, [userId]))?.email || "";

// ---------------------------------------------------------------- додати людину
export type AddResult =
  | { ok: true; kind: "added"; email: string; role: Role; message: string }
  | { ok: true; kind: "invited"; email: string; role: Role; message: string; inviteId: string }
  | { ok: false; status: number; error: string };

export async function addToTeam(wsId: string, byUserId: string, rawEmail: unknown, rawRole: unknown): Promise<AddResult> {
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!emailOk(email)) return { ok: false, status: 400, error: "Введи пошту людини, напр. kostya@gmail.com" };
  if (!isAssignable(rawRole)) return { ok: false, status: 400, error: "Обери рівень доступу: повний, редактор, автор або перегляд." };
  const role = rawRole as Role;
  const byRole = await roleIn(byUserId, wsId);
  // повний доступ може додавати людей, але не вище за себе (вище - лише власник, а його не видають)
  if (!can(byRole, "team")) return { ok: false, status: 403, error: "Командою бренду керує власник або людина з повним доступом." };
  const by = await emailOf(byUserId);
  if (email === by) return { ok: false, status: 400, error: "Це твоя пошта - ти вже в бренді." };
  const brand = await workspaceTitle(wsId);
  const u = await one<{ id: string }>(`select id from app_user where email=$1 and deleted_at is null`, [email]);
  if (u) {
    const cur = await roleIn(u.id, wsId);
    if (cur) return { ok: false, status: 409, error: `${email} уже в бренді: ${roleLine(cur)}. Щоб змінити рівень - обери його в списку нижче.` };
    await q(`insert into workspace_member(workspace_id, user_id, role, added_by) values($1,$2,$3,$4) on conflict do nothing`, [wsId, u.id, role, byUserId]);
    await q(`delete from workspace_invite where workspace_id=$1 and lower(email)=$2 and accepted_at is null`, [wsId, email]);
    await logEvent("info", "team", `додано до бренду «${brand}»: ${email} (${ROLE_LABEL[role]})`, { ws: wsId }, byUserId);
    // лист і бот - не критично: доступ уже є, людина побачить бренд у перемикачі
    const tgOk = await notifyPerson(u.id, `👥 ${by} додав(ла) тебе до бренду «${brand}».\nРоль: ${roleLine(role)} - ${ROLE_HINT[role]}.\n\nПерейти на нього в боті - /brand.`,
      [[{ text: "🌐 Відкрити бренд", url: brandLink(wsId) }]]);
    try { await sendTeamAddedEmail({ to: email, brand, by, role: roleLine(role), hint: ROLE_HINT[role], link: brandLink(wsId) }); }
    catch (e: any) { if (!tgOk) await logEvent("warn", "email", `лист «тебе додали» НЕ надіслано (${email}): ${e.message}`, { ws: wsId }, byUserId); }
    return { ok: true, kind: "added", email, role, message: `Готово: ${email} має доступ (${roleLine(role)}). Бренд уже зʼявився в цієї людини в меню брендів.` };
  }
  const open = await one<{ n: number }>(`select count(*)::int n from workspace_invite where workspace_id=$1 and accepted_at is null`, [wsId]);
  if ((open?.n || 0) >= MAX_OPEN_INVITES) return { ok: false, status: 429, error: "Забагато неприйнятих запрошень - скасуй старі в списку нижче." };
  const token = randomBytes(32).toString("hex");
  const row = await one<{ id: string }>(
    `insert into workspace_invite(workspace_id, email, role, invited_by, token_hash, expires_at, sent_at)
     values($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval, now())
     on conflict (workspace_id, lower(email)) where accepted_at is null
       do update set role=excluded.role, invited_by=excluded.invited_by, token_hash=excluded.token_hash,
                     expires_at=excluded.expires_at, sent_at=now(), created_at=now()
     returning id`, [wsId, email, role, byUserId, hashToken(token), String(INVITE_DAYS)]);
  try {
    await sendTeamInviteEmail({ to: email, brand, by, role: roleLine(role), hint: ROLE_HINT[role], link: `${env.appBaseUrl}/invite/${token}`, days: INVITE_DAYS });
  } catch (e: any) {
    await logEvent("warn", "email", `лист-запрошення НЕ надіслано (${email}): ${e.message}`, { ws: wsId }, byUserId);
    return { ok: false, status: 502, error: "Запрошення збережено, але лист не відправився - натисни «↻ Надіслати ще раз» за хвилину." };
  }
  await logEvent("info", "team", `запрошення в бренд «${brand}»: ${email} (${ROLE_LABEL[role]})`, { ws: wsId }, byUserId);
  return { ok: true, kind: "invited", email, role, inviteId: row!.id,
    message: `Запрошення надіслано на ${email}. Щойно людина зареєструється з цією поштою, бренд зʼявиться в неї (${roleLine(role)}).` };
}

export async function resendInvite(wsId: string, byUserId: string, inviteId: string): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }> {
  const inv = await one<{ email: string; role: string }>(`select email, role from workspace_invite where id=$1 and workspace_id=$2 and accepted_at is null`, [inviteId, wsId]);
  if (!inv) return { ok: false, status: 404, error: "Цього запрошення вже нема - можливо, його прийняли." };
  const token = randomBytes(32).toString("hex");
  await q(`update workspace_invite set token_hash=$2, expires_at=now() + ($3 || ' days')::interval, sent_at=now(), invited_by=$4 where id=$1`,
    [inviteId, hashToken(token), String(INVITE_DAYS), byUserId]);
  const role = normRole(inv.role);
  try {
    await sendTeamInviteEmail({ to: inv.email, brand: await workspaceTitle(wsId), by: await emailOf(byUserId), role: roleLine(role), hint: ROLE_HINT[role],
      link: `${env.appBaseUrl}/invite/${token}`, days: INVITE_DAYS });
  } catch (e: any) { return { ok: false, status: 502, error: "Лист не відправився: " + String(e.message).slice(0, 160) }; }
  return { ok: true, message: `Надіслано ще раз на ${inv.email}. Попереднє посилання з листа більше не діє.` };
}

export async function cancelInvite(wsId: string, inviteId: string): Promise<boolean> {
  return (await q(`delete from workspace_invite where id=$1 and workspace_id=$2 and accepted_at is null returning id`, [inviteId, wsId])).length > 0;
}

// ---------------------------------------------------------------- змінити роль, прибрати, покинути
export async function changeRole(wsId: string, byUserId: string, userId: string, rawRole: unknown): Promise<{ ok: true; role: Role } | { ok: false; status: number; error: string }> {
  if (!isAssignable(rawRole)) return { ok: false, status: 400, error: "Невідомий рівень доступу." };
  if (userId === byUserId) return { ok: false, status: 400, error: "Свою роль не змінюють - попроси власника або покинь бренд." };
  const cur = await roleIn(userId, wsId);
  if (!cur) return { ok: false, status: 404, error: "Цієї людини вже нема в бренді." };
  if (cur === "owner") return { ok: false, status: 400, error: "Роль власника не змінюється." };
  const role = rawRole as Role;
  await q(`update workspace_member set role=$3 where workspace_id=$1 and user_id=$2`, [wsId, userId, role]);
  await logEvent("info", "team", `роль змінено: ${await emailOf(userId)} → ${ROLE_LABEL[role]}`, { ws: wsId }, byUserId);
  return { ok: true, role };
}

export async function leaveBrand(wsId: string, userId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cur = await roleIn(userId, wsId);
  if (!cur) return { ok: false, status: 404, error: "Ти вже не в цьому бренді." };
  if (cur === "owner") return { ok: false, status: 400, error: "Власник не може покинути свій бренд - його можна лише видалити (Профіль → Небезпечна зона)." };
  const { revokeAccess } = await import("./workspaces.js");
  await revokeAccess(wsId, userId);
  await logEvent("info", "team", `покинув(ла) бренд: ${await emailOf(userId)}`, { ws: wsId }, userId);
  return { ok: true };
}

// ---------------------------------------------------------------- прийняти запрошення
export type Accepted = { workspace_id: string; title: string; role: Role };

async function acceptRows(rows: { id: string; workspace_id: string; role: string; invited_by: string | null }[], userId: string, email: string): Promise<Accepted[]> {
  const out: Accepted[] = [];
  for (const r of rows) {
    const role = normRole(r.role);
    // уже учасник (додали напряму) - роль не знижуємо й не підвищуємо мовчки
    await q(`insert into workspace_member(workspace_id, user_id, role, added_by) values($1,$2,$3,$4) on conflict do nothing`, [r.workspace_id, userId, role, r.invited_by]);
    await q(`update workspace_invite set accepted_at=now(), accepted_by=$2 where id=$1`, [r.id, userId]);
    const title = await workspaceTitle(r.workspace_id);
    out.push({ workspace_id: r.workspace_id, title, role });
    await logEvent("info", "team", `запрошення прийнято: ${email} у «${title}» (${ROLE_LABEL[role]})`, { ws: r.workspace_id }, userId);
    if (r.invited_by && r.invited_by !== userId)
      await notifyPerson(r.invited_by, `✅ ${email} прийняв(ла) запрошення в бренд «${title}» (${roleLine(role)}).`).catch(() => false);
  }
  return out;
}

/** Усі відкриті запрошення на ЦЮ пошту - лише коли пошту щойно перевірено (лист підтвердження, Google). */
export async function acceptInvitesByEmail(userId: string, email: string): Promise<Accepted[]> {
  const rows = await q<{ id: string; workspace_id: string; role: string; invited_by: string | null }>(
    `select id, workspace_id, role, invited_by from workspace_invite
      where lower(email)=lower($1) and accepted_at is null and expires_at > now() order by created_at`, [email]);
  return rows.length ? acceptRows(rows, userId, email) : [];
}

export type InviteInfo = { email: string; brand: string; role: Role; by: string; expired: boolean; accepted: boolean; workspace_id: string };
export async function inviteInfo(token: unknown): Promise<InviteInfo | null> {
  if (!isInviteToken(token)) return null;
  const r = await one<{ email: string; workspace_id: string; role: string; by: string | null; expired: boolean; accepted: boolean }>(
    `select i.email, i.workspace_id, i.role, a.email as by, (i.expires_at < now()) as expired, (i.accepted_at is not null) as accepted
       from workspace_invite i left join app_user a on a.id=i.invited_by where i.token_hash=$1`, [hashToken(token)]);
  if (!r) return null;
  return { email: r.email, brand: await workspaceTitle(r.workspace_id), role: normRole(r.role), by: r.by || "", expired: r.expired, accepted: r.accepted, workspace_id: r.workspace_id };
}

/** Посилання з листа: приймає ЦЕ запрошення для людини, чия пошта збігається (посилання прийшло в її скриньку). */
export async function acceptInviteToken(token: unknown, userId: string, email: string): Promise<{ ok: true; accepted: Accepted } | { ok: false; reason: "invalid" | "expired" | "mismatch"; email?: string }> {
  if (!isInviteToken(token)) return { ok: false, reason: "invalid" };
  const r = await one<{ id: string; workspace_id: string; role: string; invited_by: string | null; email: string; expired: boolean; accepted_at: string | null }>(
    `select id, workspace_id, role, invited_by, email, (expires_at < now()) as expired, accepted_at from workspace_invite where token_hash=$1`, [hashToken(token)]);
  if (!r) return { ok: false, reason: "invalid" };
  if (String(r.email).toLowerCase() !== String(email).toLowerCase()) return { ok: false, reason: "mismatch", email: r.email };
  if (r.accepted_at) {
    // вже прийняте (повторний клік з листа) - просто ведемо в бренд, якщо доступ лишився
    const role = await roleIn(userId, r.workspace_id);
    return role ? { ok: true, accepted: { workspace_id: r.workspace_id, title: await workspaceTitle(r.workspace_id), role } } : { ok: false, reason: "invalid" };
  }
  if (r.expired) return { ok: false, reason: "expired" };
  const [a] = await acceptRows([r], userId, email);
  return { ok: true, accepted: a };
}

// ---------------------------------------------------------------- затвердження постів
const firstLineOf = (s: unknown) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 139) + "…" : t || "(без тексту)";
};

/** Автор надіслав пост на затвердження: кожному, хто затверджує, - у бот, а хто без бота - листом. */
export async function notifyReviewRequest(wsId: string, postId: string, byUserId: string): Promise<number> {
  const [brand, by, post, approvers] = await Promise.all([
    workspaceTitle(wsId), emailOf(byUserId),
    one<{ content: string }>(`select content from post where id=$1`, [postId]),
    q<{ user_id: string; email: string }>(
      `select m.user_id, u.email from workspace_member m join app_user u on u.id=m.user_id
        where m.workspace_id=$1 and m.role in ('owner','admin','member','editor') and m.user_id<>$2 and u.deleted_at is null`, [wsId, byUserId]),
  ]);
  const link = cabinetPostLink(env.appBaseUrl, postId);
  const first = firstLineOf(post?.content);
  let n = 0;
  for (const a of approvers) {
    const viaBot = await notifyPerson(a.user_id, `📨 «${brand}»: ${by} надіслав(ла) пост на затвердження.\n\n«${first}»`, [[{ text: "✍ Відкрити пост", url: link }]]);
    if (!viaBot) { try { await sendReviewRequestEmail({ to: a.email, brand, by, firstLine: first, link }); } catch { continue; } }
    n++;
  }
  return n;
}

/** Затвердили чи повернули пост автора - йому (ботом, інакше листом). Свій же пост - без сповіщення. */
export async function notifyReviewResult(wsId: string, postId: string, byUserId: string | null, approved: boolean, note?: string | null): Promise<void> {
  const p = await one<{ submitted_by: string | null; content: string }>(`select submitted_by, content from post where id=$1`, [postId]);
  if (!p?.submitted_by || p.submitted_by === byUserId) return;
  const [brand, by, to] = await Promise.all([workspaceTitle(wsId), byUserId ? emailOf(byUserId) : Promise.resolve("Holos"), emailOf(p.submitted_by)]);
  const link = cabinetPostLink(env.appBaseUrl, postId);
  const first = firstLineOf(p.content);
  const text = approved
    ? `✅ «${brand}»: ${by} затвердив(ла) твій пост.\n\n«${first}»`
    : `↩ «${brand}»: ${by} повернув(ла) пост на доопрацювання.${note ? `\nКоментар: ${note}` : ""}\n\n«${first}»`;
  const viaBot = await notifyPerson(p.submitted_by, text, [[{ text: "✍ Відкрити пост", url: link }]]);
  if (!viaBot && to) { try { await sendReviewResultEmail({ to, brand, by, firstLine: first, link, approved, note: note || undefined }); } catch { /* не критично */ } }
}

/**
 * Автор пише й править чернетки, але не те, що вже затверджено чи опубліковано (це зміна чужого
 * рішення); видаляє - лише свої. null - можна (або поста нема - тоді виклик сам скаже «не знайдено»).
 */
export async function authorEditBlock(ws: string, postId: string, userId: string | null, deleting = false): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(postId))) return null;
  const p = await one<{ review: string | null; created_by: string | null; sent: boolean }>(
    `select p.review, p.created_by, exists(select 1 from post_published pp where pp.post_id=p.id) as sent
       from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!p) return null;
  if (p.sent) return "Цей пост уже опубліковано - змінювати його може редактор чи власник.";
  if (p.review === "approved") return "Пост уже затверджено - змінювати його може редактор чи власник. Якщо треба правка - попроси їх повернути пост на доопрацювання.";
  if (deleting && (!userId || p.created_by !== userId)) return "Автор видаляє лише власні чернетки.";
  return null;
}

/** Надіслати на затвердження (кабінет, бот, Mini App, конектор - одна дія). */
// Уже на затвердженні - вдруге нікого не будимо (кнопка в боті, повтор у конекторі); затверджений чи
// опублікований пост «на затвердження» не відкликається: він міг уже стояти в календарі.
export type SubmitResult = { ok: true; already?: boolean } | { ok: false; error: string };
export async function submitForReview(ws: string, postId: string, userId: string | null): Promise<SubmitResult> {
  const p = await one<{ review: string | null; sent: boolean }>(
    `select p.review, exists(select 1 from post_published pp where pp.post_id=p.id) as sent
       from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!p) return { ok: false, error: "пост не знайдено" };
  if (p.sent) return { ok: false, error: "Пост уже опубліковано - на затвердження надсилати нічого." };
  if (p.review === "approved") return { ok: false, error: "Пост уже затверджено." };
  if (p.review === "pending") return { ok: true, already: true };
  await q(`update post set review='pending', submitted_by=$2, submitted_at=now(), review_note=null where id=$1`, [postId, userId]);
  if (userId) notifyReviewRequest(ws, postId, userId).catch((e) => logEvent("warn", "team", `сповіщення «на затвердження» не пішло: ${e?.message || e}`, { ws }));
  return { ok: true };
}

/** Пост щойно затвердили (кнопкою, плануванням, конектором): якщо його чекав автор - кажемо йому. */
export async function approvedNotice(ws: string, postId: string, prevReview: string | null | undefined, byUserId: string | null): Promise<void> {
  if (prevReview === "pending") await notifyReviewResult(ws, postId, byUserId, true).catch(() => {});
}
