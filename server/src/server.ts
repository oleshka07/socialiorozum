import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";
import { q, one } from "./db.js";
import { executeStep, STEP_ORDER, StepKey, DEFAULT_PROMPTS, deriveVoice, deriveBrandFromText, generateStrategy, adaptForChannels, generatePostsOnePass, buildLitePrompt, rewritePost, generateChannelPlan, atomizePost, extractIdeasFromText, matchPlanSlots, buildLiteSkeleton, suggestHashtags } from "./pipeline.js";
import * as tg from "./telegram.js";
import * as threads from "./threads.js";
import * as meta from "./meta.js";
import * as fireflies from "./fireflies.js";
import * as grain from "./grain.js";
import * as meetgeek from "./meetgeek.js";
const TRANSCRIBERS: Record<string, { listTranscripts: (k: string) => Promise<any[]>; getTranscript: (k: string, id: string) => Promise<{ title: string; text: string }> }> = { fireflies, grain, meetgeek };
const transMod = (p?: string | null) => TRANSCRIBERS[p || "fireflies"] || fireflies;
import * as auth from "./auth.js";
import { sendVerifyEmail, sendResetEmail, sendDeletionScheduledEmail, sendEmailChangedNotice } from "./email.js";
import { logEvent } from "./log.js";
import { startAutopost } from "./autopost.js";
import { startRssPoller, pullFeed } from "./rss-poller.js";
import { MEDIA_DIR, saveMedia, deleteMediaFile, convertAllHeif, getThumb } from "./media.js";
import { startGdrivePoller, pullGdriveFolder } from "./gdrive-poller.js";
import * as gdrive from "./gdrive.js";
import { publishPostToChannels, alreadySentNetworks } from "./publisher.js";
import { startLifecycleWorker } from "./lifecycle.js";
import { generateImageForPost, imageProviders, overlayForPost } from "./images.js";
import { initTelegramBot, createConnectLink, handleUpdate, botEnabled, botUsername } from "./tgbot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true, trustProxy: true });
await app.register(cors, { origin: env.appBaseUrl, credentials: true });
await app.register(cookie, { secret: env.sessionSecret });
await app.register(fstatic, { root: join(__dirname, "..", "public"), prefix: "/" });

// медіа-сховище: файли на диску (Docker-volume), віддаємо публічно за /media/<uuid>.<ext>
await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 10 } });
await app.register(fstatic, { root: MEDIA_DIR, prefix: "/media/", decorateReply: false });
// мініатюри (sharp + диск-кеш) - щоб сітки не вантажили повні зображення; публічно, як і /media
app.get("/thumb/:name", async (req: any, reply) => {
  const buf = await getThumb(String(req.params.name));
  if (!buf) return reply.code(404).send();
  reply.header("Cache-Control", "public, max-age=604800");
  reply.type("image/jpeg");
  return reply.send(buf);
});

// зберігаємо сирий JSON-боді (для HMAC-перевірки вебхуків), парсинг лишаємо як був
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  (_req as any).rawBody = body;
  if (!body) return done(null, {});
  try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
});

// HTML-сторінки не кешуємо браузером - щоб після деплою одразу бачити свіжий app.html
app.addHook("onSend", async (req: any, reply, payload) => {
  const u = (req.raw.url || "").split("?")[0];
  if (["/", "/app", "/B", "/b", "/login", "/register", "/forgot", "/reset"].includes(u))
    reply.header("Cache-Control", "no-cache, must-revalidate");
  return payload;
});

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
  if (url.startsWith("/api/webhooks/")) return;
  const user = await auth.userBySession(req.cookies?.[COOKIE]);
  if (!user) return reply.code(401).send({ error: "Не авторизовано" });
  if (!user.email_verified) return reply.code(403).send({ error: "Пошта не підтверджена" });
  req.user = user;
  auth.touchActive(user.id).catch(() => {}); // оновлення активності (throttled усередині), не блокує запит
});

// володіння run/post у межах workspace юзера
const cancelRun = new Set<string>();
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
  if (u.deleted_at) { await auth.restoreAccount(u.id); await logEvent("info", "account", `відновлено акаунт при вході: ${email}`, null, u.id); }
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
  // завжди ok - не розкриваємо, чи існує email
  return { ok: true, message: "Якщо такий email існує - ми надіслали лист для скидання." };
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

// ===================== ACCOUNT (профіль, гігієна, видалення) =====================
app.get("/api/account", async (req: any) => {
  const u = await one<{ email: string; email_verified: boolean; created_at: string; has_pw: boolean }>(
    `select email, email_verified, created_at, (password_hash is not null) as has_pw from app_user where id=$1`, [req.user.id]);
  const m = await one<{ n: number; bytes: string }>(
    `select count(*)::int n, coalesce(sum(size),0)::bigint bytes from media_asset where workspace_id=$1`, [req.user.workspace_id]);
  return { email: u?.email, emailVerified: u?.email_verified, createdAt: u?.created_at, hasPassword: !!u?.has_pw, media: { count: m?.n || 0, bytes: Number(m?.bytes || 0) } };
});

app.post("/api/account/password", async (req: any, reply) => {
  const cur = String(req.body?.currentPassword ?? "");
  const next = String(req.body?.newPassword ?? "");
  if (next.length < 8) return reply.code(400).send({ error: "Пароль мінімум 8 символів" });
  const u = await one<{ password_hash: string | null }>(`select password_hash from app_user where id=$1`, [req.user.id]);
  if (u?.password_hash && !auth.verifyPassword(cur, u.password_hash)) return reply.code(403).send({ error: "Поточний пароль невірний" });
  await auth.setPassword(req.user.id, next);
  await logEvent("info", "account", "пароль змінено", null, req.user.id);
  return { ok: true };
});

app.post("/api/account/email", async (req: any, reply) => {
  const newEmail = String(req.body?.email ?? "").trim().toLowerCase();
  const pw = String(req.body?.password ?? "");
  if (!emailOk(newEmail)) return reply.code(400).send({ error: "Некоректний email" });
  const u = await one<{ password_hash: string | null; email: string }>(`select password_hash, email from app_user where id=$1`, [req.user.id]);
  if (newEmail === u?.email) return reply.code(400).send({ error: "Це той самий email" });
  if (u?.password_hash && !auth.verifyPassword(pw, u.password_hash)) return reply.code(403).send({ error: "Пароль невірний" });
  if (await auth.userByEmail(newEmail)) return reply.code(409).send({ error: "Такий email вже зайнятий" });
  const old = u?.email;
  await auth.setEmailAddr(req.user.id, newEmail);
  try { if (old) await sendEmailChangedNotice(old, newEmail); await sendEmailChangedNotice(newEmail, newEmail); } catch { /* лист не критичний */ }
  await logEvent("info", "account", `email змінено: ${old} -> ${newEmail}`, null, req.user.id);
  return { ok: true, email: newEmail };
});

app.get("/api/account/export", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const [settings, rubrics, strategy, sources, posts, schedule, media] = await Promise.all([
    q(`select key, content from settings_block where workspace_id=$1`, [ws]),
    q(`select name, emoji, description, share, idx from rubric where workspace_id=$1 order by idx`, [ws]),
    one(`select data, status from strategy where workspace_id=$1`, [ws]),
    q(`select id, origin, title, transcript, created_at from source where workspace_id=$1 order by created_at`, [ws]),
    q(`select p.id, p.stage, p.review, p.content, p.channels, p.created_at from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 order by p.created_at`, [ws]),
    q(`select ss.scheduled_at, ss.status, p.content from schedule_slot ss left join plan_item pi on pi.id=ss.plan_item_id join post p on p.id=coalesce(ss.post_id, pi.post_id) join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1`, [ws]),
    q(`select kind, mime, original_name, filename, size, created_at from media_asset where workspace_id=$1`, [ws]),
  ]);
  reply.header("Content-Disposition", `attachment; filename="socialio-export.json"`);
  reply.type("application/json");
  return { exported_at: new Date().toISOString(), email: req.user.email, settings, rubrics, strategy, sources, posts, schedule, media };
});

app.post("/api/account/delete", async (req: any, reply) => {
  const confirm = String(req.body?.confirmEmail ?? "").trim().toLowerCase();
  if (confirm !== String(req.user.email).toLowerCase()) return reply.code(400).send({ error: "Введіть свій email для підтвердження" });
  await auth.softDeleteAccount(req.user.id);
  try { await sendDeletionScheduledEmail(req.user.email, `${env.appBaseUrl}/login`, 14); } catch { /* лист не критичний */ }
  await logEvent("info", "account", `акаунт заплановано до видалення: ${req.user.email}`, null, req.user.id);
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true, message: "Акаунт заплановано до видалення через 14 днів. Дані зникли з кабінету. Увійдіть протягом 14 днів, щоб скасувати." };
});

