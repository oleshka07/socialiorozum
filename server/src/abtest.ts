// 🧪 Порівняння моделей на ОДНОМУ матеріалі.
//
// Питання, на яке це відповідає: «контент слабкий через модель чи через промт?» Без інструменту
// відповісти на нього неможливо - міняти модель у коді й деплоїти, щоб порівняти на око, це не
// експеримент, а вгадування.
//
// Ключове рішення: промт будується ОДИН РАЗ через звичайний `buildLitePrompt` і віддається всім
// моделям ДОСЛІВНО. Тобто змінна тут рівно одна - модель. Якби кожна модель отримувала свій промт,
// порівняння не значило б нічого. З тієї ж причини результат розбирається тим самим `parseLitePosts`,
// що й бойова генерація: інакше «на цій моделі гірше» могло б означати «наш парсер не зрозумів її».
//
// Результат НІКУДИ не зберігається як пости - інакше кожен прогін засмічував би Студію N×копіями.
// У `llm_usage` він лягає з `step='abtest'`, щоб вартість експериментів було видно окремо від роботи.
import { q, one } from "./db.js";
import { chat, type UsageOut } from "./openrouter.js";
import { buildLitePrompt, parseLitePosts, type LitePost } from "./pipeline.js";

export type AbVariant = {
  model: string;
  ok: boolean;
  error?: string;
  posts: LitePost[];
  ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  costKnown: boolean;
};

export type AbResult = {
  material: { id: string | null; title: string; chars: number };
  prompt: { chars: number; system: string };
  count: number;
  variants: AbVariant[];
};

const MAX_MODELS = 4;   // більше - і один прогін коштує як день роботи, а порівнювати вже нема чим
const MAX_COUNT = 3;

// Матеріал для прогону: конкретне джерело, джерело поста або сирий текст.
async function resolveMaterial(workspaceId: string, opts: { sourceId?: string; postId?: string; text?: string }) {
  if (opts.sourceId) {
    const r = await one<{ id: string; title: string; transcript: string; origin: string }>(
      `select id, coalesce(title,'') as title, coalesce(transcript,'') as transcript, coalesce(origin,'') as origin
         from source where id=$1 and workspace_id=$2`, [opts.sourceId, workspaceId]);
    if (!r) throw new Error("Матеріал не знайдено");
    return r;
  }
  if (opts.postId) {
    // від поста йдемо до його джерела: порівнювати треба на ТОМУ САМОМУ вході, з якого пост і зробили
    const r = await one<{ id: string; title: string; transcript: string; origin: string }>(
      `select s.id, coalesce(s.title,'') as title, coalesce(s.transcript,'') as transcript, coalesce(s.origin,'') as origin
         from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
        where p.id=$1 and s.workspace_id=$2`, [opts.postId, workspaceId]);
    if (!r) throw new Error("У поста немає вихідного матеріалу");
    return r;
  }
  const text = String(opts.text || "").trim();
  if (text.length < 80) throw new Error("Замало матеріалу: встав хоча б кілька абзаців");
  return { id: null as string | null, title: "власний текст", transcript: text, origin: "" };
}

