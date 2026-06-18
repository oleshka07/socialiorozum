import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import cookie from "@fastify/cookie";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env } from "./env.js";
import { q, one } from "./db.js";
import { executeStep, STEP_ORDER, StepKey, DEFAULT_PROMPTS, rewriteWithStep } from "./pipeline.js";
import * as tg from "./telegram.js";
import * as auth from "./auth.js";
import { sendVerifyEmail, sendResetEmail } from "./email.js";
import { logEvent } from "./log.js";
import { startAutopost } from "./autopost.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true, trustProxy: true });
await app.register(cors, { origin: env.appBaseUrl, credentials: true });
await app.register(cookie, { secret: env.sessionSecret });
await app.register(fstatic, { root: join(__dirname, "..", "public"), prefix: "/" });

// базові security-заголовки
app.addHook("onRequest", async (_req, reply) => {
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
});

// простий in-memory rate-limit (додаток одноінстансний)
const rlHits = new Map<string, { n: number; t: number }>();
function rateLimited(key: string, max: number, windowMs = 60000): boolean {
  const now = Date.now();
  const h = rlHits.get(key);
  if (!h || now - h.t > windowMs) { rlHits.set(key, { n: 1, t: now }); return false; }
  h.n++;
  return h.n > max;
}

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
  if (rateLimited("reg:" + req.ip, 10)) return reply.code(429).send({ error: "Забагато спроб. Спробуйте за хвилину." });
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!emailOk(email)) return reply.code(400).send({ error: "Некоректний email" });
  if (password.length < 8) return reply.code(400).send({ error: "Пароль мінімум 8 символів" });
  if (await auth.userByEmail(email)) return reply.code(409).send({ error: "Такий email вже зареєстрований" });
  const user = await auth.createUser(email, password);
  await logEvent("info", "register", `новий акаунт: ${email}`, null, user.id);
  const token = await auth.createEmailToken(user.id, "verify");
  try { await sendVerifyEmail(email, `${env.appBaseUrl}/api/auth/verify?token=${token}`); }
  catch (e: any) { await logEvent("error", "email", `verify-лист НЕ надіслано (${email}): ${e.message}`, null, user.id); }
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
  if (rateLimited("login:" + req.ip, 20)) return reply.code(429).send({ error: "Забагато спроб. Спробуйте за хвилину." });
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const u = await auth.userByEmail(email);
  if (!u || !auth.verifyPassword(password, u.password_hash)) {
    await logEvent("warn", "auth", `невдалий вхід: ${email}`);
    return reply.code(401).send({ error: "Невірний email або пароль" });
  }
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

app.post("/api/auth/request-reset", async (req: any, reply) => {
  if (rateLimited("reset:" + req.ip, 5)) return reply.code(429).send({ error: "Забагато спроб. Спробуйте за хвилину." });
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const u = await auth.userByEmail(email);
  if (u) {
    const token = await auth.createEmailToken(u.id, "reset");
    try { await sendResetEmail(email, `${env.appBaseUrl}/reset?token=${token}`); }
    catch (e: any) { await logEvent("error", "email", `reset-лист НЕ надіслано (${email}): ${e.message}`, null, u.id); }
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

// ---- Google OAuth (вхід через Google; обходить email-верифікацію) ----
const GOOGLE_REDIRECT = `${env.appBaseUrl}/api/auth/google/callback`;
const stateCookie = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 600 };

app.get("/api/auth/google", async (_req, reply) => {
  if (!env.google.clientId) return reply.redirect("/login?error=google_off");
  const state = auth.newToken();
  reply.setCookie("oauth_state", state, stateCookie);
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.google.clientId);
  u.searchParams.set("redirect_uri", GOOGLE_REDIRECT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_account");
  return reply.redirect(u.toString());
});

app.get("/api/auth/google/callback", async (req: any, reply) => {
  const code = String(req.query?.code ?? "");
  const state = String(req.query?.state ?? "");
  if (!code || !state || state !== req.cookies?.oauth_state) return reply.redirect("/login?error=google");
  reply.clearCookie("oauth_state", { path: "/" });
  try {
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: env.google.clientId, client_secret: env.google.clientSecret,
        redirect_uri: GOOGLE_REDIRECT, grant_type: "authorization_code",
      }),
    });
    const tok: any = await tr.json();
    if (!tr.ok || !tok.access_token) throw new Error("token exchange: " + JSON.stringify(tok).slice(0, 150));
    const ur = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const info: any = await ur.json();
    if (!info.email || info.email_verified === false) throw new Error("google не повернув підтверджений email");
    const user = await auth.findOrCreateGoogleUser(info.email, info.sub || "");
    reply.setCookie(COOKIE, await auth.createSession(user.id), cookieOpts);
    await logEvent("info", "auth", `Google-вхід: ${info.email}`, null, user.id);
    return reply.redirect("/app");
  } catch (e: any) {
    await logEvent("error", "auth", "Google callback помилка: " + e.message);
    return reply.redirect("/login?error=google");
  }
});

