// Фоновий поллер RSS-стрічок: тягне нові статті -> source(origin='rss')+run,
// дедуп за external_id, опційно одразу проганяє пайплайн (auto_run).
import { q, one } from "./db.js";
import { logEvent } from "./log.js";
import { fetchFeed } from "./rss.js";
import { executeStep, STEP_ORDER, StepKey } from "./pipeline.js";

const POLL_MS = 15 * 60 * 1000; // кожні 15 хв
const MAX_NEW_PER_TICK = 8;     // обмеження, щоб великий фід не залив систему

type Feed = { id: string; workspace_id: string; url: string; auto_run: boolean };

// створює source+run для нових статей; повертає id нових прогонів
async function ingest(feed: Feed): Promise<string[]> {
  let items;
  try { items = await fetchFeed(feed.url); }
  catch (e: any) {
    await q(`update content_source set last_error=$2, last_pulled_at=now() where id=$1`, [feed.id, String(e.message).slice(0, 300)]);
    throw e;
  }
  const runIds: string[] = [];
  for (const it of items) {
    if (runIds.length >= MAX_NEW_PER_TICK) break;
    if (!it.externalId || !it.content) continue;
    const dup = await one(`select id from source where workspace_id=$1 and external_id=$2`, [feed.workspace_id, it.externalId]);
    if (dup) continue;
    const src = await one<{ id: string }>(
      `insert into source(workspace_id,origin,title,transcript,external_id) values($1,'rss',$2,$3,$4) returning id`,
      [feed.workspace_id, (it.title || feed.url).slice(0, 200), it.content.slice(0, 50000), it.externalId]);
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
    runIds.push(run!.id);
  }
  await q(`update content_source set last_error=null, last_pulled_at=now() where id=$1`, [feed.id]);
  if (runIds.length) await logEvent("info", "rss", `${feed.url}: +${runIds.length} нових`);
  return runIds;
}

async function runPipelines(runIds: string[]): Promise<void> {
  for (const rid of runIds) {
    try { for (const s of STEP_ORDER) await executeStep(rid, s as StepKey); }
    catch (e: any) { await logEvent("error", "rss", `автопілот ${rid}: ${e.message}`, { runId: rid }); }
  }
}

async function tick(): Promise<void> {
  const feeds = await q<Feed>(`select id, workspace_id, url, auto_run from content_source where active=true and kind='rss' limit 50`);
  for (const f of feeds) {
    try {
      const runIds = await ingest(f);
      if (f.auto_run && runIds.length) await runPipelines(runIds);
    } catch (e: any) { await logEvent("warn", "rss", `${f.url}: ${e.message}`); }
  }
}

// on-demand: підтягнути один фід зараз (пайплайн — у фоні, щоб запит відповів швидко)
export async function pullFeed(feedId: string, ws: string): Promise<number> {
  const f = await one<Feed>(`select id, workspace_id, url, auto_run from content_source where id=$1 and workspace_id=$2`, [feedId, ws]);
  if (!f) throw new Error("стрічку не знайдено");
  const runIds = await ingest(f);
  if (f.auto_run && runIds.length) runPipelines(runIds).catch(() => {});
  return runIds.length;
}

let running = false;
export function startRssPoller(): void {
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); }
    catch (e: any) { await logEvent("error", "rss", "tick: " + e.message); }
    finally { running = false; }
  }, POLL_MS);
  console.log("[rss] поллер запущено (кожні 15 хв)");
}
