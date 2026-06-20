import { q, one } from "./db.js";
import { logEvent } from "./log.js";
import { publishPostToChannels } from "./publisher.js";

// Фоновий воркер: публікує заплановані (status='planned') слоти, час яких настав,
// у ВСІ обрані мережі поста (post.channels). Якщо мережі не обрані — Telegram (legacy).
async function tick(): Promise<void> {
  const due = await q<{ id: string; post_id: string; workspace_id: string }>(
    `select ss.id, p.id as post_id, s.workspace_id
     from schedule_slot ss
       left join plan_item pi on pi.id = ss.plan_item_id
       join post p on p.id = coalesce(ss.post_id, pi.post_id)
       join pipeline_run r on r.id = p.run_id
       join source s on s.id = r.source_id
     where ss.status='planned' and ss.scheduled_at is not null and ss.scheduled_at <= now()
     order by ss.scheduled_at
     limit 20`
  );

  for (const slot of due) {
    // атомарно "забираємо" слот, щоб не задублювати при перекритті тіків
    const claimed = await one(`update schedule_slot set status='posting' where id=$1 and status='planned' returning id`, [slot.id]);
    if (!claimed) continue;
    try {
      const results = await publishPostToChannels(slot.workspace_id, slot.post_id, { fallbackTelegram: true });
      const anyOk = results.some((r) => r.status === "sent");
      await q(`update schedule_slot set status=$2 where id=$1`, [slot.id, anyOk ? "posted" : "failed"]);
      const ok = results.filter((r) => r.status === "sent").map((r) => r.channel).join(", ");
      const err = results.filter((r) => r.status === "error").map((r) => `${r.channel}: ${r.error}`).join("; ");
      if (anyOk) await logEvent("info", "autopost", `slot ${slot.id} → ${ok}${err ? ` (помилки: ${err})` : ""}`);
      else await logEvent("warn", "autopost", `slot ${slot.id} не опубліковано: ${err || "немає каналів"}`);
    } catch (e: any) {
      await q(`update schedule_slot set status='failed' where id=$1`, [slot.id]);
      await logEvent("error", "autopost", `slot ${slot.id}: ${e.message}`);
    }
  }
}

let running = false;
export function startAutopost(): void {
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); }
    catch (e: any) { await logEvent("error", "autopost", "tick: " + e.message); }
    finally { running = false; }
  }, 60000);
  console.log("[autopost] воркер запущено (перевірка щохвилини)");
}