// ---- адмін: журнал подій/помилок ----
app.get("/api/admin/logs", async (req: any, reply) => {
  if (!env.adminEmails.includes(String(req.user.email).toLowerCase()))
    return reply.code(403).send({ error: "Лише адміністратор" });
  const limit = Math.min(Number(req.query?.limit ?? 100), 500);
  return q(`select level, scope, message, meta, user_id, created_at
            from app_log order by created_at desc limit $1`, [limit]);
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

// ===================== PROMPTS (модель + промпт на кожен крок) =====================
app.get("/api/prompts", async (req: any) => {
  const rows = await q<{ step_key: string; model: string; content: string }>(
    `select step_key, model, content from prompt_template where workspace_id=$1 and is_active=true`,
    [req.user.workspace_id]
  );
  const byStep = Object.fromEntries(rows.map((r) => [r.step_key, r]));
  return STEP_ORDER.map((step) =>
    byStep[step] ?? { step_key: step, model: DEFAULT_PROMPTS[step].model, content: DEFAULT_PROMPTS[step].content });
});

app.put("/api/prompts/:step", async (req: any, reply) => {
  const step = req.params.step;
  if (!STEP_ORDER.includes(step)) return reply.code(400).send({ error: "невідомий крок" });
  const model = String(req.body?.model ?? "").trim();
  const content = String(req.body?.content ?? "").trim();
  if (!model || !content) return reply.code(400).send({ error: "model і content обов'язкові" });
  const ws = req.user.workspace_id;
  await q(`update prompt_template set is_active=false where workspace_id=$1 and step_key=$2 and is_active=true`, [ws, step]);
  await q(`insert into prompt_template(workspace_id, step_key, model, content, is_active) values($1,$2,$3,$4,true)`, [ws, step, model, content]);
  return { ok: true };
});

// ===================== SOURCES + RUNS =====================
app.post("/api/sources", async (req: any) => {
  const { transcript, title, origin } = req.body ?? {};
  if (!transcript) return { error: "transcript обовʼязковий" };
  if (String(transcript).length > 100000) return { error: "Транскрипт задовгий (макс 100k символів)" };
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
  const [steps, ideas, posts, plan, published, schedule] = await Promise.all([
    q(`select step_key,status,model,prompt_version,output,error,updated_at from step_run where run_id=$1`, [id]),
    q(`select id,idx,idea,angle,selected from idea where run_id=$1 order by idx`, [id]),
    q(`select id,stage,channel_type,content,review from post where run_id=$1 order by created_at`, [id]),
    q(`select pi.*, p.content as post_content from plan_item pi
        join content_plan cp on cp.id=pi.plan_id
        left join post p on p.id=pi.post_id
        where cp.run_id=$1`, [id]),
    q(`select tp.post_id, tp.target, tp.status, tp.message_id from telegram_publish tp
        join post p on p.id=tp.post_id where p.run_id=$1 and tp.status='sent'`, [id]),
    q(`select ss.id, ss.plan_item_id, ss.scheduled_at, ss.status from schedule_slot ss
        join plan_item pi on pi.id=ss.plan_item_id join content_plan cp on cp.id=pi.plan_id
        where cp.run_id=$1`, [id]),
  ]);
  return { run, steps, ideas, posts, plan, published, schedule };
});

app.post("/api/runs/:id/steps/:step/run", async (req: any, reply) => {
  const { id, step } = req.params;
  if (!STEP_ORDER.includes(step)) return reply.code(400).send({ error: "невідомий крок" });
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  try { await executeStep(id, step as StepKey); return { ok: true }; }
  catch (e: any) { await logEvent("error", "pipeline", `крок ${step}: ${e.message}`, { runId: id }, req.user.id); return reply.code(500).send({ error: e.message }); }
});

app.post("/api/runs/:id/run-from/:step", async (req: any, reply) => {
  const { id, step } = req.params;
  const idx = STEP_ORDER.indexOf(step);
  if (idx < 0) return reply.code(400).send({ error: "невідомий крок" });
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  try { for (const s of STEP_ORDER.slice(idx)) await executeStep(id, s as StepKey); return { ok: true }; }
  catch (e: any) { await logEvent("error", "pipeline", `run-from ${step}: ${e.message}`, { runId: id }, req.user.id); return reply.code(500).send({ error: e.message }); }
});

app.post("/api/runs/:id/ideas/select", async (req: any, reply) => {
  if (!(await runOwned(req.params.id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  const { selectedIds } = req.body ?? {};
  await q(`update idea set selected = (id = any($2)) where run_id=$1`, [req.params.id, selectedIds ?? []]);
  return { ok: true };
});

app.post("/api/runs/:id/schedule", async (req: any, reply) => {
  const id = req.params.id;
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  const slots = req.body?.slots ?? [];
  // перезаписуємо лише ще не опубліковані слоти цього прогону
  await q(
    `delete from schedule_slot where status in ('planned','failed')
       and plan_item_id in (select pi.id from plan_item pi join content_plan cp on cp.id=pi.plan_id where cp.run_id=$1)`,
    [id]
  );
  let count = 0;
  for (const s of slots) {
    const owned = await one(
      `select 1 from plan_item pi join content_plan cp on cp.id=pi.plan_id where pi.id=$1 and cp.run_id=$2`,
      [s.planItemId, id]
    );
    if (!owned) continue; // IDOR-захист: plan_item має належати цьому прогону
    await q(`insert into schedule_slot(plan_item_id, scheduled_at, status) values($1,$2,'planned')`,
      [s.planItemId, s.scheduledAt ?? null]);
    count++;
  }
  return { ok: true, count };
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
      await logEvent("error", "telegram", `публікація в ${t}: ${e.message}`, null, req.user.id);
      results.push({ target: t, status: "error", error: e.message });
    }
  }
  return { ok: true, results };
});

// ===================== POST-ЮНІТИ (банк публікацій) =====================
async function postOwned(postId: string, ws: string) {
  return one<{ content: string }>(
    `select p.content from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
}

app.put("/api/posts/:postId", async (req: any, reply) => {
  if (!(await postOwned(req.params.postId, req.user.workspace_id))) return reply.code(404).send({ error: "пост не знайдено" });
  await q(`update post set content=$2 where id=$1`, [req.params.postId, String(req.body?.content ?? "")]);
  return { ok: true };
});

app.post("/api/posts/:postId/review", async (req: any, reply) => {
  if (!(await postOwned(req.params.postId, req.user.workspace_id))) return reply.code(404).send({ error: "пост не знайдено" });
  const status = String(req.body?.status ?? "");
  if (!["approved", "needs_work", "archived", ""].includes(status)) return reply.code(400).send({ error: "невідомий статус" });
  await q(`update post set review=nullif($2,'') where id=$1`, [req.params.postId, status]);
  return { ok: true };
});

app.post("/api/posts/:postId/regenerate", async (req: any, reply) => {
  const post = await postOwned(req.params.postId, req.user.workspace_id);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try {
    const fresh = await rewriteWithStep(req.user.workspace_id, "deai", post.content);
    await q(`update post set content=$2, review=null where id=$1`, [req.params.postId, fresh]);
    return { ok: true, content: fresh };
  } catch (e: any) {
    await logEvent("error", "regenerate", e.message, null, req.user.id);
    return reply.code(500).send({ error: e.message });
  }
});

app.get("/api/usage", async (req: any) => {
  return one(`select coalesce(sum(prompt_tokens),0)::int as prompt_tokens,
                     coalesce(sum(completion_tokens),0)::int as completion_tokens,
                     coalesce(sum(cost),0)::float as cost, count(*)::int as calls
              from llm_usage where workspace_id=$1`, [req.user.workspace_id]);
});

// ===================== БАНК + ПЛАНУВАННЯ (по постах, рівень workspace) =====================
app.get("/api/bank", async (req: any) => {
  return q(`select p.id, p.content, p.review, p.created_at, src.title as source_title
            from post p join pipeline_run r on r.id=p.run_id join source src on src.id=r.source_id
            where src.workspace_id=$1 and p.stage='final' and p.review='approved'
            order by p.created_at desc`, [req.user.workspace_id]);
});

app.get("/api/schedule", async (req: any) => {
  return q(`select ss.id, ss.scheduled_at, ss.status, p.id as post_id, p.content
            from schedule_slot ss
              left join plan_item pi on pi.id=ss.plan_item_id
              join post p on p.id = coalesce(ss.post_id, pi.post_id)
              join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where s.workspace_id=$1 order by ss.scheduled_at`, [req.user.workspace_id]);
});

async function slotOwned(slotId: string, ws: string) {
  return one(`select ss.id from schedule_slot ss
                left join plan_item pi on pi.id=ss.plan_item_id
                join post p on p.id=coalesce(ss.post_id, pi.post_id)
                join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
              where ss.id=$1 and s.workspace_id=$2`, [slotId, ws]);
}

app.post("/api/schedule", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const postId = String(req.body?.postId ?? "");
  if (!(await postOwned(postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const r = await one<{ id: string }>(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned') returning id`,
    [postId, req.body?.scheduledAt ?? null]);
  return { ok: true, id: r!.id };
});

app.put("/api/schedule/:id", async (req: any, reply) => {
  if (!(await slotOwned(req.params.id, req.user.workspace_id))) return reply.code(404).send({ error: "слот не знайдено" });
  await q(`update schedule_slot set scheduled_at=$2, status='planned' where id=$1`, [req.params.id, req.body?.scheduledAt ?? null]);
  return { ok: true };
});

app.delete("/api/schedule/:id", async (req: any, reply) => {
  if (!(await slotOwned(req.params.id, req.user.workspace_id))) return reply.code(404).send({ error: "слот не знайдено" });
  await q(`delete from schedule_slot where id=$1`, [req.params.id]);
  return { ok: true };
});

// авто-розподіл затверджених незапланованих юнітів за найкращими годинами
app.post("/api/schedule/auto", async (req: any) => {
  const ws = req.user.workspace_id;
  const units = await q<{ id: string }>(
    `select p.id from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and p.stage='final' and p.review='approved'
       and not exists(select 1 from schedule_slot ss where ss.post_id=p.id and ss.status in ('planned','posting','posted'))
     order by p.created_at`, [ws]);
  const TIMES = [[9, 0], [13, 0], [19, 0]];
  const base = new Date(); base.setUTCHours(0, 0, 0, 0);
  let count = 0;
  for (let i = 0; i < units.length; i++) {
    const day = Math.floor(i / TIMES.length) + 1;
    const [h, m] = TIMES[i % TIMES.length];
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + day); d.setUTCHours(h, m, 0, 0);
    await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [units[i].id, d.toISOString()]);
    count++;
  }
  return { ok: true, count };
});

// ===================== СТОРІНКИ =====================
app.get("/app", (_req, reply) => reply.sendFile("app.html"));
app.get("/B", (_req, reply) => reply.sendFile("b.html"));
app.get("/b", (_req, reply) => reply.sendFile("b.html"));
app.get("/login", (_req, reply) => reply.sendFile("auth.html"));
app.get("/register", (_req, reply) => reply.sendFile("auth.html"));
app.get("/forgot", (_req, reply) => reply.sendFile("auth.html"));
app.get("/reset", (_req, reply) => reply.sendFile("auth.html"));

app.listen({ port: env.port, host: "0.0.0.0" }).then((addr) => {
  app.log.info(`socialio на ${addr}`);
  startAutopost();
});
