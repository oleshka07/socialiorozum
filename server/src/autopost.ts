import { q, one } from "./db.js";
import { logEvent } from "./log.js";
import { publishPostToChannels, isStopping } from "./publisher.js";
import { publishQuestions } from "./pipeline.js";

// тексти тимчасових збоїв (людські - з humanTgError/humanMetaError/humanNetError - і сирі мережеві)
const TRANSIENT = /зачекати|забагато|не відповів|не відповіла|тимчасово|перезапуска|саме зараз публікується|timeout|HTTP 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i;

// Фоновий воркер: публікує заплановані (status='planned') слоти, час яких настав,
// у ВСІ обрані мережі поста (post.channels). Якщо мережі не обрані — Telegram (legacy).
async function tick(): Promise<void> {
  if (isStopping()) return; // сервер зупиняється - нові слоти забере наступний процес
  // сторож: слот, що завис у 'posting' (процес упав посеред публікації - деплой, OOM) інакше
  // випадає з автопосту НАЗАВЖДИ без жодної помилки в UI - наступний тік бачить лише status='planned'.
  await q(`update schedule_slot set status='planned', updated_at=now() where status='posting' and updated_at < now() - interval '15 minutes'`);
  const due = await q<{ id: string; post_id: string; workspace_id: string; channels: any; attempts: number }>(
    `select ss.id, p.id as post_id, s.workspace_id, ss.channels, ss.attempts
     from schedule_slot ss
       left join plan_item pi on pi.id = ss.plan_item_id
       join post p on p.id = coalesce(ss.post_id, pi.post_id)
       join pipeline_run r on r.id = p.run_id
       join source s on s.id = r.source_id
     where ss.status='planned' and ss.scheduled_at is not null and coalesce(ss.retry_at, ss.scheduled_at) <= now()
     order by ss.scheduled_at
     limit 20`
  );

  for (const slot of due) {
    // атомарно "забираємо" слот, щоб не задублювати при перекритті тіків
    const claimed = await one(`update schedule_slot set status='posting', updated_at=now() where id=$1 and status='planned' returning id`, [slot.id]);
    if (!claimed) continue;
    try {
      // слот із channels (ритм каналів) цілить лише свою підмножину мереж
      const only = slot.channels ? Object.keys(slot.channels).filter((k) => slot.channels[k] && slot.channels[k].on) : undefined;
      const results = await publishPostToChannels(slot.workspace_id, slot.post_id, only && only.length ? only : undefined);
      const anyOk = results.some((r) => r.status === "sent");
      const ok = results.filter((r) => r.status === "sent").map((r) => r.channel).join(", ");
      const skip = results.filter((r) => r.status === "skipped").map((r) => r.channel).join(", ");
      const err = results.filter((r) => r.status === "error").map((r) => `${r.channel}: ${r.error}`).join("; ");
      // «пропущено» (мережа вже опублікована) — це НЕ помилка: слот вважається виконаним, якщо є хоч один sent або лише skipped без помилок
      const benign = !err && (anyOk || !!skip);
      // тимчасовий збій (ліміт мережі, таймаут, 5xx, перезапуск) - не вирок: повторюємо до 3 разів через
      // 10 хв. Уже надіслані мережі повтор не чіпає (дедуп «раз на мережу»), добивається лише решта.
      const errs = results.filter((r) => r.status === "error");
      if (!benign && errs.length && errs.every((r) => TRANSIENT.test(String(r.error))) && (slot.attempts || 0) < 3) {
        const note = [ok ? `✓ ${ok}` : "", `⏳ повтор ${(slot.attempts || 0) + 1}/3 через 10 хв: ${err}`].filter(Boolean).join(" · ");
        await q(`update schedule_slot set status='planned', attempts=attempts+1, retry_at=now() + interval '10 minutes', result=$2, updated_at=now() where id=$1`, [slot.id, note]);
        await logEvent("warn", "autopost", `slot ${slot.id}: тимчасовий збій, повтор через 10 хв (${err})`);
        continue;
      }
      const summary = [ok ? `✓ ${ok}` : "", skip ? `↩ вже: ${skip}` : "", err ? `⚠ ${err}` : ""].filter(Boolean).join(" · ") || "немає обраних каналів";
      await q(`update schedule_slot set status=$2, result=$3, updated_at=now() where id=$1`, [slot.id, benign ? "posted" : "failed", summary]);
      if (anyOk) await q(`update plan_slot set status='published' where post_id=$1 and status in ('drafted','approved','scheduled')`, [slot.post_id]);
      // «Питання» після публікації: 3 теми-продовження → Банк ідей (у фоні, помилка не критична)
      if (anyOk) one<{ content: string }>(`select content from post where id=$1`, [slot.post_id])
        .then((p) => p && publishQuestions(slot.workspace_id, p.content)).catch(() => {});
      if (anyOk) await logEvent("info", "autopost", `slot ${slot.id} → ${ok}${err ? ` (помилки: ${err})` : ""}`);
      else if (benign) await logEvent("info", "autopost", `slot ${slot.id}: усі мережі вже опубліковано (${skip})`);
      else await logEvent("warn", "autopost", `slot ${slot.id} не опубліковано: ${err || "немає каналів"}`);
    } catch (e: any) {
      await q(`update schedule_slot set status='failed', result=$2, updated_at=now() where id=$1`, [slot.id, e.message]);
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
