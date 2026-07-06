// Спільний Telegram-бот: користувач підключає СВІЙ канал до нашого бота (без власного токена).
// Потік: кабінет дає deep-link t.me/<bot>?start=<code> -> юзер тисне Start -> бот просить
// додати його адміном у канал і переслати пост -> бот перевіряє права й зберігає канал у workspace.
import { randomBytes } from "node:crypto";
import { env } from "./env.js";
import { q, one } from "./db.js";
import * as tg from "./telegram.js";
import { logEvent } from "./log.js";
import { generatePostsOnePass, buildLiteSkeleton, rewritePost } from "./pipeline.js";
import { publishPostToChannels } from "./publisher.js";
import { sendDigestNow } from "./digest.js";

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

// ---- DM-асистент: власник, «живий меседж», банк ідей ----

// tg-користувач -> його воркспейс (для DM-асистента). Фолбек на tg_connect, якщо ще не закріплено.
async function ownerWorkspace(fromId: number): Promise<string | null> {
  const o = await one<{ workspace_id: string }>(`select workspace_id from tg_owner where tg_user_id=$1`, [fromId]);
  if (o) return o.workspace_id;
  const c = await one<{ workspace_id: string }>(`select workspace_id from tg_connect where tg_user_id=$1 order by created_at desc limit 1`, [fromId]);
  return c?.workspace_id ?? null;
}
async function setOwner(fromId: number, workspaceId: string, chatId: string): Promise<void> {
  await q(`insert into tg_owner(tg_user_id, workspace_id, chat_id) values($1,$2,$3)
           on conflict (tg_user_id) do update set workspace_id=excluded.workspace_id, chat_id=excluded.chat_id`, [fromId, workspaceId, chatId]);
}

// «один живий меседж на категорію»: гасить попереднє повідомлення категорії, шле нове, зберігає message_id.
export async function liveSend(workspaceId: string, chatId: string, category: string, text: string, buttons?: tg.TgButton[][]): Promise<void> {
  const token = env.telegram.botToken;
  const prev = await one<{ message_id: string }>(`select message_id from tg_message where workspace_id=$1 and category=$2`, [workspaceId, category]);
  if (prev?.message_id) await tg.deleteMessage(token, chatId, Number(prev.message_id));
  const r = await tg.sendMessage(token, chatId, text, buttons);
  await q(`insert into tg_message(workspace_id, category, chat_id, message_id, updated_at) values($1,$2,$3,$4,now())
           on conflict (workspace_id, category) do update set chat_id=excluded.chat_id, message_id=excluded.message_id, updated_at=now()`,
    [workspaceId, category, chatId, r.message_id]);
}

// ідея з банку -> чернетка поста (той самий шлях, що й /api/ideas/:id/post); повертає id+текст поста.
async function ideaToPost(workspaceId: string, ideaId: string): Promise<{ id: string | null; content: string }> {
  const it = await one<{ text: string }>(`select text from idea_bank where id=$1 and workspace_id=$2 and status <> 'archived'`, [ideaId, workspaceId]);
  if (!it) throw new Error("ідею не знайдено");
  const src = await one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,'idea',$2,$3) returning id`,
    [workspaceId, it.text.slice(0, 200), `Ідея поста: ${it.text}`]);
  const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
  await generatePostsOnePass(run!.id, 1, [it.text]);
  const post = await one<{ id: string; content: string }>(`select id, content from post where run_id=$1 and stage='final' limit 1`, [run!.id]);
  await q(`update idea_bank set status='used', used_post_id=$2 where id=$1`, [ideaId, post?.id ?? null]);
  return { id: post?.id ?? null, content: post?.content || "(порожньо)" };
}

// побудувати Lite-скелет плану (14 днів × 4/тиж) - той самий шлях, що й /api/plan/generate (lite)
async function buildPlan(workspaceId: string): Promise<number> {
  const slots = await buildLiteSkeleton(workspaceId, 14, 4);
  const anchor = new Date(); anchor.setUTCHours(12, 0, 0, 0);
  await q(`delete from plan_slot where workspace_id=$1 and status in ('empty','matched')`, [workspaceId]);
  let n = 0;
  for (const sl of slots) {
    const d = new Date(anchor); d.setUTCDate(d.getUTCDate() + sl.day);
    await q(`insert into plan_slot(workspace_id, slot_date, channel, rubric, theme, hook) values($1,$2,'all',$3,$4,$5)`,
      [workspaceId, d.toISOString().slice(0, 10), sl.rubric || null, sl.theme.slice(0, 300), sl.hook.slice(0, 300) || null]);
    n++;
  }
  return n;
}

// слот плану -> чернетка поста (той самий шлях, що й /api/plan/slots/:id/generate «з теми»)
async function slotToPost(workspaceId: string, slotId: string): Promise<{ id: string; content: string } | null> {
  const slot = await one<{ id: string; theme: string; hook: string | null; cta: string | null; rubric: string | null; channel: string; match_source_id: string | null }>(
    `select id, theme, hook, cta, rubric, channel, match_source_id from plan_slot where id=$1 and workspace_id=$2 and status in ('empty','matched')`, [slotId, workspaceId]);
  if (!slot) return null;
  let sourceId = slot.match_source_id;
  if (!sourceId) {
    const src = await one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,'plan',$2,$3) returning id`,
      [workspaceId, slot.theme.slice(0, 200), `Тема поста: ${slot.theme}${slot.hook ? `\nГачок: ${slot.hook}` : ""}${slot.cta ? `\nЗаклик: ${slot.cta}` : ""}`]);
    sourceId = src!.id;
  }
  const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [sourceId]);
  const idea = `${slot.theme}${slot.hook ? `. Гачок: ${slot.hook}` : ""}${slot.cta ? `. Заклик: ${slot.cta}` : ""}`;
  await generatePostsOnePass(run!.id, 1, [idea]);
  const post = await one<{ id: string; content: string }>(`select id, content from post where run_id=$1 and stage='final' limit 1`, [run!.id]);
  if (!post) return null;
  await q(`update post set rubric=coalesce($2, rubric), channels=coalesce(channels,'{}'::jsonb) || $3::jsonb where id=$1`,
    [post.id, slot.rubric, JSON.stringify({ [slot.channel]: { on: true } })]);
  await q(`update plan_slot set status='drafted', post_id=$2 where id=$1`, [slot.id, post.id]);
  return { id: post.id, content: post.content };
}

