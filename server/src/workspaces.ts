// 🏢 Доступ до кабінетів: хто в які бренди має право заходити.
//
// Було жорстко 1:1 - один акаунт, один кабінет. Щоб вести другий бренд, доводилось заводити другий
// акаунт і виходити-заходити; а конектор Claude, привʼязаний до кабінету, бачив лише один бренд.
// Тепер доступ - окрема таблиця `workspace_member`, а `app_user.workspace_id` лишається «домашнім»
// кабінетом: фолбек, якщо активний не заданий або доступ до нього відкликали.
import { q, one } from "./db.js";
import { deleteMediaFile } from "./media.js";

export type WsRow = { id: string; title: string; role: string };

// Назва для людини. `workspace.name` технічний і унікальний («user:пошта»), тож у перемикачі
// показуємо `title`, а поки його не задали - пошту без префікса.
const TITLE_SQL = `coalesce(nullif(btrim(w.title),''), replace(w.name,'user:',''))`;

export async function listWorkspaces(userId: string): Promise<WsRow[]> {
  return q<WsRow>(
    `select w.id, ${TITLE_SQL} as title, m.role
       from workspace_member m join workspace w on w.id = m.workspace_id
      where m.user_id = $1
      order by (m.role = 'owner') desc, 2`, [userId]);
}

export async function workspaceTitle(wsId: string): Promise<string> {
  return (await one<{ title: string }>(`select ${TITLE_SQL} as title from workspace w where w.id=$1`, [wsId]))?.title || "кабінет";
}

export async function isMember(userId: string, wsId: string): Promise<boolean> {
  return !!(await one(`select 1 from workspace_member where user_id=$1 and workspace_id=$2`, [userId, wsId]));
}

export async function isOwner(userId: string, wsId: string): Promise<boolean> {
  return !!(await one(`select 1 from workspace_member where user_id=$1 and workspace_id=$2 and role='owner'`, [userId, wsId]));
}

export const addMember = (wsId: string, userId: string, role: "owner" | "member" = "member") =>
  q(`insert into workspace_member(workspace_id, user_id, role) values($1,$2,$3) on conflict do nothing`, [wsId, userId, role]);

export async function members(wsId: string): Promise<{ user_id: string; email: string; role: string }[]> {
  return q(`select m.user_id, u.email, m.role from workspace_member m join app_user u on u.id = m.user_id
            where m.workspace_id=$1 order by (m.role='owner') desc, u.email`, [wsId]);
}

// Видати доступ до кабінету за поштою. Свідомо НЕ створюємо акаунт на льоту: доступ до бренду
// мовчки не зʼявляється в людини, якої в сервісі ще немає - спершу вона реєструється сама.
export async function grantAccess(wsId: string, email: string): Promise<{ ok: boolean; error?: string }> {
  const u = await one<{ id: string }>(`select id from app_user where email=$1 and deleted_at is null`, [String(email || "").trim().toLowerCase()]);
  if (!u) return { ok: false, error: "Такого акаунта немає. Спершу нехай зареєструється, тоді дай доступ." };
  if (await isMember(u.id, wsId)) return { ok: false, error: "У цієї людини вже є доступ." };
  await addMember(wsId, u.id, "member");
  return { ok: true };
}

// Відкликання доступу. Власника (owner) прибрати не можна - інакше кабінет лишиться без господаря
// і його нікому буде віддати чи видалити.
export async function revokeAccess(wsId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const row = await one<{ role: string }>(`select role from workspace_member where workspace_id=$1 and user_id=$2`, [wsId, userId]);
  if (!row) return { ok: false, error: "Доступу й так немає." };
  if (row.role === "owner") return { ok: false, error: "Власника кабінету прибрати не можна." };
  await q(`delete from workspace_member where workspace_id=$1 and user_id=$2`, [wsId, userId]);
  // разом із доступом - і Telegram: бот і Mini App цієї людини більше не відкривають кабінет
  await q(`delete from tg_owner where workspace_id=$1 and user_id=$2`, [wsId, userId]);
  await q(`delete from tg_connect where workspace_id=$1 and created_by=$2`, [wsId, userId]);
  // сесії, що сиділи в цьому кабінеті, самі впадуть у домашній: resolve у userBySession робить
  // join по членству, тож окремо чистити нічого не треба
  return { ok: true };
}

