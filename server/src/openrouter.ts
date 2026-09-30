import { env } from "./env.js";
import { assertSpend, assertRate, noteSpend } from "./spend.js";
import { q } from "./db.js";
import { isCliModel, cliAllowedFor, cliChat, CliUnavailable } from "./claudecli.js";
import { logEvent } from "./log.js";

// usage: опційний «вихідний» обʼєкт - chat() заповнює його токенами й вартістю ЦЬОГО виклику.
// Потрібен там, де ціна конкретного виклику є частиною результату (порівняння моделей): читати її
// назад із llm_usage було б гонкою (паралельні виклики пишуть у ту саму таблицю).
// costKnown=false означає «токени точні, ціна невідома» - прямий виклик OpenAI не повертає вартість,
// і ми знаємо ставки лише для моделей із OPENAI_PRICES; показувати 0 як факт було б брехнею.
// truncated: відповідь урвалась на ліміті токенів. Без цього прапорця обрізаний JSON виглядав як
// «модель не тримає наш контракт», хоча насправді це НАШ ліміт був затісний - і в порівнянні моделей
// це прямо обмовляло нормальну модель.
export type UsageOut = { prompt_tokens: number; completion_tokens: number; cost: number; costKnown: boolean; truncated?: boolean };
// images: картинки до запиту (data:image/jpeg;base64,…) - моделі, що бачать (gpt-4o-mini, Gemini), так
// пишуть підписи до кадрів відео. Підписка Claude (сайдкар CLI) картинок не приймає - такий виклик іде API.
export type ChatCtx = { workspaceId: string; step?: string; json?: boolean; maxTokens?: number; usage?: UsageOut; images?: string[] };

// «—»/«–» - найстійкіший AI-маркер: промпти просять їх не вживати, але моделі однаково їх вставляють.
// Гарантію дає лише зачистка КОДОМ на виході кожного виклику (безпечно і для JSON-відповідей).
const stripDashes = (s: string) => s.replace(/[ \t]*[—–][ \t]*/g, " - ");

// ціни OpenAI для прямих викликів ($/1M токенів: [вхід, вихід]) — щоб рахувати вартість у llm_usage
const OPENAI_PRICES: Record<string, [number, number]> = {
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
};
// консервативна оцінка для моделей поза прайсом - лише для стелі витрат (див. нижче)
const FALLBACK_PRICE: [number, number] = [2.5, 10];

// ціни Gemini ($/1M токенів). Ставимо 0 — цільовий сценарій це БЕЗКОШТОВНИЙ тариф Gemini для дешевих кроків.
// (Якщо перейдете на платний тариф - підставте реальні ставки, напр. gemini-2.5-flash ≈ [0.30, 2.50].)
const GEMINI_PRICES: Record<string, [number, number]> = { "gemini-2.5-flash": [0, 0] };

