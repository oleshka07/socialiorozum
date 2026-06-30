import { createHash } from "node:crypto";
import { q, one } from "./db.js";
import { chat, extractJsonArray, extractJsonObject } from "./openrouter.js";

// порядок кроків кишки (strategy = v2)
export const STEP_ORDER = ["extract_ideas", "drafts", "tone", "format", "deai", "strategy"] as const;
export type StepKey = (typeof STEP_ORDER)[number];

// РЕДАГОВАНІ промпти — ЛИШЕ обробка/стилістика. Технічну частину (формат JSON, контекст бренду)
// додає код нижче (STEP_CONTEXT/STEP_FORMAT), щоб правки промпта не ламали парсинг.
export const DEFAULT_PROMPTS: Record<StepKey, { model: string; content: string }> = {
  extract_ideas: {
    model: "openai/gpt-4o-mini",
    content: "Ти контент-стратег. Знайди в транскрипті окремі контент-ідеї, кожна зі своїм кутом подачі.",
  },
  drafts: {
    model: "anthropic/claude-sonnet-4.5",
    content:
      "Зроби пост СУВОРО на основі змісту сесії (першоджерело нижче) — використовуй конкретні приклади, думки й формулювання саме з неї, не вигадуй загальних порад «з повітря». " +
      "Структура: гачок, 2-4 абзаци користі, м'який заклик. Поверни лише текст поста.",
  },
  tone: {
    model: "anthropic/claude-sonnet-4.5",
    content: "Перепиши пост у голосі бренду, не змінюючи зміст. Поверни лише текст.",
  },
  format: {
    model: "openai/gpt-4o-mini",
    content: "Зроби чистий, готовий до публікації формат: короткі абзаци, помірні емодзі. Поверни лише текст.",
  },
  deai: {
    model: "anthropic/claude-sonnet-4.5",
    content: "Прибери ознаки AI. Збережи зміст, голос і формат (абзаци, емодзі, хештеги). Поверни лише текст.",
  },
  strategy: {
    model: "openai/gpt-4o-mini",
    content: "Признач кожному готовому посту (по порядку) тип і рекомендований зсув у днях від старту, спираючись на контент-стратегію.",
  },
};

// ХАРДКОД (не редагується юзером): контекст бренду + контракт формату відповіді.
const STEP_CONTEXT: Record<StepKey, (s: Record<string, string>) => string> = {
  extract_ideas: (s) => (s.marketing_context ? `\n\nКонтекст бренду й аудиторії: ${s.marketing_context}` : ""),
  drafts:        (s) => (s.marketing_context ? `\n\nКонтекст бренду й аудиторії: ${s.marketing_context}` : ""),
  tone:          (s) => (s.tone_of_voice ? `\n\nГолос бренду (Tone of Voice): ${s.tone_of_voice}` : ""),
  format:        () => "",
  deai:          (s) => (s.deai_rules ? `\n\nПравила де-AI: ${s.deai_rules}` : ""),
  strategy:      (s) => (s.content_strategy ? `\n\nКонтент-стратегія: ${s.content_strategy}` : ""),
};
const STEP_FORMAT: Partial<Record<StepKey, string>> = {
  extract_ideas: `\n\nПоверни ЛИШЕ валідний JSON-масив, без жодного тексту довкола: [{"idea":"...","angle":"..."}]`,
  strategy: `\n\nПоверни ЛИШЕ валідний JSON-масив рівно по одному обʼєкту на пост, у тому ж порядку: [{"type":"користь|історія|рефлексія|заклик","dayOffset":0}]`,
};