// зберегти надіслану думку як ідею (origin='bot') + підтвердження живим меседжем
async function captureIdea(workspaceId: string, chatId: string, text: string): Promise<void> {
  const r = await one<{ id: string }>(`insert into idea_bank(workspace_id, text, origin) values($1,$2,'bot') returning id`, [workspaceId, text.slice(0, 500)]);
  await liveSend(workspaceId, chatId, "capture",
    `💡 Збережено в Банк ідей:\n«${text.slice(0, 140)}»`,
    [[{ text: "✨ Зробити пост зараз", data: `idea_post:${r!.id}` }], [{ text: "📋 Усі ідеї", data: "idea_list" }]]);
}

// список банку ідей (живий меседж, category='idea_list')
async function sendIdeaList(workspaceId: string, chatId: string): Promise<void> {
  const rows = await q<{ id: string; text: string }>(`select id, text from idea_bank where workspace_id=$1 and status='new' order by created_at desc limit 8`, [workspaceId]);
  if (!rows.length) { await liveSend(workspaceId, chatId, "idea_list", "💡 Банк ідей порожній. Надішли мені будь-яку думку — і я збережу її як ідею."); return; }
  const buttons = rows.map((r) => [{ text: `✨ ${r.text.slice(0, 40)}`, data: `idea_post:${r.id}` }]);
  await liveSend(workspaceId, chatId, "idea_list", `💡 Твої ідеї (${rows.length}). Тапни, щоб зробити пост:`, buttons);
}

// обробка апдейту від Telegram (виклик із вебхука)
export async function handleUpdate(update: any): Promise<void> {
  const token = env.telegram.botToken; if (!token) return;
  try {
    if (update?.callback_query) { await handleCallback(update.callback_query); return; }
    const msg = update?.message; if (!msg || !msg.from) return;
    const fromId = msg.from.id; const chatId = String(msg.chat?.id ?? fromId); const text = String(msg.text || "").trim();

    // /start [code] — вітання + (за наявності коду) закріплення власника воркспейсу
    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1] || "";
      if (code) {
        const row = await one<{ workspace_id: string }>(`select workspace_id from tg_connect where code=$1`, [code]);
        if (row) {
          await q(`update tg_connect set tg_user_id=$2 where code=$1`, [code, fromId]);
          await setOwner(fromId, row.workspace_id, chatId);
          await tg.sendMessage(token, chatId, "Вітаю! 🤝 Я тепер твій контент-помічник.\n\n• Надішли будь-яку думку — збережу як ідею в Банк.\n• /idea — твої ідеї, зробити з них пост у 1 тап.\n\nЩоб публікувати у свій канал: додай мене АДМІНОМ у канал і перешли сюди будь-який пост із нього.");
          return;
        }
      }
      await tg.sendMessage(token, chatId, "Привіт! Щоб під'єднати мене до твого кабінету, відкрий посилання «Підключити наш бот» у socialio.");
      return;
    }

    // /idea — банк ідей
    if (text.toLowerCase().startsWith("/idea")) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio (кнопка «Підключити наш бот»)."); return; }
      await sendIdeaList(ws, chatId);
      return;
    }

    // /digest — надіслати ранкове зведення негайно (перевірка)
    if (text.toLowerCase().startsWith("/digest")) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio."); return; }
      await sendDigestNow(ws, chatId);
      return;
    }

    // переслали пост із каналу -> підключення каналу (як було)
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      await tg.sendMessage(token, chatId, await attachChannel(fromId, msg.forward_from_chat.id, msg.forward_from_chat.title));
      return;
    }
    // @username каналу -> підключення каналу; якщо не канал — впаде в захоплення ідеї
    if (text.startsWith("@")) {
      try { const chat = await tg.getChat(token, text); if (chat.type === "channel") { await tg.sendMessage(token, chatId, await attachChannel(fromId, chat.id, chat.title || text)); return; } } catch { /* не канал */ }
    }

    // будь-який інший текст -> ідея в Банк
    if (text && !text.startsWith("/")) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio (кнопка «Підключити наш бот»), тоді я збережу твої ідеї."); return; }
      await captureIdea(ws, chatId, text);
      return;
    }

    await tg.sendMessage(token, chatId, "Надішли думку — збережу як ідею 💡. /idea — твої ідеї.");
  } catch (e: any) { await logEvent("error", "tgbot", "update: " + e.message); }
}

