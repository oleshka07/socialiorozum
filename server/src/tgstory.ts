// 📲 Сторіс у профілі Telegram через Telegram Business (Bot API 9.0+: postStory від імені бізнес-акаунта).
//
// Бот сам у канал сторіс не ставить (Telegram дає це лише людям-адмінам), але людина з Telegram Premium може
// підключити бот до свого акаунта: Telegram → Налаштування → Telegram Business → Чат-боти → @бот, з правом
// «Керування історіями». Telegram шле боту апдейт business_connection (id підключення, людина, права), і
// далі бот від її імені ставить сторіс через postStory(business_connection_id, …).
//
// Ми НЕ просимо апдейтів business_message (allowed_updates їх не містить): бот не читає ані бізнес-чатів
// людини, ані її клієнтів - лише ставить сторіс.
//
// Вимоги Telegram до сторіс: фото 1080×1920 до 10 МБ; відео 720×1280, H.265 (HEVC), ключовий кадр щосекунди,
// MPEG4, до 30 МБ і до 60 с; обидва - новим файлом (attach://), за адресою не можна. Живе 6/12/24/48 год;
// post_to_chat_page - лишити в профілі після того, як мине.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { q, one } from "./db.js";
import { env } from "./env.js";
import * as tg from "./telegram.js";
import { MEDIA_DIR } from "./media.js";
import { logEvent } from "./log.js";
import { can, normRole } from "./roles.js";
import type { PostMedia } from "./slides.js";

export const TG_STORY_HOURS = [6, 12, 24, 48];
export const TG_STORY_MAX_SEC = 60;
export const TG_STORY_VIDEO_MAX = 30 * 1024 * 1024;
export const TG_STORY_PHOTO_MAX = 10 * 1024 * 1024;
const botIdOf = (token: string | null | undefined): string => String(token || "").split(":")[0];

export type TgBiz = { id: string; bot_id: string; tg_user_id: string; user_chat_id: string | null; username: string | null; name: string | null; can_stories: boolean; enabled: boolean };

/** Як підписати профіль людям: @нік, інакше імʼя. */
export const bizLabel = (b: Pick<TgBiz, "username" | "name"> | null | undefined): string =>
  b ? (b.username ? "@" + b.username : b.name || "профіль Telegram") : "";

/** Токен бота, яким людина підключила Business: спільний, колишній спільний чи власний бот кабінету. */
async function tokenForBot(botId: string): Promise<string | null> {
  if (env.telegram.botToken && botIdOf(env.telegram.botToken) === botId) return env.telegram.botToken;
  const { ownBotToken } = await import("./tgbot.js");
  return ownBotToken(botId);
}

/** Підключення Business, з яким працює бренд (і його стан). */
export async function brandBiz(ws: string): Promise<TgBiz | null> {
  return one<TgBiz>(`select b.id, b.bot_id, b.tg_user_id::text, b.user_chat_id::text, b.username, b.name, b.can_stories, b.enabled
                       from tg_story_brand sb join tg_business b on b.id=sb.conn_id where sb.workspace_id=$1`, [ws]);
}
/** Чи можна з цього бренду ставити сторіс у профіль Telegram просто зараз. */
export async function tgStoryReady(ws: string): Promise<boolean> {
  const b = await brandBiz(ws);
  return !!b && b.enabled && b.can_stories;
}

/** Що бачить людина в Каналах: підключення бренду, свої підключення (щоб «використати тут») і як підключити. */
export async function tgStoryView(ws: string, userId: string | null): Promise<{
  brand: (TgBiz & { label: string }) | null; mine: Array<TgBiz & { label: string; here: boolean }>; bot: string; linked: boolean;
}> {
  const b = await brandBiz(ws);
  const tgIds = userId ? (await q<{ tg_user_id: string }>(`select tg_user_id::text from tg_owner where user_id=$1`, [userId])).map((r) => r.tg_user_id) : [];
  const mine = tgIds.length ? await q<TgBiz>(
    `select id, bot_id, tg_user_id::text, user_chat_id::text, username, name, can_stories, enabled from tg_business
      where tg_user_id = any($1::bigint[]) order by updated_at desc`, [tgIds]) : [];
  const { botUsername } = await import("./tgbot.js");
  return {
    brand: b ? { ...b, label: bizLabel(b) } : null,
    mine: mine.map((m) => ({ ...m, label: bizLabel(m), here: m.id === b?.id })),
    bot: botUsername(),
    linked: tgIds.length > 0,
  };
}

