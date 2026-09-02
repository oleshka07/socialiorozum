// Спільний Telegram-бот: користувач підключає СВІЙ канал до нашого бота (без власного токена).
// Потік: кабінет дає deep-link t.me/<bot>?start=<code> -> юзер тисне Start -> бот просить
// додати його адміном у канал і переслати пост -> бот перевіряє права й зберігає канал у workspace.
import { randomBytes } from "node:crypto";
import { env } from "./env.js";
import { q, one } from "./db.js";
import * as tg from "./telegram.js";
import { logEvent } from "./log.js";
import { generatePostsOnePass, buildLiteSkeleton, rewritePost, suggestDevelopment, reelsScript, sliceToReels, extractIdeasFromText, repeatVariant, generateThreadsTakes } from "./pipeline.js";
import { publishPostToChannels } from "./publisher.js";
import { sendDigestNow } from "./digest.js";
import { isDiaryPending, appendDiaryText, attachDiaryMedia, attachMediaToEntry, diaryPhotoTarget, transcribeVoice, skipDiaryToday, sendDiaryNow, weekDiaryText } from "./diary.js";
import { cabinetPostLink } from "./permalink.js";
import * as cmp from "./tgcompose.js";
import { looksLikeReadyPost } from "./textkind.js";
const postDeepLink = (postId: string) => cabinetPostLink(env.appBaseUrl, postId);

let BOT_ID = 0;
let BOT_USERNAME = env.telegram.botUsername;

export const botEnabled = (): boolean => !!env.telegram.botToken;
export const botUsername = (): string => BOT_USERNAME;

// Токен бота для ПРОАКТИВНИХ повідомлень воркспейсу (дайджест/щоденник/живі меседжі):
// власний бот воркспейсу (введений у Налаштуваннях), якщо він відрізняється від спільного; інакше спільний.
export async function wsBotToken(workspaceId: string): Promise<string> {
  const r = await one<{ bot_token: string | null }>(`select bot_token from telegram_config where workspace_id=$1`, [workspaceId]);
  return (r?.bot_token && r.bot_token !== env.telegram.botToken) ? r.bot_token : env.telegram.botToken;
}

// Власний бот воркспейсу отримує СВІЙ вебхук → усі DM-фічі (щоденник, дайджест, ідеї) працюють
// через нього, а не лише публікація. У вебхук-URL кладемо id бота (?bot=), щоб роут знав, чиїм
// токеном відповідати. Повертає username бота для підказки в UI.
export async function registerOwnBotWebhook(token: string): Promise<string> {
  const me = await tg.getMe(token);
  const url = `${env.appBaseUrl}/api/webhooks/telegram/${env.telegram.webhookSecret}?bot=${me.id}`;
  await tg.setWebhook(token, url, env.telegram.webhookSecret);
  return me.username || String(me.id);
}

export async function initTelegramBot(): Promise<void> {
  if (!env.telegram.botToken) { console.log("[tgbot] TELEGRAM_BOT_TOKEN не заданий - спільний бот вимкнено"); return; }
  try {
    const me = await tg.getMe(env.telegram.botToken);
    BOT_ID = me.id; if (me.username) BOT_USERNAME = me.username;
    if (env.beta.telegramWebhookOff) {
      // БЕТА зі спільним прод-токеном: webhook НЕ чіпаємо, інакше вкрадемо його в прода.
      // Публікація в канали з бети працює (прямі API-виклики); DM-фічі бота обробляє прод.
      console.log(`[tgbot] бот @${BOT_USERNAME} (id ${BOT_ID}); TELEGRAM_WEBHOOK_OFF=1 → webhook лишається за продом`);
      return;
    }
    const url = `${env.appBaseUrl}/api/webhooks/telegram/${env.telegram.webhookSecret}`;
    await tg.setWebhook(env.telegram.botToken, url, env.telegram.webhookSecret);
    await registerMenu(env.telegram.botToken);
    console.log(`[tgbot] спільний бот @${BOT_USERNAME} (id ${BOT_ID}); webhook → ${url}`);
  } catch (e: any) { console.error("[tgbot] init: " + e.message); }
}

export async function createConnectLink(workspaceId: string): Promise<string> {
  const token = await wsBotToken(workspaceId);
  if (!token) throw new Error("Спільний бот не налаштований на сервері");
  // deep-link веде на бота, який реально обслуговує цей воркспейс (власний або спільний)
  let username = BOT_USERNAME;
  if (token !== env.telegram.botToken) { try { username = (await tg.getMe(token)).username || username; } catch { /* фолбек на спільного */ } }
  const code = randomBytes(8).toString("hex");
  await q(`delete from tg_connect where workspace_id=$1`, [workspaceId]); // один активний код на воркспейс
  await q(`insert into tg_connect(code, workspace_id) values($1,$2)`, [code, workspaceId]);
  return `https://t.me/${username}?start=${code}`;
}

