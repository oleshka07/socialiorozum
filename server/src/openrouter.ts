import { env } from "./env.js";
import { q } from "./db.js";

export type ChatCtx = { workspaceId: string; step?: string };

// ціни OpenAI для прямих викликів ($/1M токенів: [вхід, вихід]) — щоб рахувати вартість у llm_usage
const OPENAI_PRICES: Record<string, [number, number]> = {
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
};

// ціни Gemini ($/1M токенів). Ставимо 0 — цільовий сценарій це БЕЗКОШТОВНИЙ тариф Gemini для дешевих кроків.
// (Якщо перейдете на платний тариф - підставте реальні ставки, напр. gemini-2.5-flash ≈ [0.30, 2.50].)
const GEMINI_PRICES: Record<string, [number, number]> = { "gemini-2.5-flash": [0, 0] };

// Gemini через Google AI Studio (generativelanguage) — інший формат запиту/відповіді, ніж OpenAI.
async function geminiChat(model: string, system: string, user: string, ctx?: ChatCtx): Promise<string> {
  const apiModel = model.replace(/^google\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${env.gemini.apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
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
  if (!res.ok) { const t = await res.text(); throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`); }
  const j: any = await res.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("");
  if (ctx?.workspaceId) {
    const um = j.usageMetadata || {};
    const pin = um.promptTokenCount || 0, pout = um.candidatesTokenCount || 0;
    const [cin, cout] = GEMINI_PRICES[apiModel] || [0, 0];
    const cost = (pin / 1e6) * cin + (pout / 1e6) * cout;
    try { await q(`insert into llm_usage(workspace_id, step, model, prompt_tokens, completion_tokens, cost) values($1,$2,$3,$4,$5,$6)`, [ctx.workspaceId, ctx.step ?? null, model, pin, pout, cost]); } catch { /* облік не критичний */ }
  }
  return text;
}

export async function chat(model: string, system: string, user: string, ctx?: ChatCtx): Promise<string> {
  // "google/*" → напряму в Gemini, якщо є GEMINI_API_KEY; інакше падає у OpenRouter (він теж уміє google/gemini-*)
  if (model.startsWith("google/") && env.gemini.apiKey) return geminiChat(model, system, user, ctx);
  // моделі "openai/*" ідуть напряму в OpenAI, якщо заданий OPENAI_API_KEY (дешевше за наценку OpenRouter)
  const useOpenAI = model.startsWith("openai/") && !!env.openai.apiKey;
  if (!useOpenAI && !env.openrouter.apiKey) throw new Error("Не задано ні OPENAI_API_KEY, ні OPENROUTER_API_KEY");
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
  const body: any = { model: apiModel, temperature: 0.7, max_tokens: 1500,
    messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  if (!useOpenAI) body.usage = { include: true }; // OpenRouter-специфічне

  // timeout: інакше крок назавжди лишиться у статусі running
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, signal: controller.signal, body: JSON.stringify(body) });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error(`${provider} timeout 60s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${provider} ${res.status}: ${t.slice(0, 300)}`);
  }
  const j: any = await res.json();
  if (ctx?.workspaceId) {
    const u = j.usage || {};
    let cost = u.cost || 0;
    if (useOpenAI && OPENAI_PRICES[apiModel]) {
      const [pin, pout] = OPENAI_PRICES[apiModel];
      cost = ((u.prompt_tokens || 0) / 1e6) * pin + ((u.completion_tokens || 0) / 1e6) * pout;
    }
    try {
      await q(
        `insert into llm_usage(workspace_id, step, model, prompt_tokens, completion_tokens, cost) values($1,$2,$3,$4,$5,$6)`,
        [ctx.workspaceId, ctx.step ?? null, model, u.prompt_tokens || 0, u.completion_tokens || 0, cost]
      );
    } catch { /* облік не критичний */ }
  }
  return j.choices?.[0]?.message?.content ?? "";
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
