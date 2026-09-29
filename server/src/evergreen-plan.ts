// ♻️ Вічнозелена черга - ЧИСТА частина (без БД): налаштування, які пости повторювати, куди й коли.
// Сама черга (бібліотека, повтори, воркер) - evergreen.ts.
//
// Головні рішення:
//  • Повтор - це НОВИЙ пост (копія зі свіжим першим рядком), а не повторна публікація старого: у
//    мережі він окремий, зі своїм посиланням і статистикою, а в кабінеті видно, чий він повтор.
//  • Повтор ставиться в календар щонайменше за добу: людина бачить його в «Сьогодні» й календарі
//    і може скасувати чи поправити, перш ніж він вийде.
//  • Тижневий ліміт рахує СТВОРЕНІ повтори (і скасовані теж): скасування не означає «постав інший
//    просто зараз».
//  • Той самий пост - не частіше ніж раз на gapWeeks тижнів і не більше maxRepeats разів.
import { zonedToUtc } from "./tgcompose.js";

export type EgSettings = {
  on: boolean;         // черга працює (типово - ні: людина вмикає сама)
  perWeek: number;     // скільки повторів на тиждень (1-7)
  gapWeeks: number;    // той самий пост - не частіше ніж раз на N тижнів (2-26)
  maxRepeats: number;  // скільки разів повторювати один пост (1-10)
  fresh: boolean;      // свіжий перший рядок (AI, копійки) і перевірка «чи не прив'язаний до дати»
  autoAdd: boolean;    // хіти (×minMult від норми) додаються в чергу самі
  minMult: number;     // поріг хіта (1.2-5)
};
export const EG_DEFAULTS: EgSettings = { on: false, perWeek: 2, gapWeeks: 6, maxRepeats: 3, fresh: true, autoAdd: true, minMult: 1.5 };

export function normEg(raw: unknown): EgSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  return {
    on: r.on === true,
    perWeek: Math.round(num(r.perWeek, EG_DEFAULTS.perWeek, 1, 7)),
    gapWeeks: Math.round(num(r.gapWeeks, EG_DEFAULTS.gapWeeks, 2, 26)),
    maxRepeats: Math.round(num(r.maxRepeats, EG_DEFAULTS.maxRepeats, 1, 10)),
    fresh: r.fresh !== false,
    autoAdd: r.autoAdd !== false,
    minMult: Math.round(num(r.minMult, EG_DEFAULTS.minMult, 1.2, 5) * 10) / 10,
  };
}

// Прив'язка до дати чи події: без AI (fresh вимкнено) такий пост не повторюємо, з AI - це підказка моделі.
const MONTHS_UK = "січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня";
const MONTHS_CS = "ledna|února|března|dubna|května|června|července|srpna|září|října|listopadu|prosince";
const DATE_RX: RegExp[] = [
  /(?<![\d.])(0?[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])(?:\.(?:20)?\d{2})?(?![\d])/u,                  // 28.09, 01.10.2026
  new RegExp(`(?<![\\p{L}\\d])(0?[1-9]|[12]\\d|3[01])\\.?\\s+(${MONTHS_UK}|${MONTHS_CS})(?!\\p{L})`, "iu"), // 28 вересня, 28. září
  /(?<![\p{L}])(сьогодні|завтра|вчора|позавчора|післязавтра|цього тижня|наступного тижня|цими вихідними|до кінця (?:тижня|місяця|року)|тільки до|лише до|акція діє)(?!\p{L})/iu,
  /(?<![\p{L}])(today|tomorrow|yesterday|this week|next week|this weekend|only until|dnes|zítra|včera|tento týden|příští týden|pouze do|jen do)(?!\p{L})/iu,
];
export function dateBound(text: string): string | null {
  const t = String(text || "");
  for (const rx of DATE_RX) { const m = t.match(rx); if (m) return m[0].trim(); }
  return null;
}

/** Куди повторювати: мережі, куди пост справді вийшов і які досі підключені. Пост, доданий хітом
 *  (не людиною), не повторюємо там, де він помітно не зайшов (×<0.8 від норми). */
export function repeatNets(o: { sent: string[]; mults: Record<string, number | null | undefined>; manual: boolean; connected: string[] }): string[] {
  const out: string[] = [];
  for (const n of o.sent) {
    if (out.includes(n) || !o.connected.includes(n)) continue;
    const m = o.mults[n];
    if (!o.manual && m != null && m < 0.8) continue;
    out.push(n);
  }
  return out;
}