async function attachChannel(fromId: number, chatId: number, title: string, token: string): Promise<string> {
  const row = await one<{ workspace_id: string }>(`select workspace_id from tg_connect where tg_user_id=$1 order by created_at desc limit 1`, [fromId]);
  if (!row) return "Спершу відкрий посилання підключення з кабінету socialio (кнопка «Підключити наш бот»).";
  // перевіряємо членство ТИМ ботом, якому переслали пост (власний або спільний); id бота = префікс токена
  const botId = Number(token.split(":")[0]) || BOT_ID;
  let member: { status: string };
  try { member = await tg.getChatMember(token, String(chatId), botId); }
  catch { return "Не бачу цього каналу. Додай мене адміном у канал і спробуй ще раз."; }
  if (!["administrator", "creator"].includes(member.status)) return "Додай мене АДМІНОМ у канал (з правом публікувати), тоді перешли пост ще раз.";
  await q(`insert into telegram_config(workspace_id, bot_token, channel_chat_id, channel_title, updated_at)
           values($1,$2,$3,$4,now())
           on conflict (workspace_id) do update set bot_token=excluded.bot_token, channel_chat_id=excluded.channel_chat_id, channel_title=excluded.channel_title, updated_at=now()`,
    [row.workspace_id, token, String(chatId), title || null]);
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
  const token = await wsBotToken(workspaceId); // власний бот воркспейсу, якщо задано
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
  await generatePostsOnePass(run!.id, 1, [idea], undefined, { channels: slot.channel && slot.channel !== "all" ? [slot.channel] : [] });
  const post = await one<{ id: string; content: string }>(`select id, content from post where run_id=$1 and stage='final' limit 1`, [run!.id]);
  if (!post) return null;
  await q(`update post set rubric=coalesce($2, rubric), channels=coalesce(channels,'{}'::jsonb) || $3::jsonb where id=$1`,
    [post.id, slot.rubric, JSON.stringify({ [slot.channel]: { on: true } })]);
  await q(`update plan_slot set status='drafted', post_id=$2 where id=$1`, [slot.id, post.id]);
  return { id: post.id, content: post.content };
}

// зберегти надіслану думку як ідею (origin='bot') + підтвердження живим меседжем
async function captureIdea(workspaceId: string, chatId: string, text: string): Promise<void> {
  // 500 символів обрізали готовий пост тестера посередині - тепер уміщається повний текст.
  const r = await one<{ id: string }>(`insert into idea_bank(workspace_id, text, origin) values($1,$2,'bot') returning id`, [workspaceId, text.slice(0, 3000)]);
  // «📝 Опублікувати як є» = взяти текст ДОСЛІВНО й одразу відкрити композер (канали/фото/час);
  // «✨ Переписати AI» = AI зробить пост із думки. Дві різні наміри - дві різні кнопки, і ПЕРШОЮ стоїть
  // та, що відповідає тексту: готовий пост → «як є» (фідбек тестера: «написав одне - опублікувалось інше»
  // це якраз натиснута верхня кнопка AI на готовому тексті), коротка думка → AI.
  const ready = looksLikeReadyPost(text);
  const raw = { text: "📝 Опублікувати як є (мій текст без змін)", data: `idea_raw:${r!.id}` };
  const ai = { text: ready ? "✨ Переписати AI (зміст збережу)" : "✨ Зробити пост з думки (AI)", data: `idea_post:${r!.id}` };
  await liveSend(workspaceId, chatId, "capture",
    (ready ? `📝 Схоже на готовий пост. Зберіг у Банк ідей:\n«${text.slice(0, 140)}…»\n\nОпублікувати як є - текст піде без змін.`
           : `💡 Збережено в Банк ідей:\n«${text.slice(0, 140)}»`),
    ready ? [[raw], [ai], [{ text: "📋 Усі ідеї", data: "idea_list" }]]
          : [[ai], [raw], [{ text: "📋 Усі ідеї", data: "idea_list" }]]);
}

// список банку ідей (живий меседж, category='idea_list')
async function sendIdeaList(workspaceId: string, chatId: string): Promise<void> {
  const rows = await q<{ id: string; text: string }>(`select id, text from idea_bank where workspace_id=$1 and status='new' order by created_at desc limit 8`, [workspaceId]);
  if (!rows.length) { await liveSend(workspaceId, chatId, "idea_list", "💡 Банк ідей порожній. Надішли мені будь-яку думку — і я збережу її як ідею."); return; }
  const buttons = rows.map((r) => [{ text: `✨ ${r.text.slice(0, 40)}`, data: `idea_post:${r.id}` }]);
  await liveSend(workspaceId, chatId, "idea_list", `💡 Твої ідеї (${rows.length}). Тапни, щоб зробити пост:`, buttons);
}

