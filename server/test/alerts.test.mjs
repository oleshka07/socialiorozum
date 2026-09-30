// 🔔 Сповіщення про збої: правила на СПРАВЖНІХ рядках журналу прода й беті (30.09) - що з них будить
// адміна одразу, що лише коли повторюється, а що йде в денний звіт.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, providerOf, normMsg, maskSecrets, buddyUrl, dueToNotify, digestText, hintFor } from "../dist/alerts-plan.js";

test("кошти закінчились - одразу, критично, один відбиток на провайдера", () => {
  const a = classify("error", "threads-auto", 'тейки: OpenRouter 402: {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 1500 tokens, but can only afford 3"}}');
  assert.equal(a.kind, "ai_funds"); assert.equal(a.notify, "now"); assert.equal(a.severity, "critical"); assert.equal(a.provider, "OpenRouter");
  const b = classify("error", "threads-auto", "тейки: На рахунку провайдера моделі (OpenRouter) закінчились кошти - обери іншу модель в Інструментах («Головна модель») або поповни рахунок. (на сьогодні спроби вичерпано)");
  assert.equal(b.fp, a.fp, "різні слова - та сама проблема");
  const c = classify("error", "autopilot", 'вебхук-автопілот: OpenAI 429: {\n "error": {\n "message": "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/"');
  assert.equal(c.kind, "ai_funds"); assert.equal(c.provider, "OpenAI");
  const d = classify("error", "mcp", 'generate_image: fal 403: {"detail":"User is locked. Reason: TOP_UP."}');
  assert.equal(d.kind, "ai_funds"); assert.equal(d.provider, "fal.ai");
  const e = classify("warn", "job", "ai: На рахунку FLUX.1 schnell (fal.ai) скінчились кошти або квота: провайдер не приймає запити до поповнення.");
  assert.equal(e.fp, d.fp);
  // запасний маршрут підхопив - сповістити, але як попередження
  const f = classify("warn", "llm", "OpenRouter: закінчились кошти - запасний маршрут openai/gpt-4o (OpenAI) на 10 хв. На рахунку провайдера моделі (OpenRouter) закінчились кошти");
  assert.equal(f.fp, a.fp); assert.equal(f.severity, "warning"); assert.equal(f.notify, "now");
});

test("«модель тимчасово недоступна» - лише коли повторюється, не плутати з коштами", () => {
  const a = classify("error", "threads-auto", "тейки: Модель тимчасово недоступна (OpenAI 429) - спробуй за хвилину. Якщо повторюється - вичерпано квоту провайдера.");
  assert.equal(a.kind, "ai_unavailable"); assert.equal(a.notify, "burst"); assert.equal(a.burst, 5); assert.equal(a.provider, "OpenAI");
  const b = classify("warn", "post_digest", "не вдалось дистилювати пост: Модель тимчасово недоступна (OpenAI 429) - спробуй за хвилину. Якщо повторюється - вичерпано квоту провайдера.");
  assert.equal(b.fp, a.fp);
});

test("ключі: Deepgram і Azure - попередження одразу, основні моделі й пошта - критично", () => {
  const a = classify("warn", "stt", "deepgram не впорався (Deepgram: ключ не прийнято - перевір його в Налаштування → Профіль → Ключі провайдерів) - слова для субтитрів через whisper");
  assert.equal(a.kind, "ai_key"); assert.equal(a.provider, "Deepgram"); assert.equal(a.severity, "warning"); assert.equal(a.notify, "now");
  const b = classify("warn", "job", "montage: Azure Speech: ключ не прийнято - перевір AZURE_SPEECH_KEY і регіон");
  assert.equal(b.provider, "Azure Speech"); assert.equal(b.kind, "ai_key");
  assert.equal(classify("warn", "montage", "Azure Speech: ключ не прийнято - перевір AZURE_SPEECH_KEY і регіон").fp, b.fp);
  const c = classify("error", "pipeline", "OpenRouter: ключ не прийнято (HTTP 401) - перевір його в Налаштування → Профіль → Ключі провайдерів.");
  assert.equal(c.severity, "critical");
  const m = classify("error", "email", "verify-лист НЕ надіслано (a@b.cz): Resend 403: The domain is not verified");
  assert.equal(m.kind, "email_send"); assert.equal(m.severity, "critical");
  assert.equal(classify("error", "email", "verify-лист НЕ надіслано (x@y.ua): Resend 403: The domain is not verified").fp, m.fp, "пошта людини не робить нову проблему");
});

