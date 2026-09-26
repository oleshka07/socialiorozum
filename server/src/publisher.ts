// Спільна публікація поста в усі обрані мережі (composer «Опублікувати» + плановий автопостер).
import { q, one } from "./db.js";
import { env } from "./env.js";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as tg from "./telegram.js";
import * as threads from "./threads.js";
import * as meta from "./meta.js";
import * as linkedin from "./linkedin.js";
import * as youtube from "./youtube.js";
import * as tiktok from "./tiktok.js";
import { MEDIA_DIR } from "./media.js";
import { ensureIgSafeImage } from "./images.js";
import { adaptForChannels, reelCaption, threadsSplit } from "./pipeline.js";
import { getSetting } from "./settings.js";
import { tgLink, fbLink, fbVideoLink, liLink } from "./permalink.js";
import { logEvent } from "./log.js";
import { startJob } from "./jobs.js";
import { ensurePostDigest } from "./memory.js";
import { postMediaList } from "./slides.js";
import { commentAfterPublish, commentFor } from "./comments.js";

export async function thValidToken(ws: string): Promise<{ token: string; userId: string } | null> {
  const c = await one<{ threads_user_id: string | null; access_token: string | null; token_expires_at: string | null }>(
    `select threads_user_id, access_token, token_expires_at from threads_config where workspace_id=$1`, [ws]);
  if (!c?.access_token || !c.threads_user_id) return null;
  const exp = c.token_expires_at ? new Date(c.token_expires_at).getTime() : 0;
  if (exp && exp - Date.now() < 7 * 864e5) {
    try {
      const r = await threads.refreshToken(c.access_token);
      const newExp = new Date(Date.now() + r.expires_in * 1000).toISOString();
      await q(`update threads_config set access_token=$2, token_expires_at=$3, updated_at=now() where workspace_id=$1`, [ws, r.access_token, newExp]);
      return { token: r.access_token, userId: c.threads_user_id };
    } catch { /* пробуємо наявним токеном */ }
  }
  return { token: c.access_token, userId: c.threads_user_id };
}

// comment - перший коментар під щойно опублікованим постом (якщо для мережі його задано)
export type PubResult = { channel: string; status: "sent" | "error" | "skipped"; error?: string; note?: string; comment?: { status: string; error?: string } };

// Мережі, у які сервіс реально публікує. У `post.channels` бувають службові ключі (manual_adapt,
// reel_caption) і сміття на кшталт «all» із майстер-плану: без цього фільтра такий ключ пролітав
// повз усі гілки й звітував «опубліковано», хоча не пішло нікуди.
export const PUB_NETS = ["telegram", "threads", "facebook", "instagram", "linkedin"];
export const enabledNets = (ch: any): string[] => PUB_NETS.filter((k) => ch && ch[k] && ch[k].on === true);

