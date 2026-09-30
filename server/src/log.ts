import { q } from "./db.js";

export type LogLevel = "info" | "warn" | "error";

// 🔔 Хук сповіщень (alerts.ts ставить його на старті): кожен warn/error іде ще й туди - там вирішують,
// чи це привід написати адміну. Через хук, а не імпорт: журнал пишуть і модулі, якими користується
// alerts.ts (бот, пошта), тож прямий імпорт замкнув би модулі в коло.
type LogHook = (level: LogLevel, scope: string, message: string) => void;
let hook: LogHook | null = null;
export function setLogHook(fn: LogHook | null): void { hook = fn; }

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
  if (hook && level !== "info") { try { hook(level, scope, String(message ?? "")); } catch { /* так само */ } }
}
