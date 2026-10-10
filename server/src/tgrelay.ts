// 🤖 Свій бот людини, що вже працює деінде (рішення Олега 10.10: «бот на моєму коді, роби перший варіант»).
//
// Telegram дає Telegram Business лише одного чат-бота, а в бота одне місце для апдейтів (його вебхук або
// його getUpdates). Якщо людина вже має свого бота, який відповідає людям від її імені, Holos його не
// забирає: вебхук не чіпаємо (setWebhook не кличемо ніколи), а бот людини сам пересилає сюди те, що Holos
// потрібно, - на адресу /api/webhooks/telegram/relay/<id бота> з секретом у заголовку
// X-Telegram-Bot-Api-Secret-Token (так само, як Telegram шле вебхуки):
//  - business_connection - підключення до Telegram Business (для сторіс у профіль); правду про нього беремо
//    у Telegram (getBusinessConnection), а не з тіла запиту;
//  - business_message, написані САМОЮ людиною, - лише якщо вона ввімкнула «💡 Ідеї з моїх повідомлень»;
//  - повідомлення КЛІЄНТІВ - лише з окремою галочкою «👥 і питання клієнтів» (рішення Олега 10.10, типово
//    вимкнено). Без неї відкидаємо (відправник ≠ людина з підключення), з нею - знеособлюємо ДО збереження
//    (телефони, пошти, посилання, ніки, номери) і беремо в ідеї лише теми, про які питають, без цитат клієнтів.
//    Бот дізнається про галочку з відповіді на кожне переслане (поле clients) і без неї клієнтів не шле.
// Токен бота Holos тримає лише для postStory і getBusinessConnection. Сирий текст повідомлень живе
// до вечірнього проходу (не довше 48 год) і стирається; у ньому нема, кому й куди людина писала.
import { createHash } from "node:crypto";
import { q, one } from "./db.js";
import { env } from "./env.js";
import * as tg from "./telegram.js";
import { logEvent } from "./log.js";
import { hookSecret, looksLikeBotToken } from "./tgbot.js";
import { onBusinessConnection, bizLabel, type TgBiz } from "./tgstory.js";
import { chatIdeasFromNotes } from "./pipeline.js";

const botIdOf = (token: string): string => String(token || "").split(":")[0];
export const relayUrl = (botId: string): string => `${env.appBaseUrl}/api/webhooks/telegram/relay/${botId}`;
export const relaySecret = (botId: string): string => hookSecret(`relay:${botId}`);

export const NOTE_MIN = 30;           // коротше - «ок», «дякую», «буду о 5»: думки там нема
export const CLIENT_MIN = 20;         // питання клієнта буває коротким: «А вікна теж миєте?»
export const CLIENT_MAX = 600;
export const NOTE_MAX = 1500;         // довше обрізаємо: для ідеї вистачає
export const NOTES_PER_PASS = 80;     // вечірній прохід бере найсвіжіші
export const NOTES_TTL_H = 48;        // сирий текст довше не живе за жодних умов
export const IDEAS_HOUR = Number(process.env.CHAT_IDEAS_HOUR ?? 21); // вечір за поясом бренду: день переписок уже позаду
export const IDEAS_PER_DAY = 3;

type RelayRow = { bot_id: string; workspace_id: string; token: string; username: string | null; ideas: boolean; client_ideas: boolean; added_by: string | null; last_seen_at: string | null };
const RELAY_COLS = `bot_id, workspace_id, token, username, ideas, client_ideas, added_by, last_seen_at`;

export async function relayOf(ws: string): Promise<RelayRow | null> {
  return one<RelayRow>(`select ${RELAY_COLS} from tg_relay where workspace_id=$1 order by updated_at desc limit 1`, [ws]);
}

/** Чи текст власного повідомлення варто тримати до вечора (тут же - що саме зберегти). */
const VOICE_RX = /^\s*\[голосове(?: повідомлення)?\]\s*/i; // «[голосове повідомлення]» без розшифровки - порожньо
export function noteText(raw: unknown): string {
  const t = String(raw ?? "").replace(VOICE_RX, "").replace(/\s+/g, " ").trim();
  if (t.length < NOTE_MIN) return "";
  // самі посилання й емодзі - не думка
  const meat = t.replace(/https?:\/\/\S+/g, "").replace(/[\p{Extended_Pictographic}\s]/gu, "");
  if (meat.length < NOTE_MIN / 2) return "";
  return t.slice(0, NOTE_MAX);
}
/**
 * Знеособити текст клієнта ДО збереження: пошти, посилання, @ніки, телефони, рахунки (IBAN) і довгі номери
 * (картки, замовлення, документи) - на мітки. Імена так не прибрати - їх модель не бере в ідеї за промтом.
 */
