import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import cookie from "@fastify/cookie";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env } from "./env.js";
import { q, one } from "./db.js";
import { executeStep, STEP_ORDER, StepKey } from "./pipeline.js";
import * as tg from "./telegram.js";
import * as auth from "./auth.js";
import { sendVerifyEmail, sendResetEmail } from "./email.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });
await app.register(cors, { origin: true, credentials: true });
await app.register(cookie, { secret: env.sessionSecret });
await app.register(fstatic, { root: join(__dirname, "..", "public"), prefix: "/" });

const COOKIE = "sid";
const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 60 * 60 * 24 * 30 };
const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// ---- захист API: усе під /api/, крім /api/auth/*, потребує сесії + підтвердженої пошти ----
app.addHook("preHandler", async (req: any, reply) => {
  const url = (req.raw.url || "").split("?")[0];
  if (!url.startsWith("/api/")) return;
  if (url.startsWith("/api/auth/")) return;
  const user = await auth.userBySession(req.cookies?.[COOKIE]);
  if (!user) return reply.code(401).send({ error: "Не авторизовано" });
  if (!user.email_verified) return reply.code(403).send({ error: "Пошта не підтверджена" });
  req.user = user;
});

// володіння run/post у межах workspace юзера
async function runOwned(runId: string, ws: string) {
  return !!(await one(
    `select 1 from pipeline_run r join source s on s.id=r.source_id where r.id=$1 and s.workspace_id=$2`,
    [runId, ws]
  ));
}

app.get("/health", async () => ({ ok: true }));

// ===================== AUTH =====================
app.post("/api/auth/register", async (req: any, reply) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!emailOk(email)) return reply.code(400).send({ error: "Некоректний email" });
  if (password.length < 8) return reply.code(400).send({ error: "Пароль мінімум 8 символів" });
  if (await auth.userByEmail(email)) return reply.code(409).send({ error: "Такий email вже зареєстрований" });
  const user = await auth.createUser(email, password);
  const token = await auth.createEmailToken(user.id, "verify");
  try { await sendVerifyEmail(email, `${env.appBaseUrl}/api/auth/verify?token=${token}`); }
  catch (e: any) { req.log.error("verify email failed: " + e.message); }
  return { ok: true, message: "Перевірте пошту й підтвердіть акаунт." };
});

app.get("/api/auth/verify", async (req: any, reply) => {
  const token = String(req.query?.token ?? "");
  const userId = await auth.consumeEmailToken(token, "verify");
  if (!userId) return reply.redirect("/login?error=verify");
  await auth.markVerified(userId);
  const sid = await auth.createSession(userId);
  reply.setCookie(COOKIE, sid, cookieOpts);
  return reply.redirect("/app");
});

app.post("/api/auth/login", async (req: any, reply) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const u = await auth.userByEmail(email);
  if (!u || !auth.verifyPassword(password, u.password_hash))
    return reply.code(401).send({ error: "Невірний email або пароль" });
  if (!u.email_verified) return reply.code(403).send({ error: "Підтвердіть пошту (перевірте лист)" });
  const sid = await auth.createSession(u.id);
  reply.setCookie(COOKIE, sid, cookieOpts);
  return { ok: true };
});

app.post("/api/auth/logout", async (req: any, reply) => {
  const sid = req.cookies?.[COOKIE];
  if (sid) await auth.deleteSession(sid);
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true };
});

app.get("/api/auth/me", async (req: any, reply) => {
  const user = await auth.userBySession(req.cookies?.[COOKIE]);
  if (!user) return reply.code(401).send({ error: "Не авторизовано" });
  return { email: user.email, emailVerified: user.email_verified };
});

app.post("/api/auth/request-reset", async (req: any) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const u = await auth.userByEmail(email);
  if (u) {
    const token = await auth.createEmailToken(u.id, "reset");
    try { await sendResetEmail(email, `${env.appBaseUrl}/reset?token=${token}`); }
    catch (e: any) { req.log.error("reset email failed: " + e.message); }
  }
  // завжди ok — не розкриваємо, чи існує email
  return { ok: true, message: "Якщо такий email існує — ми надіслали лист для скидання." };
});

app.post("/api/auth/reset", async (req: any, reply) => {
  const token = String(req.body?.token ?? "");
  const password = String(req.body?.password ?? "");
  if (password.length < 8) return reply.code(400).send({ error: "Пароль мінімум 8 символів" });
  const userId = await auth.consumeEmailToken(token, "reset");
  if (!userId) return reply.code(400).send({ error: "Посилання недійсне або застаріле" });
  await auth.setPassword(userId, password);
  return { ok: true };
});

// ===================== SETTINGS =====================
app.get("/api/settings", async (req: any) =>
  q(`select key, content from settings_block where workspace_id=$1`, [req.user.workspace_id]));