// обробка апдейту від Telegram (виклик із вебхука); tokenOverride = власний бот воркспейсу (?bot= у URL)
// ---- точки входу без слешів ----
// TG_MENU: підказки в ☰; кнопка ліворуч від поля вводу відкриває Mini App; постійна клавіатура
// дублює найчастіші дії текстом (натиснув - Telegram надіслав саме цей рядок, ми його роутимо).
const MINIAPP_URL = `${env.appBaseUrl}/tgapp`;
const KB_NEW = "✍️ Новий пост", KB_APP = "🚀 Кабінет", KB_IDEAS = "💡 Ідеї", KB_DIARY = "📔 Щоденник", KB_PLAN = "📅 План", KB_DIGEST = "☀️ Зведення";
async function registerMenu(token: string): Promise<void> {
  await tg.setMyCommands(token, [
    { command: "post", description: "Новий пост: текст, фото, канали, публікація" },
    { command: "plan", description: "Що заплановано найближчим часом" },
    { command: "idea", description: "Банк ідей" },
    { command: "diary", description: "Записати в щоденник" },
    { command: "digest", description: "Зведення дня" },
  ]);
  await tg.setChatMenuButton(token, MINIAPP_URL, "Кабінет");
}
const mainKeyboard = (): tg.TgKbButton[][] => [
  [{ text: KB_NEW }, { text: KB_APP, web_app: { url: MINIAPP_URL } }],
  [{ text: KB_PLAN }, { text: KB_IDEAS }, { text: KB_DIARY }, { text: KB_DIGEST }],
];