export function scrubPersonal(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[пошта]")
    .replace(/(?:https?:\/\/|www\.)\S+|\b(?:t\.me|wa\.me|instagram\.com|facebook\.com)\/\S+/gi, "[посилання]")
    .replace(/(^|[^\w])@[A-Za-z0-9_]{3,}/g, "$1[нік]")
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, "[рахунок]")
    .replace(/\+?\d[\d ().\/-]{6,}\d/g, (m) => (m.replace(/\D/g, "").length >= 7 ? "[номер]" : m));
}
/** Що з повідомлення клієнта тримати до вечора: знеособлене питання, а не «дякую» чи «ок». */
export function clientNoteText(raw: unknown): string {
  const t = scrubPersonal(String(raw ?? "").replace(VOICE_RX, "")).replace(/\s+/g, " ").trim();
  if (t.length < CLIENT_MIN) return "";
  const meat = t.replace(/\[(?:пошта|посилання|нік|рахунок|номер)\]/g, "").replace(/[\p{Extended_Pictographic}\s\p{P}]/gu, "");
  if (meat.length < CLIENT_MIN / 2) return "";
  return t.slice(0, CLIENT_MAX);
}
/**
 * Цитата в ідеї - лише слова самої людини: щоб модель не підсунула туди слова клієнта. Порівнюємо за початком
 * слова (4 літери): модель переказує думку автора, і «просить» стає «просять», «страх» - «страху».
 */
export function quoteFromOwn(quote: string, own: string[]): string {
  const words = (x: string) => (x.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).map((w) => w.slice(0, 4));
  const q = words(quote);
  if (!q.length || !own.length) return "";
  const have = new Set(own.flatMap(words));
  const hit = q.filter((w) => have.has(w)).length;
  return hit / q.length >= 0.6 ? quote : "";
}
/** Ключ запису: відбиток (підключення, чат, повідомлення) - сам чат не зберігаємо. */
export const noteKey = (connId: string, chatId: unknown, messageId: unknown): string =>
  createHash("sha256").update(`${connId}:${chatId}:${messageId}`).digest("hex").slice(0, 40);

/**
 * Підключити свій бот до бренду без перехоплення: перевірити токен у Telegram і зберегти. Вебхук бота
 * не чіпаємо - бот і далі працює там, де працював.
 */
export async function addRelay(ws: string, userId: string, rawToken: string): Promise<{ bot: string; canBusiness: boolean }> {
  const token = String(rawToken || "").trim().replace(/^bot(?=\d)/i, "");
  if (!looksLikeBotToken(token)) throw new Error("Це не схоже на токен бота. Він виглядає так: 123456789:AAH… - скопіюй його з @BotFather цілком.");
  if (env.telegram.botToken && botIdOf(token) === botIdOf(env.telegram.botToken))
    throw new Error("Це спільний бот Holos - його підключати не треба. Сюди - токен твого власного бота, який уже працює деінде.");
  let me: { id: number; username?: string; can_connect_to_business?: boolean };
  try { me = await tg.getMe(token) as any; }
  catch (e: any) { throw new Error("Telegram не прийняв цей токен: " + String(e.message).slice(0, 160)); }
  const own = await one<{ n: number }>(`select count(*)::int n from telegram_config where bot_token like $1`, [`${me.id}:%`]);
  if (own?.n) throw new Error("Цей бот уже стоїть у Holos «власним ботом» кабінету - він і так ставить сторіс через Holos. Тут - бот, який працює поза Holos.");
  await q(`insert into tg_relay(bot_id, workspace_id, token, username, added_by) values($1,$2,$3,$4,$5)
           on conflict (bot_id) do update set workspace_id=excluded.workspace_id, token=excluded.token, username=excluded.username,
             added_by=excluded.added_by, updated_at=now()`, [String(me.id), ws, token, me.username || null, userId]);
  await logEvent("info", "tgrelay", `свій бот @${me.username || me.id} підключено без перехоплення (сторіс${me.can_connect_to_business === false ? "; Business Mode у бота вимкнено" : ""})`, null, userId);
  return { bot: me.username || String(me.id), canBusiness: me.can_connect_to_business !== false };
}

