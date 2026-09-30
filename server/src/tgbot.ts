// Спільний Telegram-бот: користувач підключає СВІЙ канал до нашого бота (без власного токена).
// Потік: кабінет дає deep-link t.me/<bot>?start=<code> -> юзер тисне Start -> бот просить
// додати його адміном у канал і переслати пост -> бот перевіряє права й зберігає канал у workspace.
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "./env.js";
import { q, one } from "./db.js";
import * as tg from "./telegram.js";
import { logEvent } from "./log.js";
import { touchWorkspaceActive } from "./auth.js";
import { generatePostsOnePass, buildLiteSkeleton, rewritePost, suggestDevelopment, reelsScript, sliceToReels, extractIdeasFromText, repeatVariant, generateThreadsTakes } from "./pipeline.js";
import { publishPostToChannels, PUB_NETS, pubLabel } from "./publisher.js";
import { sendDigestNow } from "./digest.js";
import { isDiaryPending, appendDiaryText, attachDiaryMedia, attachMediaToEntry, diaryPhotoTarget, transcribeVoice, skipDiaryToday, sendDiaryNow, weekDiaryText } from "./diary.js";
import { cabinetPostLink } from "./permalink.js";
import * as cmp from "./tgcompose.js";
import { looksLikeReadyPost } from "./textkind.js";
import { legacyHosts, isOurHookUrl, foreignHookHost as foreignHost } from "./brand.js";
import { setSecret } from "./secrets.js";
import { getMt, startMt, montageMessage, montageCallback, moveMtSession } from "./tgmontage.js";
import { commentCallback, commentText, showComments } from "./tgcomments.js";
import { botBrands, pickBrand, setBotBrand, homeIfLost, brandOfCallback, brandLabel, moveDraft, type BotBrands } from "./tgbrand.js";
const postDeepLink = (postId: string) => cabinetPostLink(env.appBaseUrl, postId);

let BOT_ID = 0;
let BOT_USERNAME = env.telegram.botUsername;

export const botEnabled = (): boolean => !!env.telegram.botToken;
export const botUsername = (): string => BOT_USERNAME;

// 🔁 КОЛИШНІ СПІЛЬНІ БОТИ. Спільного бота міняють з адмінки (напр., @R_Socialio_bot → @holos_rozum_bot).
// Кабінети, що підключали канал через попереднього, мають у telegram_config ЙОГО токен - і без цього
// списку він виглядав би їхнім «власним» ботом: кнопка «Підключити наш бот» вела б назавжди в старого,
// і перейти на нового не вийшло б ніяк. Колишній спільний - наш бот (його токен був у нашому .env чи
// адмінці), тож і довіра до нього та сама, що до спільного: людину впізнаємо за tg_owner. Він і далі
// публікує в канали, де стоїть адміном, і відповідає тим, хто пише йому, а все нове - посилання
// підключення, сповіщення - іде через нового. Писати першим людині, яка нового бота ще не запускала,
// Telegram не дає, тож до того сповіщення доходять старим ботом із проханням перейти. Зберігається
// токен, а не лише id: без нього старий бот замовк би після першого ж рестарту.
const formerShared = new Map<string, string>(); // id бота → токен
const botIdOf = (token: string | null | undefined): string => String(token || "").split(":")[0];
export const isFormerShared = (token?: string | null): boolean =>
  !!token && token !== env.telegram.botToken && formerShared.get(botIdOf(token)) === token;
/** Наш бот: поточний спільний або колишній спільний (на відміну від власного бота кабінету). */
const sharedLike = (token: string): boolean => token === env.telegram.botToken || isFormerShared(token);
/** Усі наші боти - поточний і колишні спільні (щоб жоден із них не вважався чиїмсь «власним»). */
export const sharedTokens = (): string[] => [env.telegram.botToken, ...formerShared.values()].filter((t) => !!t);

async function saveFormerShared(): Promise<void> {
  await q(`insert into app_secret(name, value, updated_by) values('TG_FORMER_SHARED',$1,'system')
           on conflict (name) do update set value=excluded.value, updated_at=now(), updated_by='system'`,
    [JSON.stringify(Object.fromEntries(formerShared))]);
}
// Токен, якого Telegram більше не визнає (відкликали в @BotFather, бо засвітився), - уже не наш бот:
// ним не опублікуєш і не отримаєш апдейтів, а підписом Mini App із ним можна було б назватись будь-ким.
const deadToken = (e: any): boolean => e?.tgStatus === 401 || e?.tgStatus === 404;
async function dropFormer(id: string, why: string): Promise<void> {
  if (!formerShared.delete(id)) return;
  await saveFormerShared();
  await logEvent("warn", "tgbot", `попередній спільний бот ${id} прибрано: ${why}`);
}
/**
 * Підписи Mini App, яким віримо як спільному боту: поточний і ті колишні, яких Telegram досі визнає
 * (getMe не частіше разу на 10 хвилин). Не вдалося перевірити (мережа) - цього разу не віримо.
 */
const formerChecked = new Map<string, number>();
export async function liveSharedTokens(): Promise<string[]> {
  const out = env.telegram.botToken ? [env.telegram.botToken] : [];
  for (const [id, tok] of [...formerShared]) {
    if (tok === env.telegram.botToken) continue;
    if (Date.now() - (formerChecked.get(id) || 0) > 600_000) {
      try { await tg.getMe(tok); formerChecked.set(id, Date.now()); }
      catch (e: any) { if (deadToken(e)) await dropFormer(id, "Telegram його не визнає (токен відкликано)"); continue; }
    }
    out.push(tok);
  }
  return out;
}
/** Попередній спільний бот стає колишнім; поточний колишнім не буває. */
export async function rememberFormerShared(prevToken: string): Promise<void> {
  const prev = String(prevToken || "").trim(), cur = env.telegram.botToken;
  let changed = false;
  if (prev && prev !== cur && looksLikeBotToken(prev) && formerShared.get(botIdOf(prev)) !== prev) { formerShared.set(botIdOf(prev), prev); changed = true; }
  if (cur && formerShared.delete(botIdOf(cur))) changed = true;
  if (changed) await saveFormerShared();
}
/** Старт: колишні з бази + бот із .env, якщо спільного вже поставили з адмінки. */
export async function loadFormerShared(): Promise<void> {
  formerShared.clear();
  const r = await one<{ value: string }>(`select value from app_secret where name='TG_FORMER_SHARED'`);
  try {
    for (const [id, tok] of Object.entries(JSON.parse(r?.value || "{}")))
      if (typeof tok === "string" && botIdOf(tok) === id) formerShared.set(id, tok);
  } catch { /* битий запис - починаємо з порожнього */ }
  await rememberFormerShared(String(process.env.TELEGRAM_BOT_TOKEN ?? ""));
}
// @нік колишнього бота - для підказки в кабінеті (getMe раз на процес)
const formerNames = new Map<string, string>();
export async function formerBotName(token: string): Promise<string> {
  const id = botIdOf(token);
  if (!formerNames.has(id)) { try { formerNames.set(id, (await tg.getMe(token)).username || id); } catch { return id; } }
  return formerNames.get(id)!;
}

// Токен бота кабінету: власний бот (введений у Налаштуваннях), якщо він є; інакше спільний. Колишній
// спільний «власним» не вважається - інакше кабінет не зміг би перейти на нового бота. Не токен узагалі
// (напр. «-» у полі власного бота) - теж не власний бот: таким нічого не надішлеш.
export async function wsBotToken(workspaceId: string): Promise<string> {
  const r = await one<{ bot_token: string | null }>(`select bot_token from telegram_config where workspace_id=$1`, [workspaceId]);
  return (r?.bot_token && looksLikeBotToken(r.bot_token) && !sharedLike(r.bot_token)) ? r.bot_token : env.telegram.botToken;
}

/**
 * Куди веде вебхук бота, якщо НЕ на цей сервіс (хост), інакше "". Бот, чий вебхук веде на інший живий
 * сервіс (прод ↔ бета), там і працює: забрати його сюди - мовчки вимкнути його там.
 */
export async function foreignHookOf(token: string): Promise<string> {
  const url = String((await tg.getWebhookInfo(token)).url || "");
  return foreignHost(url, env.appBaseUrl, legacyHosts(env.appBaseUrl, process.env.LEGACY_HOSTS));
}

/**
 * Спільного бота перевипустили в @BotFather (старий токен Telegram більше не визнає), а в .env лишився
 * старий. Якщо живий токен ТОГО САМОГО бота вже вставили в кабінеті (полем «власний бот») - беремо його
 * спільним: у бота рівно один живий токен, тож це той самий бот, наш. Пишемо в «Ключі провайдерів»
 * (видно в адмінці), щоб рестарт не повертав мертвий токен із .env.
 */