// 📅 Що заплановано. Запланувати з бота було можна ще раніше, а ПОБАЧИТИ чергу - ніде: людина
// не пам'ятала, що вже стоїть у розкладі, і планувала двічі або не планувала зовсім.
async function sendPlan(ws: string, chatId: string): Promise<void> {
  const rows = await q<{ post_id: string; scheduled_at: string; content: string; channels: any }>(
    `select ss.post_id, ss.scheduled_at, p.content, coalesce(ss.channels, p.channels) as channels
       from schedule_slot ss join post p on p.id=ss.post_id
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and ss.status='planned' and ss.scheduled_at > now()
     order by ss.scheduled_at limit 8`, [ws]);
  if (!rows.length) {
    await liveSend(ws, chatId, "plan", "📅 Нічого не заплановано.\n\nВідкрий чернетку (/post або «📝 Пости» в застосунку) і натисни «🗓 Запланувати».");
    return;
  }
  const tzRow = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [ws]);
  const tz = tzRow?.content || "Europe/Kyiv";
  const fmt = new Intl.DateTimeFormat("uk-UA", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const lines = rows.map((r) => {
    const nets = Object.keys(r.channels || {}).filter((k) => r.channels[k] && r.channels[k].on);
    const head = r.content.split("\n").find(Boolean) || "";
    return `🗓 <b>${fmt.format(new Date(r.scheduled_at))}</b> · ${nets.join(", ") || "без каналів"}\n${escHtml(head.slice(0, 90))}`;
  });
  // кнопка веде в композер того самого поста - звідти можна перенести час або опублікувати одразу
  const buttons = rows.slice(0, 4).map((r) => [{ text: `✍ ${fmt.format(new Date(r.scheduled_at))}`, data: `cc:${r.post_id}` }]);
  await liveSend(ws, chatId, "plan", `📅 <b>Найближчі публікації</b>\n\n${lines.join("\n\n")}`, buttons);
}
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function handleUpdate(update: any, tokenOverride?: string): Promise<void> {
  const token = tokenOverride || env.telegram.botToken; if (!token) return;
  try {
    if (update?.callback_query) { await handleCallback(update.callback_query, token); return; }
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
          await tg.sendWithKeyboard(token, chatId, "Вітаю! 🤝 Я тепер твій контент-помічник.\n\n• Надішли будь-яку думку — збережу як ідею в Банк.\n• /idea — твої ідеї, зробити з них пост у 1 тап.\n• /post — написати пост прямо тут: текст, фото, канали, публікація зараз або за розкладом.\n• 📔 Двічі на день спитаю, що відбувалося: відповідай текстом, ГОЛОСОМ, фото чи відео — усе ляже в щоденник і стане живим джерелом постів. /diary — спитати зараз.\n\nЩоб публікувати у свій канал: додай мене АДМІНОМ у канал і перешли сюди будь-який пост із нього.", mainKeyboard());
          await registerMenu(token);
          return;
        }
      }
      await tg.sendMessage(token, chatId, "Привіт! Щоб під'єднати мене до твого кабінету, відкрий посилання «Підключити наш бот» у socialio.");
      return;
    }

    // кнопки постійної клавіатури приходять звичайним текстом - зводимо їх до тих самих дій
    if (text === KB_NEW || text === KB_IDEAS || text === KB_DIARY || text === KB_PLAN || text === KB_DIGEST) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio."); return; }
      if (text === KB_IDEAS) { await sendIdeaList(ws, chatId); return; }
      if (text === KB_DIARY) { await sendDiaryNow(ws, chatId); return; }
      if (text === KB_PLAN)  { await sendPlan(ws, chatId); return; }
      if (text === KB_DIGEST) { await sendDigestNow(ws, chatId); return; }
      await cmp.expect(ws, "", "text", chatId);
      await tg.sendMessage(token, chatId, "📝 Надішли текст поста наступним повідомленням.");
      return;
    }

    // 📝 /post [текст] — написати пост прямо з телефона: текст → фото → канали → публікація
    if (text.toLowerCase().startsWith("/post")) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio."); return; }
      const body = text.slice(5).trim();
      if (!body) { await cmp.expect(ws, "", "text", chatId); await tg.sendMessage(token, chatId, "📝 Надішли текст поста наступним повідомленням."); return; }
      await openCompose(ws, chatId, await cmp.createBotDraft(ws, body), token);
      return;
    }

    // /menu — повернути кнопки (якщо юзер їх колись сховав)
    if (text.toLowerCase().startsWith("/menu")) {
      await registerMenu(token);
      await tg.sendWithKeyboard(token, chatId, "Кнопки на місці 👇", mainKeyboard());
      return;
    }

    // /idea — банк ідей
    if (text.toLowerCase().startsWith("/idea")) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio (кнопка «Підключити наш бот»)."); return; }
      await sendIdeaList(ws, chatId);
      return;
    }

    // /plan — черга публікацій (запланувати з бота можна було й раніше, побачити чергу - ніде)
    if (text.toLowerCase().startsWith("/plan")) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio."); return; }
      await sendPlan(ws, chatId);
      return;
    }

    // /digest — надіслати ранкове зведення негайно (перевірка)
    if (text.toLowerCase().startsWith("/digest")) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio."); return; }
      await sendDigestNow(ws, chatId);
      return;
    }

    // /diary — питання щоденника негайно (перевірка без очікування 13:00/20:00)
    if (text.toLowerCase().startsWith("/diary")) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio."); return; }
      await sendDiaryNow(ws, chatId);
      return;
    }

    // 📝 якщо композер чекає на конкретну відповідь (текст/фото/дату) - вона має пріоритет над
    // щоденником і банком ідей: людина щойно натиснула кнопку й відповідає саме на неї
    {
      const wsC = await ownerWorkspace(fromId);
      if (wsC) {
        const st = await cmp.getCompose(wsC);
        if (st.await && await composeReply(wsC, chatId, msg, st, token)) return;
      }
    }

    // 🎙 голосове → Whisper → запис у щоденник (голос = завжди щоденник: надиктовані історії дня)
    if (msg.voice?.file_id) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio."); return; }
      try {
        const f = await tg.getFileBuffer(token, msg.voice.file_id);
        const heard = await transcribeVoice(f.buffer, "voice.ogg");
        await appendDiaryText(ws, chatId, heard, true);
      } catch (e: any) { await tg.sendMessage(token, chatId, "⚠️ " + String(e.message).slice(0, 200)); }
      return;
    }

    // 📎 фото/відео → галерея з міткою «щоденник» + привʼязка до запису дня
    const media = msg.photo?.length ? { fileId: msg.photo[msg.photo.length - 1].file_id, mime: "image/jpeg", name: "diary.jpg", size: msg.photo[msg.photo.length - 1].file_size }
      : msg.video?.file_id ? { fileId: msg.video.file_id, mime: msg.video.mime_type || "video/mp4", name: "diary.mp4", size: msg.video.file_size }
      : msg.video_note?.file_id ? { fileId: msg.video_note.file_id, mime: "video/mp4", name: "diary-note.mp4", size: msg.video_note.file_size }
      : null;
    if (media) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio."); return; }
      if ((media.size || 0) > 19.5 * 1024 * 1024) { await tg.sendMessage(token, chatId, "⚠️ Telegram віддає ботам файли лише до 20 МБ. Закороти відео або завантаж його через застосунок (Матеріали → медіа)."); return; }
      try {
        const buf = (await tg.getFileBuffer(token, media.fileId)).buffer;
        // якщо щойно був запис (голос чи текст) - фото ПРОДОВЖУЄ саме його, а не заводить окремий
        // матеріал: історія і кадр про ту саму подію мають доїхати в генерацію разом
        const target = await diaryPhotoTarget(ws);
        if (target) await attachMediaToEntry(ws, chatId, target, buf, media.mime, media.name, msg.caption);
        else await attachDiaryMedia(ws, chatId, buf, media.mime, media.name, msg.caption);
      }
      catch (e: any) {
        const friendly = /too big/i.test(String(e.message)) ? "файл понад 20 МБ - Telegram не віддає його ботам. Закороти відео або завантаж через застосунок." : String(e.message).slice(0, 200);
        await tg.sendMessage(token, chatId, "⚠️ " + friendly);
      }
      return;
    }

    // переслали пост із каналу -> підключення каналу (як було)
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      await tg.sendMessage(token, chatId, await attachChannel(fromId, msg.forward_from_chat.id, msg.forward_from_chat.title, token));
      return;
    }
    // @username каналу -> підключення каналу; якщо не канал — впаде в захоплення ідеї
    if (text.startsWith("@")) {
      try { const chat = await tg.getChat(token, text); if (chat.type === "channel") { await tg.sendMessage(token, chatId, await attachChannel(fromId, chat.id, chat.title || text, token)); return; } } catch { /* не канал */ }
    }

    // будь-який інший текст: відповідь на відкрите питання щоденника → запис дня; інакше → ідея в Банк
    if (text && !text.startsWith("/")) {
      const ws = await ownerWorkspace(fromId);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету socialio (кнопка «Підключити наш бот»), тоді я збережу твої ідеї."); return; }
      if (await isDiaryPending(ws)) { await appendDiaryText(ws, chatId, text); return; }
      await captureIdea(ws, chatId, text);
      return;
    }

    await tg.sendMessage(token, chatId, "Надішли думку — збережу як ідею 💡. /idea — твої ідеї, /diary — запис у щоденник.");
  } catch (e: any) { await logEvent("error", "tgbot", "update: " + e.message); }
}

