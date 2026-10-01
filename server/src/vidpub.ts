// 🎬 Публікація відео в YouTube і TikTok: токени (живуть годину і добу - освіжаємо самі), заливка,
// чекання обробки TikTok і сторож тих публікацій, які TikTok обробляє довше, ніж ми чекаємо.
// Резервації «раз на пост» і рядки *_publish - у publisher.ts, як і для решти мереж.
import { q, one } from "./db.js";
import { env } from "./env.js";
import { logEvent } from "./log.js";
import * as youtube from "./youtube.js";
import * as tiktok from "./tiktok.js";
import { ttPost, type TtOpts, type YtOpts } from "./vidnets.js";

export type VidFile = { path: string; filename: string; size: number; width: number; height: number; duration: number };

// Спільний патерн «освіж OAuth-токен, якщо скоро протухне» (YouTube/TikTok: refresh_token → новий access_token).
export async function freshToken(
  cfg: { access_token: string; refresh_token: string | null; token_expires_at: string | null },
  refresh: (rt: string) => Promise<{ access_token: string; refresh_token?: string; expires_in: number }>,
  persist: (token: string, refreshToken: string | null, expiresAt: string) => Promise<void>,
  force = false,
): Promise<string> {
  const exp = cfg.token_expires_at ? new Date(cfg.token_expires_at).getTime() : 0;
  if (!cfg.refresh_token || (!force && exp && exp - Date.now() > 5 * 60e3)) return cfg.access_token;
  const r = await refresh(cfg.refresh_token);
  const newExp = new Date(Date.now() + (Number(r.expires_in) || 3600) * 1000).toISOString();
  await persist(r.access_token, r.refresh_token || cfg.refresh_token, newExp);
  return r.access_token;
}

// ---------------- YouTube ----------------
export async function ytToken(ws: string): Promise<string> {
  const yc = await one<{ access_token: string; refresh_token: string | null; token_expires_at: string | null }>(
    `select access_token, refresh_token, token_expires_at from youtube_config where workspace_id=$1`, [ws]);
  if (!yc) throw new Error("YouTube не підключено - Налаштування → Канали → YouTube");
  return freshToken(yc,
    (rt) => youtube.refreshAccessToken(env.google.clientId, env.google.clientSecret, rt),
    async (t, _rt, expAt) => { await q(`update youtube_config set access_token=$2, token_expires_at=$3, updated_at=now() where workspace_id=$1`, [ws, t, expAt]); });
}

export type YtDone = { videoId: string; permalink: string; privacy: string; note: string };
export async function youtubeUpload(ws: string, f: VidFile, text: string, o: YtOpts): Promise<YtDone> {
  const token = await ytToken(ws);
  const title = o.title || youtube.titleFrom(text) || "Відео";
  const r = await youtube.uploadResumable(token, f.path, f.size, tiktok.mimeOf(f.filename),
    { title, description: text, privacy: o.privacy, madeForKids: o.kids, synthetic: o.ai });
  const notes: string[] = [];
  // проєкт, що ще не пройшов аудит YouTube: відео, залиті через API, YouTube робить приватними сам
  if (r.privacy && r.privacy !== o.privacy && r.privacy === "private")
    notes.push(`YouTube залив відео приватним (обрано «${youtube.YT_PRIVACY_UA[o.privacy]}»): поки Holos не пройшов аудит YouTube, усі відео, залиті через API, YouTube робить приватними, і змінити це в YouTube Studio не дає`);
  if (r.syntheticDropped && o.ai) notes.push("позначку «AI-вміст» YouTube через API не прийняв - постав її в YouTube Studio");
  return { videoId: r.videoId, permalink: youtube.ytLink(r.videoId, f), privacy: r.privacy, note: notes.join("; ") };
}

