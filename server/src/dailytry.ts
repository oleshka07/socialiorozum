// ⏱ Щоденні задачі (зведення о 9:00, питання щоденника, щоденні тейки) після збою НЕ мають
// повторювати спробу на кожному тіку до кінця години. Так було: тейки падали щохвилини
// (60 спроб на день, 840 помилок у журналі за два тижні), зведення й щоденник - кожні 5 хв. Тепер:
// до 3 спроб на день із паузою 20 хв, а постійна відмова (бота заблокували, токен недійсний,
// чат не знайдено, на рахунку моделі нема грошей) - одразу до завтра.
const tries = new Map<string, { day: string; n: number; next: number }>();
const MAX_TRIES = 3, PAUSE_MS = 20 * 60_000;

export function canTry(key: string, day: string, now = Date.now()): boolean {
  const t = tries.get(key);
  return !t || t.day !== day || (t.n < MAX_TRIES && now >= t.next);
}

/** Зафіксувати збій; повертає true, якщо на сьогодні спроби вичерпано (варто сказати про це в журналі). */
export function failedTry(key: string, day: string, err: unknown, now = Date.now()): boolean {
  const t = tries.get(key);
  const n = permanentError(err) ? MAX_TRIES : (t && t.day === day ? t.n : 0) + 1;
  tries.set(key, { day, n, next: now + PAUSE_MS });
  return n >= MAX_TRIES;
}

export function succeededTry(key: string): void { tries.delete(key); }

// відмови, які за 20 хв самі не минуть: повторювати їх сьогодні - лише засмічувати журнал
export function permanentError(err: unknown): boolean {
  const m = String((err as any)?.message ?? err ?? "");
  return /заблокували|видалили|недійсн|не знайдено|Not Found|Unauthorized|Forbidden|can't initiate|chat not found|закінчились кошти|немає коштів|requires more credits|insufficient_quota|перевір ключ/i.test(m);
}
