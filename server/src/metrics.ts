// Збір метрик опублікованих постів (post_metric), щоденні знімки підписників (follower_snapshot)
// і бенчмарки «×N до власної норми».
// Принцип (курс-фреймворк): «якість визначає аудиторія, не ми» - норма мережі = МЕДІАНА переглядів,
// кожен пост звітується множником до неї (×0.6 / ×1.0 / ×2.3), не голими цифрами.
// Воркер кожні 6 год освіжає знімки постів віком до 90 днів (не частіше ніж раз на добу на пост).
import { q, one } from "./db.js";
import { logEvent } from "./log.js";
import * as threads from "./threads.js";
import * as meta from "./meta.js";
import * as tg from "./telegram.js";
import { thValidToken } from "./publisher.js";
import { buildAnalytics, MATURE_H, type PubRow, type FollowerRow } from "./analytics.js";

const PER_TICK = 25; // постів на мережу за прохід (щоб не впертись у ліміти Graph API)

// ---- Набори метрик із відступом ----
// Мережі час від часу вимикають метрики: Facebook у 2025-2026 прибрав post_impressions*, Instagram -
// impressions і plays, Threads додав shares пізніше за решту. Непідтримана метрика валить УВЕСЬ запит,
// тож пробуємо набори від найповнішого, а всередині набору відкидаємо саме ту метрику, на яку
// поскаржилась мережа. Спрацьований набір памʼятається на процес (окремо для кожного типу медіа),
// щоб не платити зайвими запитами за кожен пост.
const TH_SETS = [["views", "likes", "replies", "reposts", "quotes", "shares"], ["views", "likes", "replies", "reposts", "quotes"]];
const IG_SETS = [["views", "reach", "likes", "comments", "saved", "shares", "follows"], ["views", "reach", "likes", "comments", "saved", "shares"], ["reach", "likes", "comments", "saved", "shares"], ["reach", "likes"]];
const FB_POST_SETS = [["post_media_view", "post_total_media_view_unique"], ["post_media_view"], ["post_impressions", "post_impressions_unique"]];
const FB_VIDEO_SETS = [["total_video_views", "total_video_impressions_unique"], ["total_video_views"], ["post_video_views"]];

/** Яку частину набору лишити, коли мережа відмовила в усьому запиті. Три відомі форми відмови:
 *  «does not support the views metric for this media product type» - називає зайву метрику;
 *  «metric[5] must be one of the following values: views, likes, …» - називає ДОЗВОЛЕНІ;
 *  «The value must be a valid insights metric» - не називає нічого (тоді null: пробуй наступний набір). */