export async function dropRelay(ws: string): Promise<void> {
  const r = await relayOf(ws);
  if (!r) return;
  // підключення Business цього бота більше нікому обслуговувати - разом із ним і профіль сторіс бренду
  await q(`delete from tg_business where bot_id=$1`, [r.bot_id]);
  await q(`delete from tg_relay where bot_id=$1`, [r.bot_id]);
  await q(`delete from tg_chat_note where workspace_id=$1`, [ws]);
  await logEvent("info", "tgrelay", `свій бот @${r.username || r.bot_id} відʼєднано`);
}

/** Галочки: own - власні повідомлення, clients - і питання клієнтів. Вимкнене - його черга стирається одразу. */
export async function setRelayIdeas(ws: string, opts: { own?: boolean; clients?: boolean }): Promise<void> {
  if (typeof opts.own === "boolean") {
    await q(`update tg_relay set ideas=$2, updated_at=now() where workspace_id=$1`, [ws, opts.own]);
    if (!opts.own) await q(`delete from tg_chat_note where workspace_id=$1 and who='own'`, [ws]);
  }
  if (typeof opts.clients === "boolean") {
    await q(`update tg_relay set client_ideas=$2, updated_at=now() where workspace_id=$1`, [ws, opts.clients]);
    if (!opts.clients) await q(`delete from tg_chat_note where workspace_id=$1 and who='client'`, [ws]);
  }
}

/** Що бачить людина в Каналах. Адресу з секретом - лише той, хто керує каналами (manage). */
export async function relayView(ws: string, mayManage: boolean): Promise<{
  bot: string; url?: string; secret?: string; ideas: boolean; clients: boolean; lastSeen: string | null; notes: number; clientNotes: number;
  conn: (Pick<TgBiz, "id" | "can_stories" | "enabled"> & { label: string }) | null;
} | null> {
  const r = await relayOf(ws);
  if (!r) return null;
  const c = await one<TgBiz>(`select id, bot_id, tg_user_id::text, user_chat_id::text, username, name, can_stories, enabled from tg_business where bot_id=$1 order by updated_at desc limit 1`, [r.bot_id]);
  const notes = await one<{ n: number; c: number }>(`select count(*) filter (where who='own')::int n, count(*) filter (where who='client')::int c from tg_chat_note where workspace_id=$1`, [ws]);
  return {
    bot: r.username || r.bot_id,
    ...(mayManage ? { url: relayUrl(r.bot_id), secret: relaySecret(r.bot_id) } : {}),
    ideas: r.ideas, clients: r.client_ideas, lastSeen: r.last_seen_at, notes: notes?.n || 0, clientNotes: notes?.c || 0,
    conn: c ? { id: c.id, can_stories: c.can_stories, enabled: c.enabled, label: bizLabel(c) } : null,
  };
}

/** Правда про підключення - з Telegram (те, що переслав бот, лише підказує id). */
async function syncConnection(r: RelayRow, connId: string): Promise<TgBiz | null> {
  const bc = await tg.getBusinessConnection(r.token, connId);
  await onBusinessConnection(bc, r.token, { relayWs: r.workspace_id });
  return one<TgBiz>(`select id, bot_id, tg_user_id::text, user_chat_id::text, username, name, can_stories, enabled from tg_business where id=$1`, [connId]);
}

/**
 * Апдейт, який переслав бот людини. Повертає, що з ним зроблено (для журналу бота й тестів):
 * connection - підключення оновлено; note - думку збережено до вечора; client - знеособлене питання клієнта;
 * skip:<чому> - пропущено. clients - чи хоче Holos повідомлення клієнтів (бот без цього їх не шле).
 */
