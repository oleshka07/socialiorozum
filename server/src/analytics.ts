// 📈 Аналітика постів: з сирих публікацій і метрик - картина «що працює».
// Модуль ЧИСТИЙ (без БД і мережі): вхід - рядки публікацій з метриками й знімки підписників, вихід -
// усе, що малює екран Аналітики. Саме тут легко збрехати непомітно (поділити на нуль, змішати мережі
// різного масштабу, назвати висновком шум із двох постів), тож логіка покрита юнітами.
//
// Головні рішення:
//  • Порівнюємо пости НЕ голими переглядами, а множником до норми своєї мережі (медіана переглядів
//    мережі за обраний період): 800 переглядів у Facebook і 8 000 у Threads можуть бути однаково
//    «нормальним» постом. Лише так розрізи «що впливає» можна рахувати через усі мережі разом.
//  • У групі - МЕДІАНА множників, не середнє: один вірусний пост не робить формат «найкращим».
//  • Висновок пишемо лише коли обидві порівнювані групи мають щонайменше 3 пости і різниця ≥30%;
//    кількість постів завжди в тексті - людина бачить, на чому він тримається.
//  • З нормою порівнюємо лише «дозрілі» цифри: зняті щонайменше через MATURE_H год після публікації.
//    Пост, знятий через 20 хвилин, має 0 переглядів не тому, що він слабкий, а тому, що його ще не
//    бачили; без цього порогу найсвіжіший пост завжди виглядав би найгіршим і тягнув униз день і
//    годину, коли його опублікували.

export type PubRow = {
  post_id: string; net: string; created_at: string; permalink: string | null;
  text: string;               // текст, що пішов у ЦЮ мережу (своя версія або майстер-текст)
  format: string | null; rubric: string | null; intent: string | null; origin: string | null;
  media_kind: string;         // text | photo | carousel | video | story
  views: number | null; reach: number | null; likes: number | null; replies: number | null;
  reposts: number | null; quotes: number | null; shares: number | null; saves: number | null;
  follows?: number | null;    // Instagram: скільки людей підписалось після поста
  m_error: string | null;
  fetched_at: string | null;  // остання СПРОБА збору (її пише й невдала)
  measured_at?: string | null; // коли мережа востаннє справді віддала цифри
};
export type FollowerRow = { network: string; day: string; followers: number };
export type AnalyticsOpts = { days: number; net: string; tz: string; now?: number };

export const MEASURED_NETS = ["threads", "instagram", "facebook"];   // мережі, що віддають статистику постів
export const NET_LABEL: Record<string, string> = { threads: "Threads", instagram: "Instagram", facebook: "Facebook", telegram: "Telegram", linkedin: "LinkedIn" };
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const DAYPARTS = [
  { key: "morning", label: "Ранок 6-11", from: 6, to: 11 },
  { key: "day", label: "День 11-16", from: 11, to: 16 },
  { key: "evening", label: "Вечір 16-21", from: 16, to: 21 },
  { key: "night", label: "Ніч 21-6", from: 21, to: 30 },
];
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const MIN_GROUP = 3;      // стільки постів у групі, щоб її медіані можна було вірити
const MIN_INSIGHTS = 6;   // стільки постів зі статистикою, щоб узагалі говорити про висновки
// Основні перегляди пост набирає за перші 1-2 доби (Threads, Instagram і Facebook показують свіже
// передусім). Цифри, зняті раніше, - «ще набирає»: видно, але з нормою не порівнюємо.
export const MATURE_H = 48;

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
const postsWord = (n: number) => `${n} ${plural(n, "пост", "пости", "постів")}`;
const fmtNum = (n: number) => Math.round(n).toLocaleString("uk-UA");
// ×0.04 не округлюємо до «×0.0»: це не нуль, а пост, який побачили в 25 разів менше за звичайний
export const fmtMult = (m: number) => (m > 0 && m < 0.1 ? "×" + (Math.round(m * 100) / 100).toFixed(2) : "×" + (Math.round(m * 10) / 10).toFixed(1));