export async function runAbTest(
  workspaceId: string,
  opts: { sourceId?: string; postId?: string; text?: string; models: string[]; count?: number }
): Promise<AbResult> {
  const models = [...new Set((opts.models || []).map((m) => String(m).trim()).filter(Boolean))].slice(0, MAX_MODELS);
  if (models.length < 2) throw new Error("Обери щонайменше дві моделі - інакше нема з чим порівнювати");
  const count = Math.max(1, Math.min(MAX_COUNT, Number(opts.count) || 1));
  const mat = await resolveMaterial(workspaceId, opts);

  // ОДИН промт на всіх (див. коментар угорі). origin передаємо теперішній - режим «з власних слів
  // автора» для щоденника мусить бути таким самим, як у бою.
  const { system } = await buildLitePrompt(workspaceId, count, undefined, undefined, mat.origin);
  const user = `Вхідний матеріал:\n---\n${mat.transcript}`;
  const maxTokens = Math.min(8000, 700 + count * 500);

  // паралельно: послідовно 4 моделі × кілька постів - це хвилини очікування на екрані
  const variants = await Promise.all(models.map(async (model): Promise<AbVariant> => {
    const usage: UsageOut = { prompt_tokens: 0, completion_tokens: 0, cost: 0, costKnown: false };
    const t0 = Date.now();
    try {
      const out = await chat(model, system, user, { workspaceId, step: "abtest", maxTokens, usage });
      const posts = parseLitePosts(out);
      return {
        model, ok: posts.length > 0, posts, ms: Date.now() - t0,
        // порожній розбір - це ТЕЖ результат порівняння (модель не тримає наш JSON-контракт),
        // тож не ховаємо його за загальною помилкою, а називаємо прямо
        error: posts.length ? undefined : "модель не повернула валідний JSON за нашим контрактом",
        ...usage,
      };
    } catch (e: any) {
      return { model, ok: false, error: String(e?.message || e).slice(0, 300), posts: [], ms: Date.now() - t0, ...usage };
    }
  }));

  return {
    material: { id: mat.id, title: mat.title || "без назви", chars: mat.transcript.length },
    prompt: { chars: system.length, system },
    count,
    variants,
  };
}

// ---------------------------------------------------------------- каталог моделей
// Список моделей тягнемо з ПУБЛІЧНОГО /models OpenRouter (ключ не потрібен), а не тримаємо
// захардкоджений: слаги й ціни змінюються щомісяця, а застарілий список у коді - це або «моделі нема»,
// або неправдива ціна. Кеш на 6 годин; якщо мережа недоступна - віддаємо мінімальний фолбек із тих
// моделей, які застосунок і так використовує.
type CatalogRow = { id: string; name: string; in: number; out: number; ctx: number };
let catalogCache: { at: number; rows: CatalogRow[] } | null = null;
const CATALOG_TTL = 6 * 3600 * 1000;
const CATALOG_FALLBACK: CatalogRow[] = [
  { id: "openai/gpt-4o", name: "GPT-4o", in: 2.5, out: 10, ctx: 128000 },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini", in: 0.15, out: 0.6, ctx: 128000 },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", in: 0, out: 0, ctx: 1000000 },
];

export async function modelCatalog(): Promise<{ rows: CatalogRow[]; live: boolean }> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return { rows: catalogCache.rows, live: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
    if (!res.ok) throw new Error("openrouter /models " + res.status);
    const j: any = await res.json();
    const rows: CatalogRow[] = (j.data || [])
      // лише текстові чат-моделі великих лабораторій: у повному каталозі понад 300 позицій,
      // і випадаючий список із них - не вибір, а стіна
      .filter((m: any) => /^(openai|anthropic|google|x-ai|meta-llama|mistralai|deepseek|qwen)\//.test(String(m.id || "")))
      .filter((m: any) => (m.architecture?.output_modalities || ["text"]).includes("text"))
      .map((m: any) => ({
        id: String(m.id),
        name: String(m.name || m.id),
        in: Math.round((Number(m.pricing?.prompt) || 0) * 1e6 * 1000) / 1000,     // $/1M токенів
        out: Math.round((Number(m.pricing?.completion) || 0) * 1e6 * 1000) / 1000,
        ctx: Number(m.context_length) || 0,
      }))
      .sort((a: CatalogRow, b: CatalogRow) => a.id.localeCompare(b.id));
    if (!rows.length) throw new Error("порожній каталог");
    catalogCache = { at: Date.now(), rows };
    return { rows, live: true };
  } catch {
    return { rows: CATALOG_FALLBACK, live: false };
  } finally { clearTimeout(timer); }
}

// Скільки експерименти вже коштували (щоб порівняння моделей не було «безкоштовним» на вигляд).
export async function abSpend(workspaceId: string): Promise<{ calls: number; cost: number }> {
  const r = await one<{ calls: string; cost: string }>(
    `select count(*)::text as calls, coalesce(sum(cost),0)::text as cost from llm_usage where workspace_id=$1 and step='abtest'`,
    [workspaceId]);
  return { calls: Number(r?.calls || 0), cost: Number(r?.cost || 0) };
}
