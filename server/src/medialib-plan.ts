// 🖼 Медіатека як окрема сторінка - ЧИСТІ правила (без БД): у якому стані файл, куди він уже вийшов
// і коли його можна відкласти в архів. Архів - лише позначка «не показувати в списку»: файл, пости,
// публікації й статистика лишаються як були (див. medialib.ts).

// мережі, у які публікує Holos (порядок - як у кабінеті)
export const LIB_NETS = ["telegram", "threads", "instagram", "facebook", "linkedin", "youtube", "tiktok", "whatsapp"] as const;

/** Один пост, у якому стоїть файл (напряму, кадром каруселі, кропом під формат чи всередині змонтованого відео). */
export type PostUse = {
  id: string;
  review: string | null;        // archived - пост відкладено, і він ніде не вийшов: не рахується
  sent: string[];               // мережі, куди пост уже вийшов
  lastPub: string | null;       // остання публікація (ISO)
  nextAt: string | null;        // найближчий слот у розкладі (ISO), null - не запланований
  nets: string[];               // мережі, обрані в пості
};

/** free - ніде; montage - лише в змонтованому відео, яке ще ні в якому пості; draft - лише в чернетках;
 *  planned - стоїть у розкладі; published - вже вийшов, але ще є в чернетці; done - відпрацьоване: усі пости
 *  з ним уже вийшли і з ним більше нічого не заплановано. */
export type MediaState = "free" | "montage" | "draft" | "planned" | "published" | "done";

export type Usage = {
  state: MediaState;
  posts: string[];              // пости, що рахуються (без відкладених невиданих)
  sent: string[];               // мережі, куди файл уже вийшов (у порядку LIB_NETS)
  lastPub: string | null;
  nextAt: string | null;
  waiting: string[];            // мережі запланованих постів, куди ще не вийшло
};

const order = (nets: Iterable<string>): string[] => {
  const s = new Set(nets);
  return [...LIB_NETS.filter((n) => s.has(n)), ...[...s].filter((n) => !(LIB_NETS as readonly string[]).includes(n)).sort()];
};
const maxIso = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : (Date.parse(a) >= Date.parse(b) ? a : b));
const minIso = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : (Date.parse(a) <= Date.parse(b) ? a : b));

export function mediaUsage(posts: PostUse[], inMontage = false): Usage {
  // пост, який відклали (review = archived) і який ніде не вийшов, - вже не «робота з файлом»
  const live = posts.filter((p) => p.sent.length || p.nextAt || p.review !== "archived");
  let lastPub: string | null = null, nextAt: string | null = null;
  const sent = new Set<string>(), waiting = new Set<string>();
  let anyPub = false, anyPlanned = false, anyDraft = false;
  for (const p of live) {
    if (p.sent.length) { anyPub = true; p.sent.forEach((n) => sent.add(n)); lastPub = maxIso(lastPub, p.lastPub); }
    if (p.nextAt) {
      anyPlanned = true; nextAt = minIso(nextAt, p.nextAt);
      p.nets.filter((n) => !p.sent.includes(n)).forEach((n) => waiting.add(n));
    } else if (!p.sent.length) anyDraft = true;
  }
  const state: MediaState = anyPlanned ? "planned"
    : anyPub ? (anyDraft ? "published" : "done")
    : anyDraft ? "draft"
    : inMontage ? "montage" : "free";
  return { state, posts: live.map((p) => p.id), sent: order(sent), lastPub, nextAt, waiting: order(waiting) };
}

// скільки днів після останньої публікації відпрацьоване йде в архів (0 - не відкладати)
export const ARCHIVE_DAYS = [0, 10, 15, 30, 60] as const;
export const DEFAULT_ARCHIVE_DAYS = 30;
export function normArchiveDays(v: unknown): number {
  if (v === null || v === undefined || v === "") return DEFAULT_ARCHIVE_DAYS;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // найближче з дозволених (12 → 10, 20 → 15, 45 → 30): у людини лише кілька кнопок
  return ARCHIVE_DAYS.filter((d) => d > 0).reduce((best, d) => (Math.abs(d - n) < Math.abs(best - n) ? d : best), 30);
}

/** Коли файл піде в архів сам (ISO) - null, якщо не піде: не відпрацьоване, автоархів вимкнено чи людина
 *  повернула файл з архіву руками («не ховати»). */
export function archiveDueAt(u: Pick<Usage, "state" | "lastPub">, days: number, keep = false): string | null {
  if (keep || !days || u.state !== "done" || !u.lastPub) return null;
  const t = Date.parse(u.lastPub);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 86400000).toISOString();
}

/** Що зробити з файлом зараз: заархівувати, повернути з автоархіву (знову потрібен), чи нічого. */
export function archiveAction(
  m: { archived_at: string | null; archived_by: string | null; archive_keep: boolean },
  u: Pick<Usage, "state" | "lastPub">, days: number, now = Date.now(),
): "archive" | "restore" | null {
  if (m.archived_at) {
    // сам відклав - сам і повертає, щойно файл знову в роботі (новий пост, повтор хіта, розклад).
    // Відкладене людиною руками лишається, доки вона його не поверне
    return m.archived_by === "auto" && ["draft", "planned", "published"].includes(u.state) ? "restore" : null;
  }
  const due = archiveDueAt(u, days, m.archive_keep);
  return due && Date.parse(due) <= now ? "archive" : null;
}

// назва файлу: те, що людина (чи Claude) дала сама; порожнє - прибрати назву
export const cleanTitle = (v: unknown): string =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
