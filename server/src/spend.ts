// 💸 Стеля витрат на AI - на воркспейс, у ЄДИНІЙ точці.
//
// До цього ліміти стояли лише на логіні й реєстрації, а `llm_usage` читався тільки для показу в
// Аналітиці. Тобто будь-який підтверджений email = необмежений рахунок OpenAI на картці оператора
// (перевірено: 25 генерацій підряд - 25×200, жодного 429). Для відкритого доступу це блокер.
//
// Чому стеля стоїть у `chat()`/`generateImage()`, а не в роутах: генеративних роутів ~40, і кожен
// новий забували б додати в список. У вузькому місці, через яке проходить КОЖЕН платний виклик,
// пропустити неможливо. Ціна - один SQL-запит на виклик моделі (кешований на 15с), тобто ~0.1% від
// вартості самого виклику.
//
// Три шари, від дешевого до дорогого:
//  1. частота: не більше N викликів моделі за хвилину на воркспейс (у памʼяті, без БД);
//  2. денна стеля в доларах (UTC-доба, щоб «поновиться опівночі» було передбачуваним);
//  3. місячна стеля - на випадок «по $2.99 щодня».
// Дефолти - з .env; окремому кабінету адмін може задати свої (колонки на `workspace`).
import { q, one } from "./db.js";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
export const CAPS = {
  day: num(process.env.SPEND_CAP_USD_DAY, 3),
  month: num(process.env.SPEND_CAP_USD_MONTH, 30),
  callsPerMin: num(process.env.SPEND_CALLS_PER_MIN, 40),
};

export class SpendCapError extends Error {
  code = "spend_cap";
  constructor(msg: string) { super(msg); this.name = "SpendCapError"; }
}

export type Spent = { day: number; month: number };
export type Caps = { day: number; month: number };

/** Чиста перевірка: 0 у стелі = «без обмеження» (для власного кабінету оператора). */
export function capVerdict(spent: Spent, caps: Caps): { ok: true } | { ok: false; reason: "day" | "month" } {
  if (caps.day > 0 && spent.day >= caps.day) return { ok: false, reason: "day" };
  if (caps.month > 0 && spent.month >= caps.month) return { ok: false, reason: "month" };
  return { ok: true };
}

/** Людське повідомлення - його бачить користувач у кабінеті, тож без «quota exceeded». */
export function capMessage(reason: "day" | "month" | "rate", spent: Spent, caps: Caps): string {
  const usd = (x: number) => `$${x.toFixed(2)}`;
  if (reason === "rate") return "Забагато запитів до AI за хвилину - зачекай трохи й повтори.";
  if (reason === "day") return `Денну стелю витрат на AI вичерпано: ${usd(spent.day)} із ${usd(caps.day)}. Поновиться опівночі за UTC. Якщо потрібно більше - напиши адміністратору.`;
  return `Місячну стелю витрат на AI вичерпано: ${usd(spent.month)} із ${usd(caps.month)}. Якщо потрібно більше - напиши адміністратору.`;
}

// ---- 1. частота (у памʼяті; застосунок одноінстансний) ----
const win = new Map<string, { n: number; t: number }>();
export function overCallRate(ws: string, max = CAPS.callsPerMin, now = Date.now(), windowMs = 60000): boolean {
  if (max <= 0) return false;
  const h = win.get(ws);
  if (!h || now - h.t > windowMs) { win.set(ws, { n: 1, t: now }); return false; }
  h.n++;
  return h.n > max;
}

// ---- 2-3. долари з llm_usage (кеш 15с: у генерації буває 3-5 паралельних викликів) ----
const cache = new Map<string, { at: number; spent: Spent; caps: Caps }>();
const CACHE_MS = 15000;

async function workspaceCaps(ws: string): Promise<Caps> {
  const r = await one<{ spend_cap_day: string | null; spend_cap_month: string | null }>(
    `select spend_cap_day, spend_cap_month from workspace where id=$1`, [ws]).catch(() => null);
  return {
    day: r?.spend_cap_day != null ? Number(r.spend_cap_day) : CAPS.day,
    month: r?.spend_cap_month != null ? Number(r.spend_cap_month) : CAPS.month,
  };
}

export async function spendStatus(ws: string, fresh = false): Promise<{ spent: Spent; caps: Caps }> {
  const c = cache.get(ws);
  if (!fresh && c && Date.now() - c.at < CACHE_MS) return { spent: c.spent, caps: c.caps };
  const [r, caps] = await Promise.all([
    one<{ day: string; month: string }>(
      `select coalesce(sum(cost) filter (where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'),0)::float as day,
              coalesce(sum(cost) filter (where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'),0)::float as month
         from llm_usage where workspace_id=$1 and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`, [ws]),
    workspaceCaps(ws),
  ]);
  const spent = { day: Number(r?.day || 0), month: Number(r?.month || 0) };
  cache.set(ws, { at: Date.now(), spent, caps });
  return { spent, caps };
}

/**
 * Лише частотний шар, без доларів. Потрібен для викликів, які нічого не коштують (Claude через
 * ПІДПИСКУ): блокувати їх доларовою стелею було б неправдою - грошей вони не витрачають, - але
 * обмеження «N викликів за хвилину» лишається, бо воно захищає квоту підписки й сам сервіс.
 */
export function assertRate(ws: string): void {
  if (overCallRate(ws)) throw new SpendCapError(capMessage("rate", { day: 0, month: 0 }, CAPS));
}

/** Кидає SpendCapError, якщо цьому воркспейсу вже не можна витрачати. Викликається ПЕРЕД платним запитом. */
export async function assertSpend(ws: string): Promise<void> {
  assertRate(ws);
  const { spent, caps } = await spendStatus(ws);
  const v = capVerdict(spent, caps);
  if (!v.ok) throw new SpendCapError(capMessage(v.reason, spent, caps));
}

/** Після запису витрати - щоб наступна перевірка бачила свіжу суму, а не 15-секундний кеш. */
export function noteSpend(ws: string, usd: number): void {
  const c = cache.get(ws);
  if (c) { c.spent.day += usd; c.spent.month += usd; }
}