export function narrowMetrics(requested: string[], message: string): string[] | null {
  const msg = String(message || "");
  const allowed = msg.match(/must be one of(?: the following values)?\s*:?\s*[{[(]?\s*([a-z0-9_,'"\s]+?)\s*(?:[})\]]|\bbut\b|$)/i);
  if (allowed) {
    const ok = new Set(allowed[1].split(/[\s,'"]+/).filter(Boolean).map((x) => x.toLowerCase()));
    const kept = requested.filter((m) => ok.has(m.toLowerCase()));
    if (kept.length && kept.length < requested.length) return kept;
  }
  const named = requested.filter((m) => new RegExp(`(^|[^a-z0-9_])${m}([^a-z0-9_]|$)`, "i").test(msg));
  if (named.length === 1 && requested.length > 1) return requested.filter((m) => m !== named[0]);
  return null;
}

/** Відмова стосується самого запиту метрик (метрика не та), а не доступу чи ліміту. На відмову
 *  доступу пробувати інші набори марно - лише зайві запити. */
export function isMetricRequestError(message: string): boolean {
  const m = String(message || "");
  if (/дозволу|втрачено|зачекати|permission|access token|rate limit|too many/i.test(m)) return false;
  return /metric|insights|must be one of|does not support|not supported|invalid parameter|\(#100\)/i.test(m);
}

const workingSets = new Map<string, string[]>();
/** Перший набір, що повернув хоч одну метрику. Порожня відповідь (метрику вимкнули мовчки) теж
 *  веде до наступного набору; якщо все порожнє - повертає {} (мережа нічого не віддала, але й не
 *  відмовила). Відмова доступу кидається одразу. */
export async function fetchMetrics(sets: string[][], fn: (metrics: string[]) => Promise<Record<string, number>>, cacheKey?: string): Promise<Record<string, number>> {
  const cached = cacheKey ? workingSets.get(cacheKey) : undefined;
  const queue = cached ? [cached, ...sets] : sets;
  let lastErr: any = null, sawEmpty = false;
  for (const first of queue) {
    let set = first;
    for (let attempt = 0; attempt < 4 && set.length; attempt++) {
      try {
        const values = await fn(set);
        if (set.some((m) => typeof values[m] === "number")) {
          if (cacheKey) workingSets.set(cacheKey, set);
          return values;
        }
        sawEmpty = true;
        break;
      } catch (e: any) {
        lastErr = e;
        if (!isMetricRequestError(e?.message)) throw e;
        const next = narrowMetrics(set, e?.message);
        if (!next) break;
        set = next;
      }
    }
  }
  if (sawEmpty) return {};
  throw lastErr || new Error("мережа не віддала метрик");
}

// ---- Запис ----
export type MetricSnapshot = {
  views: number | null; reach?: number | null; likes: number | null; replies?: number | null;
  reposts?: number | null; quotes?: number | null; shares?: number | null; saves?: number | null; follows?: number | null; error?: string | null;
};
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.round(x)) : null);

async function saveMetric(postId: string, network: string, m: MetricSnapshot): Promise<void> {
  await q(
    `insert into post_metric(post_id, network, views, reach, likes, replies, reposts, quotes, shares, saves, follows, error, err_count, fetched_at, measured_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,now(),now())
     on conflict (post_id, network) do update set views=excluded.views, reach=excluded.reach, likes=excluded.likes,
       replies=excluded.replies, reposts=excluded.reposts, quotes=excluded.quotes, shares=excluded.shares,
       saves=excluded.saves, follows=excluded.follows, error=excluded.error, err_count=0, fetched_at=now(), measured_at=now()`,
    [postId, network, num(m.views), num(m.reach), num(m.likes), num(m.replies), num(m.reposts) ?? 0, num(m.quotes) ?? 0,
      num(m.shares), num(m.saves), num(m.follows), m.error ? String(m.error).slice(0, 300) : null]);
}

// Збій теж пишеться (попередні цифри лишаються): інакше пост, з якого нічого не витягнути, вибирався
// б першим на КОЖНОМУ проході й відтісняв решту. Після 5 збоїв поспіль - спроба раз на тиждень.
// measured_at збій НЕ чіпає: він каже, коли зняті ті цифри, що лежать у рядку.
async function saveFailure(postId: string, network: string, err: string): Promise<void> {
  await q(
    `insert into post_metric(post_id, network, views, likes, replies, error, err_count, fetched_at)
     values($1,$2,null,null,null,$3,1,now())
     on conflict (post_id, network) do update set error=excluded.error, err_count=post_metric.err_count+1, fetched_at=now()`,
    [postId, network, String(err || "невідома помилка").slice(0, 300)]);
}

// Пости мережі, яким потрібен свіжий знімок. Сторіс не беремо: їхні кадри живуть 24 год, а рядок
// публікації тримає список id кадрів. Порядок - спершу ті, яких ще не питали, далі найдавніше питані.
// Частота: раз на minAgeH год (воркер - раз на добу), але пост перших 3 днів, чиї цифри ще «не
// дозріли» (зняті раніше, ніж за MATURE_H год після публікації), і пост, з якого цифр ще не було, -
// на кожному проході воркера (кожні 6 год). Інакше знімок, зроблений через 20 хв після публікації,
// висів би добу як «0 переглядів». 5 год, а не 6 - запас, щоб прохід не пропускав пост через секунди.
const YOUNG_EVERY_H = 5;
async function staleRows(ws: string, network: "threads" | "instagram" | "facebook", minAgeH = 24): Promise<{ post_id: string; ext: string }[]> {
  return q<{ post_id: string; ext: string }>(
    `select x.post_id, x.ext from (
         select post_id, media_id as ext, created_at from threads_publish where status='sent' and $2='threads'
         union all select post_id, external_id, created_at from meta_publish where status='sent' and channel=$2
       ) x
       join post p on p.id=x.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       left join post_metric pm on pm.post_id=x.post_id and pm.network=$2
     where s.workspace_id=$1 and x.ext is not null and position(',' in x.ext)=0
       and coalesce(p.format,'post') <> 'story'
       and x.created_at > now() - interval '90 days'
       and (pm.post_id is null or pm.fetched_at < now() - case
              when pm.err_count >= 5 then interval '7 days'
              when pm.measured_at is null
                or (x.created_at > now() - interval '3 days' and pm.measured_at < x.created_at + make_interval(hours => ${MATURE_H}))
                then make_interval(hours => least($3::int, ${YOUNG_EVERY_H}))
              else make_interval(hours => $3::int) end)
     order by pm.fetched_at nulls first, x.created_at desc limit ${PER_TICK}`, [ws, network, minAgeH]);
}

// відмова на рівні акаунта (токен, ліміт): решту постів цієї мережі в цей прохід не чіпаємо
const accountLevel = (m: string) => /втрачено|зачекати|access token|rate limit|too many/i.test(m);
const noInsightsAccess = (m: string) => /дозволу|permission/i.test(m);

async function collectThreads(ws: string, minAgeH: number): Promise<number> {
  const tok = await thValidToken(ws).catch(() => null);
  if (!tok) return 0;
  let n = 0;
  for (const r of await staleRows(ws, "threads", minAgeH)) {
    try {
      const v = await fetchMetrics(TH_SETS, (m) => threads.mediaInsights(tok.token, r.ext, m), "threads");
      await saveMetric(r.post_id, "threads", {
        views: num(v.views), likes: num(v.likes), replies: num(v.replies), reposts: num(v.reposts),
        quotes: num(v.quotes), shares: num(v.shares), error: Object.keys(v).length ? null : "Threads не повернув метрик для цього поста",
      });
      n++;
    } catch (e: any) {
      await saveFailure(r.post_id, "threads", e?.message);
      if (accountLevel(String(e?.message))) break;
    }
  }
  return n;
}

async function collectInstagram(ws: string, token: string, minAgeH: number): Promise<number> {
  let n = 0, insightsBlocked = "";
  for (const r of await staleRows(ws, "instagram", minAgeH)) {
    // лайки й коментарі ПОЛЯМИ є навіть без дозволу на інсайти
    let f: Awaited<ReturnType<typeof meta.igMediaFields>> | null = null, fErr = "";
    try { f = await meta.igMediaFields(r.ext, token); } catch (e: any) { fErr = String(e?.message || ""); }
    if (!f && accountLevel(fErr)) { await saveFailure(r.post_id, "instagram", fErr); break; }
    const kind = String(f?.media_product_type || f?.media_type || "FEED").toUpperCase();
    let v: Record<string, number> | null = null, vErr = insightsBlocked;
    if (!insightsBlocked) {
      try { v = await fetchMetrics(IG_SETS, (m) => meta.igMediaMetrics(r.ext, token, m), `instagram:${kind}`); }
      catch (e: any) { vErr = String(e?.message || ""); if (noInsightsAccess(vErr)) insightsBlocked = vErr; }
    }
    if (!f && !v) { await saveFailure(r.post_id, "instagram", vErr || fErr); continue; }
    const got = v && Object.keys(v).length ? v : null;
    await saveMetric(r.post_id, "instagram", {
      // views - нова головна метрика Instagram; для медіа, де її нема, охоплення - найближча заміна
      views: num(got?.views ?? got?.reach), reach: num(got?.reach),
      likes: num(got?.likes ?? f?.like_count), replies: num(got?.comments ?? f?.comments_count),
      saves: num(got?.saved), shares: num(got?.shares), follows: num(got?.follows),
      error: got ? null : `перегляди недоступні: ${vErr || "Instagram не повернув інсайтів"}`,
    });
    n++;
  }
  return n;
}

async function collectFacebook(ws: string, token: string, minAgeH: number): Promise<number> {
  let n = 0, insightsBlocked = "";
  for (const r of await staleRows(ws, "facebook", minAgeH)) {
    // відео Сторінки зберігаємо голим id відео; дописи (текст, фото, галерея) - «<сторінка>_<пост>»
    const isVideo = /^\d+$/.test(r.ext);
    let eng: Awaited<ReturnType<typeof meta.fbPostEngagement>> | null = null, eErr = "";
    try { eng = await meta.fbPostEngagement(r.ext, token, isVideo); } catch (e: any) { eErr = String(e?.message || ""); }
    if (!eng && accountLevel(eErr)) { await saveFailure(r.post_id, "facebook", eErr); break; }
    let v: Record<string, number> | null = null, vErr = insightsBlocked;
    if (!insightsBlocked) {
      try {
        v = isVideo
          ? await fetchMetrics(FB_VIDEO_SETS, (m) => meta.fbVideoMetrics(r.ext, token, m), "facebook:video")
          : await fetchMetrics(FB_POST_SETS, (m) => meta.fbPostMetrics(r.ext, token, m), "facebook:post");
      } catch (e: any) { vErr = String(e?.message || ""); if (noInsightsAccess(vErr)) insightsBlocked = vErr; }
    }
    if (!eng && !v) { await saveFailure(r.post_id, "facebook", vErr || eErr); continue; }
    const got = v && Object.keys(v).length ? v : null;
    await saveMetric(r.post_id, "facebook", {
      views: num(got?.post_media_view ?? got?.post_impressions ?? got?.total_video_views ?? got?.post_video_views),
      reach: num(got?.post_total_media_view_unique ?? got?.post_impressions_unique ?? got?.total_video_impressions_unique),
      likes: eng?.reactions ?? null, replies: eng?.comments ?? null, shares: eng?.shares ?? null,
      error: got ? null : `перегляди недоступні: ${vErr || "Facebook не повернув переглядів для цього допису"}`,
    });
    n++;
  }
  return n;
}

async function wsTimezone(ws: string): Promise<string> {
  const r = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [ws]);
  const tz = (r?.content || "").trim() || "Europe/Kyiv";
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return "Europe/Kyiv"; }
}

// Підписники - раз на прохід; за день лишається останнє значення. Кожна мережа окремо: збій однієї
// (немає дозволу, бота прибрали з каналу) не зупиняє інші.
export async function snapshotFollowers(ws: string): Promise<number> {
  const tz = await wsTimezone(ws);
  let saved = 0;
  const put = async (network: string, value: unknown) => {
    const v = num(value);
    if (v == null) return;
    await q(`insert into follower_snapshot(workspace_id, network, day, followers) values($1,$2,(now() at time zone $4)::date,$3)
             on conflict (workspace_id, network, day) do update set followers=excluded.followers, updated_at=now()`, [ws, network, v, tz]);
    saved++;
  };
  const tok = await thValidToken(ws).catch(() => null);
  if (tok) { try { await put("threads", (await threads.userInsights(tok.token, tok.userId, ["followers_count"])).followers_count); } catch { /* без threads_manage_insights */ } }
  const mt = await one<{ page_id: string | null; page_token: string | null; ig_user_id: string | null }>(
    `select page_id, page_token, ig_user_id from meta_config where workspace_id=$1 and page_token is not null`, [ws]);
  if (mt?.page_token) {
    if (mt.ig_user_id) { try { await put("instagram", (await meta.igStats(mt.ig_user_id, mt.page_token)).followers_count); } catch { /* ignore */ } }
    if (mt.page_id) {
      try { const s = await meta.pageStats(mt.page_id, mt.page_token); await put("facebook", s.followers_count ?? s.fan_count); } catch { /* ignore */ }
    }
  }
  const tc = await one<{ bot_token: string | null; channel_chat_id: string | null; group_chat_id: string | null }>(
    `select bot_token, channel_chat_id, group_chat_id from telegram_config where workspace_id=$1`, [ws]);
  const chat = tc?.channel_chat_id || tc?.group_chat_id;
  if (tc?.bot_token && chat) { try { await put("telegram", await tg.getChatMemberCount(tc.bot_token, chat)); } catch { /* бота прибрали з каналу */ } }
  return saved;
}

// minAgeH - наскільки свіжий знімок уже вважається достатнім: воркер питає раз на добу, а кнопка
// «Оновити статистику» в кабінеті - все, що старше за годину.
export async function collectWorkspace(ws: string, minAgeH = 24): Promise<{ posts: number; followers: number }> {
  let n = 0;
  n += await collectThreads(ws, minAgeH);
  const mt = await one<{ page_token: string | null }>(`select page_token from meta_config where workspace_id=$1 and page_token is not null`, [ws]);
  if (mt?.page_token) {
    n += await collectInstagram(ws, mt.page_token, minAgeH);
    n += await collectFacebook(ws, mt.page_token, minAgeH);
  }
  const followers = await snapshotFollowers(ws);
  return { posts: n, followers };
}

async function tick(): Promise<void> {
  const wss = await q<{ workspace_id: string }>(
    `select workspace_id from threads_config where access_token is not null
     union select workspace_id from meta_config where page_token is not null
     union select workspace_id from telegram_config where bot_token is not null and coalesce(channel_chat_id, group_chat_id) is not null`);
  for (const w of wss) {
    try { await collectWorkspace(w.workspace_id); }
    catch (e: any) { await logEvent("error", "metrics", `збір ${w.workspace_id}: ${e.message}`); }
  }
}

let running = false;
export function startMetrics(): void {
  const run = async () => {
    if (running) return; running = true;
    try { await tick(); } catch (e: any) { await logEvent("error", "metrics", "tick: " + e.message); } finally { running = false; }
  };
  setTimeout(run, 3 * 60 * 1000);       // перший збір через 3 хв після старту
  setInterval(run, 6 * 60 * 60 * 1000); // далі кожні 6 год
  console.log("[metrics] воркер збору метрик постів запущено");
}

// ---- Бенчмарки: медіана по мережі + множник кожного поста ----
export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type BenchPost = { post_id: string; network: string; views: number; likes: number; mult: number; title: string; content: string; fetched_at: string };
export async function networkBenchmarks(ws: string): Promise<{ networks: Record<string, { median: number; count: number }>; posts: BenchPost[] }> {
  // лише пости, де мережа справді віддала перегляди: «невідомо» (NULL) не тягне норму вниз
  const rows = await q<{ post_id: string; network: string; views: number; likes: number | null; fetched_at: string; content: string }>(
    `select pm.post_id, pm.network, pm.views, pm.likes, pm.fetched_at, p.content
       from post_metric pm join post p on p.id=pm.post_id
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and pm.views is not null order by pm.views desc`, [ws]);
  const byNet = new Map<string, number[]>();
  for (const r of rows) { if (!byNet.has(r.network)) byNet.set(r.network, []); byNet.get(r.network)!.push(r.views); }
  const networks: Record<string, { median: number; count: number }> = {};
  for (const [net, views] of byNet) {
    if (views.length < 3) continue; // замало даних для чесної норми
    networks[net] = { median: Math.max(1, Math.round(median(views))), count: views.length };
  }
  const posts: BenchPost[] = rows
    .filter((r) => networks[r.network])
    .map((r) => ({
      post_id: r.post_id, network: r.network, views: r.views, likes: r.likes ?? 0,
      mult: Math.round((r.views / networks[r.network].median) * 10) / 10,
      title: (r.content || "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 80) || "",
      content: (r.content || "").slice(0, 1500), fetched_at: r.fetched_at,
    }))
    .sort((a, b) => b.mult - a.mult);
  return { networks, posts };
}

// ---- Дані екрана «Аналітика» (і інструмента analytics у конекторі Claude) ----
// Сирі рядки - одним запитом (публікація × метрики мережі × ознаки поста), уся арифметика - у
// чистому analytics.ts. Беремо подвійний період: попередній потрібен для порівняння «до/після».
export async function analyticsFor(ws: string, days: number, net = "all") {
  const tzRow = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [ws]);
  let tz = (tzRow?.content || "").trim() || "Europe/Kyiv";
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "Europe/Kyiv"; }
  const d = Math.max(1, Math.min(365, Math.round(days) || 90));
  const rows = await q<PubRow>(
    `select x.post_id, x.net, x.created_at, x.permalink,
            coalesce(nullif(p.channels->x.net->>'text',''), p.content, '') as text,
            coalesce(p.format,'post') as format, p.rubric, p.intent, s.origin,
            case when coalesce(p.format,'post')='story' then 'story'
                 when ma.kind='video' or (p.format='reel' and p.reel_video is not null) then 'video'
                 when exists (select 1 from post_slide ps where ps.post_id=p.id) then 'carousel'
                 when p.media_id is not null then 'photo' else 'text' end as media_kind,
            pm.views, pm.reach, pm.likes, pm.replies, pm.reposts, pm.quotes, pm.shares, pm.saves, pm.follows,
            pm.error as m_error, pm.fetched_at, pm.measured_at
       from (
         (select distinct on (post_id) post_id, 'telegram'::text as net, created_at, permalink
            from telegram_publish where status='sent' order by post_id, (target <> 'channel'), created_at)
         union all select post_id, 'threads', created_at, permalink from threads_publish where status='sent'
         union all select post_id, channel, created_at, permalink from meta_publish where status='sent'
         union all select post_id, 'linkedin', created_at, permalink from linkedin_publish where status='sent'
       ) x
       join post p on p.id=x.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       left join media_asset ma on ma.id=p.media_id
       left join post_metric pm on pm.post_id=x.post_id and pm.network=x.net
      where s.workspace_id=$1 and x.created_at > now() - make_interval(days => $2::int)
      order by x.created_at desc limit 5000`, [ws, d * 2]);
  const followers = await q<FollowerRow>(
    `select network, to_char(day,'YYYY-MM-DD') as day, followers from follower_snapshot
      where workspace_id=$1 and day >= (now() at time zone $3)::date - $2::int order by day`, [ws, d + 30, tz]);
  const connected = await one<{ threads: boolean; meta: boolean; telegram: boolean; linkedin: boolean }>(
    `select exists(select 1 from threads_config where workspace_id=$1 and access_token is not null) as threads,
            exists(select 1 from meta_config where workspace_id=$1 and page_token is not null) as meta,
            exists(select 1 from telegram_config where workspace_id=$1 and bot_token is not null and coalesce(channel_chat_id, group_chat_id) is not null) as telegram,
            exists(select 1 from linkedin_config where workspace_id=$1 and access_token is not null) as linkedin`, [ws]);
  return { ...buildAnalytics(rows, followers, { days: d, net, tz }), connected };
}
