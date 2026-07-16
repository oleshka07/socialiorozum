// Типізований доступ до settings_block (key-value на воркспейс).
// До цього кожен читач руками робив select + JSON.parse у порожньому try/catch -
// 15 сліпих зон. Тут: одна точка парсингу, битий JSON = fallback (і слід у консолі).
import { q, one } from "./db.js";

export async function getSettingText(ws: string, key: string): Promise<string> {
  const r = await one<{ content: string }>(
    `select content from settings_block where workspace_id=$1 and key=$2`, [ws, key]);
  return r?.content ?? "";
}

export async function getSetting<T>(ws: string, key: string, fallback: T): Promise<T> {
  const raw = await getSettingText(ws, key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch { console.warn(`[settings] битий JSON у ${key} (ws=${ws}) - повертаю fallback`); return fallback; }
}

export async function setSetting(ws: string, key: string, value: unknown): Promise<void> {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  await q(
    `insert into settings_block(workspace_id, key, content) values($1,$2,$3)
     on conflict (workspace_id, key) do update set content=excluded.content, updated_at=now()`,
    [ws, key, content]);
}
