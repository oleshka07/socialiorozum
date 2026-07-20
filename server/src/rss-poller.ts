// Фоновий поллер RSS-стрічок: тягне нові статті -> source(origin='rss')+run,
// дедуп за external_id, опційно одразу проганяє пайплайн (auto_run).
import { q, one } from "./db.js";
import { logEvent } from "./log.js";
import { fetchFeed, fetchArticleText, resolveGoogleNewsUrl, cleanText, RssItem } from "./rss.js";
import { businessDiscovery } from "./meta.js";
import { generatePostsOnePass, matchPlanSlots, scoreMaterials } from "./pipeline.js";

const POLL_MS = 15 * 60 * 1000; // кожні 15 хв
const MAX_NEW_PER_TICK = 8;     // обмеження, щоб великий фід не залив систему

type Feed = { id: string; workspace_id: string; url: string; kind?: string; auto_run: boolean; error_count?: number; last_pulled_at?: string | null };

// kind='instagram': url = маркер instagram:username; читаємо чужу бізнес-сторінку через
// business_discovery Meta Graph (токен ПІДКЛЮЧЕНОГО Instagram цього воркспейсу)
async function fetchInstagramItems(feed: Feed): Promise<RssItem[]> {
  const user = feed.url.replace(/^instagram:/, "");
  const mt = await one<{ ig_user_id: string | null; page_token: string | null }>(
    `select ig_user_id, page_token from meta_config where workspace_id=$1`, [feed.workspace_id]);
  if (!mt?.ig_user_id || !mt.page_token) throw new Error("Instagram воркспейсу відключено - джерело не читається");
  const bd = await businessDiscovery(mt.ig_user_id, mt.page_token, user, 12);
  return bd.media.filter((m) => m.caption).map((m) => ({
    externalId: `ig:${m.id}`,
    title: m.caption.split("\n").find(Boolean)?.slice(0, 200) || `@${user}`,
    content: m.caption + (m.permalink ? `\n\n${m.permalink}` : ""),
    link: m.permalink || "",
  }));
}

