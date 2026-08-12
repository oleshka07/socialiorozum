// kie.ai - шлюз до чужих генеративних моделей (відео, зображення) під одним ключем.
//
// Навіщо він нам: наші три провайдери зображень захардкоджені (gpt-image-1 / FLUX / Nano Banana),
// а рілси беруть візуал зі стоку Pexels. kie.ai дає доступ до свіжих моделей БЕЗ окремого
// підключення до кожного вендора - тобто «спробувати кращу модель» перестає бути окремим проєктом.
//
// Головне архітектурне рішення, підглянуте в VelsVisual: **списку моделей у коді НЕМА**.
// Каталог і ціни тягнуться з живого прайса kie.ai, бо захардкоджений перелік застаріє за місяць
// і - що гірше - брехатиме про ціну. Той самий урок, що з версією LinkedIn і з `fixUnsupportedParam`.
import { env } from "./env.js";

const BASE = "https://api.kie.ai";
const PRICING_URL = `${BASE}/client/v1/model-pricing/page`;
// Курс на випадок, коли запис прайса не має usdPrice. 1 кредит = $0.005 (публічна сторінка цін).
export const USD_PER_CREDIT = 0.005;

export type KieModel = {
  id: string;            // slug моделі, напр. "google/veo3-fast"
  category: "image" | "video" | "audio";
  description: string;
  credits: number;
  usd: number;           // ціна ОДНІЄЇ генерації
  unit: string;          // за що саме береться ціна ("per video", "per 1080p image"…)
  provider: string;
};

export function kieReady(): boolean { return !!env.kie.apiKey; }

// ---- конверт відповіді kie: {code, msg, data}; успіх - code === 200 ----
async function kieFetch(path: string, init: RequestInit, timeoutMs = 60000): Promise<any> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.kie.apiKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let j: any;
  try { j = await res.json(); } catch { throw new Error(`kie.ai HTTP ${res.status}`); }
  if (j?.code === 200) return j.data;
  const msg = String(j?.msg || j?.message || `HTTP ${res.status}`);
  if (j?.code === 401) throw new Error("kie.ai: ключ не приймається - перевір KIE_API_KEY в адмінці");
  if (j?.code === 402) throw new Error("kie.ai: вичерпані кредити - поповни баланс у кабінеті kie.ai");
  throw new Error(`kie.ai (${j?.code ?? res.status}): ${msg.slice(0, 200)}`);
}

/** Баланс кредитів акаунта - щоб «ключ доданий» означало «і він працює». */
export async function kieCredits(): Promise<number | null> {
  try {
    const d = await kieFetch("/api/v1/chat/credit", { method: "GET" }, 20000);
    const n = typeof d === "number" ? d : Number(d?.credit ?? d?.credits ?? d?.balance);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// ---- каталог і ціни (публічний ендпоінт, ключ не потрібен) ----
const CATEGORY_BY_INTERFACE: Record<string, KieModel["category"]> = { image: "image", video: "video", music: "audio" };
let priceCache: { at: number; models: KieModel[] } | null = null;
const PRICE_TTL = 6 * 60 * 60 * 1000;

export function modelIdFromAnchor(anchor: string): string {
  const m = /[?&]model=([^&]+)/.exec(anchor || "");
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

export function normalizeRecord(raw: any): KieModel | null {
  const category = CATEGORY_BY_INTERFACE[String(raw?.interfaceType || "").toLowerCase()];
  if (!category) return null;                 // chat-моделі нас тут не цікавлять
  const credits = Number(raw.creditPrice);
  if (!Number.isFinite(credits)) return null;
  const usdRaw = Number(raw.usdPrice);
  const usd = raw.usdPrice !== undefined && raw.usdPrice !== null && raw.usdPrice !== "" && Number.isFinite(usdRaw)
    ? usdRaw : credits * USD_PER_CREDIT;
  const id = modelIdFromAnchor(String(raw.anchor || ""));
  if (!id) return null;
  return {
    id, category, description: String(raw.modelDescription || ""),
    credits, usd, unit: String(raw.creditUnit || ""), provider: String(raw.provider || ""),
  };
}

/** Живий каталог моделей із цінами. Кеш 6 год; при недоступності мережі віддаємо старий кеш. */
export async function kieCatalog(): Promise<KieModel[]> {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL) return priceCache.models;
  const out: KieModel[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const res = await fetch(PRICING_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageNum: page, pageSize: 100, modelDescription: "", interfaceType: "" }),
        signal: AbortSignal.timeout(20000),
      });
      const j: any = await res.json();
      if (j?.code !== 200 || !j.data) break;
      const records: any[] = j.data.records || j.data.list || (Array.isArray(j.data) ? j.data : []);
      for (const r of records) { const m = normalizeRecord(r); if (m) out.push(m); }
      if (records.length < 100) break;
    }
  } catch { /* нижче віддамо старий кеш */ }
  if (!out.length) return priceCache?.models || [];
  // одна модель може мати кілька записів (роздільність/режим) - лишаємо найдешевший як орієнтир
  const best = new Map<string, KieModel>();
  for (const m of out) { const cur = best.get(m.id); if (!cur || m.usd < cur.usd) best.set(m.id, m); }
  const models = [...best.values()].sort((a, b) => a.usd - b.usd);
  priceCache = { at: Date.now(), models };
  return models;
}

