import { createHash } from "node:crypto";
import { q, one } from "./db.js";
import { chat, extractJsonArray } from "./openrouter.js";

// порядок кроків кишки (strategy = v2)
export const STEP_ORDER = ["extract_ideas", "drafts", "tone", "format", "deai", "strategy"] as const;
export type StepKey = (typeof STEP_ORDER)[number];

// дефолтні промпти (placeholders тягнуться з settings_block)
export const DEFAULT_PROMPTS: Record<StepKey, { model: string; content: string }> = {
  extract_ideas: {
    model: "openai/gpt-4o-mini",
    content:
      "Ти контент-стратег. Знайди в транскрипті до 6 контент-ідей. Marketing Context: {{marketing_context}}\n" +
      'Поверни ЛИШЕ JSON-масив: [{"idea":"...","angle":"..."}]',
  },
  drafts: {
    model: "anthropic/claude-sonnet-4.5",
    content:
      "Зроби пост СУВОРО на основі змісту сесії (першоджерело нижче) — використовуй конкретні приклади, думки й формулювання саме з неї, НЕ вигадуй загальних порад «з повітря». " +
      "Структура: гачок, 2-4 абзаци користі, м'який заклик. " +
      "Marketing Context: {{marketing_context}}. Поверни лише текст поста.",
  },
  tone: {
    model: "anthropic/claude-sonnet-4.5",
    content: "Перепиши пост у голосі бренду, не змінюючи зміст. Tone of Voice: {{tone_of_voice}}. Поверни лише текст.",
  },
  format: {
    model: "openai/gpt-4o-mini",
    content: "Адаптуй під Telegram: короткі абзаци, помірні емодзі, 1-2 хештеги. Поверни лише текст.",
  },
  deai: {
    model: "anthropic/claude-sonnet-4.5",
    content: "Прибери ознаки AI за правилами: {{deai_rules}}. ЗБЕРЕЖИ зміст, голос ТА формат — абзаци, емодзі, хештеги. Поверни лише текст.",
  },
  strategy: {
    model: "openai/gpt-4o-mini",
    content:
      "Для КОЖНОГО готового поста (по порядку) признач тип і рекомендований зсув у днях від старту. Content Strategy: {{content_strategy}}\n" +
      'Поверни ЛИШЕ JSON-масив рівно по одному об\'єкту на пост, у ТОМУ Ж порядку: [{"type":"користь|історія|рефлексія|заклик","dayOffset":0}]',
  },
};

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
export async function executeStep(runId: string, step: StepKey) {
  const { workspace_id, transcript } = await runContext(runId);
  const settings = await loadSettings(workspace_id);
  const tpl = await resolvePrompt(workspace_id, step);
  const lang = (settings.output_language || "Українська").trim();
  let rubricsText = "";
  if (step === "extract_ideas" || step === "drafts" || step === "strategy") {
    const rubs = await q<{ name: string; share: number; description: string }>(
      `select name, share, description from rubric where workspace_id=$1 order by idx`, [workspace_id]);
    if (rubs.length) rubricsText = "\n\nРубрики контенту (орієнтир для тем і пропорцій у наборі постів): " +
      rubs.map((r) => `${r.name} ~${r.share}%${r.description ? ` (${r.description})` : ""}`).join("; ") + ".";
  }
  const system = fillPrompt(tpl.content, settings) + `\n\nМова всього тексту у відповіді: ${lang}.` + rubricsText;
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
  const system = fillPrompt(tpl.content, settings) + `\n\nМова всього тексту у відповіді: ${lang}.`;
  return chat(tpl.model, system, `---\n${text}`, { workspaceId, step });
}