// ---------------- TikTok ----------------
type TtCfg = { access_token: string; refresh_token: string | null; token_expires_at: string | null; username: string | null; scopes: string | null; display_name: string | null };
async function ttCfg(ws: string): Promise<TtCfg> {
  const c = await one<TtCfg>(`select access_token, refresh_token, token_expires_at, username, scopes, display_name from tiktok_config where workspace_id=$1`, [ws]);
  if (!c) throw new Error("TikTok не підключено - Налаштування → Канали → TikTok");
  return c;
}
export async function ttToken(ws: string, force = false): Promise<string> {
  const c = await ttCfg(ws);
  return freshToken(c,
    (rt) => tiktok.refreshToken(env.tiktok.clientKey, env.tiktok.clientSecret, rt),
    async (t, rt, expAt) => { await q(`update tiktok_config set access_token=$2, refresh_token=$3, token_expires_at=$4, updated_at=now() where workspace_id=$1`, [ws, t, rt, expAt]); },
    force);
}
// Виклик TikTok зі свіжим токеном; токен відкликали чи він протух раніше строку - освіжаємо раз і повторюємо.
export async function withTt<T>(ws: string, fn: (token: string) => Promise<T>): Promise<T> {
  try { return await fn(await ttToken(ws)); }
  catch (e: any) {
    if (!(e instanceof tiktok.TikTokError) || e.code !== "access_token_invalid") throw e;
    return fn(await ttToken(ws, true));
  }
}

// «Хто публікує» для композера: TikTok вимагає показати нік і варіанти перед постом. Хвилину памʼятаємо,
// щоб відкриття композера не впиралось у ліміт TikTok (20 запитів на хвилину).
const creatorCache = new Map<string, { at: number; info: tiktok.CreatorInfo }>();
export async function ttCreator(ws: string, fresh = false): Promise<tiktok.CreatorInfo> {
  const c = creatorCache.get(ws);
  if (!fresh && c && Date.now() - c.at < 60_000) return c.info;
  const info = await withTt(ws, (t) => tiktok.creatorInfo(t));
  creatorCache.set(ws, { at: Date.now(), info });
  if (info.username) await q(`update tiktok_config set username=$2 where workspace_id=$1 and coalesce(username,'')<>$2`, [ws, info.username]).catch(() => {});
  return info;
}
export const canDirect = (scopes: string | null | undefined) => !scopes || String(scopes).split(/[\s,]+/).includes("video.publish");

export type TtStart = { publishId: string; mode: "direct" | "inbox"; username: string; notes: string[] };
// Старт публікації: перевірки TikTok → init → заливка. onUploaded - коли файл уже в TikTok (з цього
// моменту повтор задублював би пост: рядок має стати «обробляється», а не звільнитись).
export async function tiktokStart(ws: string, f: VidFile, text: string, o: TtOpts, onUploaded: (publishId: string, mode: "direct" | "inbox") => Promise<void>): Promise<TtStart> {
  const cfg = await ttCfg(ws);
  const mime = tiktok.mimeOf(f.filename);
  const notes: string[] = [];
  let mode: "direct" | "inbox" = o.mode === "direct" ? "direct" : "inbox";
  if (mode === "direct" && !canDirect(cfg.scopes)) {
    mode = "inbox";
    notes.push("пряма публікація в TikTok ще не ввімкнена для Holos - відео пішло в чернетки TikTok");
  }
  let username = cfg.username || "";
  const run = async (token: string) => {
    if (mode === "direct") {
      // TikTok вимагає питати «хто публікує» перед кожним постом: варіанти «Хто бачить» могли змінитись
      const info = await tiktok.creatorInfo(token);
      if (info.username) username = info.username;
      const bad = tiktok.checkPost(ttPost(o, text), info, f.duration);
      if (bad) throw new Error(bad);
      try {
        return await tiktok.initDirect(token, ttPost(o, text), info, f.size);
      } catch (e: any) {
        // до аудиту TikTok пускає пряму публікацію лише в приватний акаунт: тоді - у чернетки, як і обіцяли людям
        if (!(e instanceof tiktok.TikTokError) || e.code !== "unaudited_client_can_only_post_to_private_accounts") throw e;
        mode = "inbox";
        notes.push("TikTok ще не перевірив застосунок Holos, а до того пряма публікація можлива лише в приватний акаунт - відео пішло в чернетки TikTok");
      }
    }
    return tiktok.initInbox(token, f.size);
  };
  const init = await withTt(ws, run);
  await tiktok.uploadFile(init, f.path, mime, f.size);
  await onUploaded(init.publishId, mode);
  if (username && username !== cfg.username) await q(`update tiktok_config set username=$2 where workspace_id=$1`, [ws, username]).catch(() => {});
  return { publishId: init.publishId, mode, username, notes };
}

