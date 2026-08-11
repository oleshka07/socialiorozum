import Fastify from "fastify";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { env } from "./env.js";
import { q, one } from "./db.js";
import { executeStep, STEP_ORDER, StepKey, DEFAULT_PROMPTS, deriveVoice, deriveBrandFromText, generateStrategy, adaptForChannels, generatePostsOnePass, buildLitePrompt, rewritePost, generateChannelPlan, atomizePost, extractIdeasFromText, ideaMode, matchPlanSlots, buildLiteSkeleton, suggestHashtags, directorVerdict, aiAudit, deAiFix, storytellingVerdict, normFormat, FORMATS, suggestHooks, suggestHeadline, reelsScript, sliceToReels, publishQuestions, suggestDevelopment, suggestLeadMagnets, buildLeadMagnet, topPatterns, generateThreadsTakes, repeatVariant, expandTake, threadsStarterPack, threadsNicheReview, suggestThreadReplies, DEFAULT_MAIN_MODEL } from "./pipeline.js";
import { startReelJob, reelJobs, parseReelScript } from "./reelvideo.js";
import * as tg from "./telegram.js";
import * as threads from "./threads.js";
import { tgLink, fbLink, liLink } from "./permalink.js";
import { verifyInitData } from "./tgauth.js";
import { createBotDraft, publishNow, connectedNets } from "./tgcompose.js";
import * as linkedin from "./linkedin.js";
import * as youtube from "./youtube.js";
import * as tiktok from "./tiktok.js";
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
import { resolveSource } from "./rss-resolver.js";
import { MEDIA_DIR, saveMedia, deleteMediaFile, convertAllHeif, getThumb } from "./media.js";
import { startGdrivePoller, pullGdriveFolder } from "./gdrive-poller.js";
import * as gdrive from "./gdrive.js";
import { publishPostToChannels, alreadySentNetworks, startReelPublishJob, reelPubJobs, reelSentNetworks } from "./publisher.js";
import { startLifecycleWorker } from "./lifecycle.js";
import { startDigest } from "./digest.js";
import { startMetrics, networkBenchmarks } from "./metrics.js";
import { startDiary } from "./diary.js";
import { startThreadsAuto } from "./threads-auto.js";
import { getSettingText } from "./settings.js";
import { runAbTest, modelCatalog, abSpend } from "./abtest.js";
import { contextReview, contextIssueCount, suggestFieldFix } from "./context-check.js";
import { generateImageForPost, imageProviders, overlayForPost, attachCroppedImage, stockPhotoOptions, attachStockPhoto } from "./images.js";
import { initTelegramBot, createConnectLink, handleUpdate, botEnabled, botUsername, registerOwnBotWebhook } from "./tgbot.js";
import { chat } from "./openrouter.js";

// ============================================================================
// ЗМІСТ ФАЙЛУ (182 роути; шукай за банером «===== НАЗВА =====» або шляхом роуту)
//   гейти/хуки:  BETA_PIN, onSend, preHandler auth (≈ рядок 60-140)
//   AUTH+ACCOUNT: /api/auth/*, /api/account/* (register/login/lifecycle)
//   SETTINGS/PROMPTS: /api/settings, /api/prompts
//   SOURCES/MEDIA: /api/sources/*, /api/media/* (+bulk-delete)
//   POSTS: CRUD, review, regenerate, adapt, hooks, ai-audit, image*, repeat, expand-thread
//   THREADS: takes, starter-pack, niche-review, comments (реплай-коуч)
//   ANALYTICS: benchmarks, top-patterns, threads
//   RUNS/PIPELINE: /api/runs/* (PRO-кишка)
//   INTEGRATIONS: telegram → meta → threads → linkedin → youtube → tiktok → gdrive (OAuth-мости)
//   PLAN/MATERIALS/IDEAS: /api/plan/*, /api/materials/*, /api/ideas/*
//   SCHEDULE/PUBLISH: /api/schedule/*, /api/posts/:id/publish-all, /api/published
//   WEBHOOKS/PAGES: /api/webhooks/*, статичні сторінки, listen + старт воркерів
// TODO(рефакторинг, окрема сесія): фізичний розріз на src/routes/* по одному
// модулю за раз із деплоєм після кожного (інтеграції перемішані з post-роутами -
// різати треба уважно, не механічно).
// ============================================================================
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true, trustProxy: true });
await app.register(cors, { origin: env.appBaseUrl, credentials: true });
await app.register(cookie, { secret: env.sessionSecret });
await app.register(fstatic, { root: join(__dirname, "..", "public"), prefix: "/" });

// медіа-сховище: файли на диску (Docker-volume), віддаємо публічно за /media/<uuid>.<ext>
await app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024, files: 10 } }); // 60МБ: b-roll відео для рілсів (фото й так менші)
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

