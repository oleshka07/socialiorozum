import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env } from "./env.js";
import { q, one } from "./db.js";
import { executeStep, STEP_ORDER, StepKey } from "./pipeline.js";
import * as tg from "./telegram.js";

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
  const [steps, ideas, posts, plan, published] = await Promise.all([
    q(`select step_key,status,model,prompt_version,output,error,updated_at from step_run where run_id=$1`, [id]),
    q(`select id,idx,idea,angle,selected from idea where run_id=$1 order by idx`, [id]),
    q(`select id,stage,channel_type,content from post where run_id=$1 order by created_at`, [id]),
    q(`select pi.* from plan_item pi join content_plan cp on cp.id=pi.plan_id where cp.run_id=$1`, [id]),
    q(`select tp.post_id, tp.target, tp.status, tp.message_id from telegram_publish tp
        join post p on p.id=tp.post_id where p.run_id=$1 and tp.status='sent'`, [id]),
  ]);
  return { run, steps, ideas, posts, plan, published };
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

// ---------- Telegram інтеграція ----------
async function tgConfig(ws: string) {
  return one<{
    bot_token: string | null; channel_chat_id: string | null; group_chat_id: string | null;
    channel_title: string | null; group_title: string | null;
  }>(
    `select bot_token, channel_chat_id, group_chat_id, channel_title, group_title
     from telegram_config where workspace_id=$1`, [ws]
  );
}

// поточна конфігурація (токен не віддаємо — лише чи заданий)
app.get("/api/integrations/telegram", async () => {
  const ws = await defaultWorkspace();
  const c = await tgConfig(ws);
  return {
    hasToken: !!(c && c.bot_token),
    channelChatId: c?.channel_chat_id ?? "",
    groupChatId: c?.group_chat_id ?? "",
    channelTitle: c?.channel_title ?? "",
    groupTitle: c?.group_title ?? "",
  };
});

// зберегти конфіг (токен оновлюємо лише якщо переданий непорожній)
app.put("/api/integrations/telegram", async (req: any) => {
  const ws = await defaultWorkspace();
  const token = String(req.body?.botToken ?? "").trim();
  const channel = String(req.body?.channelChatId ?? "").trim() || null;
  const group = String(req.body?.groupChatId ?? "").trim() || null;
  await q(
    `insert into telegram_config(workspace_id, bot_token, channel_chat_id, group_chat_id, updated_at)
     values($1, nullif($2,''), $3, $4, now())
     on conflict (workspace_id) do update set
       bot_token = case when $2 <> '' then $2 else telegram_config.bot_token end,
       channel_chat_id = excluded.channel_chat_id,
       group_chat_id = excluded.group_chat_id,
       updated_at = now()`,
    [ws, token, channel, group]
  );
  return { ok: true };
});

// перевірити з'єднання: валідність токена + доступ/адмінство у канал/групу
app.post("/api/integrations/telegram/test", async (req: any, reply) => {
  const ws = await defaultWorkspace();
  const stored = await tgConfig(ws);
  const token = String(req.body?.botToken ?? "").trim() || stored?.bot_token || "";
  if (!token) return reply.code(400).send({ error: "Спершу введіть Bot Token" });
  let me: { id: number; username?: string; first_name?: string };
  try { me = await tg.getMe(token); }
  catch (e: any) { return reply.code(400).send({ error: "Невалідний токен: " + e.message }); }

  const checkChat = async (raw?: string | null) => {
    const id = String(raw ?? "").trim();
    if (!id) return null;
    try {
      const chat = await tg.getChat(token, id);
      let isAdmin = false;
      try {
        const m = await tg.getChatMember(token, id, me.id);
        isAdmin = m.status === "administrator" || m.status === "creator";
      } catch { /* приватні групи можуть не віддавати member — не критично */ }
      return { ok: true, id, title: chat.title || chat.username || id, type: chat.type, isAdmin };
    } catch (e: any) {
      return { ok: false, id, error: e.message };
    }
  };
  const channel = await checkChat(req.body?.channelChatId ?? stored?.channel_chat_id);
  const group = await checkChat(req.body?.groupChatId ?? stored?.group_chat_id);

  if (channel?.ok || group?.ok) {
    await q(`update telegram_config set channel_title=$2, group_title=$3 where workspace_id=$1`,
      [ws, channel?.ok ? channel.title : null, group?.ok ? group.title : null]).catch(() => {});
  }
  return { bot: { id: me.id, username: me.username, name: me.first_name }, channel, group };
});

// опублікувати готовий пост у канал і/або групу
app.post("/api/posts/:postId/publish", async (req: any, reply) => {
  const ws = await defaultWorkspace();
  const cfg = await tgConfig(ws);
  if (!cfg || !cfg.bot_token) return reply.code(400).send({ error: "Telegram не підключений — додайте Bot Token у Інтеграціях" });
  const post = await one<{ content: string }>(`select content from post where id=$1`, [req.params.postId]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  const targets: string[] = Array.isArray(req.body?.targets) ? req.body.targets : [];
  const chatOf: Record<string, string | null> = { channel: cfg.channel_chat_id, group: cfg.group_chat_id };
  const results: any[] = [];
  for (const t of targets) {
    const chatId = chatOf[t];
    if (!chatId) { results.push({ target: t, status: "error", error: "не налаштовано" }); continue; }
    try {
      const r = await tg.sendMessage(cfg.bot_token, chatId, post.content);
      await q(`insert into telegram_publish(post_id, target, chat_id, message_id, status) values($1,$2,$3,$4,'sent')`,
        [req.params.postId, t, chatId, r.message_id]);
      results.push({ target: t, status: "sent", messageId: r.message_id });
    } catch (e: any) {
      await q(`insert into telegram_publish(post_id, target, chat_id, status, error) values($1,$2,$3,'error',$4)`,
        [req.params.postId, t, chatId, e.message]);
      results.push({ target: t, status: "error", error: e.message });
    }
  }
  return { ok: true, results };
});

app.listen({ port: env.port, host: "0.0.0.0" }).then((addr) => app.log.info(`KontentGrov на ${addr}`));