export type TtOutcome = { state: "sent" | "processing" | "failed"; ttStatus: string; videoId: string; permalink: string; error: string };
export function outcomeOf(st: tiktok.TtStatus, mode: "direct" | "inbox", username: string): TtOutcome {
  const videoId = st.postIds[0] || "";
  if (st.status === "PUBLISH_COMPLETE") return { state: "sent", ttStatus: st.status, videoId, permalink: tiktok.ttLink(username, videoId), error: "" };
  if (st.status === "SEND_TO_USER_INBOX" && mode === "inbox") return { state: "sent", ttStatus: st.status, videoId: "", permalink: "", error: "" };
  if (st.status === "FAILED") return { state: "failed", ttStatus: st.status, videoId: "", permalink: "", error: tiktok.failReasonText(st.failReason) };
  return { state: "processing", ttStatus: st.status, videoId: "", permalink: "", error: "" };
}

// Чекаємо обробку TikTok до хвилини (зазвичай вистачає). Довше - віддаємо сторожу: публікацію (і чергу
// автопостера, що йде по одному слоту) не тримаємо.
export async function tiktokWait(ws: string, publishId: string, mode: "direct" | "inbox", username: string, maxMs = Number(process.env.TIKTOK_WAIT_MS ?? 60_000)): Promise<TtOutcome> {
  const until = Date.now() + maxMs;
  let last: TtOutcome = { state: "processing", ttStatus: "", videoId: "", permalink: "", error: "" };
  for (let i = 0; Date.now() < until; i++) {
    await new Promise((r) => setTimeout(r, Math.min(Number(process.env.TIKTOK_POLL_MS ?? 4000) * (i < 5 ? 1 : 2), Math.max(0, until - Date.now()))));
    try { last = outcomeOf(await withTt(ws, (t) => tiktok.fetchStatus(t, publishId)), mode, username); }
    catch { continue; } // збій запиту стану - не вирок публікації, спробуємо ще
    if (last.state !== "processing") return last;
  }
  return last;
}

export const ttDraftNote = "відео в чернетках TikTok: відкрий TikTok (сповіщення про чернетку або Профіль → Чернетки), встав підпис і натисни «Опублікувати» - підпис TikTok у чернетку не переносить";