/** Через скільки годин після публікації знято цифри; null - момент невідомий (тоді не відсікаємо). */
export function snapAgeH(r: Pick<PubRow, "created_at" | "fetched_at" | "measured_at">): number | null {
  const at = r.measured_at || r.fetched_at;
  if (!at) return null;
  const h = (Date.parse(at) - Date.parse(r.created_at)) / 36e5;
  return Number.isFinite(h) ? Math.max(0, h) : null;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Сума взаємодій; null, якщо мережа не віддала жодної (а не 0 - «нуль» і «невідомо» різні речі). */
export function interactionsOf(r: Pick<PubRow, "likes" | "replies" | "reposts" | "quotes" | "shares" | "saves">): number | null {
  const parts = [r.likes, r.replies, r.reposts, r.quotes, r.shares, r.saves];
  if (parts.every((x) => x == null)) return null;
  return parts.reduce<number>((a, x) => a + (x || 0), 0);
}

// ---- час у поясі кабінету ----
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD_EN: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
export function localParts(iso: string | number, tz: string): { ymd: string; wd: number; hour: number } {
  const p: Record<string, string> = {};
  for (const x of fmtFor(tz).formatToParts(new Date(iso))) p[x.type] = x.value;
  return { ymd: `${p.year}-${p.month}-${p.day}`, wd: WD_EN[p.weekday] ?? 0, hour: Number(p.hour) % 24 };
}
const addDays = (ymd: string, n: number): string => {
  const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const weekdayOf = (ymd: string): number => (new Date(ymd + "T12:00:00Z").getUTCDay() + 6) % 7;
const mondayOf = (ymd: string): string => addDays(ymd, -weekdayOf(ymd));
export function daypartOf(hour: number): number {
  return DAYPARTS.findIndex((d) => (hour >= d.from && hour < d.to) || (hour + 24 >= d.from && hour + 24 < d.to));
}

// ---- розрізи ----
export function lengthGroup(len: number): { key: string; label: string } {
  if (len < 280) return { key: "short", label: "Короткий (до 280)" };
  if (len <= 800) return { key: "medium", label: "Середній (280-800)" };
  return { key: "long", label: "Довгий (800+)" };
}
export function hookGroup(text: string): { key: string; label: string } {
  const first = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  if (/\?\s*[)»"”]*\s*$/.test(first) || /^[^.!]{0,140}\?/.test(first)) return { key: "question", label: "Питання" };
  if (/\d/.test(first)) return { key: "number", label: "З цифрою" };
  return { key: "statement", label: "Твердження" };
}
const MEDIA_LABEL: Record<string, string> = { text: "Лише текст", photo: "Фото", carousel: "Карусель", video: "Відео", story: "Сторіс" };
const INTENT_LABEL: Record<string, string> = { awareness: "Знайомство", nurture: "Прогрів", sale: "Продаж" };
export function originGroup(origin: string | null): { key: string; label: string } {
  const o = String(origin || "");
  if (["diary", "bot", "meeting", "fireflies", "grain", "meetgeek", "manual", "upload"].includes(o)) return { key: "own", label: "Твої слова (щоденник, бот, зустрічі)" };
  if (o === "mcp") return { key: "mcp", label: "Написано з Claude" };
  if (["rss", "gdrive"].includes(o)) return { key: "feeds", label: "Зі стрічок і новин" };
  if (["topic", "plan", "takes", "idea", "brand", "api"].includes(o)) return { key: "generated", label: "Згенеровано з теми чи плану" };
  return { key: "other", label: "Інше" };
}

type Enriched = PubRow & { interactions: number | null; er: number | null; mult: number | null; young: boolean; snapH: number | null; lp: { ymd: string; wd: number; hour: number } };
export type Group = { key: string; label: string; n: number; median: number; thin: boolean };
export type Driver = { key: string; title: string; hint: string; groups: Group[] };

function groupBy(rows: Enriched[], keyOf: (r: Enriched) => { key: string; label: string } | null, order?: string[]): Group[] {
  const m = new Map<string, { label: string; mults: number[] }>();
  for (const r of rows) {
    if (r.mult == null) continue;
    const k = keyOf(r);
    if (!k) continue;
    if (!m.has(k.key)) m.set(k.key, { label: k.label, mults: [] });
    m.get(k.key)!.mults.push(r.mult);
  }
  const groups = [...m.entries()].map(([key, g]) => ({ key, label: g.label, n: g.mults.length, median: Math.round(median(g.mults) * 100) / 100, thin: g.mults.length < MIN_GROUP }));
  if (order) return groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return groups.sort((a, b) => b.n - a.n);
}

// рубрик буває багато: найчастіші 6, решта - «Інші рубрики»
function rubricKey(rows: Enriched[]): (r: Enriched) => { key: string; label: string } | null {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.mult != null && r.rubric) counts.set(r.rubric, (counts.get(r.rubric) || 0) + 1);
  const top = new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k));
  return (r) => (!r.rubric ? null : top.has(r.rubric) ? { key: r.rubric, label: r.rubric } : { key: "__other", label: "Інші рубрики" });
}