test("проблеми людей (їхні канали, токени, OAuth) - у денний звіт, не будять адміна", () => {
  const cases = [
    ["error", "digest", "Telegram: Not Found", "user_tg"],
    ["error", "diary", "Telegram не впізнав бота (404): токен бота недійсний - встав його заново в Налаштування → Канали. (на сьогодні спроби вичерпано)", "user_tg"],
    ["warn", "tgbot", "власний бот: перевірка вебхука не вдалась: Telegram не впізнав бота (404): токен бота недійсний", "user_tg"],
    ["warn", "autopost", "slot 1d2e3f4a-0000-4000-8000-000000000000 не опубліковано: threads: Threads не підключено", "user_publish"],
    ["warn", "autopost", "slot 9f9f9f9f-0000-4000-8000-000000000000 не опубліковано: telegram: Канал не знайдено - перевір підключення каналу в Налаштування → Канали.", "user_publish"],
    ["warn", "comment", "Threads: перший коментар не вийшов: The requested resource does not exist", "user_publish"],
    ["error", "threads", "OAuth callback: This action requires the threads_basic permission. You must submit for app review, or your user must be in the list of Threads testers", "user_oauth"],
    ["error", "meta", "state mismatch - cookie є але != state", "user_oauth"],
    ["warn", "rss", "http://rsshub:1200/threads/laba.ua: RSS timeout 20s", "sources"],
    ["warn", "brief", "стратегічний бриф не збігається з описом бренду - у генерацію не йде (треба перегенерувати)", "user_brief"],
  ];
  for (const [lv, sc, m, kind] of cases) {
    const v = classify(lv, sc, m);
    assert.equal(v.kind, kind, m);
    assert.equal(v.notify, "digest", m);
    assert.equal(v.group, "users", m);
  }
  // однакова причина з різними id слотів - одна група у звіті
  assert.equal(classify("warn", "autopost", "slot aaaaaaaa-0000-4000-8000-000000000000 не опубліковано: threads: Threads не підключено").fp,
    classify("warn", "autopost", "slot bbbbbbbb-1111-4111-8111-111111111111 не опубліковано: threads: Threads не підключено").fp);
});

test("адреса повернення OAuth - налаштування адміна, одразу", () => {
  const v = classify("error", "meta", "Meta відмовив: URL Blocked: This redirect failed because the redirect URI is not whitelisted in the app’s Client OAuth Settings.");
  assert.equal(v.kind, "oauth_config"); assert.equal(v.notify, "now"); assert.equal(v.group, "service");
  assert.equal(classify("error", "threads", "Threads відмовив: URL Blocked: redirect uri is not whitelisted").title, "Threads: адресу повернення не прийнято");
});

test("сервер, процес, база, невдалі входи, шум", () => {
  const h = classify("error", "http", "POST /api/posts/:id/publish-all: Cannot read properties of undefined (reading 'x')");
  assert.equal(h.kind, "server"); assert.equal(h.notify, "burst"); assert.equal(h.burst, 3);
  assert.match(h.title, /POST \/api\/posts\/:id\/publish-all/);
  assert.equal(classify("error", "process", "unhandledRejection: TypeError: x is not a function").notify, "now");
  const db = classify("error", "http", 'GET /api/today: relation "plan_slot" does not exist');
  assert.equal(db.kind, "db"); assert.equal(db.severity, "critical");
  const au = classify("warn", "auth", "невдалий вхід: someone@example.com");
  assert.equal(au.kind, "auth_fail"); assert.equal(au.burst, 30); assert.equal(au.fp, classify("warn", "auth", "невдалий вхід: other@x.io").fp);
  assert.equal(classify("info", "autopost", "slot x → telegram").notify, "none");
  assert.equal(classify("error", "alerts", "не вдалось").notify, "none", "власні збої сповіщень - не коло");
  const other = classify("error", "lifecycle", "tick: boom 42");
  assert.equal(other.notify, "burst"); assert.equal(other.fp, classify("error", "lifecycle", "tick: boom 43").fp);
  assert.equal(classify("warn", "publish", "авто-адаптація не вдалась (їде майстер-текст): у відповіді немає JSON-обʼєкта").notify, "digest");
});

test("providerOf: хто згаданий ПЕРШИМ (запасний маршрут у тексті не плутає)", () => {
  assert.equal(providerOf("OpenAI: закінчились кошти - запасний маршрут openai/gpt-4o (OpenRouter)"), "OpenAI");
  assert.equal(providerOf("OpenRouter 402: model openai/gpt-4o"), "OpenRouter");
  assert.equal(providerOf("ElevenLabs не впорався (x) - озвучено Azure"), "ElevenLabs");
  assert.equal(providerOf("deepgram не впорався - розшифровано через whisper"), "Deepgram");
  assert.equal(providerOf("щось зовсім інше"), "");
});