/** Бренд ставить сторіс у цей профіль (лише своє підключення людини - чужий профіль так не візьмеш). */
export async function useBizForBrand(ws: string, userId: string, connId: string): Promise<TgBiz> {
  const b = await one<TgBiz>(`select b.id, b.bot_id, b.tg_user_id::text, b.user_chat_id::text, b.username, b.name, b.can_stories, b.enabled
                                from tg_business b where b.id=$1 and exists (select 1 from tg_owner o where o.tg_user_id=b.tg_user_id and o.user_id=$2)`, [connId, userId]);
  if (!b) throw new Error("Це підключення не твоє або його вже нема - підключи бот у Telegram Business ще раз.");
  await q(`insert into tg_story_brand(workspace_id, conn_id) values($1,$2) on conflict (workspace_id) do update set conn_id=excluded.conn_id, updated_at=now()`, [ws, b.id]);
  return b;
}
export async function dropBizFromBrand(ws: string): Promise<void> {
  await q(`delete from tg_story_brand where workspace_id=$1`, [ws]);
}

/**
 * Апдейт business_connection: людина підключила (чи відключила, чи змінила права) бот у Telegram Business.
 * Зберігаємо, привʼязуємо до бренду, з яким людина зараз працює в боті (якщо в нього ще нема свого профілю
 * для сторіс і людина там керує каналами), і кажемо людині, що далі.
 */