// ---- БЕТА: PIN-гейт (env BETA_PIN; на проді не заданий - блок неактивний). ----
// Відкриті без PIN: /health, вебхуки (Telegram/Fireflies шлють POST без кукі) і /media/
// (Telegram/Meta ТЯГНУТЬ картинку по URL при публікації - PIN зламав би фото-пости).
if (env.beta.pin) {
  const PIN_COOKIE = "beta_ok";
  const pinToken = createHash("sha256").update(env.beta.pin + env.sessionSecret).digest("hex").slice(0, 32);
  const pinPage = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>socialio BETA</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101014;color:#eee;font-family:system-ui,sans-serif}.c{text-align:center;padding:24px}.b{display:inline-block;background:#e67e22;color:#fff;font-weight:800;font-size:12px;padding:3px 12px;border-radius:20px;letter-spacing:.08em;margin-bottom:14px}input{font-size:22px;letter-spacing:.4em;text-align:center;width:170px;padding:10px;border-radius:12px;border:1px solid #333;background:#1a1a20;color:#fff;outline:none}button{display:block;margin:14px auto 0;padding:10px 26px;border-radius:12px;border:0;background:#7c5cff;color:#fff;font-weight:700;font-size:14px;cursor:pointer}#e{color:#ff6b6b;font-size:13px;min-height:18px;margin-top:10px}</style></head>
<body><div class="c"><div class="b">BETA</div><h3 style="margin:0 0 16px;font-weight:600">Тестове середовище socialio</h3>
<input id="p" type="password" inputmode="numeric" maxlength="8" placeholder="PIN" autofocus>
<button onclick="go()">Увійти</button><div id="e"></div></div>
<script>function go(){fetch('/beta-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:document.getElementById('p').value})}).then(r=>{if(r.ok)location.href='/app';else document.getElementById('e').textContent='Невірний PIN';});}
document.getElementById('p').addEventListener('keydown',e=>{if(e.key==='Enter')go();});</script></body></html>`;
  app.addHook("onRequest", async (req: any, reply) => {
    const url = (req.raw.url || "").split("?")[0];
    if (url === "/health" || url === "/beta-pin" || url === "/favicon.svg" || url.startsWith("/api/webhooks/") || url.startsWith("/media/")) return;
    // Mini App живе всередині Telegram - PIN там ввести ніде, а захист у нього свій (підпис initData)
    if (url === "/tgapp" || url.startsWith("/api/tg/")) return;
    if (req.cookies?.[PIN_COOKIE] === pinToken) return;
    if (url.startsWith("/api/")) return reply.code(401).send({ error: "beta: потрібен PIN" });
    return reply.type("text/html").send(pinPage);
  });
  app.post("/beta-pin", async (req: any, reply) => {
    if (rateLimited("betapin:" + req.ip, 10)) return reply.code(429).send({ error: "Забагато спроб - зачекай хвилину" });
    if (String((req.body as any)?.pin ?? "").trim() !== env.beta.pin) return reply.code(401).send({ error: "невірний PIN" });
    reply.setCookie(PIN_COOKIE, pinToken, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
    return { ok: true };
  });
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
  if (url.startsWith("/api/tg/")) return;   // Mini App: перевірка не кукою, а підписом initData (tgauth.ts)
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

// ✨ чорновий список болів клієнта з брифу/ніші (юзер редагує; НЕ зберігає сам - лише пропозиція)
// ⏳ ФОНОВІ AI-ДЖОБИ (спільний механізм). nginx рве проксі на 60 секундах, а один виклик головної
// моделі на промті в 25 тис. символів у це вікно не вкладається - людина отримувала 504 на роботі,
// яка НАСПРАВДІ виконувалась далі. Ту саму дірку ми вже закрили для публікації; тут вона
// повторилась на перевірці контексту, тож механізм зроблено спільним, а не ще однією латкою.
type AiJob = { ws: string; status: "running" | "done" | "error"; result?: any; error?: string; at: number };
const aiJobs = new Map<string, AiJob>();
const AIJOB_TTL = 15 * 60 * 1000;

function startAiJob(ws: string, work: () => Promise<any>): string {
  for (const [k, v] of aiJobs) if (v.status !== "running" && Date.now() - v.at > AIJOB_TTL) aiJobs.delete(k);
  const id = randomUUID();
  aiJobs.set(id, { ws, status: "running", at: Date.now() });
  work()
    .then((result) => aiJobs.set(id, { ws, status: "done", result, at: Date.now() }))
    .catch(async (e: any) => {
      aiJobs.set(id, { ws, status: "error", error: String(e?.message || e).slice(0, 300), at: Date.now() });
      await logEvent("warn", "aijob", e?.message || String(e), { ws });
    });
  return id;
}

app.get("/api/jobs/:id", async (req: any, reply) => {
  const j = aiJobs.get(req.params.id);
  if (!j) return { status: "idle" };                                   // процес перезапустився - клієнт не висне
  if (j.ws !== req.user.workspace_id) return reply.code(404).send({ error: "не знайдено" });
  return { status: j.status, result: j.result, error: j.error };
});

// 🩺 Перевірка контексту: що людина поклала в промт і чи не суперечить воно саме собі.
// Запобіжника від «сміття на вході» не було зовсім - порожнє чи самосуперечливе поле мовчки їхало
// в модель, і зрозуміти, чому пости слабкі, було неможливо навіть розробнику.
app.post("/api/brand/context-check", async (req: any) => {
  const ws = req.user.workspace_id;
  const deep = req.body?.deep !== false;
  // швидкий (детермінований) шар віддаємо ОДРАЗУ - він без моделі й займає мілісекунди;
  // джоба потрібна лише глибокому розбору
  if (!deep) return await contextReview(ws, false);
  return { jobId: startAiJob(ws, () => contextReview(ws, true)) };
});

// Варіант виправлення ОДНОГО поля. Свідомо не «полагодь усе»: людина мусить бачити «було → стало»
// і зберегти сама - інакше сервіс тихо перепише бренд за неї.
app.post("/api/brand/context-fix", async (req: any) => {
  const ws = req.user.workspace_id;
  const key = String(req.body?.key || ""), problem = String(req.body?.problem || "");
  return { jobId: startAiJob(ws, async () => ({ suggestion: await suggestFieldFix(ws, key, problem) })) };
});

app.post("/api/brand/suggest-pains", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  try {
    const rows = await q<{ key: string; content: string }>(`select key, content from settings_block where workspace_id=$1 and key in ('marketing_context','strategy_brief','brand_thesis')`, [ws]);
    const s: Record<string, string> = {}; for (const r of rows) s[r.key] = r.content || "";
    const ctx = (s.strategy_brief || s.marketing_context || "").trim();
    if (!ctx) return reply.code(400).send({ error: "Спершу заповни Базу бренду (ніша й аудиторія)" });
    const raw = await chat(env.cheapModel,
      "Ти маркетолог-практик. Склади список з 8-10 РЕАЛЬНИХ болів ідеального клієнта цього бренду. Кожен рядок СТРОГО у форматі: «біль дослівно словами клієнта» → що бренд робить із цим → доказ/цифра (якщо з контексту невідомо - постав [доказ?]). Болі - конкретні й побутові, не абстракції. Мова - мова бренду. Поверни ЛИШЕ рядки списку, без вступу і нумерації.",
      `Бренд: ${ctx.slice(0, 2500)}${s.brand_thesis ? `\nТеза: ${s.brand_thesis}` : ""}`,
      { workspaceId: ws, step: "pains" });
    return { pains: raw.trim().slice(0, 3000) };
  } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// «Написати про конкретну тему»: користувач задає НАПРЯМ, сервіс одразу генерує пости саме про це
// (закриває фідбек «не вистачає задати про що писати»). channels? - націлити пости на обрані мережі.
app.post("/api/generate/topic", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const topic = String(req.body?.topic || "").trim();
  if (!topic) return reply.code(400).send({ error: "Напиши, про що зробити пост" });
  const count = Math.max(1, Math.min(10, Number(req.body?.count) || 3));
  const nets: string[] = Array.isArray(req.body?.channels) ? req.body.channels.map((x: any) => String(x)).filter((x: string) => PLAN_NETS.includes(x)) : [];
  try {
    const src = await one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,'topic',$2,$3) returning id`,
      [ws, topic.slice(0, 200), `Напрям для постів (пиши САМЕ про це, у голосі бренду): ${topic}`]);
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
    // кожен пост - інший кут тієї самої теми
    const ideas = Array.from({ length: count }, (_, i) => count > 1 ? `${topic} (кут ${i + 1}: свіжий ракурс, не повторюй попередні)` : topic);
    await generatePostsOnePass(run!.id, count, ideas);
    if (nets.length) {
      const patch = JSON.stringify(Object.fromEntries(nets.map((n) => [n, { on: true }])));
      await q(`update post set channels=coalesce(channels,'{}'::jsonb) || $2::jsonb where run_id=$1 and stage='final'`, [run!.id, patch]);
    }
    return { ok: true, runId: run!.id, count };
  } catch (e: any) { await logEvent("error", "gen_topic", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// ----- контент-джерела (RSS) -----
app.get("/api/sources/rss", async (req: any) =>
  q(`select id, url, title, kind, active, auto_run, last_pulled_at, last_error from content_source
     where workspace_id=$1 and kind in ('rss','instagram') order by created_at desc`, [req.user.workspace_id]));

// крок 1 флоу «Додати джерело»: резолв вводу (тема / посилання) у feed URL + прев'ю останніх постів.
// НІЧОГО не зберігає - юзер спочатку бачить «Знайдено: … ось останні пости» і підтверджує.
app.post("/api/sources/rss/resolve", async (req: any, reply) => {
  const t = String(req.body?.type ?? "rss");
  const type = (["news", "telegram", "threads", "instagram"].includes(t) ? t : "rss") as any;
  try { return { ok: true, ...(await resolveSource(type, String(req.body?.input ?? ""), req.body?.lang, req.user.workspace_id)) }; }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

app.post("/api/sources/rss", async (req: any, reply) => {
  const url = String(req.body?.url ?? "").trim();
  const kind = req.body?.kind === "instagram" ? "instagram" : "rss";
  if (kind === "instagram" ? !/^instagram:[A-Za-z0-9_.]{2,40}$/.test(url) : !/^https?:\/\//i.test(url))
    return reply.code(400).send({ error: "Вкажіть коректний URL стрічки (https://…)" });
  const autoRun = req.body?.autoRun === true;
  const title = String(req.body?.title ?? "").trim().slice(0, 200) || null;
  const r = await one<{ id: string }>(
    `insert into content_source(workspace_id, kind, url, title, auto_run) values($1,$2,$3,$4,$5) returning id`,
    [req.user.workspace_id, kind, url, title, autoRun]);
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
  // ?source=broll - персональна відео-бібліотека для рілсів (вставки з автором у кадрі)
  const source = String(req.query?.source || "") === "broll" ? "broll" : "upload";
  try {
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      const m = await saveMedia(req.user.workspace_id, { buffer: buf, mime: part.mimetype || "application/octet-stream", name: part.filename, source });
      if (source === "broll" && m.kind !== "video") { await q(`delete from media_asset where id=$1`, [m.id]); await deleteMediaFile(m.filename); throw new Error("для b-roll потрібне відео (mp4/mov)"); }
      saved.push({ id: m.id, kind: m.kind, url: `/media/${m.filename}` });
    }
  } catch (e: any) { return reply.code(400).send({ error: e.message }); }
  return { ok: true, saved };
});

// технічні копії (ig-safe: JPEG-версія для Instagram API) в бібліотеці не показуємо -
// вони дублювали кожне опубліковане фото і засмічували медіатеку
app.get("/api/media", async (req: any) =>
  q(`select id, kind, mime, original_name, filename, size, source, created_at from media_asset
     where workspace_id=$1 and source not in ('ig-safe','ai-base') order by created_at desc limit 200`, [req.user.workspace_id]));

app.delete("/api/media/:id", async (req: any, reply) => {
  const m = await one<{ filename: string }>(`select filename from media_asset where id=$1 and workspace_id=$2`, [req.params.id, req.user.workspace_id]);
  if (!m) return reply.code(404).send({ error: "медіа не знайдено" });
  await q(`delete from media_asset where id=$1`, [req.params.id]);
  await deleteMediaFile(m.filename);
  return { ok: true };
});

// масове видалення з медіатеки (виділення чекбоксами в UI); пости не ламаються - post.media_id
// має on delete set null (фото просто відкріпиться)
app.post("/api/media/bulk-delete", async (req: any, reply) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, 300);
  if (!ids.length) return reply.code(400).send({ error: "нема що видаляти" });
  const rows = await q<{ id: string; filename: string }>(
    `select id, filename from media_asset where workspace_id=$1 and id = any($2::uuid[])`, [req.user.workspace_id, ids]);
  for (const m of rows) {
    await q(`delete from media_asset where id=$1`, [m.id]);
    await deleteMediaFile(m.filename);
  }
  return { ok: true, deleted: rows.length };
});

// прикріпити/відкріпити медіа до поста; з aspect — обітнути під формат (кроп-копія стає image_base)
app.post("/api/posts/:postId/media", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const mediaId = req.body?.mediaId || null;
  if (mediaId && req.body?.aspect) {
    const c = req.body?.crop;
    const crop = (c && [c.x, c.y, c.w, c.h].every((v: any) => typeof v === "number" && isFinite(v)))
      ? { x: c.x, y: c.y, w: c.w, h: c.h } : undefined;
    try { const r = await attachCroppedImage(ws, req.params.postId, mediaId, req.body.aspect, crop); return { ok: true, filename: r.filename }; }
    catch (e: any) { return reply.code(400).send({ error: e.message }); }
  }
  if (mediaId && !(await one(`select id from media_asset where id=$1 and workspace_id=$2`, [mediaId, ws])))
    return reply.code(404).send({ error: "медіа не знайдено" });
  await q(`update post set media_id=$2 where id=$1`, [req.params.postId, mediaId]);
  return { ok: true };
});


// ===================== КОМПОЗЕР (мульти-мережевий постинг) =====================
// які мережі взагалі підключені (для чипів у композері)
app.get("/api/channels/status", async (req: any) => {
  const ws = req.user.workspace_id;
  const [tgc, th, mt, li, yt, tt] = await Promise.all([
    one<{ bot_token: string | null; channel_chat_id: string | null; group_chat_id: string | null }>(`select bot_token, channel_chat_id, group_chat_id from telegram_config where workspace_id=$1`, [ws]),
    one<{ access_token: string | null }>(`select access_token from threads_config where workspace_id=$1`, [ws]),
    one<{ page_token: string | null; ig_user_id: string | null }>(`select page_token, ig_user_id from meta_config where workspace_id=$1`, [ws]),
    one<{ access_token: string | null }>(`select access_token from linkedin_config where workspace_id=$1`, [ws]),
    one<{ access_token: string | null }>(`select access_token from youtube_config where workspace_id=$1`, [ws]),
    one<{ access_token: string | null }>(`select access_token from tiktok_config where workspace_id=$1`, [ws]),
  ]);
  return {
    telegram: !!(tgc && tgc.bot_token && (tgc.channel_chat_id || tgc.group_chat_id)),
    threads: !!(th && th.access_token),
    facebook: !!(mt && mt.page_token),
    instagram: !!(mt && mt.page_token && mt.ig_user_id),
    linkedin: !!(li && li.access_token),
    youtube: !!(yt && yt.access_token),
    tiktok: !!(tt && tt.access_token),
  };
});

// повний стан поста для композера (текст, канали, фото)
app.get("/api/posts/:postId/full", async (req: any, reply) => {
  const p = await one(`select p.id, p.content, p.review, p.channels, p.headline, p.rubric, p.intent, p.format, p.image_prompt, (p.image_base is not null) as has_base, ma.filename as media_filename
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
  const post = await one<{ content: string; channels: any; intent: string | null }>(
    `select p.content, p.channels, p.intent from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  const channels: string[] = Array.isArray(req.body?.channels) ? req.body.channels : [];
  try {
    const variants = await adaptForChannels(ws, post.content, channels, post.intent || undefined);
    const cur = post.channels || {};
    for (const ch of channels) cur[ch] = { on: true, text: variants[ch] || (cur[ch] && cur[ch].text) || post.content };
    await q(`update post set channels=$2 where id=$1`, [req.params.postId, JSON.stringify(cur)]);
    return { ok: true, channels: cur };
  } catch (e: any) { await logEvent("error", "adapt", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// опублікувати в усі обрані мережі (через спільний publisher)
// 📣 ПУБЛІКАЦІЯ - ФОНОВА ДЖОБА, а не синхронний запит.
// Причина: пост їде в мережі ПОСЛІДОВНО, і кожна ланка може бути повільною - авто-адаптація тексту,
// polling контейнера в Instagram і Threads (вони обробляють медіа асинхронно, до 40с кожен), ретраї з
// бекофом, паузи між частинами гілки, дозапит permalink. У сумі це легко перевалює за хвилину, а
// nginx рве проксі-зʼєднання на 60с і віддає 504. Найгірше тут не сама помилка: публікація на сервері
// ПРОДОВЖУВАЛАСЬ і зазвичай успішно завершувалась, тож людина бачила «⚠ 504» на реально
// опублікованому пості. Тепер запит одразу вертає «почав», а клієнт полить статус.
type PubJob = { status: "running" | "done" | "error"; results?: any[]; message?: string; error?: string; at: number };
const publishJobs = new Map<string, PubJob>();
const PUBJOB_TTL = 15 * 60 * 1000;

function startPublishJob(postId: string, work: () => Promise<Partial<PubJob>>): PubJob {
  // прибирання завершених джоб: Map інакше росла б увесь час життя процесу
  for (const [k, v] of publishJobs) if (v.status !== "running" && Date.now() - v.at > PUBJOB_TTL) publishJobs.delete(k);
  const cur = publishJobs.get(postId);
  if (cur && cur.status === "running") return cur;   // подвійний клік не запускає другу публікацію
  const job: PubJob = { status: "running", at: Date.now() };
  publishJobs.set(postId, job);
  work()
    .then((out) => publishJobs.set(postId, { ...job, ...out, status: "done", at: Date.now() }))
    .catch(async (e: any) => {
      publishJobs.set(postId, { ...job, status: "error", error: String(e?.message || e).slice(0, 300), at: Date.now() });
      await logEvent("error", "publish", e?.message || String(e), { postId });
    });
  return job;
}

app.post("/api/posts/:postId/publish-all", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const postId = req.params.postId;
  if (!(await postOwned(postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const job = startPublishJob(postId, async () => {
    const results = await publishPostToChannels(ws, postId);
    if (!results.length) throw new Error("Оберіть хоча б одну мережу");
    // Публікація один раз на мережу: гасимо запланований слот ЛИШЕ якщо не лишилось не надісланих мереж
    // (інакше слот має відпрацювати решту мереж пізніше). Так уникаємо і дубля, і скасування каналу.
    if (results.some((r) => r.status === "sent")) {
      // «Розвідник», режим «Питання»: 3 питання-продовження від аудиторії → Банк ідей
      one<{ content: string }>(`select content from post where id=$1`, [postId])
        .then((p) => p && publishQuestions(ws, p.content)).catch(() => {});
      const post = await one<{ channels: any }>(`select channels from post where id=$1`, [postId]);
      const enabled = Object.keys(post?.channels || {}).filter((k) => post!.channels[k] && post!.channels[k].on);
      const sent = new Set(await alreadySentNetworks(postId));
      if (!enabled.filter((k) => !sent.has(k)).length) {
        await q(`update schedule_slot set status='posted', result='опубліковано вручну (слот погашено)' where post_id=$1 and status='planned'`, [postId]);
        await q(`update plan_slot set status='published' where post_id=$1 and status in ('drafted','approved','scheduled')`, [postId]);
      }
    }
    return { results };
  });
  return { started: true, status: job.status };
});

// Статус публікації. `idle` = джоби нема (процес перезапустився або запит прийшов надто пізно) -
// клієнт у цьому разі просто перечитує реальний стан поста через /publish-state, а не висить вічно.
app.get("/api/posts/:postId/publish-job", async (req: any, reply) => {
  if (!(await postOwned(req.params.postId, req.user.workspace_id))) return reply.code(404).send({ error: "пост не знайдено" });
  const j = publishJobs.get(req.params.postId);
  return j ? { status: j.status, results: j.results, message: j.message, error: j.error } : { status: "idle" };
});

// 🔗 Посилання на опублікований пост по мережах. Для постів, опублікованих ДО появи колонки
// permalink, лінк збирається зі збережених id тут же (Telegram/Facebook/LinkedIn це дозволяють) і
// доліковується в БД, щоб наступного разу вже читався готовим. Threads/Instagram віддають permalink
// лише запитом - для старих рядків доганяємо його лениво, по одному посту на вимогу UI.
async function postPermalinks(ws: string, postId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const [tg, th, mt, li, tgc] = await Promise.all([
    q<{ id: string; chat_id: string | null; message_id: string | null; permalink: string | null; target: string }>(
      `select id, chat_id, message_id::text as message_id, permalink, target from telegram_publish where post_id=$1 and status='sent'`, [postId]),
    q<{ id: string; media_id: string | null; permalink: string | null }>(
      `select id, media_id, permalink from threads_publish where post_id=$1 and status='sent'`, [postId]),
    q<{ id: string; channel: string; external_id: string | null; permalink: string | null }>(
      `select id, channel, external_id, permalink from meta_publish where post_id=$1 and status='sent'`, [postId]),
    q<{ id: string; external_id: string | null; permalink: string | null }>(
      `select id, external_id, permalink from linkedin_publish where post_id=$1 and status='sent'`, [postId]),
    one<{ channel_username: string | null }>(`select channel_username from telegram_config where workspace_id=$1`, [ws]),
  ]);
  // тип-юніон, а не string: імʼя таблиці підставляється в SQL, тож звужуємо його на рівні компілятора,
  // щоб тут ніколи не могло опинитись значення із запиту
  type PubTable = "telegram_publish" | "threads_publish" | "meta_publish" | "linkedin_publish";
  const heal = async (table: PubTable, id: string, url: string) => {
    await q(`update ${table} set permalink=$2 where id=$1`, [id, url]);
  };
  for (const r of tg) {
    let url = r.permalink || "";
    if (!url) { url = tgLink(r.chat_id || "", r.message_id, r.target === "channel" ? tgc?.channel_username : null); if (url) await heal("telegram_publish", r.id, url); }
    if (url && !out.telegram) out.telegram = url;
  }
  for (const r of mt) {
    let url = r.permalink || "";
    if (!url && r.channel === "facebook") { url = fbLink(r.external_id); if (url) await heal("meta_publish", r.id, url); }
    if (url && r.channel && !out[r.channel]) out[r.channel] = url;
  }
  for (const r of li) {
    let url = r.permalink || "";
    if (!url) { url = liLink(r.external_id); if (url) await heal("linkedin_publish", r.id, url); }
    if (url && !out.linkedin) out.linkedin = url;
  }
  // Threads: старі рядки без permalink - один запит на пост (не критично, якщо не вийде)
  for (const r of th) {
    let url = r.permalink || "";
    if (!url && r.media_id) {
      try {
        const tok = await thValidToken(ws);
        if (tok) { url = await threads.mediaPermalink(tok.token, r.media_id); if (url) await heal("threads_publish", r.id, url); }
      } catch { /* лишиться без лінка */ }
    }
    if (url && !out.threads) out.threads = url;
  }
  // Instagram зі старих рядків: permalink теж лише запитом
  for (const r of mt) {
    if (r.channel !== "instagram" || r.permalink || !r.external_id) continue;
    try {
      const cfg = await one<{ page_token: string | null }>(`select page_token from meta_config where workspace_id=$1`, [ws]);
      if (cfg?.page_token) { const url = await meta.mediaPermalink(r.external_id, cfg.page_token); if (url) { await heal("meta_publish", r.id, url); out.instagram = out.instagram || url; } }
    } catch { /* лишиться без лінка */ }
  }
  return out;
}

// стан публікації поста: у які мережі вже відправлено (для композера — блокуємо повторну відправку)
app.get("/api/posts/:postId/publish-state", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const sent = await alreadySentNetworks(req.params.postId);
  return { sent, links: await postPermalinks(ws, req.params.postId) };
});

// 🧵 Тейки для Threads: N коротких чернеток з Банку ідей/щоденника (кнопка в Студії;
// щоденну автопорцію вмикає threads_strategy.takes - воркер threads-auto)
app.post("/api/posts/threads-takes", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  try { const created = await generateThreadsTakes(ws, Number(req.body?.count || 5)); return { ok: true, created }; }
  catch (e: any) { await logEvent("error", "threads-takes", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// 🔁 «Повторити хіт»: дубль поста зі свіжим гачком + план на +48 год (тільки Threads за замовч.)
app.post("/api/posts/:postId/repeat", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ run_id: string; content: string; image_prompt: string | null; rubric: string | null; media_id: string | null; channels: any }>(
    `select p.run_id, p.content, p.image_prompt, p.rubric, p.media_id, p.channels from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try {
    const fresh = await repeatVariant(ws, post.content);
    const hours = Math.max(1, Math.min(168, Number(req.body?.hours) || 48));
    // дубль їде лише в Threads (там повтор іншій аудиторії - валідована практика; інші мережі дублікати не люблять)
    const np = await one<{ id: string }>(
      `insert into post(run_id, stage, content, image_prompt, rubric, media_id, channels)
       values($1,'final',$2,$3,$4,$5,$6::jsonb) returning id`,
      [post.run_id, fresh, post.image_prompt, post.rubric, post.media_id, JSON.stringify({ threads: { on: true } })]);
    const when = new Date(Date.now() + hours * 3600e3).toISOString();
    await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [np!.id, when]);
    return { ok: true, id: np!.id, scheduledAt: when };
  } catch (e: any) { await logEvent("error", "repeat", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// 🧵 «Розгорнути в гілку»: тейк-хіт → повний пост-чернетка з увімкненою гілкою Threads
app.post("/api/posts/:postId/expand-thread", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ run_id: string; content: string; rubric: string | null }>(
    `select p.run_id, p.content, p.rubric from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try {
    const full = await expandTake(ws, post.content);
    const np = await one<{ id: string }>(
      `insert into post(run_id, stage, content, rubric, channels) values($1,'final',$2,$3,$4::jsonb) returning id`,
      [post.run_id, full, post.rubric, JSON.stringify({ threads: { on: true, thread: true } })]);
    return { ok: true, id: np!.id };
  } catch (e: any) { await logEvent("error", "expand-thread", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// 🚀 Стартовий пакет Threads: біо-варіанти (копіювати руками) + 2 чернетки (знайомство + закріп)
app.post("/api/threads/starter-pack", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  try {
    const pack = await threadsStarterPack(ws);
    const src = await one<{ id: string }>(
      `insert into source(workspace_id, origin, title, transcript) values($1,'takes','🚀 Стартовий пакет Threads',$2) returning id`,
      [ws, pack.intro + "\n\n" + pack.pinned]);
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
    const intro = await one<{ id: string }>(`insert into post(run_id, stage, content, channels) values($1,'final',$2,$3::jsonb) returning id`,
      [run!.id, pack.intro, JSON.stringify({ threads: { on: true } })]);
    const pinned = await one<{ id: string }>(`insert into post(run_id, stage, content, channels) values($1,'final',$2,$3::jsonb) returning id`,
      [run!.id, pack.pinned, JSON.stringify({ threads: { on: true } })]);
    return { ok: true, bio: pack.bio, introId: intro!.id, pinnedId: pinned!.id };
  } catch (e: any) { await logEvent("error", "threads-starter", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// 🔍 Розбір ніші: формули з хітів Threads-джерел + власних топів; ідеї падають у Банк
app.post("/api/threads/niche-review", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  try { return { ok: true, ...(await threadsNicheReview(ws)) }; }
  catch (e: any) { await logEvent("error", "niche-review", e.message, null, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// 💬 Реплай-коуч: свіжі коментарі під нашими Threads-постами + AI-драфт відповіді на кожен.
// Потребує threads_manage_replies у токені (перепідключення після апруву пермішена).
app.get("/api/threads/comments", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const cfg = await one<{ access_token: string | null; threads_user_id: string | null; username: string | null }>(
    `select access_token, threads_user_id, username from threads_config where workspace_id=$1`, [ws]);
  if (!cfg?.access_token) return reply.code(400).send({ error: "Threads не підключено" });
  const posts = await q<{ media_id: string; content: string }>(
    `select tp.media_id, p.content from threads_publish tp join post p on p.id=tp.post_id
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and tp.status='sent' and tp.media_id is not null
       and tp.created_at > now() - interval '7 days' order by tp.created_at desc limit 6`, [ws]);
  if (!posts.length) return { items: [], hint: "За останній тиждень нема опублікованих Threads-постів." };
  let replied: string[] = [];
  try { const rr = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='th_replied'`, [ws]); replied = JSON.parse(rr?.content || "[]") || []; } catch { replied = []; }
  const repliedSet = new Set(replied);
  const items: { commentId: string; username: string; comment: string; postTitle: string; postText: string; timestamp: string }[] = [];
  let permErr = "";
  for (const p of posts) {
    try {
      for (const r of await threads.mediaReplies(cfg.access_token, p.media_id)) {
        if (cfg.username && r.username.toLowerCase() === cfg.username.toLowerCase()) continue; // власні ветки/відповіді
        if (repliedSet.has(r.id)) continue;
        items.push({ commentId: r.id, username: r.username, comment: r.text, postTitle: (p.content || "").split("\n")[0].slice(0, 70), postText: p.content || "", timestamp: r.timestamp });
      }
    } catch (e: any) { permErr = String(e.message).slice(0, 200); }
  }
  if (!items.length && permErr)
    return reply.code(400).send({ error: "Не вдалося прочитати коментарі: " + permErr + ". Якщо пермішен threads_manage_replies щойно увімкнено - перепідключи Threads у Налаштування → Канали (токен отримує нові дозволи лише при повторному підключенні)." });
  items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  // ?countOnly=1 - дешевий лічильник для екрана «Сьогодні» (без LLM-драфтів)
  if (String(req.query?.countOnly || "") === "1") return { count: items.length };
  let drafts: Record<string, string> = {};
  try { drafts = await suggestThreadReplies(ws, items.map((it) => ({ commentId: it.commentId, postText: it.postText, comment: it.comment, username: it.username }))); }
  catch { /* без драфтів теж корисно - користувач напише сам */ }
  return { items: items.slice(0, 15).map((it) => ({ commentId: it.commentId, username: it.username, comment: it.comment, postTitle: it.postTitle, timestamp: it.timestamp, draft: drafts[it.commentId] || "" })) };
});

// відповісти на конкретний комент (reply_to_id = id комента; фіксуємо, щоб не показувати вдруге)
app.post("/api/threads/reply", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const commentId = String(req.body?.commentId || ""), text = String(req.body?.text || "").trim().slice(0, 490);
  if (!commentId || !text) return reply.code(400).send({ error: "порожня відповідь" });
  const tok = await thValidToken(ws);
  if (!tok) return reply.code(400).send({ error: "Threads не підключено" });
  try {
    await threads.publish(tok.token, tok.userId, text, undefined, commentId);
    let replied: string[] = [];
    try { const rr = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='th_replied'`, [ws]); replied = JSON.parse(rr?.content || "[]") || []; } catch { replied = []; }
    replied.push(commentId);
    await q(`insert into settings_block(workspace_id, key, content) values($1,'th_replied',$2)
             on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
      [ws, JSON.stringify(replied.slice(-200))]);
    return { ok: true };
  } catch (e: any) {
    await logEvent("error", "threads-reply", e.message, null, req.user.id);
    return reply.code(500).send({ error: e.message + (/permission|not authorized|OAuth/i.test(e.message) ? " (перепідключи Threads - нові дозволи діють після повторного підключення)" : "") });
  }
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

// ПРОТОТИП (бета): сценарій Reels → готове відео. Старт фонової збірки + полінг статусу (nginx-таймаути не заважають).
app.post("/api/posts/:postId/reel-video", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string; filename: string | null }>(
    `select p.content, ma.filename from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       left join media_asset ma on ma.id=p.media_id
     where p.id=$1 and s.workspace_id=$2`, [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  if (!env.azure.speechKey) return reply.code(400).send({ error: "Потрібен AZURE_SPEECH_KEY у .env (Azure Speech, безкоштовний тариф F0) + перезапуск стека" });
  if (parseReelScript(post.content || "").length < 2) return reply.code(400).send({ error: "Це не сценарій Reels - спершу зроби «🎬 Сценарій Reels» на матеріалі" });
  const j = reelJobs.get(req.params.postId);
  if (j?.status === "running") return { ok: true, status: "running" };
  startReelJob(ws, req.params.postId, post.content, post.filename);
  return { ok: true, status: "running" };
});
app.get("/api/posts/:postId/reel-video", async (req: any, reply) => {
  if (!(await postOwned(req.params.postId, req.user.workspace_id))) return reply.code(404).send({ error: "пост не знайдено" });
  const j = reelJobs.get(req.params.postId);
  if (j) return j;
  // після рестарту/для іншої вкладки: готовий рілс лежить на пості
  const p = await one<{ reel_video: string | null }>(`select reel_video from post where id=$1`, [req.params.postId]);
  return p?.reel_video ? { status: "done", filename: p.reel_video } : { status: "none" };
});

// Публікація готового рілса: IG Reels / FB відео / YouTube Shorts / TikTok (чернетка).
// Фонова джоба (IG обробляє відео до ~3 хв): POST стартує, GET полить.
app.post("/api/posts/:postId/reel-publish", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const nets = (Array.isArray(req.body?.nets) ? req.body.nets : []).filter((n: any) => ["instagram", "facebook", "youtube", "tiktok"].includes(n));
  if (!nets.length) return reply.code(400).send({ error: "обери хоча б одну мережу" });
  const j = reelPubJobs.get(req.params.postId);
  if (j?.status === "running") return { ok: true, status: "running" };
  startReelPublishJob(ws, req.params.postId, nets);
  return { ok: true, status: "running" };
});
app.get("/api/posts/:postId/reel-publish", async (req: any, reply) => {
  if (!(await postOwned(req.params.postId, req.user.workspace_id))) return reply.code(404).send({ error: "пост не знайдено" });
  const j = reelPubJobs.get(req.params.postId);
  const sent = await reelSentNetworks(req.params.postId);
  return j ? { ...j, sent } : { status: "none", sent };
});

// Стокові фото Pexels: 2-3 варіанти під тему поста → юзер обирає → кроп під формат + база для тексту
app.post("/api/posts/:postId/stock-photos", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try { const photos = await stockPhotoOptions(ws, post.content, String(req.body?.aspect || "")); return { ok: true, photos }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});
app.post("/api/posts/:postId/stock-photo", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const url = String(req.body?.url || "");
  if (!url) return reply.code(400).send({ error: "нема url фото" });
  try { const r = await attachStockPhoto(ws, req.params.postId, url, String(req.body?.aspect || "")); return { ok: true, filename: r.filename }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// «Мультиплікатор», Продовження: 5 кутів розвитку теми поста → Банк ідей
app.post("/api/posts/:postId/develop", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try {
    const ideas = await suggestDevelopment(ws, post.content || "");
    for (const it of ideas) await q(`insert into idea_bank(workspace_id, text, angle, origin) values($1,$2,$3,'ai')`, [ws, it.idea.slice(0, 500), it.angle.slice(0, 300) || "розвиток"]);
    return { ok: true, ideas };
  } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// «Мультиплікатор», Нарізка: матеріал → серія постів одним кліком (тейки Розвідника → генерація)
app.post("/api/materials/:id/series", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const m = await one<{ id: string; transcript: string; origin: string }>(`select id, transcript, origin from source where id=$1 and workspace_id=$2`, [req.params.id, ws]);
  if (!m) return reply.code(404).send({ error: "матеріал не знайдено" });
  try {
    const takes = await extractIdeasFromText(ws, m.transcript, 6, undefined, ideaMode(m.origin));
    if (!takes.length) return reply.code(500).send({ error: "не вдалося витягнути тейки з матеріалу" });
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [m.id]);
    // серія з АРКОМ: частини пов'язані і ведуть до пейофу, а не розсип постів на тему
    const n = takes.length;
    const count = await generatePostsOnePass(run!.id, n,
      takes.map((t, i) => t.idea + (t.angle ? ` Кут: ${t.angle}.` : "") + (t.hook ? ` Гачок: ${t.hook}` : "") +
        ` [Це частина ${i + 1} з ${n} звʼязаної серії: кожен пост самостійний, але наприкінці - місток-інтрига до наступної частини${i === n - 1 ? "; ЦЕ ФІНАЛ серії - пейофф: сильний висновок усього арка + головний CTA" : ""}.]`));
    return { ok: true, count };
  } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// «Магніт»: лід-магніти (генерація + збережений список)
app.post("/api/lead-magnets", async (req: any, reply) => {
  try { return { ok: true, magnets: await suggestLeadMagnets(req.user.workspace_id) }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});
// «Магніт» крок 2: зібрати САМ магніт - готовий чекліст/гайд як чернетка в Студії
app.post("/api/lead-magnets/build", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const title = String(req.body?.title ?? "").trim();
  const what = String(req.body?.what ?? "").trim();
  if (!title) return reply.code(400).send({ error: "нема назви магніта" });
  try {
    const text = await buildLeadMagnet(ws, { title, what, keyword: String(req.body?.keyword ?? "") });
    const src = await one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,'idea',$2,$3) returning id`,
      [ws, `🧲 ${title}`.slice(0, 200), `Лід-магніт: ${title}. ${what}`.slice(0, 2000)]);
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
    const post = await one<{ id: string }>(`insert into post(run_id, stage, content) values($1,'final',$2) returning id`, [run!.id, text]);
    return { ok: true, postId: post!.id };
  } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});
// «Магніт під ТЕМУ»: 🧲 на картці поста - магніти саме під цю тему (кеш не чіпає)
app.post("/api/posts/:postId/lead-magnet", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try { return { ok: true, magnets: await suggestLeadMagnets(ws, post.content.slice(0, 800)) }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});
app.get("/api/lead-magnets", async (req: any) => {
  const row = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='lead_magnets'`, [req.user.workspace_id]);
  let magnets: any[] = []; try { magnets = JSON.parse(row?.content || "[]"); } catch { magnets = []; }
  return { magnets };
});

// «Коваль» (самонавчання голосу): правка юзера → постійне правило в tone_of_voice
// Бенчмарки ×N: медіана переглядів по мережі (норма) + множник кожного поста до неї
// ⚡ Екран «Сьогодні»: один виклик = стан дня (те саме, що ранковий дайджест бота, але живе в застосунку).
// Дешевий: лише БД-запити; коменти Threads фронт довантажує окремо (?countOnly=1).
app.get("/api/today", async (req: any) => {
  const ws = req.user.workspace_id;
  const tz = (await getSettingText(ws, "timezone")) || "Europe/Kyiv";
  const dayStr = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - offset * 86400e3));
  const today = dayStr(0);
  const [slots, drafts, draftsCount, ideas, nextSlot, thConn, thDays, planCount, approvedCount, chanCount, failed, freshMat, pubYest, netToday] = await Promise.all([
    // що виходить/вийшло сьогодні (за таймзоною воркспейсу)
    q<any>(`select ss.id, ss.scheduled_at, ss.status, ss.result, coalesce(ss.channels, p.channels) as channels,
                   p.id as post_id, left(regexp_replace(p.content,'\\s+',' ','g'), 90) as title
              from schedule_slot ss join post p on p.id=ss.post_id
              join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where s.workspace_id=$1 and ss.scheduled_at is not null
              and to_char(ss.scheduled_at at time zone $2,'YYYY-MM-DD')=$3
            order by ss.scheduled_at`, [ws, tz, today]),
    // топ-3 чернетки на затвердження (найсвіжіші, ще не затверджені й не опубліковані)
    q<any>(`select p.id, left(regexp_replace(p.content,'\\s+',' ','g'), 120) as title, p.rubric
              from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where s.workspace_id=$1 and p.stage='final' and coalesce(p.review,'')not in('approved','archived')
              and not exists (select 1 from threads_publish tp where tp.post_id=p.id and tp.status='sent')
              and not exists (select 1 from telegram_publish tg2 where tg2.post_id=p.id and tg2.status='sent')
              and not exists (select 1 from meta_publish mp where mp.post_id=p.id and mp.status='sent')
            order by p.created_at desc limit 3`, [ws]),
    one<{ n: number }>(`select count(*)::int n from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where s.workspace_id=$1 and p.stage='final' and coalesce(p.review,'') not in ('approved','archived')`, [ws]),
    one<{ n: number }>(`select count(*)::int n from idea_bank where workspace_id=$1 and status='new'`, [ws]),
    one<{ id: string; theme: string; slot_date: string }>(
      `select id, theme, slot_date::text from plan_slot where workspace_id=$1 and slot_date >= $2 and status in ('empty','matched') order by slot_date limit 1`, [ws, today]),
    one<{ n: number }>(`select count(*)::int n from threads_config where workspace_id=$1 and access_token is not null`, [ws]),
    q<{ d: string }>(`select distinct to_char(tp.created_at at time zone $2,'YYYY-MM-DD') as d
              from threads_publish tp join post p on p.id=tp.post_id
              join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where s.workspace_id=$1 and tp.status='sent' and tp.created_at > now() - interval '60 days'`, [ws, tz]),
    // швидкий старт: чи є план, чи затверджений хоч один пост, чи підключений хоч один канал
    one<{ n: number }>(`select count(*)::int n from plan_slot where workspace_id=$1`, [ws]),
    one<{ n: number }>(`select count(*)::int n from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where s.workspace_id=$1 and p.review='approved'`, [ws]),
    one<{ n: number }>(
      `select ((exists(select 1 from telegram_config where workspace_id=$1 and bot_token is not null and (channel_chat_id is not null or group_chat_id is not null)))::int
             + (exists(select 1 from threads_config  where workspace_id=$1 and access_token is not null))::int
             + (exists(select 1 from meta_config     where workspace_id=$1 and page_token   is not null))::int
             + (exists(select 1 from linkedin_config where workspace_id=$1 and access_token is not null))::int) as n`, [ws]),
    // ⚠ збої публікацій за 48г - інакше ховаються в тултіпах календаря і юзер їх не бачить
    q<any>(`select ss.id, ss.scheduled_at, left(coalesce(ss.result,''), 160) as result, p.id as post_id,
                   left(regexp_replace(p.content,'\\s+',' ','g'), 80) as title
              from schedule_slot ss join post p on p.id=ss.post_id
              join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where s.workspace_id=$1 and ss.status='failed' and ss.scheduled_at > now() - interval '48 hours'
            order by ss.scheduled_at desc limit 5`, [ws]),
    // 📥 нові матеріали з джерел за 24г (без тумбстоунів) + найкраща AI-оцінка
    one<{ n: number; top: number | null }>(
      `select count(*)::int n, max(ai_score) as top from source
        where workspace_id=$1 and archived=false and origin='rss' and created_at > now() - interval '24 hours'`, [ws]),
    // ✈️ скільки публікацій реально вийшло вчора (за таймзоною) - замикання циклу «зробив → вийшло»
    one<{ n: number }>(
      `select count(*)::int n from (
         select tp.created_at from telegram_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.status='sent'
         union all select tp.created_at from threads_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.status='sent'
         union all select tp.created_at from meta_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.status='sent'
         union all select tp.created_at from linkedin_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.status='sent'
       ) u where to_char(u.created_at at time zone $2,'YYYY-MM-DD')=$3`, [ws, tz, dayStr(1)]),
    // 📡 funnel/канали-віджет «Сьогодні»: скільки пішло СЬОГОДНІ по кожній мережі окремо
    q<{ net: string; n: number }>(
      `select net, count(*)::int n from (
         select 'telegram' as net, tp.created_at from telegram_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.status='sent'
         union all select 'threads', tp.created_at from threads_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.status='sent'
         union all select 'instagram', tp.created_at from meta_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.channel='instagram' and tp.status='sent'
         union all select 'facebook', tp.created_at from meta_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.channel='facebook' and tp.status='sent'
         union all select 'linkedin', tp.created_at from linkedin_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where s.workspace_id=$1 and tp.status='sent'
       ) u where to_char(u.created_at at time zone $2,'YYYY-MM-DD')=$3 group by net`, [ws, tz, today]),
  ]);
  // стрік Threads: поспіль днів із публікацією (сьогодні ще без поста - стрік живий від учора)
  const set = new Set(thDays.map((x) => x.d));
  let streak = 0;
  for (let i = set.has(today) ? 0 : 1; i < 60; i++) { if (set.has(dayStr(i))) streak++; else break; }
  const netTodayMap: Record<string, number> = {};
  for (const r of netToday) netTodayMap[r.net] = r.n;
  return {
    date: today,
    slots, drafts, draftsTotal: draftsCount?.n || 0, ideas: ideas?.n || 0,
    nextSlot: nextSlot || null,
    threads: (thConn?.n || 0) > 0 ? { streak, postedToday: set.has(today) } : null,
    quickstart: { channels: chanCount?.n || 0, plan: planCount?.n || 0, approved: approvedCount?.n || 0 },
    failed, freshMaterials: { count: freshMat?.n || 0, top: freshMat?.top ?? null }, publishedYesterday: pubYest?.n || 0,
    netToday: netTodayMap,
    publishedToday: Object.values(netTodayMap).reduce((a, b) => a + b, 0),
  };
});

// укр. відмінок числівника: 1 чернетка / 2 чернетки / 5 чернеток
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
// 🦉 Помічник-провідник (сова Rozum): «твій наступний крок». Обчислює стан воркспейсу і повертає
// пріоритезований список порад - кожна з ціллю (куди летіти) і дією (кнопка). Фронт логує показ/клік.
app.get("/api/guide/next", async (req: any) => {
  const ws = req.user.workspace_id;
  const off = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='guide_off'`, [ws]);
  if (off?.content === "1") return { off: true, tips: [] };
  const S: Record<string, string> = {};
  for (const r of await q<{ key: string; content: string }>(`select key, content from settings_block where workspace_id=$1`, [ws])) S[r.key] = (r.content || "").trim();
  const [chan, plan, drafts, approvedUnsched, noImg, src, thConn, thToday, ideas] = await Promise.all([
    one<{ n: number }>(
      `select ((exists(select 1 from telegram_config where workspace_id=$1 and bot_token is not null and (channel_chat_id is not null or group_chat_id is not null)))::int
             + (exists(select 1 from threads_config where workspace_id=$1 and access_token is not null))::int
             + (exists(select 1 from meta_config where workspace_id=$1 and page_token is not null))::int
             + (exists(select 1 from linkedin_config where workspace_id=$1 and access_token is not null))::int) as n`, [ws]),
    one<{ n: number }>(`select count(*)::int n from plan_slot where workspace_id=$1`, [ws]),
    // чернетки на затвердження (не затверджені, не опубліковані)
    one<{ n: number }>(`select count(*)::int n from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       where s.workspace_id=$1 and p.stage='final' and coalesce(p.review,'')not in('approved','archived')
         and not exists(select 1 from telegram_publish t where t.post_id=p.id and t.status='sent')
         and not exists(select 1 from threads_publish t where t.post_id=p.id and t.status='sent')
         and not exists(select 1 from meta_publish t where t.post_id=p.id and t.status='sent')`, [ws]),
    // затверджені, але ще не в календарі й не опубліковані
    one<{ n: number }>(`select count(*)::int n from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       where s.workspace_id=$1 and p.review='approved'
         and not exists(select 1 from schedule_slot ss where ss.post_id=p.id and ss.status in('planned','posting','posted'))
         and not exists(select 1 from telegram_publish t where t.post_id=p.id and t.status='sent')`, [ws]),
    // затверджені без зображення
    one<{ n: number }>(`select count(*)::int n from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       where s.workspace_id=$1 and p.review='approved' and p.media_id is null`, [ws]),
    one<{ n: number }>(`select count(*)::int n from source where workspace_id=$1 and archived=false`, [ws]),
    one<{ n: number }>(`select count(*)::int n from threads_config where workspace_id=$1 and access_token is not null`, [ws]),
    one<{ n: number }>(`select count(*)::int n from threads_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       where s.workspace_id=$1 and tp.status='sent' and tp.created_at > now() - interval '20 hours'`, [ws]),
    one<{ n: number }>(`select count(*)::int n from idea_bank where workspace_id=$1 and status='new'`, [ws]),
  ]);
  type Tip = { id: string; text: string; emote: string; target: string; action?: { label: string; view?: string; tab?: string; do?: string } };
  const tips: Tip[] = [];
  // порядок = реальний воркфлоу; беремо перші незакриті кроки
  if (!S.marketing_context) tips.push({ id: "brand", text: "Почнемо з бренду - розкажи, чим займаєшся і для кого. Це контекст для кожного поста.", emote: "point", target: '.navitem[data-view="brand"]', action: { label: "Заповнити бренд", view: "brand" } });
  if ((chan?.n || 0) === 0) tips.push({ id: "channel", text: "Підключи хоч один канал публікації - інакше постам нікуди виходити.", emote: "point", target: "#avatar", action: { label: "Підключити канал", view: "settings", tab: "channels" } });
  if (!S.pain_points && !S.brand_thesis && S.marketing_context) tips.push({ id: "pains", text: "Заповни болі клієнта - і AI перестане «писати не про те», а бере теми з реального болю.", emote: "think", target: '.navitem[data-view="brand"]', action: { label: "Додати болі", view: "strategy" } });
  if ((plan?.n || 0) === 0) tips.push({ id: "plan", text: "Згенеруй контент-план - я розкладу теми на тижні вперед за твоєю стратегією.", emote: "point", target: '.navitem[data-view="publish"]', action: { label: "Створити план", view: "publish", tab: "plan" } });
  if ((src?.n || 0) === 0 && (plan?.n || 0) > 0) tips.push({ id: "source", text: "Додай джерело контенту (тема новин, Telegram-канал чи просто думку) - буде з чого робити пости.", emote: "point", target: "#genPostsBtn", action: { label: "Додати матеріал", do: "addmaterial" } });
  if ((drafts?.n || 0) > 0) tips.push({ id: "approve", text: `У тебе ${drafts!.n} ${plural(drafts!.n, "чернетка", "чернетки", "чернеток")} на затвердження - переглянь і затверди, щоб пости вийшли вчасно.`, emote: "happy", target: '.navitem[data-view="create"]', action: { label: `Переглянути (${drafts!.n})`, view: "create", tab: "posts" } });
  if ((approvedUnsched?.n || 0) > 0) tips.push({ id: "schedule", text: `${approvedUnsched!.n} затверджених ${plural(approvedUnsched!.n, "пост", "пости", "постів")} ще не в календарі. Додай їх - і публікація піде автоматично.`, emote: "point", target: '.navitem[data-view="publish"]', action: { label: "У календар", view: "publish", tab: "cal" } });
  if ((noImg?.n || 0) > 0) tips.push({ id: "image", text: `${noImg!.n} затверджених ${plural(noImg!.n, "пост", "пости", "постів")} без зображення - з картинкою охоплення помітно більше.`, emote: "think", target: '.navitem[data-view="create"]', action: { label: "До постів", view: "create", tab: "posts" } });
  if ((thConn?.n || 0) > 0 && (thToday?.n || 0) === 0) tips.push({ id: "takes", text: "Сьогодні ще нема поста в Threads. Зроблю 3 короткі тейки з Банку ідей - публікуєш у 1 тап.", emote: "point", target: '.navitem[data-view="create"]', action: { label: "3 тейки", do: "takes" } });
  if (!tips.length) tips.push({ id: "allgood", text: (ideas?.n || 0) > 0 ? `Все під контролем 🦉 У Банку ${ideas!.n} ${plural(ideas!.n, "ідея", "ідеї", "ідей")} - можу зробити з них пости.` : "Все під контролем 🦉 Гарна робота! Зазирни в Аналітику - подивись, що спрацювало.", emote: "sleep", target: '.navitem[data-view="today"]', action: (ideas?.n || 0) > 0 ? { label: "До ідей", view: "create", tab: "ideas" } : { label: "Аналітика", view: "analytics" } });
  return { off: false, tips: tips.slice(0, 4) };
});
app.post("/api/guide/log", async (req: any) => {
  const tip = String(req.body?.tip || "").slice(0, 60);
  const event = String(req.body?.event || "").slice(0, 20);
  if (tip && event) { try { await q(`insert into guide_log(workspace_id, tip, event) values($1,$2,$3)`, [req.user.workspace_id, tip, event]); } catch { /* лог не критичний */ } }
  if (event === "off") { try { await q(`insert into settings_block(workspace_id,key,content) values($1,'guide_off','1') on conflict (workspace_id,key) do update set content='1'`, [req.user.workspace_id]); } catch { /* ignore */ } }
  if (event === "on") { try { await q(`delete from settings_block where workspace_id=$1 and key='guide_off'`, [req.user.workspace_id]); } catch { /* ignore */ } }
  return { ok: true };
});

app.get("/api/analytics/benchmarks", async (req: any) => networkBenchmarks(req.user.workspace_id));

// 🧵 Розширена аналітика Threads: профіль за 7 днів (з дельтами до попередніх 7), підписники,
// таблиця останніх постів, інтервал постингу, стрік, демографія (якщо API віддає).
// Живі виклики Graph API → кеш 15 хв у settings_block (щоб не молотити API кожним відкриттям).
app.get("/api/analytics/threads", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const cfg = await one<{ access_token: string | null; threads_user_id: string | null; username: string | null }>(
    `select access_token, threads_user_id, username from threads_config where workspace_id=$1`, [ws]);
  if (!cfg?.access_token || !cfg.threads_user_id) return reply.code(400).send({ error: "Threads не підключено" });
  const cached = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='threads_an_cache'`, [ws]);
  try { const c = JSON.parse(cached?.content || "{}"); if (c.ts && Date.now() - c.ts < 15 * 60e3 && c.data) return c.data; } catch { /* битий кеш - оновимо */ }
  const nowSec = Math.floor(Date.now() / 1000), week = 7 * 86400;
  const METRICS = ["views", "likes", "replies", "reposts", "quotes"];
  const data: any = { username: cfg.username || null, period: 7 };
  try { data.now = await threads.userInsights(cfg.access_token, cfg.threads_user_id, METRICS, nowSec - week, nowSec); } catch (e: any) { data.now = null; data.insightsError = String(e.message).slice(0, 200); }
  try { data.prev = data.now ? await threads.userInsights(cfg.access_token, cfg.threads_user_id, METRICS, nowSec - 2 * week, nowSec - week) : null; } catch { data.prev = null; }
  try { data.followers = (await threads.userInsights(cfg.access_token, cfg.threads_user_id, ["followers_count"])).followers_count ?? null; } catch { data.followers = null; }
  // демографія - best effort (потрібен threads_manage_insights і ≥100 підписників)
  data.demographics = {};
  for (const b of ["gender", "age", "country"] as const) {
    try { data.demographics[b] = await threads.followerDemographics(cfg.access_token, cfg.threads_user_id, b); } catch { /* без пермішена/замало підписників */ }
  }
  // останні пости з метриками (post_metric оновлює воркер кожні 6 год)
  data.posts = await q<any>(
    `select tp.post_id, tp.created_at, left(regexp_replace(p.content, '\\s+', ' ', 'g'), 90) as title,
            coalesce(pm.views,0) views, coalesce(pm.likes,0) likes, coalesce(pm.replies,0) replies,
            coalesce(pm.reposts,0) reposts, coalesce(pm.quotes,0) quotes
       from threads_publish tp join post p on p.id=tp.post_id
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       left join post_metric pm on pm.post_id=tp.post_id and pm.network='threads'
     where s.workspace_id=$1 and tp.status='sent'
     order by tp.created_at desc limit 10`, [ws]);
  // інтервал постингу за 7 днів + к-сть постів
  const pubs = await q<{ created_at: string }>(
    `select created_at from threads_publish tp join post p on p.id=tp.post_id
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and tp.status='sent' and tp.created_at > now() - interval '7 days'
     order by tp.created_at`, [ws]);
  data.postsCount = pubs.length;
  data.intervalH = pubs.length > 1
    ? Math.round((new Date(pubs[pubs.length - 1].created_at).getTime() - new Date(pubs[0].created_at).getTime()) / (pubs.length - 1) / 3600e3 * 10) / 10
    : null;
  // стрік: поспіль днів із ≥1 публікацією (за таймзоною воркспейсу), рахуючи від сьогодні/вчора
  const tzRow = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [ws]);
  const tz = tzRow?.content || "Europe/Kyiv";
  const days = await q<{ d: string }>(
    `select distinct to_char(tp.created_at at time zone $2, 'YYYY-MM-DD') as d
       from threads_publish tp join post p on p.id=tp.post_id
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and tp.status='sent' and tp.created_at > now() - interval '60 days'
     order by d desc`, [ws, tz]);
  const set = new Set(days.map((x) => x.d));
  const dayStr = (offset: number) => {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return f.format(new Date(Date.now() - offset * 86400e3));
  };
  let streak = 0, start = set.has(dayStr(0)) ? 0 : 1; // сьогодні ще без поста - стрік живий від учора
  for (let i = start; i < 60; i++) { if (set.has(dayStr(i))) streak++; else break; }
  data.streak = streak;
  data.postedToday = set.has(dayStr(0));
  await q(`insert into settings_block(workspace_id, key, content) values($1,'threads_an_cache',$2)
           on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
    [ws, JSON.stringify({ ts: Date.now(), data })]);
  return data;
});

// «Що спрацювало»: розбір топ-постів (×N ≥ 1.2) → повторювані патерни + готове правило голосу
app.post("/api/analytics/top-patterns", async (req: any, reply) => {
  try { return { ok: true, ...(await topPatterns(req.user.workspace_id)) }; }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

app.post("/api/voice-rules", async (req: any, reply) => {
  const rule = String(req.body?.rule ?? "").trim().slice(0, 200);
  if (!rule) return reply.code(400).send({ error: "порожнє правило" });
  const cur = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='tone_of_voice'`, [req.user.workspace_id]);
  const content = (cur?.content || "").trim();
  if (content.length > 4000) return reply.code(400).send({ error: "Голос бренду вже завеликий - почисти його в Базі бренду, тоді додам нове правило" });
  const next = content ? `${content}\n- ${rule}` : `Правила голосу:\n- ${rule}`;
  await q(`insert into settings_block(workspace_id, key, content) values($1,'tone_of_voice',$2)
           on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`, [req.user.workspace_id, next]);
  return { ok: true };
});

// «Хук-майстер»: 3 варіанти відкриття з кульмінації (точкова заміна першого рядка)
app.post("/api/posts/:postId/hooks", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try { return { ok: true, ...(await suggestHooks(ws, String(req.body?.text || post.content || ""))) }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// «Архітектор»: заголовок на картинку за принципом непересічення (не дублює текст поста)
app.post("/api/posts/:postId/headline", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try { return { ok: true, headline: await suggestHeadline(ws, post.content || "") }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// «Директор»: вердикт чи веде пост до головної цілі (дешева модель, on-demand)
app.post("/api/posts/:postId/director", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try { return { ok: true, ...(await directorVerdict(ws, String(req.body?.text || post.content || ""))) }; }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// «Антидетектор»: аудит AI-слідів без правки (діагностика)
app.post("/api/posts/:postId/ai-audit", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try { return { ok: true, findings: await aiAudit(ws, String(req.body?.text || post.content || "")) }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// «Сторителлінг-редактор»: оцінка поста як історії (12 прийомів) + до 5 правок «Було→Пропоную→Чому»
app.post("/api/posts/:postId/storytelling", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`,
    [req.params.postId, ws]);
  if (!post) return reply.code(404).send({ error: "пост не знайдено" });
  try { return { ok: true, ...(await storytellingVerdict(ws, String(req.body?.text || post.content || ""))) }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
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

// «Антидетектор» 2.0: точкове виправлення AI-слідів (2 проходи; решта тексту не рухається). НЕ зберігає - UI сам PUT-ає.
app.post("/api/posts/:postId/deai-fix", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const text = String(req.body?.text ?? "");
  if (!text.trim()) return reply.code(400).send({ error: "порожній текст" });
  try { return { ok: true, ...(await deAiFix(ws, text)) }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// перенакласти текст на вже згенероване БАЗОВЕ зображення (дешево, без нової генерації)
app.post("/api/posts/:postId/image-text", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  try { const filename = await overlayForPost(ws, req.params.postId, String(req.body?.headline ?? ""), req.body?.overlay !== false, { position: req.body?.position, font: req.body?.font, bg: req.body?.bg, align: req.body?.align, upper: req.body?.upper === true, accent: req.body?.accent, kicker: req.body?.kicker, subtitle: req.body?.subtitle, size: req.body?.size }); return { ok: true, filename }; }
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
  // ВЛАСНИЙ бот (токен відрізняється від спільного): реєструємо йому вебхук - тоді через нього
  // працює НЕ лише публікація, а всі DM-фічі (щоденник, дайджест, банк ідей, кнопки).
  if (token && token !== env.telegram.botToken) {
    try {
      const username = await registerOwnBotWebhook(token);
      await logEvent("info", "tgbot", `власний бот @${username} підключено (webhook + DM-фічі)`, null, req.user.id);
      return { ok: true, ownBot: username, dmReady: true };
    } catch (e: any) {
      await logEvent("warn", "tgbot", "власний бот: вебхук не зареєструвався: " + e.message, null, req.user.id);
      return { ok: true, warn: "Токен збережено, але вебхук не зареєструвався: " + String(e.message).slice(0, 150) + ". Публікація працюватиме, DM-фічі - ні." };
    }
  }
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
// threads_manage_replies: читання коментарів під власними постами + відповіді на них (реплай-коуч);
// пермішен апрувнуто в App Review - у токен потрапляє після (пере)підключення акаунта
const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_insights", "threads_manage_replies"];

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

// ===================== LINKEDIN (автопостинг, 5-та мережа) =====================
const LINKEDIN_REDIRECT = `${env.appBaseUrl}/api/integrations/linkedin/callback`;

app.get("/api/integrations/linkedin", async (req: any) => {
  const c = await one<{ display_name: string | null; token_expires_at: string | null }>(
    `select display_name, token_expires_at from linkedin_config where workspace_id=$1`, [req.user.workspace_id]);
  const expired = !!(c?.token_expires_at && new Date(c.token_expires_at).getTime() < Date.now());
  return { configured: !!env.linkedin.clientId, hasToken: !!c, name: c?.display_name ?? "", expiresAt: c?.token_expires_at ?? null, expired };
});

app.get("/api/integrations/linkedin/connect", async (req: any, reply) => {
  if (!env.linkedin.clientId) return reply.code(400).send({ error: "LINKEDIN_CLIENT_ID не заданий на сервері (чекаємо апрув застосунку LinkedIn)" });
  const state = auth.newToken();
  reply.setCookie("linkedin_state", state, stateCookie);
  await logEvent("info", "linkedin", `connect redirect_uri=${LINKEDIN_REDIRECT}`, null, req.user.id);
  return reply.redirect(linkedin.authUrl(env.linkedin.clientId, LINKEDIN_REDIRECT, state));
});

app.get("/api/integrations/linkedin/callback", async (req: any, reply) => {
  const code = String(req.query?.code ?? ""); const state = String(req.query?.state ?? "");
  const oerr = String(req.query?.error_description ?? req.query?.error ?? "");
  if (oerr) { await logEvent("error", "linkedin", `LinkedIn відмовив: ${oerr}`, { error: req.query?.error }, req.user.id); return reply.redirect("/app?linkedin=error"); }
  if (!code || !state || state !== req.cookies?.linkedin_state) { await logEvent("error", "linkedin", "callback: code/state некоректні", null, req.user.id); return reply.redirect("/app?linkedin=error"); }
  reply.clearCookie("linkedin_state", { path: "/" });
  try {
    const tok = await linkedin.exchangeCode(env.linkedin.clientId, env.linkedin.clientSecret, LINKEDIN_REDIRECT, code);
    const me = await linkedin.getMe(tok.access_token);
    const exp = new Date(Date.now() + (tok.expires_in || 60 * 86400) * 1000).toISOString();
    await q(`insert into linkedin_config(workspace_id, member_urn, display_name, access_token, token_expires_at, updated_at)
             values($1,$2,$3,$4,$5,now())
             on conflict (workspace_id) do update set member_urn=excluded.member_urn, display_name=excluded.display_name,
               access_token=excluded.access_token, token_expires_at=excluded.token_expires_at, updated_at=now()`,
      [req.user.workspace_id, `urn:li:person:${me.sub}`, me.name ?? "", tok.access_token, exp]);
    await logEvent("info", "linkedin", `підключено ${me.name || me.sub}`, null, req.user.id);
    return reply.redirect("/app?linkedin=ok");
  } catch (e: any) {
    await logEvent("error", "linkedin", "OAuth callback: " + e.message, null, req.user.id);
    return reply.redirect("/app?linkedin=error");
  }
});

app.post("/api/integrations/linkedin/disconnect", async (req: any) => {
  await q(`delete from linkedin_config where workspace_id=$1`, [req.user.workspace_id]);
  return { ok: true };
});

// ===================== YOUTUBE SHORTS (рілси; той самий Google-застосунок, що й логін/Drive) =====================
const YOUTUBE_REDIRECT = `${env.appBaseUrl}/api/integrations/youtube/callback`;

app.get("/api/integrations/youtube", async (req: any) => {
  const c = await one<{ channel_title: string | null }>(`select channel_title from youtube_config where workspace_id=$1`, [req.user.workspace_id]);
  return { configured: !!env.google.clientId, hasToken: !!c, name: c?.channel_title ?? "" };
});

app.get("/api/integrations/youtube/connect", async (req: any, reply) => {
  if (!env.google.clientId) return reply.code(400).send({ error: "Підключення YouTube тимчасово недоступне" });
  const state = auth.newToken();
  reply.setCookie("youtube_state", state, stateCookie);
  return reply.redirect(youtube.authUrl(env.google.clientId, YOUTUBE_REDIRECT, state));
});

app.get("/api/integrations/youtube/callback", async (req: any, reply) => {
  const code = String(req.query?.code ?? ""); const state = String(req.query?.state ?? "");
  if (String(req.query?.error ?? "")) { await logEvent("error", "youtube", `Google відмовив: ${req.query.error}`, null, req.user.id); return reply.redirect("/app?youtube=error"); }
  if (!code || !state || state !== req.cookies?.youtube_state) return reply.redirect("/app?youtube=error");
  reply.clearCookie("youtube_state", { path: "/" });
  try {
    const tok = await youtube.exchangeCode(env.google.clientId, env.google.clientSecret, YOUTUBE_REDIRECT, code);
    const title = await youtube.myChannelTitle(tok.access_token).catch(() => "YouTube");
    const exp = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString();
    await q(`insert into youtube_config(workspace_id, channel_title, access_token, refresh_token, token_expires_at, updated_at)
             values($1,$2,$3,$4,$5,now())
             on conflict (workspace_id) do update set channel_title=excluded.channel_title, access_token=excluded.access_token,
               refresh_token=coalesce(excluded.refresh_token, youtube_config.refresh_token), token_expires_at=excluded.token_expires_at, updated_at=now()`,
      [req.user.workspace_id, title, tok.access_token, tok.refresh_token ?? null, exp]);
    await logEvent("info", "youtube", `підключено канал ${title}`, null, req.user.id);
    return reply.redirect("/app?youtube=ok");
  } catch (e: any) {
    await logEvent("error", "youtube", "OAuth callback: " + e.message, null, req.user.id);
    return reply.redirect("/app?youtube=error");
  }
});

app.post("/api/integrations/youtube/disconnect", async (req: any) => {
  await q(`delete from youtube_config where workspace_id=$1`, [req.user.workspace_id]);
  return { ok: true };
});

// ===================== TIKTOK (рілси; до аудиту застосунку - відео їде юзеру в чернетки) =====================
const TIKTOK_REDIRECT = `${env.appBaseUrl}/api/integrations/tiktok/callback`;

app.get("/api/integrations/tiktok", async (req: any) => {
  const c = await one<{ display_name: string | null }>(`select display_name from tiktok_config where workspace_id=$1`, [req.user.workspace_id]);
  return { configured: !!env.tiktok.clientKey, hasToken: !!c, name: c?.display_name ?? "" };
});

app.get("/api/integrations/tiktok/connect", async (req: any, reply) => {
  if (!env.tiktok.clientKey) return reply.code(400).send({ error: "Підключення TikTok тимчасово недоступне" });
  const state = auth.newToken();
  reply.setCookie("tiktok_state", state, stateCookie);
  return reply.redirect(tiktok.authUrl(env.tiktok.clientKey, TIKTOK_REDIRECT, state));
});

app.get("/api/integrations/tiktok/callback", async (req: any, reply) => {
  const code = String(req.query?.code ?? ""); const state = String(req.query?.state ?? "");
  if (String(req.query?.error ?? "")) { await logEvent("error", "tiktok", `TikTok відмовив: ${req.query.error}`, null, req.user.id); return reply.redirect("/app?tiktok=error"); }
  if (!code || !state || state !== req.cookies?.tiktok_state) return reply.redirect("/app?tiktok=error");
  reply.clearCookie("tiktok_state", { path: "/" });
  try {
    const tok = await tiktok.exchangeCode(env.tiktok.clientKey, env.tiktok.clientSecret, TIKTOK_REDIRECT, code);
    const info = await tiktok.userInfo(tok.access_token).catch(() => ({ displayName: "TikTok" }));
    const exp = new Date(Date.now() + (tok.expires_in || 86400) * 1000).toISOString();
    await q(`insert into tiktok_config(workspace_id, open_id, display_name, access_token, refresh_token, token_expires_at, updated_at)
             values($1,$2,$3,$4,$5,$6,now())
             on conflict (workspace_id) do update set open_id=excluded.open_id, display_name=excluded.display_name,
               access_token=excluded.access_token, refresh_token=excluded.refresh_token, token_expires_at=excluded.token_expires_at, updated_at=now()`,
      [req.user.workspace_id, tok.open_id, info.displayName, tok.access_token, tok.refresh_token ?? null, exp]);
    await logEvent("info", "tiktok", `підключено ${info.displayName}`, null, req.user.id);
    return reply.redirect("/app?tiktok=ok");
  } catch (e: any) {
    await logEvent("error", "tiktok", "OAuth callback: " + e.message, null, req.user.id);
    return reply.redirect("/app?tiktok=error");
  }
});

app.post("/api/integrations/tiktok/disconnect", async (req: any) => {
  await q(`delete from tiktok_config where workspace_id=$1`, [req.user.workspace_id]);
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
  // origin потрібен, щоб «Переробити» для щоденника/діалогу теж ішло в режимі «з власних слів автора»
  // (інакше правка знову дописує вигадані списки й загальні висновки)
  return one<{ content: string; origin: string }>(
    `select p.content, coalesce(s.origin,'') as origin from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
}

app.put("/api/posts/:postId", async (req: any, reply) => {
  if (!(await postOwned(req.params.postId, req.user.workspace_id))) return reply.code(404).send({ error: "пост не знайдено" });
  if (typeof req.body?.content === "string") await q(`update post set content=$2 where id=$1`, [req.params.postId, req.body.content]);
  if (typeof req.body?.rubric === "string") await q(`update post set rubric=nullif($2,'') where id=$1`, [req.params.postId, req.body.rubric.slice(0, 60)]);
  if (typeof req.body?.intent === "string" && ["awareness", "nurture", "sale", ""].includes(req.body.intent))
    await q(`update post set intent=nullif($2,'') where id=$1`, [req.params.postId, req.body.intent]);
  if (typeof req.body?.format === "string" && (FORMATS as readonly string[]).includes(req.body.format))
    await q(`update post set format=$2 where id=$1`, [req.params.postId, req.body.format]);
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
    const fresh = await rewritePost(req.user.workspace_id, post.content, typeof req.body?.instruction === "string" ? req.body.instruction : undefined, post.origin);
    await q(`update post set content=$2, review=null where id=$1`, [req.params.postId, fresh]);
    return { ok: true, content: fresh };
  } catch (e: any) {
    await logEvent("error", "regenerate", e.message, null, req.user.id);
    return reply.code(500).send({ error: e.message });
  }
});

app.get("/api/usage", async (req: any) => {
  const ws = req.user.workspace_id;
  const total = await one(`select coalesce(sum(prompt_tokens),0)::int as prompt_tokens,
                     coalesce(sum(completion_tokens),0)::int as completion_tokens,
                     coalesce(sum(cost),0)::float as cost, count(*)::int as calls
              from llm_usage where workspace_id=$1`, [ws]);
  // Розріз за моделями й кроками (30 днів). Раніше ендпоінт віддавав ЛИШЕ разом за весь час, тож на
  // питання «яка модель зʼїдає гроші / скільки токенів іде на генерацію поста» відповіді не було -
  // хоча дані для неї в llm_usage лежали з першого дня.
  const byModel = await q(`select model, count(*)::int as calls,
                                  coalesce(sum(prompt_tokens),0)::int as prompt_tokens,
                                  coalesce(sum(completion_tokens),0)::int as completion_tokens,
                                  coalesce(sum(cost),0)::float as cost
                             from llm_usage where workspace_id=$1 and created_at > now() - interval '30 days'
                            group by model order by cost desc, calls desc`, [ws]);
  const byStep = await q(`select coalesce(step,'-') as step, count(*)::int as calls,
                                 coalesce(sum(prompt_tokens),0)::int as prompt_tokens,
                                 coalesce(sum(completion_tokens),0)::int as completion_tokens,
                                 coalesce(sum(cost),0)::float as cost
                            from llm_usage where workspace_id=$1 and created_at > now() - interval '30 days'
                           group by step order by cost desc, calls desc`, [ws]);
  return { ...(total || {}), byModel, byStep };
});

// ===================== 🧪 ПОРІВНЯННЯ МОДЕЛЕЙ =====================
// «Контент слабкий через модель чи через промт?» - без прогону на тому самому матеріалі це вгадування.
app.get("/api/models/catalog", async (req: any) => {
  const [cat, spend] = await Promise.all([modelCatalog(), abSpend(req.user.workspace_id)]);
  const s = await getSettingText(req.user.workspace_id, "main_model");
  return { models: cat.rows, live: cat.live, current: s.trim() || DEFAULT_MAIN_MODEL, defaultModel: DEFAULT_MAIN_MODEL, spend };
});

app.post("/api/ab/generate", async (req: any) => {
  const b = req.body ?? {};
  const ws = req.user.workspace_id;
  // 4 моделі паралельно, кожна до хвилини - синхронна відповідь тут не мала шансів пережити nginx
  return { jobId: startAiJob(ws, () => runAbTest(ws, {
    sourceId: b.sourceId, postId: b.postId, text: b.text,
    models: Array.isArray(b.models) ? b.models : [], count: b.count,
  })) };
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
const PLAN_NETS = ["telegram", "instagram", "threads", "facebook", "linkedin"];
app.post("/api/plan/generate", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  try {
    const horizon = Math.max(7, Math.min(90, Number(req.body?.horizon) || 14));
    const ppw = Math.max(1, Math.min(14, Number(req.body?.posts_per_week) || 4));
    const topic = String(req.body?.topic || "").trim().slice(0, 1000);
    const anchor = new Date(); anchor.setUTCHours(12, 0, 0, 0);
    // мережі, обрані для плану (порожньо = один спільний скелет 'all', легасі-поведінка)
    const nets: string[] = Array.isArray(req.body?.networks) ? req.body.networks.map((x: any) => String(x)).filter((x: string) => PLAN_NETS.includes(x)) : [];
    let total = 0; const byNet: Record<string, number> = {};
    const insertSlots = async (channel: string, slots: { day: number; rubric: string; theme: string; hook: string; format: string }[]) => {
      for (const sl of slots) {
        const d = new Date(anchor); d.setUTCDate(d.getUTCDate() + sl.day);
        await q(`insert into plan_slot(workspace_id, slot_date, channel, rubric, theme, hook, format) values($1,$2,$3,$4,$5,$6,$7)`,
          [ws, d.toISOString().slice(0, 10), channel, sl.rubric || null, sl.theme.slice(0, 300), sl.hook.slice(0, 300) || null, normFormat(sl.format)]);
        total++; byNet[channel] = (byNet[channel] || 0) + 1;
      }
    };
    if (nets.length) {
      // окремий скелет НА КОЖНУ мережу: свій набір тем (тон під платформу), channel=<мережа>.
      // прибираємо старі незаповнені слоти цих мереж + легасі спільні ('all'), щоб не змішувати моделі.
      await q(`delete from plan_slot where workspace_id=$1 and status in ('empty','matched') and (channel = any($2) or channel='all')`, [ws, nets]);
      for (const net of nets) {
        const slots = await buildLiteSkeleton(ws, horizon, ppw, { topic, network: net }); // кидає чітку помилку, якщо нема стратегії
        await insertSlots(net, slots);
      }
    } else {
      // легасі: ОДИН спільний скелет 'all'
      const slots = await buildLiteSkeleton(ws, horizon, ppw, { topic });
      await q(`delete from plan_slot where workspace_id=$1 and status in ('empty','matched')`, [ws]);
      await insertSlots("all", slots);
    }
    let matched = 0; try { matched = await matchPlanSlots(ws); } catch { /* метчинг не критичний */ }
    return { ok: true, slots: total, byNet, matched };
  } catch (e: any) { await logEvent("error", "plan", e.message, null, req.user.id); return reply.code(400).send({ error: e.message }); }
});

app.get("/api/plan", async (req: any) => {
  const ws = req.user.workspace_id;
  const channel = req.query?.channel ? String(req.query.channel) : null;
  const slots = await q(
    `select ps.id, ps.slot_date, ps.channel, ps.rubric, ps.theme, ps.hook, ps.status, ps.match_note, ps.post_id, ps.format, s.title as match_title
     from plan_slot ps left join source s on s.id = ps.match_source_id
     where ps.workspace_id=$1 ${channel ? "and ps.channel=$2" : ""} order by ps.slot_date`,
    channel ? [ws, channel] : [ws]);
  const [channels, realized] = await Promise.all([
    q<{ channel: string }>(`select distinct channel from plan_slot where workspace_id=$1`, [ws]),
    // ФАКТИЧНИЙ мікс форматів за 30 днів - цього не показує жоден конкурент (у них формат живе
    // або лише в аналітиці, або взагалі в ручних тегах), а дані в нас уже є
    q<{ format: string; n: number }>(
      `select p.format, count(*)::int n from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
        where s.workspace_id=$1 and p.stage='final' and coalesce(p.review,'') <> 'archived'
          and p.created_at > now() - interval '30 days' group by p.format`, [ws]),
  ]);
  const realizedMix: Record<string, number> = {};
  for (const r of realized) realizedMix[r.format || "post"] = r.n;
  return { slots, channels: channels.map((c) => c.channel), realizedMix };
});

app.post("/api/plan/match", async (req: any, reply) => {
  try { const n = await matchPlanSlots(req.user.workspace_id); return { ok: true, matched: n }; }
  catch (e: any) { return reply.code(400).send({ error: e.message }); }
});

// Згенерувати пост для слота: from='material' (зі зметченого матеріалу) або 'theme' (чиста генерація з теми)
app.post("/api/plan/slots/:id/generate", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const slot = await one<{ id: string; theme: string; hook: string | null; cta: string | null; rubric: string | null; channel: string; match_source_id: string | null; status: string; format: string }>(
    `select id, theme, hook, cta, rubric, channel, match_source_id, status, format from plan_slot where id=$1 and workspace_id=$2`, [req.params.id, ws]);
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
    // 🧪-слот (10% плану): експериментальний пост - подача, якої бренд ще не робив
    const expNote = slot.theme.startsWith("🧪") ? ". ЕКСПЕРИМЕНТ: зроби подачу, якої бренд ще не робив (інший ритм, структура, жанр чи сміливіший кут) - але голос і ДНК бренду збережи" : "";
    const idea = `${slot.theme.replace(/^🧪\s*/, "")}${slot.hook ? `. Гачок: ${slot.hook}` : ""}${slot.cta ? `. Заклик: ${slot.cta}` : ""}${expNote}`;
    await generatePostsOnePass(run!.id, 1, [idea], [slot.format]);
    const post = await one<{ id: string }>(`select id from post where run_id=$1 and stage='final' limit 1`, [run!.id]);
    if (!post) throw new Error("пост не згенерувався");
    // привʼязка пост<->слот + рубрика слота + канал слота увімкнений (тільки для реальної мережі; 'all' - без примусу каналу)
    const chanPatch = PLAN_NETS.includes(slot.channel) ? JSON.stringify({ [slot.channel]: { on: true } }) : "{}";
    await q(`update post set rubric=coalesce($2, rubric), channels=coalesce(channels,'{}'::jsonb) || $3::jsonb where id=$1`,
      [post.id, slot.rubric, chanPatch]);
    await q(`update plan_slot set status='drafted', post_id=$2 where id=$1`, [slot.id, post.id]);
    return { ok: true, postId: post.id };
  } catch (e: any) { await logEvent("error", "plan_slot", e.message, { slotId: slot.id }, req.user.id); return reply.code(500).send({ error: e.message }); }
});

// ===================== МАТЕРІАЛИ (стрічка сировини) =====================
app.get("/api/materials", async (req: any) => {
  const rows = await q(
    `select s.id, s.origin, coalesce(s.title,'') as title, left(s.transcript, 260) as preview,
            length(s.transcript) as chars, s.created_at, s.feed_id, s.ai_score, s.ai_score_why,
            cs.title as feed_title, cs.url as feed_url,
            ps.id as slot_id, ps.theme as slot_theme, ps.rubric as slot_rubric, ps.slot_date
     from source s
     left join content_source cs on cs.id = s.feed_id
     left join plan_slot ps on ps.match_source_id = s.id and ps.status='matched'
     where s.workspace_id=$1 and s.archived=false and coalesce(s.transcript,'') <> ''
     order by (s.origin='diary') desc, s.created_at desc limit 200`, [req.user.workspace_id]);
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
// Ідеї з матеріалу (для модалки вибору перед генерацією).
// «Розвідник»: режим за походженням - RSS = «Сигнал» (тейк від бренду), нотатка/ідея = «Історія» (кути кейсу).
app.post("/api/materials/:id/ideas", async (req: any, reply) => {
  const m = await one<{ transcript: string; origin: string }>(`select transcript, origin from source where id=$1 and workspace_id=$2`, [req.params.id, req.user.workspace_id]);
  if (!m) return reply.code(404).send({ error: "матеріал не знайдено" });
  try { const ideas = await extractIdeasFromText(req.user.workspace_id, m.transcript, Number(req.body?.count) || 6, Array.isArray(req.body?.rubrics) ? req.body.rubrics : undefined, ideaMode(m.origin)); return { ok: true, ideas }; }
  catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// «Сценарист»: готовий до зйомки сценарій Reels з матеріалу → чернетка в Студії
app.post("/api/materials/:id/reels", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const m = await one<{ id: string; transcript: string }>(`select id, transcript from source where id=$1 and workspace_id=$2`, [req.params.id, ws]);
  if (!m) return reply.code(404).send({ error: "матеріал не знайдено" });
  try {
    const script = await reelsScript(ws, m.transcript, Number(req.body?.targetSec) || undefined);
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [m.id]);
    const post = await one<{ id: string }>(`insert into post(run_id, stage, content, format) values($1,'final',$2,'reel') returning id`, [run!.id, script]);
    return { ok: true, postId: post!.id };
  } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// «Мультиплікатор», режим «Нарізка»: довгий транскрипт → 5-7 самостійних сценаріїв Reels (тиждень відео-контенту)
app.post("/api/materials/:id/reel-slices", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const m = await one<{ id: string; transcript: string }>(`select id, transcript from source where id=$1 and workspace_id=$2`, [req.params.id, ws]);
  if (!m) return reply.code(404).send({ error: "матеріал не знайдено" });
  if ((m.transcript || "").length < 800) return reply.code(400).send({ error: "Матеріал закороткий для нарізки - потрібен довгий транскрипт чи стаття" });
  try {
    const scripts = await sliceToReels(ws, m.transcript, Number(req.body?.targetSec) || undefined);
    if (!scripts.length) return reply.code(500).send({ error: "не вдалося нарізати сценарії" });
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [m.id]);
    for (const sc of scripts) await q(`insert into post(run_id, stage, content, format) values($1,'final',$2,'reel')`, [run!.id, sc]);
    return { ok: true, count: scripts.length };
  } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// ---- Банк ідей (workspace-scoped, окремо від run-bound idea; джерело для /idea в боті) ----
app.get("/api/ideas", async (req: any) => {
  const rows = await q(`select id, text, angle, rubric, origin, created_at from idea_bank
                        where workspace_id=$1 and status='new' order by created_at desc limit 100`, [req.user.workspace_id]);
  return { ideas: rows };
});
app.post("/api/ideas", async (req: any, reply) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return reply.code(400).send({ error: "порожня ідея" });
  const r = await one<{ id: string }>(
    `insert into idea_bank(workspace_id, text, angle, rubric, origin) values($1,$2,$3,$4,$5) returning id`,
    [req.user.workspace_id, text.slice(0, 500), String(req.body?.angle ?? "").slice(0, 300) || null,
     String(req.body?.rubric ?? "").slice(0, 60) || null, ["bot", "ai", "plan", "material"].includes(req.body?.origin) ? req.body.origin : "manual"]);
  return { ok: true, id: r!.id };
});
app.post("/api/ideas/:id/archive", async (req: any, reply) => {
  const r = await one(`update idea_bank set status='archived' where id=$1 and workspace_id=$2 returning id`, [req.params.id, req.user.workspace_id]);
  if (!r) return reply.code(404).send({ error: "ідею не знайдено" });
  return { ok: true };
});
app.post("/api/ideas/:id/post", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const it = await one<{ text: string }>(`select text from idea_bank where id=$1 and workspace_id=$2 and status <> 'archived'`, [req.params.id, ws]);
  if (!it) return reply.code(404).send({ error: "ідею не знайдено" });
  try {
    const src = await one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,'idea',$2,$3) returning id`,
      [ws, it.text.slice(0, 200), `Ідея поста: ${it.text}`]);
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
    await generatePostsOnePass(run!.id, 1, [it.text], [normFormat(req.body?.format)]);
    const post = await one<{ id: string }>(`select id from post where run_id=$1 and stage='final' limit 1`, [run!.id]);
    await q(`update idea_bank set status='used', used_post_id=$2 where id=$1 and workspace_id=$3`, [req.params.id, post?.id ?? null, ws]);
    return { ok: true, count: 1 };
  } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});
// Створити пости з матеріалу (всі обрані ідеї, або 1 пост без ідей)
app.post("/api/materials/:id/posts", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  const m = await one<{ id: string }>(`select id from source where id=$1 and workspace_id=$2`, [req.params.id, ws]);
  if (!m) return reply.code(404).send({ error: "матеріал не знайдено" });
  try {
    const ideas = Array.isArray(req.body?.ideas) ? req.body.ideas.map((x: any) => String(x).trim()).filter(Boolean) : [];
    // формати на кожну обрану ідею (Розвідник уже радить формат - тепер він доїжджає до поста)
    const fmts = Array.isArray(req.body?.formats) ? req.body.formats.map((x: any) => normFormat(x)) : undefined;
    const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [m.id]);
    const count = await generatePostsOnePass(run!.id, ideas.length || 1, ideas.length ? ideas : undefined, fmts);
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
  const [tg, th, mt, gd, trc, src, med, posts, appr, sched, pub, strat, li, planN, botOwner] = await Promise.all([
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
    one<any>(`select access_token from linkedin_config where workspace_id=$1`, [ws]),
    one<{ n: number }>(`select count(*)::int n from plan_slot where workspace_id=$1`, [ws]),
    one<{ n: number }>(`select count(*)::int n from tg_owner where workspace_id=$1`, [ws]),
  ]);
  const tgOn = !!(tg && tg.bot_token && (tg.channel_chat_id || tg.group_chat_id));
  const igfbOn = !!(mt && mt.page_token);
  const thOn = !!(th && th.access_token);
  const liOn = !!(li && li.access_token);
  const chanCnt = [tgOn, igfbOn, thOn, liOn].filter(Boolean).length;
  // Навчальний шлях = реальний воркфлоу продукту: бренд+позиціонування → стратегія+план →
  // канали+бот → контент → публікація. Порядок у модалці задає order в openTasksModal.
  const tasks = [
    { id: "brand", section: "brand", points: 15, label: "Заповнити Базу бренду (ніша й аудиторія)", done: !!S.marketing_context },
    { id: "voice", section: "brand", points: 10, label: "Налаштувати голос бренду", done: !!S.tone_of_voice },
    { id: "pains", section: "strategy", points: 10, label: "Заповнити болі клієнта і тезу «Х для Y» (рушій генерації)", done: !!(S.pain_points || S.brand_thesis) },
    { id: "goal", section: "strategy", points: 5, label: "Обрати головну ціль контенту", done: !!S.primary_goal },
    { id: "strategy", section: "strategy", points: 5, label: "Згенерувати стратегію (рубрики й ритм)", done: !!(strat && strat.data && Object.keys(strat.data).length) },
    { id: "plan", section: "publish", points: 10, label: "Згенерувати контент-план (теми наперед)", done: (planN?.n || 0) > 0 },
    { id: "chan1", section: "settings", points: 15, label: "Підключити перший канал публікації", done: chanCnt >= 1 },
    { id: "chan2", section: "settings", points: 5, label: "Підключити другий канал (той самий пост - ширше охоплення)", done: chanCnt >= 2 },
    { id: "bot", section: "settings", points: 10, label: "Підключити бот-асистент у Telegram (ідеї, щоденник, дайджест)", done: (botOwner?.n || 0) > 0 },
    { id: "source", section: "sources", points: 5, label: "Додати джерело контенту (тема новин, Telegram-канал, RSS)", done: (src?.n || 0) > 0 },
    { id: "media", section: "sources", points: 5, label: "Завантажити або згенерувати фото", done: (med?.n || 0) > 0 },
    { id: "gen10", section: "create", points: 10, label: "Згенерувати перші 10 постів", done: (posts?.n || 0) >= 10 },
    { id: "approve", section: "create", points: 5, label: "Затвердити перший пост", done: (appr?.n || 0) > 0 },
    { id: "schedule", section: "publish", points: 5, label: "Запланувати пост у календарі (AI-розподіл)", done: (sched?.n || 0) > 0 },
    { id: "publish", section: "publish", points: 10, label: "Зробити першу публікацію", done: Number(pub?.n || 0) > 0 },
    { id: "transcriber", section: "settings", points: 5, label: "Інструменти: підключити транскрибатор (Fireflies)", done: !!(trc && trc.api_key) },
    { id: "gdrive", section: "sources", points: 5, label: "Інструменти: підключити Google Drive (банк фото)", done: !!(gd && gd.refresh_token) },
    { id: "plans", section: "settings", points: 5, label: "Ознайомитися з тарифами", done: S.seen_plans === "1" },
  ];
  const total = tasks.reduce((a, t) => a + t.points, 0);
  const got = tasks.filter((t) => t.done).reduce((a, t) => a + t.points, 0);
  // 🩺 стан контексту поруч із відсотком налаштування: детермінований шар безкоштовний, тож
  // проблеми видно ЗАВЖДИ, а не лише коли людина здогадається натиснути перевірку
  let context = { critical: 0, total: 0 };
  try { context = await contextIssueCount(ws); } catch { /* не критично для екрана задач */ }
  return { score: Math.round((got / total) * 100), points: got, total, tasks, context };
});

// позначити задачу-прапорець виконаною (напр. «Ознайомитися з тарифами»)
app.post("/api/tasks/ack", async (req: any, reply) => {
  const key = String(req.body?.key ?? "");
  if (!["seen_plans"].includes(key)) return reply.code(400).send({ error: "невідома задача" });
  await q(`insert into settings_block(workspace_id,key,content) values($1,$2,'1') on conflict (workspace_id,key) do update set content='1', updated_at=now()`, [req.user.workspace_id, key]);
  return { ok: true };
});

app.get("/api/bank", async (req: any) => {
  // sent: пост УЖЕ поїхав хоч в одну мережу - потрібно для перемикача «Опубліковані» в банку
  // (раніше опубліковані просто тьмяніли разом із тими, що вже в календарі, і їх не було як розділити)
  return q(`select p.id, p.content, p.review, p.created_at, src.title as source_title,
                   exists(
                     select 1 from telegram_publish t where t.post_id=p.id and t.status='sent'
                     union all select 1 from threads_publish t where t.post_id=p.id and t.status='sent'
                     union all select 1 from meta_publish t where t.post_id=p.id and t.status='sent'
                     union all select 1 from linkedin_publish t where t.post_id=p.id and t.status='sent'
                   ) as sent
            from post p join pipeline_run r on r.id=p.run_id join source src on src.id=r.source_id
            where src.workspace_id=$1 and p.stage='final' and p.review='approved'
            order by p.created_at desc`, [req.user.workspace_id]);
});

// усі фінальні пости воркспейсу (Студія/Інбокс - глобальний список, НЕ привʼязаний до активного джерела)
// + sent: у які мережі пост УЖЕ опубліковано (іконки на картці + фільтр «Опубліковані»)
app.get("/api/posts/studio", async (req: any) => {
  const rows = await q<any>(`select p.id, p.content, p.review, p.channels, p.rubric, p.intent, p.reel_video, p.format, p.qa, src.origin as source_origin, ma.filename as media_filename, p.created_at, src.title as source_title
            from post p join pipeline_run r on r.id=p.run_id join source src on src.id=r.source_id
            left join media_asset ma on ma.id=p.media_id
            where src.workspace_id=$1 and p.stage='final' and (p.review is null or p.review <> 'archived')
            order by p.created_at desc`, [req.user.workspace_id]);
  const ids = rows.map((r: any) => r.id);
  const sentMap = new Map<string, string[]>();
  // 🔗 links[postId][мережа] = URL опублікованого поста: іконки мереж на картці стають клікабельними
  const linkMap = new Map<string, Record<string, string>>();
  const add = (pid: string, net: string, link?: string | null) => {
    const a = sentMap.get(pid) || []; if (!a.includes(net)) a.push(net); sentMap.set(pid, a);
    if (link) { const l = linkMap.get(pid) || {}; if (!l[net]) l[net] = link; linkMap.set(pid, l); }
  };
  if (ids.length) {
    const [tg, th, mt, li, yt, tt] = await Promise.all([
      q<{ post_id: string; permalink: string | null }>(`select distinct post_id, permalink from telegram_publish where status='sent' and post_id=any($1)`, [ids]),
      q<{ post_id: string; permalink: string | null }>(`select distinct post_id, permalink from threads_publish where status='sent' and post_id=any($1)`, [ids]),
      q<{ post_id: string; channel: string; permalink: string | null }>(`select distinct post_id, channel, permalink from meta_publish where status='sent' and post_id=any($1)`, [ids]),
      q<{ post_id: string; permalink: string | null }>(`select distinct post_id, permalink from linkedin_publish where status='sent' and post_id=any($1)`, [ids]),
      q<{ post_id: string }>(`select distinct post_id from youtube_publish where status='sent' and post_id=any($1)`, [ids]),
      q<{ post_id: string }>(`select distinct post_id from tiktok_publish where status='sent' and post_id=any($1)`, [ids]),
    ]);
    tg.forEach((r) => add(r.post_id, "telegram", r.permalink)); th.forEach((r) => add(r.post_id, "threads", r.permalink));
    mt.forEach((r) => r.channel && add(r.post_id, r.channel, r.permalink)); li.forEach((r) => add(r.post_id, "linkedin", r.permalink));
    yt.forEach((r) => add(r.post_id, "youtube")); tt.forEach((r) => add(r.post_id, "tiktok"));
  }
  return rows.map((r: any) => ({ ...r, sent: sentMap.get(r.id) || [], links: linkMap.get(r.id) || {} }));
});

// видалення поста (замінило архів у UI): опублікованим - відмова, інакше зникла б історія
// публікацій і метрики аналітики (усі *_publish та post_metric каскадяться від post)
app.delete("/api/posts/:postId", async (req: any, reply) => {
  const ws = req.user.workspace_id;
  if (!(await postOwned(req.params.postId, ws))) return reply.code(404).send({ error: "пост не знайдено" });
  const sent = new Set([...(await alreadySentNetworks(req.params.postId)), ...(await reelSentNetworks(req.params.postId))]);
  if (sent.size) return reply.code(409).send({ error: "Пост уже опубліковано (" + [...sent].join(", ") + ") - видалення стерло б історію публікацій і аналітику. Він живе у фільтрі «Опубліковані»." });
  await q(`delete from post where id=$1`, [req.params.postId]);
  return { ok: true };
});

app.get("/api/schedule", async (req: any) => {
  return q(`select ss.id, ss.scheduled_at, ss.status, ss.result, p.id as post_id, p.content, coalesce(ss.channels, p.channels) as channels
            from schedule_slot ss
              left join plan_item pi on pi.id=ss.plan_item_id
              join post p on p.id = coalesce(ss.post_id, pi.post_id)
              join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where s.workspace_id=$1 order by ss.scheduled_at`, [req.user.workspace_id]);
});

// реально опубліковані пости (ручні + планові) з усіх мереж - для Аналітики
app.get("/api/published", async (req: any) => {
  const ws = req.user.workspace_id;
  // permalink їде в тому ж union - «Останні публікації» стають клікабельними без окремого запиту
  const recent = await q<{ post_id: string; net: string; created_at: string; content: string; permalink: string | null }>(
    `select x.post_id, x.net, x.created_at, x.permalink, p.content from (
        select post_id, 'telegram'::text as net, created_at, permalink from telegram_publish where status='sent'
        union all select post_id, 'threads', created_at, permalink from threads_publish where status='sent'
        union all select post_id, channel, created_at, permalink from meta_publish where status='sent'
        union all select post_id, 'linkedin', created_at, permalink from linkedin_publish where status='sent'
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
  const units = await q<{ id: string; channels: any; rubric: string | null }>(
    `select p.id, p.channels, p.rubric from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
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
  // 3.4) ритм каналів (спадкування «як у бренду»): мережа з власним ритмом отримує ОКРЕМИЙ слот
  // на свій день/час (+фільтр рубрик); решта мереж їдуть спільним слотом, як раніше.
  let rhythm: Record<string, { days?: number[]; time?: string; times?: string[]; rubrics?: string[] }> = {};
  try {
    const rr = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='channel_rhythm'`, [ws]);
    rhythm = JSON.parse(rr?.content || "{}") || {};
  } catch { rhythm = {}; }
  const hasCustom = (n: string) => { const r = rhythm[n]; return !!(r && ((r.days && r.days.length) || r.time || (r.times && r.times.length) || (r.rubrics && r.rubrics.length))); };
  const rhIdx: Record<string, number> = {}; // кілька часів мережі → ротація між ПОСТАМИ (2-3 слоти/день у Threads)
  let count = 0;
  // розкласти один пост від базової дати (Y,Mo,D): спільний слот для мереж-спадкоємців + окремі за ритмами
  const placePost = async (u: { id: string; channels: any; rubric: string | null }, Y: number, Mo: number, D: number, baseTime: string): Promise<void> => {
    const ch = u.channels && Object.keys(u.channels).length ? u.channels : { telegram: { on: true } };
    const nets = Object.keys(ch).filter((k) => ch[k] && ch[k].on);
    const custom = nets.filter(hasCustom);
    const inherit = nets.filter((n) => !custom.includes(n));
    const futureOr10m = (d: Date) => (d.getTime() > Date.now() ? d : new Date(Date.now() + 10 * 60 * 1000));
    const [bh, bm] = baseTime.split(":").map(Number);
    if (inherit.length || !custom.length) {
      // channels=null коли підмножина = всі мережі поста (легасі-поведінка, нічого не змінюється)
      const subset = custom.length ? JSON.stringify(Object.fromEntries(inherit.map((n) => [n, { on: true }]))) : null;
      const dd = futureOr10m(zonedToUTC(Y, Mo, D, bh, bm, tz));
      await q(`insert into schedule_slot(post_id, scheduled_at, status, channels) values($1,$2,'planned',$3)`, [u.id, dd.toISOString(), subset]);
      count++;
    }
    for (const n of custom) {
      const r = rhythm[n] || {};
      // фільтр рубрик: ця мережа бере лише свої рубрики (пост без рубрики проходить завжди)
      if (r.rubrics && r.rubrics.length && u.rubric && !r.rubrics.map((x) => String(x).toLowerCase()).includes(String(u.rubric).toLowerCase())) continue;
      // найближчий дозволений день ритму, починаючи з базової дати
      const base = new Date(Date.UTC(Y, Mo - 1, D, 12));
      let dTgt = base;
      if (r.days && r.days.length) {
        for (let off = 0; off < 7; off++) { const c = new Date(base); c.setUTCDate(c.getUTCDate() + off); if (r.days.includes(c.getUTCDay())) { dTgt = c; break; } }
      }
      const okT = (x: any) => /^\d{1,2}:\d{2}$/.test(String(x || ""));
      const listT = (Array.isArray(r.times) ? r.times.filter(okT).map(String) : []);
      if (!listT.length && okT(r.time)) listT.push(String(r.time));
      const t = listT.length ? listT[(rhIdx[n] || 0) % listT.length] : baseTime;
      rhIdx[n] = (rhIdx[n] || 0) + 1;
      const [h, m] = t.split(":").map(Number);
      const dd = futureOr10m(zonedToUTC(dTgt.getUTCFullYear(), dTgt.getUTCMonth() + 1, dTgt.getUTCDate(), h, m, tz));
      await q(`insert into schedule_slot(post_id, scheduled_at, status, channels) values($1,$2,'planned',$3)`,
        [u.id, dd.toISOString(), JSON.stringify({ [n]: { on: true } })]);
      count++;
    }
  };
  // 3.5) пости, привʼязані до слотів ПЛАНУ, стають САМЕ на дату свого слота (перший час зі стратегії)
  let rest = units;
  if (units.length) {
    const withSlot = await q<{ post_id: string; slot_date: string }>(
      `select post_id, slot_date::text as slot_date from plan_slot
       where workspace_id=$1 and post_id = any($2) and status in ('drafted','approved','scheduled')`,
      [ws, units.map((u) => u.id)]);
    const slotByPost = new Map(withSlot.map((r) => [r.post_id, r.slot_date]));
    for (const u of units.filter((x) => slotByPost.has(x.id))) {
      const [Y, Mo, D] = String(slotByPost.get(u.id)).slice(0, 10).split("-").map(Number);
      await placePost(u, Y, Mo, D, times[0]);
      await q(`update plan_slot set status='scheduled' where post_id=$1 and status in ('drafted','approved')`, [u.id]);
    }
    rest = units.filter((x) => !slotByPost.has(x.id));
  }
  // 4) РІВНОМІРНИЙ розподіл: спершу ПО ОДНОМУ посту на кожен дозволений день горизонту,
  //    і лише коли днів забракло - друге коло (2-й пост/день з іншим часом). Так 9 постів
  //    лягають на 9 різних днів, а не стосом 6 в один день, коли best_days вузькі, а часів багато.
  const tzToday = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-").map(Number);
  const cursor = new Date(Date.UTC(tzToday[0], tzToday[1] - 1, tzToday[2], 12, 0, 0)); // календарний курсор (полудень UTC, без DST-стрибків)
  const dayDates: { Y: number; Mo: number; D: number }[] = [];
  for (let off = 1; off <= 120 && dayDates.length < Math.max(rest.length, 1); off++) {
    const c = new Date(cursor); c.setUTCDate(c.getUTCDate() + off);
    if (bestDays.length && !bestDays.includes(c.getUTCDay())) continue;
    dayDates.push({ Y: c.getUTCFullYear(), Mo: c.getUTCMonth() + 1, D: c.getUTCDate() });
  }
  for (let idx = 0; idx < rest.length && dayDates.length; idx++) {
    const day = dayDates[idx % dayDates.length];
    const pass = Math.floor(idx / dayDates.length); // 0 = перший пост дня, 1 = другий тощо
    await placePost(rest[idx], day.Y, day.Mo, day.D, times[pass % times.length]);
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
// вебхук Telegram-ботів (auth-exempt; секрет у шляху + у заголовку).
// Без ?bot= - спільний бот. З ?bot=<id> - ВЛАСНИЙ бот воркспейсу (токен шукаємо за префіксом id:
// токени Telegram мають формат "<botId>:<hash>") - усі DM-фічі працюють через нього.
app.post("/api/webhooks/telegram/:secret", async (req: any, reply) => {
  if (req.params.secret !== env.telegram.webhookSecret) return reply.code(404).send({ error: "not found" });
  const hdr = req.headers["x-telegram-bot-api-secret-token"];
  if (hdr && hdr !== env.telegram.webhookSecret) return reply.code(403).send({ error: "bad secret" });
  const botId = String(req.query?.bot || "").replace(/\D/g, "");
  if (botId) {
    const own = await one<{ bot_token: string }>(
      `select bot_token from telegram_config where bot_token like $1 limit 1`, [`${botId}:%`]);
    if (!own) return { ok: true, ignored: true }; // бот відв'язаний - апдейт нікому обробляти
    handleUpdate(req.body, own.bot_token).catch(() => {});
    return { ok: true };
  }
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

// ===================== 📱 TELEGRAM MINI APP =====================
// Сторінка відкривається ВСЕРЕДИНІ Telegram, де нашої кукі-сесії немає. Автентифікація - через
// підписаний `initData` (див. tgauth.ts), а воркспейс береться з tg_owner: той самий звʼязок
// «цей телеграм-юзер = цей кабінет», що вже закріплюється при підключенні бота.
// Тому ці роути свідомо ЗВІЛЬНЕНІ від кукі-хука (їхня перевірка не слабша, а інша).
async function tgUser(req: any): Promise<{ ws: string; tgId: number } | null> {
  const initData = String(req.headers["x-tg-init-data"] || req.body?.initData || "");
  if (!initData) return null;
  // спільний бот або власний бот воркспейсу: перевіряємо обома токенами, які реально можуть підписати
  const tokens = [env.telegram.botToken, ...(await q<{ bot_token: string }>(`select distinct bot_token from telegram_config where bot_token is not null`)).map((r) => r.bot_token)];
  for (const t of tokens) {
    if (!t) continue;
    const u = verifyInitData(initData, t);
    if (!u) continue;
    const own = await one<{ workspace_id: string }>(`select workspace_id from tg_owner where tg_user_id=$1`, [u.id]);
    if (own) return { ws: own.workspace_id, tgId: u.id };
    return null; // підпис валідний, але кабінет не привʼязаний
  }
  return null;
}
const tgGuard = async (req: any, reply: any) => {
  const u = await tgUser(req);
  if (!u) { reply.code(401).send({ error: "Відкрий застосунок кнопкою в боті (підпис Telegram недійсний або кабінет не підключено)" }); return null; }
  return u;
};

app.get("/api/tg/me", async (req: any, reply) => {
  const u = await tgGuard(req, reply); if (!u) return;
  const [drafts, mats, nets] = await Promise.all([
    one<{ c: string }>(`select count(*)::text c from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
                        where s.workspace_id=$1 and p.stage='final' and (p.review is null or p.review<>'archived')`, [u.ws]),
    one<{ c: string }>(`select count(*)::text c from source where workspace_id=$1 and archived=false`, [u.ws]),
    connectedNets(u.ws),
  ]);
  return { ok: true, drafts: +(drafts?.c || 0), materials: +(mats?.c || 0), nets };
});

// 📥 джерела/матеріали: свіже зверху, коротким тілом (у телефоні довгі полотна ніхто не читає)
app.get("/api/tg/materials", async (req: any, reply) => {
  const u = await tgGuard(req, reply); if (!u) return;
  const rows = await q<{ id: string; title: string; origin: string; created_at: string; transcript: string; ai_score: number | null }>(
    `select id, coalesce(title,'(без назви)') as title, origin, created_at, left(coalesce(transcript,''), 240) as transcript, ai_score
       from source where workspace_id=$1 and archived=false
     order by (origin='diary') desc, created_at desc limit 30`, [u.ws]);
  return { items: rows };
});

// 📝 чорновики: те саме, що Студія, але лише найпотрібніше
app.get("/api/tg/drafts", async (req: any, reply) => {
  const u = await tgGuard(req, reply); if (!u) return;
  const rows = await q<{ id: string; content: string; review: string | null; channels: any; created_at: string }>(
    `select p.id, p.content, p.review, p.channels, p.created_at from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 and p.stage='final' and (p.review is null or p.review<>'archived')
     order by p.created_at desc limit 30`, [u.ws]);
  const ids = rows.map((r) => r.id);
  const sent = new Set<string>();
  if (ids.length) {
    const rs = await q<{ post_id: string }>(
      `select post_id from telegram_publish where status='sent' and post_id=any($1)
       union select post_id from threads_publish where status='sent' and post_id=any($1)
       union select post_id from meta_publish where status='sent' and post_id=any($1)
       union select post_id from linkedin_publish where status='sent' and post_id=any($1)`, [ids]);
    rs.forEach((r) => sent.add(r.post_id));
  }
  return { items: rows.map((r) => ({ ...r, sent: sent.has(r.id) })) };
});

// ✍️ створити пост із власного тексту (той самий шлях, що й у боті)
app.post("/api/tg/post", async (req: any, reply) => {
  const u = await tgGuard(req, reply); if (!u) return;
  const text = String(req.body?.text ?? "").trim();
  if (text.length < 3) return reply.code(400).send({ error: "Порожній текст" });
  const id = await createBotDraft(u.ws, text.slice(0, 8000));
  return { ok: true, id };
});

// вибір мереж + текст існуючої чернетки
app.put("/api/tg/post/:postId", async (req: any, reply) => {
  const u = await tgGuard(req, reply); if (!u) return;
  const own = await one<{ id: string }>(
    `select p.id from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where p.id=$1 and s.workspace_id=$2`, [req.params.postId, u.ws]);
  if (!own) return reply.code(404).send({ error: "пост не знайдено" });
  if (typeof req.body?.text === "string" && req.body.text.trim())
    await q(`update post set content=$2 where id=$1`, [own.id, String(req.body.text).slice(0, 8000)]);
  if (req.body?.channels && typeof req.body.channels === "object")
    await q(`update post set channels=$2 where id=$1`, [own.id, JSON.stringify(req.body.channels)]);
  return { ok: true };
});

// 🚀 публікація: та сама точка, що й кабінет/бот - дедуп і permalink працюють однаково
// Mini App ходить через той самий nginx, тож має ту саму 504-експозицію, що й кабінет - публікуємо
// теж джобою. Клієнт полить `/api/tg/post/:id/publish-job`.
app.post("/api/tg/post/:postId/publish", async (req: any, reply) => {
  const u = await tgGuard(req, reply); if (!u) return;
  const job = startPublishJob(req.params.postId, async () => ({ message: await publishNow(u.ws, req.params.postId) }));
  return { started: true, status: job.status };
});

app.get("/api/tg/post/:postId/publish-job", async (req: any, reply) => {
  const u = await tgGuard(req, reply); if (!u) return;
  const j = publishJobs.get(req.params.postId);
  return j ? { status: j.status, message: j.message, error: j.error } : { status: "idle" };
});

// ===================== СТОРІНКИ =====================
app.get("/tgapp", (_req, reply) => reply.sendFile("tgapp.html"));
// 🧹 КЕШ-БАСТИНГ. `app.html` тягне `/app.js` без версії, тож браузер міг тримати СТАРИЙ файл після
// деплою - і людина не бачила щойно випущених змін («не бачу цієї кнопки», хоча вона вже є).
// Підставляємо в тег версію, обчислену з вмісту файлу: змінився файл - змінився URL.
let appHtmlCached = "";
function appHtml(): string {
  if (appHtmlCached) return appHtmlCached;
  const dir = join(__dirname, "..", "public");
  const js = readFileSync(join(dir, "app.js"));
  const v = createHash("sha1").update(js).digest("hex").slice(0, 10);
  appHtmlCached = readFileSync(join(dir, "app.html"), "utf8").replace('src="/app.js"', `src="/app.js?v=${v}"`);
  return appHtmlCached;
}
app.get("/app", (_req, reply) => reply.type("text/html; charset=utf-8").send(appHtml()));
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
  startDigest();
  startMetrics();
  startDiary();
  startThreadsAuto();
  initTelegramBot();
  // одноразово полагодити залишкові iPhone HEIF -> JPEG (у фоні; ідемпотентно)
  convertAllHeif().then((n) => { if (n) app.log.info(`HEIF→JPEG конвертовано: ${n}`); }).catch((e: any) => app.log.error("convertAllHeif: " + e.message));
});