// Gemini через Google AI Studio (generativelanguage) — інший формат запиту/відповіді, ніж OpenAI.
async function geminiChat(model: string, system: string, user: string, ctx?: ChatCtx): Promise<string> {
  const apiModel = model.replace(/^google\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${env.gemini.apiKey}`;
  const imgParts = (ctx?.images || []).map((u) => {
    const m = /^data:([^;]+);base64,(.+)$/.exec(u);
    return m ? { inline_data: { mime_type: m[1], data: m[2] } } : null;
  }).filter(Boolean);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }, ...imgParts] }],
    // ctx.maxTokens шанується так само, як в OpenAI-гілці: інакше Gemini обрізався б на 1500 там,
    // де решта моделей отримує 8000 (генерація 8-12 постів), і порівняння моделей було б нечесним
    generationConfig: { temperature: 0.7, maxOutputTokens: ctx?.maxTokens || 1500 },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify(body) });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("Gemini timeout 60s");
    throw e;
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const t = await res.text();
    // 429 RESOURCE_EXHAUSTED - це не збій коду, а вичерпані кредити/квота проєкту в AI Studio.
    // Сира портянка JSON тут нічого не пояснює людині, яка просто хоче зрозуміти, що робити далі.
    if (res.status === 429) throw new ProviderDown("Gemini: вичерпано квоту або кредити проєкту - поповни в Google AI Studio (ai.studio/projects) чи обери іншу модель", "Gemini", "funds");
    if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(t))
      throw new ProviderDown("Gemini: ключ не прийнято - перевір його в Налаштування → Профіль → Ключі провайдерів", "Gemini", "key");
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const j: any = await res.json();
  const text = stripDashes((j.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join(""));
  {
    const um = j.usageMetadata || {};
    const pin = um.promptTokenCount || 0, pout = um.candidatesTokenCount || 0;
    const [cin, cout] = GEMINI_PRICES[apiModel] || [0, 0];
    const cost = (pin / 1e6) * cin + (pout / 1e6) * cout;
    // ціна «відома» лише для моделей із нашого прайсу; для gemini-2.5-flash це навмисний 0 (free tier)
    if (ctx?.usage) Object.assign(ctx.usage, { prompt_tokens: pin, completion_tokens: pout, cost, costKnown: !!GEMINI_PRICES[apiModel] });
    if (ctx?.workspaceId) try { await q(`insert into llm_usage(workspace_id, step, model, prompt_tokens, completion_tokens, cost) values($1,$2,$3,$4,$5,$6)`, [ctx.workspaceId, ctx.step ?? null, model, pin, pout, cost]); noteSpend(ctx.workspaceId, cost); } catch { /* облік не критичний */ }
  }
  return text;
}

// Мережева помилка на шляху до моделі - людською. «fetch failed» / ECONNREFUSED / ENOTFOUND / timeout
// доходили до користувача сирими (спіймано аудитом: модель вимкнено → «fetch failed» у кабінеті).
// Це не помилка людини і не назавжди, тож текст каже: тимчасово, спробуй за хвилину.
export function humanNetError(provider: string, e: any): string {
  const name = String(e?.name || ""), msg = String(e?.message || e || ""), code = String(e?.cause?.code || e?.code || "");
  if (name === "AbortError" || /timeout/i.test(msg)) return `Модель не відповіла за 60 секунд (${provider}) - спробуй ще раз; якщо повторюється, провайдер перевантажений.`;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|UND_ERR|network/i.test(msg + " " + code))
    return `Модель тимчасово недоступна (нема звʼязку з ${provider}) - спробуй за хвилину.`;
  return `${provider}: ${msg.slice(0, 200)}`;
}

// Особливості конкретних моделей, вивчені з їхніх же помилок (модель → що робити з тілом запиту).
// Живе на процес: перезапуск просто перевчиться за один виклик.
type Quirk = { renameMaxTokens?: boolean; drop?: string[] };
const QUIRKS = new Map<string, Quirk>();

function applyQuirks(apiModel: string, body: any): void {
  const qk = QUIRKS.get(apiModel);
  if (!qk) return;
  if (qk.renameMaxTokens && body.max_tokens != null) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
  for (const k of qk.drop || []) delete body[k];
}

// Розбір 400 «unsupported_parameter/unsupported_value»: правимо тіло під модель і кажемо, чи є сенс
// повторювати. Саме так ми дізнаємось про вимоги нових моделей, не тримаючи їх списку в коді.
export function fixUnsupportedParam(apiModel: string, body: any, errText: string): boolean {
  let e: any = {};
  try { e = JSON.parse(errText)?.error || {}; } catch { /* не JSON - нижче підстрахуємось текстом */ }
  const code = String(e.code || "");
  const param = String(e.param || "");
  const msg = String(e.message || errText);
  if (!/unsupported_parameter|unsupported_value|Unsupported parameter|Unsupported value/i.test(code + " " + msg)) return false;
  const qk = QUIRKS.get(apiModel) || {};
  if (param === "max_tokens" || /max_completion_tokens/.test(msg)) {
    if (body.max_tokens == null) return false;
    body.max_completion_tokens = body.max_tokens; delete body.max_tokens;
    qk.renameMaxTokens = true; QUIRKS.set(apiModel, qk); return true;
  }
  if (param && body[param] !== undefined) {
    delete body[param];
    qk.drop = [...new Set([...(qk.drop || []), param])]; QUIRKS.set(apiModel, qk); return true;
  }
  return false;
}

// 🛟 Провайдер «лежить надовго»: закінчились кошти або не прийнято ключ. На відміну від 429/5xx це не
// минає за хвилину - без поповнення кожен наступний виклик впаде так само (тейки на беті 26.09 падали
// щохвилини). Такий збій - привід піти запасним маршрутом (див. chat) і написати адміну (alerts.ts).
export class ProviderDown extends Error {
  constructor(message: string, public provider: string, public why: "funds" | "key") { super(message); }
}
// «Кошти закінчились» у різних провайдерів звучить по-різному; OpenAI 30.09 відповідав 429 з «You have no
// credits remaining» - раніше це читалось як «тимчасово недоступна, спробуй за хвилину».
export const FUNDS_TEXT = /insufficient_quota|requires more credits|credit balance|Insufficient credits|no credits remaining|exceeded your current quota|billing_hard_limit|insufficient funds/i;

type Route = "gemini" | "openai" | "openrouter";
const ROUTE_NAME: Record<Route, string> = { gemini: "Gemini", openai: "OpenAI", openrouter: "OpenRouter" };
/** Куди піде модель: google/* і openai/* - напряму, якщо є ключ; решта - OpenRouter. */
export function routeFor(model: string): Route | null {
  if (model.startsWith("google/") && env.gemini.apiKey) return "gemini";
  if (model.startsWith("openai/") && env.openai.apiKey) return "openai";
  return env.openrouter.apiKey ? "openrouter" : null;
}
/** Запасний маршрут для провайдера, що «лежить»: інший провайдер, у якого є ключ. */
export function failoverFor(route: Route, model: string): { route: Route; model: string } | null {
  const fm = env.llm.failoverModel;
  if (route === "openrouter") {
    if (env.openai.apiKey) return { route: "openai", model: fm.startsWith("openai/") ? fm : "openai/gpt-4o" };
    if (env.gemini.apiKey) return { route: "gemini", model: "google/gemini-2.5-flash" };
    return null;
  }
  if (route === "openai") {
    if (env.openrouter.apiKey) return { route: "openrouter", model };   // та сама модель через OpenRouter
    if (env.gemini.apiKey) return { route: "gemini", model: "google/gemini-2.5-flash" };
    return null;
  }
  if (env.openrouter.apiKey) return { route: "openrouter", model };
  if (env.openai.apiKey) return { route: "openai", model: "openai/gpt-4o-mini" };
  return null;
}
// провайдер → до якого часу вважаємо його «лежачим»: ці 10 хв виклики йдуть одразу запасним маршрутом,
// без марного запиту щоразу; потім пробуємо знову (раптом уже поповнили)
const DOWN = new Map<Route, number>();
const DOWN_MS = 10 * 60_000;
export function _resetFailover(): void { DOWN.clear(); }

export async function chat(model: string, system: string, user: string, ctx?: ChatCtx): Promise<string> {
  // 🤖 "claude-cli/*" → Claude через ПІДПИСКУ (сайдкар із Claude Code CLI), без оплати токенів.
  // Стоїть ПЕРЕД доларовою стелею свідомо: цей виклик грошей не витрачає, тож блокувати його
  // стелею було б неправдою; частотне обмеження лишається - воно береже квоту підписки.
  // Будь-яка причина «не вийшло» (кабінету не дозволено, сайдкара немає - як на проді, - квота
  // вичерпана, таймаут) закінчується однаково: мовчки далі звичайним API-шляхом. Користувач не
  // має ані бачити цього, ані лишатись без відповіді через чужу інфраструктуру.
  if (isCliModel(model)) {
    if (ctx?.workspaceId) assertRate(ctx.workspaceId);
    if (!ctx?.images?.length && await cliAllowedFor(ctx?.workspaceId)) {
      try {
        const r = await cliChat(model, system, user, ctx);
        // costKnown=true з ціною 0 - це факт, а не «ціна невідома»: підписку вже сплачено.
        if (ctx?.usage) Object.assign(ctx.usage, { prompt_tokens: r.inTokens, completion_tokens: r.outTokens, cost: 0, costKnown: true });
        return stripDashes(r.text);
      } catch (e: any) {
        if (!(e instanceof CliUnavailable)) throw e;
        logEvent("warn", "claude-cli", `фолбек на ${env.claudeCli.fallbackModel}: ${String(e.message).slice(0, 200)}`).catch(() => {});
      }
    }
    model = env.claudeCli.fallbackModel;
  }
  // 💸 Стеля витрат - ТУТ, бо через цю функцію проходить кожен платний виклик (див. spend.ts).
  // Виклики без воркспейсу (їх нема, але про всяк випадок) не капаються - і не обліковуються.
  if (ctx?.workspaceId) await assertSpend(ctx.workspaceId);
  // "google/*" → напряму в Gemini, якщо є GEMINI_API_KEY; інакше падає у OpenRouter (він теж уміє google/gemini-*)
  // моделі "openai/*" ідуть напряму в OpenAI, якщо заданий OPENAI_API_KEY (дешевше за наценку OpenRouter)
  const route = routeFor(model);
  if (!route) throw new Error("Не задано ні OPENAI_API_KEY, ні OPENROUTER_API_KEY");
  // 🛟 Запасний маршрут: кошти закінчились чи ключ не прийнято - той самий виклик іде іншим провайдером,
  // а в журнал (і звідти адміну) - попередження. Людина отримує пост, адмін - сповіщення поповнити.
  const alt = env.llm.failover ? failoverFor(route, model) : null;
  if (alt && (DOWN.get(route) || 0) > Date.now()) return callRoute(alt.route, alt.model, system, user, ctx);
  try {
    return await callRoute(route, model, system, user, ctx);
  } catch (e: any) {
    if (!(e instanceof ProviderDown) || !alt) throw e;
    DOWN.set(route, Date.now() + DOWN_MS);
    logEvent("warn", "llm", `${e.provider}: ${e.why === "funds" ? "закінчились кошти" : "ключ не прийнято"} - запасний маршрут ${alt.model} (${ROUTE_NAME[alt.route]}) на ${DOWN_MS / 60000} хв. ${e.message.slice(0, 200)}`).catch(() => {});
    return callRoute(alt.route, alt.model, system, user, ctx);
  }
}

async function callRoute(route: Route, model: string, system: string, user: string, ctx?: ChatCtx): Promise<string> {
  if (route === "gemini") return geminiChat(model, system, user, ctx);
  const useOpenAI = route === "openai";
  const provider = useOpenAI ? "OpenAI" : "OpenRouter";
  const url = useOpenAI ? "https://api.openai.com/v1/chat/completions" : `${env.openrouter.baseUrl}/chat/completions`;
  const apiModel = useOpenAI ? model.replace(/^openai\//, "") : model;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${useOpenAI ? env.openai.apiKey : env.openrouter.apiKey}`,
    "Content-Type": "application/json",
  };
  if (!useOpenAI) {
    if (env.openrouter.referer) headers["HTTP-Referer"] = env.openrouter.referer;
    if (env.openrouter.title) headers["X-Title"] = env.openrouter.title;
  }
  // presence_penalty: дешевий і надійніший важіль проти шаблонних фраз/повторів, ніж лише regex-заборони
  // в промпті (AI_TRACE_RX). Помірне значення - не ламає структуровані JSON-відповіді.
  const userContent: any = ctx?.images?.length
    ? [{ type: "text", text: user }, ...ctx.images.map((url) => ({ type: "image_url", image_url: { url, detail: "low" } }))]
    : user;
  const body: any = { model: apiModel, temperature: 0.7, max_tokens: ctx?.maxTokens || 1500, presence_penalty: 0.3,
    messages: [{ role: "system", content: system }, { role: "user", content: userContent }] };
  if (!useOpenAI) body.usage = { include: true }; // OpenRouter-специфічне
  // примусовий JSON-режим - без нього модель інколи ігнорує «поверни лише JSON» і відповідає прозою
  // (уточнююче питання, відмова), і extractJsonArray/Object лишається ні з чим
  if (ctx?.json) body.response_format = { type: "json_object" };
  applyQuirks(apiModel, body);

  const send = async (): Promise<Response> => {
    // timeout: інакше крок назавжди лишиться у статусі running
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try { return await fetch(url, { method: "POST", headers, signal: controller.signal, body: JSON.stringify(body) }); }
    catch (e: any) { throw new Error(humanNetError(provider, e)); }
    finally { clearTimeout(timer); }
  };

  let res = await send();
  // 🔧 САМОНАЛАШТУВАННЯ ПІД МОДЕЛЬ. Нові моделі OpenAI відкидають параметри, які приймали старі:
  // `max_tokens` треба слати як `max_completion_tokens`, а фіксовані temperature/presence_penalty
  // вони взагалі не підтримують. Через це БУДЬ-ЯКА новіша модель падала з 400 ще до генерації - тобто
  // перемкнутися на щось свіжіше за gpt-4o було неможливо в принципі. Список моделей хардкодити не
  // можна (застаріє за місяць), тож ми читаємо, на що САМЕ свариться API, прибираємо цей параметр і
  // повторюємо. Вдале налаштування памʼятається на процес - розплачується лише перший виклик.
  for (let i = 0; i < 4 && !res.ok; i++) {
    const raw = await res.clone().text();
    const fixed = fixUnsupportedParam(apiModel, body, raw);
    if (!fixed) break;
    res = await send();
  }

  if (!res.ok) {
    const t = await res.text();
    // гроші на рахунку провайдера скінчились - це не «спробуй за хвилину»: без поповнення чи іншої
    // моделі кожна наступна спроба впаде так само (так тейки на беті падали 840 разів за два тижні)
    if (res.status === 402 || FUNDS_TEXT.test(t))
      throw new ProviderDown(`На рахунку провайдера моделі (${provider}) закінчились кошти - обери іншу модель в Інструментах («Головна модель») або поповни рахунок.`, provider, "funds");
    // ключ відкликали/не той - так само «надовго», і так само привід піти запасним маршрутом
    if (res.status === 401 || /invalid[_ ]api[_ ]key|incorrect api key|No auth credentials|User not found/i.test(t))
      throw new ProviderDown(`${provider}: ключ не прийнято (HTTP ${res.status}) - перевір його в Налаштування → Профіль → Ключі провайдерів.`, provider, "key");
    // 5xx і 429 у провайдера - не наша помилка і не назавжди: кажемо людині саме це, а деталь
    // лишаємо після крапки для оператора (вона потрапляє в журнал разом із повідомленням)
    if (res.status >= 500 || res.status === 429)
      throw new Error(`Модель тимчасово недоступна (${provider} ${res.status}) - спробуй за хвилину.${res.status === 429 ? " Якщо повторюється - вичерпано квоту провайдера." : ""}`);
    throw new Error(`${provider} ${res.status}: ${t.slice(0, 300)}`);
  }
  const j: any = await res.json();
  {
    const u = j.usage || {};
    let cost = u.cost || 0;
    // OpenRouter вертає вартість сам; прямий OpenAI - ні, тож рахуємо за нашим прайсом (і чесно
    // кажемо «невідомо», якщо моделі в ньому нема - інакше нова модель виглядала б безкоштовною)
    const costKnown = !useOpenAI ? u.cost != null : !!OPENAI_PRICES[apiModel];
    if (useOpenAI && OPENAI_PRICES[apiModel]) {
      const [pin, pout] = OPENAI_PRICES[apiModel];
      cost = ((u.prompt_tokens || 0) / 1e6) * pin + ((u.completion_tokens || 0) / 1e6) * pout;
    }
    // 💸 Ціна невідома (модель поза прайсом, провайдер не повернув cost) - для СТЕЛІ витрат
    // рахуємо консервативно за тарифом gpt-4o. Інакше невідома модель була б «безкоштовною», і
    // стеля її не бачила б - рівно та дірка, через яку витрати тікають. costKnown лишається false,
    // щоб у Аналітиці це чесно показувалось як оцінка, а не факт.
    if (!costKnown && !cost && (u.prompt_tokens || u.completion_tokens)) {
      const [pin, pout] = FALLBACK_PRICE;
      cost = ((u.prompt_tokens || 0) / 1e6) * pin + ((u.completion_tokens || 0) / 1e6) * pout;
    }
    if (ctx?.usage) Object.assign(ctx.usage, { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, cost, costKnown,
      truncated: j.choices?.[0]?.finish_reason === "length" });
    if (ctx?.workspaceId) try {
      await q(
        `insert into llm_usage(workspace_id, step, model, prompt_tokens, completion_tokens, cost) values($1,$2,$3,$4,$5,$6)`,
        [ctx.workspaceId, ctx.step ?? null, model, u.prompt_tokens || 0, u.completion_tokens || 0, cost]
      );
      noteSpend(ctx.workspaceId, cost);
    } catch { /* облік не критичний */ }
  }
  return stripDashes(j.choices?.[0]?.message?.content ?? "");
}

// надійний витяг JSON-масиву (терпить markdown-огорожі та текст довкола)
export function extractJsonArray<T = any>(text: string): T[] {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("у відповіді немає JSON-масиву");
  try {
    return JSON.parse(m[0]) as T[];
  } catch {
    throw new Error("невалідний JSON у відповіді моделі");
  }
}

// надійний витяг JSON-обʼєкта
export function extractJsonObject<T = any>(text: string): T {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("у відповіді немає JSON-обʼєкта");
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    throw new Error("невалідний JSON у відповіді моделі");
  }
}
