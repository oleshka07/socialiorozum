import { createHash } from "node:crypto";
import { q, one } from "./db.js";
import { chat, extractJsonArray, extractJsonObject } from "./openrouter.js";

// порядок кроків кишки (strategy = v2)
export const STEP_ORDER = ["extract_ideas", "drafts", "tone", "format", "deai", "strategy"] as const;
export type StepKey = (typeof STEP_ORDER)[number];

// РЕДАГОВАНІ промпти - ЛИШЕ обробка/стилістика. Технічну частину (формат JSON, контекст бренду)
// додає код нижче (STEP_CONTEXT/STEP_FORMAT), щоб правки промпта не ламали парсинг.
export const DEFAULT_PROMPTS: Record<StepKey, { model: string; content: string }> = {
  extract_ideas: {
    model: "openai/gpt-4o-mini",
    content: "Ти контент-стратег. Знайди в транскрипті окремі контент-ідеї, кожна зі своїм кутом подачі.",
  },
  drafts: {
    model: "anthropic/claude-sonnet-4.5",
    content:
      "Зроби пост СУВОРО на основі змісту сесії (першоджерело нижче) - використовуй конкретні приклади, думки й формулювання саме з неї, не вигадуй загальних порад «з повітря». " +
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

// Наскрізне правило стилю для ВСІЄЇ генерації тексту: широке тире («—») - типовий AI-маркер.
const NO_DASH_RULE = "\n\nПунктуація: НІКОЛИ не використовуй широке тире («—») чи середнє тире («–») у тексті. Замінюй їх комою, двокрапкою, дефісом або розбивай на окремі речення.";

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
    "Проаналізуй приклади постів автора і опиши його tone of voice (голос бренду) СТРУКТУРОВАНО, як робочу інструкцію для AI-копірайтера:\n" +
    "1) Тон і звертання (ти/ви, енергія, дистанція) - 2-3 речення.\n" +
    "2) РОБИ: 5 характерних прийомів автора (ритм, довжина абзаців, як будує гачки, як завершує).\n" +
    "3) НЕ РОБИ: 5 речей, які зламали б цей голос.\n" +
    "4) Фірмова лексика: 5-10 слів/зворотів, які автор реально вживає.\n" +
    "5) Емодзі: які, скільки, де.\n" +
    "Стисло, без преамбул і води." +
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
    "1) marketing_context - ніша, тематика й цільова аудиторія (2-4 речення);\n" +
    "2) tone_of_voice - стислий опис тону й стилю автора;\n" +
    "3) content_strategy - короткі нотатки про теми/рубрики, які варто публікувати;\n" +
    "4) language - мова, якою переважно пише автор (назва УКРАЇНСЬКОЮ, напр.: Українська, Англійська, Чеська, Польська, Німецька, Іспанська, Французька, Італійська).\n" +
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
  if (s.prompt_engine !== "legacy") return generateStrategyV2(workspaceId, s);
  const lang = (s.output_language || "Українська").trim();
  const system =
    "Ти контент-стратег. На основі ніші, аудиторії й голосу бренду згенеруй контент-стратегію. " +
    'Поверни ЛИШЕ валідний JSON-обʼєкт: {"rubrics":[{"name":"...","emoji":"...","description":"...","share":40}],' +
    '"frequency":{"posts_per_week":4},"best_days":["mon","wed","fri"],"times":["11:00","18:00"],' +
    '"channels":["telegram"],"schedule_rationale":"чому саме ці дні й час для цієї ніші та каналу","monthly_themes":["...","..."]}. ' +
    "4-6 рубрик, сума share = 100. Дні й час публікацій підбери за найкращими практиками саме для цієї ніші та каналу: " +
    "best_days - короткі коди (пн=mon … нд=sun); times - формат HH:MM, 1-3 значення (скільки значень - стільки постів на день)." +
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

// ---- V2 (Strategy Brief): єдиний бриф-джерело правди (Prompt 1) ----
// Надбудова над legacy: видає СУПЕРСЕТ JSON (rubrics/best_days/times/channels лишаються,
// щоб календар і рубрики працювали) + поля брифу. Компактний бриф пишеться в settings_block.strategy_brief
// для інʼєкції у Lite та канальні плани. Прапорець: settings_block.prompt_engine='v2'.
async function generateStrategyV2(workspaceId: string, s: Record<string, string>): Promise<any> {
  const lang = (s.output_language || "Українська").trim();
  const system =
    "Ти топовий SMM- і контент-стратег із 15+ роками побудови органічного зростання. " +
    "На основі бізнесу, ніші, аудиторії й голосу бренду побудуй ЄДИНИЙ стратегічний бриф (Strategy Brief) - джерело правди для всього контенту. " +
    "Застосуй перевірені фреймворки: Jobs-to-Be-Done, StoryBrand (клієнт = герой, бренд = провідник), контент-пілери, правило 80/20 (цінність/промо), Hero-Hub-Hygiene (~10/30/60). " +
    "Будь конкретним і рішучим - займай позицію, не лий води. " +
    'Поверни ЛИШЕ валідний JSON-обʼєкт точно такої форми: {' +
    '"positioning":"одне речення позиціювання",' +
    '"differentiators":["…","…","…"],' +
    '"icp":{"audience":"хто це","jtbd":["…"],"pains":["…"],"desires":["…"],"objections":["…"]},' +
    '"brandscript":"герой(клієнт) / його проблема / бренд як провідник / план / заклик / успіх / провал",' +
    '"brand_voice":{"tone":"…","dos":["…"],"donts":["…"]},' +
    '"content_pillars":[{"name":"…","why":"чому виграє","jtbd":"яку задачу закриває","funnel":"awareness|consideration|conversion","angles":["…","…"]}],' +
    '"messaging":{"value_prop":"…","proof_points":["…"],"big_idea":"…"},' +
    '"offers_and_ctas":{"primary_offer":"…","lead_magnet":"…","soft_cta":"…","hard_cta":"…"},' +
    '"value_promotion_ratio":"80/20","hhh_split":"10/30/60",' +
    '"rubrics":[{"name":"…","emoji":"…","description":"…","share":40}],' +
    '"frequency":{"posts_per_week":4},"best_days":["mon","wed","fri"],"times":["11:00","18:00"],' +
    '"channels":["telegram"],"schedule_rationale":"чому саме ці дні й час для цієї ніші та каналу","monthly_themes":["…","…"]' +
    "}. " +
    "3-5 рубрик (узгоджені з content_pillars за темами), сума share = 100. " +
    "best_days - короткі коди (пн=mon … нд=sun); times - формат HH:MM, 1-3 значення." +
    `\n\nМова всіх текстів брифу: ${lang}.`;
  const user =
    `Бізнес, ніша й аудиторія: ${s.marketing_context || ""}\n` +
    `Голос бренду: ${s.tone_of_voice || ""}\n` +
    `Нотатки стратегії: ${s.content_strategy || ""}\n` +
    `Продукти/офери/ціни: ${s.offers_and_prices || ""}`;
  const raw = await chat("openai/gpt-4o", system, user, { workspaceId, step: "strategy" });
  const parsed: any = extractJsonObject(raw) || {};
  await q(
    `insert into strategy(workspace_id,data,status,updated_at) values($1,$2,'draft',now())
     on conflict (workspace_id) do update set data=excluded.data, status='draft', updated_at=now()`,
    [workspaceId, JSON.stringify(parsed)]
  );
  const briefText = renderBriefText(parsed);
  if (briefText)
    await q(
      `insert into settings_block(workspace_id,key,content) values($1,'strategy_brief',$2)
       on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
      [workspaceId, briefText]
    );
  return parsed;
}

// Компактний текстовий рендер брифу для інʼєкції у промти (Lite/канальні плани/атомізація).
function renderBriefText(b: any): string {
  if (!b || typeof b !== "object") return "";
  const arr = (x: any) => (Array.isArray(x) ? x.filter(Boolean).join("; ") : "");
  const pillars = Array.isArray(b.content_pillars)
    ? b.content_pillars.map((p: any) => `${p?.name || ""} (${p?.funnel || ""}: ${arr(p?.angles)})`).filter(Boolean).join(" | ")
    : "";
  const lines = [
    b.positioning && `Позиціювання: ${b.positioning}`,
    Array.isArray(b.differentiators) && b.differentiators.length && `Відмінності: ${arr(b.differentiators)}`,
    b.icp && `Аудиторія: ${b.icp.audience || ""}; болі: ${arr(b.icp.pains)}; бажання: ${arr(b.icp.desires)}; заперечення: ${arr(b.icp.objections)}`,
    b.brand_voice && `Голос: ${b.brand_voice.tone || ""}; робити: ${arr(b.brand_voice.dos)}; уникати: ${arr(b.brand_voice.donts)}`,
    pillars && `Контент-пілери: ${pillars}`,
    b.messaging && `Ключове повідомлення: ${b.messaging.value_prop || ""}; велика ідея: ${b.messaging.big_idea || ""}`,
    b.offers_and_ctas && `Офер: ${b.offers_and_ctas.primary_offer || ""}; лід-магніт: ${b.offers_and_ctas.lead_magnet || ""}; мʼякий CTA: ${b.offers_and_ctas.soft_cta || ""}; жорсткий CTA: ${b.offers_and_ctas.hard_cta || ""}`,
    `Цінність:промо = ${b.value_promotion_ratio || "80/20"}; Hero-Hub-Hygiene = ${b.hhh_split || "10/30/60"}`,
  ].filter(Boolean);
  return lines.join("\n");
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
    + countText + NO_DASH_RULE + `\n\nМова всього тексту у відповіді: ${lang}.` + rubricsText;
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
      // AI радить лише тип і день для КОЖНОГО готового поста (по порядку) - самі пости не змінюємо
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
  const system = fillPrompt(tpl.content, settings) + STEP_CONTEXT[step](settings) + NO_DASH_RULE + `\n\nМова всього тексту у відповіді: ${lang}.`;
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
  const v2 = s.prompt_engine !== "legacy";
  const tone = s.tone_of_voice ? `\nГолос бренду (зберігай): ${s.tone_of_voice}` : "";
  const deai = s.deai_rules ? `\nПравила «без AI» (зберігай): ${s.deai_rules}` : "";
  // V2: адаптація успадковує бриф і ПОВНІ плейбуки каналів (алгоритми 2025-26), не однорядкові правила
  const brief = v2 ? (s.strategy_brief || "").trim() : "";
  const playbooks = v2
    ? "\nПлейбуки каналів (перекладай пост у нативний формат, НЕ вигадуй новий зміст):\n" + want.map((c) => `[${c}] ${CHANNEL_PLAYBOOK[c] || rules[c]}\nФормат: ${rules[c]}`).join("\n")
    : "\nПравила:\n" + want.map((c) => "- " + rules[c]).join("\n");
  const critique = v2 ? "\nПеред видачею перевір кожну версію: гачок працює саме для цього каналу; довжина й формат нативні; голос не зламано. Слабке перепиши." : "";
  const system = "Адаптуй пост під кожну вказану соцмережу, зберігаючи зміст, голос бренду й живу людську мову." +
    (brief ? `\n\n<strategy_brief>\n${brief}\n</strategy_brief>` : "") +
    tone + deai + playbooks + critique +
    NO_DASH_RULE + `\n\nПоверни ЛИШЕ валідний JSON-обʼєкт виду {${want.map((c) => `"${c}":"…"`).join(",")}}. Мова: ${lang}.`;
  const raw = await chat(v2 ? "openai/gpt-4o" : "openai/gpt-4o-mini", system, `Пост:\n---\n${content}`, { workspaceId, step: "format" });
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
  const v2 = s.prompt_engine !== "legacy";
  const outputFormat = `Поверни ЛИШЕ валідний JSON-масив обʼєктів: [{"text":"повний текст поста","image_prompt":"короткий опис зображення англійською для генерації - сцена/обʼєкти/настрій, без тексту на зображенні","rubric":"назва рубрики поста${rubs.length ? " (СТРОГО одна з переліку рубрик вище)" : ""}"}, …]. Мова текстів постів: ${lang}.`;

  if (v2) {
    // V2 (бібліотека промтів): XML-структура + multishot (реальні пости автора) + меню гачків +
    // фреймворк під воронку + само-критика. Порядок секцій: роль → бриф → бренд → зразки → правила → задача → формат.
    const brief = (s.strategy_brief || "").trim();
    const examples = (s.voice_examples || "").trim().slice(0, 3000);
    const system =
      "<role>Ти елітний direct-response копірайтер і SMM-автор із 15+ роками досвіду. Пишеш нативно для соцмереж і НІКОЛИ не звучиш як AI чи «загальний» контент.</role>" +
      (brief ? `\n\n<strategy_brief>\nДжерело правди - не суперечити:\n${brief}\n</strategy_brief>` : "") +
      "\n\n<brand>" +
      (s.marketing_context ? `\nБренд і аудиторія: ${s.marketing_context}` : "") +
      (s.tone_of_voice ? `\nГолос бренду (суворо дотримуйся): ${s.tone_of_voice}` : "") +
      (s.deai_rules ? `\nПравила «без AI»: ${s.deai_rules}` : "") +
      "\n</brand>" +
      (examples ? `\n\n<voice_examples>\nРЕАЛЬНІ пости автора - еталон голосу. Відтворюй ритм, лексику, звертання й розмір абзаців САМЕ як тут, але НЕ копіюй зміст:\n---\n${examples}\n---\n</voice_examples>` : "") +
      "\n\n<rules>" +
      "\n- Кожен пост ОДРАЗУ фінальний: жива людська мова, без канцеляризмів, без «варто зазначити/у сучасному світі», без шаблонних списків заради списків." +
      "\n- Фреймворк під стадію воронки поста: AIDA або PAS - холодна аудиторія (awareness); BAB - короткі залучальні пости; FAB/4P - тепла аудиторія (consideration/conversion)." +
      "\n- Гачок (перший рядок вирішує все): подумки склади 3 варіанти різних типів (цікавісний розрив, патерн-перебій, контр-теза, попередження про помилку, число/список, пряма обіцянка) і залиш у пості НАЙСИЛЬНІШИЙ." +
      "\n- Один чіткий мʼякий заклик на пост, не більше." +
      rubricsText +
      NO_DASH_RULE.replace(/^\n+/, "\n- ") +
      "\n</rules>" +
      `\n\n<task>\nЗгенеруй рівно ${n} різних постів за вхідним матеріалом.${ideasText}\nПеред видачею САМО-КРИТИКА кожного поста за 5 критеріями: (а) гачок зупиняє скрол; (б) голос як у зразках; (в) один чіткий CTA; (г) нативний формат; (д) реальна користь для читача. Усе, що слабке, перепиши до видачі.\n</task>` +
      `\n\n<output_format>\n${outputFormat}\n</output_format>`;
    return { system, model: "openai/gpt-4o" };
  }

  // LEGACY (prompt_engine != v2) - незмінний класичний промт
  const system =
    "Ти досвідчений SMM-копірайтер. За вхідним матеріалом нижче згенеруй готові до публікації пости. " +
    "Кожен пост ОДРАЗУ фінальний: у голосі бренду, живою людською мовою без ознак AI (без канцеляризмів, без «варто зазначити/у сучасному світі», без шаблонних списків заради списків), з чітким гачком, користю та мʼяким закликом." +
    (s.marketing_context ? `\n\nБренд і аудиторія: ${s.marketing_context}` : "") +
    (s.tone_of_voice ? `\n\nГолос бренду (суворо дотримуйся): ${s.tone_of_voice}` : "") +
    (s.deai_rules ? `\n\nПравила «без AI»: ${s.deai_rules}` : "") +
    rubricsText + ideasText +
    NO_DASH_RULE + `\n\nЗгенеруй рівно ${n} різних постів. ${outputFormat}`;
  return { system, model: "openai/gpt-4o" };
}

// Lite-генерація: ОДИН виклик LLM -> N готових постів (замість 5 кроків кишки).
export async function generatePostsOnePass(runId: string, count: number, ideas?: string[]): Promise<number> {
  const { workspace_id, transcript } = await runContext(runId);
  const sel = (ideas || []).map((t) => String(t).trim()).filter(Boolean);
  const n = Math.max(1, Math.min(12, sel.length ? sel.length : (Number(count) || 6)));
  const { system, model } = await buildLitePrompt(workspace_id, n, sel.length ? sel : undefined);
  const out = await chat(model, system, `Вхідний матеріал:\n---\n${transcript}`, { workspaceId: workspace_id, step: "lite" });
  let posts: { text: string; image_prompt: string; rubric: string }[] = [];
  try {
    posts = extractJsonArray<any>(out).map((x) => typeof x === "string"
      ? { text: x, image_prompt: "", rubric: "" }
      : { text: String(x?.text || x?.content || x?.post || ""), image_prompt: String(x?.image_prompt || x?.image || ""), rubric: String(x?.rubric || "") })
      .map((p) => ({ text: p.text.trim(), image_prompt: p.image_prompt.trim(), rubric: p.rubric.trim().slice(0, 60) })).filter((p) => p.text);
  } catch { posts = []; }
  if (!posts.length) throw new Error("Не вдалося згенерувати пости (порожня відповідь моделі)");
  await q(`delete from post where run_id=$1 and stage='final'`, [runId]);
  for (const p of posts) await q(`insert into post(run_id, stage, content, image_prompt, rubric) values($1,'final',$2,$3,$4)`, [runId, p.text, p.image_prompt || null, p.rubric || null]);
  return posts.length;
}

// ---- V2 Крок 3: контент-план по каналах (Prompts 2-7, лише канали socialio) ----
const CHANNEL_PLAYBOOK: Record<string, string> = {
  telegram:
    "Telegram: алгоритмічної стрічки немає - кожен пост іде всім підписникам через push. Завдання - утримання, щільність користі й воронка, не «вірусність». Архітектура: канал (broadcast) + група (спільнота) + бот (лід-магніт/автоматизація). ~80/20 користь/продаж; кілька якісних постів/тиждень > обсяг. Нативні формати: розмітка тексту, опитування, голосові, закріплене повідомлення з офером.",
  instagram:
    "Instagram (Mosseri, 2025): головні сигнали - час перегляду, sends-per-reach (поширення в DM), saves. Reels = охоплення/нові люди; каруселі (до 20 слайдів) = збереження й глибоке залучення; Stories = стосунки. Гачок у перші 3 сек (інакше ~50% відвалюються). Тільки ОРИГІНАЛЬНИЙ контент (без водяних знаків). Ключові слова в підписі (social SEO), 3-5 релевантних тегів.",
  threads:
    "Threads: до 500 символів, розмовний тон, без хештегів. Короткі думки, питання до аудиторії, треди з кількох постів. Заохочуй відповіді (репліки - головний сигнал поширення). Автентичність > полірованість.",
  facebook:
    "Facebook: усе відео тепер Reels (охоплення поза підписниками); зберігання/поширення > лайки; фото добре заходять у стрічці (підписи 40-80 символів). Групи дають значно більше органіки, ніж сторінки - спільнота в групі, анонси на сторінці. Оригінальність винагороджується.",
};

export async function generateChannelPlan(workspaceId: string, channel: string, horizonDays: number, postsPerWeek: number): Promise<any[]> {
  const playbook = CHANNEL_PLAYBOOK[channel];
  if (!playbook) throw new Error("Канал не підтримується: " + channel);
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const brief = (s.strategy_brief || "").trim();
  const system =
    `Ти старший контент-стратег каналу ${channel}, що знає його алгоритм 2025-2026. ` +
    "Розширюй ЄДИНУ стратегію на цей канал, НЕ суперечачи брифу - перекладай позиціювання, пілери, голос і офери у нативний для каналу контент, а не вигадуй наново. " +
    (brief
      ? `\n\nСТРАТЕГІЧНИЙ БРИФ:\n${brief}`
      : `\n\nКонтекст бренду: ${s.marketing_context || ""}\nГолос: ${s.tone_of_voice || ""}`) +
    `\n\nПравила каналу:\n${playbook}` +
    `\n\nПобудуй контент-план на ${horizonDays} днів за темпу ${postsPerWeek} постів/тиждень. ` +
    "Кожен пункт прив'яжи до пілера й стадії воронки; тримай 80/20 користь/промо та розподіл Hero/Hub/Hygiene. " +
    'Поверни ЛИШЕ валідний JSON-масив обʼєктів: [{"day":1,"pillar":"…","hhh":"hero|hub|hygiene","funnel":"awareness|consideration|conversion","format":"…","hook":"чіпкий гачок/робоча назва","message":"ключова думка","cta":"…","kpi":"головна метрика"}]. ' +
    `Мова всіх текстів: ${lang}.`;
  const raw = await chat("openai/gpt-4o", system, "Згенеруй контент-план.", { workspaceId, step: "channel_plan" });
  let rows: any[] = [];
  try { rows = extractJsonArray<any>(raw); } catch { rows = []; }
  await q(
    `insert into settings_block(workspace_id,key,content) values($1,$2,$3)
     on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
    [workspaceId, "channel_plan_" + channel, JSON.stringify(rows)]
  );
  return rows;
}

// ---- Lite-скелет плану: ДЕТЕРМІНОВАНО зі стратегії (рубрики × best_days × теми) ----
// Канало-незалежний, не залежить від крихкого LLM-плану → порожнім не буде, якщо є стратегія.
export async function buildLiteSkeleton(workspaceId: string, horizonDays: number, postsPerWeek = 4): Promise<{ day: number; rubric: string; theme: string; hook: string }[]> {
  const strat = await one<{ data: any }>(`select data from strategy where workspace_id=$1`, [workspaceId]);
  const data: any = strat?.data || {};
  const rubrics: { name: string; share?: number }[] = Array.isArray(data.rubrics) ? data.rubrics.filter((r: any) => r?.name) : [];
  if (!rubrics.length) throw new Error("Спершу згенеруй стратегію (розділ Стратегія) - зі стратегії будується скелет плану.");
  const DMAP: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  let bestDays: number[] = Array.isArray(data.best_days) ? data.best_days.map((d: string) => DMAP[String(d).toLowerCase().slice(0, 3)]).filter((x: any) => x != null) : [];
  if (!bestDays.length) bestDays = [1, 3, 5];
  // зважений «мішок» рубрик за share
  const bag: string[] = [];
  for (const r of rubrics) { const w = Math.max(1, Math.round((Number(r.share) || 25) / 10)); for (let k = 0; k < w; k++) bag.push(r.name); }
  // кількість слотів = «постів на тиждень» × кількість тижнів у горизонті
  const ppw = Math.max(1, Math.min(14, Math.round(postsPerWeek) || 4));
  const totalTarget = Math.max(1, Math.min(60, Math.round((horizonDays / 7) * ppw)));
  // дні-кандидати для постингу (best_days у межах горизонту; якщо порожньо - будь-який день)
  const candidates: number[] = [];
  for (let day = 1; day <= horizonDays; day++) {
    const dow = new Date(Date.now() + day * 864e5).getUTCDay();
    if (bestDays.includes(dow)) candidates.push(day);
  }
  if (!candidates.length) for (let day = 1; day <= horizonDays; day++) candidates.push(day);
  const slots: { day: number; rubric: string; theme: string; hook: string }[] = [];
  let bi = 0;
  for (let i = 0; i < totalTarget; i++) slots.push({ day: candidates[i % candidates.length], rubric: bag[bi++ % bag.length], theme: "", hook: "" });
  slots.sort((a, b) => a.day - b.day);
  // теми: ОДИН дешевий виклик; фолбек - рубрика (щоб ніколи не порожньо)
  if (slots.length) {
    try {
      const s = await loadSettings(workspaceId);
      const lang = (s.output_language || "Українська").trim();
      const themes = Array.isArray(data.monthly_themes) ? data.monthly_themes.filter(Boolean).map(String) : [];
      const system = "Ти контент-стратег. Для кожного слота (рубрика задана) придумай коротку конкретну тему поста (до 12 слів) у ніші бренду." +
        (s.strategy_brief ? `\nБриф: ${s.strategy_brief.slice(0, 1500)}` : (s.marketing_context ? `\nНіша: ${s.marketing_context}` : "")) +
        (themes.length ? `\nОрієнтир тем: ${themes.slice(0, 10).join("; ")}` : "") +
        `\n\nПоверни ЛИШЕ валідний JSON-масив рівно з ${slots.length} рядків-тем, у тому ж порядку, що рубрики нижче. Мова: ${lang}.`;
      const user = slots.map((x, i) => `${i + 1}. [${x.rubric}]`).join("\n");
      const raw = await chat("openai/gpt-4o-mini", system, user, { workspaceId, step: "plan_themes" });
      const arr = extractJsonArray<any>(raw).map((x: any) => String(x?.theme || x || "").trim());
      slots.forEach((x, i) => { x.theme = (arr[i] || "").slice(0, 300) || `${x.rubric}: ідея дня`; });
    } catch { slots.forEach((x) => { x.theme = x.theme || `${x.rubric}: ідея дня`; }); }
  }
  return slots;
}

// ---- V2 Крок 4: атомізація (Prompt 10) - 1 пілерний пост → варіанти під усі канали ----
export async function atomizePost(workspaceId: string, content: string, channels: string[]): Promise<{ atoms: string[]; matrix: any[] }> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const brief = (s.strategy_brief || "").trim();
  const chans = (channels || []).filter((c) => CHANNEL_PLAYBOOK[c]);
  const targets = chans.length ? chans.join(", ") : "telegram, instagram, threads, facebook";
  const system =
    "Ти стратег ре-використання контенту (create once, publish everywhere / COPE). " +
    (brief ? `\nСТРАТЕГІЧНИЙ БРИФ (тримай бренд):\n${brief}\n` : "") +
    "1) Витягни 12-30 «атомів» із пілерного матеріалу: статистика, цитати, кроки, історії, контр-думки, FAQ, помилки. " +
    "2) Зістав атоми з нативними форматами для кожного каналу зі своїм свіжим гачком (НЕ копіюй однаковий текст між каналами). " +
    `\n\nКанали: ${targets}.` +
    ' Поверни ЛИШЕ валідний JSON-обʼєкт: {"atoms":["…"],"matrix":[{"atom":"…","channel":"…","format":"…","hook":"нативний гачок","cta":"…","best":false}]}. ' +
    "Познач best:true для топ-варіантів на канал. " +
    `Мова всіх текстів: ${lang}.`;
  const raw = await chat("openai/gpt-4o", system, `Пілерний матеріал:\n---\n${(content || "").slice(0, 8000)}`, { workspaceId, step: "atomize" });
  const o: any = extractJsonObject(raw) || {};
  return { atoms: Array.isArray(o.atoms) ? o.atoms : [], matrix: Array.isArray(o.matrix) ? o.matrix : [] };
}

// ---- Стрічка матеріалів: витягнути ідеї з одного матеріалу (модалка «Ідеї з матеріалу») ----
export async function extractIdeasFromText(workspaceId: string, text: string, count = 6, rubricsFilter?: string[]): Promise<{ idea: string; rubric: string }[]> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const rubs = await q<{ name: string }>(`select name from rubric where workspace_id=$1 order by idx`, [workspaceId]);
  const picked = (rubricsFilter || []).map((r) => String(r).trim()).filter(Boolean);
  const rubList = (picked.length ? rubs.filter((r) => picked.includes(r.name)) : rubs).map((r) => r.name).join(", ");
  const system =
    "Ти контент-стратег. Знайди в матеріалі окремі контент-ідеї для соцмереж, кожна зі своїм кутом подачі. " +
    (s.marketing_context ? `\nБренд і аудиторія: ${s.marketing_context}` : "") +
    (rubList ? `\nРубрики бренду: ${rubList}. Кожній ідеї признач НАЙБЛИЖЧУ рубрику з цього переліку.` : "") +
    `\n\nЗнайди до ${Math.max(1, Math.min(10, count))} ідей. Поверни ЛИШЕ валідний JSON-масив: [{"idea":"суть ідеї одним реченням","rubric":"назва рубрики"}]. Мова: ${lang}.`;
  const raw = await chat("openai/gpt-4o-mini", system, `Матеріал:\n---\n${(text || "").slice(0, 20000)}`, { workspaceId, step: "ideas" });
  let out: { idea: string; rubric: string }[] = [];
  try {
    out = extractJsonArray<any>(raw).map((x) => ({ idea: String(x?.idea || x || "").trim(), rubric: String(x?.rubric || "").trim() })).filter((x) => x.idea);
  } catch { out = []; }
  return out;
}