async function adoptReissuedToken(): Promise<boolean> {
  const dead = env.telegram.botToken, id = botIdOf(dead);
  if (!/^\d+$/.test(id)) return false;
  const rows = await q<{ bot_token: string }>(`select distinct bot_token from telegram_config where bot_token like $1 and bot_token <> $2`, [`${id}:%`, dead]);
  for (const r of rows) {
    if (!looksLikeBotToken(r.bot_token)) continue;
    try {
      const me = await tg.getMe(r.bot_token);
      if (String(me.id) !== id) continue;
      await setSecret("TELEGRAM_BOT_TOKEN", r.bot_token, "system");
      await logEvent("warn", "tgbot", `спільний бот @${me.username || id}: токен із .env Telegram більше не визнає, а в кабінеті знайшовся живий токен того самого бота - він тепер спільний (Ключі провайдерів)`);
      return true;
    } catch { /* і цей токен не живий - шукаємо далі */ }
  }
  return false;
}

/**
 * Рядки кабінетів, чиїм токеном уже нічого не зробиш, - на живого спільного бота (лише коли Telegram щойно
 * визнав спільний токен):
 *  - старий токен ТОГО САМОГО бота: у @BotFather випустили новий, а живий у бота завжди один;
 *  - не токен узагалі (напр. «-» у полі власного бота);
 *  - відкликаний токен бота з .env, коли спільного вже поставили в адмінці: кабінети, що підключались
 *    через нього, інакше публікували б мертвим токеном («токен власного бота недійсний» - хоча свого
 *    бота в них ніколи не було). Живий бот із .env - колишній спільний, його рядки не чіпаємо.
 */
async function normalizeBotRows(): Promise<void> {
  const cur = env.telegram.botToken, id = botIdOf(cur);
  if (!cur || !/^\d+$/.test(id)) return;
  const fixed = await q<{ workspace_id: string }>(
    `update telegram_config set bot_token=$1, updated_at=now()
      where bot_token is not null and bot_token <> $1
        and (split_part(bot_token, ':', 1) = $2 or bot_token !~ '^[0-9]{5,20}:[A-Za-z0-9_-]{30,}$')
      returning workspace_id`, [cur, id]);
  let dead: { workspace_id: string }[] = [];
  const envTok = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (looksLikeBotToken(envTok) && botIdOf(envTok) !== id) {
    try { await tg.getMe(envTok); }
    catch (e: any) {
      if (deadToken(e)) dead = await q<{ workspace_id: string }>(`update telegram_config set bot_token=$1, updated_at=now() where bot_token=$2 returning workspace_id`, [cur, envTok]);
    }
  }
  const n = fixed.length + dead.length;
  if (n) await logEvent("info", "tgbot", `кабінетів переведено на спільного бота @${BOT_USERNAME}: ${n} (мертвий токен - старий того ж бота, не токен або відкликаний бот із .env)`);
}

// Власний бот воркспейсу отримує СВІЙ вебхук → усі DM-фічі (щоденник, дайджест, ідеї) працюють
// через нього, а не лише публікація. У вебхук-URL кладемо id бота (?bot=), щоб роут знав, чиїм
// токеном відповідати. Повертає username бота для підказки в UI.
export async function registerOwnBotWebhook(token: string): Promise<string> {
  const me = await tg.getMe(token);
  await tg.setWebhook(token, ownHookUrl(me.id), hookSecret(`bot:${me.id}`));
  verifiedBots.set(String(me.id), token);
  return me.username || String(me.id);
}