// почати з чистого листа: стерти весь контент воркспейсу + повернути онбординг (підключення каналів лишаються)
app.post("/api/account/reset", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (String(req.body?.confirm ?? "").trim().toUpperCase() !== "RESET") return reply.code(400).send({ error: "Введіть RESET для підтвердження" });
  const media = await q<{ filename: string }>(`select filename from media_asset where workspace_id=$1`, [ws]);
  for (const m of media) await deleteMediaFile(m.filename);
  await q(`delete from source where workspace_id=$1`, [ws]);          // каскад: runs→posts/ideas/step_run/content_plan→plan_item→schedule_slot(+publish-логи)
  await q(`delete from media_asset where workspace_id=$1`, [ws]);
  await q(`delete from content_source where workspace_id=$1`, [ws]);  // RSS
  await q(`delete from strategy where workspace_id=$1`, [ws]);
  await q(`delete from rubric where workspace_id=$1`, [ws]);
  await q(`delete from prompt_template where workspace_id=$1`, [ws]);
  await q(`delete from settings_block where workspace_id=$1`, [ws]);  // бренд/мова/онбординг-прапор
  await q(`delete from llm_usage where workspace_id=$1`, [ws]);
  await auth.seedWorkspaceDefaults(ws);                                // дефолтні налаштування + рубрики
  await logEvent("info", "account", `чистий старт (reset воркспейсу): ${req.user.email}`, null, req.user.id);
  return { ok: true, message: "Готово - кабінет очищено. Зараз почнеться онбординг." };
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

// скинути промпт кроку до стандартного (деактивує збережені версії → фолбек на DEFAULT_PROMPTS)
app.delete("/api/prompts/:step", async (req: any, reply) => {
  const step = req.params.step;
  if (!STEP_ORDER.includes(step)) return reply.code(400).send({ error: "невідомий крок" });
  await q(`update prompt_template set is_active=false where workspace_id=$1 and step_key=$2`, [req.user.workspace_id, step]);
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

// згенерувати джерело-бриф із Бази бренду - для «миттєвих перших постів» без транскрипту
app.post("/api/generate/from-brand", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const rows = await q<{ key: string; content: string }>(`select key, content from settings_block where workspace_id=$1`, [ws]);
  const s: Record<string, string> = {}; for (const r of rows) s[r.key] = r.content || "";
  const rubs = await q<{ name: string; description: string }>(`select name, description from rubric where workspace_id=$1 order by idx`, [ws]);
  if (!(s.marketing_context || "").trim() && !rubs.length) return reply.code(400).send({ error: "Спершу заповни Базу бренду (ніша й аудиторія)" });
  const brief = [
    s.marketing_context ? `Бренд і аудиторія:\n${s.marketing_context}` : "",
    s.tone_of_voice ? `Голос бренду:\n${s.tone_of_voice}` : "",
    s.content_strategy ? `Нотатки стратегії:\n${s.content_strategy}` : "",
    rubs.length ? `Рубрики контенту:\n${rubs.map((r) => `- ${r.name}${r.description ? `: ${r.description}` : ""}`).join("\n")}` : "",
    `Завдання: на основі цього бренду згенеруй ідеї та готові дописи для соцмереж. Пиши загальнокорисні пости в межах ніші, без вигаданих фактів про конкретні події.`,
  ].filter(Boolean).join("\n\n");
  const src = await one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,'brand','Згенеровано з Бази бренду',$2) returning id`, [ws, brief]);
  const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
  return { runId: run!.id };
});

// ----- контент-джерела (RSS) -----
app.get("/api/sources/rss", async (req: any) =>
  q(`select id, url, title, active, auto_run, last_pulled_at, last_error from content_source
     where workspace_id=$1 and kind='rss' order by created_at desc`, [req.user.workspace_id]));

app.post("/api/sources/rss", async (req: any, reply) => {
  const url = String(req.body?.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return reply.code(400).send({ error: "Вкажіть коректний URL стрічки (https://…)" });
  const autoRun = req.body?.autoRun === true;
  const r = await one<{ id: string }>(
    `insert into content_source(workspace_id, kind, url, auto_run) values($1,'rss',$2,$3) returning id`,
    [req.user.workspace_id, url, autoRun]);
  return { ok: true, id: r!.id };
});

app.put("/api/sources/rss/:id", async (req: any, reply) => {
  const owned = await one(`select id from content_source where id=$1 and workspace_id=$2`, [req.params.id, req.user.workspace_id]);
  if (!owned) return reply.code(404).send({ error: "стрічку не знайдено" });
  const active = typeof req.body?.active === "boolean" ? req.body.active : null;
  const autoRun = typeof req.body?.autoRun === "boolean" ? req.body.autoRun : null;
  await q(`update content_source set active=coalesce($2,active), auto_run=coalesce($3,auto_run) where id=$1`,
    [req.params.id, active, autoRun]);
  return { ok: true };
});

app.delete("/api/sources/rss/:id", async (req: any, reply) => {
  const owned = await one(`select id from content_source where id=$1 and workspace_id=$2`, [req.params.id, req.user.workspace_id]);
  if (!owned) return reply.code(404).send({ error: "стрічку не знайдено" });
  await q(`delete from content_source where id=$1`, [req.params.id]);
  return { ok: true };
});

app.post("/api/sources/rss/:id/pull", async (req: any, reply) => {
  try { return { ok: true, created: await pullFeed(req.params.id, req.user.workspace_id) }; }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// останні підтягнуті джерела (RSS/Fireflies/ручні) - щоб їх можна було відкрити в роботі
app.get("/api/sources/recent", async (req: any) =>
  q(`select s.id, s.title, s.origin, s.created_at, r.id as run_id
     from source s join pipeline_run r on r.source_id=s.id
     where s.workspace_id=$1 order by s.created_at desc limit 20`, [req.user.workspace_id]));

// ===================== МЕДІА-БІБЛІОТЕКА =====================
app.post("/api/media", async (req: any, reply) => {
  const saved: any[] = [];
  try {
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      const m = await saveMedia(req.user.workspace_id, { buffer: buf, mime: part.mimetype || "application/octet-stream", name: part.filename });
      saved.push({ id: m.id, kind: m.kind, url: `/media/${m.filename}` });
    }
  } catch (e: any) { return reply.code(400).send({ error: e.message }); }
  return { ok: true, saved };
});

app.get("/api/media", async (req: any) =>
  q(`select id, kind, mime, original_name, filename, size, source, created_at from media_asset
     where workspace_id=$1 order by created_at desc limit 200`, [req.user.workspace_id]));

app.delete("/api/media/:id", async (req: any, reply) => {
  const m = await one<{ filename: string }>(`select filename from media_asset where id=$1 and workspace_id=$2`, [req.params.id, req.user.workspace_id]);
  if (!m) return reply.code(404).send({ error: "медіа не знайдено" });
  await q(`delete from media_asset where id=$1`, [req.params.id]);
  await deleteMediaFile(m.filename);
  return { ok: true };
});

// прикріпити/відкріпити медіа до поста
app.post("/api/posts/:postId/media", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const mediaId = req.body?.mediaId || null;
  if (mediaId && !(await one(`select id from media_asset where id=$1 and workspace_id=$2`, [mediaId, ws])))
    return reply.code(404).send({ error: "медіа не знайдено" });
  await q(`update post set media_id=$2 where id=$1`, [req.params.postId, mediaId]);
  return { ok: true };
});


// ===================== КОМПОЗЕР (мульти-мережевий постинг) =====================
// які мережі взагалі підключені (для чипів у композері)
app.get("/api/channels/status", async (req: any) => {
  const ws = req.user.workspace_id;
  const [tgc, th, mt] = await Promise.all([
    one<{ bot_token: string | null; channel_chat_id: string | null; group_chat_id: string | null }>(`select bot_token, channel_chat_id, group_chat_id from telegram_config where workspace_id=$1`, [ws]),
    one<{ access_token: string | null }>(`select access_token from threads_config where workspace_id=$1`, [ws]),
    one<{ page_token: string | null; ig_user_id: string | null }>(`select page_token, ig_user_id from meta_config where workspace_id=$1`, [ws]),
  ]);
  return {
    telegram: !!(tgc && tgc.bot_token && (tgc.channel_chat_id || tgc.group_chat_id)),
    threads: !!(th && th.access_token),
    facebook: !!(mt && mt.page_token),
    instagram: !!(mt && mt.page_token && mt.ig_user_id),
  };
});

// повний стан поста для композера (текст, канали, фото)
app.get("/api/posts/:postId/full", async (req: any, reply) => {
  const p = await one(`select p.id, p.content, p.review, p.channels, p.headline, p.rubric, p.image_prompt, (p.image_base is not null) as has_base, ma.filename as media_filename
     from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     left join media_asset ma on ma.id=p.media_id
     where p.id=$1 and s.workspace_id=$2`, [req.params.postId, req.user.workspace_id]);
  if (!p) return reply.code(404).send({ error: "пост не знайдено" });
  return p;
});

// зберегти вибір мереж + тексти
app.post("/api/posts/:postId/channels", async (req: any, reply) => {
  if (!(await postOwned(req.params.postId, req.user.workspace_id))) return reply.code(404).send({ error: "пост не знайдено" });
  await q(`update post set channels=$2 where id=$1`, [req.params.postId, JSON.stringify(req.body?.channels ?? {})]);
  return { ok: true };
});

// AI-адаптація під обрані мережі
app.post("/api/posts/:postId/adapt", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string; channels: any }>(
    `select p.content, p.channels from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  const channels: string[] = Array.isArray(req.body?.channels) ? req.body.channels : [];
  try {
    const variants = await adaptForChannels(ws, post.content, channels);
    const cur = post.channels || {};
    for (const ch of channels) cur[ch] = { on: true, text: variants[ch] || (cur[ch] && cur[ch].text) || post.content };
    await q(`update post set channels=$2 where id=$1`, [req.params.postId, JSON.stringify(cur)]);
    return { ok: true, channels: cur };
  } catch (e: any) { await logEvent("error", "adapt", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// опублікувати в усі обрані мережі (через спільний publisher)
app.post("/api/posts/:postId/publish-all", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  try {
    const results = await publishPostToChannels(ws, req.params.postId);
    if (!results.length) return reply.code(400).send({ error: "Оберіть хоча б одну мережу" });
    // Публікація один раз на мережу: гасимо запланований слот ЛИШЕ якщо не лишилось не надісланих обраних мереж
    // (інакше слот має відпрацювати решту мереж пізніше). Так уникаємо і дубля, і скасування запланованого каналу.
    if (results.some((r) => r.status === "sent")) {
      const post = await one<{ channels: any }>(`select channels from post where id=$1`, [req.params.postId]);
      const enabled = Object.keys(post?.channels || {}).filter((k) => post!.channels[k] && post!.channels[k].on);
      const sent = new Set(await alreadySentNetworks(req.params.postId));
      const remaining = enabled.filter((k) => !sent.has(k));
      if (!remaining.length) {
        await q(`update schedule_slot set status='posted', result='опубліковано вручну (слот погашено)' where post_id=$1 and status='planned'`, [req.params.postId]);
        await q(`update plan_slot set status='published' where post_id=$1 and status in ('drafted','approved','scheduled')`, [req.params.postId]);
      }
    }
    return { ok: true, results };
  } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// стан публікації поста: у які мережі вже відправлено (для композера — блокуємо повторну відправку)
app.get("/api/posts/:postId/publish-state", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const sent = await alreadySentNetworks(req.params.postId);
  return { sent };
});

// AI-хештеги для поста (кнопка «# Хештеги» у композері)
app.post("/api/posts/:postId/hashtags", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try { const hashtags = await suggestHashtags(ws, String(req.body?.text || post.content || "")); return { ok: true, hashtags }; }
  catch (e: any) { await logEvent("error", "hashtags", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// ===================== GOOGLE DRIVE =====================
const GDRIVE_REDIRECT = `${env.appBaseUrl}/api/integrations/gdrive/callback`;

app.get("/api/integrations/gdrive", async (req: any) => {
  const c = await one<{ email: string | null; refresh_token: string | null }>(`select email, refresh_token from gdrive_config where workspace_id=$1`, [req.user.workspace_id]);
  return { configured: !!env.google.clientId, connected: !!(c && c.refresh_token), email: c?.email ?? "" };
});

app.get("/api/integrations/gdrive/connect", async (req: any, reply) => {
  if (!env.google.clientId) return reply.code(400).send({ error: "GOOGLE_CLIENT_ID не заданий на сервері" });
  const state = auth.newToken();
  reply.setCookie("gdrive_state", state, stateCookie);
  return reply.redirect(gdrive.authUrl(env.google.clientId, GDRIVE_REDIRECT, state));
});

app.get("/api/integrations/gdrive/callback", async (req: any, reply) => {
  const code = String(req.query?.code ?? ""); const state = String(req.query?.state ?? "");
  const oerr = String(req.query?.error ?? "");
  if (oerr) { await logEvent("error", "gdrive", `Google відмовив: ${oerr}`, null, req.user?.id); return reply.redirect("/app?gdrive=error"); }
  if (!code || !state || state !== req.cookies?.gdrive_state) return reply.redirect("/app?gdrive=error");
  reply.clearCookie("gdrive_state", { path: "/" });
  try {
    const t = await gdrive.exchangeCode(env.google.clientId, env.google.clientSecret, GDRIVE_REDIRECT, code);
    const email = await gdrive.getEmail(t.access_token).catch(() => "");
    const exp = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
    await q(`insert into gdrive_config(workspace_id, access_token, refresh_token, token_expires_at, email, updated_at)
             values($1,$2,$3,$4,$5,now())
             on conflict (workspace_id) do update set access_token=excluded.access_token,
               refresh_token=coalesce(excluded.refresh_token, gdrive_config.refresh_token),
               token_expires_at=excluded.token_expires_at, email=excluded.email, updated_at=now()`,
      [req.user.workspace_id, t.access_token, t.refresh_token ?? null, exp, email]);
    await logEvent("info", "gdrive", `підключено ${email}`, null, req.user.id);
    return reply.redirect("/app?gdrive=ok");
  } catch (e: any) {
    await logEvent("error", "gdrive", "OAuth callback: " + e.message, null, req.user?.id);
    return reply.redirect("/app?gdrive=error");
  }
});

app.post("/api/integrations/gdrive/disconnect", async (req: any) => {
  await q(`delete from gdrive_config where workspace_id=$1`, [req.user.workspace_id]);
  return { ok: true };
});

// токен + ключі для Google Picker (фронт відкриває нативний вибір папки)
app.get("/api/integrations/gdrive/picker-token", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const c = await one<{ refresh_token: string | null }>(`select refresh_token from gdrive_config where workspace_id=$1`, [ws]);
  if (!c?.refresh_token) return reply.code(400).send({ error: "Спершу підключіть Google Drive" });
  if (!env.google.apiKey) return reply.code(400).send({ error: "GOOGLE_API_KEY не заданий на сервері" });
  try {
    const t = await gdrive.refresh(env.google.clientId, env.google.clientSecret, c.refresh_token);
    await q(`update gdrive_config set access_token=$2, token_expires_at=$3, updated_at=now() where workspace_id=$1`,
      [ws, t.access_token, new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString()]);
    return { token: t.access_token, apiKey: env.google.apiKey, appId: env.google.clientId.split("-")[0] || "" };
  } catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

app.get("/api/sources/gdrive", async (req: any) =>
  q(`select id, folder_id, name, active, last_pulled_at, last_error from gdrive_folder where workspace_id=$1 order by created_at desc`, [req.user.workspace_id]));

app.post("/api/sources/gdrive", async (req: any, reply) => {
  const folderId = String(req.body?.folderId ?? "").trim();
  if (!folderId) return reply.code(400).send({ error: "Оберіть папку через Google Picker" });
  const dup = await one<{ id: string }>(`select id from gdrive_folder where workspace_id=$1 and folder_id=$2`, [req.user.workspace_id, folderId]);
  if (dup) return { ok: true, id: dup.id, duplicate: true };
  const r = await one<{ id: string }>(`insert into gdrive_folder(workspace_id, folder_id, name) values($1,$2,$3) returning id`,
    [req.user.workspace_id, folderId, String(req.body?.name ?? "").slice(0, 120) || null]);
  return { ok: true, id: r!.id };
});

app.put("/api/sources/gdrive/:id", async (req: any, reply) => {
  const owned = await one(`select id from gdrive_folder where id=$1 and workspace_id=$2`, [req.params.id, req.user.workspace_id]);
  if (!owned) return reply.code(404).send({ error: "папку не знайдено" });
  const active = typeof req.body?.active === "boolean" ? req.body.active : null;
  await q(`update gdrive_folder set active=coalesce($2,active) where id=$1`, [req.params.id, active]);
  return { ok: true };
});

app.delete("/api/sources/gdrive/:id", async (req: any, reply) => {
  const owned = await one(`select id from gdrive_folder where id=$1 and workspace_id=$2`, [req.params.id, req.user.workspace_id]);
  if (!owned) return reply.code(404).send({ error: "папку не знайдено" });
  await q(`delete from gdrive_folder where id=$1`, [req.params.id]);
  return { ok: true };
});

app.post("/api/sources/gdrive/:id/pull", async (req: any, reply) => {
  try { return { ok: true, created: await pullGdriveFolder(req.params.id, req.user.workspace_id) }; }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

app.get("/api/runs/:id", async (req: any, reply) => {
  const { id } = req.params;
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  const run = await one(`select * from pipeline_run where id=$1`, [id]);
  const [steps, ideas, posts, plan, published, schedule] = await Promise.all([
    q(`select step_key,status,model,prompt_version,output,error,updated_at from step_run where run_id=$1`, [id]),
    q(`select id,idx,idea,angle,selected from idea where run_id=$1 order by idx`, [id]),
    q(`select p.id,p.stage,p.channel_type,p.content,p.review,p.media_id,p.channels, ma.filename as media_filename
       from post p left join media_asset ma on ma.id=p.media_id where p.run_id=$1 order by p.created_at`, [id]),
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
  const source = await one(`select s.title, left(s.transcript,280) as snippet, length(s.transcript) as len
                            from source s join pipeline_run r on r.source_id=s.id where r.id=$1`, [id]);
  return { run, source, steps, ideas, posts, plan, published, schedule };
});

app.post("/api/runs/:id/steps/:step/run", async (req: any, reply) => {
  const { id, step } = req.params;
  if (!STEP_ORDER.includes(step)) return reply.code(400).send({ error: "невідомий крок" });
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  const opts = { count: req.body?.count, rubrics: req.body?.rubrics };
  try { await executeStep(id, step as StepKey, opts); return { ok: true }; }
  catch (e: any) { await logEvent("error", "pipeline", `крок ${step}: ${e.message}`, { runId: id }, req.user.id); return reply.code(500).send({ error: e.message }); }
});

app.post("/api/runs/:id/run-from/:step", async (req: any, reply) => {
  const { id, step } = req.params;
  const idx = STEP_ORDER.indexOf(step);
  if (idx < 0) return reply.code(400).send({ error: "невідомий крок" });
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  const opts = { count: req.body?.count, rubrics: req.body?.rubrics };
  try {
    for (const s of STEP_ORDER.slice(idx)) {
      if (cancelRun.has(id)) { cancelRun.delete(id); break; }
      await executeStep(id, s as StepKey, s === "extract_ideas" ? opts : undefined);
    }
    cancelRun.delete(id);
    return { ok: true };
  } catch (e: any) { cancelRun.delete(id); await logEvent("error", "pipeline", `run-from ${step}: ${e.message}`, { runId: id }, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// Автопілот: повний прогін кишки (чернетки лишаються на підтвердження - банк-pending)
app.post("/api/runs/:id/autopilot", async (req: any, reply) => {
  const id = req.params.id;
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  try {
    for (const s of STEP_ORDER) { if (cancelRun.has(id)) { cancelRun.delete(id); break; } await executeStep(id, s as StepKey); }
    cancelRun.delete(id);
    await logEvent("info", "autopilot", "повний прогін", { runId: id }, req.user.id); return { ok: true };
  } catch (e: any) { cancelRun.delete(id); await logEvent("error", "autopilot", e.message, { runId: id }, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// LITE: одна генерація N готових постів (замість 6-крокової кишки) - дешево
app.post("/api/runs/:id/generate-lite", async (req: any, reply) => {
  const id = req.params.id; const ws = req.user.workspace_id;
  if (!(await runOwned(id, ws))) return reply.code(404).send({ error: "run не знайдено" });
  try {
    const count = await generatePostsOnePass(id, Number(req.body?.count) || 6, Array.isArray(req.body?.ideas) ? req.body.ideas : undefined);
    let images = 0;
    if (req.body?.images) {
      const posts = await q<{ id: string }>(`select id from post where run_id=$1 and stage='final'`, [id]);
      // онбординг шле provider:'gemini' (Nano Banana) для вау-ефекту перших зображень; без ключа - дефолтний провайдер
      const provider = ["openai", "fal", "gemini"].includes(req.body?.provider) ? req.body.provider : undefined;
      const res = await Promise.allSettled(posts.map((p) => generateImageForPost(ws, p.id, provider ? { provider } : undefined)));
      images = res.filter((r) => r.status === "fulfilled").length;
    }
    return { ok: true, count, images };
  } catch (e: any) { await logEvent("error", "lite", e.message, { runId: id }, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// згенерувати ідеї (дешево) для блоку «💡 Ідеї → пости» у Студії
app.post("/api/runs/:id/ideas", async (req: any, reply) => {
  const id = req.params.id;
  if (!(await runOwned(id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  try {
    await executeStep(id, "extract_ideas", { count: Number(req.body?.count) || 6, rubrics: Array.isArray(req.body?.rubrics) ? req.body.rubrics : undefined });
    const ideas = await q<{ idea: string; angle: string }>(`select idea, angle from idea where run_id=$1 order by idx`, [id]);
    return { ok: true, ideas };
  } catch (e: any) { await logEvent("error", "ideas", e.message, { runId: id }, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// згенерувати зображення для одного поста (кнопка «🎨 Зображення»)
app.post("/api/posts/:postId/image", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  try { const filename = await generateImageForPost(ws, req.params.postId, { headline: req.body?.headline, aspect: req.body?.aspect, provider: req.body?.provider, prompt: req.body?.prompt }); return { ok: true, filename }; }
  catch (e: any) { await logEvent("error", "image", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// перенакласти текст на вже згенероване БАЗОВЕ зображення (дешево, без нової генерації)
app.post("/api/posts/:postId/image-text", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  try { const filename = await overlayForPost(ws, req.params.postId, String(req.body?.headline ?? ""), req.body?.overlay !== false); return { ok: true, filename }; }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// провайдер зображень: статус (які ключі є) + вибір
app.get("/api/integrations/images", async (req: any) => {
  const ws = req.user.workspace_id;
  const [prov, ov] = await Promise.all([
    one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='image_provider'`, [ws]),
    one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='image_overlay'`, [ws]),
  ]);
  return { provider: prov?.content || "openai", overlay: (ov?.content ?? "1") !== "0", available: imageProviders() };
});
app.post("/api/integrations/images", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (req.body?.provider !== undefined) {
    const p = String(req.body.provider);
    if (!["openai", "fal", "gemini"].includes(p)) return reply.code(400).send({ error: "невідомий провайдер" });
    await q(`insert into settings_block(workspace_id,key,content) values($1,'image_provider',$2)
             on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`, [ws, p]);
  }
  if (req.body?.overlay !== undefined) {
    await q(`insert into settings_block(workspace_id,key,content) values($1,'image_overlay',$2)
             on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`, [ws, req.body.overlay ? "1" : "0"]);
  }
  return { ok: true };
});

// перегляд спільного промту Lite-генерації (прозорість: що саме йде в модель)
app.get("/api/generate/prompt-preview", async (req: any) => {
  const n = Math.max(1, Math.min(12, Number(req.query?.count) || 6));
  return buildLitePrompt(req.user.workspace_id, n);
});

app.post("/api/runs/:id/cancel", async (req: any, reply) => {
  if (!(await runOwned(req.params.id, req.user.workspace_id))) return reply.code(404).send({ error: "run не знайдено" });
  cancelRun.add(req.params.id);
  return { ok: true };
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
    sharedBot: botEnabled(),
  };
});

// спільний бот: видати deep-link для підключення каналу
app.post("/api/integrations/telegram/connect-link", async (req: any, reply) => {
  if (!botEnabled()) return reply.code(400).send({ error: "Спільний бот не налаштований на сервері" });
  try { return { link: await createConnectLink(req.user.workspace_id), bot: botUsername() }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
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


// ===================== THREADS (Meta) =====================
const THREADS_REDIRECT = `${env.appBaseUrl}/api/integrations/threads/callback`;
const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_insights"];

async function thConfig(ws: string) {
  return one<{ threads_user_id: string | null; username: string | null; access_token: string | null; token_expires_at: string | null }>(
    `select threads_user_id, username, access_token, token_expires_at from threads_config where workspace_id=$1`, [ws]);
}

// дійсний токен (рефреш якщо лишилось < 7 днів до завершення 60-денного)
async function thValidToken(ws: string): Promise<{ token: string; userId: string } | null> {
  const c = await thConfig(ws);
  if (!c?.access_token || !c.threads_user_id) return null;
  const exp = c.token_expires_at ? new Date(c.token_expires_at).getTime() : 0;
  if (exp && exp - Date.now() < 7 * 864e5) {
    try {
      const r = await threads.refreshToken(c.access_token);
      const newExp = new Date(Date.now() + r.expires_in * 1000).toISOString();
      await q(`update threads_config set access_token=$2, token_expires_at=$3, updated_at=now() where workspace_id=$1`, [ws, r.access_token, newExp]);
      return { token: r.access_token, userId: c.threads_user_id };
    } catch { /* рефреш не вдався - пробуємо наявним токеном */ }
  }
  return { token: c.access_token, userId: c.threads_user_id };
}

app.get("/api/integrations/threads", async (req: any) => {
  const c = await thConfig(req.user.workspace_id);
  return { configured: !!env.threads.appId, hasToken: !!(c && c.access_token), username: c?.username ?? "", expiresAt: c?.token_expires_at ?? null };
});

app.get("/api/integrations/threads/connect", async (req: any, reply) => {
  if (!env.threads.appId) return reply.code(400).send({ error: "THREADS_APP_ID не заданий на сервері" });
  const state = auth.newToken();
  reply.setCookie("threads_state", state, stateCookie);
  await logEvent("info", "threads", `connect redirect_uri=${THREADS_REDIRECT}`, { scopes: THREADS_SCOPES }, req.user.id);
  return reply.redirect(threads.authUrl(env.threads.appId, THREADS_REDIRECT, state, THREADS_SCOPES));
});

app.get("/api/integrations/threads/callback", async (req: any, reply) => {
  const code = String(req.query?.code ?? ""); const state = String(req.query?.state ?? "");
  const oerr = String(req.query?.error_description ?? req.query?.error ?? "");
  if (oerr) { await logEvent("error", "threads", `Threads відмовив: ${oerr}`, { error: req.query?.error }, req.user.id); return reply.redirect("/app?threads=error"); }
  if (!code) { await logEvent("error", "threads", "callback без code", { keys: Object.keys(req.query || {}) }, req.user.id); return reply.redirect("/app?threads=error"); }
  if (!state || state !== req.cookies?.threads_state) { await logEvent("error", "threads", `state mismatch - cookie ${req.cookies?.threads_state ? "є але != state" : "ВІДСУТНІЙ"}`, null, req.user.id); return reply.redirect("/app?threads=error"); }
  reply.clearCookie("threads_state", { path: "/" });
  try {
    const short = await threads.exchangeCode(env.threads.appId, env.threads.appSecret, THREADS_REDIRECT, code);
    const long = await threads.exchangeLongLived(env.threads.appSecret, short.access_token);
    const me = await threads.getMe(long.access_token).catch(() => ({ id: short.user_id, username: "" }));
    const exp = new Date(Date.now() + long.expires_in * 1000).toISOString();
    await q(`insert into threads_config(workspace_id, threads_user_id, username, access_token, token_expires_at, updated_at)
             values($1,$2,$3,$4,$5,now())
             on conflict (workspace_id) do update set threads_user_id=excluded.threads_user_id, username=excluded.username,
               access_token=excluded.access_token, token_expires_at=excluded.token_expires_at, updated_at=now()`,
      [req.user.workspace_id, me.id || short.user_id, me.username ?? "", long.access_token, exp]);
    await logEvent("info", "threads", `підключено @${me.username || me.id}`, null, req.user.id);
    return reply.redirect("/app?threads=ok");
  } catch (e: any) {
    await logEvent("error", "threads", "OAuth callback: " + e.message, null, req.user.id);
    return reply.redirect("/app?threads=error");
  }
});

app.post("/api/integrations/threads/disconnect", async (req: any) => {
  await q(`delete from threads_config where workspace_id=$1`, [req.user.workspace_id]);
  return { ok: true };
});


app.get("/api/posts/:postId/threads-insights", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const pub = await one<{ media_id: string }>(
    `select media_id from threads_publish where post_id=$1 and status='sent' and media_id is not null order by created_at desc limit 1`,
    [req.params.postId]);
  if (!pub?.media_id) return reply.code(400).send({ error: "Цей пост ще не опубліковано в Threads" });
  const tok = await thValidToken(ws);
  if (!tok) return reply.code(400).send({ error: "Threads не підключений" });
  try { return await threads.mediaInsights(tok.token, pub.media_id); }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// ===================== META (Facebook + Instagram) =====================
const META_REDIRECT = `${env.appBaseUrl}/api/integrations/meta/callback`;
const META_SCOPES = ["public_profile", "pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish", "instagram_manage_insights"];

async function metaCfg(ws: string) {
  return one<{ page_id: string | null; page_name: string | null; page_token: string | null; ig_user_id: string | null; ig_username: string | null; token_expires_at: string | null }>(
    `select page_id, page_name, page_token, ig_user_id, ig_username, token_expires_at from meta_config where workspace_id=$1`, [ws]);
}

app.get("/api/integrations/meta", async (req: any) => {
  const c = await metaCfg(req.user.workspace_id);
  return {
    configured: !!env.meta.appId,
    hasToken: !!(c && c.page_token),
    pageName: c?.page_name ?? "",
    igUsername: c?.ig_username ?? "",
    expiresAt: c?.token_expires_at ?? null,
  };
});

app.get("/api/integrations/meta/connect", async (req: any, reply) => {
  if (!env.meta.appId) return reply.code(400).send({ error: "META_APP_ID не заданий на сервері" });
  const state = auth.newToken();
  reply.setCookie("meta_state", state, stateCookie);
  await logEvent("info", "meta", `connect redirect_uri=${META_REDIRECT}`, { scopes: META_SCOPES }, req.user.id);
  return reply.redirect(meta.authUrl(env.meta.appId, META_REDIRECT, state, META_SCOPES));
});

app.get("/api/integrations/meta/callback", async (req: any, reply) => {
  const code = String(req.query?.code ?? ""); const state = String(req.query?.state ?? "");
  const oerr = String(req.query?.error_description ?? req.query?.error ?? "");
  if (oerr) { await logEvent("error", "meta", `Meta відмовив: ${oerr}`, { error: req.query?.error }, req.user.id); return reply.redirect("/app?meta=error"); }
  if (!code) { await logEvent("error", "meta", "callback без code", { keys: Object.keys(req.query || {}) }, req.user.id); return reply.redirect("/app?meta=error"); }
  if (!state || state !== req.cookies?.meta_state) { await logEvent("error", "meta", `state mismatch - cookie ${req.cookies?.meta_state ? "є але != state" : "ВІДСУТНІЙ"}`, null, req.user.id); return reply.redirect("/app?meta=error"); }
  reply.clearCookie("meta_state", { path: "/" });
  try {
    const short = await meta.exchangeCode(env.meta.appId, env.meta.appSecret, META_REDIRECT, code);
    const long = await meta.exchangeLongLived(env.meta.appId, env.meta.appSecret, short.access_token);
    const pages = await meta.getPages(long.access_token);
    if (!pages.length) return reply.redirect("/app?meta=nopage");
    const page = pages.find((p) => p.instagram_business_account?.id) || pages[0]; // надаємо перевагу сторінці з IG
    const exp = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null;
    await q(`insert into meta_config(workspace_id, user_token, page_id, page_name, page_token, ig_user_id, ig_username, token_expires_at, updated_at)
             values($1,$2,$3,$4,$5,$6,$7,$8,now())
             on conflict (workspace_id) do update set user_token=excluded.user_token, page_id=excluded.page_id, page_name=excluded.page_name,
               page_token=excluded.page_token, ig_user_id=excluded.ig_user_id, ig_username=excluded.ig_username,
               token_expires_at=excluded.token_expires_at, updated_at=now()`,
      [req.user.workspace_id, long.access_token, page.id, page.name, page.access_token,
       page.instagram_business_account?.id ?? null, page.instagram_business_account?.username ?? null, exp]);
    await logEvent("info", "meta", `підключено сторінку «${page.name}»${page.instagram_business_account ? ` + IG @${page.instagram_business_account.username || ""}` : ""}`, null, req.user.id);
    return reply.redirect("/app?meta=ok");
  } catch (e: any) {
    await logEvent("error", "meta", "OAuth callback: " + e.message, null, req.user.id);
    return reply.redirect("/app?meta=error");
  }
});

app.post("/api/integrations/meta/disconnect", async (req: any) => {
  await q(`delete from meta_config where workspace_id=$1`, [req.user.workspace_id]);
  return { ok: true };
});

// вивести голос бренду з останніх постів Instagram (читаємо підписи -> voice_examples -> deriveVoice)
app.post("/api/integrations/meta/import-voice", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const c = await metaCfg(ws);
  if (!c?.ig_user_id || !c.page_token) return reply.code(400).send({ error: "Instagram не підключений" });
  let media;
  try { media = await meta.getRecentMedia(c.ig_user_id, c.page_token, 20); }
  catch (e: any) { return reply.code(400).send({ error: "Не вдалося прочитати пости IG: " + e.message }); }
  const captions = media.map((m) => (m.caption || "").trim()).filter((t) => t.length > 15);
  if (captions.length < 2) return reply.code(400).send({ error: "Замало текстових постів в Instagram для аналізу" });
  const joined = captions.slice(0, 20).join("\n\n---\n\n");
  await q(`insert into settings_block(workspace_id, key, content) values($1,'voice_examples',$2)
           on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`, [ws, joined]);
  const d = await deriveBrandFromText(ws, joined);
  // явна дія «аналізувати IG» -> ПЕРЕЗАПИСУЄМО поля бренду свіжими (інакше при зміні акаунта лишаються старі дані)
  const upsert = (key: string, val: string) => q(`insert into settings_block(workspace_id,key,content) values($1,$2,$3) on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`, [ws, key, val]);
  if (d.marketing_context) await upsert("marketing_context", d.marketing_context);
  if (d.content_strategy) await upsert("content_strategy", d.content_strategy);
  if (d.tone_of_voice) { await upsert("tone_of_voice", d.tone_of_voice); await upsert("tone_of_voice_derived", d.tone_of_voice); }
  if (d.language) await upsert("output_language", d.language); // будь-яка мова, не лише з дропдауна
  await logEvent("info", "meta", `бренд виведено з ${captions.length} IG-постів (мова: ${d.language || "?"})`, null, req.user.id);
  return { ok: true, count: captions.length, derived: d.tone_of_voice, marketing_context: d.marketing_context, content_strategy: d.content_strategy, language: d.language };
});


app.get("/api/posts/:postId/facebook-insights", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const pub = await one<{ external_id: string }>(
    `select external_id from meta_publish where post_id=$1 and channel='facebook' and status='sent' and external_id is not null order by created_at desc limit 1`,
    [req.params.postId]);
  if (!pub?.external_id) return reply.code(400).send({ error: "Цей пост ще не опубліковано у Facebook" });
  const c = await metaCfg(ws);
  if (!c?.page_token) return reply.code(400).send({ error: "Facebook не підключений" });
  try { return await meta.postInsights(pub.external_id, c.page_token); }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// зведена аналітика акаунтів (FB-Сторінка + IG): надійні поля підписників
app.get("/api/integrations/meta/stats", async (req: any, reply) => {
  const c = await metaCfg(req.user.workspace_id);
  if (!c?.page_token) return reply.code(400).send({ error: "Meta не підключений" });
  const out: any = {};
  try { if (c.page_id) out.facebook = await meta.pageStats(c.page_id, c.page_token); } catch (e: any) { out.facebookError = e.message; }
  try { if (c.ig_user_id) out.instagram = await meta.igStats(c.ig_user_id, c.page_token); } catch (e: any) { out.instagramError = e.message; }
  try { if (c.ig_user_id) out.instagramInsights = await meta.igInsights(c.ig_user_id, c.page_token); } catch (e: any) { out.instagramInsightsError = e.message; }
  return out;
});

// список доступних FB-Сторінок (+ їх IG) для вибору акаунта
app.get("/api/integrations/meta/pages", async (req: any, reply) => {
  const c = await one<{ user_token: string | null; page_id: string | null }>(`select user_token, page_id from meta_config where workspace_id=$1`, [req.user.workspace_id]);
  if (!c?.user_token) return reply.code(400).send({ error: "Meta не підключений" });
  try {
    const pages = await meta.getPages(c.user_token);
    return pages.map((p) => ({ id: p.id, name: p.name, ig: p.instagram_business_account?.username || null, current: p.id === c.page_id }));
  } catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// обрати конкретну сторінку (та її IG) як активну
app.post("/api/integrations/meta/select", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const pageId = String(req.body?.pageId ?? "");
  const c = await one<{ user_token: string | null }>(`select user_token from meta_config where workspace_id=$1`, [ws]);
  if (!c?.user_token) return reply.code(400).send({ error: "Meta не підключений" });
  const pages = await meta.getPages(c.user_token).catch(() => [] as any[]);
  const page = pages.find((p) => p.id === pageId);
  if (!page) return reply.code(404).send({ error: "сторінку не знайдено" });
  await q(`update meta_config set page_id=$2, page_name=$3, page_token=$4, ig_user_id=$5, ig_username=$6, updated_at=now() where workspace_id=$1`,
    [ws, page.id, page.name, page.access_token, page.instagram_business_account?.id ?? null, page.instagram_business_account?.username ?? null]);
  await logEvent("info", "meta", `обрано сторінку «${page.name}»`, null, req.user.id);
  return { ok: true };
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
  if (typeof req.body?.content === "string") await q(`update post set content=$2 where id=$1`, [req.params.postId, req.body.content]);
  if (typeof req.body?.rubric === "string") await q(`update post set rubric=nullif($2,'') where id=$1`, [req.params.postId, req.body.rubric.slice(0, 60)]);
  return { ok: true };
});

app.post("/api/posts/:postId/review", async (req: any, reply) => {
  if (!(await postOwned(req.params.postId, req.user.workspace_id))) return reply.code(404).send({ error: "пост не знайдено" });
  const status = String(req.body?.status ?? "");
  if (!["approved", "needs_work", "archived", ""].includes(status)) return reply.code(400).send({ error: "невідомий статус" });
  await q(`update post set review=nullif($2,'') where id=$1`, [req.params.postId, status]);
  // синхронізація скелета плану: затвердив -> слот approved; заархівував -> слот звільняється
  if (status === "approved")
    await q(`update plan_slot set status='approved' where post_id=$1 and status='drafted'`, [req.params.postId]);
  else if (status === "archived")
    await q(`update plan_slot set status = case when match_source_id is null then 'empty' else 'matched' end, post_id=null
             where post_id=$1 and status in ('drafted','approved')`, [req.params.postId]);
  return { ok: true };
});

app.post("/api/posts/:postId/regenerate", async (req: any, reply) => {
  const post = await postOwned(req.params.postId, req.user.workspace_id);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try {
    const fresh = await rewritePost(req.user.workspace_id, post.content, typeof req.body?.instruction === "string" ? req.body.instruction : undefined);
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

// ===================== БАЗА БРЕНДУ =====================
app.post("/api/brand/derive-voice", async (req: any, reply) => {
  try { return { derived: await deriveVoice(req.user.workspace_id) }; }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// ===================== СТРАТЕГІЯ (згенерована, L2) =====================
app.get("/api/strategy", async (req: any) => {
  const r = await one(`select data, status, updated_at from strategy where workspace_id=$1`, [req.user.workspace_id]);
  return r ?? { data: {}, status: "none" };
});
app.post("/api/strategy/generate", async (req: any, reply) => {
  try {
    const ws = req.user.workspace_id;
    const data = await generateStrategy(ws);
    if (Array.isArray(data?.rubrics)) await saveRubrics(ws, data.rubrics);  // авто-застосування: рубрики одразу в роботі (без прихованого «Застосувати»)
    await q(`update strategy set status='applied', updated_at=now() where workspace_id=$1`, [ws]);
    return { data, status: "applied" };
  } catch (e: any) { return reply.code(400).send({ error: e.message }); }
});
app.put("/api/strategy", async (req: any) => {
  await q(`insert into strategy(workspace_id,data,status,updated_at) values($1,$2,'draft',now())
           on conflict (workspace_id) do update set data=excluded.data, updated_at=now()`,
    [req.user.workspace_id, JSON.stringify(req.body?.data ?? {})]);
  return { ok: true };
});

// ===================== V2: КОНТЕНТ-ПЛАН ПО КАНАЛАХ (Prompt 2-7) =====================
app.post("/api/channel-plan", async (req: any, reply) => {
  try {
    const ws = req.user.workspace_id;
    const channel = String(req.body?.channel || "").trim();
    const horizon = Math.max(7, Math.min(90, Number(req.body?.horizon) || 30));
    const ppw = Math.max(1, Math.min(14, Number(req.body?.posts_per_week) || 4));
    const rows = await generateChannelPlan(ws, channel, horizon, ppw);
    return { ok: true, channel, rows };
  } catch (e: any) { await logEvent("error", "channel_plan", e.message, null, req.user.id); return reply.code(400).send({ error: e.message }); }
});
app.get("/api/channel-plan/:channel", async (req: any) => {
  const r = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key=$2`, [req.user.workspace_id, "channel_plan_" + req.params.channel]);
  let rows: any[] = []; try { rows = r ? JSON.parse(r.content) : []; } catch { rows = []; }
  return { channel: req.params.channel, rows };
});

// ===================== ПЛАН-СКЕЛЕТ (workspace-scoped слоти: що і коли має вийти) =====================
// Lite (mode='lite', default): ОДИН канало-незалежний скелет (channel='all') детерміновано зі стратегії.
// PRO (mode='pro', channel=X): багатший план під конкретний канал (LLM, нативні алгоритми) - окрема вкладка.
app.post("/api/plan/generate", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  try {
    const mode = req.body?.mode === "pro" ? "pro" : "lite";
    const horizon = Math.max(7, Math.min(90, Number(req.body?.horizon) || 14));
    const anchor = new Date(); anchor.setUTCHours(12, 0, 0, 0);
    let n = 0;
    if (mode === "pro") {
      const channel = String(req.body?.channel || "telegram").trim();
      const ppw = Math.max(1, Math.min(14, Number(req.body?.posts_per_week) || 4));
      const rows = await generateChannelPlan(ws, channel, horizon, ppw);
      if (!rows.length) return reply.code(400).send({ error: "План порожній - спершу згенеруй стратегію (розділ Стратегія)" });
      await q(`delete from plan_slot where workspace_id=$1 and channel=$2 and status in ('empty','matched')`, [ws, channel]);
      for (const r of rows) {
        const day = Math.max(1, Number(r?.day) || (n + 1));
        const d = new Date(anchor); d.setUTCDate(d.getUTCDate() + day);
        await q(`insert into plan_slot(workspace_id, slot_date, channel, rubric, theme, hook, cta) values($1,$2,$3,$4,$5,$6,$7)`,
          [ws, d.toISOString().slice(0, 10), channel, String(r?.pillar || "").slice(0, 60) || null,
           String(r?.message || r?.hook || "Тема").slice(0, 300), String(r?.hook || "").slice(0, 300) || null, String(r?.cta || "").slice(0, 200) || null]);
        n++;
      }
    } else {
      const ppw = Math.max(1, Math.min(14, Number(req.body?.posts_per_week) || 4));
      const slots = await buildLiteSkeleton(ws, horizon, ppw); // кидає чітку помилку, якщо нема стратегії
      // Lite = ОДИН спільний скелет: прибираємо незаповнені слоти БУДЬ-ЯКОГО каналу (включно з легасі-скелетами до переходу на channel='all')
      await q(`delete from plan_slot where workspace_id=$1 and status in ('empty','matched')`, [ws]);
      for (const sl of slots) {
        const d = new Date(anchor); d.setUTCDate(d.getUTCDate() + sl.day);
        await q(`insert into plan_slot(workspace_id, slot_date, channel, rubric, theme, hook) values($1,$2,'all',$3,$4,$5)`,
          [ws, d.toISOString().slice(0, 10), sl.rubric || null, sl.theme.slice(0, 300), sl.hook.slice(0, 300) || null]);
        n++;
      }
    }
    let matched = 0; try { matched = await matchPlanSlots(ws); } catch { /* метчинг не критичний */ }
    return { ok: true, slots: n, matched };
  } catch (e: any) { await logEvent("error", "plan", e.message, null, req.user.id); return reply.code(400).send({ error: e.message }); }
});

app.get("/api/plan", async (req: any) => {
  const channel = req.query?.channel ? String(req.query.channel) : null;
  const slots = await q(
    `select ps.id, ps.slot_date, ps.channel, ps.rubric, ps.theme, ps.hook, ps.status, ps.match_note, ps.post_id, s.title as match_title
     from plan_slot ps left join source s on s.id = ps.match_source_id
     where ps.workspace_id=$1 ${channel ? "and ps.channel=$2" : ""} order by ps.slot_date`,
    channel ? [req.user.workspace_id, channel] : [req.user.workspace_id]);
  const channels = await q<{ channel: string }>(`select distinct channel from plan_slot where workspace_id=$1`, [req.user.workspace_id]);
  return { slots, channels: channels.map((c) => c.channel) };
});

app.post("/api/plan/match", async (req: any, reply) => {
  try { const n = await matchPlanSlots(req.user.workspace_id); return { ok: true, matched: n }; }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// Згенерувати пост для слота: from='material' (зі зметченого матеріалу) або 'theme' (чиста генерація з теми)
app.post("/api/plan/slots/:id/generate", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const slot = await one<{ id: string; theme: string; hook: string | null; cta: string | null; rubric: string | null; channel: string; match_source_id: string | null; status: string }>(
    `select id, theme, hook, cta, rubric, channel, match_source_id, status from plan_slot where id=$1 and workspace_id=$2`, [req.params.id, ws]);
  if (!slot) return reply.code(404).send({ error: "слот не знайдено" });
  try {
    const useMaterial = req.body?.from === "material" && slot.match_source_id;
    let sourceId = slot.match_source_id;
    if (!useMaterial) {
      // генерація «з теми»: джерело-план (origin='plan') з самою темою як матеріалом
      const src = await one<{ id: string }>(
        `insert into source(workspace_id, origin, title, transcript) values($1,'plan',$2,$3) returning id`,
        [ws, slot.theme.slice(0, 200), `Тема поста: ${slot.theme}${slot.hook ? `\nГачок: ${slot.hook}` : ""}${slot.cta ? `\nЗаклик: ${slot.cta}` : ""}`]);
      sourceId = src!.id;
    }
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [sourceId]);
    const idea = `${slot.theme}${slot.hook ? `. Гачок: ${slot.hook}` : ""}${slot.cta ? `. Заклик: ${slot.cta}` : ""}`;
    await generatePostsOnePass(run!.id, 1, [idea]);
    const post = await one<{ id: string }>(`select id from post where run_id=$1 and stage='final' limit 1`, [run!.id]);
    if (!post) throw new Error("пост не згенерувався");
    // привʼязка пост<->слот + рубрика слота + канал слота увімкнений
    await q(`update post set rubric=coalesce($2, rubric), channels=coalesce(channels,'{}'::jsonb) || $3::jsonb where id=$1`,
      [post.id, slot.rubric, JSON.stringify({ [slot.channel]: { on: true } })]);
    await q(`update plan_slot set status='drafted', post_id=$2 where id=$1`, [slot.id, post.id]);
    return { ok: true, postId: post.id };
  } catch (e: any) { await logEvent("error", "plan_slot", e.message, { slotId: slot.id }, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// ===================== МАТЕРІАЛИ (стрічка сировини) =====================
app.get("/api/materials", async (req: any) => {
  const rows = await q(
    `select s.id, s.origin, coalesce(s.title,'') as title, left(s.transcript, 260) as preview,
            length(s.transcript) as chars, s.created_at,
            ps.id as slot_id, ps.theme as slot_theme, ps.rubric as slot_rubric, ps.slot_date
     from source s
     left join plan_slot ps on ps.match_source_id = s.id and ps.status='matched'
     where s.workspace_id=$1 and s.archived=false and coalesce(s.transcript,'') <> ''
     order by s.created_at desc limit 60`, [req.user.workspace_id]);
  return { materials: rows };
});
app.get("/api/materials/:id", async (req: any, reply) => {
  const m = await one(`select id, origin, title, transcript, created_at from source where id=$1 and workspace_id=$2`, [req.params.id, req.user.workspace_id]);
  if (!m) return reply.code(404).send({ error: "матеріал не знайдено" });
  return m;
});
app.post("/api/materials/:id/archive", async (req: any, reply) => {
  const r = await one(`update source set archived=true where id=$1 and workspace_id=$2 returning id`, [req.params.id, req.user.workspace_id]);
  if (!r) return reply.code(404).send({ error: "матеріал не знайдено" });
  await q(`update plan_slot set status='empty', match_source_id=null, match_note=null where workspace_id=$1 and match_source_id=$2 and status='matched'`, [req.user.workspace_id, req.params.id]);
  return { ok: true };
});
// Ідеї з матеріалу (для модалки вибору перед генерацією)
app.post("/api/materials/:id/ideas", async (req: any, reply) => {
  const m = await one<{ transcript: string }>(`select transcript from source where id=$1 and workspace_id=$2`, [req.params.id, req.user.workspace_id]);
  if (!m) return reply.code(404).send({ error: "матеріал не знайдено" });
  try { const ideas = await extractIdeasFromText(req.user.workspace_id, m.transcript, Number(req.body?.count) || 6, Array.isArray(req.body?.rubrics) ? req.body.rubrics : undefined); return { ok: true, ideas }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});
// Створити пости з матеріалу (всі обрані ідеї, або 1 пост без ідей)
app.post("/api/materials/:id/posts", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const m = await one<{ id: string }>(`select id from source where id=$1 and workspace_id=$2`, [req.params.id, ws]);
  if (!m) return reply.code(404).send({ error: "матеріал не знайдено" });
  try {
    const ideas = Array.isArray(req.body?.ideas) ? req.body.ideas.map((x: any) => String(x).trim()).filter(Boolean) : [];
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [m.id]);
    const count = await generatePostsOnePass(run!.id, ideas.length || 1, ideas.length ? ideas : undefined);
    // якщо матеріал зметчений зі слотом - привʼяжемо перший пост до слота
    const slot = await one<{ id: string; rubric: string | null; channel: string }>(
      `select id, rubric, channel from plan_slot where workspace_id=$1 and match_source_id=$2 and status='matched' limit 1`, [ws, m.id]);
    if (slot) {
      const post = await one<{ id: string }>(`select id from post where run_id=$1 and stage='final' order by created_at limit 1`, [run!.id]);
      if (post) {
        await q(`update post set rubric=coalesce($2, rubric), channels=coalesce(channels,'{}'::jsonb) || $3::jsonb where id=$1`,
          [post.id, slot.rubric, JSON.stringify({ [slot.channel]: { on: true } })]);
        await q(`update plan_slot set status='drafted', post_id=$2 where id=$1`, [slot.id, post.id]);
      }
    }
    return { ok: true, count };
  } catch (e: any) { await logEvent("error", "material_posts", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// ===================== V2: АТОМІЗАЦІЯ (Prompt 10) =====================
app.post("/api/posts/:postId/atomize", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  try {
    const p = await one<{ content: string }>(`select content from post where id=$1`, [req.params.postId]);
    if (!p) return reply.code(404).send({ error: "пост не знайдено" });
    const channels = Array.isArray(req.body?.channels) ? req.body.channels : [];
    const res = await atomizePost(ws, p.content, channels);
    return { ok: true, ...res };
  } catch (e: any) { await logEvent("error", "atomize", e.message, null, req.user.id); return reply.code(400).send({ error: e.message }); }
});

// ===================== РУБРИКИ (контент-мікс) =====================
async function saveRubrics(ws: string, items: any[]): Promise<number> {
  await q(`delete from rubric where workspace_id=$1`, [ws]);
  let count = 0;
  for (let i = 0; i < (items || []).length; i++) {
    const r = items[i]; const name = String(r?.name ?? "").trim();
    if (!name) continue;
    await q(`insert into rubric(workspace_id,name,emoji,description,share,idx) values($1,$2,$3,$4,$5,$6)`,
      [ws, name.slice(0, 60), r.emoji ? String(r.emoji).slice(0, 8) : null,
       r.description ? String(r.description).slice(0, 300) : null,
       Math.max(0, Math.min(100, Number(r.share) || 0)), i]);
    count++;
  }
  return count;
}
app.get("/api/rubrics", async (req: any) =>
  q(`select id,name,emoji,description,share,idx from rubric where workspace_id=$1 order by idx, name`, [req.user.workspace_id]));
app.put("/api/rubrics", async (req: any) =>
  ({ ok: true, count: await saveRubrics(req.user.workspace_id, Array.isArray(req.body?.rubrics) ? req.body.rubrics : []) }));

// ===================== БАНК + ПЛАНУВАННЯ (по постах, рівень workspace) =====================
// задачі/онбординг-чеклист + бал заповнення (гейміфікація)
app.get("/api/tasks", async (req: any) => {
  const ws = req.user.workspace_id;
  const rows = await q<{ key: string; content: string }>(`select key,content from settings_block where workspace_id=$1`, [ws]);
  const S: Record<string, string> = {}; for (const r of rows) S[r.key] = (r.content || "").trim();
  const [tg, th, mt, gd, trc, src, med, posts, appr, sched, pub, strat] = await Promise.all([
    one<any>(`select bot_token,channel_chat_id,group_chat_id from telegram_config where workspace_id=$1`, [ws]),
    one<any>(`select access_token from threads_config where workspace_id=$1`, [ws]),
    one<any>(`select page_token from meta_config where workspace_id=$1`, [ws]),
    one<any>(`select refresh_token from gdrive_config where workspace_id=$1`, [ws]),
    one<any>(`select api_key from transcription_config where workspace_id=$1`, [ws]),
    one<{ n: number }>(`select count(*)::int n from source where workspace_id=$1`, [ws]),
    one<{ n: number }>(`select count(*)::int n from media_asset where workspace_id=$1`, [ws]),
    one<{ n: number }>(`select count(*)::int n from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and p.stage='final'`, [ws]),
    one<{ n: number }>(`select count(*)::int n from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and p.review='approved'`, [ws]),
    one<{ n: number }>(`select count(*)::int n from schedule_slot ss left join plan_item pi on pi.id=ss.plan_item_id join post p on p.id=coalesce(ss.post_id,pi.post_id) join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1`, [ws]),
    one<{ n: number }>(`select (select count(*) from telegram_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.status='sent')
      + (select count(*) from meta_publish mp join post p on p.id=mp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and mp.status='sent')
      + (select count(*) from threads_publish thp join post p on p.id=thp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and thp.status='sent') as n`, [ws]),
    one<{ data: any }>(`select data from strategy where workspace_id=$1`, [ws]),
  ]);
  const tgOn = !!(tg && tg.bot_token && (tg.channel_chat_id || tg.group_chat_id));
  const igfbOn = !!(mt && mt.page_token);
  const thOn = !!(th && th.access_token);
  const tasks = [
    { id: "brand", section: "brand", points: 15, label: "Заповнити Базу бренду (ніша й аудиторія)", done: !!S.marketing_context },
    { id: "voice", section: "brand", points: 10, label: "Налаштувати голос бренду", done: !!S.tone_of_voice },
    { id: "chan1", section: "settings", points: 15, label: "Підключити хоча б один канал", done: tgOn || igfbOn || thOn },
    { id: "chanAll", section: "settings", points: 10, label: "Підключити всі канали (Telegram, IG/FB, Threads)", done: tgOn && igfbOn && thOn },
    { id: "transcriber", section: "settings", points: 5, label: "Підключити транскрибатор (Fireflies)", done: !!(trc && trc.api_key) },
    { id: "gdrive", section: "sources", points: 5, label: "Підключити Google Drive", done: !!(gd && gd.refresh_token) },
    { id: "source", section: "sources", points: 5, label: "Додати джерело контенту", done: (src?.n || 0) > 0 },
    { id: "media", section: "sources", points: 5, label: "Завантажити або згенерувати фото", done: (med?.n || 0) > 0 },
    { id: "strategy", section: "strategy", points: 5, label: "Згенерувати стратегію", done: !!(strat && strat.data && Object.keys(strat.data).length) },
    { id: "gen10", section: "create", points: 10, label: "Згенерувати перші 10 постів", done: (posts?.n || 0) >= 10 },
    { id: "approve", section: "create", points: 5, label: "Затвердити пости", done: (appr?.n || 0) > 0 },
    { id: "schedule", section: "publish", points: 5, label: "Запланувати пост у календарі", done: (sched?.n || 0) > 0 },
    { id: "publish", section: "publish", points: 10, label: "Зробити першу публікацію", done: Number(pub?.n || 0) > 0 },
    { id: "plans", section: "settings", points: 5, label: "Ознайомитися з тарифами", done: S.seen_plans === "1" },
  ];
  const total = tasks.reduce((a, t) => a + t.points, 0);
  const got = tasks.filter((t) => t.done).reduce((a, t) => a + t.points, 0);
  return { score: Math.round((got / total) * 100), points: got, total, tasks };
});

// позначити задачу-прапорець виконаною (напр. «Ознайомитися з тарифами»)
app.post("/api/tasks/ack", async (req: any, reply) => {
  const key = String(req.body?.key ?? "");
  if (!["seen_plans"].includes(key)) return reply.code(400).send({ error: "невідома задача" });
  await q(`insert into settings_block(workspace_id,key,content) values($1,$2,'1') on conflict (workspace_id,key) do update set content='1', updated_at=now()`, [req.user.workspace_id, key]);
  return { ok: true };
});

app.get("/api/bank", async (req: any) => {
  return q(`select p.id, p.content, p.review, p.created_at, src.title as source_title
            from post p join pipeline_run r on r.id=p.run_id join source src on src.id=r.source_id
            where src.workspace_id=$1 and p.stage='final' and p.review='approved'
            order by p.created_at desc`, [req.user.workspace_id]);
});

// усі фінальні пости воркспейсу (Студія/Інбокс - глобальний список, НЕ привʼязаний до активного джерела)
app.get("/api/posts/studio", async (req: any) => {
  return q(`select p.id, p.content, p.review, p.channels, p.rubric, src.origin as source_origin, ma.filename as media_filename, p.created_at, src.title as source_title
            from post p join pipeline_run r on r.id=p.run_id join source src on src.id=r.source_id
            left join media_asset ma on ma.id=p.media_id
            where src.workspace_id=$1 and p.stage='final' and (p.review is null or p.review <> 'archived')
            order by p.created_at desc`, [req.user.workspace_id]);
});

app.get("/api/schedule", async (req: any) => {
  return q(`select ss.id, ss.scheduled_at, ss.status, ss.result, p.id as post_id, p.content, p.channels
            from schedule_slot ss
              left join plan_item pi on pi.id=ss.plan_item_id
              join post p on p.id = coalesce(ss.post_id, pi.post_id)
              join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where s.workspace_id=$1 order by ss.scheduled_at`, [req.user.workspace_id]);
});

// реально опубліковані пости (ручні + планові) з усіх мереж - для Аналітики
app.get("/api/published", async (req: any) => {
  const ws = req.user.workspace_id;
  const recent = await q<{ post_id: string; net: string; created_at: string; content: string }>(
    `select x.post_id, x.net, x.created_at, p.content from (
        select post_id, 'telegram'::text as net, created_at from telegram_publish where status='sent'
        union all select post_id, 'threads', created_at from threads_publish where status='sent'
        union all select post_id, channel, created_at from meta_publish where status='sent'
     ) x
     join post p on p.id=x.post_id
     join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1
     order by x.created_at desc limit 100`, [ws]);
  const posts = new Set(recent.map((r) => r.post_id)).size;
  return { posts, sends: recent.length, recent };
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
  // якщо мережі не обрані (drag&drop) - типово Telegram, але ЯВНО (видно в календарі), не тихо
  const cur = await one<{ channels: any }>(`select channels from post where id=$1`, [postId]);
  const cch = cur?.channels || {};
  if (!Object.keys(cch).some((k) => cch[k] && cch[k].on))
    await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify({ telegram: { on: true } })]);
  // якщо у поста ВЖЕ є незапощений слот - переносимо його, а не додаємо другий (інакше подвійна публікація)
  const existing = await one<{ id: string }>(`select id from schedule_slot where post_id=$1 and status='planned' limit 1`, [postId]);
  if (existing) {
    await q(`update schedule_slot set scheduled_at=$2 where id=$1`, [existing.id, req.body?.scheduledAt ?? null]);
    await q(`update plan_slot set status='scheduled' where post_id=$1 and status in ('drafted','approved')`, [postId]);
    return { ok: true, id: existing.id, moved: true };
  }
  const r = await one<{ id: string }>(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned') returning id`,
    [postId, req.body?.scheduledAt ?? null]);
  await q(`update plan_slot set status='scheduled' where post_id=$1 and status in ('drafted','approved')`, [postId]);
  return { ok: true, id: r!.id };
});

app.put("/api/schedule/:id", async (req: any, reply) => {
  if (!(await slotOwned(req.params.id, req.user.workspace_id))) return reply.code(404).send({ error: "слот не знайдено" });
  // переносити можна лише те, що ще не пішло: posted/posting не «воскрешаємо» - це друга публікація
  const r = await one<{ id: string }>(
    `update schedule_slot set scheduled_at=$2, status='planned' where id=$1 and status in ('planned','failed') returning id`,
    [req.params.id, req.body?.scheduledAt ?? null]);
  if (!r) return reply.code(409).send({ error: "Слот уже опубліковано - перенести не можна. Заплануй пост заново зі Студії." });
  return { ok: true };
});

app.delete("/api/schedule/:id", async (req: any, reply) => {
  if (!(await slotOwned(req.params.id, req.user.workspace_id))) return reply.code(404).send({ error: "слот не знайдено" });
  await q(`delete from schedule_slot where id=$1`, [req.params.id]);
  return { ok: true };
});

// авто-розподіл затверджених постів за розкладом зі Стратегії (дні + час).
// Чистить незапощені planned-слоти й розкладає заново - передбачуваний календар без дублів.
// конвертація «стінного» часу в поясі tz -> UTC (для автопланування за поясом воркспейсу)
function tzOffsetMs(date: Date, tz: string): number {
  const p: any = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(date).reduce((a: any, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}
function zonedToUTC(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}

app.post("/api/schedule/auto", async (req: any) => {
  const ws = req.user.workspace_id;
  // 1) прибрати всі незапощені (planned) слоти воркспейсу - і старі plan-based, і post-based
  await q(
    `delete from schedule_slot where status='planned' and id in (
       select ss.id from schedule_slot ss
         left join plan_item pi on pi.id=ss.plan_item_id
         join post p on p.id=coalesce(ss.post_id, pi.post_id)
         join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       where s.workspace_id=$1)`, [ws]);
  // 2) затверджені фінальні пости, які ще не запощені й не в процесі
  const units = await q<{ id: string }>(
    `select p.id from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and p.stage='final' and p.review='approved'
       and not exists(select 1 from schedule_slot ss where ss.post_id=p.id and ss.status in ('posting','posted'))
     order by p.created_at`, [ws]);
  // типово Telegram для постів без обраних мереж (явно - щоб autopost мав куди публікувати, не тихо)
  if (units.length) await q(`update post set channels=$2 where id = any($1) and (channels is null or channels = '{}'::jsonb)`,
    [units.map((u) => u.id), JSON.stringify({ telegram: { on: true } })]);
  // 3) розклад зі Стратегії: дні (best_days) + час (times). Фолбек: щодня, 11:00.
  const strat = await one<{ data: any }>(`select data from strategy where workspace_id=$1`, [ws]);
  const DMAP: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const bestDays: number[] = Array.isArray(strat?.data?.best_days)
    ? strat!.data.best_days.map((d: string) => DMAP[String(d).toLowerCase().slice(0, 3)]).filter((x: any) => x != null) : [];
  let times: string[] = Array.isArray(strat?.data?.times)
    ? strat!.data.times.map((t: any) => String(t)).filter((t: string) => /^\d{1,2}:\d{2}$/.test(t)) : [];
  if (!times.length) times = ["11:00"];
  // часовий пояс воркспейсу - щоб час публікацій був «стінним» у поясі користувача
  const tzRow = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [ws]);
  const tz = tzRow?.content || "Europe/Kyiv";
  // 3.5) пости, привʼязані до слотів ПЛАНУ, стають САМЕ на дату свого слота (перший час зі стратегії)
  let count = 0;
  let rest = units;
  if (units.length) {
    const withSlot = await q<{ post_id: string; slot_date: string }>(
      `select post_id, slot_date::text as slot_date from plan_slot
       where workspace_id=$1 and post_id = any($2) and status in ('drafted','approved','scheduled')`,
      [ws, units.map((u) => u.id)]);
    const slotByPost = new Map(withSlot.map((r) => [r.post_id, r.slot_date]));
    const [h0, m0] = times[0].split(":").map(Number);
    for (const u of units.filter((x) => slotByPost.has(x.id))) {
      const [Y, Mo, D] = String(slotByPost.get(u.id)).slice(0, 10).split("-").map(Number);
      const dd = zonedToUTC(Y, Mo, D, h0, m0, tz);
      const when = dd.getTime() > Date.now() ? dd : new Date(Date.now() + 10 * 60 * 1000); // дата слота в минулому -> через 10 хв
      await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [u.id, when.toISOString()]);
      await q(`update plan_slot set status='scheduled' where post_id=$1 and status in ('drafted','approved')`, [u.id]);
      count++;
    }
    rest = units.filter((x) => !slotByPost.has(x.id));
  }
  // 4) times.length постів/день у дозволені дні (за поясом); надлишок - на наступні тижні
  const tzToday = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-").map(Number);
  const cursor = new Date(Date.UTC(tzToday[0], tzToday[1] - 1, tzToday[2], 12, 0, 0)); // календарний курсор (полудень UTC, без DST-стрибків)
  let off = 1, i = 0;
  while (i < rest.length && off <= 120) {
    const c = new Date(cursor); c.setUTCDate(c.getUTCDate() + off);
    const Y = c.getUTCFullYear(), Mo = c.getUTCMonth() + 1, D = c.getUTCDate();
    if (bestDays.length && !bestDays.includes(c.getUTCDay())) { off++; continue; }
    for (let k = 0; k < times.length && i < rest.length; k++, i++) {
      const [h, m] = times[k].split(":").map(Number);
      const dd = zonedToUTC(Y, Mo, D, h, m, tz);
      await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [rest[i].id, dd.toISOString()]);
      count++;
    }
    off++;
  }
  return { ok: true, count };
});

// ===================== ТРАНСКРИБАЦІЯ (Fireflies) =====================
async function transConfig(ws: string) {
  return one<{ provider: string; api_key: string | null; webhook_token: string | null; webhook_secret: string | null; auto_run: boolean | null }>(
    `select provider, api_key, webhook_token, webhook_secret, auto_run from transcription_config where workspace_id=$1`, [ws]);
}
app.get("/api/integrations/transcription", async (req: any) => {
  const ws = req.user.workspace_id;
  let c = await transConfig(ws);
  if (c && !c.webhook_token) { // згенерувати токен для рядків, створених до фічі вебхуків
    await q(`update transcription_config set webhook_token=$2 where workspace_id=$1`, [ws, auth.newToken()]);
    c = await transConfig(ws);
  }
  return {
    provider: c?.provider || "fireflies",
    hasKey: !!(c && c.api_key),
    webhookUrl: c?.webhook_token ? `${env.appBaseUrl}/api/webhooks/fireflies/${c.webhook_token}` : "",
    hasSecret: !!(c && c.webhook_secret),
    autoRun: !!(c && c.auto_run),
  };
});
app.put("/api/integrations/transcription", async (req: any) => {
  const ws = req.user.workspace_id;
  // «Без підпису»: прибрати секрет → вебхук приймається лише за токеном в URL (надійніше, ніж матчити секрет із Fireflies)
  if (req.body?.clearSecret === true) { await q(`update transcription_config set webhook_secret=null, updated_at=now() where workspace_id=$1`, [ws]); return { ok: true }; }
  const key = String(req.body?.apiKey ?? "").trim();
  const secret = String(req.body?.webhookSecret ?? "").trim();
  const autoRun = req.body?.autoRun === true || req.body?.autoRun === "true";
  const provider = ["fireflies", "grain", "meetgeek"].includes(String(req.body?.provider)) ? String(req.body.provider) : "fireflies";
  await q(`insert into transcription_config(workspace_id, provider, api_key, webhook_secret, auto_run, webhook_token, updated_at)
           values($1,$6, nullif($2,''), nullif($3,''), $4, $5, now())
           on conflict (workspace_id) do update set
             provider = $6,
             api_key = case when $2 <> '' then $2 else transcription_config.api_key end,
             webhook_secret = case when $3 <> '' then $3 else transcription_config.webhook_secret end,
             auto_run = $4,
             webhook_token = coalesce(transcription_config.webhook_token, $5),
             updated_at=now()`,
    [ws, key, secret, autoRun, auth.newToken(), provider]);
  return { ok: true };
});
app.get("/api/transcription/list", async (req: any, reply) => {
  const c = await transConfig(req.user.workspace_id);
  if (!c?.api_key) return reply.code(400).send({ error: "Спершу додайте API-ключ транскрибатора у Налаштуваннях" });
  try { return await transMod(c.provider).listTranscripts(c.api_key); }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});
app.post("/api/transcription/import", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const c = await transConfig(ws);
  if (!c?.api_key) return reply.code(400).send({ error: "Спершу додайте API-ключ транскрибатора" });
  let t: { title: string; text: string };
  try { t = await transMod(c.provider).getTranscript(c.api_key, String(req.body?.id ?? "")); }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
  if (!t.text) return reply.code(400).send({ error: "Порожній транскрипт" });
  const src = await one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,$4,$2,$3) returning id`, [ws, t.title, t.text, c.provider || "fireflies"]);
  const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
  await logEvent("info", "transcription", `імпорт Fireflies: ${t.title}`, null, req.user.id);
  return { sourceId: src!.id, runId: run!.id, title: t.title };
});

// вебхук Fireflies: «зустріч готова» -> автоімпорт джерела (+ опційно автопілот).
// Поза auth: маршрутизація через per-workspace токен у URL, автентичність - HMAC-підпис.
// вебхук спільного Telegram-бота (auth-exempt; секрет у шляху + у заголовку)
app.post("/api/webhooks/telegram/:secret", async (req: any, reply) => {
  if (req.params.secret !== env.telegram.webhookSecret) return reply.code(404).send({ error: "not found" });
  const hdr = req.headers["x-telegram-bot-api-secret-token"];
  if (hdr && hdr !== env.telegram.webhookSecret) return reply.code(403).send({ error: "bad secret" });
  handleUpdate(req.body).catch(() => {});
  return { ok: true };
});

app.post("/api/webhooks/fireflies/:token", async (req: any, reply) => {
  const cfg = await one<{ workspace_id: string; api_key: string | null; webhook_secret: string | null; auto_run: boolean | null }>(
    `select workspace_id, api_key, webhook_secret, auto_run from transcription_config where webhook_token=$1`, [req.params.token]);
  if (!cfg) return reply.code(404).send({ error: "unknown webhook" });
  if (cfg.webhook_secret) {
    const raw = req.rawBody || "";
    const expected = createHmac("sha256", cfg.webhook_secret).update(raw).digest("hex");
    const got = String(req.headers["x-hub-signature"] || "").replace(/^sha256=/, "");
    const gb = Buffer.from(got), eb = Buffer.from(expected);
    const okSig = gb.length === eb.length && timingSafeEqual(gb, eb);
    if (!okSig) {
      await logEvent("warn", "transcription", `вебхук: невірний підпис (rawLen=${raw.length}, hdr=${req.headers["x-hub-signature"] ? "є" : "нема"}, got=${got.slice(0, 10)}, exp=${expected.slice(0, 10)})`, null);
      return reply.code(401).send({ error: "bad signature" });
    }
  }
  const body = req.body || {};
  if (body.eventType && body.eventType !== "Transcription completed") return { ok: true, ignored: true };
  const meetingId = String(body.meetingId || body.meeting_id || body.id || (body.data && (body.data.meetingId || body.data.id)) || "");
  if (!meetingId) { await logEvent("warn", "transcription", "вебхук без meetingId (тест-пінг?) payload=" + JSON.stringify(body).slice(0, 250), null); return { ok: true, note: "no meetingId" }; }
  if (!cfg.api_key) return reply.code(400).send({ error: "no api key" });
  const dup = await one(`select id from source where workspace_id=$1 and external_id=$2`, [cfg.workspace_id, meetingId]);
  if (dup) return { ok: true, duplicate: true };
  try {
    const t = await fireflies.getTranscript(cfg.api_key, meetingId);
    if (!t.text) return { ok: true, empty: true };
    const src = await one<{ id: string }>(`insert into source(workspace_id,origin,title,transcript,external_id) values($1,'fireflies',$2,$3,$4) returning id`,
      [cfg.workspace_id, t.title, t.text, meetingId]);
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
    await logEvent("info", "transcription", `вебхук-імпорт: ${t.title}`, { runId: run!.id });
    if (cfg.auto_run) {
      // автопілот довгий (~2-3 хв) - у фоні, щоб вебхук одразу повернув 200 і Fireflies не ретраїв
      (async () => {
        try { for (const s of STEP_ORDER) await executeStep(run!.id, s as StepKey); await logEvent("info", "autopilot", "вебхук-автопілот: готово", { runId: run!.id }); }
        catch (e: any) { await logEvent("error", "autopilot", `вебхук-автопілот: ${e.message}`, { runId: run!.id }); }
      })();
    }
    return { ok: true, runId: run!.id, autopilot: !!cfg.auto_run };
  } catch (e: any) {
    await logEvent("error", "transcription", `вебхук getTranscript: ${e.message}`, null);
    return reply.code(500).send({ error: e.message });
  }
});

// ===================== СТОРІНКИ =====================
app.get("/app", (_req, reply) => reply.sendFile("app.html"));
app.get("/B", (_req, reply) => reply.sendFile("b.html"));
app.get("/b", (_req, reply) => reply.sendFile("b.html"));
app.get("/login", (_req, reply) => reply.sendFile("auth.html"));
app.get("/register", (_req, reply) => reply.sendFile("auth.html"));
app.get("/forgot", (_req, reply) => reply.sendFile("auth.html"));
app.get("/reset", (_req, reply) => reply.sendFile("auth.html"));
app.get("/privacy", (_req, reply) => reply.sendFile("privacy.html"));
app.get("/terms", (_req, reply) => reply.sendFile("terms.html"));
app.get("/data-deletion", (_req, reply) => reply.sendFile("data-deletion.html"));

app.listen({ port: env.port, host: "0.0.0.0" }).then((addr) => {
  app.log.info(`socialio на ${addr}`);
  startAutopost();
  startRssPoller();
  startGdrivePoller();
  startLifecycleWorker();
  initTelegramBot();
  // одноразово полагодити залишкові iPhone HEIF -> JPEG (у фоні; ідемпотентно)
  convertAllHeif().then((n) => { if (n) app.log.info(`HEIF→JPEG конвертовано: ${n}`); }).catch((e: any) => app.log.error("convertAllHeif: " + e.message));
});
