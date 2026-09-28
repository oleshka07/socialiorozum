// ⏰ Найкращий час публікації - з ВЛАСНИХ даних (п.5 дорожньої карти, 28.09).
// Модуль ЧИСТИЙ (без БД): вхід - пости з «×норми» (buildAnalytics().posts) і пояс кабінету, вихід - для
// кожної мережі (і кожного акаунта, коли їх у мережі кілька) вікна доби, у які пости набирають більше,
// і конкретний час, який ставить календар.
//
// Головні рішення:
//  • Порівнюємо «×норму» (перегляди поста до медіани свого акаунта), а не голі перегляди: тоді пости
//    різних акаунтів і періодів можна складати разом.
//  • Лише «дозрілі» пости (множник рахується після 48 год): свіжий пост ще не набрав переглядів, і
//    вечір, коли його опублікували, виглядав би гіршим, ніж є.
//  • Обережна оцінка вікна: медіана тягнеться до норми (×1.0), наче у вікні є ще BT_PRIOR звичайних
//    постів. Вікно з двома вдалими постами не стає «найкращим» - потрібна повторюваність.
//  • Радимо, лише коли є з чим порівнювати: ≥10 дозрілих постів і щонайменше два вікна по ≥3 пости.
//    Якщо людина завжди постить о 9:00, чесна відповідь - «спробуй інший час», а не «9:00 найкраще».
//  • Час для календаря - медіана фактичного часу вдалих постів у вікні (округлено до 15 хв): «коли ти
//    вже постив і це спрацювало», а не середина вікна.

export const BT_WINDOWS = [
  { key: "w0", from: 0, to: 6, label: "0-6" },
  { key: "w6", from: 6, to: 9, label: "6-9" },
  { key: "w9", from: 9, to: 12, label: "9-12" },
  { key: "w12", from: 12, to: 15, label: "12-15" },
  { key: "w15", from: 15, to: 18, label: "15-18" },
  { key: "w18", from: 18, to: 21, label: "18-21" },
  { key: "w21", from: 21, to: 24, label: "21-24" },
];
export const BT_MIN_POSTS = 10;   // дозрілих постів мережі (акаунта), щоб узагалі радити
export const BT_MIN_WINDOW = 3;   // постів у вікні, щоб йому вірити
export const BT_PRIOR = 3;        // обережність оцінки: «ще 3 звичайні пости» у кожному вікні
export const BT_LIFT = 1.1;       // радимо вікно, лише коли обережна оцінка ≥ ×1.1
export const BT_DAYS = 180;       // за скільки днів беремо пости

export type BtPost = { net: string; account?: string | null; account_name?: string | null; created_at: string; mult: number | null; media?: string | null };
export type BtWindow = { key: string; label: string; n: number; median: number; score: number; time: string };
export type BestTime = {
  key: string;                 // "threads" (мережа разом) або "threads:<акаунт>"
  net: string; account: string | null; accountName: string | null;
  n: number;                   // дозрілих постів із множником
  ready: boolean;              // даних досить, щоб порівнювати вікна
  best: BtWindow[];            // до двох вікон, найкраще першим
  worst: BtWindow | null;
  times: string[];             // «HH:MM» для календаря; порожньо - календар бере час зі стратегії
  text: string;                // людською, для кабінету й конектора
  show: boolean;               // чи показувати рядок людині (дубль мережі чи акаунт без поради - ні)
};

const NET_UA: Record<string, string> = { threads: "Threads", instagram: "Instagram", facebook: "Facebook" };
const BT_NETS = ["threads", "instagram", "facebook"];

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
const postsWord = (n: number) => `${n} ${plural(n, "пост", "пости", "постів")}`;
const fmtX = (m: number) => "×" + (Math.round(m * 10) / 10).toFixed(1);
export const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Хвилина доби (0..1439) у поясі кабінету. */
export function localMinute(iso: string, tz: string): number {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); fmtCache.set(tz, f); }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(iso))) p[x.type] = x.value;
  return (Number(p.hour) % 24) * 60 + Number(p.minute || 0);
}
export const windowOf = (minute: number) => BT_WINDOWS.find((w) => minute >= w.from * 60 && minute < w.to * 60) || BT_WINDOWS[0];

/** Обережна оцінка вікна: медіана, стягнута до норми ×1.0 так, наче у вікні ще BT_PRIOR звичайних постів. */
export const shrunk = (med: number, n: number) => (n * med + BT_PRIOR * 1) / (n + BT_PRIOR);

/** Час для календаря: медіана фактичних хвилин у вікні, округлена до 15 хв і втиснута у вікно. */
export function windowTime(minutes: number[], w: { from: number; to: number }): string {
  const lo = w.from * 60, hi = w.to * 60 - 15;
  const m = minutes.length ? Math.round(median(minutes) / 15) * 15 : lo + Math.round((hi - lo) / 30) * 15;
  return hhmm(Math.max(lo, Math.min(hi, m)));
}

