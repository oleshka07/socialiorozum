// Спільна публікація поста в усі обрані мережі (composer «Опублікувати» + плановий автопостер).
import { q, one } from "./db.js";
import { env } from "./env.js";
import * as tg from "./telegram.js";
import * as threads from "./threads.js";
import * as meta from "./meta.js";

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

export type PubResult = { channel: string; status: "sent" | "error"; error?: string };

// Публікує пост у кожну ввімкнену в post.channels мережу (своїм текстом + медіа).
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
  const textOf = (k: string) => (ch[k] && ch[k].text) || post.content;
  const imageUrl = post.filename ? `${env.appBaseUrl}/media/${post.filename}` : null;
  const results: PubResult[] = [];
  const [tgc, thTok, mt] = await Promise.all([
    one<{ bot_token: string | null; channel_chat_id: string | null; group_chat_id: string | null }>(`select bot_token, channel_chat_id, group_chat_id from telegram_config where workspace_id=$1`, [ws]),
    thValidToken(ws),
    one<{ page_id: string | null; page_token: string | null; ig_user_id: string | null }>(`select page_id, page_token, ig_user_id from meta_config where workspace_id=$1`, [ws]),
  ]);
  for (const k of enabled) {
    try {
      if (k === "telegram") {
        if (!tgc?.bot_token) throw new Error("Telegram не підключено");
        let any = false;
        const cap = textOf(k);
        for (const [t, chat] of [["channel", tgc.channel_chat_id], ["group", tgc.group_chat_id]] as const) {
          if (!chat) continue;
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
        if (!imageUrl) throw new Error("Instagram потребує фото");
        const r = await meta.publishToInstagram(mt.ig_user_id, mt.page_token, imageUrl, textOf(k));
        await q(`insert into meta_publish(post_id,channel,external_id,status) values($1,'instagram',$2,'sent')`, [postId, r.mediaId]);
      }
      results.push({ channel: k, status: "sent" });
    } catch (e: any) { results.push({ channel: k, status: "error", error: e.message }); }
  }
  return results;
}