// ---- генерація: створити задачу → дочекатись результату ----
type CreateOpts = { timeoutMs?: number; pollMs?: number };

async function createTask(model: string, input: Record<string, unknown>): Promise<string> {
  const d = await kieFetch("/api/v1/jobs/createTask", { method: "POST", body: JSON.stringify({ model, input }) }, 60000);
  const id = d?.taskId || d?.task_id || d?.id;
  if (!id) throw new Error("kie.ai: не повернув taskId");
  return String(id);
}

async function taskResult(taskId: string): Promise<{ state: "pending" | "success" | "fail"; urls: string[]; error?: string }> {
  const d = await kieFetch(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { method: "GET" }, 30000);
  if (d?.state === "success") {
    let urls: string[] = [];
    try { urls = JSON.parse(d.resultJson || "{}").resultUrls || []; } catch { urls = []; }
    return { state: "success", urls };
  }
  if (d?.state === "fail") return { state: "fail", urls: [], error: d.failMsg || "генерація не вдалася" };
  return { state: "pending", urls: [] };
}

/**
 * Згенерувати і дочекатись. Параметри моделей у kie різні, а списку схем ми не тримаємо
 * (він так само застаріє), тож діємо як `fixUnsupportedParam` у LLM-шарі: шлемо повний набір,
 * а на скаргу валідації (422) повторюємо лише з `prompt`. Це дешевше й чесніше за спробу
 * вгадати схему кожної моделі наперед.
 */
export async function kieGenerate(model: string, input: Record<string, unknown>, opts: CreateOpts = {}): Promise<string[]> {
  if (!kieReady()) throw new Error("Не доданий ключ kie.ai - Налаштування → Профіль → Ключі провайдерів");
  let taskId: string;
  try {
    taskId = await createTask(model, input);
  } catch (e: any) {
    if (!/422|валідац|invalid|unsupported|param/i.test(String(e.message)) || !input.prompt) throw e;
    taskId = await createTask(model, { prompt: input.prompt });
  }
  const timeoutMs = opts.timeoutMs ?? 8 * 60 * 1000;
  const pollMs = opts.pollMs ?? 5000;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, pollMs));
    const st = await taskResult(taskId);
    if (st.state === "success") {
      if (!st.urls.length) throw new Error("kie.ai: задача успішна, але без результату");
      return st.urls;
    }
    if (st.state === "fail") throw new Error(`kie.ai: ${st.error}`);
  }
  throw new Error(`kie.ai: модель не встигла за ${Math.round(timeoutMs / 1000)}с`);
}
