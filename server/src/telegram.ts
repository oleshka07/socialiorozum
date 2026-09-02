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
  if (!j.ok) throw new Error(humanTgError(res.status, j.description));
  return j.result as T;
}

// Помилки Bot API - людською. «Telegram HTTP 403» нічого не каже власнику каналу; Telegram у
// `description` завжди пояснює причину, і саме її треба перекласти в дію (LinkedIn і Meta вже мали
// такі тексти, Telegram - ні; спіймано аудитом).
export function humanTgError(status: number, description?: string): string {
  const d = String(description || "");
  if (/bot was blocked|bot was kicked|kicked from|not a member/i.test(d)) return "Бота видалили з каналу або заблокували - додай його адміном знову (Налаштування → Канали).";
  if (/not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|can't post/i.test(d)) return "Бот у каналі є, але без права публікувати - дай йому право «Публікувати повідомлення».";
  if (/chat not found|chat_id is empty|channel not found/i.test(d)) return "Канал не знайдено - перевір підключення каналу в Налаштування → Канали.";
  if (status === 401 || /Unauthorized/i.test(d)) return "Токен бота недійсний - перевипусти його в BotFather і встав у Налаштування → Канали.";
  if (status === 429 || /Too Many Requests|retry after/i.test(d)) return "Telegram просить зачекати (забагато повідомлень) - автопостер повторить сам.";
  if (/message is too long|caption is too long/i.test(d)) return "Текст задовгий для Telegram - скороти або дай сервісу підлаштувати під канал.";
  if (/wrong file identifier|failed to get HTTP URL content|WEBPAGE_MEDIA_EMPTY|IMAGE_PROCESS_FAILED/i.test(d)) return "Telegram не зміг завантажити зображення - спробуй інше фото або прибери його.";
  if (status === 403) return "Telegram відмовив у доступі (403): бот не адмін каналу або його видалили - перевір у Налаштування → Канали.";
  return d ? `Telegram: ${d.slice(0, 160)}` : `Telegram HTTP ${status}`;
}

export const getMe = (token: string) => tg<{ id: number; username?: string; first_name?: string }>(token, "getMe");
export const getChat = (token: string, chatId: string) =>
  tg<{ id: number; title?: string; username?: string; type?: string }>(token, "getChat", { chat_id: chatId });
export const getChatMember = (token: string, chatId: string, userId: number) =>
  tg<{ status: string; can_post_messages?: boolean }>(token, "getChatMember", { chat_id: chatId, user_id: userId });
// Розмітка постів (**жирний**, __курсив__, ~~закреслений~~, `код`) -> Telegram HTML.
// Решта тексту екранується, тому звичайний текст проходить без змін.
export function toTgHtml(text: string): string {
  let t = String(text ?? "");
  t = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  t = t.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, "<b>$1</b>");
  t = t.replace(/__([^_\n][\s\S]*?)__/g, "<i>$1</i>");
  t = t.replace(/(^|[\s(«"“])\*(?!\s)([^*\n]+?)\*(?=[\s.,!?;:)»"”]|$)/gm, "$1<b>$2</b>");
  t = t.replace(/(^|[\s(«"“])_(?!\s)([^_\n]+?)_(?=[\s.,!?;:)»"”]|$)/gm, "$1<i>$2</i>");
  t = t.replace(/~~([\s\S]+?)~~/g, "<s>$1</s>");
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return t;
}
// Inline-клавіатура: масив рядів кнопок {text, callback_data} | {text, url}
export type TgButton = { text: string; data?: string; url?: string };
const kb = (buttons?: TgButton[][]) =>
  buttons && buttons.length
    ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data || "" }))) } }
    : {};

// HTML-форматування з фолбеком: якщо Telegram не зміг розпарсити — шлемо простим текстом (публікація не падає).
export async function sendMessage(token: string, chatId: string, text: string, buttons?: TgButton[][]) {
  const extra = kb(buttons);
  try {
    return await tg<{ message_id: number }>(token, "sendMessage", { chat_id: chatId, text: toTgHtml(text), parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  } catch (e: any) {
    if (/parse entities|unsupported start tag|can't find end/i.test(String(e.message)))
      return tg<{ message_id: number }>(token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
    throw e;
  }
}
export async function deleteMessage(token: string, chatId: string, messageId: number): Promise<void> {
  try { await tg(token, "deleteMessage", { chat_id: chatId, message_id: messageId }); } catch { /* уже видалено/застаре — не критично */ }
}
export async function editMessageText(token: string, chatId: string, messageId: number, text: string, buttons?: TgButton[][]) {
  const extra = kb(buttons);
  try {
    return await tg(token, "editMessageText", { chat_id: chatId, message_id: messageId, text: toTgHtml(text), parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  } catch (e: any) {
    if (/parse entities|unsupported start tag|can't find end/i.test(String(e.message)))
      return tg(token, "editMessageText", { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true, ...extra });
    throw e;
  }
}
export async function answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void> {
  try { await tg(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }); } catch { /* не критично */ }
}
export async function sendPhoto(token: string, chatId: string, photoUrl: string, caption: string) {
  try {
    return await tg<{ message_id: number }>(token, "sendPhoto", { chat_id: chatId, photo: photoUrl, caption: toTgHtml(caption), parse_mode: "HTML" });
  } catch (e: any) {
    if (/parse entities|unsupported start tag|can't find end/i.test(String(e.message)))
      return tg<{ message_id: number }>(token, "sendPhoto", { chat_id: chatId, photo: photoUrl, caption });
    throw e;
  }
}
// завантажити файл, надісланий боту (голос/фото/відео щоденника). Bot API віддає файли до 20 МБ -
// на більших getFile повертає "file is too big" (обробляється у викликача дружнім повідомленням).
export async function getFileBuffer(token: string, fileId: string): Promise<{ buffer: Buffer; path: string }> {
  const f = await tg<{ file_path?: string }>(token, "getFile", { file_id: fileId });
  if (!f.file_path) throw new Error("файл недоступний");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`${BASE}/file/bot${token}/${f.file_path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`download ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), path: f.file_path };
  } finally { clearTimeout(timer); }
}
export const setWebhook = (token: string, url: string, secretToken?: string) =>
  tg(token, "setWebhook", { url, allowed_updates: ["message", "channel_post", "my_chat_member", "callback_query"], ...(secretToken ? { secret_token: secretToken } : {}) });

// ---- точки входу без слешів: постійна клавіатура, меню команд, кнопка Mini App ----
// Слеш-команди памʼятають одиниці; кнопка під полем вводу - те, що видно завжди.
export type TgKbButton = { text: string; web_app?: { url: string } };
export async function sendWithKeyboard(token: string, chatId: string, text: string, keyboard: TgKbButton[][]) {
  return tg<{ message_id: number }>(token, "sendMessage", {
    chat_id: chatId, text: toTgHtml(text), parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: { keyboard, resize_keyboard: true, is_persistent: true },
  });
}
// підказки в ☰ біля поля вводу
export async function setMyCommands(token: string, commands: Array<{ command: string; description: string }>): Promise<void> {
  try { await tg(token, "setMyCommands", { commands }); } catch { /* не критично: бот працює й без меню */ }
}
// кнопка ліворуч від поля вводу відкриває Mini App
export async function setChatMenuButton(token: string, url: string, text = "Кабінет"): Promise<void> {
  try { await tg(token, "setChatMenuButton", { menu_button: { type: "web_app", text, web_app: { url } } }); } catch { /* не критично */ }
}
