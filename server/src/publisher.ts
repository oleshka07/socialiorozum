// Спільна публікація поста в усі обрані мережі (composer «Опублікувати» + плановий автопостер).
import { q, one } from "./db.js";
import { env } from "./env.js";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as tg from "./telegram.js";
import * as threads from "./threads.js";
import * as meta from "./meta.js";
import * as linkedin from "./linkedin.js";
import * as vp from "./vidpub.js";
import { ytOpts, ttOpts, VIDEO_NETS } from "./vidnets.js";
import { MEDIA_DIR, probeVideo } from "./media.js";
import { ensureIgSafeImage } from "./images.js";
import { adaptForChannels, reelCaption, threadsSplit } from "./pipeline.js";
import { getSetting } from "./settings.js";
import { tgLink, fbLink, fbVideoLink, liLink } from "./permalink.js";
import { logEvent } from "./log.js";
import { startJob } from "./jobs.js";
import { ensurePostDigest } from "./memory.js";
import { postMediaList } from "./slides.js";
import { commentAfterPublish, commentFor } from "./comments.js";
import { normCollaborators, cleanAlt } from "./igextras.js";
import { threadsToken, threadsAccountFor, metaAccountFor, postAccount, postAccounts, telegramTargets, accountChoices, threadsAccounts,
  mainAccountIds, isAccNet, type MetaPage, type ThreadsLogin, type TgTarget } from "./accounts.js";
import { linkifySafe } from "./links.js";

// 👥 Акаунтів Threads у бренді може бути кілька (accounts.ts). Без userId - основний, як і раніше.
export async function thValidToken(ws: string, userId?: string | null): Promise<{ token: string; userId: string } | null> {
  const t = await threadsToken(ws, userId);
  return t ? { token: t.token, userId: t.userId } : null;
}

// comment - перший коментар під щойно опублікованим постом (якщо для мережі його задано)
// account - id акаунта мережі (Сторінки, профілю, каналу), accountName - його імʼя, коли в публікації
// акаунтів цієї мережі кілька (тоді «Facebook ✓» мало б бути сказано про кожну Сторінку окремо)
export type PubResult = { channel: string; account?: string; accountName?: string; status: "sent" | "error" | "skipped"; error?: string; note?: string; comment?: { status: string; error?: string } };
/** «Facebook», а коли акаунтів мережі в публікації кілька - «Facebook (Rozum.one)». */
export const pubLabel = (r: Pick<PubResult, "channel" | "accountName">, names: Record<string, string> = {}): string =>
  `${names[r.channel] || r.channel}${r.accountName ? ` (${r.accountName})` : ""}`;

// Мережі, у які сервіс реально публікує. У `post.channels` бувають службові ключі (manual_adapt,
// reel_caption) і сміття на кшталт «all» із майстер-плану: без цього фільтра такий ключ пролітав
// повз усі гілки й звітував «опубліковано», хоча не пішло нікуди.
export const PUB_NETS = ["telegram", "threads", "facebook", "instagram", "linkedin", "youtube", "tiktok"];
export const enabledNets = (ch: any): string[] => PUB_NETS.filter((k) => ch && ch[k] && ch[k].on === true);

// Резервація «раз на мережу» ПЕРЕД викликом мережі. Повертає рядок, "sent" (уже надіслано) або "busy"
// (саме зараз публікує інший процес). Рядок 'sending', старший за 20 хв, - слід публікації, яку обірвав
// перезапуск сервера (деплой, OOM): жоден живий процес її вже не веде, тож його переймаємо. Раніше він
// блокував мережу для поста назавжди, а автопостер ще й звітував «↩ вже», хоча пост міг не вийти.
const STALE_SENDING = "20 minutes";
type PubTable = "telegram_publish" | "threads_publish" | "meta_publish" | "linkedin_publish" | "youtube_publish" | "tiktok_publish";
async function reservePub(table: PubTable, key: Record<string, string>, extra: Record<string, string | null> = {}): Promise<{ id: string } | "sent" | "busy"> {
  const kc = Object.keys(key), kv = Object.values(key);
  const cond = kc.map((c, i) => `${c}=$${i + 1}`).join(" and ");
  // Застосунок - один процес, тож «хто зараз публікує цей пост» відомо точно (inFlightPosts). Якщо
  // крім нас ніхто, резервація 'sending' - сирота: публікацію обірвав перезапуск, падіння чи 502, що
  // вбив запит посеред роботи. Переймаємо одразу, а не через 20 хв - раніше саме ці 20 хв людина
  // бачила «пост саме зараз публікується» і не могла повторити (фідбек тестера).
  const orphan = (inFlightPosts.get(key.post_id) || 0) <= 1;
  // та сама незавершена публікація, записана ДО «раз на акаунт мережі» (давній код): у Threads/Meta -
  // рядок без акаунта (нові резервації його мають завжди), у Telegram - роль 'channel'/'group' того ж
  // чату. Без цього така сирота лишалась би «публікується просто зараз» назавжди.
  const legacy = table === "threads_publish" && key.account_id ? { sql: `post_id=$1 and account_id is null`, vals: [key.post_id] }
    : table === "meta_publish" && key.account_id ? { sql: `post_id=$1 and channel=$2 and account_id is null`, vals: [key.post_id, key.channel] }
    : table === "telegram_publish" && extra.chat_id ? { sql: `post_id=$1 and chat_id=$2 and target in ('channel','group')`, vals: [key.post_id, extra.chat_id] }
    : null;
  const staleWhen = `status='sending' and (${orphan ? "true" : "false"} or created_at < now() - interval '${STALE_SENDING}')`;
  const stale = await q<{ id: string }>(`delete from ${table} where ${cond} and ${staleWhen} returning id`, kv);
  if (legacy) stale.push(...await q<{ id: string }>(`delete from ${table} where ${legacy.sql} and ${staleWhen} returning id`, legacy.vals));
  if (stale.length) await logEvent("warn", "publish", `${table}: перейнято завислу резервацію (попередню публікацію обірвав перезапуск або збій)`, { postId: key.post_id });
  const cols = [...kc, ...Object.keys(extra)], vals = [...kv, ...Object.values(extra)];
  const r = await one<{ id: string }>(
    `insert into ${table}(${cols.join(",")},status) values(${vals.map((_, i) => `$${i + 1}`).join(",")},'sending')
     on conflict do nothing returning id`, vals);
  if (r) return r;
  const cur = await one<{ status: string }>(`select status from ${table} where ${cond}`, kv);
  return cur?.status === "sent" ? "sent" : "busy";
}
const BUSY = "у цю мережу пост саме зараз публікується (інша вкладка, бот чи автопостер) - дочекайся результату";

/**
 * Після ручної публікації (кабінет, бот, Mini App, Claude): гасимо заплановані слоти поста, лише
 * коли ВСІ обрані мережі вже надіслані. Інакше слот мусить добити решту пізніше, а збій «зараз»
 * не має тихо скасовувати завтрашню публікацію.
 */