// Вивести tone of voice із прикладів постів (Базa бренду). Пропонує (пише в tone_of_voice_derived), не чіпає tone_of_voice.
export async function deriveVoice(workspaceId: string): Promise<string> {
  const settings = await loadSettings(workspaceId);
  const examples = (settings.voice_examples || "").trim();
  if (!examples) throw new Error("Спершу встав 3-5 прикладів постів");
  const lang = (settings.output_language || "Українська").trim();
  const system =
    "Проаналізуй приклади постів автора і стисло опиши його tone of voice (голос бренду): звертання (ти/ви), тон, характерну лексику й ритм, що робить голос впізнаваним і чого уникати. 4-6 речень суцільним описом, без преамбул і списків — щоб вставити як інструкцію для AI." +
    `\n\nМова опису: ${lang}.`;
  const derived = await chat("anthropic/claude-sonnet-4.5", system, `Приклади постів:\n---\n${examples}`, { workspaceId, step: "tone" });
  await q(
    `insert into settings_block(workspace_id, key, content) values($1,'tone_of_voice_derived',$2)
     on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
    [workspaceId, derived]
  );
  return derived;
}

// Згенерувати контент-стратегію (L2) із Бази бренду. Зберігає у strategy.data (draft).
// Аналіз реальних постів автора (Instagram) -> ніша/аудиторія, голос, контент-нотатки, мова. Один виклик.
export async function deriveBrandFromText(workspaceId: string, text: string): Promise<{ tone_of_voice: string; marketing_context: string; content_strategy: string; language: string }> {
  const system = "Проаналізуй реальні пости автора нижче й поверни:\n" +
    "1) marketing_context — ніша, тематика й цільова аудиторія (2-4 речення);\n" +
    "2) tone_of_voice — стислий опис тону й стилю автора;\n" +
    "3) content_strategy — короткі нотатки про теми/рубрики, які варто публікувати;\n" +
    "4) language — мова, якою переважно пише автор (назва УКРАЇНСЬКОЮ, напр.: Українська, Англійська, Чеська, Польська, Німецька, Іспанська, Французька, Італійська).\n" +
    "Поверни ЛИШЕ валідний JSON: {\"marketing_context\":\"…\",\"tone_of_voice\":\"…\",\"content_strategy\":\"…\",\"language\":\"…\"}.";
  const raw = await chat("openai/gpt-4o-mini", system, "Пости автора:\n---\n" + text.slice(0, 12000), { workspaceId, step: "derive_brand" });
  const o = (extractJsonObject<any>(raw)) || {};
  return {
    tone_of_voice: String(o.tone_of_voice || "").trim(),
    marketing_context: String(o.marketing_context || "").trim(),
    content_strategy: String(o.content_strategy || "").trim(),
    language: String(o.language || "").trim(),
  };
}

export async function generateStrategy(workspaceId: string): Promise<any> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const system =
    "Ти контент-стратег. На основі ніші, аудиторії й голосу бренду згенеруй контент-стратегію. " +
    'Поверни ЛИШЕ валідний JSON-обʼєкт: {"rubrics":[{"name":"...","emoji":"...","description":"...","share":40}],' +
    '"frequency":{"posts_per_week":4},"best_days":["mon","wed","fri"],"times":["11:00","18:00"],' +
    '"channels":["telegram"],"schedule_rationale":"чому саме ці дні й час для цієї ніші та каналу","monthly_themes":["...","..."]}. ' +
    "4-6 рубрик, сума share = 100. Дні й час публікацій підбери за найкращими практиками саме для цієї ніші та каналу: " +
    "best_days — короткі коди (пн=mon … нд=sun); times — формат HH:MM, 1-3 значення (скільки значень — стільки постів на день)." +
    `\n\nМова текстів (rubrics, schedule_rationale, monthly_themes): ${lang}.`;
  const user = `Ніша й аудиторія: ${s.marketing_context || ""}\nГолос бренду: ${s.tone_of_voice || ""}\nНотатки стратегії: ${s.content_strategy || ""}`;
  const raw = await chat("openai/gpt-4o-mini", system, user, { workspaceId, step: "strategy" });
  const parsed = extractJsonObject(raw);
  await q(
    `insert into strategy(workspace_id,data,status,updated_at) values($1,$2,'draft',now())
     on conflict (workspace_id) do update set data=excluded.data, status='draft', updated_at=now()`,
    [workspaceId, JSON.stringify(parsed)]
  );
  return parsed;
}

async function loadSettings(workspaceId: string): Promise<Record<string, string>> {
  const rows = await q<{ key: string; content: string }>(
    `select key, content from settings_block where workspace_id=$1`,
    [workspaceId]
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.content]));
}

function fillPrompt(t: string, settings: Record<string, string>): string {
  return t.replace(/\{\{(\w+)\}\}/g, (_, k) => settings[k] ?? "");
}

async function resolvePrompt(workspaceId: string, step: StepKey) {
  const tpl = await one<{ content: string; model: string; version: number }>(
    `select content, model, version from prompt_template
     where workspace_id=$1 and step_key=$2 and is_active=true
     order by version desc limit 1`,
    [workspaceId, step]
  );
  return tpl ?? { ...DEFAULT_PROMPTS[step], version: 0 };
}

function hash(s: string) {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

// контекст прогону
async function runContext(runId: string) {
  const row = await one<{ source_id: string; workspace_id: string; transcript: string }>(
    `select r.source_id, s.workspace_id, s.transcript
     from pipeline_run r join source s on s.id=r.source_id where r.id=$1`,
    [runId]
  );
  if (!row) throw new Error("run не знайдено");
  // Кап вхідного матеріалу: gpt-4o на Tier-1 OpenAI має ліміт 30k токенів/хв (TPM). Повний транскрипт
  // (години розмови) не влазить у один запит → 429 "Request too large". ~32k символів (≈12-20k токенів)
  // більш ніж достатньо, щоб згенерувати пости, і лишає запас під TPM.
  if (row.transcript && row.transcript.length > 32000) row.transcript = row.transcript.slice(0, 32000);
  return row;
}

const stageOf: Record<string, string> = { drafts: "draft", tone: "toned", format: "formatted", deai: "final" };

async function getPosts(runId: string, stage: string) {
  return q<{ id: string; content: string }>(
    `select id, content from post where run_id=$1 and stage=$2 order by created_at`,
    [runId, stage]
  );
}

async function upsertStepRun(runId: string, step: StepKey, patch: any) {
  await q(
    `insert into step_run(run_id, step_key, model, prompt_version, input_hash, status, output, error, updated_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (run_id, step_key) do update set
       model=excluded.model, prompt_version=excluded.prompt_version, input_hash=excluded.input_hash,
       status=excluded.status, output=excluded.output, error=excluded.error, updated_at=now()`,
    [runId, step, patch.model ?? null, patch.prompt_version ?? null, patch.input_hash ?? null,
     patch.status, patch.output ? JSON.stringify(patch.output) : null, patch.error ?? null]
  );
}

// позначити всі наступні кроки як stale
async function markDownstreamStale(runId: string, step: StepKey) {
  const idx = STEP_ORDER.indexOf(step);
  const downstream = STEP_ORDER.slice(idx + 1);
  if (!downstream.length) return;
  await q(
    `update step_run set status='stale', updated_at=now()
     where run_id=$1 and step_key = any($2) and status <> 'idle'`,
    [runId, downstream]
  );
}

/** Виконати один крок кишки, зберегти результат, позначити downstream як stale. */
export async function executeStep(runId: string, step: StepKey, opts?: { count?: number; rubrics?: string[] }) {
  const { workspace_id, transcript } = await runContext(runId);
  const settings = await loadSettings(workspace_id);
  const tpl = await resolvePrompt(workspace_id, step);
  const lang = (settings.output_language || "Українська").trim();
  let rubricsText = "", countText = "";
  if (step === "extract_ideas" || step === "drafts" || step === "strategy") {
    let rubs = await q<{ name: string; share: number; description: string }>(
      `select name, share, description from rubric where workspace_id=$1 order by idx`, [workspace_id]);
    if (step === "extract_ideas" && Array.isArray(opts?.rubrics) && opts!.rubrics.length)
      rubs = rubs.filter((r) => opts!.rubrics!.includes(r.name));
    if (rubs.length) rubricsText = "\n\nРубрики контенту (орієнтир для тем і пропорцій у наборі постів): " +
      rubs.map((r) => `${r.name} ~${r.share}%${r.description ? ` (${r.description})` : ""}`).join("; ") + ".";
  }
  if (step === "extract_ideas") countText = `\n\nЗнайди до ${Math.max(1, Math.min(12, Number(opts?.count) || 6))} контент-ідей.`;
  const system = fillPrompt(tpl.content, settings) + STEP_CONTEXT[step](settings) + (STEP_FORMAT[step] || "")
    + countText + `\n\nМова всього тексту у відповіді: ${lang}.` + rubricsText;
  const ctx = { workspaceId: workspace_id, step };
  await upsertStepRun(runId, step, { status: "running", model: tpl.model, prompt_version: tpl.version });

  try {
    if (step === "extract_ideas") {
      const out = await chat(tpl.model, system, `Транскрипт:\n---\n${transcript}`, ctx);
      const ideas = extractJsonArray<{ idea: string; angle?: string }>(out);
      await q(`delete from idea where run_id=$1`, [runId]);
      for (let i = 0; i < ideas.length; i++)
        await q(`insert into idea(run_id, idx, idea, angle, selected) values($1,$2,$3,$4,true)`,
          [runId, i, ideas[i].idea, ideas[i].angle ?? ""]);
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version,
        input_hash: hash(transcript), output: ideas });
    } else if (step === "drafts") {
      const ideas = await q<{ id: string; idea: string; angle: string }>(
        `select id, idea, angle from idea where run_id=$1 and selected=true order by idx`, [runId]);
      if (!ideas.length) throw new Error("немає відібраних ідей");
      await q(`delete from post where run_id=$1 and stage='draft'`, [runId]);
      const outs: string[] = [];
      for (const it of ideas) {
        const txt = await chat(tpl.model, system,
          `Зміст сесії (першоджерело):\n---\n${transcript}\n---\nЗроби пост за цією ідеєю, спираючись на конкретику сесії вище:\nІдея: ${it.idea}\nКут: ${it.angle}`, ctx);
        outs.push(txt);
        await q(`insert into post(run_id, idea_id, stage, content) values($1,$2,'draft',$3)`,
          [runId, it.id, txt]);
      }
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version, output: outs });
    } else if (step === "tone" || step === "format" || step === "deai") {
      const inputStage = step === "tone" ? "draft" : step === "format" ? "toned" : "formatted";
      const stage = stageOf[step];
      const src = await getPosts(runId, inputStage);
      if (!src.length) throw new Error(`немає вхідних постів стадії ${inputStage}`);
      await q(`delete from post where run_id=$1 and stage=$2`, [runId, stage]);
      const outs: string[] = [];
      for (const p of src) {
        const txt = await chat(tpl.model, system, `---\n${p.content}`, ctx);
        outs.push(txt);
        await q(`insert into post(run_id, stage, content) values($1,$2,$3)`, [runId, stage, txt]);
      }
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version, output: outs });
    } else if (step === "strategy") {
      const finals = await getPosts(runId, "final");
      if (!finals.length) throw new Error("немає фінальних постів");
      // AI радить лише тип і день для КОЖНОГО готового поста (по порядку) — самі пости не змінюємо
      const out = await chat(tpl.model, system,
        "Готові пости (по порядку):\n" + finals.map((p, i) => `[${i}] ${p.content}`).join("\n\n"), ctx);
      let advice: { type?: string; dayOffset?: number }[] = [];
      try { advice = extractJsonArray<{ type?: string; dayOffset?: number }>(out); } catch { advice = []; }
      await q(`delete from content_plan where run_id=$1`, [runId]);
      const cp = await one<{ id: string }>(`insert into content_plan(run_id) values($1) returning id`, [runId]);
      for (let i = 0; i < finals.length; i++) {
        const a = advice[i] ?? {};
        const title = (finals[i].content.split("\n")[0] || `Пост ${i + 1}`).slice(0, 80);
        await q(`insert into plan_item(plan_id, post_id, title, type, day_offset) values($1,$2,$3,$4,$5)`,
          [cp!.id, finals[i].id, title, a.type ?? null, a.dayOffset ?? i * 2]);
      }
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version, output: advice });
    }

    await markDownstreamStale(runId, step);
    return { ok: true };
  } catch (e: any) {
    await upsertStepRun(runId, step, { status: "error", error: e.message, model: tpl.model });
    throw e;
  }
}

/** Перегенерувати один текст через промпт/модель заданого кроку (для кнопки «Перегенерувати»). */
export async function rewriteWithStep(workspaceId: string, step: StepKey, text: string): Promise<string> {
  const settings = await loadSettings(workspaceId);
  const tpl = await resolvePrompt(workspaceId, step);
  const lang = (settings.output_language || "Українська").trim();
  const system = fillPrompt(tpl.content, settings) + STEP_CONTEXT[step](settings) + `\n\nМова всього тексту у відповіді: ${lang}.`;
  return chat(tpl.model, system, `---\n${text}`, { workspaceId, step });
}

// AI-адаптація поста під кожну соцмережу (один виклик -> JSON {channel: text})
export async function adaptForChannels(workspaceId: string, content: string, channels: string[]): Promise<Record<string, string>> {
  const rules: Record<string, string> = {
    telegram: "Telegram: короткі абзаци, помірні емодзі, 1-2 хештеги.",
    instagram: "Instagram: чіпкий підпис + 5-10 релевантних хештегів наприкінці.",
    threads: "Threads: до 500 символів, без хештегів, розмовний тон.",
    facebook: "Facebook: 1-3 абзаци, нейтральний тон, без надлишку хештегів.",
  };
  const want = channels.filter((c) => rules[c]);
  if (!want.length) return {};
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const tone = s.tone_of_voice ? `\nГолос бренду (зберігай): ${s.tone_of_voice}` : "";
  const deai = s.deai_rules ? `\nПравила «без AI» (зберігай): ${s.deai_rules}` : "";
  const system = "Адаптуй пост під кожну вказану соцмережу, зберігаючи зміст, голос бренду й живу людську мову." + tone + deai +
    "\nПравила:\n" + want.map((c) => "- " + rules[c]).join("\n") +
    `\n\nПоверни ЛИШЕ валідний JSON-обʼєкт виду {${want.map((c) => `"${c}":"…"`).join(",")}}. Мова: ${lang}.`;
  const raw = await chat("openai/gpt-4o-mini", system, `Пост:\n---\n${content}`, { workspaceId, step: "format" });
  const obj = extractJsonObject(raw) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const c of want) if (obj && obj[c]) out[c] = String(obj[c]);
  return out;
}

// ---- LITE: один зібраний промт (усі кроки кишки в одному) ----
// Зібрати спільний системний промт Lite-генерації (для самої генерації + для перегляду користувачем).
export async function buildLitePrompt(workspaceId: string, count: number, ideas?: string[]): Promise<{ system: string; model: string }> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const rubs = await q<{ name: string; share: number; description: string }>(
    `select name, share, description from rubric where workspace_id=$1 order by idx`, [workspaceId]);
  const rubricsText = rubs.length
    ? "\n\nРубрики (орієнтир тем і пропорцій у наборі): " + rubs.map((r) => `${r.name} ~${r.share}%${r.description ? ` (${r.description})` : ""}`).join("; ") + "."
    : "";
  const ideasText = (ideas && ideas.length)
    ? "\n\nНапиши рівно по ОДНОМУ посту на кожну з цих тем (у тому ж порядку):\n" + ideas.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "";
  const n = ideas && ideas.length ? ideas.length : count;
  const system =
    "Ти досвідчений SMM-копірайтер. За вхідним матеріалом нижче згенеруй готові до публікації пости. " +
    "Кожен пост ОДРАЗУ фінальний: у голосі бренду, живою людською мовою без ознак AI (без канцеляризмів, без «варто зазначити/у сучасному світі», без шаблонних списків заради списків), з чітким гачком, користю та мʼяким закликом." +
    (s.marketing_context ? `\n\nБренд і аудиторія: ${s.marketing_context}` : "") +
    (s.tone_of_voice ? `\n\nГолос бренду (суворо дотримуйся): ${s.tone_of_voice}` : "") +
    (s.deai_rules ? `\n\nПравила «без AI»: ${s.deai_rules}` : "") +
    rubricsText + ideasText +
    `\n\nЗгенеруй рівно ${n} різних постів. Поверни ЛИШЕ валідний JSON-масив обʼєктів: [{"text":"повний текст поста","image_prompt":"короткий опис зображення англійською для генерації — сцена/обʼєкти/настрій, без тексту на зображенні"}, …]. Мова текстів постів: ${lang}.`;
  return { system, model: "openai/gpt-4o" };
}

// Lite-генерація: ОДИН виклик LLM -> N готових постів (замість 5 кроків кишки).
export async function generatePostsOnePass(runId: string, count: number, ideas?: string[]): Promise<number> {
  const { workspace_id, transcript } = await runContext(runId);
  const sel = (ideas || []).map((t) => String(t).trim()).filter(Boolean);
  const n = Math.max(1, Math.min(12, sel.length ? sel.length : (Number(count) || 6)));
  const { system, model } = await buildLitePrompt(workspace_id, n, sel.length ? sel : undefined);
  const out = await chat(model, system, `Вхідний матеріал:\n---\n${transcript}`, { workspaceId: workspace_id, step: "lite" });
  let posts: { text: string; image_prompt: string }[] = [];
  try {
    posts = extractJsonArray<any>(out).map((x) => typeof x === "string"
      ? { text: x, image_prompt: "" }
      : { text: String(x?.text || x?.content || x?.post || ""), image_prompt: String(x?.image_prompt || x?.image || "") })
      .map((p) => ({ text: p.text.trim(), image_prompt: p.image_prompt.trim() })).filter((p) => p.text);
  } catch { posts = []; }
  if (!posts.length) throw new Error("Не вдалося згенерувати пости (порожня відповідь моделі)");
  await q(`delete from post where run_id=$1 and stage='final'`, [runId]);
  for (const p of posts) await q(`insert into post(run_id, stage, content, image_prompt) values($1,'final',$2,$3)`, [runId, p.text, p.image_prompt || null]);
  return posts.length;
}

// Перегенерація одного поста зі СПІЛЬНИМ контекстом (голос + де-AI) — для кнопки «Переробити».
export async function rewritePost(workspaceId: string, text: string): Promise<string> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const system = "Перепиши цей пост іншими словами, зберігаючи зміст і структуру, у голосі бренду й живою людською мовою (без ознак AI)." +
    (s.tone_of_voice ? `\n\nГолос бренду: ${s.tone_of_voice}` : "") +
    (s.deai_rules ? `\n\nПравила «без AI»: ${s.deai_rules}` : "") +
    `\n\nПоверни лише текст поста. Мова: ${lang}.`;
  return chat("openai/gpt-4o", system, `---\n${text}`, { workspaceId, step: "regenerate" });
}
