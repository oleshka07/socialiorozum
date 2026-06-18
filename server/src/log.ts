import { q } from "./db.js";

export type LogLevel = "info" | "warn" | "error";

// Подвійне логування: у stdout (pino/docker logs) і в БД (app_log) для швидкої діагностики.
export async function logEvent(
  level: LogLevel, scope: string, message: string, meta?: any, userId?: string
): Promise<void> {
  const line = `[${level}] ${scope}: ${message}`;
  if (level === "error") console.error(line, meta ?? "");
  else if (level === "warn") console.warn(line, meta ?? "");
  else console.log(line, meta ?? "");
  try {
    await q(`insert into app_log(level, scope, message, meta, user_id) values($1,$2,$3,$4,$5)`,
      [level, scope, message, meta ? JSON.stringify(meta) : null, userId ?? null]);
  } catch { /* лог не повинен валити основний запит */ }
}
