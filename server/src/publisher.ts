// Спільна публікація поста в усі обрані мережі (composer «Опублікувати» + плановий автопостер).
import { q, one } from "./db.js";
import { env } from "./env.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as tg from "./telegram.js";
import * as threads from "./threads.js";
import * as meta from "./meta.js";
import * as linkedin from "./linkedin.js";
import * as youtube from "./youtube.js";
import * as tiktok from "./tiktok.js";
import { MEDIA_DIR } from "./media.js";
import { ensureIgSafeImage } from "./images.js";
import { adaptForChannels, reelCaption } from "./pipeline.js";
import { logEvent } from "./log.js";

async function thValidToken(ws: string): Promise<{ token: string; userId: string } | null> {
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

export type PubResult = { channel: string; status: "sent" | "error" | "skipped"; error?: string };

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
// Мережі, куди вже публікували (status='sent'), ПРОПУСКАЮТЬСЯ (публікація один раз на мережу) —
// це стосується і ручної публікації, і планового автопостера (schedule на ІНШІ мережі).
// Якщо жодної мережі не обрано — нічого не публікує (порожній результат), без тихого fallback.
export async function publishPostToChannels(ws: string, postId: string): Promise<PubResult[]> {
  const post = await one<{ content: string; channels: any; filename: string | null }>(
    `select p.content, p.channels, ma.filename from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       left join media_asset ma on ma.id=p.media_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post) throw new Error("пост не знайдено");
  const ch = post.channels || {};
  const enabled = Object.keys(ch).filter((k) => ch[k] && ch[k].on);
  const sentSet = new Set(await alreadySentNetworks(postId));
  // «Створи один раз - сервіс сам перепакує»: мережі без власної версії тексту адаптуються
  // автоматично перед відправкою (один LLM-виклик на всі відсутні; при збої - майстер-текст як раніше).
  // Покриває і плановий автопостер, і публікацію з бота - не лише кнопку «Підлаштувати» в композері.
  const missing = enabled.filter((k) => !sentSet.has(k) && !(ch[k] && String(ch[k].text || "").trim()));
  if (missing.length) {
    try {
      const variants = await adaptForChannels(ws, post.content, missing);
      let changed = false;
      for (const k of missing) if (variants[k]) { ch[k] = { ...(ch[k] || {}), on: true, text: variants[k] }; changed = true; }
      if (changed) await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify(ch)]);
    } catch { /* адаптація не критична - публікуємо майстер-текстом */ }
  }
  const textOf = (k: string) => (ch[k] && ch[k].text) || post.content;
  const imageUrl = post.filename ? `${env.appBaseUrl}/media/${post.filename}` : null;
  const results: PubResult[] = [];
  const [tgc, thTok, mt, li] = await Promise.all([
    one<{ bot_token: string | null; channel_chat_id: string | null; group_chat_id: string | null }>(`select bot_token, channel_chat_id, group_chat_id from telegram_config where workspace_id=$1`, [ws]),
    thValidToken(ws),
    one<{ page_id: string | null; page_token: string | null; ig_user_id: string | null }>(`select page_id, page_token, ig_user_id from meta_config where workspace_id=$1`, [ws]),
    one<{ member_urn: string; access_token: string; token_expires_at: string | null }>(`select member_urn, access_token, token_expires_at from linkedin_config where workspace_id=$1`, [ws]),
  ]);
  for (const k of enabled) {
    if (sentSet.has(k)) { results.push({ channel: k, status: "skipped" }); continue; } // уже опубліковано в цю мережу
    try {
      if (k === "telegram") {
        if (!tgc?.bot_token) throw new Error("Telegram не підключено");
        let any = false;
        const cap = textOf(k);
        const sentChats = new Set<string>(); // один фізичний чат не отримує пост двічі (channel==group → дубль)
        for (const [t, chat] of [["channel", tgc.channel_chat_id], ["group", tgc.group_chat_id]] as const) {
          if (!chat) continue;
          if (sentChats.has(chat)) continue; // той самий chat_id в обох полях → пропускаємо повтор
          sentChats.add(chat);
          let r: { message_id: number };
          if (imageUrl) {
            r = await tg.sendPhoto(tgc.bot_token, chat, imageUrl, cap.length <= 1024 ? cap : "");
            if (cap.length > 1024) await tg.sendMessage(tgc.bot_token, chat, cap); // підпис > ліміту Telegram → текст окремо
          } else {
            r = await tg.sendMessage(tgc.bot_token, chat, cap);
          }
          await q(`insert into telegram_publish(post_id,target,chat_id,message_id,status) values($1,$2,$3,$4,'sent')`, [postId, t, chat, r.message_id]);
          any = true;
        }
        if (!any) throw new Error("Не вказано канал/групу");
      } else if (k === "threads") {
        if (!thTok) throw new Error("Threads не підключено");
        const r = await threads.publish(thTok.token, thTok.userId, textOf(k), imageUrl || undefined);
        await q(`insert into threads_publish(post_id,media_id,status) values($1,$2,'sent')`, [postId, r.mediaId]);
      } else if (k === "facebook") {
        if (!mt?.page_id || !mt.page_token) throw new Error("Facebook не підключено");
        const r = imageUrl ? await meta.publishPhotoToPage(mt.page_id, mt.page_token, textOf(k), imageUrl) : await meta.publishToPage(mt.page_id, mt.page_token, textOf(k));
        await q(`insert into meta_publish(post_id,channel,external_id,status) values($1,'facebook',$2,'sent')`, [postId, (r as any).post_id || r.id]);
      } else if (k === "instagram") {
        if (!mt?.ig_user_id || !mt.page_token) throw new Error("Instagram не підключено");
        if (!post.filename) throw new Error("Instagram потребує фото");
        // IG приймає лише JPEG з пропорціями 0.8-1.91 → за потреби готуємо сумісну копію (PNG з AI-генерації падав)
        const safe = await ensureIgSafeImage(ws, post.filename);
        const r = await meta.publishToInstagram(mt.ig_user_id, mt.page_token, `${env.appBaseUrl}/media/${safe}`, textOf(k));
        await q(`insert into meta_publish(post_id,channel,external_id,status) values($1,'instagram',$2,'sent')`, [postId, r.mediaId]);
      } else if (k === "linkedin") {
        if (!li?.access_token || !li.member_urn) throw new Error("LinkedIn не підключено");
        if (li.token_expires_at && new Date(li.token_expires_at).getTime() < Date.now())
          throw new Error("Токен LinkedIn протух (живе 60 днів) - перепідключи у Налаштування → Канали");
        // зображення LinkedIn приймає лише через власний upload (не за URL) - читаємо локальний файл
        let imgBuf: Buffer | undefined;
        if (post.filename) { try { imgBuf = await readFile(join(MEDIA_DIR, post.filename)); } catch { /* без фото */ } }
        const r = await linkedin.publish(li.access_token, li.member_urn, textOf(k), imgBuf);
        await q(`insert into linkedin_publish(post_id,external_id,status) values($1,$2,'sent')`, [postId, r.postId || null]);
      }
      results.push({ channel: k, status: "sent" });
    } catch (e: any) { results.push({ channel: k, status: "error", error: e.message }); }
  }
  return results;
}

// ===================== ПУБЛІКАЦІЯ ВІДЕО-РІЛСІВ =====================
// Окремий шлях від текстових постів: IG (контейнер REELS), FB (відео Сторінки),
// YouTube (Shorts), TikTok (чернетка юзеру - до аудиту застосунку прямий пост недоступний).
// Фонова джоба (IG обробляє відео до ~3 хв - жоден HTTP-таймаут не переживе синхронний виклик).
export type ReelPubJob = { status: "running" | "done" | "error"; results?: PubResult[]; error?: string; startedAt: number };
export const reelPubJobs = new Map<string, ReelPubJob>();

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

export async function publishReelToChannels(ws: string, postId: string, nets: string[]): Promise<PubResult[]> {
  const post = await one<{ content: string; channels: any; reel_video: string | null }>(
    `select p.content, p.channels, p.reel_video from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post) throw new Error("пост не знайдено");
  if (!post.reel_video) throw new Error("рілс ще не зібрано - спершу 🎞 на картці сценарію");
  const ch = post.channels || {};
  // підпис до відео генеруємо один раз і кешуємо на пості (channels.reel_caption)
  let caption: string = String(ch.reel_caption || "").trim();
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
        const r = await meta.publishReelToInstagram(mt.ig_user_id, mt.page_token, videoUrl, caption);
        await q(`insert into meta_publish(post_id,channel,external_id,status) values($1,'instagram',$2,'sent')`, [postId, r.mediaId]);
      } else if (k === "facebook") {
        const mt = await one<{ page_id: string | null; page_token: string | null }>(`select page_id, page_token from meta_config where workspace_id=$1`, [ws]);
        if (!mt?.page_id || !mt.page_token) throw new Error("Facebook не підключено");
        const r = await meta.publishVideoToPage(mt.page_id, mt.page_token, caption, videoUrl);
        await q(`insert into meta_publish(post_id,channel,external_id,status) values($1,'facebook',$2,'sent')`, [postId, r.id]);
      } else if (k === "youtube") {
        const yc = await one<{ access_token: string; refresh_token: string | null; token_expires_at: string | null }>(
          `select access_token, refresh_token, token_expires_at from youtube_config where workspace_id=$1`, [ws]);
        if (!yc) throw new Error("YouTube не підключено");
        let token = yc.access_token;
        const exp = yc.token_expires_at ? new Date(yc.token_expires_at).getTime() : 0;
        if (yc.refresh_token && (!exp || exp - Date.now() < 5 * 60e3)) {
          const r = await youtube.refreshAccessToken(env.google.clientId, env.google.clientSecret, yc.refresh_token);
          token = r.access_token;
          await q(`update youtube_config set access_token=$2, token_expires_at=$3, updated_at=now() where workspace_id=$1`,
            [ws, token, new Date(Date.now() + r.expires_in * 1000).toISOString()]);
        }
        const title = caption.split("\n")[0].replace(/#[^\s#]+/g, "").trim() || "Reels";
        const r = await youtube.uploadVideo(token, await getBuf(), title, caption);
        await q(`insert into youtube_publish(post_id,external_id,status) values($1,$2,'sent')`, [postId, r.videoId]);
      } else if (k === "tiktok") {
        const tc = await one<{ access_token: string; refresh_token: string | null; token_expires_at: string | null }>(
          `select access_token, refresh_token, token_expires_at from tiktok_config where workspace_id=$1`, [ws]);
        if (!tc) throw new Error("TikTok не підключено");
        let token = tc.access_token;
        const exp = tc.token_expires_at ? new Date(tc.token_expires_at).getTime() : 0;
        if (tc.refresh_token && (!exp || exp - Date.now() < 5 * 60e3)) {
          const r = await tiktok.refreshToken(env.tiktok.clientKey, env.tiktok.clientSecret, tc.refresh_token);
          token = r.access_token;
          await q(`update tiktok_config set access_token=$2, refresh_token=$3, token_expires_at=$4, updated_at=now() where workspace_id=$1`,
            [ws, token, r.refresh_token || tc.refresh_token, new Date(Date.now() + r.expires_in * 1000).toISOString()]);
        }
        const r = await tiktok.uploadToInbox(token, await getBuf());
        await q(`insert into tiktok_publish(post_id,external_id,status) values($1,$2,'sent')`, [postId, r.publishId]);
      } else { throw new Error("невідома мережа для рілсів"); }
      results.push({ channel: k, status: "sent" });
    } catch (e: any) { results.push({ channel: k, status: "error", error: e.message }); }
  }
  return results;
}

export function startReelPublishJob(ws: string, postId: string, nets: string[]): void {
  reelPubJobs.set(postId, { status: "running", startedAt: Date.now() });
  publishReelToChannels(ws, postId, nets)
    .then((results) => reelPubJobs.set(postId, { status: "done", results, startedAt: Date.now() }))
    .catch(async (e) => { reelPubJobs.set(postId, { status: "error", error: String(e.message).slice(0, 300), startedAt: Date.now() }); await logEvent("error", "reel-pub", e.message); });
}