// ---- Хештеги для поста (кнопка «# Хештеги» у композері): 5-8 релевантних, у ніші бренду ----
export async function suggestHashtags(workspaceId: string, text: string): Promise<string[]> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const system =
    "Ти SMM-фахівець. Підбери 5-8 релевантних хештегів для цього поста: суміш нішевих і ширших, без пробілів усередині тега, без дублів, реально вживаних. " +
    (s.marketing_context ? `\nНіша бренду: ${s.marketing_context}` : "") +
    `\n\nПоверни ЛИШЕ валідний JSON-масив рядків, кожен починається з #. Мова тегів: ${lang}.`;
  const raw = await chat("openai/gpt-4o-mini", system, `Пост:\n---\n${(text || "").slice(0, 4000)}`, { workspaceId, step: "hashtags" });
  let tags: string[] = [];
  try {
    tags = extractJsonArray<any>(raw).map((x) => String(x || "").trim())
      .map((t) => (t.startsWith("#") ? t : "#" + t)).map((t) => t.replace(/\s+/g, "")).filter((t) => t.length > 1);
  } catch { tags = []; }
  return [...new Set(tags)].slice(0, 8);
}

// ---- Метчинг: які матеріали підходять під порожні слоти плану (дешевий один виклик) ----
export async function matchPlanSlots(workspaceId: string): Promise<number> {
  const slots = await q<{ id: string; theme: string; rubric: string }>(
    `select id, theme, coalesce(rubric,'') as rubric from plan_slot where workspace_id=$1 and status='empty' order by slot_date limit 20`, [workspaceId]);
  const mats = await q<{ id: string; title: string; transcript: string }>(
    `select id, coalesce(title,'') as title, left(transcript, 300) as transcript from source
     where workspace_id=$1 and archived=false and coalesce(transcript,'') <> '' order by created_at desc limit 30`, [workspaceId]);
  if (!slots.length || !mats.length) return 0;
  const system =
    "Зістав теми контент-плану з наявними матеріалами. Метч признач ЛИШЕ якщо матеріал реально розкриває тему слота (не за поверхневою схожістю слів). Один матеріал може підійти кільком слотам, слот отримує максимум один матеріал." +
    '\n\nПоверни ЛИШЕ валідний JSON-масив (порожній, якщо метчів нема): [{"slotId":"…","sourceId":"…"}].';
  const user =
    "СЛОТИ ПЛАНУ:\n" + slots.map((s) => `${s.id} | [${s.rubric}] ${s.theme}`).join("\n") +
    "\n\nМАТЕРІАЛИ:\n" + mats.map((m) => `${m.id} | ${m.title}: ${m.transcript.replace(/\n+/g, " ")}`).join("\n");
  const raw = await chat("openai/gpt-4o-mini", system, user, { workspaceId, step: "plan_match" });
  let pairs: { slotId: string; sourceId: string }[] = [];
  try { pairs = extractJsonArray<any>(raw).map((x) => ({ slotId: String(x?.slotId || ""), sourceId: String(x?.sourceId || "") })); } catch { pairs = []; }
  const slotIds = new Set(slots.map((s) => s.id)); const matIds = new Map(mats.map((m) => [m.id, m.title]));
  let n = 0;
  for (const p of pairs) {
    if (!slotIds.has(p.slotId) || !matIds.has(p.sourceId)) continue;
    await q(`update plan_slot set status='matched', match_source_id=$2, match_note=$3 where id=$1 and status='empty'`,
      [p.slotId, p.sourceId, `метч: «${String(matIds.get(p.sourceId)).slice(0, 80)}»`]);
    n++;
  }
  return n;
}

