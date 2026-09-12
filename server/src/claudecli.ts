// 🤖 Claude Code CLI як провайдер моделі: думає той Claude, за якого вже сплачено ПІДПИСКОЮ,
// а ми не платимо за токени API. Та сама ідея, що в MCP-конекторі, тільки з іншого боку:
// там Claude ходить у наш сервіс, тут сервіс ходить у Claude.
//
// Межі, з яких виросла ця реалізація:
//  1. Токен підписки НАЛЕЖИТЬ ЛЮДИНІ. Обслуговувати ним генерації інших орендарів не можна ані за
//     умовами підписки, ані практично (квота спільна й вигорить за годину). Тому шлях вмикається
//     ЯВНО на конкретний кабінет (`workspace.cli_enabled`, ставить лише адмін) - за замовчуванням
//     вимкнено для всіх, і жоден новий користувач не потрапляє на нього випадково.
//  2. Сайдкар тримає ОДИН процес за раз. Наш застосунок робить по 4-10 паралельних викликів, тож
//     на CLI має сенс садити лише ДОРОГІ виклики (головна модель), а дрібні кроки лишати на
//     дешевому API - інакше «безкоштовно» перетвориться на «повільно».
//  3. Будь-який збій = тихий фолбек на API. Вичерпана квота, впалий сайдкар, прод без сайдкара -
//     користувач не має цього побачити взагалі.
import { env } from "./env.js";
import { q, one } from "./db.js";

const PREFIX = "claude-cli/";

/** Псевдо-моделі, які вибираються в кабінеті так само, як openai/* чи google/*. */
export const CLI_MODELS = [
  { id: "claude-cli/sonnet", label: "Claude Sonnet (підписка, без оплати токенів)" },
  { id: "claude-cli/opus", label: "Claude Opus (підписка; ×5 квоти - лише де справді треба)" },
];

export const isCliModel = (m: string): boolean => (m || "").startsWith(PREFIX);

/** "claude-cli/sonnet" → "sonnet". Порожнє чи невідоме - sonnet: дефолт має бути дешевим за квотою. */
export function cliModelName(m: string): string {
  const raw = (m || "").slice(PREFIX.length).trim().toLowerCase();
  return raw === "opus" || raw === "haiku" || raw === "sonnet" ? raw : "sonnet";
}

/** CLI не має режиму «відповідай лише JSON», тож огорожу ```json і вступне слово знімаємо КОДОМ. */
export function stripJsonFence(s: string): string {
  let t = String(s || "").trim();
  const fence = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  if (fence) t = fence[1].trim();
  // Завжди вирізаємо ЗБАЛАНСОВАНИЙ обʼєкт/масив, навіть якщо текст уже починається з дужки: модель
  // любить дописати «Готово!» в кінці, і цей хвіст ламає JSON.parse так само надійно, як вступ.
  const i = t.search(/[[{]/);
  if (i < 0) return t;
  const open = t[i], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < t.length; k++) {
    const c = t[k];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return t.slice(i, k + 1); }
  }
  return t.slice(i);
}

// ---- доступність: сайдкара може не бути (прод) або квота може скінчитись (тимчасово) ----
let downUntil = 0;
let downWhy = "";
const COOLDOWN_MS = { limit: 15 * 60 * 1000, net: 60 * 1000 };

export function cliCooldown(): { down: boolean; why: string; untilMs: number } {
  return { down: Date.now() < downUntil, why: downWhy, untilMs: Math.max(0, downUntil - Date.now()) };
}
export function markCliDown(kind: "limit" | "net", why: string, now = Date.now()): void {
  downUntil = now + COOLDOWN_MS[kind]; downWhy = why;
}
export function resetCliCooldown(): void { downUntil = 0; downWhy = ""; }

/** Чи дозволено CLI ЦЬОМУ кабінету. Кеш 60с: перевірка стоїть у гарячому шляху генерації. */
const allowCache = new Map<string, { at: number; on: boolean }>();
export async function cliAllowedFor(ws: string | undefined): Promise<boolean> {
  if (!ws || !env.claudeCli.url) return false;
  const c = allowCache.get(ws);
  if (c && Date.now() - c.at < 60000) return c.on;
  const r = await one<{ cli_enabled: boolean }>(`select cli_enabled from workspace where id=$1`, [ws]).catch(() => null);
  const on = !!r?.cli_enabled;
  allowCache.set(ws, { at: Date.now(), on });
  return on;
}
export function forgetCliAllowed(ws: string): void { allowCache.delete(ws); }

