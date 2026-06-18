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
    model: "openai/gpt-4o-mini",
    content:
      "З ідеї зроби чорновий пост: гачок, 2-4 абзаци користі, м'який заклик. " +
      "Marketing Context: {{marketing_context}}. Пиши українською. Поверни лише текст.",
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
    content: "Прибери ознаки AI за правилами: {{deai_rules}}. Збережи зміст і голос. Поверни лише текст.",
  },
  strategy: {
    model: "openai/gpt-4o-mini",
    content:
      "Склади план публікацій. Content Strategy: {{content_strategy}}\n" +
      'Поверни ЛИШЕ JSON-масив: [{"title":"...","type":"користь|історія|рефлексія|заклик","postIndex":0,"dayOffset":0}]',
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
  const system = fillPrompt(tpl.content, settings);
  await upsertStepRun(runId, step, { status: "running", model: tpl.model, prompt_version: tpl.version });

  try {
    if (step === "extract_ideas") {
      const out = await chat(tpl.model, system, `Транскрипт:\n---\n${transcript}`);
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
        const txt = await chat(tpl.model, system, `Ідея: ${it.idea}\nКут: ${it.angle}`);
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
        const txt = await chat(tpl.model, system, `---\n${p.content}`);
        outs.push(txt);
        await q(`insert into post(run_id, stage, content) values($1,$2,$3)`, [runId, stage, txt]);
      }
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version, output: outs });
    } else if (step === "strategy") {
      const finals = await getPosts(runId, "final");
      if (!finals.length) throw new Error("немає фінальних постів");
      const out = await chat(tpl.model, system,
        "Готові пости:\n" + finals.map((p, i) => `[${i}] ${p.content}`).join("\n\n"));
      const plan = extractJsonArray<{ title: string; type?: string; postIndex?: number; dayOffset?: number }>(out);
      await q(`delete from content_plan where run_id=$1`, [runId]);
      const cp = await one<{ id: string }>(`insert into content_plan(run_id) values($1) returning id`, [runId]);
      for (const it of plan) {
        const post = finals[it.postIndex ?? 0];
        await q(`insert into plan_item(plan_id, post_id, title, type, day_offset) values($1,$2,$3,$4,$5)`,
          [cp!.id, post?.id ?? null, it.title, it.type ?? null, it.dayOffset ?? 0]);
      }
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version, output: plan });
    }

    await markDownstreamStale(runId, step);
    return { ok: true };
  } catch (e: any) {
    await upsertStepRun(runId, step, { status: "error", error: e.message, model: tpl.model });
    throw e;
  }
}
