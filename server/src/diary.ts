// 📔 Щоденник: бот двічі на день (обід 13:00 / вечір 20:00 за таймзоною воркспейсу) питає
// «що сьогодні відбувалося?» - відповіді текстом/голосом/фото/відео стають ЖИВИМ джерелом контенту
// (source origin='diary', один запис на день, усе дописується в нього).
// Питання не копляться: liveSend категорії 'diary' видаляє попереднє. Ігнор 3 дні поспіль → лишається
// тільки вечірнє питання. Голос розшифровує Whisper (OPENAI_API_KEY). Медіа → галерея source='diary'.
import { q, one } from "./db.js";
import { env } from "./env.js";
import { logEvent } from "./log.js";
import { liveSend } from "./tgbot.js";
import * as tg from "./telegram.js";
import { saveMedia } from "./media.js";
import { chat, extractJsonArray } from "./openrouter.js";

// ---- стан щоденника на воркспейс (settings_block key='diary_state') ----
type DiaryState = { answered?: string; skip?: string; lunch?: string; evening?: string; pending?: boolean; misses?: number };
async function getState(ws: string): Promise<DiaryState> {
  const row = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='diary_state'`, [ws]);
  try { return JSON.parse(row?.content || "{}"); } catch { return {}; }
}
async function setState(ws: string, patch: DiaryState): Promise<void> {
  const cur = await getState(ws);
  await q(`insert into settings_block(workspace_id,key,content) values($1,'diary_state',$2)
           on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
    [ws, JSON.stringify({ ...cur, ...patch })]);
}
export async function isDiaryPending(ws: string): Promise<boolean> { return !!(await getState(ws)).pending; }

// локальні година/дата/час для таймзони (як у digest.ts - маленький дубль, щоб не плодити import-цикл)
function localParts(tz: string): { hour: number; date: string; time: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return { hour: Number(p.hour), date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
async function wsTz(ws: string): Promise<string> {
  const r = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [ws]);
  return r?.content || "Europe/Kyiv";
}

// ---- питання: ротація + привʼязка до завтрашнього слота плану ----
const LUNCH_Q = [
  "Обідній чек-ін: що сьогодні вже відбулося цікавого? Розмова, задача, спостереження - текстом чи голосом 🎙",
  "Яка розмова чи момент сьогодні зачепили? Надиктуй голосом - я розшифрую і збережу.",
  "Що сьогодні пішло не так, як планував? Саме такі історії читають найкраще.",
  "Над чим зараз працюєш? Опиши процес своїми словами - з цього виходять живі пости.",
  "Було щось, що тебе сьогодні здивувало? Кинь текстом, голосом чи фото.",
];
const EVENING_Q = [
  "Вечірній чек-ін: що сьогодні відбулося? Історія, урок, момент - текстом, голосом, фото чи відео.",
  "Який головний урок дня? Один момент, одна думка - цього досить.",
  "Що сьогодні спитав клієнт чи колега таке, що ти задумався?",
  "Чим сьогоднішній день відрізнявся від учорашнього? Одна деталь.",
];
const EVENING_MORE = "Додаси щось до сьогоднішнього запису? Фото чи коротке відео з дня теж чудово заходить 📎";

async function buildQuestion(ws: string, kind: "lunch" | "evening", date: string, answeredToday: boolean): Promise<string> {
  const day = Number(date.slice(-2)) || 1;
  let text = "📔 " + (answeredToday && kind === "evening" ? EVENING_MORE
    : kind === "lunch" ? LUNCH_Q[day % LUNCH_Q.length] : EVENING_Q[day % EVENING_Q.length]);
  // вечором - гачок під завтрашній план: щоденник цілеспрямовано годує контент-план
  if (kind === "evening" && !answeredToday) {
    try {
      const slot = await one<{ theme: string }>(
        `select theme from plan_slot where workspace_id=$1 and slot_date=($2::date + 1) and status in ('empty','matched') limit 1`, [ws, date]);
      if (slot?.theme) text += `\n\n💡 Завтра за планом: «${slot.theme.replace(/^🧪\s*/, "").slice(0, 90)}». Маєш живий приклад чи історію під це?`;
    } catch { /* без гачка */ }
  }
  return text;
}

// ---- запис дня: source origin='diary', один на дату, все дописується ----
const uaDate = (date: string): string => {
  const M = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
  return `${Number(date.slice(8, 10))} ${M[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
};

// кнопки під підтвердженням запису: міст від сирої історії до контенту в 1 тап
async function diaryButtons(ws: string, srcId: string): Promise<tg.TgButton[][]> {
  const rows: tg.TgButton[][] = [[{ text: "✨ Зробити пост", data: `dpost:${srcId}` }, { text: "💡 Витягти ідеї", data: `dideas:${srcId}` }]];
  try {
    const pro = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='pro'`, [ws]);
    if (pro?.content === "1") rows[0].push({ text: "🎬 Рілс", data: `dreel:${srcId}` });
  } catch { /* без рілса */ }
  return rows;
}