export async function closeSlotsIfDone(postId: string, reason: string): Promise<boolean> {
  const post = await one<{ channels: any; ws: string }>(
    `select p.channels, s.workspace_id as ws from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1`, [postId]);
  const enabled = enabledNets(post?.channels);
  if (!post || !enabled.length) return false;
  // «усі обрані» - кожен обраний акаунт кожної мережі (дві Сторінки - обидві мають отримати пост)
  const [keys, sent] = await Promise.all([targetKeys(post.ws, post.channels, enabled), sentAccountKeys(post.ws, postId)]);
  if (keys.some((k) => !sent.has(k))) return false;
  await q(`update schedule_slot set status='posted', result=$2, updated_at=now() where post_id=$1 and status='planned'`, [postId, reason]);
  await q(`update plan_slot set status='published' where post_id=$1 and status in ('drafted','approved','scheduled')`, [postId]);
  return true;
}

// Текст CTA-гілки Threads з cta_config (детерміновано, без LLM). null = CTA не налаштований.
async function threadsCtaText(ws: string): Promise<string | null> {
  const r = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='cta_config'`, [ws]);
  let cfg: any = {}; try { cfg = JSON.parse(r?.content || "{}") || {}; } catch { return null; }
  const c = cfg.threads; const v = String(c?.value || "").trim().slice(0, 300);
  if (!v) return null;
  if (c.type === "keyword") return `Хочеш деталі - напиши «${v}» у відповідь, і я надішлю.`;
  if (c.type === "action") return v;
  return `Обіцяні деталі - тут: ${v}`;
}

// 👥 Куди саме піде пост: «мережа + акаунт» на кожну обрану галочкою Сторінку, профіль, канал. Без
// вибору - акаунт за замовчуванням (у Telegram - основні канал і група). Акаунт, якого вже нема в
// бренді, - одиниця з помилкою: людська відмова саме для нього, решта йде.
type Unit = { k: string; id: string | null; name: string | null; error?: string; th?: ThreadsLogin; meta?: MetaPage; tg?: TgTarget; tgToken?: string };
async function publishUnits(ws: string, ch: any, nets: string[]): Promise<Unit[]> {
  const units: Unit[] = [];
  let tgt: Awaited<ReturnType<typeof telegramTargets>> | null = null;
  for (const k of nets) {
    const ids = postAccounts(ch, k);
    if (k === "threads") {
      for (const id of ids.length ? ids : [null]) {
        const a = await threadsAccountFor(ws, id);
        units.push(a.ok ? { k, id: a.acc.userId, name: a.acc.username ? "@" + a.acc.username : a.acc.userId, th: a.acc } : { k, id, name: null, error: a.error });
      }
    } else if (k === "facebook" || k === "instagram") {
      for (const id of ids.length ? ids : [null]) {
        const a = await metaAccountFor(ws, k, id);
        if (!a.ok) { units.push({ k, id, name: null, error: a.error }); continue; }
        units.push(k === "facebook"
          ? { k, id: a.acc.pageId, name: a.acc.pageName, meta: a.acc }
          : { k, id: a.acc.igUserId, name: a.acc.igUsername ? "@" + a.acc.igUsername : a.acc.igUserId, meta: a.acc });
      }
    } else if (k === "telegram") {
      tgt ??= await telegramTargets(ws);
      if (!tgt.token) { units.push({ k, id: null, name: null, error: "Telegram не підключено" }); continue; }
      const list = ids.length ? ids : tgt.targets.filter((t) => t.main).map((t) => t.id);
      if (!list.length) { units.push({ k, id: null, name: null, error: "Не вказано канал/групу" }); continue; }
      for (const id of list) {
        const t = tgt.targets.find((x) => x.id === id);
        units.push(t ? { k, id: t.id, name: t.name, tg: { ...t }, tgToken: tgt.token }
          : { k, id, name: null, error: "обраний для поста канал Telegram більше не підключено до бренду - відкрий пост і обери інший (або додай його знову: Налаштування → Канали → Telegram)" });
      }
    } else units.push({ k, id: null, name: null });
  }
  return units;
}

/** Ключі «мережа|акаунт», куди пост має піти (без токенів) - щоб знати, чи вже все надіслано. */
export async function targetKeys(ws: string, ch: any, nets: string[]): Promise<string[]> {
  const choices = await accountChoices(ws);
  const out: string[] = [];
  for (const k of nets) {
    if (!isAccNet(k)) { out.push(`${k}|`); continue; }
    const ids = postAccounts(ch, k);
    if (ids.length) { out.push(...ids.map((id) => `${k}|${id}`)); continue; }
    const mains = choices[k].filter((a) => a.main).map((a) => a.id);
    if (!mains.length) out.push(`${k}|`);
    else out.push(...(k === "telegram" ? mains : mains.slice(0, 1)).map((id) => `${k}|${id}`));
  }
  return out;
}

/** Куди пост уже вийшов: ключі «мережа|акаунт». Рядки до галочок без акаунта - акаунт за замовчуванням
 *  (у Threads - за ніком із посилання, якщо такий акаунт є в бренді). */
export async function sentAccountKeys(ws: string, postId: string): Promise<Set<string>> {
  const [tgRows, thRows, mtRows, li, vid] = await Promise.all([
    q<{ chat_id: string | null }>(`select chat_id from telegram_publish where post_id=$1 and status='sent'`, [postId]),
    q<{ account_id: string | null; account_name: string | null }>(`select account_id, account_name from threads_publish where post_id=$1 and status='sent'`, [postId]),
    q<{ channel: string; account_id: string | null }>(`select channel, account_id from meta_publish where post_id=$1 and status='sent'`, [postId]),
    one<{ n: number }>(`select count(*)::int n from linkedin_publish where post_id=$1 and status='sent'`, [postId]),
    videoSentNets(postId),
  ]);
  const out = new Set<string>();
  for (const r of tgRows) out.add(`telegram|${r.chat_id || ""}`);
  if ((li?.n || 0) > 0) out.add("linkedin|");
  for (const n of vid) out.add(`${n}|`);
  const legacy = thRows.some((r) => !r.account_id) || mtRows.some((r) => !r.account_id);
  const [mains, th] = legacy ? await Promise.all([mainAccountIds(ws), threadsAccounts(ws)]) : [null, []];
  for (const r of thRows) {
    let acc = r.account_id;
    if (!acc && r.account_name) acc = th.find((a) => "@" + a.username.toLowerCase() === r.account_name!.toLowerCase())?.userId || null;
    out.add(`threads|${acc || mains?.threads || ""}`);
  }
  for (const r of mtRows) out.add(`${r.channel}|${r.account_id || (mains ? (mains as any)[r.channel] || "" : "")}`);
  return out;
}

// Мережі, куди пост УЖЕ відправлено (status='sent') хоч одним акаунтом — для позначок «опубліковано»
// (картка, бот, Mini App). Що саме з обраних акаунтів ще не отримало пост - sentAccountKeys/targetKeys.
export async function alreadySentNetworks(postId: string): Promise<string[]> {
  const [tgSent, thSent, metaSent, liSent, vid] = await Promise.all([
    one<{ n: number }>(`select count(*)::int as n from telegram_publish where post_id=$1 and status='sent'`, [postId]),
    one<{ n: number }>(`select count(*)::int as n from threads_publish where post_id=$1 and status='sent'`, [postId]),
    q<{ channel: string }>(`select distinct channel from meta_publish where post_id=$1 and status='sent'`, [postId]),
    one<{ n: number }>(`select count(*)::int as n from linkedin_publish where post_id=$1 and status='sent'`, [postId]),
    videoSentNets(postId),
  ]);
  const sent: string[] = [];
  if ((tgSent?.n || 0) > 0) sent.push("telegram");
  if ((thSent?.n || 0) > 0) sent.push("threads");
  for (const r of metaSent) if (r.channel) sent.push(r.channel); // facebook / instagram
  if ((liSent?.n || 0) > 0) sent.push("linkedin");
  sent.push(...vid);
  return sent;
}
// YouTube і TikTok: відео вже там. TikTok, що ще обробляє відео ('processing'), - теж «уже»: повтор
// задублював би пост; не вийде - сторож звільнить рядок і скаже людині.
async function videoSentNets(postId: string): Promise<string[]> {
  const r = await one<{ yt: number; tt: number }>(
    `select (select count(*)::int from youtube_publish where post_id=$1 and status='sent') as yt,
            (select count(*)::int from tiktok_publish where post_id=$1 and status in ('sent','processing')) as tt`, [postId]);
  return [...((r?.yt || 0) > 0 ? ["youtube"] : []), ...((r?.tt || 0) > 0 ? ["tiktok"] : [])];
}

// Публікує пост у кожну ввімкнену в post.channels мережу (своїм текстом + медіа).
// onlyNets (опційно, «ритм каналів»): слот розкладу може цілити ПІДМНОЖИНУ мереж - публікуємо
// лише перетин увімкнених із нею. Мережі, куди вже публікували (status='sent'), ПРОПУСКАЮТЬСЯ
// (публікація один раз на мережу) — і при ручній публікації, і в автопостері.
// Якщо жодної мережі не обрано — нічого не публікує (порожній результат), без тихого fallback.
// 🛑 Плавна зупинка. Деплой шле SIGTERM; публікація, що вже йде (Instagram і Threads обробляють відео
// хвилинами), мусить дійти до кінця, інакше пост міг вийти в мережу, а ми про це не дізнались.
// server.ts на SIGTERM ставить `stopping` і чекає, поки лічильник не впаде до нуля.
let inFlight = 0, stopping = false;
const inFlightPosts = new Map<string, number>();   // які пости публікуються в цьому процесі просто зараз
export const publishesInFlight = () => inFlight;
export const isPublishingNow = (postId: string) => (inFlightPosts.get(postId) || 0) > 0;
export const isStopping = () => stopping;
export function beginShutdown(): void { stopping = true; }
async function tracked<T>(postId: string, work: () => Promise<T>): Promise<T> {
  if (stopping) throw new Error("сервер саме перезапускається - спробуй за хвилину");
  inFlight++;
  inFlightPosts.set(postId, (inFlightPosts.get(postId) || 0) + 1);
  try { return await work(); } finally {
    inFlight--;
    const n = (inFlightPosts.get(postId) || 1) - 1;
    if (n > 0) inFlightPosts.set(postId, n); else inFlightPosts.delete(postId);
  }
}

// Мережі, куди пост публікується просто зараз (рядок-резервація 'sending'), - для «стану поста».
export async function publishingNow(postId: string): Promise<{ net: string; since: string }[]> {
  return q<{ net: string; since: string }>(
    `select 'telegram'::text as net, min(created_at) as since from telegram_publish where post_id=$1 and status='sending' having count(*) > 0
     union all select 'threads', created_at from threads_publish where post_id=$1 and status='sending'
     union all select channel, created_at from meta_publish where post_id=$1 and status='sending'
     union all select 'linkedin', created_at from linkedin_publish where post_id=$1 and status='sending'
     union all select 'youtube', created_at from youtube_publish where post_id=$1 and status='sending'
     union all select 'tiktok', created_at from tiktok_publish where post_id=$1 and status in ('sending','processing')`, [postId]);
}

/**
 * Зняти пост із розкладу: заплановані й невдалі слоти (опубліковані - це історія, їх не чіпаємо).
 * Кличеться, коли з поста знімають затвердження або прибирають усі мережі: інакше він лишався в
 * календарі як «заплановано» (автопостер відправив би незатверджений текст) чи висів там порожнім.
 */
export async function unschedulePost(postId: string): Promise<number> {
  const gone = await q<{ id: string }>(`delete from schedule_slot where post_id=$1 and status in ('planned','failed') returning id`, [postId]);
  await q(`update plan_slot ps set status = case when p.review='approved' then 'approved' else 'drafted' end
             from post p where p.id=ps.post_id and ps.post_id=$1 and ps.status='scheduled'`, [postId]);
  return gone.length;
}

// 🎬 YouTube і TikTok - спільне для поста й кнопки 📤 рілса: резервація «раз на пост» ПЕРЕД заливкою,
// рядок публікації, посилання. skipped - пост уже там (інший процес устиг першим).
async function sendYouTube(ws: string, postId: string, vf: vp.VidFile, text: string, ch: any): Promise<{ skipped?: true; note: string }> {
  const rv = await reservePub("youtube_publish", { post_id: postId });
  if (rv === "sent") return { skipped: true, note: "" };
  if (rv === "busy") throw new Error(BUSY);
  try {
    const r = await vp.youtubeUpload(ws, vf, text, ytOpts(ch.youtube));
    await q(`update youtube_publish set external_id=$2, status='sent', permalink=nullif($3,''), privacy=nullif($4,'') where id=$1`, [rv.id, r.videoId, r.permalink, r.privacy]);
    return { note: r.note };
  } catch (e: any) { await q(`delete from youtube_publish where id=$1`, [rv.id]); throw e; }
}
// TikTok обробляє відео асинхронно: чекаємо до ~1 хв; довше - рядок «обробляється», далі сторож
// (vidpub.ts) допише посилання або, якщо TikTok відмовить, звільнить рядок і напише власнику в бот.
async function sendTikTok(ws: string, postId: string, vf: vp.VidFile, text: string, ch: any): Promise<{ skipped?: true; note: string }> {
  const rv = await reservePub("tiktok_publish", { post_id: postId });
  if (rv === "sent") return { skipped: true, note: "" };
  if (rv === "busy") throw new Error(BUSY);
  let uploaded = false;
  try {
    const st = await vp.tiktokStart(ws, vf, text, ttOpts(ch.tiktok), async (publishId, mode) => {
      // файл уже в TikTok: з цього моменту рядок не звільняємо - повтор задублював би пост
      uploaded = true;
      await q(`update tiktok_publish set external_id=$2, mode=$3, status='processing', check_at=now() + interval '3 minutes' where id=$1`, [rv.id, publishId, mode]);
    });
    const out = await vp.tiktokWait(ws, st.publishId, st.mode, st.username);
    if (out.state === "failed") {
      await q(`delete from tiktok_publish where id=$1`, [rv.id]);
      throw new Error(out.error);
    }
    if (out.state === "sent")
      await q(`update tiktok_publish set status='sent', tt_status=$2, video_id=nullif($3,''), permalink=nullif($4,''),
                 check_at=case when $5 then now() + interval '2 hours' else null end where id=$1`,
        [rv.id, out.ttStatus, out.videoId, out.permalink, st.mode === "inbox" && !out.permalink]);
    else await q(`update tiktok_publish set tt_status=nullif($2,'') where id=$1`, [rv.id, out.ttStatus]);
    const notes = [...st.notes];
    if (out.state === "processing") notes.push("TikTok ще обробляє відео - посилання зʼявиться, щойно він закінчить (зазвичай кілька хвилин)");
    if (st.mode === "inbox") notes.push(vp.ttDraftNote);
    return { note: notes.join("; ") };
  } catch (e: any) {
    if (!uploaded) await q(`delete from tiktok_publish where id=$1`, [rv.id]);
    throw e;
  }
}

export function publishPostToChannels(ws: string, postId: string, onlyNets?: string[]): Promise<PubResult[]> {
  return tracked(postId, () => publishPostToChannelsNow(ws, postId, onlyNets));
}
async function publishPostToChannelsNow(ws: string, postId: string, onlyNets?: string[]): Promise<PubResult[]> {
  const post = await one<{ content: string; channels: any; format: string | null; first_comment: string | null; cover_file: string | null }>(
    `select p.content, p.channels, p.intent, p.format, p.first_comment,
            (select m.filename from media_asset m where m.id=p.reel_cover and m.kind='image') as cover_file from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post) throw new Error("пост не знайдено");
  // 📱 сторіс - окремий шлях: кожен кадр окремою сторіс, і лише там, де сторіс є в API
  if (post.format === "story") return publishStoryToChannels(ws, postId, post.channels || {}, onlyNets);
  // 🖼 кадри поста: обкладинка + кадри каруселі. Один кадр - звичайний фото-пост, 2+ - карусель
  // (Instagram/Threads - CAROUSEL, Facebook - галерея, Telegram - альбом, LinkedIn - multiImage).
  const mediaList = await postMediaList(postId);
  // відео поруч із фото буває лише в сторіс (кожен кадр окремо); пост із таким набором після зміни
  // формату не можна тихо обрізати до фото - кажемо прямо
  if (mediaList.length > 1 && mediaList.some((m) => m.kind === "video"))
    throw new Error("У пості і відео, і фото: так можна лише в сторіс. Прибери зайве або постав формат «Сторіс».");
  // 🎬 відео-пост: відео стоїть обкладинкою і завжди саме (див. setPostMediaOrder). Instagram -
  // Reels, Facebook - відео Сторінки, Threads - VIDEO, Telegram - sendVideo, LinkedIn - Videos API.
  const video = mediaList[0]?.kind === "video" ? mediaList[0] : null;
  const images = video ? [] : mediaList.filter((m) => m.kind === "image").map((m) => m.filename);
  const imageUrls = images.map((f) => `${env.appBaseUrl}/media/${f}`);
  const carousel = images.length >= 2;
  const videoUrl = video ? `${env.appBaseUrl}/media/${video.filename}` : "";
  // 🖼 обкладинка Reels (Instagram cover_url): кадр змонтованого відео з гачком або обраний людиною
  const coverUrl = video && post.cover_file ? `${env.appBaseUrl}/media/${post.cover_file}` : null;
  const videoPath = video ? join(MEDIA_DIR, video.filename) : "";
  let videoSize = video ? Number(video.size) || 0 : 0;
  if (video && !videoSize) { try { videoSize = (await stat(videoPath)).size; } catch { /* файлу нема - впаде нижче людською помилкою */ } }
  const vDur = video ? Number(video.duration) || 0 : 0;
  // межі мереж для відео - перевіряємо ДО виклику мережі: інакше людина бачить сиру помилку API
  // через кілька хвилин обробки, а не зрозумілу причину одразу
  const videoLimit = (net: string): string | null => {
    if (!video) return null;
    if (!videoSize) return "файл відео не знайдено на сервері - прикріпи відео заново";
    const mb = Math.round(videoSize / 1024 / 1024);
    if (net === "telegram" && videoSize > tg.TG_VIDEO_MAX) return `Telegram приймає від ботів відео до 50 МБ, а це ${mb} МБ - стисни відео або зніми Telegram із цього поста`;
    if (!vDur) return null; // тривалість не виміряли - хай вирішує сама мережа
    if (net === "instagram" && (vDur < 3 || vDur > 900)) return "Instagram Reels приймає відео від 3 с до 15 хв";
    if (net === "threads" && vDur > 300) return "Threads приймає відео до 5 хв - вріж відео або зніми Threads із цього поста";
    if (net === "linkedin" && (vDur < 3 || vDur > 1800)) return "LinkedIn приймає відео від 3 с до 30 хв";
    return null;
  };
  const ch = post.channels || {};
  const enabled = enabledNets(ch).filter((k) => !onlyNets || onlyNets.includes(k));
  // 👥 куди саме: пара «мережа + акаунт» на кожну обрану галочкою Сторінку, профіль чи канал (без
  // вибору - акаунт за замовчуванням, у Telegram - основні канал і група, як і було). Публікація -
  // один раз на акаунт мережі: друга Сторінка отримує пост, навіть якщо перша вже має його.
  const [units, sentKeys] = await Promise.all([publishUnits(ws, ch, enabled), sentAccountKeys(ws, postId)]);
  const isSent = (u: Unit) => sentKeys.has(`${u.k}|${u.id || ""}`);
  // «Створи один раз - сервіс сам перепакує»: мережі без власної версії тексту адаптуються
  // автоматично перед відправкою (один LLM-виклик на всі відсутні; при збої - майстер-текст як раніше).
  // Покриває і плановий автопостер, і публікацію з бота - не лише кнопку «Підлаштувати» в композері.
  // ⚠️ АЛЕ якщо адаптацією керує людина (композер поставив channels.manual_adapt при пер-канальному
  // ✨ або ↺), сервер НЕ перепаковує: мережі, які юзер свідомо лишив зі своїм текстом, інакше все одно
  // переписувались при публікації - і прев'ю в композері брехало (фідбек Олега «підлаштувало всюди,
  // а мені подобався мій перший текст»).
  const manual = ch.manual_adapt === true;
  const pendingNets = [...new Set(units.filter((u) => !isSent(u)).map((u) => u.k))];
  const missing = manual ? [] : pendingNets.filter((k) => !(ch[k] && String(ch[k].text || "").trim()) && (video || !VIDEO_NETS.includes(k)));
  if (missing.length) {
    try {
      const variants = await adaptForChannels(ws, post.content, missing, (post as any).intent || undefined);
      let changed = false;
      for (const k of missing) if (variants[k]) { ch[k] = { ...(ch[k] || {}), on: true, text: variants[k] }; changed = true; }
      if (changed) await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify(ch)]);
    } catch (e: any) {
      // не критично (їде майстер-текст), але слід лишаємо: тихий збій адаптації = Threads отримує
      // текст понад 500 симв. і публікація там падає «незрозуміло чому»
      await logEvent("warn", "publish", `авто-адаптація не вдалась (їде майстер-текст): ${e.message}`, { ws, postId });
    }
  }
  const baseText = (k: string) => (ch[k] && ch[k].text) || post.content;
  // 🔗 посилання в тексті → короткі з UTM і лічильником (коли людина це ввімкнула; Instagram - ні, там
  // вони не клікаються). Збій - текст як був: посилання в пості важливіше за лічильник
  const linked: Record<string, string> = {};
  for (const k of pendingNets) linked[k] = await linkifySafe(ws, postId, k, baseText(k));
  const textOf = (k: string) => linked[k] ?? baseText(k);
  const imageUrl = imageUrls[0] || null;
  const results: PubResult[] = [];
  const li = enabled.includes("linkedin")
    ? await one<{ member_urn: string; access_token: string; token_expires_at: string | null }>(`select member_urn, access_token, token_expires_at from linkedin_config where workspace_id=$1`, [ws])
    : null;
  // 📸 alt-текст фото (у тому ж порядку, що images): Instagram і LinkedIn
  const alts = video ? [] : mediaList.filter((m) => m.kind === "image").map((m) => cleanAlt(m.alt_text));
  // скільки акаунтів мережі в цій публікації: коли кілька, результат називає акаунт
  const perNet = new Map<string, number>();
  for (const u of units) perNet.set(u.k, (perNet.get(u.k) || 0) + 1);
  // гілка Threads ріжеться моделлю ОДИН раз: у кількох акаунтах Threads - та сама серія, без зайвого виклику
  let thParts: string[] | null = null;
  for (const u of units) {
    const k = u.k;
    const who: Pick<PubResult, "account" | "accountName"> = { ...(u.id ? { account: u.id } : {}), ...((perNet.get(k) || 0) > 1 && u.name ? { accountName: u.name } : {}) };
    if (isSent(u)) { results.push({ channel: k, ...who, status: "skipped" }); continue; } // уже опубліковано цим акаунтом
    // id щойно опублікованого поста в мережі - під ним піде перший коментар (Telegram коментарів не має)
    let target = "";
    let note = "";   // пост вийшов, але щось із доповнень ні (співавтори, alt-текст) - людина має знати
    try {
      if (u.error) throw new Error(u.error);
      if (k === "telegram") {
        const t = u.tg!, token = u.tgToken!;
        const cap = textOf(k);
        // атомарна резервація ПЕРЕД викликом Telegram - захист від гонки (подвійний клік, збіг ручної
        // публікації з автопостом). Ключ - сам чат (chat:<id>), а не роль «канал/група»: основний канал
        // бренду може змінитись (прибрали - основним став додатковий), і давній ключ 'channel' від
        // попереднього каналу вважав би новий «уже опублікованим». Давні рядки 'channel'/'group'
        // лишаються й читаються за chat_id (sentAccountKeys) - тож повтору туди не буде.
        const rv = await reservePub("telegram_publish", { post_id: postId, target: `chat:${t.id}` }, { chat_id: t.id });
        if (rv === "sent") { results.push({ channel: k, ...who, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        const reserved = rv;
        let tailErr = "";
        try {
          let r: { message_id: number };
          // текст довший за підпис (1024) іде окремим повідомленням ПІСЛЯ медіа. Якщо впаде саме він -
          // медіа вже в каналі: резервацію НЕ звільняємо (інакше повтор задублював би альбом), а кажемо прямо
          const tail = async () => {
            if (cap.length <= 1024) return;
            try { await tg.sendMessage(token, t.id, cap); } catch (e: any) { tailErr = e.message; }
          };
          const vErr = videoLimit("telegram");
          if (vErr) throw new Error(vErr);
          if (video) {
            // за адресою Telegram тягне лише до 20 МБ; більше (до 50) - надсилаємо файл самі
            const src = videoSize <= tg.TG_VIDEO_URL_MAX ? { url: videoUrl } : { file: await readFile(videoPath), name: video.filename };
            r = await tg.sendVideo(token, t.id, src, cap.length <= 1024 ? cap : "", video);
            await tail();
          } else if (carousel) {
            // альбом: підпис на першому кадрі; довший за 1024 - окремим повідомленням під альбомом
            const msgs = await tg.sendMediaGroup(token, t.id, imageUrls, cap.length <= 1024 ? cap : "");
            r = msgs[0];
            await tail();
          } else if (imageUrl) {
            r = await tg.sendPhoto(token, t.id, imageUrl, cap.length <= 1024 ? cap : "");
            await tail(); // підпис > ліміту Telegram → текст окремо
          } else {
            r = await tg.sendMessage(token, t.id, cap);
          }
          // @username каналу потрібен для гарного лінка t.me/<name>/<id>. Тягнемо ОДИН раз і кешуємо
          // (основний канал - у telegram_config, додатковий - у telegram_chat); група - лінк t.me/c/…
          if (t.kind !== "group" && t.username == null) {
            try {
              const info = await tg.getChat(token, t.id);
              t.username = info.username || "";
              if (t.kind === "channel") await q(`update telegram_config set channel_username=$2 where workspace_id=$1`, [ws, t.username]);
              else await q(`update telegram_chat set username=$3 where workspace_id=$1 and chat_id=$2`, [ws, t.id, t.username]);
            } catch { t.username = ""; } // не вийшло - лишиться лінк t.me/c/<internal>/<id>
          }
          await q(`update telegram_publish set message_id=$2, status='sent', permalink=nullif($3,'') where id=$1`,
            [reserved.id, r.message_id, tgLink(t.id, r.message_id, t.kind !== "group" ? t.username : null)]);
        } catch (e: any) {
          await q(`delete from telegram_publish where id=$1`, [reserved.id]); // звільняємо резервацію - можна повторити пізніше
          throw e;
        }
        if (tailErr) {
          await logEvent("warn", "publish", `Telegram: медіа вийшло, а текст окремим повідомленням - ні: ${tailErr}`, { ws, postId });
          results.push({ channel: k, ...who, status: "sent", note: `медіа вийшло, а довгий текст окремим повідомленням - ні (${tailErr}); допиши його в канал вручну` });
          continue;
        }
      } else if (k === "threads") {
        const thTok = u.th!;
        const thErr = videoLimit("threads"); if (thErr) throw new Error(thErr);
        // 🧵 стратегія Threads (settings_block.threads_strategy): гілка для довгих + відкладена CTA-гілка
        const strat = await getSetting<any>(ws, "threads_strategy", {});
        const perPost = ch[k] || {};
        // гілка: явний прапорець на пості АБО авто-режим для майстер-текстів понад ліміт (500)
        const wantThread = perPost.thread === true || (strat.thread === "auto" && perPost.thread !== false && post.content.length > 500);
        // резервація ОДИН раз для всього поста цього акаунта (root) - гілка/ветки нижче лише розвивають цей root
        const rv = await reservePub("threads_publish", { post_id: postId, account_id: thTok.userId }, { account_name: thTok.username ? "@" + thTok.username : null });
        if (rv === "sent") { results.push({ channel: k, ...who, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        const reserved = rv;
        let rootId: string;
        try {
          if (wantThread) {
            // гілка пакує ПОВНИЙ майстер-текст (а не скорочену 500-символьну версію) - у цьому її сенс
            const parts = thParts ??= await Promise.all((await threadsSplit(ws, post.content, perPost.number !== false)).map((t) => linkifySafe(ws, postId, "threads", t)));
            // карусель - у першому пості гілки (root), відповіді лишаються текстовими
            const first = video
              ? await threads.publishVideo(thTok.token, thTok.userId, parts[0], videoUrl)
              : carousel
              ? await threads.publishCarousel(thTok.token, thTok.userId, parts[0], imageUrls)
              : await threads.publish(thTok.token, thTok.userId, parts[0], imageUrl || undefined);
            rootId = first.mediaId;
            // root УЖЕ в мережі → фіксуємо sent ОДРАЗУ: якщо якась ветка впаде, повторна публікація
            // не задублює root (дедуп «раз на акаунт» побачить sent)
            await q(`update threads_publish set media_id=$2, status='sent' where id=$1`, [reserved.id, rootId]);
            let prev = rootId;
            for (const part of parts.slice(1)) {
              await new Promise((res) => setTimeout(res, 3000)); // пауза: root/попередня ветка мають «доїхати»
              try {
                const rr = await threads.publish(thTok.token, thTok.userId, part, undefined, prev);
                prev = rr.mediaId;
              } catch (e: any) {
                // ветка не доїхала - не валимо публікацію (root уже живий), лишаємо слід у логах
                await logEvent("error", "threads-thread", `ветка гілки не опублікувалась: ${e.message}`, { ws, postId });
                break;
              }
            }
          } else {
            const r = video
              ? await threads.publishVideo(thTok.token, thTok.userId, textOf(k), videoUrl)
              : carousel
              ? await threads.publishCarousel(thTok.token, thTok.userId, textOf(k), imageUrls)
              : await threads.publish(thTok.token, thTok.userId, textOf(k), imageUrl || undefined);
            rootId = r.mediaId;
            await q(`update threads_publish set media_id=$2, status='sent' where id=$1`, [reserved.id, rootId]);
          }
        } catch (e: any) {
          await q(`delete from threads_publish where id=$1`, [reserved.id]);
          throw e;
        }
        // 🔗 permalink Threads НЕ виводиться з media_id - лише окремим запитом. Свідомо НЕ критично:
        // публікація вже успішна, тож збій тут її не валить (лінк доберемо лениво на вимогу UI).
        if (rootId) {
          try {
            const pl = await threads.mediaPermalink(thTok.token, rootId);
            if (pl) await q(`update threads_publish set permalink=$2 where id=$1`, [reserved.id, pl]);
          } catch { /* доберемо в /publish-state */ }
        }
        target = rootId;
        // CTA-гілка з затримкою: лінк/кодове слово доклеюємо, коли пост уже розганяється. Якщо в поста
        // є свій перший коментар для Threads, він і є цим закликом - друга відповідь від автора зайва.
        const delayMin = Number(strat.cta_min || 0);
        if (delayMin > 0 && !commentFor({ ...post, channels: ch }, "threads")) {
          const cta = await threadsCtaText(ws);
          if (cta) await q(
            `insert into threads_reply_job(workspace_id,post_id,root_media_id,reply_text,due_at,account_id)
             values($1,$2,$3,$4, now() + ($5 || ' minutes')::interval, $6)`,
            [ws, postId, rootId, cta, String(delayMin), thTok.userId]);
        }
      } else if (k === "facebook") {
        const acc = u.meta!;
        const mt = { page_id: acc.pageId, page_token: acc.pageToken };
        // строк у meta_config - це строк токена КОРИСТУВАЧА (~60 днів); токен Сторінки, отриманий із
        // нього, не протухає. Тож заздалегідь не відмовляємо: якщо доступ справді втрачено, Meta
        // відповість помилкою 190, і людина побачить «перепідключи» (fbFetch).
        const rv = await reservePub("meta_publish", { post_id: postId, channel: "facebook", account_id: acc.pageId }, { account_name: acc.pageName });
        if (rv === "sent") { results.push({ channel: k, ...who, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        const reserved = rv;
        try {
          if (video) {
            // відео Сторінки: Meta сама тягне файл за адресою; вертає id відео (без id сторінки)
            const rv = await meta.publishVideoToPage(mt.page_id, mt.page_token, textOf(k), videoUrl);
            await q(`update meta_publish set external_id=$2, status='sent', permalink=nullif($3,'') where id=$1`, [reserved.id, rv.id, fbVideoLink(rv.id)]);
            target = rv.id;
          } else {
            const r = carousel ? await meta.publishMultiPhotoToPage(mt.page_id, mt.page_token, textOf(k), imageUrls)
              : imageUrl ? await meta.publishPhotoToPage(mt.page_id, mt.page_token, textOf(k), imageUrl)
              : await meta.publishToPage(mt.page_id, mt.page_token, textOf(k));
            const fbId = (r as any).post_id || r.id;
            // id FB-поста вже містить id сторінки, тож лінк збирається без додаткового запиту
            await q(`update meta_publish set external_id=$2, status='sent', permalink=nullif($3,'') where id=$1`, [reserved.id, fbId, fbLink(fbId)]);
            target = fbId;
          }
        } catch (e: any) { await q(`delete from meta_publish where id=$1`, [reserved.id]); throw e; }
      } else if (k === "instagram") {
        const acc = u.meta!;
        const mt = { ig_user_id: acc.igUserId!, page_token: acc.pageToken, ig_username: acc.igUsername };
        if (!images.length && !video) throw new Error("Instagram потребує фото або відео");
        const igErr = videoLimit("instagram"); if (igErr) throw new Error(igErr);
        const rv = await reservePub("meta_publish", { post_id: postId, channel: "instagram", account_id: mt.ig_user_id }, { account_name: mt.ig_username ? "@" + mt.ig_username : null });
        if (rv === "sent") { results.push({ channel: k, ...who, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        const reserved = rv;
        try {
          // IG приймає лише JPEG з пропорціями 0.8-1.91 → за потреби готуємо сумісну копію (PNG з AI-генерації падав).
          // Для каруселі - кожен кадр.
          const safe: string[] = [];
          for (const f of images) safe.push(await ensureIgSafeImage(ws, f));
          const safeUrls = safe.map((f) => `${env.appBaseUrl}/media/${f}`);
          // 👥 співавтори (до 3) - на фото, карусель і Reels; власний нік співавтором бути не може
          const collab = normCollaborators(ch.instagram?.collaborators, mt.ig_username).ok;
          const r = video
            ? await meta.publishReelToInstagram(mt.ig_user_id, mt.page_token, videoUrl, textOf(k), { collaborators: collab, coverUrl })
            : carousel
            ? await meta.publishCarouselToInstagram(mt.ig_user_id, mt.page_token, safeUrls, textOf(k), { collaborators: collab, altTexts: alts })
            : await meta.publishToInstagram(mt.ig_user_id, mt.page_token, safeUrls[0], textOf(k), { collaborators: collab, altText: alts[0] });
          await q(`update meta_publish set external_id=$2, status='sent' where id=$1`, [reserved.id, r.mediaId]);
          target = r.mediaId;
          if (r.dropped) note = `пост вийшов без ${r.dropped}`;
          // permalink IG - лише окремим запитом; збій не критичний (доберемо лениво в /publish-state)
          try {
            const pl = await meta.mediaPermalink(r.mediaId, mt.page_token);
            if (pl) await q(`update meta_publish set permalink=$2 where id=$1`, [reserved.id, pl]);
          } catch { /* доберемо пізніше */ }
        } catch (e: any) { await q(`delete from meta_publish where id=$1`, [reserved.id]); throw e; }
      } else if (k === "linkedin") {
        if (!li?.access_token || !li.member_urn) throw new Error("LinkedIn не підключено");
        const liErr = videoLimit("linkedin"); if (liErr) throw new Error(liErr);
        if (li.token_expires_at && new Date(li.token_expires_at).getTime() < Date.now())
          throw new Error("Токен LinkedIn протух (живе 60 днів) - перепідключи у Налаштування → Канали");
        const rv = await reservePub("linkedin_publish", { post_id: postId });
        if (rv === "sent") { results.push({ channel: k, ...who, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        const reserved = rv;
        try {
          // зображення LinkedIn приймає лише через власний upload (не за URL) - читаємо локальні файли
          const bufs: Buffer[] = [], liAlts: string[] = [];
          for (const [i, f] of images.entries()) {
            try { bufs.push(await readFile(join(MEDIA_DIR, f))); liAlts.push(alts[i] || ""); } catch { /* файл зник - без нього */ }
          }
          const r = await linkedin.publish(li.access_token, li.member_urn, textOf(k), bufs, video ? { path: videoPath, size: videoSize } : undefined, liAlts);
          // URN поста → лінк збирається детерміновано, без додаткового запиту
          await q(`update linkedin_publish set external_id=$2, status='sent', permalink=nullif($3,'') where id=$1`,
            [reserved.id, r.postId || null, liLink(r.postId || null)]);
          target = r.postId || "";
        } catch (e: any) { await q(`delete from linkedin_publish where id=$1`, [reserved.id]); throw e; }
      } else if (k === "youtube" || k === "tiktok") {
        // 🎬 лише відео: YouTube (вертикальне до 3 хв - Shorts) і TikTok. Першого коментаря тут нема:
        // YouTube вимагав би ще один дозвіл, у TikTok коментарів через API нема взагалі.
        if (!video) throw new Error(`${NET_UA[k]} приймає лише відео - прикріпи відео або зніми ${NET_UA[k]} із цього поста`);
        if (!videoSize) throw new Error("файл відео не знайдено на сервері - прикріпи відео заново");
        const vf: vp.VidFile = { path: videoPath, filename: video.filename, size: videoSize, width: Number(video.width) || 0, height: Number(video.height) || 0, duration: vDur };
        const r = k === "youtube" ? await sendYouTube(ws, postId, vf, textOf(k), ch) : await sendTikTok(ws, postId, vf, textOf(k), ch);
        if (r.skipped) { results.push({ channel: k, ...who, status: "skipped" }); continue; }
        note = r.note;
      }
      // 💬 перший коментар: пост уже в мережі, тож збій коментаря НЕ робить публікацію помилковою -
      // він окремим станом поруч (повтор - воркер або кнопка «Надіслати коментар»). Під кожною
      // публікацією свій: пост на двох Сторінках - два коментарі, кожен від своєї Сторінки.
      let cm: { status: string; error?: string } | undefined;
      if (target) {
        try {
          const st = await commentAfterPublish(postId, k, target, isAccNet(k) ? u.id || "" : "");
          if (st) cm = { status: st.status, ...(st.error ? { error: st.error } : {}) };
        } catch (e: any) {
          await logEvent("warn", "comment", `перший коментар не поставлено в чергу: ${e.message}`, { ws, postId });
        }
      }
      results.push({ channel: k, ...who, status: "sent", ...(cm ? { comment: cm } : {}), ...(note ? { note } : {}) });
    } catch (e: any) { results.push({ channel: k, ...who, status: "error", error: e.message }); }
  }
  // 🧠 памʼять контенту: щойно опублікований пост дистилюється в структурований артефакт (гачок,
  // теза, цифри, заклик), який далі читає генерація - щоб наступні пости не повторювали те саме.
  // Свідомо fire-and-forget: публікація вже відбулась, і збій дистиляції не має ані затримувати
  // відповідь, ані псувати результат. Ідемпотентність - усередині (пост у 4 мережі = один артефакт).
  if (results.some((r) => r.status === "sent")) {
    void ensurePostDigest(ws, postId).catch(() => { /* лог пише сама ensurePostDigest */ });
  }
  return results;
}

// ===================== 📱 СТОРІС =====================
// Сторіс є в API лише в Instagram (контейнер STORIES) і Facebook-Сторінки (photo_stories /
// video_stories). Кожен кадр - окрема сторіс, підпису немає (текст має бути на кадрі), живе 24 год.
// Telegram, Threads і LinkedIn сторіс через API не приймають - для них чесна відмова, а не тихий
// звичайний пост замість сторіс.
export const STORY_NETS = ["instagram", "facebook"];
const NET_UA: Record<string, string> = { telegram: "Telegram", threads: "Threads", linkedin: "LinkedIn", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", tiktok: "TikTok" };
async function publishStoryToChannels(ws: string, postId: string, ch: any, onlyNets?: string[]): Promise<PubResult[]> {
  const enabled = enabledNets(ch).filter((k) => !onlyNets || onlyNets.includes(k));
  const frames = await postMediaList(postId);
  // 👥 сторіс - з кожного обраного акаунта (або основного), як і звичайний пост
  const [units, sentKeys] = await Promise.all([publishUnits(ws, ch, enabled.filter((k) => STORY_NETS.includes(k))), sentAccountKeys(ws, postId)]);
  // мережі без сторіс - одна чесна відмова на мережу, без жодного запиту
  for (const k of enabled) if (!STORY_NETS.includes(k)) units.push({ k, id: null, name: null, error: `сторіс публікуються лише в Instagram і Facebook - ${NET_UA[k]} їх через API не приймає; зніми ${NET_UA[k]} із цього поста` });
  const perNet = new Map<string, number>();
  for (const u of units) perNet.set(u.k, (perNet.get(u.k) || 0) + 1);
  const url = (f: string) => `${env.appBaseUrl}/media/${f}`;
  const results: PubResult[] = [];
  for (const u of units) {
    const k = u.k;
    const who: Pick<PubResult, "account" | "accountName"> = { ...(u.id ? { account: u.id } : {}), ...((perNet.get(k) || 0) > 1 && u.name ? { accountName: u.name } : {}) };
    if (u.id && sentKeys.has(`${k}|${u.id}`)) { results.push({ channel: k, ...who, status: "skipped" }); continue; }
    try {
      if (u.error) throw new Error(u.error);
      if (!frames.length) throw new Error("у сторіс немає жодного кадру - додай фото чи відео");
      const mt = u.meta!;
      // межі - ДО виклику: відео в сторіс Instagram - до 60 с (а мережа сказала б це через хвилину обробки)
      const longVid = frames.find((m) => m.kind === "video" && Number(m.duration) > 60);
      if (k === "instagram" && longVid) throw new Error(`відео в сторіс Instagram - до 60 с, а тут ${Math.round(Number(longVid.duration))} с - вріж його`);
      const rv = await reservePub("meta_publish", { post_id: postId, channel: k, account_id: (k === "instagram" ? mt.igUserId : mt.pageId)! },
        { account_name: k === "instagram" ? (mt.igUsername ? "@" + mt.igUsername : null) : mt.pageName });
      if (rv === "sent") { results.push({ channel: k, ...who, status: "skipped" }); continue; }
      if (rv === "busy") throw new Error(BUSY);
      const reserved = rv;
      const ids: string[] = [];
      try {
        for (const m of frames) {
          if (k === "instagram") {
            const r = m.kind === "video"
              ? await meta.publishStoryToInstagram(mt.igUserId!, mt.pageToken, { videoUrl: url(m.filename) })
              : await meta.publishStoryToInstagram(mt.igUserId!, mt.pageToken, { imageUrl: url(await ensureIgSafeImage(ws, m.filename, { story: true })) });
            ids.push(r.mediaId);
          } else {
            const r = m.kind === "video"
              ? await meta.publishVideoStoryToPage(mt.pageId, mt.pageToken, url(m.filename))
              : await meta.publishPhotoStoryToPage(mt.pageId, mt.pageToken, url(m.filename));
            ids.push(r.postId);
          }
        }
      } catch (e: any) {
        if (!ids.length) { await q(`delete from meta_publish where id=$1`, [reserved.id]); throw e; }
        // частина кадрів уже в мережі: фіксуємо «надіслано», щоб повтор НЕ задублював їх, і кажемо прямо,
        // скільки вийшло - решту кадрів людина додасть окремою сторіс
        await q(`update meta_publish set external_id=$2, status='sent' where id=$1`, [reserved.id, ids.join(",")]);
        await logEvent("warn", "story", `${NET_UA[k]}: опубліковано ${ids.length} з ${frames.length} кадрів сторіс, далі збій: ${e.message}`, { ws, postId });
        results.push({ channel: k, ...who, status: "error", error: `опубліковано ${ids.length} з ${frames.length} кадрів, далі збій: ${e.message}` });
        continue;
      }
      await q(`update meta_publish set external_id=$2, status='sent' where id=$1`, [reserved.id, ids.join(",")]);
      results.push({ channel: k, ...who, status: "sent" });
    } catch (e: any) { results.push({ channel: k, ...who, status: "error", error: e.message }); }
  }
  if (results.some((r) => r.status === "sent")) void ensurePostDigest(ws, postId).catch(() => {});
  return results;
}

// ===================== ПУБЛІКАЦІЯ ВІДЕО-РІЛСІВ =====================
// Окремий шлях від текстових постів: IG (контейнер REELS), FB (відео Сторінки),
// YouTube (Shorts), TikTok (чернетка юзеру - до аудиту застосунку прямий пост недоступний).
// Фонова джоба (IG обробляє відео до ~3 хв - жоден HTTP-таймаут не переживе синхронний виклик).

// мережі, куди рілс УЖЕ поїхав (щоб не публікувати вдруге)
export async function reelSentNetworks(postId: string): Promise<string[]> {
  const [metaSent, vid] = await Promise.all([
    q<{ channel: string }>(`select distinct channel from meta_publish where post_id=$1 and status='sent'`, [postId]),
    videoSentNets(postId),
  ]);
  return [...metaSent.map((r) => r.channel).filter(Boolean), ...vid];
}

export function publishReelToChannels(ws: string, postId: string, nets: string[]): Promise<PubResult[]> {
  return tracked(postId, () => publishReelToChannelsNow(ws, postId, nets));
}
async function publishReelToChannelsNow(ws: string, postId: string, nets: string[]): Promise<PubResult[]> {
  const post = await one<{ content: string; channels: any; reel_video: string | null; own_video: string | null; cover_file: string | null }>(
    `select p.content, p.channels, p.reel_video, (select m.filename from media_asset m where m.id=p.media_id and m.kind='video') as own_video,
            (select m.filename from media_asset m where m.id=p.reel_cover and m.kind='image') as cover_file
       from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post) throw new Error("пост не знайдено");
  // зібраний рілс, а якщо його нема - власне відео поста (те саме відео піде в YouTube Shorts / TikTok)
  const ownVideo = !post.reel_video && !!post.own_video;
  post.reel_video = post.reel_video || post.own_video;
  if (!post.reel_video) throw new Error("рілс ще не зібрано - спершу 🎞 на картці сценарію");
  const ch = post.channels || {};
  // підпис до відео генеруємо один раз і кешуємо на пості (channels.reel_caption); у власного відео
  // підпис - сам текст поста (це не сценарій, переписувати його моделлю нема чого)
  let caption: string = String(ch.reel_caption || "").trim() || (ownVideo ? post.content.trim().slice(0, 2200) : "");
  if (!caption) {
    try {
      caption = await reelCaption(ws, post.content);
      ch.reel_caption = caption;
      await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify(ch)]);
    } catch { caption = (post.content.split("\n").find((l) => /^ХУК/i.test(l.trim())) || post.content.split("\n")[0] || "").replace(/^ХУК[^:]*:\s*/i, "").slice(0, 500); }
  }
  const videoUrl = `${env.appBaseUrl}/media/${post.reel_video}`;
  const sentSet = new Set(await reelSentNetworks(postId));
  const results: PubResult[] = [];
  // YouTube і TikTok вантажать файл частинами з диска; розмір і кадр міряємо один раз
  let vf: vp.VidFile | null = null;
  const reelFile = async (): Promise<vp.VidFile> => {
    if (vf) return vf;
    const path = join(MEDIA_DIR, post.reel_video!);
    const [st, info] = await Promise.all([stat(path), probeVideo(path)]);
    return (vf = { path, filename: post.reel_video!, size: st.size, width: info?.width || 0, height: info?.height || 0, duration: info?.duration || 0 });
  };
  for (const k of nets) {
    if (sentSet.has(k)) { results.push({ channel: k, status: "skipped" }); continue; }
    try {
      if (k === "instagram") {
        const acc = await metaAccountFor(ws, "instagram", postAccount(ch, "instagram"));
        if (!acc.ok) throw new Error(acc.error);
        const rv = await reservePub("meta_publish", { post_id: postId, channel: "instagram", account_id: acc.acc.igUserId! }, { account_name: acc.acc.igUsername ? "@" + acc.acc.igUsername : null });
        if (rv === "sent") { results.push({ channel: k, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        try {
          const r = await meta.publishReelToInstagram(acc.acc.igUserId!, acc.acc.pageToken, videoUrl, caption,
            { coverUrl: ownVideo && post.cover_file ? `${env.appBaseUrl}/media/${post.cover_file}` : null });
          await q(`update meta_publish set external_id=$2, status='sent' where id=$1`, [rv.id, r.mediaId]);
        } catch (e: any) { await q(`delete from meta_publish where id=$1`, [rv.id]); throw e; }
      } else if (k === "facebook") {
        const acc = await metaAccountFor(ws, "facebook", postAccount(ch, "facebook"));
        if (!acc.ok) throw new Error(acc.error);
        const rv = await reservePub("meta_publish", { post_id: postId, channel: "facebook", account_id: acc.acc.pageId }, { account_name: acc.acc.pageName });
        if (rv === "sent") { results.push({ channel: k, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        try {
          const r = await meta.publishVideoToPage(acc.acc.pageId, acc.acc.pageToken, caption, videoUrl);
          await q(`update meta_publish set external_id=$2, status='sent', permalink=nullif($3,'') where id=$1`, [rv.id, r.id, fbVideoLink(r.id)]);
        } catch (e: any) { await q(`delete from meta_publish where id=$1`, [rv.id]); throw e; }
      } else if (k === "youtube" || k === "tiktok") {
        // ті самі YouTube і TikTok, що в публікації поста: «раз на пост», налаштування з channels.youtube /
        // channels.tiktok (не обрано «Хто бачить» - відео йде в чернетки TikTok)
        const r = k === "youtube" ? await sendYouTube(ws, postId, await reelFile(), caption, ch) : await sendTikTok(ws, postId, await reelFile(), caption, ch);
        if (r.skipped) { results.push({ channel: k, status: "skipped" }); continue; }
        results.push({ channel: k, status: "sent", ...(r.note ? { note: r.note } : {}) });
        continue;
      } else { throw new Error("невідома мережа для рілсів"); }
      results.push({ channel: k, status: "sent" });
    } catch (e: any) { results.push({ channel: k, status: "error", error: e.message }); }
  }
  return results;
}

export async function startReelPublishJob(ws: string, postId: string, nets: string[]): Promise<void> {
  await startJob("reel-pub", postId, ws, async () => ({ results: await publishReelToChannels(ws, postId, nets) }));
}