export async function onRelayUpdate(botId: string, update: any): Promise<{ ok: true; did: string; clients: boolean }> {
  const r = await one<RelayRow>(`select ${RELAY_COLS} from tg_relay where bot_id=$1`, [botId]);
  if (!r) return { ok: true, did: "skip:no-relay", clients: false };
  const res = await relayUpdate(r, botId, update);
  return { ok: true, did: res, clients: r.client_ideas };
}
async function relayUpdate(r: RelayRow, botId: string, update: any): Promise<string> {
  await q(`update tg_relay set last_seen_at=now() where bot_id=$1`, [botId]);
  if (update?.business_connection?.id) {
    try { await syncConnection(r, String(update.business_connection.id)); return "connection"; }
    catch (e: any) {
      await logEvent("warn", "tgrelay", `підключення Business не звірилось у Telegram: ${String(e.message).slice(0, 160)}`);
      return "skip:telegram";
    }
  }
  const m = update?.business_message;
  if (!m) return "skip:kind";
  const connId = String(m.business_connection_id || "");
  if (!connId) return "skip:no-connection";
  // підключення ще не знаємо (бот переслав повідомлення раніше за підключення) - спитати Telegram
  let biz = await one<TgBiz>(`select id, bot_id, tg_user_id::text, user_chat_id::text, username, name, can_stories, enabled from tg_business where id=$1 and bot_id=$2`, [connId, botId]);
  if (!biz) {
    try { biz = await syncConnection(r, connId); }
    catch { return "skip:telegram"; }
    if (!biz) return "skip:telegram";
  }
  const from = String(m.from?.id ?? "");
  if (!from) return "skip:no-from";
  const own = from === String(biz.tg_user_id);
  // свої - з галочкою «з моїх повідомлень»; співрозмовників - лише з окремою «і питання клієнтів»,
  // інакше відкидаємо, навіть якщо бот переслав
  if (own && !r.ideas) return "skip:ideas-off";
  if (!own && !r.client_ideas) return "skip:not-owner";
  const text = own ? noteText(m.text ?? m.caption) : clientNoteText(m.text ?? m.caption);
  if (!text) return "skip:short";
  const at = Number(m.date) > 0 ? new Date(Number(m.date) * 1000) : new Date();
  await q(`insert into tg_chat_note(workspace_id, key, text, msg_at, who) values($1,$2,$3,$4,$5) on conflict (key) do nothing`,
    [r.workspace_id, noteKey(connId, m.chat?.id, m.message_id), text, at, own ? "own" : "client"]);
  return own ? "note" : "client";
}

// ---- вечірній прохід «💡 ідеї з переписок» ----
function localParts(tz: string): { hour: number; date: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return { hour: Number(p.hour) % 24, date: `${p.year}-${p.month}-${p.day}` };
}

/** Один прохід для бренду: з повідомлень за добу - до 3 ідей у Банк ідей; сирий текст стирається. */
export async function chatIdeasPass(ws: string): Promise<{ ideas: Array<{ id: string; text: string }>; notes: number }> {
  const notes = await q<{ id: string; text: string; who: string }>(
    `select id::text, text, who from tg_chat_note where workspace_id=$1 order by msg_at desc limit ${NOTES_PER_PASS}`, [ws]);
  if (!notes.length) return { ideas: [], notes: 0 };
  const chrono = notes.slice().reverse();
  const found = await chatIdeasFromNotes(ws, chrono.map((n) => ({ who: n.who === "client" ? "client" as const : "own" as const, text: n.text })));
  const ownTexts = chrono.filter((n) => n.who !== "client").map((n) => n.text);
  // що вже є в Банку - не дублюємо
  const have = new Set((await q<{ text: string }>(`select lower(text) as text from idea_bank where workspace_id=$1 order by created_at desc limit 300`, [ws])).map((x) => x.text));
  const ideas: Array<{ id: string; text: string }> = [];
  for (const f of found.slice(0, IDEAS_PER_DAY)) {
    if (have.has(f.idea.toLowerCase())) continue;
    const quote = quoteFromOwn(f.quote, ownTexts); // цитата - лише слова самої людини, не клієнта
    const text = quote ? `${f.idea}\n«${quote}»` : f.idea;
    const row = await one<{ id: string }>(`insert into idea_bank(workspace_id, text, angle, rubric, origin) values($1,$2,$3,$4,'chat') returning id`,
      [ws, text.slice(0, 3000), f.angle || null, f.rubric || null]);
    if (row) ideas.push({ id: row.id, text: f.idea });
  }
  // прохід відбувся - сирий текст більше не потрібен (і не зберігається, навіть якщо ідей нема)
  await q(`delete from tg_chat_note where workspace_id=$1 and id = any($2::bigint[])`, [ws, notes.map((n) => n.id)]);
  return { ideas, notes: notes.length };
}

