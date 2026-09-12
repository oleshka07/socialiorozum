// Ключі провайдерів, які ставляться з адмінки, а не з `.env`.
//
// Проблема, яку це лікує: щоб додати ключ, треба було зайти по SSH на сервер, відредагувати
// `/opt/socialio/server/.env` і перестворити контейнер. Тобто «спробувати нового провайдера»
// коштувало окремої сесії - і фактично не робилось ніколи.
//
// Модель накладання СВІДОМО така: `.env` лишається базою, таблиця `app_secret` кладеться ПОВЕРХ.
// Порожня таблиця = поведінка рівно як була. Видалення ключа з адмінки не «вимикає провайдера»,
// а повертає значення з `.env` - тож помилковим кліком не можна покласти те, що працювало.
//
// ⚠️ ЗНАЧЕННЯ НІКОЛИ НЕ ВИХОДИТЬ НАЗОВНІ: назовні їде лише `set`, джерело і останні 4 символи.
// Ключ не пишеться ні в лог подій, ні в консоль - навіть при помилці.
import { q } from "./db.js";
import { env } from "./env.js";

export type SecretDef = {
  name: string;      // імʼя змінної середовища - те саме, що в .env, щоб не було двох правд
  label: string;
  hint: string;
  group: "text" | "image" | "video" | "other";
  apply: (v: string) => void; // куди покласти значення в живому обʼєкті env
};

// Реєстр керованих ключів. Тут свідомо НЕ всі змінні середовища: пароль до БД, SESSION_SECRET
// і секрети OAuth-застосунків правляться разом із деплоєм і не мають сенсу в кабінеті.
export const SECRET_DEFS: SecretDef[] = [
  { name: "OPENAI_API_KEY", label: "OpenAI", group: "text", hint: "Генерація текстів (gpt-4o) напряму + зображення gpt-image-1.", apply: (v) => { env.openai.apiKey = v; } },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter", group: "text", hint: "Запасний маршрут до всіх моделей і каталог для порівняння.", apply: (v) => { env.openrouter.apiKey = v; } },
  { name: "GEMINI_API_KEY", label: "Google Gemini", group: "text", hint: "Дешеві службові кроки + зображення Nano Banana.", apply: (v) => { env.gemini.apiKey = v; } },
  { name: "FAL_KEY", label: "fal.ai (FLUX)", group: "image", hint: "Найдешевші зображення - FLUX schnell.", apply: (v) => { env.fal.apiKey = v; } },
  { name: "KIE_API_KEY", label: "kie.ai", group: "video", hint: "AI-відео для рілсів і доступ до свіжих моделей зображень. Ключ у кабінеті kie.ai.", apply: (v) => { env.kie.apiKey = v; } },
  { name: "AZURE_SPEECH_KEY", label: "Azure Speech", group: "video", hint: "Українська озвучка рілсів. Безкоштовного тарифу F0 вистачає.", apply: (v) => { env.azure.speechKey = v; } },
  { name: "DEEPGRAM_API_KEY", label: "Deepgram", group: "video", hint: "Розшифровка голосових у щоденник. Швидший і дешевший за Whisper; якщо не спрацює - автоматично піде Whisper.", apply: (v) => { env.deepgram.apiKey = v; } },
  { name: "PEXELS_API_KEY", label: "Pexels", group: "video", hint: "Безкоштовний стоковий b-roll для рілсів.", apply: (v) => { env.pexels.apiKey = v; } },
];

const DEF_BY_NAME = new Map(SECRET_DEFS.map((d) => [d.name, d]));
// Знімок того, що прийшло з `.env` НА СТАРТІ. Потрібен, щоб «видалити ключ з адмінки» вміло
// повернути початкове значення, а не залишити порожнечу.
const ENV_BASE = new Map(SECRET_DEFS.map((d) => [d.name, (process.env[d.name] ?? "").trim()]));

const overrides = new Map<string, string>();

function applyAll(): void {
  for (const d of SECRET_DEFS) d.apply(overrides.get(d.name) ?? ENV_BASE.get(d.name) ?? "");
}

/** Перечитати ключі з БД і накласти поверх `.env`. Викликається на старті і після кожного запису. */
export async function refreshSecrets(): Promise<void> {
  try {
    const rows = await q<{ name: string; value: string }>(`select name, value from app_secret`);
    overrides.clear();
    for (const r of rows) if (DEF_BY_NAME.has(r.name) && r.value.trim()) overrides.set(r.name, r.value.trim());
    applyAll();
  } catch (e: any) {
    // Таблиці ще нема (перший старт до міграції) - просто лишаємо .env.
    console.warn("[secrets] не вдалося прочитати app_secret:", String(e?.message || e).slice(0, 120));
  }
}

export async function setSecret(name: string, value: string, byEmail: string): Promise<void> {
  if (!DEF_BY_NAME.has(name)) throw new Error("невідомий ключ");
  const v = String(value || "").trim();
  if (v.length < 8) throw new Error("ключ виглядає надто коротким - перевір, чи скопіювався повністю");
  await q(`insert into app_secret(name, value, updated_by) values($1,$2,$3)
           on conflict (name) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`,
    [name, v, byEmail]);
  await refreshSecrets();
}

/** Прибрати значення з адмінки → повертається те, що в `.env` (може бути й порожнє). */
export async function clearSecret(name: string): Promise<void> {
  if (!DEF_BY_NAME.has(name)) throw new Error("невідомий ключ");
  await q(`delete from app_secret where name=$1`, [name]);
  await refreshSecrets();
}

export type SecretStatus = {
  name: string; label: string; hint: string; group: string;
  set: boolean; source: "admin" | "env" | "none"; tail: string; updatedAt?: string; updatedBy?: string;
};

/**
 * Один рядок статусу. Винесено окремою чистою функцією саме заради тесту: він стежить, щоб у
 * відповідь НІКОЛИ не потрапило саме значення ключа - це та помилка, яку легко зробити випадково
 * («додам value, щоб показати в полі») і неможливо помітити оком у зібраному JSON.
 */
export function statusRow(
  d: Pick<SecretDef, "name" | "label" | "hint" | "group">,
  adminValue: string, envValue: string,
  meta?: { updated_at?: string; updated_by?: string },
): SecretStatus {
  const admin = (adminValue || "").trim(), fromEnv = (envValue || "").trim();
  const eff = admin || fromEnv;
  return {
    name: d.name, label: d.label, hint: d.hint, group: d.group,
    set: !!eff,
    source: admin ? "admin" : fromEnv ? "env" : "none",
    tail: eff.length >= 4 ? eff.slice(-4) : "",  // коротший за 4 не показуємо взагалі
    updatedAt: meta?.updated_at, updatedBy: meta?.updated_by,
  };
}

/** Статус для адмінки. Значення не віддаємо - лише останні 4 символи для впізнавання. */
export async function secretStatuses(): Promise<SecretStatus[]> {
  const rows = await q<{ name: string; updated_at: string; updated_by: string }>(
    `select name, updated_at, updated_by from app_secret`).catch(() => []);
  const meta = new Map(rows.map((r) => [r.name, r]));
  return SECRET_DEFS.map((d) => statusRow(d, overrides.get(d.name) || "", ENV_BASE.get(d.name) || "", meta.get(d.name)));
}