// текст (набраний чи розшифрований з голосу) → ОКРЕМЕ джерело на кожен запис, ЦІЛИМ і ДОСЛІВНО.
// ⚠️ Авто-розбір на теми ВИКЛЮЧЕНО (фідбек Олега + реальний збиток): він різав ОДНУ звʼязну історію
// (дзвінок з постачальником → 6 фрагментів по 200-460 симв.) на шматки І ЗАТИРАВ оригінал, тож
// генерація бачила ~1/6 контексту й добивала пустоту вигаданою генерикою («ось що ми випробували:
// персоналізація / інтеграція AI / прозорість» - автор такого не казав). Первісна причина розбору
// («кілька аудіо зливались в одну кашу») зникла ще тоді, коли КОЖЕН запис став окремим джерелом.
export async function appendDiaryText(ws: string, chatId: string, text: string, voice = false): Promise<void> {
  const { date, time } = localParts(await wsTz(ws));
  const title = `📔 Щоденник, ${uaDate(date)} · ${time}${voice ? " 🎙" : ""}`;
  const d = await one<{ id: string }>(
    `insert into source(workspace_id, origin, title, transcript) values($1,'diary',$2,$3) returning id`,
    [ws, title, text.trim().slice(0, 8000)]);
  await setState(ws, { answered: date, pending: false, misses: 0 });
  await liveSend(ws, chatId, "diary_ok",
    `📔 Записав у щоденник (${uaDate(date)}, ${time}):\n«${text.trim().slice(0, 160)}»\n\nЗапис збережено ЦІЛИМ - історія не ріжеться на шматки, тож пост вийде звʼязним.`,
    await diaryButtons(ws, d!.id));
}

// ⚠️ ДОРМАНТНО (не викликається - див. коментар у appendDiaryText): різало звʼязну історію на шматки
// й затирало оригінал. Код лишений, бо сама ідея валідна для СПРАВДІ різних подій в одному записі -
// але тоді потрібен інший поріг («різні події», не «різні думки про одне») і БЕЗ затирання оригіналу.
// довгий запис із КІЛЬКОМА темами → окремі матеріали (зустріч з інвестором ≠ будівництво ≠ рефлексія):
// один рілс/пост на одну тему виходить звʼязним, а не «про все потроху». Дешева модель, у фоні.
async function splitDiaryTopics(ws: string, srcId: string, baseTitle: string): Promise<void> {
  const src = await one<{ transcript: string }>(`select transcript from source where id=$1`, [srcId]);
  const text = (src?.transcript || "").trim();
  if (text.length < 400) return; // короткий запис = одна тема
  const raw = await chat(env.cheapModel,
    "Ти редактор щоденника. Якщо в записі КІЛЬКА самостійних тем (різні події/сфери: зустріч, обʼєкт, рефлексія...) - розбий його. " +
    "Кожна тема = самостійний фрагмент ДОСЛІВНИМ текстом автора (нічого не переписуй і не додавай), з короткою назвою до 6 слів. " +
    'Якщо тема ОДНА - поверни []. Поверни ЛИШЕ валідний JSON-масив: [{"title":"назва теми","text":"дослівний фрагмент"}].',
    text.slice(0, 8000), { workspaceId: ws, step: "diary_split" });
  let parts: { title: string; text: string }[] = [];
  try { parts = extractJsonArray<any>(raw).map((x: any) => ({ title: String(x?.title || "").trim(), text: String(x?.text || "").trim() })).filter((p) => p.text.length > 80); } catch { return; }
  if (parts.length < 2) return;
  // перша тема займає місце оригіналу (та сама картка, кнопки бота лишаються робочими), решта - нові матеріали
  await q(`update source set title=$2, transcript=$3 where id=$1`, [srcId, `${baseTitle} · ${parts[0].title}`.slice(0, 200), parts[0].text.slice(0, 8000)]);
  for (const pt of parts.slice(1))
    await q(`insert into source(workspace_id, origin, title, transcript) values($1,'diary',$2,$3)`,
      [ws, `${baseTitle} · ${pt.title}`.slice(0, 200), pt.text.slice(0, 8000)]);
  await logEvent("info", "diary", `запис розкладено на ${parts.length} тем`);
}

// фото/відео → галерея (source='diary') + позначка в записі дня
export async function attachDiaryMedia(ws: string, chatId: string, buffer: Buffer, mime: string, name: string, caption?: string): Promise<void> {
  const { date, time } = localParts(await wsTz(ws));
  const title = `📔 Щоденник, ${uaDate(date)} · ${time} 📎`;
  const d = await one<{ id: string }>(
    `insert into source(workspace_id, origin, title, transcript) values($1,'diary',$2,'') returning id`, [ws, title]);
  const m = await saveMedia(ws, { buffer, mime, name, source: "diary", externalId: d!.id });
  const note = `📎 ${m.kind === "video" ? "відео" : "фото"} дня${caption ? `: ${caption.trim().slice(0, 300)}` : ""}`;
  await q(`update source set transcript=$2 where id=$1`, [d!.id, note]);
  await setState(ws, { answered: date, pending: false, misses: 0 });
  const buttons = await diaryButtons(ws, d!.id);
  if (m.kind === "video") buttons.push([{ text: "🎥 У вставки для рілсів (b-roll)", data: `dbroll:${m.id}` }]);
  await liveSend(ws, chatId, "diary_ok",
    `📔 ${m.kind === "video" ? "Відео" : "Фото"} в галереї з міткою «щоденник» і привʼязане до запису за ${uaDate(date)} ✓`, buttons);
}