test("normMsg і maskSecrets: відбиток без id/чисел, у повідомлення - без токенів", () => {
  assert.equal(normMsg("slot 1a2b3c4d-1111-4111-8111-111111111111 у 12:30 ×5 для a@b.cz https://x.y/z"), "slot <id> у #:# ×# для <email> <url>");
  const m = maskSecrets("bot 123456789:AAFAKEfakeFAKEfakeFAKEfakeFAKEfake12 key sk-proj-abcdefghijklmnop url /mcp/" + "a".repeat(64) + " ?key=SECRET&x=1");
  assert.ok(!/AAHdq|abcdefghij|SECRET|aaaaaaaaaaaa/.test(m), m);
  assert.match(m, /<token>/); assert.match(m, /<key>/); assert.match(m, /\/mcp\/<token>/); assert.match(m, /key=<…>/);
});

test("buddyUrl: прод дивиться на бету, бета - на прод; локально - нікуди", () => {
  assert.equal(buddyUrl("https://holos.rozum.one"), "https://beta.holos.rozum.one/health");
  assert.equal(buddyUrl("https://beta.holos.rozum.one"), "https://holos.rozum.one/health");
  assert.equal(buddyUrl("http://localhost:8080"), "");
  assert.equal(buddyUrl("http://127.0.0.1:18000"), "");
  assert.equal(buddyUrl("https://holos.rozum.one", "off"), "");
  assert.equal(buddyUrl("https://holos.rozum.one", "https://status.example.com/health"), "https://status.example.com/health");
});

test("dueToNotify: уперше - одразу; нагадування - лише якщо повторилось і минув проміжок", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const h = (x) => new Date(now - x * 3600_000).toISOString();
  assert.equal(dueToNotify({ notified_at: null, last_at: h(0), severity: "warning" }, now), true);
  assert.equal(dueToNotify({ notified_at: h(1), last_at: h(0), severity: "critical" }, now), false, "година - рано");
  assert.equal(dueToNotify({ notified_at: h(7), last_at: h(0), severity: "critical" }, now), true, "критичне - раз на 6 год");
  assert.equal(dueToNotify({ notified_at: h(7), last_at: h(0), severity: "warning" }, now), false, "попередження - раз на добу");
  assert.equal(dueToNotify({ notified_at: h(25), last_at: h(0), severity: "warning" }, now), true);
  assert.equal(dueToNotify({ notified_at: h(25), last_at: h(30), severity: "warning" }, now), false, "не повторювалось - не нагадуємо");
  assert.equal(dueToNotify({ notified_at: null, last_at: h(0), severity: "critical", muted_until: new Date(now + 3600_000).toISOString() }, now), false, "тиша");
});

test("digestText: тиха доба - без звіту; інакше відкрите, сервіс, люди, підсумок", () => {
  const stats = { published: 7, failed: 1, users: 2, spend: 0.84 };
  assert.equal(digestText({ instance: "Holos · прод", date: "30.09", open: [], groups: [], stats }), null);
  const t = digestText({
    instance: "Holos · прод", date: "30.09",
    open: [{ title: "OpenRouter: закінчились кошти", severity: "critical", count: 1440, since: "26.09 07:59" }],
    groups: [
      { title: "Пост не вийшов: threads: Threads не підключено", n: 3, last: "10:31", severity: "warning", group: "users" },
      { title: "OpenAI: модель не відповідає", n: 12, last: "09:00", severity: "warning", group: "service" },
    ],
    stats,
  });
  assert.match(t, /^🩺 Holos · прод - звіт за добу \(30\.09\)/);
  assert.ok(t.indexOf("Відкрите") < t.indexOf("Сервіс") && t.indexOf("Сервіс") < t.indexOf("У людей"));
  assert.match(t, /🔴 OpenRouter: закінчились кошти - з 26\.09 07:59, ×1440/);
  assert.match(t, /опубліковано 7, не вийшло 1 · нових людей 2 · AI \$0\.84/);
});

test("hintFor: куди йти й що буде з запасним маршрутом", () => {
  assert.match(hintFor({ kind: "ai_funds", provider: "OpenRouter" }, { failover: true, failoverVia: "OpenAI (gpt-4o)" }), /openrouter\.ai\/settings\/credits.*через OpenAI \(gpt-4o\)/);
  assert.match(hintFor({ kind: "ai_funds", provider: "OpenRouter" }, { failover: false }), /Головну модель/);
  assert.match(hintFor({ kind: "ai_key", provider: "Deepgram" }), /Whisper/);
  assert.match(hintFor({ kind: "ai_funds", provider: "fal.ai" }), /fal\.ai\/dashboard\/billing.*Бренд → Візуал/);
});