// 🔐 Секрети вебхуків. Раніше і спільний, і КОЖЕН власний бот отримували ту саму адресу з
// загальним секретом сервісу в шляху - а власник бота бачить адресу свого вебхука (getWebhookInfo)
// і з нею міг слати нам підроблені апдейти від імені будь-якого користувача Telegram. Тепер:
//  - секрети ВИВЕДЕНІ з базового (HMAC), сам базовий (часто це SESSION_SECRET) у Telegram не їде;
//  - власний бот має СВІЙ секрет і лише в заголовку (getWebhookInfo заголовок не показує), а в
//    шляху - тільки id бота; апдейти від власного бота обробляються лише для ЙОГО кабінетів.
// База секретів: TELEGRAM_WEBHOOK_SECRET, а якщо його не задано - випадкова, згенерована один раз і
// збережена в app_secret. Раніше базою був SESSION_SECRET, і він уже світився в адресах власних ботів,
// тож виводити з нього нові секрети не можна.
let hookBase = "";
export async function initHookBase(): Promise<void> {
  const fromEnv = String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (fromEnv) { hookBase = fromEnv; return; }
  const read = async () => (await one<{ value: string }>(`select value from app_secret where name='TG_WEBHOOK_BASE'`))?.value || "";
  hookBase = await read();
  if (hookBase) return;
  await q(`insert into app_secret(name, value, updated_by) values('TG_WEBHOOK_BASE',$1,'system') on conflict (name) do nothing`, [randomBytes(32).toString("hex")]);
  hookBase = await read(); // інший процес міг встигнути першим - беремо те, що лягло в базу
}
export function hookSecret(kind: string): string {
  if (!hookBase) throw new Error("hookBase не ініціалізовано (initHookBase)");
  return createHmac("sha256", hookBase).update("tg-webhook:" + kind).digest("hex").slice(0, 48);
}
export function sameSecret(got: unknown, want: string): boolean {
  const a = Buffer.from(String(Array.isArray(got) ? got[0] : got ?? "")), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const ownHookUrl = (botId: number | string) => `${env.appBaseUrl}/api/webhooks/telegram/bot/${botId}`;
// Секрет вебхука спільного бота - свій для КОЖНОГО бота (за id з токена). Коли спільного бота міняють
// з адмінки, старий бот лишається з вебхуком на наш сервер, і з однаковим секретом його апдейти
// обробились би як від нового - а відповідали б токеном нового, якого людина в тому чаті не запускала.
export const sharedHookKind = (token: string = env.telegram.botToken): string => "shared:" + String(token || "").split(":")[0];
/** Схоже на токен бота від @BotFather (123456789:AA…) - перевірка формату до запиту в Telegram. */
export const looksLikeBotToken = (v: string): boolean => /^\d{5,20}:[A-Za-z0-9_-]{30,}$/.test(String(v || "").trim());

// id бота -> токен, який Telegram підтвердив (getMe). Токен у telegram_config міг вписати будь-хто,
// тож вебхук власного бота довіряє лише перевіреному: інакше чужий рядок «<id бота>:сміття»
// перехопив би апдейти справжнього бота.
const verifiedBots = new Map<string, string>();
export async function ownBotToken(botId: string): Promise<string | null> {
  // колишній спільний бот - наш: його токен ми знаємо самі, у telegram_config його може й не бути
  const former = formerShared.get(botId);
  if (former && former !== env.telegram.botToken) return former;
  const rows = await q<{ bot_token: string }>(`select distinct bot_token from telegram_config where bot_token like $1`, [`${botId}:%`]);
  const known = verifiedBots.get(botId);
  if (known && rows.some((r) => r.bot_token === known)) return known;
  for (const r of rows) {
    try { const me = await tg.getMe(r.bot_token); if (String(me.id) === botId) { verifiedBots.set(botId, r.bot_token); return r.bot_token; } }
    catch { /* недійсний або підроблений токен - не наш */ }
  }
  return null;
}

// Після деплою: власні боти, чий вебхук досі веде на ЦЕЙ сервіс за старою адресою (із загальним
// секретом або на старому домені socialio.rozum.one після переїзду), переводимо на нову - разом із
// кнопкою Mini App. Бот, що дивиться на інший інстанс (прод/бета), не чіпаємо.
export async function refreshOwnBotWebhooks(): Promise<void> {
  const legacy = legacyHosts(env.appBaseUrl, process.env.LEGACY_HOSTS);
  const rows = await q<{ bot_token: string }>(`select distinct bot_token from telegram_config where bot_token is not null`);
  // колишні спільні - навіть якщо жоден кабінет не тримає їх у рядку: людям, що пишуть старому боту,
  // треба відповісти (і показати, куди він переїхав), а не мовчати
  const tokens = new Set([...rows.map((r) => r.bot_token), ...formerShared.values()]);
  for (const token of tokens) {
    if (!token || token === env.telegram.botToken) continue;
    try {
      const me = await tg.getMe(token);
      verifiedBots.set(String(me.id), token);
      const info = await tg.getWebhookInfo(token);
      const want = ownHookUrl(me.id);
      // поки ми питали Telegram, цей самий токен міг стати спільним (перевипущений бот, узятий з кабінету) -
      // тоді його вебхук уже спільний, і переводити його на адресу власного бота не можна
      if (token === env.telegram.botToken) continue;
      if (info.url && info.url !== want && isOurHookUrl(info.url, env.appBaseUrl, legacy)) {
        await tg.setWebhook(token, want, hookSecret(`bot:${me.id}`));
        await registerMenu(token);
        console.log(`[tgbot] власний бот @${me.username || me.id}: вебхук переведено на ${env.appBaseUrl}`);
      }
    } catch (e: any) {
      if (isFormerShared(token) && deadToken(e)) { await dropFormer(botIdOf(token), "Telegram його не визнає (токен відкликано)"); continue; }
      await logEvent("warn", "tgbot", `власний бот: перевірка вебхука не вдалась: ${String(e.message).slice(0, 160)}`);
    }
  }
}

// Чи вебхук спільного бота поставив САМЕ ЦЕЙ інстанс, і якщо ні - чому (для кабінету): "env" - бета не
// чіпає бота з .env (той самий .env скопійовано з проду); "foreign" - вебхук бота веде на інший сервіс;
// "dead" - Telegram не визнає токен.
let sharedHookOk = false;
let sharedOff: { why: "" | "env" | "foreign" | "dead"; host: string } = { why: "", host: "" };
/** Спільний бот - той, що в .env (а не поставлений в адмінці саме тут). */
const sharedFromEnv = (): boolean => env.telegram.botToken === String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();

export async function initTelegramBot(opts: { force?: boolean } = {}): Promise<void> {
  sharedHookOk = false; sharedOff = { why: "", host: "" };
  if (!env.telegram.botToken) { console.log("[tgbot] TELEGRAM_BOT_TOKEN не заданий - спільний бот вимкнено"); return; }
  try {
    let me: { id: number; username?: string };
    try { me = await tg.getMe(env.telegram.botToken); }
    catch (e: any) {
      // токен перевипустили в @BotFather: живий токен того самого бота міг уже лежати в кабінеті
      if (!deadToken(e)) throw e;
      if (!(await adoptReissuedToken().catch(() => false))) { sharedOff = { why: "dead", host: "" }; throw e; }
      me = await tg.getMe(env.telegram.botToken);
    }
    BOT_ID = me.id; if (me.username) BOT_USERNAME = me.username;
    await normalizeBotRows().catch((e: any) => logEvent("warn", "tgbot", `рядки кабінетів із мертвим токеном: ${String(e.message).slice(0, 160)}`));
    if (env.beta.telegramWebhookOff && !opts.force) {
      // БЕТА: бота з .env не чіпаємо - той самий .env скопійовано з проду, і вебхук ми вкрали б у прода.
      // Публікація в канали з бети працює (прямі API-виклики), а DM-фічі цього бота обробляє прод.
      if (sharedFromEnv()) {
        sharedOff = { why: "env", host: "" };
        console.log(`[tgbot] бот @${BOT_USERNAME} (id ${BOT_ID}); TELEGRAM_WEBHOOK_OFF=1 → webhook лишається за продом`);
        return;
      }
      // Бота поставили в адмінці ЦЬОГО інстансу - він тутешній. Але вебхук, що веде на інший сервіс, не
      // забираємо: там бот живий, і ми мовчки вимкнули б його. Забрати свідомо - з адмінки («забрати»).
      const away = await foreignHookOf(env.telegram.botToken);
      if (away) {
        sharedOff = { why: "foreign", host: away };
        await logEvent("warn", "tgbot", `спільний бот @${BOT_USERNAME}: його вебхук веде на ${away} - не забираю (там бот працює)`);
        return;
      }
    }
    const secret = hookSecret(sharedHookKind());
    await tg.setWebhook(env.telegram.botToken, `${env.appBaseUrl}/api/webhooks/telegram/${secret}`, secret);
    await registerMenu(env.telegram.botToken);
    sharedHookOk = true;
    console.log(`[tgbot] спільний бот @${BOT_USERNAME} (id ${BOT_ID}); webhook зареєстровано`);
  } catch (e: any) { console.error("[tgbot] init: " + e.message); }
}

/**
 * Спільного бота змінили з адмінки (новий токен уже в env). Попередній стає колишнім: публікує далі в
 * канали, де стоїть адміном (новий там не адмін), а його вебхук переходить на адресу власного бота.
 * Спершу новий бот (вебхук, команди, кнопка Mini App, рядки з мертвим токеном того ж бота), потім
 * колишні - щоб кабінет, де лежав старий токен того самого бота, не зачепило як «власного».
 * force - адмін свідомо забирає бота, чий вебхук веде на інший сервіс. Вертає @нік нового бота.
 */
export async function switchSharedBot(prevToken: string, force = false): Promise<string> {
  await rememberFormerShared(prevToken);
  await initTelegramBot({ force });
  await refreshOwnBotWebhooks();
  return BOT_USERNAME;
}

// true, якщо СПІЛЬНИЙ бот на цьому інстансі реально приймає повідомлення. На беті бота з .env свідомо
// лишаємо за продом (інакше бета вкрала б його), тож там DM-фічі живі лише з ботом, якого поставили в
// адмінці беті й чий вебхук цей інстанс справді поставив. Про мертві DM треба казати, а не видавати
// посилання, яке нікуди не веде.
export const sharedBotDmWorks = (): boolean => !!env.telegram.botToken && (!env.beta.telegramWebhookOff || sharedHookOk);
/** Чому спільний бот тут не приймає повідомлень (для кабінету); why "" - приймає або невідомо. */
export const sharedDmState = (): { why: "" | "env" | "foreign" | "dead"; host: string } => sharedBotDmWorks() ? { why: "", host: "" } : { ...sharedOff };

// mode 'add' - «＋ Додати канал»: канал, чий пост перешлють боту, ДОДАЄТЬСЯ до бренду (основний лишається)
export async function createConnectLink(workspaceId: string, userId?: string, mode: "main" | "add" = "main"): Promise<string> {
  const token = await wsBotToken(workspaceId);
  if (!token) throw new Error("Спільний бот не налаштований на сервері");
  // Найкоштовніша частина цього фіксу: раніше кнопка мовчки видавала t.me-посилання, код якого
  // живе в БАЗІ ЦЬОГО інстансу, а сам /start прилітав на ІНШИЙ інстанс (вебхук у прода) - там
  // такого коду немає, тож бот відповідав загальним привітанням. Людина бачила «бот мене ігнорує».
  if (token === env.telegram.botToken && !sharedBotDmWorks()) {
    const st = sharedDmState();
    throw new Error((st.why === "foreign" ? `Спільний бот @${BOT_USERNAME} зараз працює на ${st.host} (туди веде його вебхук), тож тут повідомлень не приймає.`
      : st.why === "dead" ? `Telegram не визнає токен спільного бота @${BOT_USERNAME} (його перевипустили в @BotFather).`
      : "На цьому середовищі спільний бот не приймає повідомлень: той самий бот працює на основному сервісі, і бета його не забирає.")
      + " Адміністратор може дати цьому середовищу окремого спільного бота: Налаштування → Профіль → 🔑 Ключі провайдерів → 🤖 Telegram-бот. Або підключи ВЛАСНОГО бота бренду: @BotFather → /newbot → токен у «⚙️ Розширені налаштування» нижче.");
  }
  // deep-link веде на бота, який реально обслуговує цей воркспейс (власний або спільний)
  let username = BOT_USERNAME;
  if (token !== env.telegram.botToken) { try { username = (await tg.getMe(token)).username || username; } catch { /* фолбек на спільного */ } }
  const code = randomBytes(8).toString("hex");
  await q(`delete from tg_connect where workspace_id=$1`, [workspaceId]); // один активний код на воркспейс
  await q(`insert into tg_connect(code, workspace_id, created_by, mode) values($1,$2,$3,$4)`, [code, workspaceId, userId ?? null, mode]);
  return `https://t.me/${username}?start=${code}`;
}

async function attachChannel(fromId: number, chatId: number, title: string, token: string): Promise<string> {
  const row = token !== env.telegram.botToken
    ? await one<{ workspace_id: string; mode: string }>(`select t.workspace_id, t.mode from tg_connect t join telegram_config c on c.workspace_id=t.workspace_id and c.bot_token=$2 where t.tg_user_id=$1 order by t.created_at desc limit 1`, [fromId, token])
    : await one<{ workspace_id: string; mode: string }>(`select workspace_id, mode from tg_connect where tg_user_id=$1 order by created_at desc limit 1`, [fromId]);
  if (!row) return "Спершу відкрий посилання підключення з кабінету Holos (кнопка «Підключити наш бот»).";
  // перевіряємо членство ТИМ ботом, якому переслали пост (власний або спільний); id бота = префікс токена
  const botId = Number(token.split(":")[0]) || BOT_ID;
  let member: { status: string };
  try { member = await tg.getChatMember(token, String(chatId), botId); }
  catch { return "Не бачу цього каналу. Додай мене адміном у канал і спробуй ще раз."; }
  if (!["administrator", "creator"].includes(member.status)) return "Додай мене АДМІНОМ у канал (з правом публікувати), тоді перешли пост ще раз.";
  // 📣 «＋ Додати канал»: основний канал лишається, цей - ще один у бренді (тим самим ботом)
  if (row.mode === "add") {
    const cur = await one<{ channel_chat_id: string | null; group_chat_id: string | null; bot_token: string | null }>(
      `select channel_chat_id, group_chat_id, bot_token from telegram_config where workspace_id=$1`, [row.workspace_id]);
    if (cur?.channel_chat_id && cur.bot_token === token) {
      const id = String(chatId);
      if (id !== cur.channel_chat_id && id !== cur.group_chat_id)
        await q(`insert into telegram_chat(workspace_id, chat_id, title) values($1,$2,$3)
                 on conflict (workspace_id, chat_id) do update set title=excluded.title`, [row.workspace_id, id, title || null]);
      await q(`delete from tg_connect where workspace_id=$1`, [row.workspace_id]);
      await logEvent("info", "tgbot", `канал додано до бренду: ${title || chatId}`);
      return `✅ Канал «${title || chatId}» додано до бренду. Тепер у композері кабінету й у картці поста тут («👥 Telegram») можна обрати, у які канали піде пост.`;
    }
  }
  await q(`insert into telegram_config(workspace_id, bot_token, channel_chat_id, channel_title, updated_at)
           values($1,$2,$3,$4,now())
           on conflict (workspace_id) do update set bot_token=excluded.bot_token, channel_chat_id=excluded.channel_chat_id, channel_title=excluded.channel_title,
             channel_username = case when telegram_config.channel_chat_id is distinct from excluded.channel_chat_id then null else telegram_config.channel_username end,
             updated_at=now()`,
    [row.workspace_id, token, String(chatId), title || null]);
  await q(`delete from tg_connect where workspace_id=$1`, [row.workspace_id]);
  await logEvent("info", "tgbot", `канал підключено: ${title || chatId}`);
  return `✅ Канал «${title || chatId}» підключено! Пости з кабінету тепер публікуватимуться сюди.`;
}

// ---- DM-асистент: власник, «живий меседж», банк ідей ----

// tg-користувач -> його воркспейс (для DM-асистента). Фолбек на tg_connect, якщо ще не закріплено.
// Власний бот обслуговує ЛИШЕ кабінети, де стоїть саме його токен: інакше чужий бот, якому людина
// написала, діяв би в її кабінеті (читав ідеї, публікував), а власник того бота бачив би все.
async function ownerWorkspace(fromId: number, token: string): Promise<string | null> {
  const own = !sharedLike(token);
  const o = own
    ? await one<{ workspace_id: string; user_id: string | null }>(`select o.workspace_id, o.user_id from tg_owner o join telegram_config c on c.workspace_id=o.workspace_id and c.bot_token=$2 where o.tg_user_id=$1`, [fromId, token])
    : await one<{ workspace_id: string; user_id: string | null }>(`select workspace_id, user_id from tg_owner where tg_user_id=$1`, [fromId]);
  if (o) {
    // 🏢 бот стоїть на бренді, до якого людину вже не пускають (доступ забрали) - назад у її домашній
    const ws = (await homeIfLost(fromId, o.workspace_id, o.user_id)) || o.workspace_id;
    touchWorkspaceActive(ws); // бот - теж активність у кабінеті
    return ws;
  }
  const c = own
    ? await one<{ workspace_id: string }>(`select t.workspace_id from tg_connect t join telegram_config c on c.workspace_id=t.workspace_id and c.bot_token=$2 where t.tg_user_id=$1 order by t.created_at desc limit 1`, [fromId, token])
    : await one<{ workspace_id: string }>(`select workspace_id from tg_connect where tg_user_id=$1 order by created_at desc limit 1`, [fromId]);
  return c?.workspace_id ?? null;
}
async function setOwner(fromId: number, workspaceId: string, chatId: string, userId: string | null = null): Promise<void> {
  await q(`insert into tg_owner(tg_user_id, workspace_id, chat_id, user_id) values($1,$2,$3,$4)
           on conflict (tg_user_id) do update set workspace_id=excluded.workspace_id, chat_id=excluded.chat_id, user_id=excluded.user_id`, [fromId, workspaceId, chatId, userId]);
}

// Відповідь на апдейт іде тим ботом, якому людина написала (liveSend бере його звідси): після зміни
// спільного бота людина може писати ще старому, і відповідь новим ботом опинилась би в іншому чаті.
const viaBot = new AsyncLocalStorage<string>();

// «я переїхав»: колишній спільний бот показує, де тепер нового
const movedButton = (code = ""): tg.TgButton[][] =>
  [[{ text: `➡️ Відкрити @${BOT_USERNAME}`, url: `https://t.me/${BOT_USERNAME}${code ? `?start=${code}` : ""}` }]];
const movedText = (): string =>
  `🔁 Я переїхав: тепер я @${BOT_USERNAME}. Відкрий його й натисни «Start» - там усе те саме: ідеї, щоденник, пости, зведення, застосунок.`;

// «один живий меседж на категорію»: гасить попереднє повідомлення категорії, шле нове, зберігає message_id.
export async function liveSend(workspaceId: string, chatId: string, category: string, text: string, buttons?: tg.TgButton[][]): Promise<void> {
  const cfg = await one<{ bot_token: string | null }>(`select bot_token from telegram_config where workspace_id=$1`, [workspaceId]);
  const row = cfg?.bot_token || "";
  // Ким писати: у відповідь - тим ботом, якому людина написала; першими - власним ботом кабінету, а без
  // нього спільним, за яким колишні спільні (спершу той, що в рядку кабінету): новому боту Telegram не
  // дає писати людині першим, поки вона його не запустила.
  const via = viaBot.getStore();
  const tokens = via ? [via]
    : row && !sharedLike(row) ? [row]
    : [env.telegram.botToken, ...(isFormerShared(row) ? [row] : []), ...[...formerShared.values()].reverse().filter((t) => t !== row)].filter((t) => !!t);
  const prev = await one<{ message_id: string; chat_id: string | null; bot_id: string | null }>(
    `select message_id, chat_id, bot_id from tg_message where workspace_id=$1 and category=$2`, [workspaceId, category]);
  // Попереднє повідомлення категорії гасимо лише в ЙОГО чаті й ТИМ САМИМ ботом: номери повідомлень у
  // кожній розмові з ботом свої, і чужим ботом під тим самим номером видалилось би зовсім інше
  // повідомлення. Записи до цієї версії без bot_id надіслав бот, що тоді писав кабінету: власний, а
  // без нього - спільний із .env.
  const envTok = String(process.env.TELEGRAM_BOT_TOKEN ?? "");
  const prevBot = prev?.bot_id || botIdOf(row && row !== envTok ? row : envTok);
  let lastErr: any = new Error("Спільний бот не налаштований на сервері");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (prev?.message_id && (!prev.chat_id || String(prev.chat_id) === String(chatId)) && prevBot === botIdOf(token))
      await tg.deleteMessage(token, chatId, Number(prev.message_id));
    try {
      // i > 0 - пишемо колишнім спільним ботом, бо нового людина ще не запускала: заодно кличемо перейти
      const r = i > 0
        ? await tg.sendMessage(token, chatId, `${text}\n\n${movedText()}`, [...(buttons || []), ...movedButton()])
        : await tg.sendMessage(token, chatId, text, buttons);
      await q(`insert into tg_message(workspace_id, category, chat_id, message_id, bot_id, updated_at) values($1,$2,$3,$4,$5,now())
               on conflict (workspace_id, category) do update set chat_id=excluded.chat_id, message_id=excluded.message_id, bot_id=excluded.bot_id, updated_at=now()`,
        [workspaceId, category, chatId, r.message_id, botIdOf(token)]);
      return;
    } catch (e: any) {
      lastErr = e;
      if (isFormerShared(token) && deadToken(e)) { await dropFormer(botIdOf(token), "Telegram його не визнає (токен відкликано)"); continue; }
      if (!tg.cantReachUser(e)) throw e; // ліміт, битий текст тощо - інший бот тут не допоможе
    }
  }
  throw lastErr;
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
    [post.id, slot.rubric, PUB_NETS.includes(slot.channel) ? JSON.stringify({ [slot.channel]: { on: true } }) : "{}"]);
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
  const brand = await brandLabel(workspaceId, chatId).catch(() => "");
  const raw = { text: "📝 Опублікувати як є (мій текст без змін)", data: `idea_raw:${r!.id}` };
  const ai = { text: ready ? "✨ Переписати AI (зміст збережу)" : "✨ Зробити пост з думки (AI)", data: `idea_post:${r!.id}` };
  await liveSend(workspaceId, chatId, "capture",
    (ready ? `📝 Схоже на готовий пост. Зберіг у Банк ідей${brand ? ` бренду «${brand}»` : ""}:\n«${text.slice(0, 140)}…»\n\nОпублікувати як є - текст піде без змін.`
           : `💡 Збережено в Банк ідей${brand ? ` бренду «${brand}»` : ""}:\n«${text.slice(0, 140)}»`),
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
const KB_NEW = "✍️ Новий пост", KB_APP = "🚀 Кабінет", KB_IDEAS = "💡 Ідеї", KB_DIARY = "📔 Щоденник", KB_PLAN = "📅 План", KB_DIGEST = "☀️ Зведення", KB_MONTAGE = "🎬 Монтаж", KB_COMMENTS = "💬 Коменти";
// 🏢 кнопка бренду - з назвою поточного: видно просто над полем вводу, куди зараз ідуть пости
const KB_BRAND = "🏢 ";
async function registerMenu(token: string): Promise<void> {
  await tg.setMyCommands(token, [
    { command: "post", description: "Новий пост: текст, фото, канали, публікація" },
    { command: "montage", description: "Змонтувати сторіс чи рілс із кліпів (з субтитрами)" },
    { command: "plan", description: "Що заплановано найближчим часом" },
    { command: "idea", description: "Банк ідей" },
    { command: "diary", description: "Записати в щоденник" },
    { command: "digest", description: "Зведення дня" },
    { command: "drafts", description: "Чернетки: відкрити, дописати, перенести в інший бренд" },
    { command: "comments", description: "Коментарі людей без відповіді: відповісти просто звідси" },
    { command: "brand", description: "Обрати бренд (якщо їх кілька)" },
  ]);
  await tg.setChatMenuButton(token, MINIAPP_URL, "Кабінет");
}
const mainKeyboard = (brand = ""): tg.TgKbButton[][] => [
  [{ text: KB_NEW }, { text: KB_COMMENTS }, { text: KB_MONTAGE }, { text: KB_APP, web_app: { url: MINIAPP_URL } }],
  [{ text: KB_PLAN }, { text: KB_IDEAS }, { text: KB_DIARY }, { text: KB_DIGEST }],
  ...(brand ? [[{ text: KB_BRAND + brand.slice(0, 30) }]] : []),
];

// ---- 🏢 бренд: з яким кабінетом працює бот ----
const brandsOf = (fromId: number, token: string): Promise<BotBrands> => botBrands(fromId, !sharedLike(token), token);
/** Назва для кнопки меню: лише коли брендів кілька (одному бренду кнопка ні до чого). */
async function kbBrand(fromId: number, token: string): Promise<string> {
  const b = await brandsOf(fromId, token).catch(() => null);
  return b && b.list.length > 1 ? b.list.find((x) => x.id === b.current)?.title || "" : "";
}
async function sendBrandPicker(fromId: number, chatId: string, token: string): Promise<void> {
  const b = await brandsOf(fromId, token);
  if (!b.current) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos (кнопка «Підключити наш бот»)."); return; }
  const cur = b.list.find((x) => x.id === b.current);
  if (!b.linked) {
    await tg.sendMessage(token, chatId, `🏢 Зараз я працюю з брендом «${cur?.title || "кабінет"}».\n\nЩоб перемикати бренди, мені треба знати твій акаунт Holos: відкрий кабінет → Налаштування → Канали → «Підключити наш бот» і натисни Start. Після цього /brand покаже всі твої бренди.`,
      [[{ text: "🌐 Відкрити Канали", url: `${env.appBaseUrl}/app#/settings/channels` }]]);
    return;
  }
  if (b.list.length < 2) { await tg.sendMessage(token, chatId, `🏢 У тебе один бренд - «${cur?.title || "кабінет"}», я працюю з ним. Новий бренд додається в кабінеті: меню аватара → «＋ Додати бренд».`); return; }
  await liveSend(b.current, chatId, "brand", `🏢 **З яким брендом працювати?**\n\nЗараз: «${cur?.title || "?"}». Нові пости, монтаж, ідеї, щоденник і ранкове зведення - у вибраному бренді. Відкрита сесія монтажу переїде разом із брендом.`,
    b.list.map((x) => [{ text: `${x.id === b.current ? "✓ " : ""}${x.title}`.slice(0, 60), data: `br:${x.id.slice(0, 8)}` }]));
}
async function switchBrand(fromId: number, chatId: string, token: string, short: string): Promise<string> {
  const b = await brandsOf(fromId, token);
  const target = pickBrand(b, short);
  if (!target) return "Цього бренду в тебе нема";
  if (target.id === b.current) return `Уже працюю з «${target.title}»`;
  await setBotBrand(fromId, target.id);
  const mt = b.current ? await moveMtSession(b.current, target.id).catch(() => "none" as const) : "none";
  const note = mt === "moved" ? "\n🎬 Сесію монтажу перенесено сюди ж - кліпи на місці."
    : mt === "busy" ? "\n🎬 Монтаж у попередньому бренді ще йде - готовий пост можна буде перенести кнопкою «🏢» у його картці."
    : mt === "taken" ? "\n🎬 Тут уже є відкрита сесія монтажу - попередня лишилась у тому бренді."
    : "";
  await tg.sendWithKeyboard(token, chatId, `✅ Тепер працюю з брендом «${target.title}».\nНові пости, монтаж, ідеї, щоденник і зведення - тут. Повернутись: /brand чи кнопка «🏢» унизу.${note}`, mainKeyboard(target.title));
  await logEvent("info", "tgbot", `бот перемкнуто на інший бренд (${mt === "moved" ? "з сесією монтажу" : "без сесії монтажу"})`, { ws: target.id });
  return "";
}

// 📝 Чернетки бренду, що ще нікуди не вийшли. Картка поста в чаті живе одним повідомленням і замінюється
// наступною - тож до чернетки, створеної годину тому (скажімо, рілса з монтажу), з бота було не дістатись:
// ні дописати, ні перенести в інший бренд.
async function sendDrafts(ws: string, chatId: string): Promise<void> {
  const rows = await q<{ id: string; content: string; format: string | null }>(
    `select p.id, p.content, p.format from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where s.workspace_id=$1 and p.stage='final' and coalesce(p.review,'') <> 'archived'
        and not exists (select 1 from telegram_publish x where x.post_id=p.id and x.status='sent')
        and not exists (select 1 from threads_publish x where x.post_id=p.id and x.status='sent')
        and not exists (select 1 from meta_publish x where x.post_id=p.id and x.status='sent')
        and not exists (select 1 from linkedin_publish x where x.post_id=p.id and x.status='sent')
      order by p.created_at desc limit 8`, [ws]);
  const brand = await brandLabel(ws, chatId).catch(() => "");
  if (!rows.length) { await liveSend(ws, chatId, "drafts", `📝 Чернеток нема${brand ? ` у бренді «${brand}»` : ""}. /post - написати новий.`); return; }
  await liveSend(ws, chatId, "drafts", `📝 **Чернетки**${brand ? ` · 🏢 ${brand}` : ""} - що ще нікуди не вийшло. Тапни, щоб відкрити картку:`,
    rows.map((r) => [{ text: `${r.format === "reel" ? "🎬" : r.format === "story" ? "⚡" : "✍"} ${(r.content.split("\n").find((x) => x.trim()) || "(без тексту)").trim().slice(0, 44)}`, data: `cc:${r.id}` }]));
}

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
    return `🗓 **${fmt.format(new Date(r.scheduled_at))}** · ${nets.join(", ") || "без каналів"}\n${head.slice(0, 90)}`;
  });
  // кнопка веде в композер того самого поста - звідти можна перенести час або опублікувати одразу
  const buttons = rows.slice(0, 4).map((r) => [{ text: `✍ ${fmt.format(new Date(r.scheduled_at))}`, data: `cc:${r.post_id}` }]);
  const brand = await brandLabel(ws, chatId).catch(() => "");
  await liveSend(ws, chatId, "plan", `📅 **Найближчі публікації**${brand ? ` · 🏢 ${brand}` : ""}\n\n${lines.join("\n\n")}`, buttons);
}

