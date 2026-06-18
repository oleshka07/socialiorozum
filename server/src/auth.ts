import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { q, one } from "./db.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

const SESSION_DAYS = 30;
const VERIFY_HOURS = 24;
const RESET_HOURS = 2;

// ---- паролі: scrypt (вбудований у Node, без зовнішніх залежностей) ----
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const parts = (stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(pw, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const newToken = () => randomBytes(32).toString("hex");

// ---- workspace із дефолтними блоками (на кожного юзера свій) ----
export async function createWorkspaceWithDefaults(name: string): Promise<string> {
  const ws = await one<{ id: string }>(`insert into workspace(name) values($1) returning id`, [name]);
  const wsId = ws!.id;
  for (const [key, content] of Object.entries(DEFAULT_SETTINGS)) {
    await q(
      `insert into settings_block(workspace_id, key, content) values($1,$2,$3)
       on conflict (workspace_id,key) do nothing`,
      [wsId, key, content]
    );
  }
  return wsId;
}

export type User = { id: string; email: string; email_verified: boolean; workspace_id: string };

export async function createUser(email: string, password: string): Promise<User> {
  const wsId = await createWorkspaceWithDefaults("user:" + email.toLowerCase());
  const u = await one<User>(
    `insert into app_user(email, password_hash, workspace_id) values($1,$2,$3)
     returning id, email, email_verified, workspace_id`,
    [email.toLowerCase(), hashPassword(password), wsId]
  );
  return u!;
}
export async function findOrCreateGoogleUser(email: string, googleId: string): Promise<User> {
  const e = email.toLowerCase();
  const existing = await one<User>(
    `select id, email, email_verified, workspace_id from app_user where email=$1`, [e]);
  if (existing) {
    await q(`update app_user set email_verified=true, google_id=coalesce(google_id,$2) where id=$1`, [existing.id, googleId]);
    return { ...existing, email_verified: true };
  }
  const wsId = await createWorkspaceWithDefaults("user:" + e);
  const u = await one<User>(
    `insert into app_user(email, password_hash, email_verified, workspace_id, google_id)
     values($1, null, true, $2, $3) returning id, email, email_verified, workspace_id`,
    [e, wsId, googleId]
  );
  return u!;
}

export const userByEmail = (email: string) =>
  one<User & { password_hash: string }>(
    `select id, email, email_verified, workspace_id, password_hash from app_user where email=$1`,
    [email.toLowerCase()]
  );
export const setPassword = (userId: string, password: string) =>
  q(`update app_user set password_hash=$2 where id=$1`, [userId, hashPassword(password)]);
export const markVerified = (userId: string) =>
  q(`update app_user set email_verified=true where id=$1`, [userId]);

// ---- сесії (cookie -> token у БД) ----
export async function createSession(userId: string): Promise<string> {
  const token = newToken();
  await q(
    `insert into user_session(token, user_id, expires_at) values($1,$2, now() + ($3 || ' days')::interval)`,
    [token, userId, String(SESSION_DAYS)]
  );
  return token;
}
export async function userBySession(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  return one<User>(
    `select u.id, u.email, u.email_verified, u.workspace_id
     from user_session s join app_user u on u.id = s.user_id
     where s.token=$1 and s.expires_at > now()`,
    [token]
  );
}
export const deleteSession = (token: string) => q(`delete from user_session where token=$1`, [token]);

// ---- одноразові токени для пошти ----
export async function createEmailToken(userId: string, kind: "verify" | "reset"): Promise<string> {
  const token = newToken();
  const hours = kind === "verify" ? VERIFY_HOURS : RESET_HOURS;
  await q(
    `insert into email_token(token, user_id, kind, expires_at) values($1,$2,$3, now() + ($4 || ' hours')::interval)`,
    [token, userId, kind, String(hours)]
  );
  return token;
}
export async function consumeEmailToken(token: string, kind: "verify" | "reset"): Promise<string | null> {
  const row = await one<{ user_id: string }>(
    `update email_token set used=true
     where token=$1 and kind=$2 and used=false and expires_at > now()
     returning user_id`,
    [token, kind]
  );
  return row?.user_id ?? null;
}