export type CliResult = { text: string; cost: number; inTokens: number; outTokens: number; ms: number };

/** Живий стан сайдкара - для адмінки й каталогу моделей (щоб не пропонувати те, чого немає). */
export async function cliHealth(): Promise<{ up: boolean; busy?: number; queued?: number; tokenSet?: boolean; error?: string }> {
  if (!env.claudeCli.url) return { up: false, error: "CLAUDE_CLI_URL не заданий" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${env.claudeCli.url}/health`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!res.ok) return { up: false, error: `HTTP ${res.status}` };
    const j: any = await res.json();
    return { up: true, busy: j.busy, queued: j.queued, tokenSet: !!j.tokenSet };
  } catch (e: any) { return { up: false, error: String(e?.message || e).slice(0, 120) }; }
}

export class CliUnavailable extends Error { constructor(msg: string) { super(msg); this.name = "CliUnavailable"; } }

/**
 * Один виклик моделі через підписку. Кидає CliUnavailable на БУДЬ-ЯКИЙ збій - викликач (chat())
 * мовчки переходить на API. Виняток навмисно окремого класу: «модель не змогла» і «нема доступу
 * до підписки» - різні речі, і плутати їх означало б показувати людині чужу проблему.
 */
export async function cliChat(model: string, system: string, user: string, ctx?: { workspaceId?: string; step?: string; json?: boolean }): Promise<CliResult> {
  if (!env.claudeCli.url) throw new CliUnavailable("CLI не налаштований");
  const cd = cliCooldown();
  if (cd.down) throw new CliUnavailable(cd.why || "CLI тимчасово недоступний");

  // Просимо JSON словами - іншого способу тут немає (у API це response_format). Ставимо в КІНЕЦЬ
  // системної частини: останні рядки промту модель тримає найкраще.
  const sys = ctx?.json
    ? `${system}\n\nФОРМАТ ВІДПОВІДІ: поверни ВИКЛЮЧНО валідний JSON. Без пояснень до чи після, без огорожі \`\`\`.`
    : system;

  const started = Date.now();
  let j: any;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), env.claudeCli.timeoutMs + 15000);
    const res = await fetch(`${env.claudeCli.url}/run`, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ system: sys, user, model: cliModelName(model), maxTurns: env.claudeCli.maxTurns, timeoutMs: env.claudeCli.timeoutMs }),
    }).finally(() => clearTimeout(t));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    j = await res.json();
  } catch (e: any) {
    // Сайдкара немає (прод), контейнер перезапускається, мережа впала - усе це «поки що ні».
    markCliDown("net", "Claude CLI недоступний");
    throw new CliUnavailable("Claude CLI недоступний: " + String(e?.message || e).slice(0, 120));
  }

  if (!j?.ok) {
    const err = String(j?.error || "невідома помилка");
    if (j?.limit) markCliDown("limit", "Ліміт підписки Claude вичерпано - працюємо через API");
    throw new CliUnavailable(err.slice(0, 200));
  }

  const text = ctx?.json ? stripJsonFence(String(j.text || "")) : String(j.text || "");
  const inTok = Number(j.input_tokens || 0), outTok = Number(j.output_tokens || 0);
  const wouldCost = Number(j.cost || 0);
  // cost=0 - це ПРАВДА (підписка вже сплачена), і саме він годує стелю витрат та Аналітику.
  // Скільки той самий виклик коштував би через API, пишемо в alt_cost - інакше «скільки ми
  // заощадили» неможливо порахувати, а це головне питання до цієї фічі.
  if (ctx?.workspaceId) {
    try {
      await q(`insert into llm_usage(workspace_id, step, model, prompt_tokens, completion_tokens, cost, alt_cost) values($1,$2,$3,$4,$5,0,$6)`,
        [ctx.workspaceId, ctx.step ?? null, model, inTok, outTok, wouldCost]);
    } catch { /* облік не критичний */ }
  }
  return { text, cost: wouldCost, inTokens: inTok, outTokens: outTok, ms: Date.now() - started };
}