// створює source+run для нових статей; повертає id нових прогонів
async function ingest(feed: Feed): Promise<string[]> {
  let items;
  try { items = feed.kind === "instagram" ? await fetchInstagramItems(feed) : await fetchFeed(feed.url); }
  catch (e: any) {
    await q(`update content_source set last_error=$2, last_pulled_at=now(), error_count=error_count+1 where id=$1`, [feed.id, String(e.message).slice(0, 300)]);
    throw e;
  }
  const runIds: string[] = [];
  let skipped = 0; // новини без тіла статті - пропущені (тумбстоун), щоб у Матеріали не падали голі заголовки
  const created: { id: string; title: string; excerpt: string }[] = [];
  for (const it of items) {
    if (runIds.length >= MAX_NEW_PER_TICK) break;
    if (!it.externalId || !(it.content || it.title)) continue;
    const dup = await one(`select id from source where workspace_id=$1 and external_id=$2`, [feed.workspace_id, it.externalId]);
    if (dup) continue;
    // «тонкий» айтем (Google News: лише заголовок+джерело) → догрузити текст статті за посиланням;
    // не вийшло (сайт закритий/JS-only) → матеріалом стає заголовок, Розвідник дасть кут з нього
    let content = it.content || "";
    // соцджерела (Telegram/Threads через RSSHub, Instagram): пост САМОДОСТАТНІЙ - короткий текст легітимний,
    // догрузка/гейт не застосовуються. Для новин/статей - навпаки: без тіла статті матеріал безглуздий.
    const isSocial = feed.kind === "instagram" || /rsshub|\/telegram\/channel\/|\/threads\//i.test(feed.url || "");
    if (!isSocial && content.replace(/\s+/g, " ").length < 180 && it.link) {
      // google-лінк спершу розкодовуємо у URL видавця: і стаття тягнеться з нього, і у фолбеку лінк людський
      const real = /news\.google\.com/i.test(it.link) ? await resolveGoogleNewsUrl(it.link).catch(() => "") : it.link;
      const art = real ? await fetchArticleText(real).catch(() => "") : "";
      if (art && art.replace(/\s+/g, " ").length >= 220) content = `${it.title}\n\n${art}\n\n${real}`;
      else {
        // СТАТТЯ НЕ ВИТЯГНУЛАСЬ (видавець закритий від ботів / JS-only) → в Матеріали НЕ додаємо:
        // «заголовок + посилання» - не контент. Тумбстоун (archived=true) - щоб дедуп не пробував
        // цей айтем щотіка знову, а юзер його не бачив.
        await q(`insert into source(workspace_id,origin,title,transcript,external_id,feed_id,archived)
                 values($1,'rss',$2,$3,$4,$5,true)`,
          [feed.workspace_id, (it.title || feed.url).slice(0, 200), `[стаття недоступна] ${real || it.link || ""}`.slice(0, 500), it.externalId, feed.id]);
        skipped++;
        continue;
      }
    }
    if (!content.trim()) content = it.title;
    const src = await one<{ id: string }>(
      `insert into source(workspace_id,origin,title,transcript,external_id,feed_id) values($1,'rss',$2,$3,$4,$5) returning id`,
      [feed.workspace_id, (it.title || feed.url).slice(0, 200), content.slice(0, 50000), it.externalId, feed.id]);
    created.push({ id: src!.id, title: (it.title || "").slice(0, 200), excerpt: content.slice(0, 250) });
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
    runIds.push(run!.id);
  }
  await q(`update content_source set last_error=null, last_pulled_at=now(), error_count=0 where id=$1`, [feed.id]);
  if (skipped) await logEvent("info", "rss", `${feed.url}: пропущено ${skipped} без тіла статті (видавець закритий)`);
  if (runIds.length) {
    await logEvent("info", "rss", `${feed.url}: +${runIds.length} нових`);
    try { await matchPlanSlots(feed.workspace_id); } catch { /* метчинг не критичний */ }
    // ⭐ оцінка цікавості для аудиторії - один виклик безкоштовного Gemini на весь батч, у фоні
    scoreMaterials(feed.workspace_id, created).catch(() => { /* оцінка не критична */ });
  }
  return runIds;
}

// auto_run жене ДЕФОЛТНИЙ Lite-шлях (1 виклик на прогін), а не дорогий 6-кроковий PRO-конвеєр
async function runPipelines(runIds: string[]): Promise<void> {
  for (const rid of runIds) {
    try { await generatePostsOnePass(rid, 6); }
    catch (e: any) { await logEvent("error", "rss", `авто-генерація ${rid}: ${e.message}`, { runId: rid }); }
  }
}

async function tick(): Promise<void> {
  const feeds = await q<Feed>(`select id, workspace_id, url, kind, auto_run, error_count, last_pulled_at from content_source where active=true and kind in ('rss','instagram') limit 50`);
  for (const f of feeds) {
    // експоненційний бекоф для битих фідів: 15хв → 30хв → 1г → … → стеля 6г (щоб не довбати мертве джерело)
    const errs = f.error_count || 0;
    if (errs > 0 && f.last_pulled_at) {
      const waitMs = Math.min(6 * 3600e3, POLL_MS * Math.pow(2, errs - 1));
      if (Date.now() - new Date(f.last_pulled_at).getTime() < waitMs) continue;
    }
    // jitter: не бити всі стрічки в одну секунду (рейт-ліміти джерел)
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 2500));
    try {
      const runIds = await ingest(f);
      if (f.auto_run && runIds.length) await runPipelines(runIds);
    } catch (e: any) { await logEvent("warn", "rss", `${f.url}: ${e.message}`); }
  }
}