export function buildDrivers(rows: Enriched[]): Driver[] {
  const drivers: Driver[] = [
    { key: "media", title: "Що в пості", hint: "текст, фото, карусель чи відео", groups: groupBy(rows, (r) => ({ key: r.media_kind, label: MEDIA_LABEL[r.media_kind] || r.media_kind }), ["text", "photo", "carousel", "video", "story"]) },
    { key: "hook", title: "Перший рядок", hint: "з чого пост починається", groups: groupBy(rows, (r) => hookGroup(r.text), ["question", "number", "statement"]) },
    { key: "length", title: "Довжина тексту", hint: "у знаках, для тієї мережі, куди він пішов", groups: groupBy(rows, (r) => lengthGroup((r.text || "").length), ["short", "medium", "long"]) },
    { key: "daypart", title: "Час доби", hint: "за часовим поясом кабінету", groups: groupBy(rows, (r) => { const i = daypartOf(r.lp.hour); return { key: DAYPARTS[i].key, label: DAYPARTS[i].label }; }, DAYPARTS.map((d) => d.key)) },
    { key: "weekday", title: "День тижня", hint: "коли пост вийшов", groups: groupBy(rows, (r) => ({ key: String(r.lp.wd), label: WD[r.lp.wd] }), ["0", "1", "2", "3", "4", "5", "6"]) },
    { key: "rubric", title: "Рубрика", hint: "зі стратегії", groups: groupBy(rows, rubricKey(rows)) },
    { key: "intent", title: "Намір", hint: "знайомство, прогрів чи продаж", groups: groupBy(rows, (r) => (r.intent && INTENT_LABEL[r.intent] ? { key: r.intent, label: INTENT_LABEL[r.intent] } : null), ["awareness", "nurture", "sale"]) },
    { key: "origin", title: "Звідки текст", hint: "з чого його зроблено", groups: groupBy(rows, (r) => originGroup(r.origin), ["own", "mcp", "feeds", "generated", "other"]) },
  ];
  // розріз, де всі пости в одній групі, нічого не порівнює - не показуємо
  return drivers.filter((d) => d.groups.length >= 2);
}

export function buildHeat(rows: Enriched[]): { rows: string[]; cols: string[]; cells: { r: number; c: number; n: number; median: number }[] } {
  const cells: { r: number; c: number; n: number; median: number }[] = [];
  for (let r = 0; r < 7; r++) for (let c = 0; c < DAYPARTS.length; c++) {
    const ms = rows.filter((x) => x.mult != null && x.lp.wd === r && daypartOf(x.lp.hour) === c).map((x) => x.mult as number);
    if (ms.length) cells.push({ r, c, n: ms.length, median: Math.round(median(ms) * 100) / 100 });
  }
  return { rows: WD, cols: DAYPARTS.map((d) => d.label), cells };
}

// ---- висновки ----
const INSIGHT_TITLE: Record<string, string> = {
  media: "Тип поста", hook: "Перший рядок", length: "Довжина", daypart: "Час публікації", weekday: "День тижня",
  rubric: "Рубрики", intent: "Намір", origin: "Звідки текст",
};
export type Insight = { text: string; tone: "good" | "bad" | "info"; key?: string };