export async function setTitle(wsId: string, title: string): Promise<void> {
  await q(`update workspace set title=$2 where id=$1`, [wsId, String(title || "").trim().slice(0, 60) || null]);
}

// ---- видалення ----
// Домашній кабінет - це і є акаунт: `app_user.workspace_id` посилається на нього з on delete
// cascade, тож «видалити бренд», якщо це чийсь домашній кабінет, мовчки стерло б людину разом з
// усім. Тому видалення бренду перевіряє це ПЕРШИМ і для будь-кого, не лише для себе.
export async function isAnyonesHome(wsId: string): Promise<boolean> {
  return !!(await one(`select 1 from app_user where workspace_id=$1 limit 1`, [wsId]));
}

// Стерти кабінет повністю: рядок workspace (решту бере каскад - кожна колонка workspace_id у схемі
// має FK з on delete cascade/set null, це перевірено по information_schema) і файли медіа з диска.
// Спершу база, потім файли: якщо впаде запит, пости не лишаться з битими картинками; а файл, що
// не видалився, прибере нічна зачистка сиріт. Файл, на який посилається ІНШИЙ кабінет, не чіпаємо.
// Сесії та конектори, що сиділи в цьому кабінеті, отримують null (FK on delete set null) і самі
// падають у домашній кабінет наступним же запитом.
export async function purgeWorkspace(wsId: string): Promise<void> {
  const files = await q<{ filename: string }>(
    `select distinct a.filename from media_asset a where a.workspace_id=$1
        and not exists (select 1 from media_asset b where b.filename=a.filename and b.workspace_id<>$1)`, [wsId]);
  await q(`delete from workspace where id=$1`, [wsId]);
  for (const f of files) await deleteMediaFile(f.filename).catch(() => {});
}

// Бренди, які йдуть разом з акаунтом: людина в них ЄДИНИЙ власник і вони нічий не домашній
// кабінет. Без цього після видалення акаунта такі бренди лишались сиротами - без господаря, з
// доступом у тих, кому його видали, і з даними, які людина просила стерти.
export async function soleOwnedBrands(userId: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `select w.id from workspace w
       join workspace_member m on m.workspace_id = w.id and m.user_id = $1 and m.role = 'owner'
      where not exists (select 1 from app_user u where u.workspace_id = w.id)
        and not exists (select 1 from workspace_member o where o.workspace_id = w.id and o.role = 'owner' and o.user_id <> $1)`,
    [userId]);
  return rows.map((r) => r.id);
}

const norm = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// Видалити бренд. Підтвердження - НАЗВОЮ бренду, а не «так»: так людина бачить, що саме стирає,
// і не прибере сусідній бренд, переплутавши вкладку. Кнопку «Видалити» в кабінеті шукають у
// «Небезпечній зоні» - саме там раніше стояло лише «Видалити акаунт», і його натиснули, щоб
// прибрати бренд (акаунт заплановано до видалення, людину вилогінило).
export async function deleteBrand(userId: string, wsId: string, confirm: unknown):
    Promise<{ ok: true; title: string } | { ok: false; status: number; error: string }> {
  const w = await one<{ title: string }>(`select ${TITLE_SQL} as title from workspace w where w.id=$1`, [wsId]);
  if (!w) return { ok: false, status: 404, error: "Такого бренду вже немає." };
  if (!(await isOwner(userId, wsId))) return { ok: false, status: 403, error: "Видалити бренд може лише його власник." };
  if (await isAnyonesHome(wsId)) {
    return { ok: false, status: 400, error: "Це основний кабінет акаунта: він видаляється лише разом з акаунтом (Профіль → Небезпечна зона → Видалити акаунт)." };
  }
  if (norm(confirm) !== norm(w.title)) return { ok: false, status: 400, error: `Щоб підтвердити, введи назву бренду точно: «${w.title}».` };
  await purgeWorkspace(wsId);
  return { ok: true, title: w.title };
}