// on-demand: підтягнути один фід зараз (пайплайн — у фоні, щоб запит відповів швидко)
export async function pullFeed(feedId: string, ws: string): Promise<number> {
  const f = await one<Feed>(`select id, workspace_id, url, kind, auto_run from content_source where id=$1 and workspace_id=$2`, [feedId, ws]);
  if (!f) throw new Error("стрічку не знайдено");
  const runIds = await ingest(f);
  if (f.auto_run && runIds.length) runPipelines(runIds).catch(() => {});
  return runIds.length;
}

// одноразова чистка матеріалів, що встигли зберегтися з сирим HTML (баг порядку розекранування в decode)
async function cleanBrokenItems(): Promise<void> {
  const rows = await q<{ id: string; transcript: string }>(
    `select id, transcript from source where origin='rss' and (transcript like '%<a href%' or transcript like '%&lt;%' or transcript like '%&nbsp;%') limit 500`);
  for (const r of rows) {
    const fixed = cleanText(r.transcript);
    if (fixed && fixed !== r.transcript) await q(`update source set transcript=$2 where id=$1`, [r.id, fixed]);
  }
  if (rows.length) await logEvent("info", "rss", `почищено сирих HTML-матеріалів: ${rows.length}`);
}

// разова зачистка СТАРИХ «голих» матеріалів (заголовок + «Джерело: X» + лінк без тіла статті) -
// на ВСІХ воркспейсах: гейт якості діє лише на нові айтеми, а сміття з минулих тижнів лишалось у стрічці.
// Архівуємо (не видаляємо): дедуп живий, згенеровані з них пости не чіпаються. Соцджерела
// (Telegram/Threads RSSHub, Instagram) не чіпаємо - там короткий текст легітимний.
// Ідемпотентно й дешево: після першого прогону кандидатів ~0.
async function sweepThinMaterials(): Promise<void> {
  const rows = await q<{ id: string; title: string; transcript: string }>(
    `select s.id, coalesce(s.title,'') as title, s.transcript
       from source s left join content_source cs on cs.id = s.feed_id
      where s.origin='rss' and s.archived=false and length(s.transcript) < 700
        and (cs.id is null or (cs.kind <> 'instagram' and cs.url !~* 'rsshub|/telegram/channel/|/threads/'))
      limit 2000`);
  let n = 0;
  for (const r of rows) {
    // «мʼясо» = транскрипт без заголовка, рядка «Джерело:», URL-ів і пробілів
    const meat = r.transcript
      .replace(r.title, " ")
      .replace(/^\s*Джерело:.*$/gim, " ")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\s+/g, " ").trim();
    if (meat.length < 120) { await q(`update source set archived=true where id=$1`, [r.id]); n++; }
  }
  if (n) await logEvent("info", "rss", `зачистка: заархівовано ${n} «голих» матеріалів без тіла статті`);
}

// разовий бекфіл оцінок для нещодавніх матеріалів без балу (по одному батчу на воркспейс)
async function scoreBackfill(): Promise<void> {
  const rows = await q<{ workspace_id: string; id: string; title: string; excerpt: string }>(
    `select workspace_id, id, coalesce(title,'') as title, left(transcript,250) as excerpt
     from source where origin='rss' and ai_score is null and archived=false and coalesce(transcript,'')<>''
     order by created_at desc limit 40`);
  const byWs = new Map<string, typeof rows>();
  for (const r of rows) { const a = byWs.get(r.workspace_id) || []; a.push(r); byWs.set(r.workspace_id, a); }
  for (const [ws, list] of byWs) {
    try { await scoreMaterials(ws, list.slice(0, 10)); } catch { /* не критично */ }
  }
}

let running = false;
export function startRssPoller(): void {
  cleanBrokenItems().catch(() => { /* чистка не критична */ });
  sweepThinMaterials().catch(() => { /* зачистка не критична */ });
  scoreBackfill().catch(() => { /* бекфіл не критичний */ });
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); }
    catch (e: any) { await logEvent("error", "rss", "tick: " + e.message); }
    finally { running = false; }
  }, POLL_MS);
  console.log("[rss] поллер запущено (кожні 15 хв)");
}
