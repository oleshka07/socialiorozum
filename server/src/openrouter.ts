import { env } from "./env.js";
import { q } from "./db.js";

export type ChatCtx = { workspaceId: string; step?: string };

export async function chat(model: string, system: string, user: string, ctx?: ChatCtx): Promise<string> {
  if (!env.openrouter.apiKey) throw new Error("OPENROUTER_API_KEY не заданий");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.openrouter.apiKey}`,
    "Content-Type": "application/json",
  };
  if (env.openrouter.referer) headers["HTTP-Referer"] = env.openrouter.referer;
  if (env.openrouter.title) headers["X-Title"] = env.openrouter.title;

  // timeout: інакше крок назавжди лишиться у статусі running
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res: Response;
  try {
    res = await fetch(`${env.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 1500,
        usage: { include: true },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("OpenRouter timeout 60s");
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${t.slice(0, 300)}`);
  }
  const j: any = await res.json();
  if (ctx?.workspaceId) {
    const u = j.usage || {};
    try {
      await q(
        `insert into llm_usage(workspace_id, step, model, prompt_tokens, completion_tokens, cost) values($1,$2,$3,$4,$5,$6)`,
        [ctx.workspaceId, ctx.step ?? null, model, u.prompt_tokens || 0, u.completion_tokens || 0, u.cost || 0]
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
