// 🧵 Автоматика Threads: (1) відкладені CTA-гілки (threads_reply_job - лінк/кодове слово
// доклеюється відповіддю у ВЛАСНУ гілку, коли пост уже розганяється), (2) щоденні тейки -
// щоранку порція коротких чернеток у Студію з Банку ідей і щоденника (полігон тестування:
// що залетить за бенчмарками - масштабуємо в гілку/рілс).
import { q, one } from "./db.js";
import { logEvent } from "./log.js";
import { canTry, failedTry, succeededTry } from "./dailytry.js";
import * as threads from "./threads.js";
import { thValidToken } from "./publisher.js";
import { generateThreadsTakes } from "./pipeline.js";
import { setSetting } from "./settings.js";

const TAKES_HOUR = 8; // за годину до ранкового зведення (9:00) - воно вже побачить свіжі чернетки

// локальні година + дата (YYYY-MM-DD) для таймзони воркспейсу (як у digest)
function localParts(tz: string): { hour: number; date: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return { hour: Number(p.hour), date: `${p.year}-${p.month}-${p.day}` };
}

async function processReplyJobs(): Promise<void> {
  const jobs = await q<{ id: string; workspace_id: string; root_media_id: string; reply_text: string }>(
    `select id, workspace_id, root_media_id, reply_text from threads_reply_job
     where status='pending' and due_at <= now() order by due_at limit 10`);
  for (const j of jobs) {
    // забираємо джобу ДО публікації: перезапуск між публікацією й записом статусу інакше дав би
    // другу відповідь під той самий пост
    const claimed = await one(`update threads_reply_job set status='sending' where id=$1 and status='pending' returning id`, [j.id]);
    if (!claimed) continue;
    try {
      const tok = await thValidToken(j.workspace_id);
      if (!tok) throw new Error("Threads не підключено");
      await threads.publish(tok.token, tok.userId, j.reply_text, undefined, j.root_media_id);
      await q(`update threads_reply_job set status='sent' where id=$1`, [j.id]);
    } catch (e: any) {
      await q(`update threads_reply_job set status='error', error=$2 where id=$1`, [j.id, String(e.message).slice(0, 300)]);
      await logEvent("error", "threads-auto", "CTA-гілка: " + e.message, { ws: j.workspace_id });
    }
  }
}

async function processDailyTakes(): Promise<void> {
  const rows = await q<{ workspace_id: string; content: string }>(
    `select workspace_id, content from settings_block where key='threads_strategy'`);
  for (const r of rows) {
    let n = 0;
    try { n = Number(JSON.parse(r.content || "{}").takes || 0); } catch { /* битий JSON = вимкнено */ }
    if (!n) continue;
    try {
      const th = await one<{ access_token: string | null }>(`select access_token from threads_config where workspace_id=$1`, [r.workspace_id]);
      if (!th?.access_token) continue; // тейки мають сенс лише з підключеним Threads
      const tzRow = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [r.workspace_id]);
      const { hour, date } = localParts(tzRow?.content || "Europe/Kyiv");
      if (hour !== TAKES_HOUR) continue;
      const last = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='takes_last'`, [r.workspace_id]);
      if (last?.content === date) continue; // сьогодні вже генерували
      const key = r.workspace_id + ":takes";
      if (!canTry(key, date)) continue; // після збою - не щохвилини, а до 3 спроб на день
      try {
        await generateThreadsTakes(r.workspace_id, n);
        succeededTry(key);
      } catch (e: any) {
        const gaveUp = failedTry(key, date, e);
        await logEvent("error", "threads-auto", "тейки: " + e.message + (gaveUp ? " (на сьогодні спроби вичерпано)" : " (повтор за 20 хв)"), { ws: r.workspace_id });
        continue;
      }
      await setSetting(r.workspace_id, "takes_last", date);
    } catch (e: any) { await logEvent("error", "threads-auto", "тейки: " + e.message, { ws: r.workspace_id }); }
  }
}

let running = false;
export function startThreadsAuto(): void {
  setInterval(async () => {
    if (running) return; running = true;
    try { await processReplyJobs(); await processDailyTakes(); }
    catch (e: any) { await logEvent("error", "threads-auto", "tick: " + e.message); }
    finally { running = false; }
  }, 60 * 1000);
  console.log("[threads-auto] воркер CTA-гілок і щоденних тейків запущено");
}