export async function onBusinessConnection(bc: any, token: string): Promise<void> {
  const id = String(bc?.id || "");
  const uid = Number(bc?.user?.id);
  if (!id || !Number.isFinite(uid)) return;
  const canStories = !!bc?.rights?.can_manage_stories;
  const enabled = bc?.is_enabled !== false;
  const name = [bc?.user?.first_name, bc?.user?.last_name].filter(Boolean).join(" ").slice(0, 120) || null;
  await q(`insert into tg_business(id, bot_id, tg_user_id, user_chat_id, username, name, can_stories, enabled)
           values($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (id) do update set bot_id=excluded.bot_id, user_chat_id=excluded.user_chat_id, username=excluded.username, name=excluded.name,
             can_stories=excluded.can_stories, enabled=excluded.enabled, updated_at=now()`,
    [id, botIdOf(token), uid, bc?.user_chat_id ?? null, bc?.user?.username || null, name, canStories, enabled]);
  const chat = String(bc?.user_chat_id ?? uid);
  const say = (t: string) => tg.sendMessage(token, chat, t).catch(() => {});
  if (!enabled) {
    await logEvent("info", "tgstory", `Telegram Business відключено (${bizLabel({ username: bc?.user?.username, name })})`);
    await say("📲 Бот відключено від Telegram Business - сторіс у твій профіль більше не підуть. Підключити знову: Telegram → Налаштування → Telegram Business → Чат-боти.");
    return;
  }
  // з яким брендом людина працює в боті - туди й підключення (якщо там ще нема живого профілю для сторіс)
  const o = await one<{ workspace_id: string; user_id: string | null }>(`select workspace_id, user_id from tg_owner where tg_user_id=$1`, [uid]);
  let brandNote = "";
  if (!o) {
    brandNote = "\n\nЩоб сторіс ішли з Holos, підключи цей бот до кабінету: Налаштування → Канали → «Підключити наш бот» → Start. Потім: Канали → Telegram → «📲 Сторіс у профілі» → «Використати тут».";
  } else {
    const role = o.user_id ? normRole((await one<{ role: string }>(`select role from workspace_member where user_id=$1 and workspace_id=$2`, [o.user_id, o.workspace_id]))?.role) : "owner";
    const cur = await brandBiz(o.workspace_id);
    const title = (await one<{ title: string | null }>(`select title from workspace where id=$1`, [o.workspace_id]))?.title || "бренд";
    if (!can(role, "manage")) brandNote = `\n\nУ бренді «${title}» канали підключає власник чи «повний доступ» - попроси його в Holos: Канали → Telegram → «📲 Сторіс у профілі».`;
    else if (cur && cur.id !== id && cur.enabled && String(cur.tg_user_id) !== String(uid))
      brandNote = `\n\nУ бренді «${title}» сторіс уже йдуть у ${bizLabel(cur)}. Щоб у твій профіль: Holos → Канали → Telegram → «📲 Сторіс у профілі» → «Використати тут».`;
    else {
      await q(`insert into tg_story_brand(workspace_id, conn_id) values($1,$2) on conflict (workspace_id) do update set conn_id=excluded.conn_id, updated_at=now()`, [o.workspace_id, id]);
      brandNote = `\n\n🏢 Сторіс бренду «${title}» тепер можна ставити у твій профіль: у пості формату «Сторіс» увімкни Telegram. Інший бренд - /brand, потім Канали → Telegram → «📲 Сторіс у профілі».`;
    }
  }
  await logEvent("info", "tgstory", `Telegram Business підключено: ${bizLabel({ username: bc?.user?.username, name })}, сторіс ${canStories ? "так" : "ні"}`);
  await say(canStories
    ? `📲 Telegram Business підключено - я можу ставити сторіс у твій профіль.${brandNote}\n\nТвоїх чатів я не читаю: бізнес-повідомлень не отримую взагалі.`
    : `⚠️ Бот підключено, але без права на сторіс. Telegram → Налаштування → Telegram Business → Чат-боти → цей бот → увімкни «Керування історіями» (Manage stories).${brandNote}`);
}

