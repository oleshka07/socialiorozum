// Збір метрик опублікованих постів у БД (post_metric) + бенчмарки «×N до власної норми».
// Принцип (курс-фреймворк): «якість визначає аудиторія, не ми» - норма мережі = МЕДІАНА переглядів
// за останні 90 днів, кожен пост звітується множником до неї (×0.6 / ×1.0 / ×2.3), не голими цифрами.
// Воркер кожні 6 год освіжає знімки постів віком до 90 днів (не частіше ніж раз на добу на пост).
import { q } from "./db.js";
import { logEvent } from "./log.js";
import * as threads from "./threads.js";
import * as meta from "./meta.js";

const PER_TICK = 25; // постів на мережу за прохід (щоб не впертись у ліміти Graph API)

// пости мережі, яким потрібен свіжий знімок (нема запису або він старший за добу; вік поста ≤90 днів)
async function stalePosts(ws: string, table: string, network: string, extId: string): Promise<{ post_id: string; ext: string }[]> {
  return q<{ post_id: string; ext: string }>(
    `select tp.post_id, tp.${extId} as ext from ${table} tp
       join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       left join post_metric pm on pm.post_id=tp.post_id and pm.network=$2
     where s.workspace_id=$1 and tp.status='sent' and tp.${extId} is not null
       and tp.created_at > now() - interval '90 days'
       and (pm.post_id is null or pm.fetched_at < now() - interval '24 hours')
     order by tp.created_at desc limit ${PER_TICK}`, [ws, network]);
}

async function saveMetric(postId: string, network: string, views: number, likes: number): Promise<void> {
  await q(
    `insert into post_metric(post_id, network, views, likes, fetched_at) values($1,$2,$3,$4,now())
     on conflict (post_id, network) do update set views=excluded.views, likes=excluded.likes, fetched_at=now()`,
    [postId, network, Math.max(0, Math.round(views) || 0), Math.max(0, Math.round(likes) || 0)]);
}

async function collectWorkspace(ws: string): Promise<number> {
  let n = 0;
  // Threads: insights доступні одразу (views, likes)
  const th = await q<{ access_token: string; threads_user_id: string }>(
    `select access_token, threads_user_id from threads_config where workspace_id=$1 and access_token is not null`, [ws]);
  if (th.length) {
    for (const r of await stalePosts(ws, "threads_publish", "threads", "media_id")) {
      try { const ins = await threads.mediaInsights(th[0].access_token, r.ext); await saveMetric(r.post_id, "threads", ins.views || 0, ins.likes || 0); n++; }
      catch { /* один недоступний інсайт не валить збір */ }
    }
  }
  // Facebook (post_impressions) + Instagram (reach) через page_token
  const mt = await q<{ page_token: string; ig_user_id: string | null }>(
    `select page_token, ig_user_id from meta_config where workspace_id=$1 and page_token is not null`, [ws]);
  if (mt.length) {
    for (const r of await q<{ post_id: string; ext: string; channel: string }>(
      `select mp.post_id, mp.external_id as ext, mp.channel from meta_publish mp
         join post p on p.id=mp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
         left join post_metric pm on pm.post_id=mp.post_id and pm.network=mp.channel
       where s.workspace_id=$1 and mp.status='sent' and mp.external_id is not null
         and mp.created_at > now() - interval '90 days'
         and (pm.post_id is null or pm.fetched_at < now() - interval '24 hours')
       order by mp.created_at desc limit ${PER_TICK}`, [ws])) {
      try {
        if (r.channel === "facebook") {
          const ins = await meta.postInsights(r.ext, mt[0].page_token);
          await saveMetric(r.post_id, "facebook", ins.post_impressions || ins.post_impressions_unique || 0, 0); n++;
        } else if (r.channel === "instagram") {
          const ins = await meta.igMediaInsights(r.ext, mt[0].page_token);
          await saveMetric(r.post_id, "instagram", ins.reach, ins.likes); n++;
        }
      } catch { /* без insights-дозволу чи для старого поста - пропускаємо мовчки */ }
    }
  }
  return n;
}

async function tick(): Promise<void> {
  const wss = await q<{ workspace_id: string }>(
    `select workspace_id from threads_config where access_token is not null
     union select workspace_id from meta_config where page_token is not null`);
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
export type BenchPost = { post_id: string; network: string; views: number; likes: number; mult: number; title: string; content: string; fetched_at: string };
export async function networkBenchmarks(ws: string): Promise<{ networks: Record<string, { median: number; count: number }>; posts: BenchPost[] }> {
  const rows = await q<{ post_id: string; network: string; views: number; likes: number; fetched_at: string; content: string }>(
    `select pm.post_id, pm.network, pm.views, pm.likes, pm.fetched_at, p.content
       from post_metric pm join post p on p.id=pm.post_id
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 order by pm.views desc`, [ws]);
  const byNet = new Map<string, number[]>();
  for (const r of rows) { if (!byNet.has(r.network)) byNet.set(r.network, []); byNet.get(r.network)!.push(r.views); }
  const networks: Record<string, { median: number; count: number }> = {};
  for (const [net, views] of byNet) {
    if (views.length < 3) continue; // замало даних для чесної норми
    const sorted = [...views].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    networks[net] = { median: Math.max(1, median), count: views.length };
  }
  const posts: BenchPost[] = rows
    .filter((r) => networks[r.network])
    .map((r) => ({
      post_id: r.post_id, network: r.network, views: r.views, likes: r.likes,
      mult: Math.round((r.views / networks[r.network].median) * 10) / 10,
      title: (r.content || "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 80) || "",
      content: (r.content || "").slice(0, 1500), fetched_at: r.fetched_at,
    }))
    .sort((a, b) => b.mult - a.mult);
  return { networks, posts };
}
