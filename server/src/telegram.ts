// Telegram Bot API — постинг у канал/групу (стандартне рішення, без SDK).
// Бот має бути доданий АДМІНОМ у канал/групу, щоб публікувати.
const BASE = "https://api.telegram.org";

async function tg<T = any>(token: string, method: string, body: Record<string, any> = {}): Promise<T> {
  if (!token) throw new Error("Telegram bot token не заданий");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(`${BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("Telegram timeout 15s");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const j: any = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description ? String(j.description) : `Telegram HTTP ${res.status}`);
  return j.result as T;
}

export const getMe = (token: string) => tg<{ id: number; username?: string; first_name?: string }>(token, "getMe");
export const getChat = (token: string, chatId: string) =>
  tg<{ id: number; title?: string; username?: string; type?: string }>(token, "getChat", { chat_id: chatId });
export const getChatMember = (token: string, chatId: string, userId: number) =>
  tg<{ status: string; can_post_messages?: boolean }>(token, "getChatMember", { chat_id: chatId, user_id: userId });
export const sendMessage = (token: string, chatId: string, text: string) =>
  tg<{ message_id: number }>(token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