export async function handleUpdate(update: any, tokenOverride?: string): Promise<void> {
  const token = tokenOverride || env.telegram.botToken; if (!token) return;
  await viaBot.run(token, () => handleUpdateIn(update, token));
  // колишній спільний бот обробив, що просили (нічого не губиться), і раз на добу кличе перейти
  const from = update?.callback_query?.from?.id ?? update?.message?.from?.id;
  const chat = update?.callback_query?.message?.chat ?? update?.message?.chat;
  if (from && isFormerShared(token) && (!chat?.type || chat.type === "private")) await nudgeMoved(token, String(chat?.id ?? from), from);
}

// Колишній спільний бот: підключення (/start, пересланий пост каналу, @канал) - уже через нового, бо
// кабінет має перейти на нього; решту (ідеї, щоденник, кнопки старих повідомлень) обробляє як раніше.
const movedNudged = new Map<number, number>(); // tg id → коли нагадували
async function nudgeMoved(token: string, chatId: string, fromId: number): Promise<void> {
  if (Date.now() - (movedNudged.get(fromId) || 0) < 24 * 3600_000) return;
  movedNudged.set(fromId, Date.now());
  await tg.sendMessage(token, chatId, `${movedText()} Тут я ще відповідаю, але сповіщення й усе нове - вже там.`, movedButton()).catch(() => {});
}
async function movedNotice(token: string, chatId: string, fromId: number, msg: any, text: string): Promise<boolean> {
  const fwd = msg.forward_origin?.type === "channel" || msg.forward_from_chat?.type === "channel";
  if (text.startsWith("/start")) {
    // код підключення кабінету не привʼязаний до бота - той самий код відкриється в новому
    const code = text.split(/\s+/)[1] || "";
    const ok = /^[0-9a-f]{16}$/.test(code);
    await tg.sendMessage(token, chatId, movedText() + (ok ? "\n\nПосилання підключення відкриється вже в ньому." : ""), movedButton(ok ? code : ""));
  } else if (fwd || /^@\w{4,}$/.test(text)) {
    await tg.sendMessage(token, chatId, `🔁 Канали тепер підключає @${BOT_USERNAME}. У Holos: Налаштування → Канали → «Підключити наш бот» (відкриє його), далі додай @${BOT_USERNAME} АДМІНОМ у канал і перешли пост уже йому. Попередній бот може лишатись у каналі - він просто більше не знадобиться.`, movedButton());
  } else return false;
  movedNudged.set(fromId, Date.now());
  return true;
}