// Резервація «раз на мережу» ПЕРЕД викликом мережі. Повертає рядок, "sent" (уже надіслано) або "busy"
// (саме зараз публікує інший процес). Рядок 'sending', старший за 20 хв, - слід публікації, яку обірвав
// перезапуск сервера (деплой, OOM): жоден живий процес її вже не веде, тож його переймаємо. Раніше він
// блокував мережу для поста назавжди, а автопостер ще й звітував «↩ вже», хоча пост міг не вийти.
const STALE_SENDING = "20 minutes";
type PubTable = "telegram_publish" | "threads_publish" | "meta_publish" | "linkedin_publish";
async function reservePub(table: PubTable, key: Record<string, string>, extra: Record<string, string> = {}): Promise<{ id: string } | "sent" | "busy"> {
  const kc = Object.keys(key), kv = Object.values(key);
  const cond = kc.map((c, i) => `${c}=$${i + 1}`).join(" and ");
  // Застосунок - один процес, тож «хто зараз публікує цей пост» відомо точно (inFlightPosts). Якщо
  // крім нас ніхто, резервація 'sending' - сирота: публікацію обірвав перезапуск, падіння чи 502, що
  // вбив запит посеред роботи. Переймаємо одразу, а не через 20 хв - раніше саме ці 20 хв людина
  // бачила «пост саме зараз публікується» і не могла повторити (фідбек тестера).
  const orphan = (inFlightPosts.get(key.post_id) || 0) <= 1;
  const stale = await q<{ id: string }>(
    `delete from ${table} where ${cond} and status='sending' and (${orphan ? "true" : "false"} or created_at < now() - interval '${STALE_SENDING}') returning id`, kv);
  if (stale.length) await logEvent("warn", "publish", `${table}: перейнято завислу резервацію (попередню публікацію обірвав перезапуск або збій)`, { postId: key.post_id });
  const cols = [...kc, ...Object.keys(extra)], vals = [...kv, ...Object.values(extra)];
  const r = await one<{ id: string }>(
    `insert into ${table}(${cols.join(",")},status) values(${vals.map((_, i) => `$${i + 1}`).join(",")},'sending')
     on conflict (${kc.join(",")}) do nothing returning id`, vals);
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
  const post = await one<{ channels: any }>(`select channels from post where id=$1`, [postId]);
  const enabled = enabledNets(post?.channels);
  const sent = new Set(await alreadySentNetworks(postId));
  if (!enabled.length || enabled.some((k) => !sent.has(k))) return false;
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

// Мережі, куди пост УЖЕ відправлено (status='sent') — щоб не публікувати вдруге (публікація один раз на мережу).
export async function alreadySentNetworks(postId: string): Promise<string[]> {
  const [tgSent, thSent, metaSent, liSent] = await Promise.all([
    one<{ n: number }>(`select count(*)::int as n from telegram_publish where post_id=$1 and status='sent'`, [postId]),
    one<{ n: number }>(`select count(*)::int as n from threads_publish where post_id=$1 and status='sent'`, [postId]),
    q<{ channel: string }>(`select distinct channel from meta_publish where post_id=$1 and status='sent'`, [postId]),
    one<{ n: number }>(`select count(*)::int as n from linkedin_publish where post_id=$1 and status='sent'`, [postId]),
  ]);
  const sent: string[] = [];
  if ((tgSent?.n || 0) > 0) sent.push("telegram");
  if ((thSent?.n || 0) > 0) sent.push("threads");
  for (const r of metaSent) if (r.channel) sent.push(r.channel); // facebook / instagram
  if ((liSent?.n || 0) > 0) sent.push("linkedin");
  return sent;
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
     union all select 'linkedin', created_at from linkedin_publish where post_id=$1 and status='sending'`, [postId]);
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

export function publishPostToChannels(ws: string, postId: string, onlyNets?: string[]): Promise<PubResult[]> {
  return tracked(postId, () => publishPostToChannelsNow(ws, postId, onlyNets));
}
async function publishPostToChannelsNow(ws: string, postId: string, onlyNets?: string[]): Promise<PubResult[]> {
  const post = await one<{ content: string; channels: any; format: string | null; first_comment: string | null }>(
    `select p.content, p.channels, p.intent, p.format, p.first_comment from post p
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
  const sentSet = new Set(await alreadySentNetworks(postId));
  // «Створи один раз - сервіс сам перепакує»: мережі без власної версії тексту адаптуються
  // автоматично перед відправкою (один LLM-виклик на всі відсутні; при збої - майстер-текст як раніше).
  // Покриває і плановий автопостер, і публікацію з бота - не лише кнопку «Підлаштувати» в композері.
  // ⚠️ АЛЕ якщо адаптацією керує людина (композер поставив channels.manual_adapt при пер-канальному
  // ✨ або ↺), сервер НЕ перепаковує: мережі, які юзер свідомо лишив зі своїм текстом, інакше все одно
  // переписувались при публікації - і прев'ю в композері брехало (фідбек Олега «підлаштувало всюди,
  // а мені подобався мій перший текст»).
  const manual = ch.manual_adapt === true;
  const missing = manual ? [] : enabled.filter((k) => !sentSet.has(k) && !(ch[k] && String(ch[k].text || "").trim()));
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
  const textOf = (k: string) => (ch[k] && ch[k].text) || post.content;
  const imageUrl = imageUrls[0] || null;
  const results: PubResult[] = [];
  const [tgc, thTok, mt, li] = await Promise.all([
    one<{ bot_token: string | null; channel_chat_id: string | null; group_chat_id: string | null; channel_username: string | null }>(`select bot_token, channel_chat_id, group_chat_id, channel_username from telegram_config where workspace_id=$1`, [ws]),
    thValidToken(ws),
    one<{ page_id: string | null; page_token: string | null; ig_user_id: string | null; token_expires_at: string | null }>(`select page_id, page_token, ig_user_id, token_expires_at from meta_config where workspace_id=$1`, [ws]),
    one<{ member_urn: string; access_token: string; token_expires_at: string | null }>(`select member_urn, access_token, token_expires_at from linkedin_config where workspace_id=$1`, [ws]),
  ]);
  for (const k of enabled) {
    if (sentSet.has(k)) { results.push({ channel: k, status: "skipped" }); continue; } // уже опубліковано в цю мережу
    // id щойно опублікованого поста в мережі - під ним піде перший коментар (Telegram коментарів не має)
    let target = "";
    try {
      if (k === "telegram") {
        if (!tgc?.bot_token) throw new Error("Telegram не підключено");
        let any = false, already = false, tailErr = "";
        const cap = textOf(k);
        const sentChats = new Set<string>(); // один фізичний чат не отримує пост двічі (channel==group → дубль)
        for (const [t, chat] of [["channel", tgc.channel_chat_id], ["group", tgc.group_chat_id]] as const) {
          if (!chat) continue;
          if (sentChats.has(chat)) continue; // той самий chat_id в обох полях → пропускаємо повтор
          sentChats.add(chat);
          // атомарна резервація ПЕРЕД викликом Telegram - захист від гонки (подвійний клік, збіг
          // ручної публікації з автопостом). Хтось інший уже зарезервував/надіслав цю ціль → пропускаємо.
          const rv = await reservePub("telegram_publish", { post_id: postId, target: t }, { chat_id: chat });
          if (rv === "sent") { already = true; continue; }
          if (rv === "busy") throw new Error(BUSY);
          const reserved = rv;
          try {
            let r: { message_id: number };
            // текст довший за підпис (1024) іде окремим повідомленням ПІСЛЯ медіа. Якщо впаде саме він -
            // медіа вже в каналі: резервацію НЕ звільняємо (інакше повтор задублював би альбом), а кажемо прямо
            const tail = async () => {
              if (cap.length <= 1024) return;
              try { await tg.sendMessage(tgc.bot_token!, chat, cap); } catch (e: any) { tailErr = e.message; }
            };
            const vErr = videoLimit("telegram");
            if (vErr) throw new Error(vErr);
            if (video) {
              // за адресою Telegram тягне лише до 20 МБ; більше (до 50) - надсилаємо файл самі
              const src = videoSize <= tg.TG_VIDEO_URL_MAX ? { url: videoUrl } : { file: await readFile(videoPath), name: video.filename };
              r = await tg.sendVideo(tgc.bot_token, chat, src, cap.length <= 1024 ? cap : "", video);
              await tail();
            } else if (carousel) {
              // альбом: підпис на першому кадрі; довший за 1024 - окремим повідомленням під альбомом
              const msgs = await tg.sendMediaGroup(tgc.bot_token, chat, imageUrls, cap.length <= 1024 ? cap : "");
              r = msgs[0];
              await tail();
            } else if (imageUrl) {
              r = await tg.sendPhoto(tgc.bot_token, chat, imageUrl, cap.length <= 1024 ? cap : "");
              await tail(); // підпис > ліміту Telegram → текст окремо
            } else {
              r = await tg.sendMessage(tgc.bot_token, chat, cap);
            }
            // @username каналу потрібен для гарного лінка t.me/<name>/<id>. Тягнемо ОДИН раз і
            // кешуємо в telegram_config: далі публікації обходяться без цього запиту.
            if (t === "channel" && tgc.channel_username == null) {
              try {
                const info = await tg.getChat(tgc.bot_token, chat);
                tgc.channel_username = info.username || "";
                await q(`update telegram_config set channel_username=$2 where workspace_id=$1`, [ws, tgc.channel_username]);
              } catch { tgc.channel_username = ""; } // не вийшло - лишиться лінк t.me/c/<internal>/<id>
            }
            await q(`update telegram_publish set message_id=$2, status='sent', permalink=nullif($3,'') where id=$1`,
              [reserved.id, r.message_id, tgLink(chat, r.message_id, t === "channel" ? tgc.channel_username : null)]);
            any = true;
          } catch (e: any) {
            await q(`delete from telegram_publish where id=$1`, [reserved.id]); // звільняємо резервацію - можна повторити пізніше
            throw e;
          }
        }
        if (!any) {
          if (already) { results.push({ channel: k, status: "skipped" }); continue; }
          throw new Error("Не вказано канал/групу");
        }
        if (tailErr) {
          await logEvent("warn", "publish", `Telegram: медіа вийшло, а текст окремим повідомленням - ні: ${tailErr}`, { ws, postId });
          results.push({ channel: k, status: "sent", note: `медіа вийшло, а довгий текст окремим повідомленням - ні (${tailErr}); допиши його в канал вручну` });
          continue;
        }
      } else if (k === "threads") {
        if (!thTok) throw new Error("Threads не підключено");
        const thErr = videoLimit("threads"); if (thErr) throw new Error(thErr);
        // 🧵 стратегія Threads (settings_block.threads_strategy): гілка для довгих + відкладена CTA-гілка
        const strat = await getSetting<any>(ws, "threads_strategy", {});
        const perPost = ch[k] || {};
        // гілка: явний прапорець на пості АБО авто-режим для майстер-текстів понад ліміт (500)
        const wantThread = perPost.thread === true || (strat.thread === "auto" && perPost.thread !== false && post.content.length > 500);
        // резервація ОДИН раз для всього поста (root) - гілка/ветки нижче лише розвивають цей root
        const rv = await reservePub("threads_publish", { post_id: postId });
        if (rv === "sent") { results.push({ channel: k, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        const reserved = rv;
        let rootId: string;
        try {
          if (wantThread) {
            // гілка пакує ПОВНИЙ майстер-текст (а не скорочену 500-символьну версію) - у цьому її сенс
            const parts = await threadsSplit(ws, post.content, perPost.number !== false);
            // карусель - у першому пості гілки (root), відповіді лишаються текстовими
            const first = video
              ? await threads.publishVideo(thTok.token, thTok.userId, parts[0], videoUrl)
              : carousel
              ? await threads.publishCarousel(thTok.token, thTok.userId, parts[0], imageUrls)
              : await threads.publish(thTok.token, thTok.userId, parts[0], imageUrl || undefined);
            rootId = first.mediaId;
            // root УЖЕ в мережі → фіксуємо sent ОДРАЗУ: якщо якась ветка впаде, повторна публікація
            // не задублює root (дедуп «раз на мережу» побачить sent)
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
            `insert into threads_reply_job(workspace_id,post_id,root_media_id,reply_text,due_at)
             values($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
            [ws, postId, rootId, cta, String(delayMin)]);
        }
      } else if (k === "facebook") {
        if (!mt?.page_id || !mt.page_token) throw new Error("Facebook не підключено");
        // строк у meta_config - це строк токена КОРИСТУВАЧА (~60 днів); токен Сторінки, отриманий із
        // нього, не протухає. Тож заздалегідь не відмовляємо: якщо доступ справді втрачено, Meta
        // відповість помилкою 190, і людина побачить «перепідключи» (fbFetch).
        const rv = await reservePub("meta_publish", { post_id: postId, channel: "facebook" });
        if (rv === "sent") { results.push({ channel: k, status: "skipped" }); continue; }
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
        if (!mt?.ig_user_id || !mt.page_token) throw new Error("Instagram не підключено");
        if (!images.length && !video) throw new Error("Instagram потребує фото або відео");
        const igErr = videoLimit("instagram"); if (igErr) throw new Error(igErr);
        const rv = await reservePub("meta_publish", { post_id: postId, channel: "instagram" });
        if (rv === "sent") { results.push({ channel: k, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        const reserved = rv;
        try {
          // IG приймає лише JPEG з пропорціями 0.8-1.91 → за потреби готуємо сумісну копію (PNG з AI-генерації падав).
          // Для каруселі - кожен кадр.
          const safe: string[] = [];
          for (const f of images) safe.push(await ensureIgSafeImage(ws, f));
          const safeUrls = safe.map((f) => `${env.appBaseUrl}/media/${f}`);
          const r = video
            ? await meta.publishReelToInstagram(mt.ig_user_id, mt.page_token, videoUrl, textOf(k))
            : carousel
            ? await meta.publishCarouselToInstagram(mt.ig_user_id, mt.page_token, safeUrls, textOf(k))
            : await meta.publishToInstagram(mt.ig_user_id, mt.page_token, safeUrls[0], textOf(k));
          await q(`update meta_publish set external_id=$2, status='sent' where id=$1`, [reserved.id, r.mediaId]);
          target = r.mediaId;
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
        if (rv === "sent") { results.push({ channel: k, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        const reserved = rv;
        try {
          // зображення LinkedIn приймає лише через власний upload (не за URL) - читаємо локальні файли
          const bufs: Buffer[] = [];
          for (const f of images) { try { bufs.push(await readFile(join(MEDIA_DIR, f))); } catch { /* файл зник - без нього */ } }
          const r = await linkedin.publish(li.access_token, li.member_urn, textOf(k), bufs, video ? { path: videoPath, size: videoSize } : undefined);
          // URN поста → лінк збирається детерміновано, без додаткового запиту
          await q(`update linkedin_publish set external_id=$2, status='sent', permalink=nullif($3,'') where id=$1`,
            [reserved.id, r.postId || null, liLink(r.postId || null)]);
          target = r.postId || "";
        } catch (e: any) { await q(`delete from linkedin_publish where id=$1`, [reserved.id]); throw e; }
      }
      // 💬 перший коментар: пост уже в мережі, тож збій коментаря НЕ робить публікацію помилковою -
      // він окремим станом поруч (повтор - воркер або кнопка «Надіслати коментар»)
      let cm: { status: string; error?: string } | undefined;
      if (target) {
        try {
          const st = await commentAfterPublish(postId, k, target);
          if (st) cm = { status: st.status, ...(st.error ? { error: st.error } : {}) };
        } catch (e: any) {
          await logEvent("warn", "comment", `перший коментар не поставлено в чергу: ${e.message}`, { ws, postId });
        }
      }
      results.push({ channel: k, status: "sent", ...(cm ? { comment: cm } : {}) });
    } catch (e: any) { results.push({ channel: k, status: "error", error: e.message }); }
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
const NET_UA: Record<string, string> = { telegram: "Telegram", threads: "Threads", linkedin: "LinkedIn", instagram: "Instagram", facebook: "Facebook" };
async function publishStoryToChannels(ws: string, postId: string, ch: any, onlyNets?: string[]): Promise<PubResult[]> {
  const enabled = enabledNets(ch).filter((k) => !onlyNets || onlyNets.includes(k));
  const sentSet = new Set(await alreadySentNetworks(postId));
  const frames = await postMediaList(postId);
  const mt = await one<{ page_id: string | null; page_token: string | null; ig_user_id: string | null; token_expires_at: string | null }>(
    `select page_id, page_token, ig_user_id, token_expires_at from meta_config where workspace_id=$1`, [ws]);
  const url = (f: string) => `${env.appBaseUrl}/media/${f}`;
  const results: PubResult[] = [];
  for (const k of enabled) {
    if (sentSet.has(k)) { results.push({ channel: k, status: "skipped" }); continue; }
    try {
      if (!STORY_NETS.includes(k)) throw new Error(`сторіс публікуються лише в Instagram і Facebook - ${NET_UA[k]} їх через API не приймає; зніми ${NET_UA[k]} із цього поста`);
      if (!frames.length) throw new Error("у сторіс немає жодного кадру - додай фото чи відео");
      if (k === "instagram" && (!mt?.ig_user_id || !mt.page_token)) throw new Error("Instagram не підключено");
      if (k === "facebook" && (!mt?.page_id || !mt.page_token)) throw new Error("Facebook не підключено");
      // межі - ДО виклику: відео в сторіс Instagram - до 60 с (а мережа сказала б це через хвилину обробки)
      const longVid = frames.find((m) => m.kind === "video" && Number(m.duration) > 60);
      if (k === "instagram" && longVid) throw new Error(`відео в сторіс Instagram - до 60 с, а тут ${Math.round(Number(longVid.duration))} с - вріж його`);
      const rv = await reservePub("meta_publish", { post_id: postId, channel: k });
      if (rv === "sent") { results.push({ channel: k, status: "skipped" }); continue; }
      if (rv === "busy") throw new Error(BUSY);
      const reserved = rv;
      const ids: string[] = [];
      try {
        for (const m of frames) {
          if (k === "instagram") {
            const r = m.kind === "video"
              ? await meta.publishStoryToInstagram(mt!.ig_user_id!, mt!.page_token!, { videoUrl: url(m.filename) })
              : await meta.publishStoryToInstagram(mt!.ig_user_id!, mt!.page_token!, { imageUrl: url(await ensureIgSafeImage(ws, m.filename, { story: true })) });
            ids.push(r.mediaId);
          } else {
            const r = m.kind === "video"
              ? await meta.publishVideoStoryToPage(mt!.page_id!, mt!.page_token!, url(m.filename))
              : await meta.publishPhotoStoryToPage(mt!.page_id!, mt!.page_token!, url(m.filename));
            ids.push(r.postId);
          }
        }
      } catch (e: any) {
        if (!ids.length) { await q(`delete from meta_publish where id=$1`, [reserved.id]); throw e; }
        // частина кадрів уже в мережі: фіксуємо «надіслано», щоб повтор НЕ задублював їх, і кажемо прямо,
        // скільки вийшло - решту кадрів людина додасть окремою сторіс
        await q(`update meta_publish set external_id=$2, status='sent' where id=$1`, [reserved.id, ids.join(",")]);
        await logEvent("warn", "story", `${NET_UA[k]}: опубліковано ${ids.length} з ${frames.length} кадрів сторіс, далі збій: ${e.message}`, { ws, postId });
        results.push({ channel: k, status: "error", error: `опубліковано ${ids.length} з ${frames.length} кадрів, далі збій: ${e.message}` });
        continue;
      }
      await q(`update meta_publish set external_id=$2, status='sent' where id=$1`, [reserved.id, ids.join(",")]);
      results.push({ channel: k, status: "sent" });
    } catch (e: any) { results.push({ channel: k, status: "error", error: e.message }); }
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
  const [metaSent, ytSent, ttSent] = await Promise.all([
    q<{ channel: string }>(`select distinct channel from meta_publish where post_id=$1 and status='sent'`, [postId]),
    one<{ n: number }>(`select count(*)::int as n from youtube_publish where post_id=$1 and status='sent'`, [postId]),
    one<{ n: number }>(`select count(*)::int as n from tiktok_publish where post_id=$1 and status='sent'`, [postId]),
  ]);
  const sent: string[] = metaSent.map((r) => r.channel).filter(Boolean);
  if ((ytSent?.n || 0) > 0) sent.push("youtube");
  if ((ttSent?.n || 0) > 0) sent.push("tiktok");
  return sent;
}

// Спільний патерн «освіжи OAuth-токен, якщо скоро протухне» (YouTube/TikTok мають однакову механіку
// refresh_token → новий access_token; раніше два дослівно схожі блоки жили в publishReelToChannels)
async function freshToken(
  cfg: { access_token: string; refresh_token: string | null; token_expires_at: string | null },
  refresh: (rt: string) => Promise<{ access_token: string; refresh_token?: string; expires_in: number }>,
  persist: (token: string, refreshToken: string | null, expiresAt: string) => Promise<void>
): Promise<string> {
  const exp = cfg.token_expires_at ? new Date(cfg.token_expires_at).getTime() : 0;
  if (!cfg.refresh_token || (exp && exp - Date.now() > 5 * 60e3)) return cfg.access_token;
  const r = await refresh(cfg.refresh_token);
  const newExp = new Date(Date.now() + r.expires_in * 1000).toISOString();
  await persist(r.access_token, r.refresh_token || cfg.refresh_token, newExp);
  return r.access_token;
}

export function publishReelToChannels(ws: string, postId: string, nets: string[]): Promise<PubResult[]> {
  return tracked(postId, () => publishReelToChannelsNow(ws, postId, nets));
}
async function publishReelToChannelsNow(ws: string, postId: string, nets: string[]): Promise<PubResult[]> {
  const post = await one<{ content: string; channels: any; reel_video: string | null; own_video: string | null }>(
    `select p.content, p.channels, p.reel_video, (select m.filename from media_asset m where m.id=p.media_id and m.kind='video') as own_video
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
  let videoBuf: Buffer | null = null; // читаємо з диска один раз (YouTube/TikTok вантажать файлом)
  const getBuf = async () => (videoBuf ??= await readFile(join(MEDIA_DIR, post.reel_video!)));
  for (const k of nets) {
    if (sentSet.has(k)) { results.push({ channel: k, status: "skipped" }); continue; }
    try {
      if (k === "instagram") {
        const mt = await one<{ page_token: string | null; ig_user_id: string | null }>(`select page_token, ig_user_id from meta_config where workspace_id=$1`, [ws]);
        if (!mt?.ig_user_id || !mt.page_token) throw new Error("Instagram не підключено");
        const rv = await reservePub("meta_publish", { post_id: postId, channel: "instagram" });
        if (rv === "sent") { results.push({ channel: k, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        try {
          const r = await meta.publishReelToInstagram(mt.ig_user_id, mt.page_token, videoUrl, caption);
          await q(`update meta_publish set external_id=$2, status='sent' where id=$1`, [rv.id, r.mediaId]);
        } catch (e: any) { await q(`delete from meta_publish where id=$1`, [rv.id]); throw e; }
      } else if (k === "facebook") {
        const mt = await one<{ page_id: string | null; page_token: string | null }>(`select page_id, page_token from meta_config where workspace_id=$1`, [ws]);
        if (!mt?.page_id || !mt.page_token) throw new Error("Facebook не підключено");
        const rv = await reservePub("meta_publish", { post_id: postId, channel: "facebook" });
        if (rv === "sent") { results.push({ channel: k, status: "skipped" }); continue; }
        if (rv === "busy") throw new Error(BUSY);
        try {
          const r = await meta.publishVideoToPage(mt.page_id, mt.page_token, caption, videoUrl);
          await q(`update meta_publish set external_id=$2, status='sent', permalink=nullif($3,'') where id=$1`, [rv.id, r.id, fbVideoLink(r.id)]);
        } catch (e: any) { await q(`delete from meta_publish where id=$1`, [rv.id]); throw e; }
      } else if (k === "youtube") {
        const yc = await one<{ access_token: string; refresh_token: string | null; token_expires_at: string | null }>(
          `select access_token, refresh_token, token_expires_at from youtube_config where workspace_id=$1`, [ws]);
        if (!yc) throw new Error("YouTube не підключено");
        const token = await freshToken(yc,
          (rt) => youtube.refreshAccessToken(env.google.clientId, env.google.clientSecret, rt),
          async (t, _rt, expAt) => { await q(`update youtube_config set access_token=$2, token_expires_at=$3, updated_at=now() where workspace_id=$1`, [ws, t, expAt]); });
        const title = caption.split("\n")[0].replace(/#[^\s#]+/g, "").trim() || "Reels";
        const r = await youtube.uploadVideo(token, await getBuf(), title, caption);
        await q(`insert into youtube_publish(post_id,external_id,status) values($1,$2,'sent')`, [postId, r.videoId]);
      } else if (k === "tiktok") {
        const tc = await one<{ access_token: string; refresh_token: string | null; token_expires_at: string | null }>(
          `select access_token, refresh_token, token_expires_at from tiktok_config where workspace_id=$1`, [ws]);
        if (!tc) throw new Error("TikTok не підключено");
        const token = await freshToken(tc,
          (rt) => tiktok.refreshToken(env.tiktok.clientKey, env.tiktok.clientSecret, rt),
          async (t, rt, expAt) => { await q(`update tiktok_config set access_token=$2, refresh_token=$3, token_expires_at=$4, updated_at=now() where workspace_id=$1`, [ws, t, rt, expAt]); });
        const r = await tiktok.uploadToInbox(token, await getBuf());
        await q(`insert into tiktok_publish(post_id,external_id,status) values($1,$2,'sent')`, [postId, r.publishId]);
      } else { throw new Error("невідома мережа для рілсів"); }
      results.push({ channel: k, status: "sent" });
    } catch (e: any) { results.push({ channel: k, status: "error", error: e.message }); }
  }
  return results;
}

export async function startReelPublishJob(ws: string, postId: string, nets: string[]): Promise<void> {
  await startJob("reel-pub", postId, ws, async () => ({ results: await publishReelToChannels(ws, postId, nets) }));
}