export function driverInsight(d: Driver): { ratio: number; insight: Insight } | null {
  const ok = d.groups.filter((g) => g.n >= MIN_GROUP);
  if (ok.length < 2) return null;
  const best = ok.reduce((a, b) => (b.median > a.median ? b : a));
  const worst = ok.reduce((a, b) => (b.median < a.median ? b : a));
  if (best === worst || best.median <= 0) return null;
  const ratio = best.median / Math.max(worst.median, 0.05);
  if (ratio < 1.3) return null;
  return {
    ratio,
    insight: {
      key: d.key, tone: "good",
      text: `${INSIGHT_TITLE[d.key] || d.title}: найкраще «${best.label}» - ${fmtMult(best.median)} від твоєї норми (${postsWord(best.n)}), найслабше «${worst.label}» - ${fmtMult(worst.median)} (${postsWord(worst.n)}).`,
    },
  };
}

export function buildInsights(measured: Enriched[], drivers: Driver[], kpi: Kpi, days: number): Insight[] {
  const out: Insight[] = [];
  if (kpi.viewsPrev > 0 && kpi.measuredPrev >= 3 && kpi.measured >= 3) {
    const pct = Math.round(((kpi.views - kpi.viewsPrev) / kpi.viewsPrev) * 100);
    if (Math.abs(pct) >= 10) out.push({
      key: "trend", tone: pct > 0 ? "good" : "bad",
      text: `Перегляди за ці ${days} днів ${pct > 0 ? "+" : ""}${pct}% до попередніх ${days} (${fmtNum(kpi.views)} проти ${fmtNum(kpi.viewsPrev)}) при ${postsWord(kpi.posts)} проти ${kpi.postsPrev}.`,
    });
  }
  const withMult = measured.filter((r) => r.mult != null);
  if (withMult.length < MIN_INSIGHTS) {
    const fresh = measured.filter((r) => r.young).length;
    const noNorm = measured.filter((r) => r.views != null && !r.young && r.mult == null).length;
    out.push({
      key: "few", tone: "info",
      text: `Для висновків «що працює» потрібно хоча б ${MIN_INSIGHTS} постів, які вже можна порівняти з нормою своєї мережі (Threads, Instagram чи Facebook: від 3 постів на мережу, кожному щонайменше 2 доби). Зараз таких ${withMult.length}` +
        (fresh ? `; ще ${fresh} ${plural(fresh, "свіжий пост набирає", "свіжі пости набирають", "свіжих постів набирають")} перегляди` : "") +
        (noNorm ? `; ще ${postsWord(noNorm)} - у мережі, де поки менше 3 постів, тож її норми нема` : "") +
        ". Статистика збирається сама: свіжі пости - кожні 6 годин, далі раз на добу.",
    });
    return out;
  }
  const ranked = drivers.map(driverInsight).filter(Boolean) as { ratio: number; insight: Insight }[];
  ranked.sort((a, b) => b.ratio - a.ratio);
  for (const x of ranked.slice(0, 3)) out.push(x.insight);
  const top = withMult.reduce((a, b) => ((b.mult as number) > (a.mult as number) ? b : a));
  if ((top.mult as number) >= 1.5) {
    const title = (top.text || "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 70) || "без тексту";
    out.push({ key: "top", tone: "good", text: `Найсильніший пост періоду - «${title}» (${NET_LABEL[top.net] || top.net}, ${fmtMult(top.mult as number)} від норми, ${fmtNum(top.views || 0)} переглядів).` });
  }
  if (!ranked.length) out.push({ key: "flat", tone: "info", text: "Помітної різниці між типами постів, часом і довжиною поки нема: групи замалі або результати близькі. Варто пробувати різне - так зʼявиться що порівнювати." });
  return out;
}

// ---- головна збірка ----
export type Kpi = {
  posts: number; postsPrev: number; sends: number; sendsByNet: Record<string, number>;
  views: number; viewsPrev: number; interactions: number; interactionsPrev: number;
  er: number | null; erPrev: number | null; measured: number; measuredPrev: number;
};

function kpiOf(cur: PubRow[], prev: PubRow[]): Kpi {
  const agg = (rows: PubRow[]) => {
    let views = 0, inter = 0, erViews = 0, erInter = 0, measured = 0;
    for (const r of rows) {
      const i = interactionsOf(r);
      if (r.views != null) { views += r.views; measured++; }
      if (i != null) inter += i;
      if (r.views != null && r.views > 0 && i != null) { erViews += r.views; erInter += i; }
    }
    return { views, inter, er: erViews > 0 ? erInter / erViews : null, measured };
  };
  const a = agg(cur), b = agg(prev);
  const sendsByNet: Record<string, number> = {};
  for (const r of cur) sendsByNet[r.net] = (sendsByNet[r.net] || 0) + 1;
  return {
    posts: new Set(cur.map((r) => r.post_id)).size, postsPrev: new Set(prev.map((r) => r.post_id)).size,
    sends: cur.length, sendsByNet,
    views: a.views, viewsPrev: b.views, interactions: a.inter, interactionsPrev: b.inter,
    er: a.er, erPrev: b.er, measured: a.measured, measuredPrev: b.measured,
  };
}

export function buildSeries(cur: Enriched[], days: number, fromYmd: string, toYmd: string): { unit: "week" | "month"; buckets: { key: string; label: string; posts: number; views: Record<string, number>; interactions: Record<string, number> }[]; nets: string[] } {
  const unit: "week" | "month" = days > 92 ? "month" : "week";
  const keyOf = (ymd: string) => (unit === "week" ? mondayOf(ymd) : ymd.slice(0, 7));
  const labelOf = (key: string) => unit === "week" ? `${key.slice(8, 10)}.${key.slice(5, 7)}` : `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
  const keys: string[] = [];
  for (let d = fromYmd; d <= toYmd; d = addDays(d, 1)) { const k = keyOf(d); if (keys[keys.length - 1] !== k) keys.push(k); }
  const map = new Map(keys.map((k) => [k, { key: k, label: labelOf(k), posts: new Set<string>(), views: {} as Record<string, number>, interactions: {} as Record<string, number> }]));
  const nets = new Set<string>();
  for (const r of cur) {
    const b = map.get(keyOf(r.lp.ymd));
    if (!b) continue;
    b.posts.add(r.post_id);
    if (r.views != null) { b.views[r.net] = (b.views[r.net] || 0) + r.views; nets.add(r.net); }
    if (r.interactions != null) b.interactions[r.net] = (b.interactions[r.net] || 0) + r.interactions;
  }
  return {
    unit,
    buckets: [...map.values()].map((b) => ({ key: b.key, label: b.label, posts: b.posts.size, views: b.views, interactions: b.interactions })),
    nets: MEASURED_NETS.filter((n) => nets.has(n)),
  };
}

export function buildFollowers(rows: FollowerRow[], fromYmd: string): Record<string, { points: { day: string; n: number }[]; now: number | null; delta: number | null; since: string | null }> {
  const out: Record<string, { points: { day: string; n: number }[]; now: number | null; delta: number | null; since: string | null }> = {};
  const byNet = new Map<string, FollowerRow[]>();
  for (const r of rows) { if (!byNet.has(r.network)) byNet.set(r.network, []); byNet.get(r.network)!.push(r); }
  for (const [net, list] of byNet) {
    list.sort((a, b) => a.day.localeCompare(b.day));
    const inPeriod = list.filter((x) => x.day >= fromYmd);
    const before = list.filter((x) => x.day < fromYmd).pop();
    const base = before || inPeriod[0];
    const last = list[list.length - 1];
    out[net] = {
      points: inPeriod.map((x) => ({ day: x.day, n: x.followers })),
      now: last ? last.followers : null,
      // дельта лише коли є з чим порівняти: один знімок - це стан, а не зміна
      delta: base && last && base !== last ? last.followers - base.followers : null,
      since: base && base !== last ? base.day : null,
    };
  }
  return out;
}

export function buildAnalytics(all: PubRow[], followers: FollowerRow[], o: AnalyticsOpts) {
  const now = o.now ?? Date.now();
  const days = Math.max(1, Math.min(730, Math.round(o.days)));
  const curFrom = now - days * 864e5, prevFrom = now - 2 * days * 864e5;
  const netOk = (r: PubRow) => o.net === "all" || r.net === o.net;
  const inCur = (r: PubRow) => { const t = Date.parse(r.created_at); return t >= curFrom && t <= now; };
  const inPrev = (r: PubRow) => { const t = Date.parse(r.created_at); return t >= prevFrom && t < curFrom; };
  // драйвер БД віддає час обʼєктом Date - зводимо до ISO, щоб порівняння й JSON були однозначні
  const iso = (x: unknown): string => new Date(x as any).toISOString();
  const rows = all.filter(netOk).map((r) => ({
    ...r, created_at: iso(r.created_at), fetched_at: r.fetched_at ? iso(r.fetched_at) : null,
    measured_at: r.measured_at ? iso(r.measured_at) : null,
  }));
  const cur = rows.filter(inCur), prev = rows.filter(inPrev);
  // «ще набирає»: цифри є, але зняті раніше, ніж пост устиг їх набрати
  const isYoung = (r: PubRow) => { if (r.views == null) return false; const h = snapAgeH(r); return h != null && h < MATURE_H; };

  // норма кожної мережі - медіана «дозрілих» переглядів у цьому ж зрізі (від 3 постів)
  const norms: Record<string, { median: number; n: number }> = {};
  for (const net of MEASURED_NETS) {
    const v = cur.filter((r) => r.net === net && r.views != null && !isYoung(r)).map((r) => r.views as number);
    if (v.length >= MIN_GROUP) norms[net] = { median: Math.max(1, median(v)), n: v.length };
  }
  const enriched: Enriched[] = cur.map((r) => {
    const interactions = interactionsOf(r);
    const norm = norms[r.net];
    const young = isYoung(r);
    return {
      ...r, interactions, young, snapH: r.views == null ? null : snapAgeH(r),
      er: r.views != null && r.views > 0 && interactions != null ? interactions / r.views : null,
      // множник лише для дозрілих: свіжий пост ще не має з чим чесно порівнюватись
      mult: norm && r.views != null && !young ? Math.round((r.views / norm.median) * 100) / 100 : null,
      lp: localParts(r.created_at, o.tz),
    };
  });
  const measured = enriched.filter((r) => MEASURED_NETS.includes(r.net) && r.media_kind !== "story");
  const kpi = kpiOf(cur, prev);
  const drivers = buildDrivers(measured);
  const toYmd = localParts(now, o.tz).ymd;
  const fromYmd = localParts(curFrom, o.tz).ymd;

  const coverage: Record<string, { published: number; measured: number; partial: number; error: string | null; lastFetch: string | null; perPost: boolean }> = {};
  for (const r of enriched) {
    const c = coverage[r.net] || (coverage[r.net] = { published: 0, measured: 0, partial: 0, error: null, lastFetch: null, perPost: MEASURED_NETS.includes(r.net) });
    c.published++;
    if (r.views != null) c.measured++;
    else if (r.m_error) { c.partial++; c.error = c.error || r.m_error; }
    if (r.fetched_at && (!c.lastFetch || r.fetched_at > c.lastFetch)) c.lastFetch = r.fetched_at;
  }

  return {
    days, net: o.net, tz: o.tz, from: fromYmd, to: toYmd,
    kpi, norms, coverage,
    series: buildSeries(enriched.filter((r) => MEASURED_NETS.includes(r.net)), days, fromYmd, toYmd),
    followers: buildFollowers(o.net === "all" ? followers : followers.filter((f) => f.network === o.net), fromYmd),
    drivers,
    heat: buildHeat(measured),
    insights: buildInsights(measured, drivers, kpi, days),
    posts: enriched.map((r) => ({
      post_id: r.post_id, net: r.net, created_at: r.created_at, permalink: r.permalink,
      title: (r.text || "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 110) || "",
      media: r.media_kind, format: r.format, rubric: r.rubric,
      views: r.views, reach: r.reach, likes: r.likes, replies: r.replies,
      shares: r.shares == null && r.reposts == null && r.quotes == null ? null : (r.shares || 0) + (r.reposts || 0) + (r.quotes || 0),
      saves: r.saves, follows: r.follows ?? null, interactions: r.interactions,
      er: r.er == null ? null : Math.round(r.er * 10000) / 10000, mult: r.mult, error: r.views == null ? r.m_error : null,
      young: r.young, snap_h: r.snapH == null ? null : Math.round(r.snapH * 10) / 10,
    })),
  };
}
export type AnalyticsResult = ReturnType<typeof buildAnalytics>;
