// 🏢 Доступ до кабінетів: хто в які бренди має право заходити.
//
// Було жорстко 1:1 - один акаунт, один кабінет. Щоб вести другий бренд, доводилось заводити другий
// акаунт і виходити-заходити; а конектор Claude, привʼязаний до кабінету, бачив лише один бренд.
// Тепер доступ - окрема таблиця `workspace_member`, а `app_user.workspace_id` лишається «домашнім»
// кабінетом: фолбек, якщо активний не заданий або доступ до нього відкликали.
import { q, one } from "./db.js";

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
  // сесії, що сиділи в цьому кабінеті, самі впадуть у домашній: resolve у userBySession робить
  // join по членству, тож окремо чистити нічого не треба
  return { ok: true };
}

export async function setTitle(wsId: string, title: string): Promise<void> {
  await q(`update workspace set title=$2 where id=$1`, [wsId, String(title || "").trim().slice(0, 60) || null]);
}
