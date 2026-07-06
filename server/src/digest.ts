// Ранкове зведення в Telegram-DM: раз на день о DIGEST_HOUR (локальний час воркспейсу).
// Один живий меседж (category 'daily') — інсайт дня + дірка в плані на завтра + к-сть ідей + кнопки.
import { q, one } from "./db.js";
import { env } from "./env.js";
import { logEvent } from "./log.js";
import { nextInsight } from "./pipeline.js";
import { liveSend } from "./tgbot.js";

const DIGEST_HOUR = 9; // ранок за таймзоною воркспейсу

// локальні година + дата (YYYY-MM-DD) для таймзони
function localParts(tz: string): { hour: number; date: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return { hour: Number(p.hour), date: `${p.year}-${p.month}-${p.day}` };
}
const plusDay = (date: string, n: number): string => {
  const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};

async function sendDigest(ws: string, chatId: string, localDate: string): Promise<void> {
  let insight = "Контент, який ти не опублікував, не працює.";
  try { insight = await nextInsight(ws); } catch { /* фолбек лишається */ }
  const tomorrow = plusDay(localDate, 1);
  const [slotTomorrow, ideasCount, anyPlan, nextSlot] = await Promise.all([
    one<{ n: number }>(`select count(*)::int n from plan_slot where workspace_id=$1 and slot_date=$2 and status <> 'published'`, [ws, tomorrow]),
    one<{ n: number }>(`select count(*)::int n from idea_bank where workspace_id=$1 and status='new'`, [ws]),
    one<{ n: number }>(`select count(*)::int n from plan_slot where workspace_id=$1 and slot_date >= $2`, [ws, localDate]),
    one<{ id: string; theme: string }>(`select id, theme from plan_slot where workspace_id=$1 and slot_date >= $2 and status in ('empty','matched') order by slot_date limit 1`, [ws, localDate]),
  ]);
  const lines = [`💡 **${insight}**`];
  if (!(slotTomorrow?.n)) lines.push("\n⚠️ Завтра нема запланованого поста. Виділи 5 хвилин.");
  if (nextSlot?.theme) lines.push(`✍️ Найближча тема: «${nextSlot.theme.slice(0, 90)}»`);
  if (ideasCount?.n) lines.push(`💡 У Банку ${ideasCount.n} ідей — зроби пост у 1 тап.`);
  if (!(anyPlan?.n)) lines.push("📭 Контент-плану ще нема — сформуймо кістяк на 2 тижні.");

  const buttons: { text: string; data?: string; url?: string }[][] = [];
  if (nextSlot?.id) buttons.push([{ text: "✍️ Зробити пост зараз", data: `slot_post:${nextSlot.id}` }]); // 1 тап: тема слота → чернетка в DM
  if (ideasCount?.n) buttons.push([{ text: "💡 Показати ідеї", data: "idea_list" }]);
  if (!(anyPlan?.n)) buttons.push([{ text: "⚡ Сформувати план", data: "plan_gen" }]);
  buttons.push([{ text: "🌐 Відкрити застосунок", url: env.appBaseUrl + "/app" }]);
  await liveSend(ws, chatId, "daily", lines.join("\n"), buttons);
}

// Надіслати зведення НЕГАЙНО (команда /digest у боті - для перевірки без очікування 9:00).
export async function sendDigestNow(ws: string, chatId: string): Promise<void> {
  const tzRow = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [ws]);
  const { date } = localParts(tzRow?.content || "Europe/Kyiv");
  await sendDigest(ws, chatId, date);
}

async function tick(): Promise<void> {
  if (!env.telegram.botToken) return;
  const owners = await q<{ workspace_id: string; chat_id: string }>(`select workspace_id, chat_id from tg_owner where chat_id is not null`);
  for (const o of owners) {
    try {
      const tzRow = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [o.workspace_id]);
      const { hour, date } = localParts(tzRow?.content || "Europe/Kyiv");
      if (hour !== DIGEST_HOUR) continue;
      const last = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='digest_last'`, [o.workspace_id]);
      if (last?.content === date) continue; // вже слали сьогодні
      await sendDigest(o.workspace_id, o.chat_id, date);
      await q(`insert into settings_block(workspace_id, key, content) values($1,'digest_last',$2)
               on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`, [o.workspace_id, date]);
    } catch (e: any) { await logEvent("error", "digest", e.message); }
  }
}

let running = false;
export function startDigest(): void {
  setInterval(async () => {
    if (running) return; running = true;
    try { await tick(); } catch (e: any) { await logEvent("error", "digest", "tick: " + e.message); } finally { running = false; }
  }, 5 * 60 * 1000); // кожні 5 хв; шле раз на день о 9:00 локального часу воркспейсу
  console.log("[digest] воркер ранкового зведення запущено");
}
