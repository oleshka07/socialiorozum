// Ранкове зведення в Telegram-DM: раз на день о DIGEST_HOUR (локальний час воркспейсу).
// Один живий меседж (category 'daily') — інсайт дня + дірка в плані на завтра + к-сть ідей + кнопки.
import { q, one } from "./db.js";
import { env } from "./env.js";
import { logEvent } from "./log.js";
import { nextInsight } from "./pipeline.js";
import { liveSend } from "./tgbot.js";
import { networkBenchmarks } from "./metrics.js";
import { weekDiary } from "./diary.js";
import * as threads from "./threads.js";

// «Мультиплікатор ← аналітика»: чи вистрілив хтось із нещодавніх Threads-постів (перегляди ≥1.5× середнього решти).
// MVP на Threads (там insights найдоступніші); IG/FB додамо, коли буде збір метрик у БД.
async function findBreakout(ws: string): Promise<{ postId: string; views: number; title: string } | null> {
  const cfg = await one<{ threads_user_id: string | null; access_token: string | null }>(
    `select threads_user_id, access_token from threads_config where workspace_id=$1`, [ws]);
  if (!cfg?.access_token) return null;
  const recent = await q<{ post_id: string; media_id: string; content: string }>(
    `select tp.post_id, tp.media_id, p.content from threads_publish tp join post p on p.id=tp.post_id
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and tp.status='sent' and tp.media_id is not null
       and tp.created_at > now() - interval '72 hours' order by tp.created_at desc limit 6`, [ws]);
  if (recent.length < 3) return null; // замало даних для медіани
  const stats: { postId: string; views: number; title: string }[] = [];
  for (const r of recent) {
    try {
      const ins = await threads.mediaInsights(cfg.access_token, r.media_id);
      stats.push({ postId: r.post_id, views: ins.views || 0, title: (r.content || "").split("\n")[0].slice(0, 70) });
    } catch { /* один недоступний інсайт не валить перевірку */ }
  }
  if (stats.length < 3) return null;
  const top = stats.reduce((a, b) => (b.views > a.views ? b : a));
  // норма = медіана з накопичених метрик (post_metric, ≥5 знімків); фолбек - середнє решти свіжих постів
  let baseline = 0;
  try {
    const { networks } = await networkBenchmarks(ws);
    if (networks.threads && networks.threads.count >= 5) baseline = networks.threads.median;
  } catch { /* бенчмарки ще не зібрані */ }
  if (!baseline) {
    const rest = stats.filter((x) => x !== top);
    baseline = rest.reduce((s2, x) => s2 + x.views, 0) / rest.length;
  }
  return top.views >= 30 && top.views >= baseline * 1.5 ? top : null;
}

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
  // 🔥 пост вистрілив → пропонуємо «Продовження» одразу, поки аудиторія тепла
  let breakout: { postId: string; views: number; title: string } | null = null;
  try { breakout = await findBreakout(ws); } catch { /* аналітика не критична */ }
  if (breakout) lines.push(`\n🔥 Пост «${breakout.title}» залетів (${breakout.views} переглядів — сильно вище решти). Розвинути, поки гаряче?`);
  // 🎯 Директор: «третя ідея повз ціль» - патерн, який варто назвати
  try {
    const dm = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='director_misses'`, [ws]);
    const d = JSON.parse(dm?.content || "{}");
    if (Number(d.count) >= 3 && (d.date === localDate || d.date === plusDay(localDate, -1)))
      lines.push(`\n🎯 ${d.count} чернетки поспіль не вели до цілі. Що відводить від фокуса?`);
  } catch { /* не критично */ }

  // 📔 недільна петля: тиждень щоденника → серія ідей / нарізка на рілси
  let weekD: { count: number; chars: number } | null = null;
  if (new Date(localDate + "T12:00:00Z").getUTCDay() === 0) {
    try { const w = await weekDiary(ws); if (w.count > 0) { weekD = w; lines.push(`\n📔 За тиждень ${w.count} запис(ів) щоденника. Перетворимо на контент?`); } }
    catch { /* не критично */ }
  }
  const buttons: { text: string; data?: string; url?: string }[][] = [];
  if (weekD) {
    const row: { text: string; data: string }[] = [{ text: "💡 Ідеї з тижня", data: "dweek_ideas" }];
    try {
      const pro = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='pro'`, [ws]);
      if (pro?.content === "1" && weekD.chars > 800) row.push({ text: "🎞 Нарізка на рілси", data: "dweek_reels" });
    } catch { /* без другої кнопки */ }
    buttons.push(row);
  }
  if (breakout) {
    const row: { text: string; data: string }[] = [{ text: "🔥 5 кутів продовження", data: `dev:${breakout.postId}` }];
    // перепакування хіта в інший формат - рілс (ПРО-трек)
    try {
      const pro = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='pro'`, [ws]);
      if (pro?.content === "1") row.push({ text: "🎬 Рілс із цього", data: `reel:${breakout.postId}` });
    } catch { /* без кнопки */ }
    buttons.push(row);
  }
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
