// 🔐 Автентифікація Telegram Mini App.
//
// Mini App відкривається ВСЕРЕДИНІ Telegram і не має нашої кукі-сесії. Замість логіну Telegram
// передає у сторінку `initData` - підписаний рядок із даними користувача. Ми перевіряємо підпис
// секретом, виведеним із токена бота: підробити його, не знаючи токена, неможливо.
//
// Алгоритм (документація Telegram, Validating data received via the Mini App):
//   secret_key       = HMAC_SHA256(key="WebAppData", data=<bot_token>)
//   data_check_string = усі пари "k=v", КРІМ hash, відсортовані за k і зʼєднані через \n
//   валідно, якщо HMAC_SHA256(key=secret_key, data=data_check_string) == hash
//
// ⚠️ Порядок і склад пар критичні: зайве поле або несортований порядок дають інший хеш, і тоді
// або все відвалюється, або (гірше) хтось підбирає обхід. Тому це окремий модуль під юнітами.
import { createHmac, timingSafeEqual } from "node:crypto";

export type TgInitUser = { id: number; username?: string; first_name?: string };

// Термін придатності: підписаний initData не протухає сам по собі, тож обмежуємо вручну -
// інакше перехоплений колись рядок працював би вічно.
const MAX_AGE_SEC = 24 * 60 * 60;

export function verifyInitData(initData: string, botToken: string, maxAgeSec = MAX_AGE_SEC, nowMs = Date.now()): TgInitUser | null {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;

  const pairs: string[] = [];
  // Виключається ЛИШЕ `hash`. Поле `signature` (Ed25519 для сторонньої перевірки) Telegram
  // включає у власний підрахунок, тож викинути його = зламати перевірку на реальних даних.
  params.forEach((v, k) => { if (k !== "hash") pairs.push(`${k}=${v}`); });
  pairs.sort();
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");

  const a = Buffer.from(calc, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || (nowMs / 1000 - authDate) > maxAgeSec) return null; // застарілий підпис

  try {
    const u = JSON.parse(params.get("user") || "null");
    if (!u || typeof u.id !== "number") return null;
    return { id: u.id, username: u.username, first_name: u.first_name };
  } catch { return null; }
}