async function handleUpdateIn(update: any, token: string): Promise<void> {
  try {
    if (update?.callback_query) { await handleCallback(update.callback_query, token); return; }
    const msg = update?.message; if (!msg || !msg.from) return;
    // бот говорить лише в особистих повідомленнях. У групі, куди він публікує, Telegram надсилає йому
    // службові події й відповіді на його пости - раніше бот відповідав на них у групі, а текст власника
    // з групи тихо падав у щоденник і цитувався там же
    if (msg.chat?.type && msg.chat.type !== "private") return;
    const fromId = msg.from.id; const chatId = String(msg.chat?.id ?? fromId); const text = String(msg.text || "").trim();
    if (isFormerShared(token) && await movedNotice(token, chatId, fromId, msg, text)) return;

    // /start [code] — вітання + (за наявності коду) закріплення власника воркспейсу
    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1] || "";
      if (code) {
        // код власного бота відкриває лише кабінет цього бота (підключення завжди йде тим ботом, що видав посилання)
        // Код разовий і живе добу: ним підключається ОДНА людина (повтор тієї ж - можна). Раніше
        // посилання, що кудись потрапило, назавжди робило власником кабінету будь-кого, хто його відкрив.
        const own = token !== env.telegram.botToken;
        const row = await one<{ workspace_id: string; created_by: string | null }>(
          `update tg_connect t set tg_user_id=$2 where t.code=$1 and (t.tg_user_id is null or t.tg_user_id=$2)
             and t.created_at > now() - interval '1 day'
             ${own ? "and exists (select 1 from telegram_config c where c.workspace_id=t.workspace_id and c.bot_token=$3)" : ""}
           returning t.workspace_id, t.created_by`, own ? [code, fromId, token] : [code, fromId]);
        if (row) {
          await setOwner(fromId, row.workspace_id, chatId, row.created_by);
          const kb = await kbBrand(fromId, token);
          await tg.sendWithKeyboard(token, chatId, (kb ? `🏢 Бренд: «${kb}» (інший - /brand)\n\n` : "") + "Вітаю! 🤝 Я тепер твій контент-помічник.\n\n• Надішли будь-яку думку — збережу як ідею в Банк.\n• /idea — твої ідеї, зробити з них пост у 1 тап.\n• /post — написати пост прямо тут: текст, фото, канали, публікація зараз або за розкладом.\n• 🎬 /montage — надішли кліпи й голосове, я змонтую сторіс чи рілс із субтитрами.\n• 📔 Двічі на день спитаю, що відбувалося: відповідай текстом, ГОЛОСОМ, фото чи відео — усе ляже в щоденник і стане живим джерелом постів. /diary — спитати зараз.\n\nЩоб публікувати у свій канал: додай мене АДМІНОМ у канал і перешли сюди будь-який пост із нього.", mainKeyboard(kb));
          await registerMenu(token);
          return;
        }
      }
      // Код був, але не знайшовся - найчастіше він створений на ІНШОМУ інстансі (бета/прод мають
      // окремі бази). Раніше це виглядало як «бот просто привітався» і не лишало жодного сліду.
      if (code) {
        await logEvent("warn", "tgbot", `/start із невідомим кодом ${code.slice(0, 8)}… (tg ${fromId}) - код створено на іншому інстансі або застарів`);
        await tg.sendMessage(token, chatId, "Це посилання підключення не діє: код або застарів, або створений в іншому середовищі (бета й прод мають окремі бази). Відкрий Holos і натисни «Підключити наш бот» ще раз.");
        return;
      }
      // людина вже привʼязана (напр., прийшла з попереднього спільного бота) - просто вітаємо з кнопками
      if (await ownerWorkspace(fromId, token)) {
        const kb = await kbBrand(fromId, token);
        await tg.sendWithKeyboard(token, chatId, (kb ? `🏢 Бренд: «${kb}» (інший - /brand)\n\n` : "") + "Вітаю! 🤝 Кабінет уже підключено.\n\n• Надішли будь-яку думку — збережу як ідею.\n• /post — новий пост, /montage — сторіс чи рілс із кліпів, /idea — ідеї, /diary — щоденник, /plan — що заплановано.\n\nЩоб публікувати у свій канал через мене: додай мене АДМІНОМ у канал і перешли сюди будь-який пост із нього.", mainKeyboard(kb));
        return;
      }
      await tg.sendMessage(token, chatId, "Привіт! Щоб під'єднати мене до твого кабінету, відкрий посилання «Підключити наш бот» у Holos.");
      return;
    }

    // переслали пост каналу ПІД ЧАС підключення (є свіжий код) - підключаємо канал, навіть якщо в пості
    // фото чи відео (раніше такий пост ішов у щоденник). Нове поле forward_origin (Bot API 7) і старе.
    {
      const fwd = msg.forward_origin?.type === "channel" ? msg.forward_origin.chat
        : msg.forward_from_chat?.type === "channel" ? msg.forward_from_chat : null;
      if (fwd && (msg.photo || msg.video || msg.document || msg.animation)) {
        const pending = await one(`select 1 from tg_connect where tg_user_id=$1 and created_at > now() - interval '1 day'`, [fromId]);
        if (pending) { await tg.sendMessage(token, chatId, await attachChannel(fromId, fwd.id, fwd.title, token)); return; }
      }
    }

    // 🏢 /brand чи кнопка бренду в меню - вибір бренду, з яким працює бот
    if (text.toLowerCase().startsWith("/brand") || (text.startsWith(KB_BRAND) && text.length > KB_BRAND.length)) {
      await sendBrandPicker(fromId, chatId, token);
      return;
    }

    // кнопки постійної клавіатури приходять звичайним текстом - зводимо їх до тих самих дій
    if (text === KB_NEW || text === KB_IDEAS || text === KB_DIARY || text === KB_PLAN || text === KB_DIGEST || text === KB_MONTAGE || text === KB_COMMENTS || text.toLowerCase().startsWith("/comments")) {
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos."); return; }
      // 💬 коментарі людей без відповіді - картка з чернеткою (поточний бренд, а коли там порожньо - інший)
      if (text === KB_COMMENTS || text.toLowerCase().startsWith("/comments")) { await showComments(fromId, chatId, ws); return; }
      if (text === KB_MONTAGE) { await startMt(ws, chatId); return; }
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
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos."); return; }
      const body = text.slice(5).trim();
      if (!body) { await cmp.expect(ws, "", "text", chatId); await tg.sendMessage(token, chatId, "📝 Надішли текст поста наступним повідомленням."); return; }
      await openCompose(ws, chatId, await cmp.createBotDraft(ws, body), token);
      return;
    }

    // 🎬 /montage — змонтувати сторіс чи рілс із кліпів, надісланих сюди ж
    if (text.toLowerCase().startsWith("/montage")) {
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos."); return; }
      await startMt(ws, chatId);
      return;
    }

    // /menu — повернути кнопки (якщо юзер їх колись сховав)
    if (text.toLowerCase().startsWith("/menu")) {
      await registerMenu(token);
      await tg.sendWithKeyboard(token, chatId, "Кнопки на місці 👇", mainKeyboard(await kbBrand(fromId, token)));
      return;
    }

    // /idea — банк ідей
    if (text.toLowerCase().startsWith("/idea")) {
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos (кнопка «Підключити наш бот»)."); return; }
      await sendIdeaList(ws, chatId);
      return;
    }

    // /drafts — чернетки бренду: відкрити картку (дописати, опублікувати, перенести в інший бренд)
    if (text.toLowerCase().startsWith("/drafts")) {
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos."); return; }
      await sendDrafts(ws, chatId);
      return;
    }

    // /plan — черга публікацій (запланувати з бота можна було й раніше, побачити чергу - ніде)
    if (text.toLowerCase().startsWith("/plan")) {
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos."); return; }
      await sendPlan(ws, chatId);
      return;
    }

    // /digest — надіслати ранкове зведення негайно (перевірка)
    if (text.toLowerCase().startsWith("/digest")) {
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos."); return; }
      await sendDigestNow(ws, chatId);
      return;
    }

    // /diary — питання щоденника негайно (перевірка без очікування 13:00/20:00)
    if (text.toLowerCase().startsWith("/diary")) {
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos."); return; }
      await sendDiaryNow(ws, chatId);
      return;
    }

    // 💬 «✍ Свій текст» під коментарем: наступне повідомлення - відповідь людині під постом
    if (text && await commentText(fromId, chatId, text)) return;

    // 📝 якщо композер чекає на конкретну відповідь (текст/фото/дату) - вона має пріоритет над
    // щоденником і банком ідей: людина щойно натиснула кнопку й відповідає саме на неї
    {
      const wsC = await ownerWorkspace(fromId, token);
      // 🖼 решта фото АЛЬБОМУ, перше з якого вже стало обкладинкою: Telegram шле альбом окремими
      // повідомленнями, тож без цього кадри 2..N пішли б звичайним шляхом (у щоденник) замість каруселі
      if (wsC && msg.media_group_id && albumPosts.has(String(msg.media_group_id)) && msg.photo?.length) {
        albumPhoto(wsC, chatId, msg, token);
        return;
      }
      if (wsC) {
        const st = await cmp.getCompose(wsC);
        if (st.await && await composeReply(wsC, chatId, msg, st, token)) return;
        // 🎬 відкрита сесія монтажу: відео, фото й голосові - у монтаж, а не в щоденник
        const mt = await getMt(wsC);
        if (mt && await montageMessage(wsC, chatId, msg, mt, token)) return;
      }
    }

    // 🎙 голосове → Whisper → запис у щоденник (голос = завжди щоденник: надиктовані історії дня)
    if (msg.voice?.file_id) {
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos."); return; }
      try {
        const f = await tg.getFileBuffer(token, msg.voice.file_id);
        const heard = await transcribeVoice(f.buffer, "voice.ogg", ws);
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
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos."); return; }
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
    const fwdChan = msg.forward_origin?.type === "channel" ? msg.forward_origin.chat
      : msg.forward_from_chat?.type === "channel" ? msg.forward_from_chat : null;
    if (fwdChan) {
      await tg.sendMessage(token, chatId, await attachChannel(fromId, fwdChan.id, fwdChan.title, token));
      return;
    }
    // @username каналу -> підключення каналу; якщо не канал — впаде в захоплення ідеї
    if (text.startsWith("@")) {
      try { const chat = await tg.getChat(token, text); if (chat.type === "channel") { await tg.sendMessage(token, chatId, await attachChannel(fromId, chat.id, chat.title || text, token)); return; } } catch { /* не канал */ }
    }

    // будь-який інший текст: відповідь на відкрите питання щоденника → запис дня; інакше → ідея в Банк
    if (text && !text.startsWith("/")) {
      const ws = await ownerWorkspace(fromId, token);
      if (!ws) { await tg.sendMessage(token, chatId, "Спершу під'єднай мене з кабінету Holos (кнопка «Підключити наш бот»), тоді я збережу твої ідеї."); return; }
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
  const card = await cmp.composeCard(ws, postId, await brandLabel(ws, chatId).catch(() => ""));
  if (!card) { await cmp.clearCompose(ws); await tg.sendMessage(token, chatId, "Пост не знайдено - можливо, його видалили в кабінеті."); return; }
  await cmp.expect(ws, postId, null, chatId);
  await liveSend(ws, chatId, "compose", card.text, [...card.buttons, [{ text: "🌐 Відкрити в кабінеті", url: postDeepLink(postId) }]]);
}

// 🖼 альбом → карусель. Telegram шле альбом окремими повідомленнями з одним media_group_id, і
// доставити їх може ПАРАЛЕЛЬНО й не по порядку. Тому фото альбому спершу збираються (1,5 с тиші
// після останнього), а тоді обробляються за message_id - тобто в тому порядку, в якому людина їх
// обрала: перше замінює фото поста й стає обкладинкою, решта - кадрами. Живе 2 хв.
type AlbumItem = { mid: number; fileId: string; size: number };
const albumPosts = new Map<string, { postId: string; until: number; items: AlbumItem[]; timer?: ReturnType<typeof setTimeout> }>();
// Черга й лічильник кадрів - на ПОСТ, а не на альбом: вибір понад 10 фото Telegram ділить на кілька
// альбомів із різними id, і раніше перше фото другого альбому знову «ставало обкладинкою» й стирало
// вже додані кадри (карусель виходила перемішаною). Тепер другий альбом того ж поста продовжує перший.
const albumChains = new Map<string, { busy: Promise<void>; done: number; until: number }>();
function albumPhoto(ws: string, chatId: string, msg: any, token: string, postId?: string): boolean {
  const key = String(msg.media_group_id);
  const now = Date.now();
  for (const [k, v] of albumPosts) if (v.until < now) albumPosts.delete(k);
  for (const [k, v] of albumChains) if (v.until < now) albumChains.delete(k);
  let a = albumPosts.get(key);
  if (!a) {
    if (!postId) return false;
    a = { postId, until: now + 120_000, items: [] };
    albumPosts.set(key, a);
  }
  const chain = albumChains.get(a.postId) || { busy: Promise.resolve(), done: 0, until: 0 };
  chain.until = now + 120_000;
  albumChains.set(a.postId, chain);
  const ph = msg.photo[msg.photo.length - 1];
  a.items.push({ mid: Number(msg.message_id) || 0, fileId: ph.file_id, size: ph.file_size || 0 });
  const al = a;
  if (al.timer) clearTimeout(al.timer);
  al.timer = setTimeout(() => {
    const batch = al.items.splice(0).sort((x, y) => x.mid - y.mid);
    chain.busy = chain.busy.then(async () => {
      for (const it of batch) {
        try {
          if (it.size > 19.5 * 1024 * 1024) continue;
          const f = await tg.getFileBuffer(token, it.fileId);
          if (chain.done === 0) await cmp.setAlbumCover(ws, al.postId, f.buffer);
          else await cmp.appendPhoto(ws, al.postId, f.buffer, "image/jpeg", "tg-post.jpg");
          chain.done++;
        } catch (e: any) { await logEvent("warn", "tgbot", `кадр альбому не додався: ${e.message}`, { ws }); }
      }
      await openCompose(ws, chatId, al.postId, token); // картку оновлюємо раз на альбом, не на кожен кадр
    }).catch(() => {});
  }, 1500);
  return true;
}

// відповідь на те, чого композер зараз чекає; true = повідомлення оброблено
async function composeReply(ws: string, chatId: string, msg: any, st: { postId: string | null; await: string | null }, token: string): Promise<boolean> {
  const text = String(msg.text || "").trim();
  if (st.await === "photo") {
    // 🎬 відео (або відео файлом-документом) - стає відео поста замість фото
    const vid = msg.video || (msg.document && /^video\//.test(String(msg.document.mime_type || "")) ? msg.document : null);
    if (vid) {
      if ((vid.file_size || 0) > 19.5 * 1024 * 1024) {
        await tg.sendMessage(token, chatId, "⚠️ Telegram не віддає ботам файли понад 20 МБ. Відкрий «🚀 Кабінет» (Mini App) і натисни «🎬 Відео» в пості - там великі файли вантажаться частинами.");
        return true;
      }
      try {
        const f = await tg.getFileBuffer(token, vid.file_id);
        await cmp.attachVideo(ws, st.postId!, f.buffer, vid.file_name || "video.mp4");
      } catch (e: any) { await tg.sendMessage(token, chatId, "⚠️ " + String(e.message).slice(0, 200)); return true; }
      await openCompose(ws, chatId, st.postId!, token);
      return true;
    }
    const ph = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
    if (!ph) return false;                       // прислали не фото - хай іде звичайним шляхом
    // альбом у відповідь на «Фото чи альбом» → карусель (див. albumPhoto)
    if (msg.media_group_id) return albumPhoto(ws, chatId, msg, token, st.postId!);
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
    case "cp":  await cmp.expect(ws, postId, "photo", chatId); await tg.answerCallbackQuery(token, cbq.id, "Надішли фото чи відео"); await tg.sendMessage(token, chatId, "🖼 Надішли фото чи відео наступним повідомленням. Кілька фото альбомом - вийде карусель (до 10). Відео - до 20 МБ (межа Telegram для ботів); більші - через «🚀 Кабінет»."); return true;
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
    case "cac": {
      // 👥 які Сторінки / профілі / канали мережі отримають пост
      const c = await cmp.accountsCard(ws, postId, arg);
      await tg.answerCallbackQuery(token, cbq.id);
      if (c) await liveSend(ws, chatId, "compose", c.text, c.buttons); else await openCompose(ws, chatId, postId, token);
      return true;
    }
    case "cad": {
      // 📣 «＋ Додати канал» з бота: код підключення в режимі «додати» для бренду, з яким зараз працює бот;
      // далі людина пересилає пост каналу чи пише @назву - attachChannel знайде цей код і ДОДАСТЬ канал
      const fromId = Number(cbq.from?.id);
      const owner = await one<{ user_id: string | null }>(`select user_id from tg_owner where tg_user_id=$1`, [fromId]);
      await q(`delete from tg_connect where workspace_id=$1`, [ws]);
      await q(`insert into tg_connect(code, workspace_id, tg_user_id, created_by, mode) values($1,$2,$3,$4,'add')`, [randomBytes(8).toString("hex"), ws, fromId, owner?.user_id ?? null]);
      await cmp.stopExpecting(ws); // інакше «@канал» пішов би текстом поста, якщо бот ще чекав текст
      let me = BOT_USERNAME;
      if (!sharedLike(token)) { try { me = (await tg.getMe(token)).username || me; } catch { /* лишається спільний */ } }
      await tg.answerCallbackQuery(token, cbq.id);
      const bl = await brandLabel(ws, chatId).catch(() => "");
      await liveSend(ws, chatId, "compose", `📣 **Ще один канал чи група${bl ? ` у бренд «${bl}»` : " у бренд"}**

1. Додай мене (@${me}) адміністратором у канал - з правом публікувати.
2. Перешли сюди будь-який пост із цього каналу. Або надішли його @назву, якщо канал публічний.

Основний канал лишається, новий стане ще одним - і в картці поста зʼявиться галочка для нього.`, [[{ text: "‹ Назад до поста", data: `cc:${postId}` }]]);
      return true;
    }
    case "cat": {
      const [, , net, suffix] = data.split(":");
      const why = await cmp.toggleAccount(ws, postId, net, suffix);
      await tg.answerCallbackQuery(token, cbq.id, why || undefined);
      const c = await cmp.accountsCard(ws, postId, net);
      if (c) await liveSend(ws, chatId, "compose", c.text, c.buttons);
      return true;
    }
    case "cb": {
      // 🏢 у який бренд цей пост (чернетку, що ще нікуди не вийшла, можна перенести)
      const b = await brandsOf(Number(cbq.from?.id), token);
      await tg.answerCallbackQuery(token, cbq.id);
      if (b.list.length < 2) { await openCompose(ws, chatId, postId, token); return true; }
      const rows: tg.TgButton[][] = b.list.map((x) => [{ text: `${x.id === ws ? "✓ " : ""}${x.title}`.slice(0, 60), data: `cbm:${postId}:${x.id.slice(0, 8)}` }]);
      rows.push([{ text: "‹ Назад", data: `cc:${postId}` }]);
      await liveSend(ws, chatId, "compose", "🏢 **У який бренд цей пост?**\n\nЧернетка переїде разом із фото чи відео. Мережі - ті, що підключені в новому бренді (версії тексту під мережі складуться заново його голосом). Бот теж перемкнеться на цей бренд.", rows);
      return true;
    }
    case "cbm": {
      const fromId = Number(cbq.from?.id);
      const b = await brandsOf(fromId, token);
      const target = pickBrand(b, arg);
      if (!target) { await tg.answerCallbackQuery(token, cbq.id, "Цього бренду в тебе нема"); return true; }
      if (target.id === ws) { await tg.answerCallbackQuery(token, cbq.id, "Пост уже в цьому бренді"); await openCompose(ws, chatId, postId, token); return true; }
      const r = await moveDraft(postId, ws, target.id);
      if (!r.ok) { await tg.answerCallbackQuery(token, cbq.id, r.error.slice(0, 190)); await openCompose(ws, chatId, postId, token); return true; }
      await tg.answerCallbackQuery(token, cbq.id, `Перенесено в «${target.title}»`.slice(0, 190));
      if (b.current !== target.id) await setBotBrand(fromId, target.id);
      await cmp.stopExpecting(ws);
      await logEvent("info", "tgbot", "чернетку перенесено в інший бренд з бота", { ws: target.id });
      await tg.sendWithKeyboard(token, chatId, `✅ Чернетку перенесено в «${target.title}», і я тепер працюю з ним.`, mainKeyboard(target.title));
      await openCompose(target.id, chatId, postId, token);
      return true;
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

const repTapped = new Map<string, number>();
// натискання inline-кнопок (tokenOverride = власний бот воркспейсу)
async function handleCallback(cbq: any, tokenOverride?: string): Promise<void> {
  const token = tokenOverride || env.telegram.botToken;
  const fromId = cbq.from?.id; const chatId = String(cbq.message?.chat?.id ?? fromId); const data = String(cbq.data || "");
  // 🔔 кнопки сповіщення про збій («✓ Вирішено», «🔕 Тиша») - лише адміну, перевіряє alerts.ts
  if (data.startsWith("al:")) {
    const { alertCallback } = await import("./alerts.js");
    await tg.answerCallbackQuery(token, cbq.id, (await alertCallback(data, Number(fromId)).catch(() => "")) || undefined);
    return;
  }
  // 💬 коментарі людей: кнопки картки (рядок сповіщення каже, чий він і в якому бренді)
  if (data.startsWith("cm:")) {
    try { await commentCallback(data, cbq, token); }
    catch (e: any) { await tg.answerCallbackQuery(token, cbq.id, ("⚠️ " + String(e?.message || e)).slice(0, 180)).catch(() => {}); }
    return;
  }
  // 🏢 вибір бренду з /brand
  if (data.startsWith("br:")) {
    const why = await switchBrand(Number(fromId), chatId, token, data.slice(3)).catch((e: any) => String(e?.message || e).slice(0, 150));
    await tg.answerCallbackQuery(token, cbq.id, why || "Готово");
    return;
  }
  const active = await ownerWorkspace(fromId, token);
  if (!active) { await tg.answerCallbackQuery(token, cbq.id, "Спершу під'єднай кабінет Holos"); return; }
  // кнопка зі старого повідомлення після перемикання бренду - діє в бренді свого запису (якщо людина має туди доступ)
  const who = await one<{ user_id: string | null }>(`select user_id from tg_owner where tg_user_id=$1`, [fromId]);
  const ws = await brandOfCallback(data, active, who?.user_id || null, !sharedLike(token), token);
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
    if (await montageCallback(ws, chatId, data, cbq, token, (pid) => viaBot.run(token, () => openCompose(ws, chatId, pid, token)))) return;
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
      const postId = data.slice("rep:".length);
      // подвійний натиск давав ДВА повтори (два нові пости й два слоти) - другий натиск ігноруємо
      const last = repTapped.get(postId) || 0;
      if (Date.now() - last < 10 * 60_000) { await tg.answerCallbackQuery(token, cbq.id, "Повтор уже заплановано"); return; }
      repTapped.set(postId, Date.now());
      await tg.answerCallbackQuery(token, cbq.id, "Готую повтор…");
      const post = await one<{ run_id: string; content: string; image_prompt: string | null; rubric: string | null; media_id: string | null }>(
        `select p.run_id, p.content, p.image_prompt, p.rubric, p.media_id from post p
           join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
         where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
      if (!post) { await tg.sendMessage(token, chatId, "Пост не знайдено."); return; }
      const fresh = await repeatVariant(ws, post.content);
      const np = await one<{ id: string }>(
        `insert into post(run_id, stage, content, image_prompt, rubric, media_id, channels, repeat_of)
         values($1,'final',$2,$3,$4,$5,$6::jsonb,$7) returning id`,
        [post.run_id, fresh, post.image_prompt, post.rubric, post.media_id, JSON.stringify({ threads: { on: true } }), postId]);
      const when = new Date(Date.now() + 48 * 3600e3);
      await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [np!.id, when.toISOString()]);
      const tz = (await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [ws]))?.content || "Europe/Kyiv";
      await tg.sendMessage(token, chatId, `🔁 Повтор заплановано на ${when.toLocaleString("uk", { timeZone: tz })} (свіжий гачок, та сама суть - покажеться іншій аудиторії).`);
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
      await cmp.masterChanged(ws, postId, rewritten);
      const mid = cbq.message?.message_id;
      const text = `✅ Оновлена чернетка:\n\n${rewritten.slice(0, 3500)}`;
      if (mid) await tg.editMessageText(token, chatId, mid, text, draftButtons(postId));
      else await tg.sendMessage(token, chatId, text, draftButtons(postId));
      return;
    }
    if (data.startsWith("pub:")) {
      const postId = data.slice("pub:".length);
      // стара кнопка могла лишитись у чаті після перепідключення до іншого бренду - лише свій пост
      if (!(await cmp.loadPost(ws, postId))) { await tg.answerCallbackQuery(token, cbq.id, "Пост не знайдено"); return; }
      await tg.answerCallbackQuery(token, cbq.id, "Публікую…");
      // вмикаємо Telegram, не чіпаючи решти його налаштувань (обрані канали, свій текст)
      await q(`update post set channels = jsonb_set(coalesce(channels, '{}'::jsonb), '{telegram}', coalesce(channels->'telegram', '{}'::jsonb) || '{"on":true}'::jsonb) where id=$1`, [postId]);
      const results = await publishPostToChannels(ws, postId);
      const ok = results.filter((r) => r.status === "sent").map((r) => pubLabel(r));
      const err = results.filter((r) => r.status === "error");
      if (ok.length) await tg.sendMessage(token, chatId, "✈️ Опубліковано: " + ok.join(", "));
      else await tg.sendMessage(token, chatId, "⚠️ Не вдалося: " + (err.map((e) => `${pubLabel(e)} — ${e.error}`).join("; ") || "немає підключеного каналу") + ".\nПідключи канал: додай мене АДМІНОМ у свій канал і перешли сюди пост із нього.");
      return;
    }
    await tg.answerCallbackQuery(token, cbq.id);
  } catch (e: any) {
    // більшість кнопок уже відповіли Telegram («Генерую…») до роботи - повторна відповідь на той самий
    // натиск мовчки ігнорується, тож причину пишемо ПОВІДОМЛЕННЯМ (інакше людина не бачила нічого)
    await tg.answerCallbackQuery(token, cbq.id, "Помилка: " + String(e.message).slice(0, 150)).catch(() => {});
    await tg.sendMessage(token, chatId, "⚠️ Не вийшло: " + String(e.message).slice(0, 300)).catch(() => {});
    await logEvent("error", "tgbot", "callback: " + e.message);
  }
}