// ---- перекодування під вимоги Telegram ----
let niceOk: boolean | null = null;
function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`ffmpeg не вклався в ${Math.round(timeoutMs / 1000)} с`)); }, timeoutMs);
    p.stderr.on("data", (d) => { err = (err + d).slice(-600); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.trim().slice(-300)}`)); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}
async function ffmpeg(args: string[], timeoutMs = 600000): Promise<void> {
  if (niceOk === null) niceOk = await run("nice", ["-n", "10", "true"], 5000).then(() => true, () => false);
  const base = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args];
  return niceOk ? run("nice", ["-n", "10", "ffmpeg", ...base], timeoutMs) : run("ffmpeg", base, timeoutMs);
}
/** Відео → 720×1280 HEVC, ключовий кадр щосекунди, MPEG4 до 30 МБ (тло - розмите, якщо кадр не 9:16). */
export async function storyVideoFile(dir: string, src: string, n: number, maxrate = "3M"): Promise<string> {
  const out = join(dir, `tgs${n}.mp4`);
  const vf = "split=2[b0][f0];[b0]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:2[bg];" +
    "[f0]scale=720:1280:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p,setsar=1";
  await ffmpeg(["-i", src, "-t", String(TG_STORY_MAX_SEC), "-filter_complex", vf, "-c:v", "libx265", "-preset", "veryfast", "-crf", "28",
    "-maxrate", maxrate, "-bufsize", "6M", "-x265-params", "keyint=30:min-keyint=30:scenecut=0:log-level=error", "-tag:v", "hvc1",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-threads", "2", out]);
  return out;
}

/** Куди й чим ставити сторіс бренду (людська відмова - якщо нікуди). */
export async function storyTarget(ws: string): Promise<{ biz: TgBiz; token: string } | { error: string }> {
  const b = await brandBiz(ws);
  if (!b) return { error: "сторіс у Telegram ставляться у твій профіль через Telegram Business - підключи бот: Налаштування → Канали → Telegram → «📲 Сторіс у профілі»" };
  if (!b.enabled) return { error: `бот відключено від Telegram Business у ${bizLabel(b)} - підключи знову: Telegram → Налаштування → Telegram Business → Чат-боти` };
  if (!b.can_stories) return { error: `у Telegram Business боту не дали права на сторіс (${bizLabel(b)}): Telegram → Налаштування → Telegram Business → Чат-боти → бот → «Керування історіями»` };
  const token = await tokenForBot(b.bot_id);
  if (!token) return { error: "бот, через якого підключено Telegram Business, більше не працює в Holos - підключи наш бот у Telegram Business ще раз" };
  return { biz: b, token };
}

export type TgStoryOpts = { hours?: number | null; keep?: boolean | null; caption?: string | null };
/** Налаштування сторіс Telegram з поста (channels.telegram): скільки живе, чи лишати в профілі, підпис. */
export function tgStoryOpts(ch: any): { period: number; keep: boolean; caption: string } {
  const t = ch?.telegram || {};
  const h = Number(t.story_hours);
  return {
    period: (TG_STORY_HOURS.includes(h) ? h : 24) * 3600,
    keep: t.story_keep === true,
    caption: String(t.story_caption || "").trim().slice(0, 2048),
  };
}

/**
 * Поставити кадри сторіс у профіль: кожен кадр - окрема сторіс. Вертає id сторіс по порядку; на збої
 * посеред - кидає помилку з тим, що вже вийшло (err.posted), щоб не дублювати при повторі.
 */
export async function postTgStories(token: string, biz: TgBiz, frames: PostMedia[], ch: any): Promise<{ ids: number[]; permalink: string }> {
  const o = tgStoryOpts(ch);
  for (const f of frames) if (f.kind === "video" && Number(f.duration) > TG_STORY_MAX_SEC + 0.5)
    throw new Error(`відео в сторіс Telegram - до ${TG_STORY_MAX_SEC} с, а тут ${Math.round(Number(f.duration))} с - вріж його (монтаж сам ділить сторіс на частини до 60 с)`);
  await mkdir(join(MEDIA_DIR, "tmp"), { recursive: true });
  const dir = await mkdtemp(join(MEDIA_DIR, "tmp", "tgs-"));
  const ids: number[] = [];
  try {
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const src = join(MEDIA_DIR, f.filename);
      let file: Buffer, content: Record<string, unknown>;
      if (f.kind === "video") {
        let p = await storyVideoFile(dir, src, i);
        if ((await stat(p)).size > TG_STORY_VIDEO_MAX) p = await storyVideoFile(dir, src, i, "1800k");
        if ((await stat(p)).size > TG_STORY_VIDEO_MAX) throw new Error("відео для сторіс Telegram виходить більше за 30 МБ навіть стиснуте - вріж його коротше");
        file = await readFile(p);
        const dur = Math.min(TG_STORY_MAX_SEC, Number(f.duration) || 0);
        content = { type: "video", video: "attach://story", ...(dur ? { duration: Math.round(dur * 10) / 10 } : {}) };
      } else {
        file = await sharp(src).rotate().resize(1080, 1920, { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 88 }).toBuffer();
        if (file.length > TG_STORY_PHOTO_MAX) file = await sharp(file).jpeg({ quality: 70 }).toBuffer();
        content = { type: "photo", photo: "attach://story" };
      }
      try {
        const r = await tg.postStory(token, biz.id, content, file, f.kind === "video" ? "story.mp4" : "story.jpg",
          { activePeriod: o.period, keep: o.keep, caption: i === 0 ? o.caption : "" });
        ids.push(r.id);
      } catch (e: any) {
        throw Object.assign(new Error(e.message), { posted: [...ids] });
      }
    }
  } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
  const permalink = biz.username && ids.length ? `https://t.me/${biz.username}/s/${ids[0]}` : "";
  return { ids, permalink };
}