type BtOne = BestTime & { usual?: string };   // usual - вікно, де майже всі пости (коли порівнювати нема з чим)
function one(key: string, net: string, account: string | null, accountName: string | null, posts: { minute: number; mult: number }[]): BtOne {
  const n = posts.length;
  const who = `${NET_UA[net] || net}${accountName ? " " + accountName : ""}`;
  const base = { key, net, account, accountName, n, best: [] as BtWindow[], worst: null as BtWindow | null, times: [] as string[], show: true };
  const wins: BtWindow[] = [];
  for (const w of BT_WINDOWS) {
    const inW = posts.filter((p) => windowOf(p.minute).key === w.key);
    if (!inW.length) continue;
    const med = Math.round(median(inW.map((p) => p.mult)) * 100) / 100;
    wins.push({ key: w.key, label: w.label, n: inW.length, median: med, score: Math.round(shrunk(med, inW.length) * 100) / 100, time: windowTime(inW.map((p) => p.minute), w) });
  }
  const solid = wins.filter((w) => w.n >= BT_MIN_WINDOW);
  if (n < BT_MIN_POSTS)
    return { ...base, ready: false, text: `${who}: поки ${postsWord(n)} зі статистикою (дозрілі, від 2 діб) - для поради треба ${BT_MIN_POSTS}. Holos порахує сам, щойно їх набереться.` };
  if (solid.length < 2) {
    const usual = (solid[0] || [...wins].sort((a, b) => b.n - a.n)[0]);
    const suggest = usual && BT_WINDOWS.find((w) => w.key === usual.key)!.from < 15 ? "18-21" : "9-12";
    return { ...base, ready: false, usual: usual?.label,
      text: `${who}: майже всі пости виходили ${usual ? `о ${usual.label}` : "в один і той самий час"} - порівняти нема з чим. Постав 3-4 пости в інший час (наприклад, о ${suggest}), і Holos покаже, коли краще.` };
  }
  const ranked = [...solid].sort((a, b) => b.score - a.score || b.n - a.n);
  const best = ranked.filter((w) => w.score >= BT_LIFT).slice(0, 2);
  const worst = ranked[ranked.length - 1];
  if (!best.length)
    return { ...base, ready: true, worst,
      text: `${who}: час публікації майже не впливає (${solid.length} ${plural(solid.length, "вікно", "вікна", "вікон")} доби з ${postsWord(n)}, різниця менша за 10%) - став, коли зручно.` };
  const bestTxt = best.map((w) => `о ${w.label} - ${fmtX(w.median)} від твоєї норми (${postsWord(w.n)})`).join(", далі ");
  const worstTxt = worst && !best.includes(worst) ? `; найслабше о ${worst.label} - ${fmtX(worst.median)} (${postsWord(worst.n)})` : "";
  const times = best.map((w) => w.time);
  return { ...base, ready: true, best, worst: worst && !best.includes(worst) ? worst : null, times,
    text: `${who}: найкраще ${bestTxt}${worstTxt}. Найкращий час для постів - ${times.join(" і ")}.` };
}

/**
 * Найкращий час для кожної мережі зі статистикою (разом по мережі) і для кожного її акаунта, коли їх
 * у мережі кілька. posts - buildAnalytics().posts (у них уже є «×норма» дозрілих постів).
 */
export function bestTimes(posts: BtPost[], tz: string): BestTime[] {
  const out: BestTime[] = [];
  const strip = ({ usual, ...b }: BtOne): BestTime => (void usual, b);
  for (const net of BT_NETS) {
    const rows = posts.filter((p) => p.net === net && p.media !== "story");
    if (!rows.length) continue;
    const measured = rows.filter((p) => p.mult != null && Number.isFinite(p.mult)).map((p) => ({ ...p, minute: localMinute(p.created_at, tz), mult: p.mult as number }));
    const all = one(net, net, null, null, measured);
    const accs = [...new Set(rows.map((p) => p.account || ""))];
    const accItems: BtOne[] = accs.length > 1
      ? accs.map((a) => one(`${net}:${a}`, net, a, rows.find((p) => (p.account || "") === a)?.account_name || null, measured.filter((p) => (p.account || "") === a)))
      : [];
    // усі пости зі статистикою - одного акаунта: рядок мережі повторив би його слово в слово, тож
    // людині показуємо рядок акаунта (у ньому видно, чиї це пости), а мережа лишається для календаря
    const sole = accItems.find((x) => x.n > 0 && x.n === all.n);
    if (sole) all.show = false;
    const src = sole ? `час ${sole.accountName || "іншого акаунта"}` : `спільний час акаунтів ${NET_UA[net] || net}`;
    for (const x of accItems) {
      // акаунт без своєї поради: календар ставить його пости в час мережі разом (див. pickTimes) - і так і пишемо
      const pooled = !x.ready && all.times.length > 0;
      if (pooled) {
        const who = `${NET_UA[net] || net}${x.accountName ? " " + x.accountName : ""}`;
        const why = x.usual ? `майже всі пости виходили о ${x.usual} - порівняти нема з чим`
          : x.n ? `поки ${postsWord(x.n)} зі статистикою (дозрілі, від 2 діб), а для своєї поради треба ${BT_MIN_POSTS}`
          : "своїх постів зі статистикою ще нема";
        x.text = `${who}: ${why} - тож календар ставить його пости в ${src}: ${all.times.join(" і ")}.`
          + (x.usual ? "" : ` Свій час Holos порахує сам, щойно набереться ${BT_MIN_POSTS}.`);
      }
      x.show = x === sole || x.ready || pooled;
    }
    out.push(strip(all), ...accItems.map(strip));
  }
  return out;
}

/**
 * Який час ставити посту в мережу. Акаунт, по якому досить даних, - його власний висновок (навіть
 * «час не впливає»: тоді порожньо, і календар бере час зі стратегії). Акаунт без своєї поради чи пост
 * без акаунта - час мережі разом (pooled: true).
 */
export function pickTimes(items: BestTime[], net: string, account?: string | null): { times: string[]; item: BestTime | null; pooled: boolean } {
  const acc = account != null ? items.find((b) => b.key === `${net}:${account}`) : null;
  if (acc && acc.ready) return { times: acc.times, item: acc, pooled: false };
  const all = items.find((b) => b.key === net) || null;
  return { times: all ? all.times : [], item: all, pooled: !!acc };
}
export const timesFor = (items: BestTime[], net: string, account?: string | null): string[] => pickTimes(items, net, account).times;
