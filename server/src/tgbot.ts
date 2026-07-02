// Спільний Telegram-бот: користувач підключає СВІЙ канал до нашого бота (без власного токена).
// Потік: кабінет дає deep-link t.me/<bot>?start=<code> -> юзер тисне Start -> бот просить
// додати його адміном у канал і переслати пост -> бот перевіряє права й зберігає канал у workspace.
import { randomBytes } from "node:crypto";
import { env } from "./env.js";
import { q, one } from "./db.js";
import * as tg from "./telegram.js";
import { logEvent } from "./log.js";

let BOT_ID = 0;
let BOT_USERNAME = env.telegram.botUsername;

export const botEnabled = (): boolean => !!env.telegram.botToken;
export const botUsername = (): string => BOT_USERNAME;

export async function initTelegramBot(): Promise<void> {
  if (!env.telegram.botToken) { console.log("[tgbot] TELEGRAM_BOT_TOKEN не заданий - спільний бот вимкнено"); return; }
  try {
    const me = await tg.getMe(env.telegram.botToken);
    BOT_ID = me.id; if (me.username) BOT_USERNAME = me.username;
    const url = `${env.appBaseUrl}/api/webhooks/telegram/${env.telegram.webhookSecret}`;
    await tg.setWebhook(env.telegram.botToken, url, env.telegram.webhookSecret);
    console.log(`[tgbot] спільний бот @${BOT_USERNAME} (id ${BOT_ID}); webhook → ${url}`);
  } catch (e: any) { console.error("[tgbot] init: " + e.message); }
}

export async function createConnectLink(workspaceId: string): Promise<string> {
  if (!env.telegram.botToken) throw new Error("Спільний бот не налаштований на сервері");
  const code = randomBytes(8).toString("hex");
  await q(`delete from tg_connect where workspace_id=$1`, [workspaceId]); // один активний код на воркспейс
  await q(`insert into tg_connect(code, workspace_id) values($1,$2)`, [code, workspaceId]);
  return `https://t.me/${BOT_USERNAME}?start=${code}`;
}

async function attachChannel(fromId: number, chatId: number, title: string): Promise<string> {
  const row = await one<{ workspace_id: string }>(`select workspace_id from tg_connect where tg_user_id=$1 order by created_at desc limit 1`, [fromId]);
  if (!row) return "Спершу відкрий посилання підключення з кабінету socialio (кнопка «Підключити наш бот»).";
  let member: { status: string };
  try { member = await tg.getChatMember(env.telegram.botToken, String(chatId), BOT_ID); }
  catch { return "Не бачу цього каналу. Додай мене адміном у канал і спробуй ще раз."; }
  if (!["administrator", "creator"].includes(member.status)) return "Додай мене АДМІНОМ у канал (з правом публікувати), тоді перешли пост ще раз.";
  await q(`insert into telegram_config(workspace_id, bot_token, channel_chat_id, channel_title, updated_at)
           values($1,$2,$3,$4,now())
           on conflict (workspace_id) do update set bot_token=excluded.bot_token, channel_chat_id=excluded.channel_chat_id, channel_title=excluded.channel_title, updated_at=now()`,
    [row.workspace_id, env.telegram.botToken, String(chatId), title || null]);
  await q(`delete from tg_connect where workspace_id=$1`, [row.workspace_id]);
  await logEvent("info", "tgbot", `канал підключено: ${title || chatId}`);
  return `✅ Канал «${title || chatId}» підключено! Пости з кабінету тепер публікуватимуться сюди.`;
}

// обробка апдейту від Telegram (виклик із вебхука)
export async function handleUpdate(update: any): Promise<void> {
  const token = env.telegram.botToken; if (!token) return;
  const msg = update?.message; if (!msg || !msg.from) return;
  const fromId = msg.from.id; const text = String(msg.text || "").trim();
  try {
    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1] || "";
      if (code) {
        const row = await one<{ workspace_id: string }>(`select workspace_id from tg_connect where code=$1`, [code]);
        if (row) {
          await q(`update tg_connect set tg_user_id=$2 where code=$1`, [code, fromId]);
          await tg.sendMessage(token, String(fromId), "Вітаю! 🤝 Підключимо твій канал:\n1) Додай мене АДМІНОМ у свій канал (з правом публікувати).\n2) Перешли сюди будь-який пост із цього каналу (або надішли його @username).");
          return;
        }
      }
      await tg.sendMessage(token, String(fromId), "Привіт! Щоб підключити канал, відкрий посилання з кабінету socialio (кнопка «Підключити наш бот»).");
      return;
    }
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      await tg.sendMessage(token, String(fromId), await attachChannel(fromId, msg.forward_from_chat.id, msg.forward_from_chat.title));
      return;
    }
    if (text.startsWith("@")) {
      let chat: { id: number; title?: string; type?: string };
      try { chat = await tg.getChat(token, text); } catch { await tg.sendMessage(token, String(fromId), "Не знайшов такий канал. Краще перешли пост із каналу."); return; }
      if (chat.type === "channel") await tg.sendMessage(token, String(fromId), await attachChannel(fromId, chat.id, chat.title || text));
      else await tg.sendMessage(token, String(fromId), "Це не канал. Перешли пост із свого каналу.");
      return;
    }
    await tg.sendMessage(token, String(fromId), "Перешли мені пост із свого каналу (я маю бути там адміном), щоб його підключити.");
  } catch (e: any) { await logEvent("error", "tgbot", "update: " + e.message); }
}