// ---------------- сторож обробки TikTok ----------------
// Рядки 'processing' (TikTok ще обробляє відео) і чернетки, які людина могла вже опублікувати в
// застосунку (тоді TikTok віддасть id поста - буде посилання). Збій обробки - рядок звільняємо (можна
// опублікувати ще раз), власнику - повідомлення в бот із причиною.
const GIVE_UP_MS = 2 * 3600_000, DRAFT_WATCH_MS = 3 * 24 * 3600_000;
export async function tiktokWatchTick(): Promise<number> {
  const rows = await q<{ id: string; post_id: string; external_id: string; mode: string | null; status: string; checks: number; created_at: string; ws: string }>(
    `select tp.id, tp.post_id, tp.external_id, tp.mode, tp.status, tp.checks, tp.created_at, s.workspace_id as ws
       from tiktok_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where coalesce(tp.external_id,'')<>'' and coalesce(tp.check_at, now()) <= now()
        and (tp.status='processing'
             or (tp.status='sent' and tp.mode='inbox' and tp.permalink is null and tp.tt_status is distinct from 'FAILED'
                 and tp.created_at > now() - interval '3 days'))
      order by tp.check_at nulls first limit 20`);
  let n = 0;
  for (const r of rows) {
    const age = Date.now() - new Date(r.created_at).getTime();
    const mode = r.mode === "direct" ? "direct" : "inbox";
    try {
      const cfg = await one<{ username: string | null }>(`select username from tiktok_config where workspace_id=$1`, [r.ws]);
      const out = outcomeOf(await withTt(r.ws, (t) => tiktok.fetchStatus(t, r.external_id)), mode, cfg?.username || "");
      n++;
      if (r.status === "processing") {
        if (out.state === "sent") {
          await q(`update tiktok_publish set status='sent', tt_status=$2, video_id=nullif($3,''), permalink=nullif($4,''), checks=checks+1,
                     check_at=case when $5 then now() + interval '2 hours' else null end where id=$1`,
            [r.id, out.ttStatus, out.videoId, out.permalink, mode === "inbox" && !out.permalink]);
          continue;
        }
        if (out.state === "failed") {
          await q(`delete from tiktok_publish where id=$1`, [r.id]);
          await logEvent("warn", "tiktok", `TikTok не опублікував відео: ${out.error}`, { ws: r.ws, postId: r.post_id });
          const { notifyPublishFailed } = await import("./alerts.js");
          await notifyPublishFailed(r.ws, r.post_id, [{ net: "TikTok", error: out.error }], "⚠️ TikTok не опублікував відео").catch(() => {});
          continue;
        }
        if (age > GIVE_UP_MS) {
          // TikTok так і не сказав «готово» - не звільняємо (міг і опублікувати), але чесно кажемо
          await q(`update tiktok_publish set status='sent', tt_status=$2, error=$3, check_at=null where id=$1`,
            [r.id, out.ttStatus, "TikTok не підтвердив публікацію за 2 год - перевір профіль у TikTok"]);
          await logEvent("warn", "tiktok", `TikTok не підтвердив публікацію за 2 год (стан ${out.ttStatus || "невідомий"})`, { ws: r.ws, postId: r.post_id });
          continue;
        }
        await q(`update tiktok_publish set tt_status=$2, checks=checks+1, check_at=now() + make_interval(mins => least(30, power(2, least(checks, 5))::int)) where id=$1`, [r.id, out.ttStatus]);
      } else {
        // чернетка: людина опублікувала її в TikTok - буде посилання; ні - глянемо пізніше
        if (out.permalink || out.ttStatus === "FAILED" || age > DRAFT_WATCH_MS)
          await q(`update tiktok_publish set tt_status=$2, video_id=nullif($3,''), permalink=nullif($4,''), check_at=null where id=$1`, [r.id, out.ttStatus, out.videoId, out.permalink]);
        else await q(`update tiktok_publish set tt_status=$2, checks=checks+1, check_at=now() + interval '2 hours' where id=$1`, [r.id, out.ttStatus]);
      }
    } catch (e: any) {
      // токен відкликали, TikTok лежить: не смикаємо щохвилини, а давнє processing - як вище, «не підтвердив»
      if (r.status === "processing" && age > GIVE_UP_MS)
        await q(`update tiktok_publish set status='sent', error=$2, check_at=null where id=$1`, [r.id, `TikTok не підтвердив публікацію за 2 год (${String(e.message).slice(0, 160)}) - перевір профіль у TikTok`]);
      else await q(`update tiktok_publish set check_at=now() + interval '10 minutes' where id=$1`, [r.id]);
    }
  }
  return n;
}

let watching = false;
export function startTikTokWatch(): void {
  const every = Number(process.env.TIKTOK_WATCH_MS ?? 60_000);
  if (!(every > 0)) return;
  setInterval(async () => {
    if (watching) return;
    watching = true;
    try { await tiktokWatchTick(); }
    catch (e: any) { await logEvent("error", "tiktok", "сторож обробки: " + e.message); }
    finally { watching = false; }
  }, every);
}