// Перегенерація одного поста зі СПІЛЬНИМ контекстом (голос + де-AI + бриф) - для кнопки «Переробити».
// instruction - конкретна правка від користувача («зроби коротшим», «прибери смайли», «додай приклад»):
// виконується ПОВЕРХ повного контексту, тож правка не губить голос/стратегію.
export async function rewritePost(workspaceId: string, text: string, instruction?: string): Promise<string> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const instr = (instruction || "").trim();
  const brief = s.prompt_engine !== "legacy" ? (s.strategy_brief || "").trim() : "";
  const task = instr
    ? `Внеси в цей пост конкретну правку, яку просить користувач, зберігаючи решту тексту, зміст, голос бренду й живу людську мову (без ознак AI).\n\nПРАВКА ВІД КОРИСТУВАЧА: ${instr.slice(0, 600)}`
    : "Перепиши цей пост іншими словами, зберігаючи зміст і структуру, у голосі бренду й живою людською мовою (без ознак AI).";
  const system = task +
    (brief ? `\n\nСТРАТЕГІЧНИЙ БРИФ (тримай бренд): ${brief}` : "") +
    (s.tone_of_voice ? `\n\nГолос бренду: ${s.tone_of_voice}` : "") +
    (s.deai_rules ? `\n\nПравила «без AI»: ${s.deai_rules}` : "") +
    NO_DASH_RULE + `\n\nПоверни лише текст поста. Мова: ${lang}.`;
  return chat("openai/gpt-4o", system, `---\n${text}`, { workspaceId, step: "regenerate" });
}
