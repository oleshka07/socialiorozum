import { q, one } from "./db.js";
import * as tg from "./telegram.js";
import { logEvent } from "./log.js";

// Фоновий воркер: публікує заплановані (status='planned') слоти, час яких настав.
// Постить лише те, що користувач свідомо додав у календар із датою.
async function tick(): Promise<void> {
  const due = await q<{
    id: string; post_id: string | null; content: string | null;
    bot_token: string | null; channel_chat: string | null; group_chat: string | null;
  }>(
    `select ss.id,
            p.id as post_id, p.content as content,
            tc.bot_token,
            tc.channel_chat_id as channel_chat,
            tc.group_chat_id   as group_chat
     from schedule_slot ss
       join plan_item pi  on pi.id = ss.plan_item_id
       join content_plan cp on cp.id = pi.plan_id
       join pipeline_run r on r.id = cp.run_id
       join source s on s.id = r.source_id
       left join post p on p.id = pi.post_id
       left join telegram_config tc on tc.workspace_id = s.workspace_id
     where ss.status = 'planned' and ss.scheduled_at is not null and ss.scheduled_at <= now()
     order by ss.scheduled_at
     limit 20`
  );

  for (const slot of due) {
    // атомарно "забираємо" слот, щоб не задублювати при перекритті тіків
    const claimed = await one(`update schedule_slot set status='posting' where id=$1 and status='planned' returning id`, [slot.id]);
    if (!claimed) continue;

    if (!slot.content || !slot.bot_token) {
      await q(`update schedule_slot set status='failed' where id=$1`, [slot.id]);
      await logEvent("warn", "autopost", `slot ${slot.id}: немає контенту або Telegram не підключений`);
      continue;
    }

    let anyOk = false;
    for (const [target, chatId] of [["channel", slot.channel_chat], ["group", slot.group_chat]] as const) {
      if (!chatId) continue;
      try {
        const r = await tg.sendMessage(slot.bot_token, chatId, slot.content);
        await q(`insert into telegram_publish(post_id, target, chat_id, message_id, status) values($1,$2,$3,$4,'sent')`,
          [slot.post_id, target, chatId, r.message_id]);
        anyOk = true;
      } catch (e: any) {
        await q(`insert into telegram_publish(post_id, target, chat_id, status, error) values($1,$2,$3,'error',$4)`,
          [slot.post_id, target, chatId, e.message]);
        await logEvent("error", "autopost", `slot ${slot.id} ${target}: ${e.message}`);
      }
    }
    await q(`update schedule_slot set status=$2 where id=$1`, [slot.id, anyOk ? "posted" : "failed"]);
    if (anyOk) await logEvent("info", "autopost", `опубліковано slot ${slot.id}`);
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