// ---- Whisper: голосове → текст (OPENAI_API_KEY; ~$0.006/хв) ----
export async function transcribeVoice(buffer: Buffer, filename: string): Promise<string> {
  if (!env.openai.apiKey) throw new Error("розшифровка голосу тимчасово недоступна - напиши, будь ласка, текстом");
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(buffer)], { type: "audio/ogg" }), filename || "voice.ogg");
  fd.append("model", "whisper-1");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let res: Response;
  try { res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${env.openai.apiKey}` }, body: fd, signal: controller.signal }); }
  catch (e: any) { if (e?.name === "AbortError") throw new Error("розшифровка затягнулась - спробуй коротше повідомлення"); throw e; }
  finally { clearTimeout(timer); }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message ? String(j.error.message).slice(0, 200) : `Whisper HTTP ${res.status}`);
  const text = String(j.text || "").trim();
  if (!text) throw new Error("не розчув - спробуй ще раз або напиши текстом");
  return text;
}

// «сьогодні нічого» - закриває день (вечірнє питання не приходить)
export async function skipDiaryToday(ws: string): Promise<void> {
  const { date } = localParts(await wsTz(ws));
  await setState(ws, { skip: date, pending: false });
}

// надіслати питання щоденника негайно (/diary у боті - перевірка без очікування розкладу)
export async function sendDiaryNow(ws: string, chatId: string): Promise<void> {
  const { date } = localParts(await wsTz(ws));
  const st = await getState(ws);
  const text = await buildQuestion(ws, "evening", date, st.answered === date);
  await liveSend(ws, chatId, "diary", text, [[{ text: "🙅 Сьогодні нічого", data: "dnone" }]]);
  await setState(ws, { pending: true });
}

// тижневий підсумок для НЕДІЛЬНОГО дайджеста: скільки записів + сумарний текст тижня
export async function weekDiary(ws: string): Promise<{ count: number; chars: number }> {
  const r = await one<{ n: number; chars: number }>(
    `select count(*)::int n, coalesce(sum(length(transcript)),0)::int chars from source
     where workspace_id=$1 and origin='diary' and created_at > now() - interval '7 days'`, [ws]);
  return { count: r?.n || 0, chars: r?.chars || 0 };
}
export async function weekDiaryText(ws: string): Promise<string> {
  const rows = await q<{ title: string; transcript: string }>(
    `select title, transcript from source where workspace_id=$1 and origin='diary' and created_at > now() - interval '7 days' order by created_at`, [ws]);
  return rows.map((r) => `${r.title}\n${r.transcript || ""}`).join("\n\n===\n\n");
}

// ---- воркер пінгів (обід/вечір за локальним часом; liveSend не дає питанням копитися) ----
const LUNCH_HOUR = 13, EVENING_HOUR = 20;
async function tick(): Promise<void> {
  if (!env.telegram.botToken) return;
  const owners = await q<{ workspace_id: string; chat_id: string }>(`select workspace_id, chat_id from tg_owner where chat_id is not null`);
  for (const o of owners) {
    try {
      const ws = o.workspace_id;
      const { hour, date } = localParts(await wsTz(ws));
      const st = await getState(ws);
      if (st.skip === date) continue;
      if (hour === LUNCH_HOUR && st.lunch !== date && st.answered !== date) {
        // бекоф «не бісити»: 3 дні пінгів без жодної відповіді → обідній вимикається, лишається вечірній
        let misses = st.misses || 0;
        const yest = new Date(date + "T12:00:00Z"); yest.setUTCDate(yest.getUTCDate() - 1);
        const yesterday = yest.toISOString().slice(0, 10);
        if (st.evening === yesterday && st.answered !== yesterday) misses++;
        if (misses >= 3) { await setState(ws, { lunch: date, misses }); continue; }
        await liveSend(ws, o.chat_id, "diary", await buildQuestion(ws, "lunch", date, false), [[{ text: "🙅 Сьогодні нічого", data: "dnone" }]]);
        await setState(ws, { lunch: date, pending: true, misses });
      } else if (hour === EVENING_HOUR && st.evening !== date) {
        const answered = st.answered === date;
        await liveSend(ws, o.chat_id, "diary", await buildQuestion(ws, "evening", date, answered),
          answered ? undefined : [[{ text: "🙅 Сьогодні нічого", data: "dnone" }]]);
        await setState(ws, { evening: date, pending: true });
      }
    } catch (e: any) { await logEvent("error", "diary", e.message); }
  }
}

let running = false;
export function startDiary(): void {
  setInterval(async () => {
    if (running) return; running = true;
    try { await tick(); } catch (e: any) { await logEvent("error", "diary", "tick: " + e.message); } finally { running = false; }
  }, 5 * 60 * 1000);
  console.log("[diary] воркер щоденника запущено (обід 13:00 / вечір 20:00 локального часу)");
}