export type EgCandidate = { postId: string; status: string; bestMult: number | null; firstSentAt: number | null; lastAt: number | null; repeats: number };
/** Коли пост можна повторити знову: через gapWeeks після першої публікації й після останнього повтору. */
export function nextEligible(c: Pick<EgCandidate, "firstSentAt" | "lastAt">, gapWeeks: number): number | null {
  if (c.firstSentAt == null) return null;
  return Math.max(c.firstSentAt, c.lastAt ?? 0) + gapWeeks * 7 * 864e5;
}
/** Хто йде в повтор: активні, з ліміту повторів, чий час уже настав; спершу найсильніші хіти, далі -
 *  ті, що довше чекали. */
export function rankCandidates(list: EgCandidate[], s: EgSettings, now: number): EgCandidate[] {
  return list
    .filter((c) => c.status === "active" && c.repeats < s.maxRepeats && (nextEligible(c, s.gapWeeks) ?? Infinity) <= now)
    .sort((a, b) => (b.bestMult ?? -1) - (a.bestMult ?? -1) || (a.lastAt ?? 0) - (b.lastAt ?? 0) || (a.firstSentAt ?? 0) - (b.firstSentAt ?? 0));
}

/** Хіти для автододавання: найкраща «×норма» поста (серед мереж) ≥ minMult; без сторіс і без
 *  самих повторів (повтор - не новий хіт, а той самий пост). */
export function hitsFrom(posts: { post_id: string; mult: number | null; media?: string | null }[], minMult: number, skip: Set<string>): Map<string, number> {
  const best = new Map<string, number>();
  for (const p of posts) {
    if (p.mult == null || p.media === "story" || skip.has(p.post_id)) continue;
    if (p.mult > (best.get(p.post_id) ?? -1)) best.set(p.post_id, p.mult);
  }
  for (const [id, m] of best) if (m < minMult) best.delete(id);
  return best;
}

export type EgPlanned = { at: number; nets: string[]; repeat: boolean };
/**
 * Коли поставити повтор: не раніше ніж за leadH годин (людина має побачити й за потреби скасувати),
 * у межах horizonDays днів, у дозволені дні тижня й години. Спершу день, де ці мережі ще нічого не
 * публікують і нема іншого повтору; далі - день без іншого повтору; далі - будь-який. Той самий час
 * ±5 хв у ту саму мережу - ніколи.
 */
// soonest - «♻️ Зараз»: людина сама просить повтор якнайшвидше, тож найближчий вільний час (без збігу ±5 хв
// у тій самій мережі), а не «день без інших постів і повторів» - інакше «зараз» з'їжджало на 2-3 дні
export function pickRepeatTime(o: { now: number; tz: string; leadH: number; horizonDays: number; dows: number[] | null; times: string[]; nets: string[]; planned: EgPlanned[]; soonest?: boolean }): { at: Date; day: string; time: string } | null {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: o.tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayOf = (ms: number) => fmt.format(new Date(ms));
  const byDay = new Map<string, { nets: Set<string>; repeat: boolean }>();
  for (const p of o.planned) {
    const d = dayOf(p.at);
    const x = byDay.get(d) || { nets: new Set<string>(), repeat: false };
    p.nets.forEach((n) => x.nets.add(n));
    if (p.repeat) x.repeat = true;
    byDay.set(d, x);
  }
  const times = [...new Set(o.times.filter((t) => /^\d{1,2}:\d{2}$/.test(t)).map((t) => t.padStart(5, "0")))];
  if (!times.length) times.push("11:00");
  const clash = (at: number) => o.planned.some((p) => Math.abs(p.at - at) <= 5 * 60e3 && p.nets.some((n) => o.nets.includes(n)));
  const [Y, M, D] = dayOf(o.now).split("-").map(Number);
  for (const pass of o.soonest ? [3] : [1, 2, 3]) {
    for (let d = 0; d <= o.horizonDays; d++) {
      const noon = new Date(Date.UTC(Y, M - 1, D + d, 12));
      const day = noon.toISOString().slice(0, 10);
      if (o.dows && o.dows.length && !o.dows.includes(noon.getUTCDay())) continue;
      const info = byDay.get(day);
      if (pass === 1 && info && (info.repeat || o.nets.some((n) => info.nets.has(n)))) continue;
      if (pass === 2 && info && info.repeat) continue;
      for (const t of times) {
        const [h, m] = t.split(":").map(Number);
        const at = zonedToUtc(noon.getUTCFullYear(), noon.getUTCMonth() + 1, noon.getUTCDate(), h, m, o.tz);
        if (at.getTime() < o.now + o.leadH * 3600e3 || clash(at.getTime())) continue;
        return { at, day, time: t };
      }
    }
  }
  return null;
}