app.put("/api/settings/:key", async (req: any) => {
  const { key } = req.params;
  const { content } = req.body ?? {};
  await q(
    `insert into settings_block(workspace_id,key,content) values($1,$2,$3)
     on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
    [req.user.workspace_id, key, content ?? ""]
  );
  return { ok: true };
});

// ===================== SOURCES + RUNS =====================
app.post("/api/sources", async (req: any) => {
  const { transcript, title, origin } = req.body ?? {};
  if (!transcript) return { error: "transcript обовʼязковий" };
  const src = await one<{ id: string }>(
    `insert into source(workspace_id, origin, title, transcript) values($1,$2,$3,$4) returning id`,
    [req.user.workspace_id, origin ?? "manual", title ?? null, transcript]
  );
  const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
  return { sourceId: src!.id, runId: run!.id };
});

app.get("/api/runs/:id", async (req: any, reply) => {
  const { id } = req.params;
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  const run = await one(`select * from pipeline_run where id=$1`, [id]);
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

app.post("/api/runs/:id/steps/:step/run", async (req: any, reply) => {
  const { id, step } = req.params;
  if (!STEP_ORDER.includes(step)) return reply.code(400).send({ error: "невідомий крок" });
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  try { await executeStep(id, step as StepKey); return { ok: true }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

app.post("/api/runs/:id/run-from/:step", async (req: any, reply) => {
  const { id, step } = req.params;
  const idx = STEP_ORDER.indexOf(step);
  if (idx < 0) return reply.code(400).send({ error: "невідомий крок" });
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  try { for (const s of STEP_ORDER.slice(idx)) await executeStep(id, s as StepKey); return { ok: true }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

app.post("/api/runs/:id/ideas/select", async (req: any, reply) => {
  if (!(await runOwned(req.params.id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  const { selectedIds } = req.body ?? {};
  await q(`update idea set selected = (id = any($2)) where run_id=$1`, [req.params.id, selectedIds ?? []]);
  return { ok: true };
});

app.post("/api/runs/:id/schedule", async (req: any, reply) => {
  if (!(await runOwned(req.params.id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  const slots = req.body?.slots ?? [];
  for (const s of slots) {
    await q(`insert into schedule_slot(plan_item_id, scheduled_at, status) values($1,$2,'planned')`,
      [s.planItemId, s.scheduledAt ?? null]);
  }
  return { ok: true, count: slots.length };
});

// ===================== TELEGRAM =====================
async function tgConfig(ws: string) {
  return one<{
    bot_token: string | null; channel_chat_id: string | null; group_chat_id: string | null;
    channel_title: string | null; group_title: string | null;
  }>(
    `select bot_token, channel_chat_id, group_chat_id, channel_title, group_title
     from telegram_config where workspace_id=$1`, [ws]
  );
}

app.get("/api/integrations/telegram", async (req: any) => {
  const c = await tgConfig(req.user.workspace_id);
  return {
    hasToken: !!(c && c.bot_token),
    channelChatId: c?.channel_chat_id ?? "",
    groupChatId: c?.group_chat_id ?? "",
    channelTitle: c?.channel_title ?? "",
    groupTitle: c?.group_title ?? "",
  };
});

app.put("/api/integrations/telegram", async (req: any) => {
  const ws = req.user.workspace_id;
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

app.post("/api/integrations/telegram/test", async (req: any, reply) => {
  const ws = req.user.workspace_id;
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
      } catch { /* приватні групи можуть не віддавати member */ }
      return { ok: true, id, title: chat.title || chat.username || id, type: chat.type, isAdmin };
    } catch (e: any) { return { ok: false, id, error: e.message }; }
  };
  const channel = await checkChat(req.body?.channelChatId ?? stored?.channel_chat_id);
  const group = await checkChat(req.body?.groupChatId ?? stored?.group_chat_id);

  if (channel?.ok || group?.ok) {
    await q(`update telegram_config set channel_title=$2, group_title=$3 where workspace_id=$1`,
      [ws, channel?.ok ? channel.title : null, group?.ok ? group.title : null]).catch(() => {});
  }
  return { bot: { id: me.id, username: me.username, name: me.first_name }, channel, group };
});

app.post("/api/posts/:postId/publish", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const cfg = await tgConfig(ws);
  if (!cfg || !cfg.bot_token) return reply.code(400).send({ error: "Telegram не підключений — додайте Bot Token у Інтеграціях" });
  // власність: пост належить workspace юзера
  const post = await one<{ content: string }>(
    `select p.content from post p
       join pipeline_run r on r.id=p.run_id
       join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [req.params.postId, ws]);
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

// ===================== СТОРІНКИ =====================
app.get("/app", (_req, reply) => reply.sendFile("app.html"));
app.get("/login", (_req, reply) => reply.sendFile("auth.html"));
app.get("/register", (_req, reply) => reply.sendFile("auth.html"));
app.get("/forgot", (_req, reply) => reply.sendFile("auth.html"));
app.get("/reset", (_req, reply) => reply.sendFile("auth.html"));

app.listen({ port: env.port, host: "0.0.0.0" }).then((addr) => app.log.info(`socialio на ${addr}`));
