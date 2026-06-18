import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env } from "./env.js";
import { q, one } from "./db.js";
import { executeStep, STEP_ORDER, StepKey } from "./pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(fstatic, { root: join(__dirname, "..", "public"), prefix: "/" });

const defaultWorkspace = async () =>
  (await one<{ id: string }>(`select id from workspace order by created_at limit 1`))!.id;

app.get("/health", async () => ({ ok: true }));

// --- settings (глобальні блоки) ---
app.get("/api/settings", async () => {
  const ws = await defaultWorkspace();
  return q(`select key, content from settings_block where workspace_id=$1`, [ws]);
});
app.put("/api/settings/:key", async (req: any) => {
  const ws = await defaultWorkspace();
  const { key } = req.params;
  const { content } = req.body ?? {};
  await q(
    `insert into settings_block(workspace_id,key,content) values($1,$2,$3)
     on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
    [ws, key, content ?? ""]
  );
  return { ok: true };
});

// --- sources + run ---
app.post("/api/sources", async (req: any) => {
  const ws = await defaultWorkspace();
  const { transcript, title, origin } = req.body ?? {};
  if (!transcript) return { error: "transcript обовʼязковий" };
  const src = await one<{ id: string }>(
    `insert into source(workspace_id, origin, title, transcript) values($1,$2,$3,$4) returning id`,
    [ws, origin ?? "manual", title ?? null, transcript]
  );
  const run = await one<{ id: string }>(
    `insert into pipeline_run(source_id) values($1) returning id`, [src!.id]
  );
  return { sourceId: src!.id, runId: run!.id };
});

// --- повний стан прогону ---
app.get("/api/runs/:id", async (req: any) => {
  const { id } = req.params;
  const run = await one(`select * from pipeline_run where id=$1`, [id]);
  if (!run) return { error: "run не знайдено" };
  const [steps, ideas, posts, plan] = await Promise.all([
    q(`select step_key,status,model,prompt_version,output,error,updated_at from step_run where run_id=$1`, [id]),
    q(`select id,idx,idea,angle,selected from idea where run_id=$1 order by idx`, [id]),
    q(`select id,stage,channel_type,content from post where run_id=$1 order by created_at`, [id]),
    q(`select pi.* from plan_item pi join content_plan cp on cp.id=pi.plan_id where cp.run_id=$1`, [id]),
  ]);
  return { run, steps, ideas, posts, plan };
});

// --- запустити крок ---
app.post("/api/runs/:id/steps/:step/run", async (req: any, reply) => {
  const { id, step } = req.params;
  if (!STEP_ORDER.includes(step)) return reply.code(400).send({ error: "невідомий крок" });
  try {
    await executeStep(id, step as StepKey);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: e.message });
  }
});

// --- запустити від кроку донизу ---
app.post("/api/runs/:id/run-from/:step", async (req: any, reply) => {
  const { id, step } = req.params;
  const idx = STEP_ORDER.indexOf(step);
  if (idx < 0) return reply.code(400).send({ error: "невідомий крок" });
  try {
    for (const s of STEP_ORDER.slice(idx)) await executeStep(id, s as StepKey);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: e.message });
  }
});

// --- вибір ідей ---
app.post("/api/runs/:id/ideas/select", async (req: any) => {
  const { selectedIds } = req.body ?? {}; // масив id вибраних ідей
  await q(`update idea set selected = (id = any($2)) where run_id=$1`, [req.params.id, selectedIds ?? []]);
  return { ok: true };
});

// --- збереження розкладу (календар) ---
app.post("/api/runs/:id/schedule", async (req: any) => {
  // body: [{ planItemId, scheduledAt }]
  const slots = req.body?.slots ?? [];
  for (const s of slots) {
    await q(
      `insert into schedule_slot(plan_item_id, scheduled_at, status) values($1,$2,'planned')`,
      [s.planItemId, s.scheduledAt ?? null]
    );
  }
  return { ok: true, count: slots.length };
});

app.listen({ port: env.port, host: "0.0.0.0" }).then((addr) => app.log.info(`KontentGrov на ${addr}`));