// ---- 📝 композер у Telegram ----
// Картка поста живе «одним живим меседжем» (liveSend category='compose'): кожна дія оновлює ту саму
// картку, а не плодить нові - інакше після п'яти натискань чат перетворюється на стрічку копій.
async function openCompose(ws: string, chatId: string, postId: string, token: string): Promise<void> {
  const card = await cmp.composeCard(ws, postId);
  if (!card) { await tg.sendMessage(token, chatId, "Пост не знайдено."); return; }
  await cmp.expect(ws, postId, null, chatId);
  await liveSend(ws, chatId, "compose", card.text, [...card.buttons, [{ text: "🌐 Відкрити в кабінеті", url: postDeepLink(postId) }]]);
}

// відповідь на те, чого композер зараз чекає; true = повідомлення оброблено
async function composeReply(ws: string, chatId: string, msg: any, st: { postId: string | null; await: string | null }, token: string): Promise<boolean> {
  const text = String(msg.text || "").trim();
  if (st.await === "photo") {
    const ph = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
    if (!ph) return false;                       // прислали не фото - хай іде звичайним шляхом
    if ((ph.file_size || 0) > 19.5 * 1024 * 1024) { await tg.sendMessage(token, chatId, "⚠️ Файл понад 20 МБ - Telegram не віддає такі ботам."); return true; }
    const f = await tg.getFileBuffer(token, ph.file_id);
    await cmp.attachPhoto(ws, st.postId!, f.buffer, "image/jpeg", "tg-post.jpg");
    await openCompose(ws, chatId, st.postId!, token);
    return true;
  }
  if (!text) return false;
  if (st.await === "text") {
    // порожній postId = це перший текст після «/post» → створюємо чернетку
    const id = st.postId || await cmp.createBotDraft(ws, text);
    if (st.postId) await cmp.setText(ws, st.postId, text);
    await openCompose(ws, chatId, id, token);
    return true;
  }
  if (st.await === "rewrite") {
    await tg.sendMessage(token, chatId, "🤖 Переписую…");
    try { await cmp.aiRewrite(ws, st.postId!, text === "-" ? undefined : text); }
    catch (e: any) { await tg.sendMessage(token, chatId, "⚠️ " + String(e.message).slice(0, 200)); }
    await openCompose(ws, chatId, st.postId!, token);
    return true;
  }
  if (st.await === "when") {
    const at = await cmp.parseWhen(ws, text);
    if (!at) { await tg.sendMessage(token, chatId, "Не зрозумів дату. Приклади: «01.08 14:30», «завтра 09:00», «2026-08-01 18:00»."); return true; }
    await tg.sendMessage(token, chatId, await cmp.schedule(ws, st.postId!, at));
    await openCompose(ws, chatId, st.postId!, token);
    return true;
  }
  return false;
}

// кнопки під згенерованою чернеткою в DM
// композер: усі гілки під одним префіксом `c*`, щоб не плутати зі старими pub:/rw:
async function composeCallback(ws: string, chatId: string, data: string, cbq: any, token: string): Promise<boolean> {
  const [head, postId, arg] = data.split(":");
  if (!postId || !/^c/.test(head)) return false;
  switch (head) {
    case "cc":  await tg.answerCallbackQuery(token, cbq.id); await openCompose(ws, chatId, postId, token); return true;
    case "cn":  await cmp.toggleNet(ws, postId, arg); await tg.answerCallbackQuery(token, cbq.id); await openCompose(ws, chatId, postId, token); return true;
    case "cp":  await cmp.expect(ws, postId, "photo", chatId); await tg.answerCallbackQuery(token, cbq.id, "Надішли фото"); await tg.sendMessage(token, chatId, "🖼 Надішли фото наступним повідомленням."); return true;
    case "ce":  await cmp.expect(ws, postId, "text", chatId);  await tg.answerCallbackQuery(token, cbq.id, "Надішли новий текст"); await tg.sendMessage(token, chatId, "✍ Надішли новий текст поста."); return true;
    case "cr":  await cmp.expect(ws, postId, "rewrite", chatId); await tg.answerCallbackQuery(token, cbq.id); await tg.sendMessage(token, chatId, "🤖 Що саме змінити? Напиши побажання (або «-», щоб просто переписати іншими словами)."); return true;
    case "ca":  await tg.answerCallbackQuery(token, cbq.id, await cmp.toggleApprove(ws, postId)); await openCompose(ws, chatId, postId, token); return true;
    case "cgo": {
      await tg.answerCallbackQuery(token, cbq.id, "Публікую…");
      let out: string; try { out = await cmp.publishNow(ws, postId); } catch (e: any) { out = "⚠️ " + String(e.message).slice(0, 200); }
      await tg.sendMessage(token, chatId, out);
      await openCompose(ws, chatId, postId, token); return true;
    }
    case "cs": {
      const w = await cmp.whenButtons(ws, postId);
      await tg.answerCallbackQuery(token, cbq.id);
      await liveSend(ws, chatId, "compose", w.text, w.buttons); return true;
    }
    case "cwx": await cmp.expect(ws, postId, "when", chatId); await tg.answerCallbackQuery(token, cbq.id); await tg.sendMessage(token, chatId, "🗓 Напиши дату й час: «01.08 14:30», «завтра 09:00» або «2026-08-01 18:00»."); return true;
    case "cw": {
      await tg.answerCallbackQuery(token, cbq.id);
      await tg.sendMessage(token, chatId, await cmp.schedule(ws, postId, new Date(Number(arg))));
      await openCompose(ws, chatId, postId, token); return true;
    }
  }
  return false;
}

