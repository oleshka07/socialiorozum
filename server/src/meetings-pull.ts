// 🔄 Звірка з хмарою Vymova (pull) - страховка на випадок, коли push не доїхав.
//
// Навіщо це поверх вебхука: push дає швидкість (транскрипт з'являється за секунди), але залежить
// від того, чи ми були живі в ту мить. Звірка раз на годину забирає все, що з'явилось після
// останнього побаченого `id`, і дедуплікація по `meeting_id` робить подвійне отримання безпечним -
// тобто саме та схема, яку рекомендує специфікація.
//
// ⚠️ Токен зберігає ОПЕРАТОР через кабінет. Ми його ніде не показуємо назад і не пишемо в журнал.
import { q, one } from "./db.js";
import { logEvent } from "./log.js";
import { normalizeMeeting, saveMeeting, nextCursor, cloudRecordToBody } from "./meetings.js";
import { generatePostsOnePass } from "./pipeline.js";
import { createHash } from "node:crypto";

const PAGE = 50;                       // за раз беремо помірно: звірка не мусить бути миттєвою
const EVERY = 60 * 60 * 1000;          // раз на годину - як радить специфікація

type PullCfg = {
  workspace_id: string;
  meeting_pull_url: string;
  meeting_pull_token: string;
  meeting_pull_after: string;
  meeting_auto: boolean | null;
};

const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 32);

// Токен їде в HTTP-заголовку, а він приймає лише ASCII: кирилична літера чи невидимий символ,
// що приліпився при копіюванні, інакше дають сире виключення рушія («Cannot convert argument to
// a ByteString») - людина побачила б незрозумілу технічну кашу замість «перевір, що скопіював».
// Спіймано прогоном звірки, а не здогадкою.
export function checkAuth(cfg: { url: string; token: string }): void {
  if (!/^https?:\/\/[^\s]+$/i.test(cfg.url.trim()))
    throw new Error("адреса хмари має починатись із https:// (напр. https://vymova.rozum.one)");
  if (!cfg.token.trim()) throw new Error("не задано токен доступу");
  if (!/^[\x21-\x7e]+$/.test(cfg.token.trim()))
    throw new Error("у токені є пробіл або не-латинський символ - схоже, він скопіювався не повністю");
}

async function api(cfg: { url: string; token: string }, path: string, timeoutMs = 30000): Promise<any> {
  checkAuth(cfg);
  const base = cfg.url.replace(/\/+$/, "");
  const res = await fetch(base + path, {
    headers: { Authorization: `Bearer ${cfg.token.trim()}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new Error("токен не приймається (401) - перевипусти його у Vymova і встав новий");
  if (res.status === 404) throw new Error("адреса не знайдена (404) - перевір URL хмари");
  if (!res.ok) throw new Error(`хмара Vymova відповіла ${res.status}`);
  return res.json();
}

/** Одна перевірка зʼєднання для кнопки в кабінеті - людською мовою, без токена у відповіді. */
export async function testPull(url: string, token: string): Promise<string> {
  const j = await api({ url, token }, `/api/meetings?after_id=0&limit=1`);
  const list = j?.meetings;
  if (!Array.isArray(list)) throw new Error("відповідь без поля «meetings» - це точно адреса API Vymova?");
  if (!list.length) return "✅ Зʼєднання є, але зустрічей у хмарі ще немає.";
  const m = list[0];
  return `✅ Зʼєднання є. Найстаріша зустріч: «${String(m.title || "").slice(0, 60)}»`
    + (m.meeting_id ? "" : " ⚠️ без meeting_id - такі дедуплікуються за іменем файлу");
}

/**
 * Один прохід звірки для одного воркспейсу. Повертає, скільки зустрічей додано.
 *
 * Детальний запис тягнемо ОКРЕМИМ запитом: список навмисно легкий (без транскрипта), інакше
 * сторінка на 50 зустрічей важила б десятки мегабайт.
 */
export async function pullOnce(cfg: PullCfg): Promise<{ added: number; seen: number; cursor: number }> {
  const auth = { url: cfg.meeting_pull_url, token: cfg.meeting_pull_token };
  const after = Number(cfg.meeting_pull_after || 0) || 0;
  const j = await api(auth, `/api/meetings?after_id=${after}&limit=${PAGE}`);
  const list: any[] = Array.isArray(j?.meetings) ? j.meetings : [];
  let added = 0;
  const done: number[] = [];
  for (const item of list) {
    const id = Number(item?.id);
    try {
      const full = await api(auth, `/api/meetings/${encodeURIComponent(String(item.id))}`);
      // деталь може приїхати як {meeting:{…}} або пласким обʼєктом - приймаємо обидва
      const rec = full?.meeting && typeof full.meeting === "object" ? full.meeting : full;
      const norm = normalizeMeeting(cloudRecordToBody({ ...item, ...rec }), sha);
      if ("ignore" in norm) { done.push(id); continue; }
      const r = await saveMeeting(norm, {
        insertSource: async (title, text, key, altKeys) => {
          const row = await one<{ id: string }>(
            `insert into source(workspace_id, origin, title, transcript, external_id)
             select $1,'meeting',$2,$3,$4
             where not exists (select 1 from source where workspace_id=$1 and external_id=any($5))
             returning id`, [cfg.workspace_id, title, text, key, altKeys]);
          return row?.id ?? null;
        },
        startRun: async (sourceId) => {
          const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [sourceId]);
          return run!.id;
        },
        log: (lvl, msg, meta) => logEvent(lvl, "meeting", `звірка: ${msg}`, meta as any),
        generate: cfg.meeting_auto !== false
          ? (runId) => { generatePostsOnePass(runId, 3).catch((e: any) => logEvent("error", "meeting", `звірка, авто-генерація: ${e.message}`, { runId })); }
          : undefined,
      });
      if (!r.duplicate) added++;
      done.push(id);
    } catch (e: any) {
      // Курсор усе одно посунеться (див. nextCursor): один биткий запис не має блокувати решту.
      await logEvent("warn", "meeting", `звірка: запис #${item?.id} не забрався - ${String(e.message).slice(0, 200)}`, null);
      done.push(id);
    }
  }
  const cursor = nextCursor(after, done);
  await q(`update transcription_config set meeting_pull_after=$2, meeting_pull_at=now() where workspace_id=$1`,
    [cfg.workspace_id, String(cursor)]);
  return { added, seen: list.length, cursor };
}

/** Воркер: раз на годину по всіх воркспейсах, де налаштована звірка. */
export function startMeetingPull(): void {
  const tick = async () => {
    const rows = await q<PullCfg>(
      `select workspace_id, meeting_pull_url, meeting_pull_token, meeting_pull_after, meeting_auto
         from transcription_config
        where coalesce(meeting_pull_url,'') <> '' and coalesce(meeting_pull_token,'') <> ''`).catch(() => []);
    for (const cfg of rows) {
      try {
        const r = await pullOnce(cfg);
        if (r.added) await logEvent("info", "meeting", `звірка: додано ${r.added} з ${r.seen} (курсор ${r.cursor})`, null);
      } catch (e: any) {
        await logEvent("warn", "meeting", `звірка не вдалась: ${String(e.message).slice(0, 200)}`, null);
      }
    }
  };
  setInterval(() => { tick().catch(() => {}); }, EVERY);
  setTimeout(() => { tick().catch(() => {}); }, 90_000);  // перший прохід невдовзі після старту
}