async function notifyIdeas(ws: string, addedBy: string | null, ideas: Array<{ id: string; text: string }>): Promise<void> {
  if (!ideas.length || !addedBy) return;
  const o = await one<{ tg_user_id: string }>(`select tg_user_id::text from tg_owner where user_id=$1 order by tg_user_id limit 1`, [addedBy]);
  if (!o) return;
  const title = (await one<{ title: string | null }>(`select title from workspace where id=$1`, [ws]))?.title || "бренд";
  const lines = ideas.map((x, i) => `${i + 1}. ${x.text}`).join("\n");
  const { liveSend } = await import("./tgbot.js");
  await liveSend(ws, o.tg_user_id, "chatideas",
    `💡 З твоїх переписок за день - ${ideas.length === 1 ? "ідея" : "ідеї"} для постів бренду «${title}» (уже в Банку ідей):\n\n${lines}`,
    [...ideas.map((x) => [{ text: `✨ Пост: ${x.text.slice(0, 36)}`, data: `idea_post:${x.id}` }]), [{ text: "💡 Усі ідеї", data: "idea_list" }]]).catch(() => {});
}

/** «Зібрати зараз» з кабінету: той самий прохід, не чекаючи вечора. */
export async function chatIdeasNow(ws: string): Promise<{ ideas: Array<{ id: string; text: string }>; notes: number }> {
  const r = await relayOf(ws);
  const res = await chatIdeasPass(ws);
  await logEvent("info", "tgrelay", `ідеї з переписок (вручну): ${res.notes} повідомл. → ${res.ideas.length} ідей`);
  await notifyIdeas(ws, r?.added_by ?? null, res.ideas);
  return res;
}

const ran = new Map<string, string>(); // бренд -> дата останнього проходу (у памʼяті; у базі - app_log)
export async function chatIdeasTick(now: Date = new Date()): Promise<void> {
  // сирий текст довше 48 год не живе за жодних умов (прохід не відбувся, ідеї вимкнули й увімкнули…)
  await q(`delete from tg_chat_note where msg_at < $1::timestamptz - interval '${NOTES_TTL_H} hours' or created_at < $1::timestamptz - interval '${NOTES_TTL_H} hours'`, [now.toISOString()]);
  const rows = await q<{ workspace_id: string; added_by: string | null; tz: string | null; last: string | null }>(
    `select r.workspace_id, r.added_by, (select content from settings_block where workspace_id=r.workspace_id and key='timezone') as tz,
            (select content from settings_block where workspace_id=r.workspace_id and key='chat_ideas_last') as last
       from tg_relay r where (r.ideas or r.client_ideas) and exists (select 1 from tg_chat_note n where n.workspace_id=r.workspace_id)`);
  for (const r of rows) {
    const { hour, date } = localParts(r.tz || "Europe/Kyiv");
    if (hour < IDEAS_HOUR || r.last === date || ran.get(r.workspace_id) === date) continue;
    ran.set(r.workspace_id, date);
    await q(`insert into settings_block(workspace_id, key, content) values($1,'chat_ideas_last',$2)
             on conflict (workspace_id, key) do update set content=excluded.content`, [r.workspace_id, date]);
    try {
      const res = await chatIdeasPass(r.workspace_id);
      await logEvent("info", "tgrelay", `ідеї з переписок: ${res.notes} повідомл. → ${res.ideas.length} ідей`);
      await notifyIdeas(r.workspace_id, r.added_by, res.ideas);
    } catch (e: any) {
      await logEvent("warn", "tgrelay", `ідеї з переписок не вийшли: ${String(e.message).slice(0, 160)}`);
    }
  }
}

export function startChatIdeas(): void {
  const ms = Number(process.env.CHAT_IDEAS_TICK_MS ?? 600000);
  if (!ms) return;
  const tick = () => chatIdeasTick().catch(() => {});
  setTimeout(tick, Number(process.env.CHAT_IDEAS_FIRST_MS ?? 60000));
  setInterval(tick, ms);
}