const draftButtons = (postId: string): tg.TgButton[][] => [
  [{ text: "✅ Опублікувати в Telegram", data: `pub:${postId}` }],
  [{ text: "✍️ Переробити", data: `rw:${postId}` }, { text: "📋 Ще ідеї", data: "idea_list" }],
  // deep-лінк: відкрити ЦЕЙ пост у композері кабінету (доредагувати, додати фото, обрати мережі)
  [{ text: "🌐 Відкрити в кабінеті", url: postDeepLink(postId) }],
];

// натискання inline-кнопок (tokenOverride = власний бот воркспейсу)
async function handleCallback(cbq: any, tokenOverride?: string): Promise<void> {
  const token = tokenOverride || env.telegram.botToken;
  const fromId = cbq.from?.id; const chatId = String(cbq.message?.chat?.id ?? fromId); const data = String(cbq.data || "");
  const ws = await ownerWorkspace(fromId);
  if (!ws) { await tg.answerCallbackQuery(token, cbq.id, "Спершу під'єднай кабінет socialio"); return; }
  try {
    if (data.startsWith("idea_raw:")) {
      const it = await one<{ text: string }>(`select text from idea_bank where id=$1 and workspace_id=$2`, [data.slice(9), ws]);
      if (!it) { await tg.answerCallbackQuery(token, cbq.id, "Не знайшов"); return; }
      await tg.answerCallbackQuery(token, cbq.id);
      const pid = await cmp.createBotDraft(ws, it.text);
      await q(`update idea_bank set status='used', used_post_id=$2 where id=$1`, [data.slice(9), pid]);
      await openCompose(ws, chatId, pid, token);
      return;
    }
    if (await composeCallback(ws, chatId, data, cbq, token)) return;
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
    // ---- 🧵 Threads: повтор хіта + тейки-порятунок ----
    if (data.startsWith("rep:")) {
      await tg.answerCallbackQuery(token, cbq.id, "Готую повтор…");
      const postId = data.slice("rep:".length);
      const post = await one<{ run_id: string; content: string; image_prompt: string | null; rubric: string | null; media_id: string | null }>(
        `select p.run_id, p.content, p.image_prompt, p.rubric, p.media_id from post p
           join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
         where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
      if (!post) { await tg.sendMessage(token, chatId, "Пост не знайдено."); return; }
      const fresh = await repeatVariant(ws, post.content);
      const np = await one<{ id: string }>(
        `insert into post(run_id, stage, content, image_prompt, rubric, media_id, channels)
         values($1,'final',$2,$3,$4,$5,$6::jsonb) returning id`,
        [post.run_id, fresh, post.image_prompt, post.rubric, post.media_id, JSON.stringify({ threads: { on: true } })]);
      const when = new Date(Date.now() + 48 * 3600e3);
      await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [np!.id, when.toISOString()]);
      await tg.sendMessage(token, chatId, `🔁 Повтор заплановано на ${when.toLocaleString("uk", { timeZone: "Europe/Kyiv" })} (свіжий гачок, та сама суть - покажеться іншій аудиторії).`);
      return;
    }
    if (data === "takes_gen") {
      await tg.answerCallbackQuery(token, cbq.id, "Пишу тейки…");
      try { const n = await generateThreadsTakes(ws, 3); await tg.sendMessage(token, chatId, `🧵 +${n} тейки в чернетках Студії - обери найживіший і опублікуй. Стрік урятовано, якщо встигнеш сьогодні 😉`); }
      catch (e: any) { await tg.sendMessage(token, chatId, "⚠️ " + String(e.message).slice(0, 200)); }
      return;
    }
    // ---- 📔 щоденник ----
    if (data === "dnone") {
      await skipDiaryToday(ws);
      await tg.answerCallbackQuery(token, cbq.id, "Ок, сьогодні пропускаємо 🙌");
      const mid = cbq.message?.message_id;
      if (mid) await tg.editMessageText(token, chatId, mid, "📔 Сьогодні без запису 🙌 Побачимось завтра.");
      return;
    }
    if (data.startsWith("mat_post:")) {
      // 🔥 топ-матеріал (оцінка ≥9/10) → чернетка в 1 тап прямо зі сповіщення
      await tg.answerCallbackQuery(token, cbq.id, "Генерую чернетку з матеріалу…");
      const src = await one<{ id: string; transcript: string }>(`select id, transcript from source where id=$1 and workspace_id=$2`, [data.slice("mat_post:".length), ws]);
      if (!src || !(src.transcript || "").trim()) { await tg.sendMessage(token, chatId, "Матеріал порожній або не знайдений."); return; }
      const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src.id]);
      await generatePostsOnePass(run!.id, 1);
      const post = await one<{ id: string; content: string }>(`select id, content from post where run_id=$1 and stage='final' limit 1`, [run!.id]);
      if (!post) { await tg.sendMessage(token, chatId, "Не вдалося згенерувати - спробуй у застосунку (Матеріали)."); return; }
      await tg.sendMessage(token, chatId, `✅ Чернетка з топ-матеріалу:\n\n${post.content.slice(0, 3500)}`, draftButtons(post.id));
      return;
    }
    if (data.startsWith("dpost:")) {
      // запис дня → готова чернетка поста (той самий Lite-шлях, що й у матеріалів)
      await tg.answerCallbackQuery(token, cbq.id, "Генерую пост із щоденника…");
      const src = await one<{ id: string; transcript: string }>(`select id, transcript from source where id=$1 and workspace_id=$2 and origin='diary'`, [data.slice("dpost:".length), ws]);
      if (!src || !(src.transcript || "").trim()) { await tg.sendMessage(token, chatId, "Запис порожній або не знайдений."); return; }
      const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src.id]);
      await generatePostsOnePass(run!.id, 1);
      const post = await one<{ id: string; content: string }>(`select id, content from post where run_id=$1 and stage='final' limit 1`, [run!.id]);
      if (!post) { await tg.sendMessage(token, chatId, "Не вдалося згенерувати - спробуй у застосунку (Матеріали → 📔)."); return; }
      await tg.sendMessage(token, chatId, `✅ Чернетка з твого дня:\n\n${post.content.slice(0, 3500)}`, draftButtons(post.id));
      return;
    }
    if (data.startsWith("dideas:")) {
      // запис дня → тейки Розвідника (story-режим: 7 типів кутів) → Банк ідей
      await tg.answerCallbackQuery(token, cbq.id, "Витягую ідеї з запису…");
      const src = await one<{ transcript: string }>(`select transcript from source where id=$1 and workspace_id=$2 and origin='diary'`, [data.slice("dideas:".length), ws]);
      if (!src || !(src.transcript || "").trim()) { await tg.sendMessage(token, chatId, "Запис порожній або не знайдений."); return; }
      const ideas = await extractIdeasFromText(ws, src.transcript, 5, undefined, "story");
      if (!ideas.length) { await tg.sendMessage(token, chatId, "Не знайшов виразних кутів - докинь у запис ще деталей."); return; }
      for (const a of ideas)
        await q(`insert into idea_bank(workspace_id, text, angle, origin) values($1,$2,$3,'ai')`, [ws, a.idea.slice(0, 500), (a.angle || "").slice(0, 300) || null]);
      await tg.sendMessage(token, chatId,
        `💡 З твого дня (уже в Банку ідей):\n\n${ideas.map((a, i) => `${i + 1}. ${a.idea}${a.angle ? ` (${a.angle})` : ""}`).join("\n")}`,
        [[{ text: "✨ Зробити пост з ідеї", data: "idea_list" }]]);
      return;
    }
    if (data.startsWith("dreel:")) {
      await tg.answerCallbackQuery(token, cbq.id, "Пишу сценарій рілса з запису…");
      const src = await one<{ id: string; transcript: string }>(`select id, transcript from source where id=$1 and workspace_id=$2 and origin='diary'`, [data.slice("dreel:".length), ws]);
      if (!src || !(src.transcript || "").trim()) { await tg.sendMessage(token, chatId, "Запис порожній або не знайдений."); return; }
      try {
        const script = await reelsScript(ws, src.transcript, 30);
        const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src.id]);
        const np = await one<{ id: string }>(`insert into post(run_id, stage, content, format) values($1,'final',$2,'reel') returning id`, [run!.id, script]);
        // 🔗 deep-лінк веде ПРЯМО в цей пост, а не просто «в застосунок»
        await tg.sendMessage(token, chatId, "🎬 Сценарій рілса з твого дня. Зібрати відео - кнопка 🎞 на картці.", [[{ text: "✍ Відкрити пост", url: postDeepLink(np!.id) }]]);
      } catch (e: any) { await tg.sendMessage(token, chatId, "Не вдалося: " + String(e.message).slice(0, 200)); }
      return;
    }
    if (data.startsWith("dbroll:")) {
      // відео дня → персональна b-roll бібліотека (вставки з автором у зібраних рілсах)
      const r = await q(`update media_asset set source='broll' where id=$1 and workspace_id=$2 and kind='video' returning id`, [data.slice("dbroll:".length), ws]);
      await tg.answerCallbackQuery(token, cbq.id, r.length ? "Додано у вставки для рілсів ✓" : "Відео не знайдено");
      return;
    }
    if (data === "dweek_ideas" || data === "dweek_reels") {
      // недільна петля: весь тиждень щоденника → серія ідей або нарізка на рілси
      await tg.answerCallbackQuery(token, cbq.id, data === "dweek_ideas" ? "Розбираю тиждень на ідеї…" : "Нарізаю тиждень на рілси…");
      const weekText = await weekDiaryText(ws);
      if (weekText.length < 200) { await tg.sendMessage(token, chatId, "Записів за тиждень замало - продовжуй вести щоденник 📔"); return; }
      const anchor = await one<{ id: string }>(`select id from source where workspace_id=$1 and origin='diary' order by created_at desc limit 1`, [ws]);
      if (data === "dweek_ideas") {
        const ideas = await extractIdeasFromText(ws, weekText, 6, undefined, "story");
        for (const a of ideas)
          await q(`insert into idea_bank(workspace_id, text, angle, origin) values($1,$2,$3,'ai')`, [ws, a.idea.slice(0, 500), (a.angle || "").slice(0, 300) || null]);
        await tg.sendMessage(token, chatId, ideas.length
          ? `💡 Тиждень розібрано на ${ideas.length} ідей (уже в Банку):\n\n${ideas.map((a, i) => `${i + 1}. ${a.idea}`).join("\n")}`
          : "Не знайшов виразних кутів у тижні.", [[{ text: "✨ Зробити пост з ідеї", data: "idea_list" }]]);
      } else {
        try {
          const scripts = await sliceToReels(ws, weekText, 30);
          if (!scripts.length || !anchor) { await tg.sendMessage(token, chatId, "Не вдалося нарізати - спробуй у застосунку."); return; }
          const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [anchor.id]);
          for (const sc of scripts) await q(`insert into post(run_id, stage, content, format) values($1,'final',$2,'reel')`, [run!.id, sc]);
          await tg.sendMessage(token, chatId, `🎞 Тиждень нарізано: ${scripts.length} сценаріїв рілсів у Чорновиках, у порядку публікації.`, [[{ text: "🌐 Відкрити застосунок", url: env.appBaseUrl + "/app" }]]);
        } catch (e: any) { await tg.sendMessage(token, chatId, "Не вдалося: " + String(e.message).slice(0, 200)); }
      }
      return;
    }
    if (data.startsWith("dev:")) {
      // «Продовження» з дайджеста: пост вистрілив → 5 кутів розвитку в Банк ідей
      const postId = data.slice("dev:".length);
      await tg.answerCallbackQuery(token, cbq.id, "Шукаю кути розвитку…");
      const post = await one<{ content: string }>(
        `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
      if (!post) { await tg.sendMessage(token, chatId, "Пост не знайдено."); return; }
      const angles = await suggestDevelopment(ws, post.content);
      if (!angles.length) { await tg.sendMessage(token, chatId, "Не вдалося скласти кути. Спробуй 🔥 на картці в застосунку."); return; }
      for (const a of angles)
        await q(`insert into idea_bank(workspace_id, text, angle, origin) values($1,$2,$3,'ai')`, [ws, a.idea.slice(0, 500), (a.angle || "").slice(0, 300) || null]);
      await tg.sendMessage(token, chatId,
        `🔥 5 кутів продовження (уже в Банку ідей):\n\n${angles.map((a, i) => `${i + 1}. ${a.idea}${a.angle ? ` (${a.angle})` : ""}`).join("\n")}`,
        [[{ text: "💡 Зробити пост з ідеї", data: "idea_list" }]]);
      return;
    }
    if (data.startsWith("reel:")) {
      // перепакування хіта: пост залетів → сценарій рілса на ту саму тему (реюзаємо run поста)
      const postId = data.slice("reel:".length);
      await tg.answerCallbackQuery(token, cbq.id, "Пишу сценарій рілса…");
      const post = await one<{ content: string; run_id: string }>(
        `select p.content, p.run_id from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
      if (!post) { await tg.sendMessage(token, chatId, "Пост не знайдено."); return; }
      try {
        const script = await reelsScript(ws, post.content, 30);
        const np = await one<{ id: string }>(`insert into post(run_id, stage, content, format) values($1,'final',$2,'reel') returning id`, [post.run_id, script]);
        await tg.sendMessage(token, chatId, "🎬 Сценарій рілса за темою хіта готовий. Зібрати відео - кнопка 🎞 на картці.",
          [[{ text: "✍ Відкрити пост", url: postDeepLink(np!.id) }]]);
      } catch (e: any) { await tg.sendMessage(token, chatId, "Не вдалося скласти сценарій: " + e.message); }
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