// кнопки під згенерованою чернеткою в DM
const draftButtons = (postId: string): tg.TgButton[][] => [
  [{ text: "✅ Опублікувати в Telegram", data: `pub:${postId}` }],
  [{ text: "✍️ Переробити", data: `rw:${postId}` }, { text: "📋 Ще ідеї", data: "idea_list" }],
];

// натискання inline-кнопок
async function handleCallback(cbq: any): Promise<void> {
  const token = env.telegram.botToken;
  const fromId = cbq.from?.id; const chatId = String(cbq.message?.chat?.id ?? fromId); const data = String(cbq.data || "");
  const ws = await ownerWorkspace(fromId);
  if (!ws) { await tg.answerCallbackQuery(token, cbq.id, "Спершу під'єднай кабінет socialio"); return; }
  try {
    if (data === "idea_list") { await tg.answerCallbackQuery(token, cbq.id); await sendIdeaList(ws, chatId); return; }
    if (data.startsWith("slot_post:")) {
      await tg.answerCallbackQuery(token, cbq.id, "Генерую пост…");
      const p = await slotToPost(ws, data.slice("slot_post:".length));
      if (!p) { await tg.sendMessage(token, chatId, "Слот уже опрацьовано або не знайдено. /idea — інші ідеї."); return; }
      await tg.sendMessage(token, chatId, `✅ Чернетка готова:\n\n${p.content.slice(0, 3500)}\n\nОпублікувати, переробити чи докрутити в застосунку?`, draftButtons(p.id));
      return;
    }
    if (data === "plan_gen") {
      await tg.answerCallbackQuery(token, cbq.id, "Будую план…");
      try { const n = await buildPlan(ws); await tg.sendMessage(token, chatId, `📅 Готово: скелет плану на 2 тижні (${n} слотів). Заповнюй його ідеями — /idea, або відкрий застосунок.`); }
      catch (e: any) { await tg.sendMessage(token, chatId, "⚠️ " + String(e.message).slice(0, 200) + "\n(Спершу згенеруй стратегію в кабінеті: розділ Стратегія.)"); }
      return;
    }
    if (data.startsWith("idea_post:")) {
      await tg.answerCallbackQuery(token, cbq.id, "Генерую пост…");
      const p = await ideaToPost(ws, data.slice("idea_post:".length));
      await tg.sendMessage(token, chatId, `✅ Чернетка готова:\n\n${p.content.slice(0, 3500)}\n\nОпублікувати, переробити чи докрутити в застосунку (фото, час)?`, p.id ? draftButtons(p.id) : undefined);
      return;
    }
    if (data.startsWith("rw:")) {
      const postId = data.slice("rw:".length);
      await tg.answerCallbackQuery(token, cbq.id, "Переробляю…");
      const post = await one<{ content: string }>(
        `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
      if (!post) { await tg.sendMessage(token, chatId, "Пост не знайдено."); return; }
      const rewritten = await rewritePost(ws, post.content);
      await q(`update post set content=$2 where id=$1`, [postId, rewritten]);
      const mid = cbq.message?.message_id;
      const text = `✅ Оновлена чернетка:\n\n${rewritten.slice(0, 3500)}`;
      if (mid) await tg.editMessageText(token, chatId, mid, text, draftButtons(postId));
      else await tg.sendMessage(token, chatId, text, draftButtons(postId));
      return;
    }
    if (data.startsWith("pub:")) {
      const postId = data.slice("pub:".length);
      await tg.answerCallbackQuery(token, cbq.id, "Публікую…");
      await q(`update post set channels = coalesce(channels, '{}'::jsonb) || '{"telegram":{"on":true}}'::jsonb where id=$1`, [postId]);
      const results = await publishPostToChannels(ws, postId);
      const ok = results.filter((r) => r.status === "sent").map((r) => r.channel);
      const err = results.filter((r) => r.status === "error");
      if (ok.length) await tg.sendMessage(token, chatId, "✈️ Опубліковано: " + ok.join(", "));
      else await tg.sendMessage(token, chatId, "⚠️ Не вдалося: " + (err.map((e) => `${e.channel} — ${e.error}`).join("; ") || "немає підключеного каналу") + ".\nПідключи канал: додай мене АДМІНОМ у свій канал і перешли сюди пост із нього.");
      return;
    }
    await tg.answerCallbackQuery(token, cbq.id);
  } catch (e: any) {
    await tg.answerCallbackQuery(token, cbq.id, "Помилка: " + String(e.message).slice(0, 150));
    await logEvent("error", "tgbot", "callback: " + e.message);
  }
}
