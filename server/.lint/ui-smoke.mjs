// Браузерний смоук кабінету: піднімає ЗАГЛУШКУ API, відкриває /app у Chromium і перевіряє, що
// інтерфейс справді малюється й реагує. Це не e2e з реальною БД - це страховка від класу багів,
// який tsc/eslint/юніти НЕ бачать: TDZ у браузері, колізія імен функцій, зламана специфічність CSS,
// кнопка, що більше нікуди не веде. Такі баги ловились тут уже кілька разів (композер не
// відкривався через `ov.querySelector` до `const ov`; `button.go` перебивав `.ghost`).
//
// Запуск: node .lint/ui-smoke.mjs   (з каталогу server)
// Вихід: 0 - усі перевірки true й нема pageerror; 1 - будь-яка false або помилка сторінки.
//
// ⚠️ Файл СВІДОМО в git (раніше .lint/ був у .gitignore і його зніс скидання середовища -
// відновлювати перевірки руками довше, ніж тримати їх у репозиторії).
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, "..", "public");
const PORT = 4599;

// ---------------------------------------------------------------- дані заглушки
// Три пости навмисно різні: чернетка (карусель, намір, рубрика, фото, знайдені qa-проблеми),
// затверджений і ОПУБЛІКОВАНИЙ (з permalink) - саме різниця між ними й перевіряється.
const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";
const P3 = "33333333-3333-3333-3333-333333333333";
const TG_LINK = "https://t.me/mychannel/42";

const POSTS = [
  {
    id: P1, content: "Слайд 1: чому підрядники зникають\nСлайд 2: що з цим робити", review: "review",
    channels: { telegram: { on: true }, threads: { on: true } }, rubric: "Кейси", source_origin: "diary",
    format: "carousel", intent: "awareness", media_filename: "pic.jpg",
    qa: { director: "partial", aiaudit: 3, storytelling: 5 }, sent: [], links: {},
  },
  {
    id: P2, content: "Затверджений пост про ціни", review: "approved",
    channels: { telegram: { on: true } }, rubric: "Освіта", source_origin: "manual",
    format: "post", intent: "sale", sent: [], links: {},
  },
  {
    id: P3, content: "Цей уже опублікований у Telegram", review: "approved",
    channels: { telegram: { on: true } }, rubric: "Кейси", source_origin: "rss",
    format: "post", intent: "nurture", sent: ["telegram"], links: { telegram: TG_LINK },
  },
];

const iso = (dayShift, hh) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayShift);
  d.setUTCHours(hh, 0, 0, 0);
  return d.toISOString();
};
const dayISO = (shift) => iso(shift, 12).slice(0, 10);

const SETTINGS = [
  { key: "onboarded", content: "1" },
  { key: "pro", content: "0" },
  { key: "timezone", content: "Europe/Kyiv" },
  { key: "tone_of_voice", content: "коротко, по-людськи" },
  { key: "primary_goal", content: "leads" },
  { key: "qa_gates", content: JSON.stringify({ director: true, aiaudit: true, storytelling: true }) },
  { key: "channel_rhythm", content: JSON.stringify({ threads: { days: [1, 3], times: ["09:00"], formats: [{ f: "carousel", share: 30 }] } }) },
  { key: "strategy_brief", content: "Бриф: інтеграція AI змінює правила гри для підрядників." },
  { key: "voice_examples", content: "Ми втратили клієнта.\nКлючовий фактор - підрядник зник на два тижні." },
];

const API = {
  "GET /auth/me": { email: "smoke@rozum.one" },
  "GET /settings": SETTINGS,
  "GET /channels/status": { metaPublic: false, telegram: true, threads: true, instagram: false, facebook: false, linkedin: false },
  "GET /tasks": {
    score: 45,
    context: { critical: 1, total: 2 },
    tasks: [
      { id: "pains", label: "Опиши болі клієнта", points: 10, section: "strategy", done: false },
      { id: "chan2", label: "Підключи другий канал", points: 10, section: "settings", done: false },
    ],
  },
  "GET /posts/studio": POSTS,
  "GET /rubrics": [
    { id: "r1", name: "Кейси", emoji: "🏷", share: 60 },
    { id: "r2", name: "Освіта", emoji: "📚", share: 40 },
  ],
  "GET /strategy": { status: "ready", data: { best_days: [1, 3, 5], times: ["09:00"], rubrics: [] } },
  "GET /materials": {
    materials: [
      { id: "m1", title: "📔 Щоденник, 30 липня", origin: "diary", ai_score: 9, ai_score_why: "живий приклад", created_at: iso(0, 8), transcript: "Дзвінок з постачальником будинків." },
      { id: "m2", title: "Стаття про ринок", origin: "rss", ai_score: 4, created_at: iso(-1, 8), transcript: "Текст статті." },
    ],
  },
  "GET /ideas": { ideas: [{ id: "i1", text: "Розповісти, як обираємо підрядника", origin: "bot", status: "new", rubric: "Кейси" }] },
  "GET /plan": {
    slots: [
      { id: "s1", slot_date: dayISO(1), channel: "all", rubric: "Кейси", theme: "Як ми обираємо підрядника", status: "empty", format: "carousel" },
      { id: "s2", slot_date: dayISO(2), channel: "all", rubric: "Освіта", theme: "Три помилки в кошторисі", status: "matched", format: "post", match_note: "щоденник 30.07" },
    ],
    realizedMix: { post: 6, carousel: 3, reel: 1 },
  },
  "GET /bank": [{ id: P2, content: "Затверджений пост про ціни", source_title: "нотатка", sent: false }],
  "GET /schedule": [
    { id: "sl1", post_id: P1, scheduled_at: iso(0, 9), status: "planned", content: "Слайд 1: чому підрядники зникають", channels: null },
  ],
  "GET /today": {
    slots: [{ id: "sl1", post_id: P1, scheduled_at: iso(0, 9), status: "planned", channels: { telegram: { on: true } }, title: "Слайд 1: чому підрядники зникають", result: null }],
    drafts: [{ id: P1, rubric: "Кейси", title: "Слайд 1: чому підрядники зникають" }],
    draftsTotal: 2,
    ideas: 1,
    nextSlot: { id: "s1", theme: "Як ми обираємо підрядника", slot_date: dayISO(1) },
    threads: { streak: 3, postedToday: false },
    quickstart: { channels: 1, plan: 0, approved: 0 },
    failed: [{ id: "sl9", post_id: P2, scheduled_at: iso(-1, 18), title: "Затверджений пост про ціни", result: "Токен Meta протух" }],
    freshMaterials: { count: 2, top: 9 },
    publishedYesterday: 1,
    publishedToday: 1,
    netToday: { telegram: 1 },
  },
  "GET /threads/comments": { count: 4, items: [] },
  "POST /brand/context-check-result": {
    score: 5, promptChars: 9200,
    findings: [
      { severity: "critical", field: "Бренд → Голос → Приклади постів", title: "У прикладах голосу 2 ознаки машинного тексту",
        why: "Промт наказує відтворювати ритм саме як у прикладах, а моделі імітують приклади охочіше, ніж виконують правила.",
        fix: "Прибери з прикладів: широке тире, «не просто X, а Y».",
        key: "voice_examples", mode: "manual", quotes: ["клієнта.\nКлючовий фактор"] },
      { severity: "warn", field: "Бренд → Бриф і цілі", title: "Стратегічний бриф написаний штампами",
        why: "У промті він помічений як джерело правди, тож штамп звідти протікає в кожен пост.", fix: "Перепиши бриф своєю мовою.",
        key: "strategy_brief", mode: "ai", quotes: ["змінює правила гри"] },
    ],
  },
  "GET /guide/next": {
    tips: [{ id: "connect", text: "Підключи канал - інакше постам нікуди їхати.", target: "#genPostsBtn", emote: "happy", action: { label: "Показати", view: "settings", tab: "channels" } }],
  },
  "GET /prompts": [],
  "GET /published": [],
  "GET /usage": {
    prompt_tokens: 1000, completion_tokens: 500, cost: 0.02, calls: 3,
    byModel: [{ model: "openai/gpt-4o", calls: 2, cost: 0.018 }, { model: "openai/gpt-4o-mini", calls: 1, cost: 0.002 }],
    byStep: [{ step: "lite", calls: 2, cost: 0.018 }, { step: "post_digest", calls: 1, cost: 0.002 }],
    cap: { spentDay: 2.55, spentMonth: 7.1, capDay: 3, capMonth: 30 },
  },
  "GET /admin/spend": { defaults: { day: 3, month: 30, callsPerMin: 40 }, workspaces: [
    { id: "ws-1", emails: "smoke@rozum.one", day: 2.55, month: 7.1, calls: 12, spend_cap_day: null, spend_cap_month: null },
    { id: "ws-2", emails: "oleg@rozum.one", day: 0.4, month: 9.9, calls: 3, spend_cap_day: 0, spend_cap_month: 0 },
  ] },
  "GET /media": [{ id: "md1", filename: "pic.jpg", source: "upload", created_at: iso(0, 8) }],
  "GET /sources/recent": [],
  "GET /sources/rss": { feeds: [] },
  "GET /lead-magnets": { magnets: [] },
  "GET /integrations/telegram": { channelChatId: "-1001234567890", groupChatId: "", hasToken: true, sharedBot: true, channelTitle: "Мій канал" },
  "GET /integrations/threads": { connected: true, username: "brand" },
  "GET /integrations/meta": { connected: false },
  "GET /integrations/linkedin": { connected: false, available: false },
  "GET /integrations/youtube": { connected: false, available: false },
  "GET /integrations/tiktok": { connected: false, available: false },
  "GET /integrations/gdrive": { connected: false, available: false },
  "GET /integrations/transcription": { hasKey: false, webhookUrl: "", hasSecret: false, autoRun: false },
  "GET /integrations/images": { provider: "gemini", available: { openai: true, fal: false, gemini: true } },
  "GET /integrations/meta/pages": [],
  "GET /account": { email: "smoke@rozum.one", created_at: iso(-30, 8), pro: false, admin: true, media: { count: 3, bytes: 1048576 } },
  "GET /analytics/benchmarks": { networks: {}, posts: [] },
  "GET /analytics/threads": null,
  "GET /models/catalog": {
    models: [
      { id: "openai/gpt-4o", name: "GPT-4o", in: 2.5, out: 10, ctx: 128000 },
      { id: "openai/gpt-4o-mini", name: "GPT-4o mini", in: 0.15, out: 0.6, ctx: 128000 },
      { id: "anthropic/claude-x", name: "Claude X", in: 3, out: 15, ctx: 200000 },
    ],
    live: true, current: "openai/gpt-4o", defaultModel: "openai/gpt-4o", spend: { calls: 2, cost: 0.0123 },
  },
};

// Відповідь порівняння моделей: одна модель дала пости, друга - ні (обидва випадки мусять малюватись).
const AB_RESULT = {
  material: { id: "m1", title: "📔 Щоденник, 30 липня", chars: 900 },
  prompt: { chars: 4200, system: "<role>Ти елітний копірайтер…</role>" },
  count: 1,
  variants: [
    { model: "openai/gpt-4o", ok: true, posts: [{ text: "Варіант від першої моделі", image_prompt: "", rubric: "Кейси", intent: "awareness" }], ms: 4200, prompt_tokens: 1800, completion_tokens: 400, cost: 0.0085, costKnown: true },
    { model: "anthropic/claude-x", ok: false, error: "модель не повернула валідний JSON за нашим контрактом", posts: [], ms: 3100, prompt_tokens: 1800, completion_tokens: 120, cost: 0, costKnown: false },
  ],
};

// Публікація як ФОНОВА джоба: перше опитування має вернути «running», і лише наступне - «done».
// Саме це відрізняє полінг від старої синхронної відповіді, через яку nginx і віддавав 504.
let pubPolls = 0;
// Довгі AI-виклики теж фонові (перевірка контексту, виправлення, порівняння моделей): заглушка
// відповідає «running» на перше опитування - інакше перевірка не відрізнила б полінг від синхронної
// відповіді, а саме синхронність і давала 504 на nginx.
let aiJobPolls = 0;
const AI_JOB_RESULT = new Map();

// Пости: /full і /publish-state обслуговуються окремо (шлях із id).
// Ключі провайдерів: заглушка СТАНОВА, бо перевіряється саме перехід «не заданий → з адмінки»
// і те, що введене значення назад НЕ приходить (у відповіді лише хвіст із 4 символів).
const KEYS = [
  { name: "OPENAI_API_KEY", label: "OpenAI", hint: "тексти й зображення", group: "text", set: true, source: "env", tail: "aB12" },
  { name: "KIE_API_KEY", label: "kie.ai", hint: "AI-відео для рілсів", group: "video", set: false, source: "none", tail: "" },
];
const KIE_VIDEO = [
  { id: "bytedance/seedance-v1-lite-t2v", category: "video", description: "швидка text-to-video", credits: 20, usd: 0.1, unit: "per 5s video", provider: "bytedance" },
  { id: "google/veo3-fast", category: "video", description: "висока якість", credits: 80, usd: 0.4, unit: "per video", provider: "google" },
];
const KIE_IMAGE = [
  { id: "qwen3/pro-text-to-image", category: "image", description: "фотореалізм", credits: 4, usd: 0.02, unit: "per image", provider: "qwen" },
];

// ---- Mini App (Telegram). Стан справжній: чернетка змінюється діями, як у житті, - інакше
// перевірка «затвердив → бачу ✅» доводила б лише те, що заглушка вміє віддавати константу.
const TGP = {
  id: "tg-post-1",
  content: "Пост із Mini App про підрядників",
  channels: { telegram: { on: true } },
  review: null, rubric: null, filename: null, scheduled_at: null, slot_id: null, sent: [], links: {},
};
function handleTg(method, path, body) {
  if (path === "/me") return { ok: true, drafts: 2, materials: 2, nets: ["telegram", "threads"], tz: "Europe/Kyiv" };
  if (path === "/materials") return { items: [{ id: "m1", title: "📔 Щоденник, 30 липня", origin: "diary", ai_score: 9, created_at: iso(0, 8), transcript: "Дзвінок з постачальником." }] };
  if (path === "/drafts") {
    return { items: [
      { ...TGP, sent: TGP.sent.length > 0, sentNets: TGP.sent, created_at: iso(0, 9) },
      { id: "tg-post-2", content: "Уже опублікований", channels: { telegram: { on: true } }, review: "approved", filename: "pic.jpg", scheduled_at: null, sent: true, sentNets: ["telegram"], created_at: iso(-2, 9) },
    ] };
  }
  if (path === "/schedule") {
    return { items: TGP.scheduled_at
      ? [{ id: "sl1", post_id: TGP.id, scheduled_at: TGP.scheduled_at, status: "planned", result: null, content: TGP.content, channels: TGP.channels, filename: TGP.filename }]
      : [] };
  }
  if (method === "POST" && path === "/post") return { ok: true, id: TGP.id };
  let m = /^\/post\/([\w-]+)$/.exec(path);
  if (m && method === "GET") return { ...TGP };
  if (m && method === "PUT") {
    if (typeof body?.text === "string" && body.text.trim()) TGP.content = body.text.trim();
    if (body?.channels) TGP.channels = body.channels;
    return { ok: true };
  }
  if (m && method === "DELETE") return { ok: true };
  m = /^\/post\/([\w-]+)\/(\w[\w-]*)$/.exec(path);
  if (m) {
    const act = m[2];
    if (act === "media" && method === "POST") { TGP.filename = "uploaded.jpg"; return { ok: true, filename: "uploaded.jpg" }; }
    if (act === "media" && method === "DELETE") { TGP.filename = null; return { ok: true }; }
    if (act === "approve") { TGP.review = body?.approved === false ? "review" : "approved"; return { ok: true, review: TGP.review }; }
    if (act === "schedule" && method === "POST") { TGP.scheduled_at = body?.at; TGP.review = "approved"; return { ok: true, message: "🗓 Заплановано" }; }
    if (act === "schedule" && method === "DELETE") { TGP.scheduled_at = null; return { ok: true }; }
    if (act === "image") { tgJob = { kind: "image", polls: 0 }; return { jobId: "j-img" }; }
    if (act === "rewrite") { tgJob = { kind: "rewrite", polls: 0 }; return { jobId: "j-rw" }; }
    if (act === "publish") { tgPubPolls = 0; TGP.sent = ["telegram"]; TGP.links = { telegram: TG_LINK }; return { started: true, status: "running" }; }
    if (act === "publish-job") { tgPubPolls++; return tgPubPolls < 2 ? { status: "running" } : { status: "done", message: "Опубліковано" }; }
  }
  m = /^\/material\/([\w-]+)\/post$/.exec(path);
  if (m) { tgJob = { kind: "mat", polls: 0 }; return { jobId: "j-mat" }; }
  if (/^\/job\//.test(path)) {
    if (!tgJob) return { status: "idle" };
    tgJob.polls++;
    if (tgJob.polls < 2) return { status: "running" };
    if (tgJob.kind === "image") { TGP.filename = "ai.jpg"; return { status: "done", result: { filename: "ai.jpg" } }; }
    if (tgJob.kind === "rewrite") { TGP.content = "Переписаний AI варіант поста"; return { status: "done", result: { text: TGP.content } }; }
    return { status: "done", result: { id: TGP.id } };
  }
  return {};
}
let tgJob = null, tgPubPolls = 0;

// приймач зустрічей: адреса СТАНОВА, бо перевіряється саме перевипуск (стара адреса вмирає)
let mtToken = "tok-aaaa1111", mtPull = false;

function handleApi(method, path, body) {
  if (path.startsWith("/tg/")) return handleTg(method, path.slice(3), body);
  const key = method + " " + path.split("?")[0];
  if (key === "GET /admin/keys") return { keys: KEYS, kie: { ready: KEYS[1].set, credits: KEYS[1].set ? 1200 : null } };
  if (method === "PUT" && path.startsWith("/admin/keys/")) {
    const name = path.split("/")[3];
    const k = KEYS.find((x) => x.name === name);
    const v = String((body && body.value) || "");
    if (k && v) { k.set = true; k.source = "admin"; k.tail = v.slice(-4); }
    return { ok: true };
  }
  if (key === "GET /pricing/media") {
    const cat = /category=video/.test(path) ? "video" : "image";
    return {
      ours: cat === "image" ? [
        { id: "fal", label: "FLUX.1 schnell (fal.ai)", note: "найдешевше", usd: 0.003, available: false },
        { id: "openai", label: "OpenAI gpt-image-1", note: "тримає текст", usd: 0.011, available: true },
      ] : [],
      kie: cat === "video" ? KIE_VIDEO : KIE_IMAGE,
      kieReady: KEYS[1].set,
    };
  }
  if (key === "GET /integrations/meeting")
    return { url: "https://socialio.rozum.one/api/webhooks/meeting/" + mtToken, hasSecret: false, auto: true, imported: 2,
             pull: { url: mtPull ? "https://vymova.rozum.one" : "", hasToken: mtPull, after: 7, at: iso(0, 9) } };
  if (key === "POST /integrations/meeting/pull") {
    mtPull = true;
    return { ok: true, message: body?.testOnly ? "✅ Зʼєднання є. Найстаріша зустріч: «Зустріч 1»" : "✅ Забрано нових зустрічей: 2 (переглянуто 3, курсор 9)" };
  }
  if (key === "PUT /integrations/meeting") {
    if (body?.rotate) mtToken = "tok-bbbb2222";
    return { ok: true };
  }
  if (key in API) return API[key];
  let mm = /^\/materials\/([\w-]+)$/.exec(path);
  if (mm && method === "GET") return { id: mm[1], transcript: "Повний текст запису щоденника про дзвінок." };
  let m = /^\/posts\/([0-9a-f-]+)\/full$/.exec(path);
  if (m) {
    const p = POSTS.find((x) => x.id === m[1]) || POSTS[0];
    return { ...p, image_prompt: "", headline: "", has_base: false };
  }
  m = /^\/posts\/([0-9a-f-]+)\/publish-state$/.exec(path);
  if (m) {
    const p = POSTS.find((x) => x.id === m[1]) || POSTS[0];
    return { sent: p.sent || [], links: p.links || {} };
  }
  if (method === "POST" && path === "/ab/generate") return AB_RESULT;
  if (method === "POST" && path === "/brand/context-fix") {
    aiJobPolls = 0;
    AI_JOB_RESULT.set("job-fix", { suggestion: "Допомагаємо власникам житла не втрачати гроші на підрядниках." });
    return { jobId: "job-fix" };
  }
  if (method === "GET" && /^\/jobs\//.test(path)) {
    const id = path.split("/")[2];
    aiJobPolls++;
    return aiJobPolls < 2 ? { status: "running" } : { status: "done", result: AI_JOB_RESULT.get(id) };
  }
  if (method === "POST" && path === "/brand/context-check") {
    // deep:false віддається одразу (детермінований шар), deep:true - джобою
    aiJobPolls = 0;
    AI_JOB_RESULT.set("job-ctx", API["POST /brand/context-check-result"]);
    return { jobId: "job-ctx" };
  }
  if (method === "POST" && /\/publish-all$/.test(path)) {
    pubPolls = 0;
    const id = path.split("/")[2];
    const p = POSTS.find((x) => x.id === id);
    if (p) { p.sent = ["telegram", "threads"]; p.links = { telegram: TG_LINK, threads: "https://www.threads.net/@brand/post/abc" }; }
    return { started: true, status: "running" };
  }
  if (method === "GET" && /\/publish-job$/.test(path)) {
    pubPolls++;
    return pubPolls < 2
      ? { status: "running" }
      : { status: "done", results: [{ channel: "telegram", status: "sent" }, { channel: "threads", status: "sent" }] };
  }
  if (method === "POST" || method === "PUT" || method === "DELETE") return { ok: true };
  return {};
}

// 1×1 прозорий PNG - щоб /thumb і /media не сипали 404 у консоль
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+H3xvzwAAAABJRU5ErkJggg==", "base64");

const server = createServer((req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/api/")) {
    // тіло читаємо, бо перевірка ключів мусить бачити, ЩО САМЕ надіслав клієнт
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      const body = handleApi(req.method, url.slice(4), parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body === undefined ? {} : body));
    });
    return;
  }
  if (url.startsWith("/thumb/") || url.startsWith("/media/")) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
    return;
  }
  const file = url === "/app" || url === "/" ? "app.html" : url === "/tgapp" ? "tgapp.html" : url.split("?")[0].replace(/^\//, "");
  const p = join(PUB, file);
  if (!existsSync(p) || !p.startsWith(PUB)) {
    res.writeHead(404).end("nope");
    return;
  }
  const ct = p.endsWith(".html") ? "text/html" : p.endsWith(".js") ? "text/javascript" : p.endsWith(".svg") ? "image/svg+xml" : "text/plain";
  res.writeHead(200, { "content-type": ct + "; charset=utf-8" });
  res.end(readFileSync(p));
});

function chromePath() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const root = "/opt/pw-browsers";
  if (existsSync(root)) {
    for (const d of readdirSync(root)) {
      for (const bin of ["chrome-linux/headless_shell", "chrome-linux/chrome"]) {
        const p = join(root, d, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) if (existsSync(p)) return p;
  return null;
}

const results = {};
const pageErrors = [];
const check = async (name, fn) => {
  try {
    results[name] = (await fn()) === true;
  } catch (e) {
    results[name] = false;
    pageErrors.push(name + ": " + e.message);
  }
};

const run = async () => {
  await new Promise((r) => server.listen(PORT, r));
  const exe = chromePath();
  if (!exe) throw new Error("не знайшов chromium (постав PW_CHROME=/шлях/до/бінарника)");
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.on("pageerror", (e) => pageErrors.push("pageerror: " + e.message));
  // зовнішні ресурси (шрифти Google, apis.google.com) у пісочниці недосяжні - глушимо, щоб не чекати таймаутів
  await page.route("**/*", (route) => {
    const u = route.request().url();
    return u.includes("127.0.0.1:" + PORT) || u.includes("localhost:" + PORT) ? route.continue() : route.abort();
  });
  await page.addInitScript(() => {
    localStorage.clear();
    try { window.confirm = () => true; window.alert = () => {}; window.prompt = () => "x"; } catch (e) {}
  });
  await page.goto(`http://127.0.0.1:${PORT}/app`, { waitUntil: "domcontentloaded" });
  // boot завершився, коли підтягнувся email (/auth/me) і намалювався екран «Сьогодні»
  await page.waitForFunction(() => {
    const e = document.getElementById("userEmail");
    const w = document.getElementById("todayWrap");
    return e && e.textContent.includes("@") && w && w.children.length > 0;
  }, undefined, { timeout: 20000 });

  const $t = (sel) => page.$eval(sel, (el) => el.textContent || "").catch(() => "");
  const vis = (sel) => page.$eval(sel, (el) => !!el.offsetParent || getComputedStyle(el).position === "fixed").catch(() => false);
  const has = (sel) => page.$(sel).then((h) => !!h);
  const count = (sel) => page.$$(sel).then((a) => a.length);

  // ---------------------------------------------------------- 1. екран «Сьогодні»
  await check("todayActive", async () =>
    (await page.$eval('.viewsec[data-view="today"]', (el) => el.classList.contains("active"))) &&
    (await $t("#pageTitle")).length > 0);

  await check("todaySlot", async () => {
    const rows = await count("#todayWrap .tdRow");
    return rows === 1 && (await $t("#todayWrap .tdRow")).includes("підрядники");
  });

  await check("todayDraft", async () => (await count(".tdOk")) === 1 && (await count(".tdEdit")) === 1);

  await check("streak", async () => {
    const tiles = await page.$$eval(".tdTile", (a) => a.map((x) => x.textContent));
    return tiles.some((t) => t.includes("Стрік") && t.includes("3 дн."));
  });

  await check("commCount", async () => {
    await page.waitForFunction(() => { const e = document.getElementById("tdComm"); return e && e.textContent === "4"; }, undefined, { timeout: 8000 });
    return true;
  });

  await check("todayFails", async () =>
    (await count(".tdFix")) === 1 && (await $t("#todayWrap")).includes("Не опублікувалось (1)"));

  await check("todayFunnel", async () => {
    const fns = await page.$$eval(".tdFn", (a) => a.map((x) => x.textContent));
    const chans = await page.$$eval(".tdChan", (a) => a.map((x) => x.textContent));
    return fns.length === 3 && fns[0].includes("Новини") && fns[1].includes("Чернетки") && fns[2].includes("Опубліковано") &&
      chans.length === 5 && chans.some((c) => c.includes("✓ підключено")) && (await count(".tdChanGo")) > 0;
  });

  await check("quickstart", async () => {
    const txt = await $t("#todayWrap");
    return txt.includes("Швидкий старт") && txt.includes("1 з 3") && (await count(".qsGo")) === 2;
  });

  // ---------------------------------------------------------- 2. Створення: вкладки, банк ідей
  await check("ideasTab", async () => {
    await page.evaluate(() => { selectView("create"); setCTab("ideas"); });
    // чекаємо на ФАКТ рендера, не на таймер: під навантаженням фіксована пауза дає фантомний провал
    await page.waitForFunction(() => {
      const l = document.getElementById("layIdeas"), f = document.getElementById("ideaBankFeed");
      return l && l.offsetParent && f && f.textContent.includes("підрядника");
    }, undefined, { timeout: 8000 });
    return true;
  });

  await check("studioClean", async () => {
    await page.evaluate(() => setCTab("posts"));
    await page.waitForFunction((id) => document.querySelector('.pcard[data-post="' + id + '"]'), P1, { timeout: 8000 });
    const tabs = await page.$$eval("#studioFilters .ftab", (a) => a.map((x) => ({ t: x.textContent, on: x.classList.contains("on") })));
    const active = tabs.find((x) => x.t.includes("Активні"));
    const pub = tabs.find((x) => x.t.includes("Опубліковані"));
    // дефолт - «Активні»; опублікований пост у сітці НЕ показується, він лише в своїй вкладці (1)
    const cards = await page.$$eval(".pcard", (a) => a.map((x) => x.dataset.post));
    return !!active && active.on && !!pub && pub.t.includes("1") && cards.length === 2 && !cards.includes(P3);
  }, );

  await check("intentChip", async () => {
    const tags = await page.$$eval('.pcard[data-post="' + P1 + '"] .ptag', (a) => a.map((x) => x.textContent));
    return tags.some((t) => t.includes("знайомство"));
  });

  await check("formatDim", async () => {
    const tags = await page.$$eval('.pcard[data-post="' + P1 + '"] .ptag', (a) => a.map((x) => x.textContent));
    // бейдж формату лише на НЕ-звичайному пості (інакше він на кожній картці = шум)
    const p2tags = await page.$$eval('.pcard[data-post="' + P2 + '"] .ptag', (a) => a.map((x) => x.textContent));
    return tags.some((t) => t.includes("карусель")) && !p2tags.some((t) => t.includes("карусель") || t.includes("Пост"));
  });

  await check("qaGates", async () => {
    const badges = await page.$$eval('.pcard[data-post="' + P1 + '"] .qabadge', (a) => a.map((x) => x.textContent));
    const boxes = (await has("#qgDirector")) && (await has("#qgAiaudit")) && (await has("#qgStorytelling"));
    const checked = await page.$eval("#qgDirector", (el) => el.checked);
    return boxes && checked && badges.length === 3 && badges.some((b) => b.includes("Сторителлінг"));
  });

  await check("postLinks", async () => {
    await page.evaluate(() => { StudioFilter = "published"; renderStudio(); });
    await page.waitForFunction((id) => document.querySelector('.pcard[data-post="' + id + '"]'), P3, { timeout: 8000 });
    const links = await page.$$eval('.pcard[data-post="' + P3 + '"] a.cdot', (a) => a.map((x) => x.getAttribute("href")));
    const ok = links.length === 1 && links[0] === TG_LINK;
    await page.evaluate(() => { StudioFilter = "all"; renderStudio(); }); // не лишаємо фільтр наступним перевіркам
    await page.waitForFunction((id) => document.querySelector('.pcard[data-post="' + id + '"]'), P1, { timeout: 8000 });
    return ok;
  });

  // ---------------------------------------------------------- 3. ⋯-меню картки
  await check("cardMenu", async () => {
    await page.click('.pcard[data-post="' + P1 + '"] [data-a="menu"]');
    await page.waitForSelector(".cardmenu", { timeout: 4000 });
    const freq = await count(".cardmenu .cm-i[data-f]");
    const advHidden = await page.$eval("#cmAdv", (el) => el.style.display === "none");
    await page.click("#cmMore");
    const advShown = await page.$eval("#cmAdv", (el) => el.style.display !== "none");
    return freq === 4 && advHidden && advShown && (await has("#cmMore"));
  });

  await check("storytelling", async () => {
    const items = await page.$$eval(".cardmenu #cmAdv .cm-i", (a) => a.map((x) => x.textContent));
    const ok = items.some((t) => t.includes("Сторителлінг")) && items.some((t) => t.includes("Директора"));
    await page.evaluate(() => document.querySelectorAll(".cardmenu,.cardmenu-bg").forEach((x) => x.remove()));
    return ok;
  });

  // ---------------------------------------------------------- 4. композер
  await check("cmpBack", async () => {
    await page.evaluate((id) => openComposer(id), P1);
    await page.waitForSelector(".cmp-ov #cmpBack", { timeout: 6000 });
    const opened = await has(".cmp-ov");
    await page.click("#cmpBack");
    await page.waitForTimeout(250);
    return opened && !(await has(".cmp-ov"));
  });

  await check("slowPublish", async () => {
    // Регресія на 504: публікація мусить пережити ПОВІЛЬНУ відправку. Стара синхронна відповідь
    // висіла до кінця запиту й гинула об таймаут nginx; тепер запит вертає «почав», а UI полить.
    await page.evaluate((id) => openComposer(id), P1);
    await page.waitForSelector(".cmp-ov #cmpNow", { timeout: 6000 });
    await page.click("#cmpNow");
    // проміжний стан із лічильником секунд = доказ, що клієнт справді полить, а не чекає одну відповідь
    await page.waitForFunction(() => /публікую…\s*\d+с/.test(document.querySelector("#cmpMsg").textContent), undefined, { timeout: 8000 });
    await page.waitForFunction(() => /✓ telegram/.test(document.querySelector("#cmpMsg").textContent), undefined, { timeout: 15000 });
    const st = await page.evaluate(() => ({
      msg: document.querySelector("#cmpMsg").textContent,
      // надіслані мережі мусять стати заблокованими з ✓ одразу, без перезаходу в композер
      tgLocked: !!document.querySelector('#cmpChips .netchip[data-net="telegram"]').disabled,
      // 🔗 і посилання на живий пост мусить зʼявитись ОДРАЗУ, а не після F5
      links: [...document.querySelectorAll("#cmpPrev a.pv-open")].map((a) => a.getAttribute("href")),
    }));
    // індикатор «AI працює» мусить ЗГАСНУТИ. Гасне він у finally, тобто на такт пізніше за повідомлення,
    // тому чекаємо на факт: так перевірка ловить саме «висить назавжди» (aiBusy без парного aiDone),
    // а не нормальну затримку в кілька мілісекунд.
    let busyCleared = true;
    try { await page.waitForFunction(() => !document.querySelector("#aiBusy.show"), undefined, { timeout: 6000 }); }
    catch { busyCleared = false; }
    await page.evaluate(() => { const b = document.querySelector("#cmpBack"); if (b) b.click(); });
    await page.waitForTimeout(250);
    return st.msg.includes("✓ telegram") && st.msg.includes("threads") && st.tgLocked
      && st.links.includes(TG_LINK) && busyCleared;
  });

  await check("perChanAdapt", async () => {
    await page.evaluate((id) => openComposer(id), P3); // у P3 telegram уже надіслано
    await page.waitForSelector(".cmp-ov #cmpChips .netgrp", { timeout: 6000 });
    // ✨ активний лише для УВІМКНЕНОЇ мережі: спершу вмикаємо Threads (у P3 обраний лише Telegram)
    await page.evaluate(() => { const b = document.querySelector('#cmpChips .netchip[data-net="threads"]'); if (b && !b.classList.contains("on")) b.click(); });
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => {
      const seg = (k) => document.querySelector('#cmpChips [data-adapt="' + k + '"]');
      return {
        grps: document.querySelectorAll("#cmpChips .netgrp").length,
        tgDisabled: !!seg("telegram") && seg("telegram").disabled,   // надіслану мережу не адаптуємо
        thEnabled: !!seg("threads") && !seg("threads").disabled,
        revert: document.querySelectorAll("#cmpChips [data-revert]").length,
      };
    });
    // прев'ю мусить ЧЕСНО казати, що мережу без своєї версії сервер спакує сам
    const note = await $t("#cmpPrev");
    return st.grps === 5 && st.tgDisabled && st.thEnabled && st.revert === 0 && note.includes("спакується під цю мережу автоматично");
  });

  await check("deepLink", async () => {
    await page.evaluate(() => { const b = document.querySelector("#cmpBack"); if (b) b.click(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { selectView("create"); setCTab("posts"); });
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => location.hash);
    await page.evaluate((id) => { location.hash = "#/post/" + id; }, P2);
    await page.waitForSelector(".cmp-ov", { timeout: 6000 });
    const hashKept = await page.evaluate((id) => location.hash === "#/post/" + id, P2);
    await page.click("#cmpBack");
    await page.waitForTimeout(300);
    const back = await page.evaluate(() => location.hash);
    return hashKept && !(await has(".cmp-ov")) && back === before;
  });

  // ---------------------------------------------------------- 5. маршрутизація
  await check("materialDeepLink", async () => {
    // лінк «🌐 Перейти» з бота: адреса мусить відкрити САМЕ той запис, навіть коли у стрічці
    // стоїть фільтр, під який він не підпадає (інакше лінк вів би в порожній екран)
    await page.evaluate(() => { selectView("create", "materials"); MatFilter = "📡 RSS"; renderMaterials(); });
    await page.waitForTimeout(200);
    const hiddenFirst = await page.evaluate(() => !document.querySelector('[data-mat="m1"]'));
    await page.evaluate(() => { location.hash = "#/material/m1"; });
    await page.waitForFunction(() => {
      const r = document.querySelector('[data-mat="m1"]');
      const f = document.getElementById("matFull");
      return r && f && f.textContent.includes("щоденника");
    }, undefined, { timeout: 8000 });
    const st = await page.evaluate(() => ({
      filter: MatFilter, open: MatOpen,
      view: document.querySelector(".viewsec.active").dataset.view, tab: cTab,
    }));
    return hiddenFirst && st.filter === "Усі" && st.open === "m1" && st.view === "create" && st.tab === "materials";
  });

  await check("routing", async () => {
    await page.evaluate(() => { selectView("publish"); setPTab("plan"); });
    await page.waitForTimeout(250);
    const h1 = await page.evaluate(() => location.hash);
    await page.evaluate(() => { location.hash = "#/create/materials"; });
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => ({
      view: document.querySelector(".viewsec.active").dataset.view,
      tab: cTab,
      // шими нормалізуються в канонічну адресу
      shim: (selectView("strategy"), location.hash),
    }));
    return h1 === "#/publish/plan" && st.view === "create" && st.tab === "materials" && st.shim === "#/brand/strat";
  });

  await check("stratShim", async () => {
    await page.evaluate(() => selectView("strategy"));
    await page.waitForTimeout(200);
    return (await page.$eval('.viewsec[data-view="brand"]', (el) => el.classList.contains("active"))) &&
      (await vis("#brandStratHost")) &&
      (await page.$eval('#bTabs .tab[data-btab="strat"]', (el) => el.classList.contains("on")));
  });

  await check("ctxDotExplained", async () => {
    // сама по собі 🔴 нічого не пояснює: у модалці налаштування вона мусить бути ПЕРШИМ рядком
    // із розшифровкою і кнопкою, куди йти (інакше це просто тривожний маркер без адресата)
    await page.evaluate(() => openTasksModal());
    await page.waitForFunction(() => document.querySelector(".modal #tkCtx"), undefined, { timeout: 6000 });
    // читаємо САМЕ ту модалку, де є кнопка: у DOM може лишатись інша від попередніх перевірок
    const txt = await page.$eval("#tkCtx", (b) => b.closest(".modal").textContent);
    await page.click("#tkCtx");
    await page.waitForFunction(() => /Оцінка контексту/.test((document.getElementById("ctxOut") || {}).textContent || ""), undefined, { timeout: 8000 });
    return txt.includes("Червона точка") && txt.includes("суперечн") && txt.includes("промт")
      && !(await has("#tkCtx"));   // кнопка закриває модалку й веде в перевірку
  });

  await check("ctxFixPopup", async () => {
    // знайти проблему виявилось легше, ніж полагодити: на кожній знахідці мусить бути «Виправити»,
    // а попап - показувати «було» з підсвіченим фрагментом і редаговане «стало»
    await page.evaluate(() => { selectView("brand"); setBTab("voice"); });
    await page.waitForFunction(() => document.getElementById("ctxRun"), undefined, { timeout: 6000 });
    await page.click("#ctxRun");
    await page.waitForFunction(() => document.querySelectorAll("#ctxOut .ctxFix").length >= 2, undefined, { timeout: 8000 });
    // ① поле, яке пише ЛИШЕ людина: кнопки «Запропонувати» бути не повинно
    await page.evaluate(() => document.querySelectorAll("#ctxOut .ctxFix")[0].click());
    await page.waitForSelector(".modal #cfNew", { timeout: 6000 });
    const manual = await page.evaluate(() => ({
      ai: !!document.querySelector("#cfAi"),
      marked: !!document.querySelector(".modal mark"),
      filled: (document.getElementById("cfNew").value || "").includes("Ключовий фактор"),
      state: (document.getElementById("cfState") || {}).textContent || "",
    }));
    await page.evaluate(() => document.querySelector("#cfX").click());
    // ② поле, яке переписати доречно: кнопка є і наповнює «стало»
    await page.evaluate(() => document.querySelectorAll("#ctxOut .ctxFix")[1].click());
    await page.waitForSelector(".modal #cfAi", { timeout: 6000 });
    await page.click("#cfAi");
    await page.waitForFunction(() => (document.getElementById("cfNew").value || "").includes("не втрачати гроші"), undefined, { timeout: 8000 });
    await page.click("#cfSave");
    await page.waitForFunction(() => !document.querySelector("#cfNew"), undefined, { timeout: 6000 });
    return !manual.ai && manual.marked && manual.filled && manual.state.includes("поки без змін");
  });

  await check("contextCheck", async () => {
    // запобіжник від сміття на вході: знахідка мусить казати ЧОМУ і ЩО ЗРОБИТИ, а критичні
    // суперечності - бути видимими біля відсотка налаштування, без жодного кліку
    await page.evaluate(() => { selectView("brand"); setBTab("voice"); });
    await page.waitForFunction(() => document.getElementById("ctxRun"), undefined, { timeout: 6000 });
    const badge = await page.evaluate(() => ({
      panel: (document.getElementById("ctxBadge") || {}).textContent || "",
      dot: !!document.querySelector("#scorePill .ctxdot"),
    }));
    await page.click("#ctxRun");
    await page.waitForFunction(() => /Оцінка контексту/.test(document.getElementById("ctxOut").textContent), undefined, { timeout: 8000 });
    const out = await $t("#ctxOut");
    return badge.dot && badge.panel.includes("критичних") &&
      out.includes("5/10") && out.includes("машинного тексту") && out.includes("Що зробити") && out.includes("штампами");
  });

  await check("painsPanel", async () => {
    // перевірка самодостатня: сама вмикає потрібну вкладку, а не покладається на стан, який лишила
    // попередня (саме на це вона й впала, коли перед нею зʼявилась перевірка контексту)
    await page.evaluate(() => { selectView("brand"); setBTab("strat"); });
    await page.waitForFunction(() => { const el = document.getElementById("painPoints"); return el && el.offsetParent; }, undefined, { timeout: 6000 });
    return (await has("#brandThesis")) && (await has("#painsSuggest"));
  });

  // ---------------------------------------------------------- 6. Публікація: плашка, банк, план
  await check("stickyHead", async () => {
    await page.evaluate(() => { selectView("publish"); setPTab("cal"); });
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({
      pos: getComputedStyle(document.querySelector(".pagehead")).position,
      tabsMoved: !!document.querySelector("#phTabs #pubTabs"),
      // на Календарі дій нема: банк тепер ЖИВЕ колонкою, кнопки-попапа під нього більше не існує
      actions: document.getElementById("phActions").children.length,
    }));
    return st.pos === "sticky" && st.tabsMoved && st.actions === 0;
  });

  await check("bankCol", async () => {
    const shown = (await vis("#bankHost")) && (await page.$eval("#bankHost", (el) => el.classList.contains("bankcol")));
    const cards = await count("#bank .chip");
    await page.click("#bankFold");
    await page.waitForTimeout(150);
    const folded = !(await vis("#bankHost")) && (await vis("#bankUnfold"));
    await page.click("#bankUnfold");
    await page.waitForTimeout(150);
    const back = await vis("#bankHost");
    return shown && cards === 1 && folded && back;
  });

  await check("formatPlan", async () => {
    await page.evaluate(() => setPTab("plan"));
    await page.waitForTimeout(500);
    const slotTags = await page.$$eval("#planList .ptag", (a) => a.map((x) => x.textContent));
    const fact = await $t("#fmtFact");
    const fmtBoxes = await count("#rhythmRows .rhFmt");
    return slotTags.some((t) => t.includes("карусель")) && fact.includes("Фактично за 30 днів") && fmtBoxes >= 4;
  });

  await check("planDefault", async () => {
    // стандарт CORE: один майстер-план. Чекбокси мереж сховані, вибір мереж порожній.
    const advOff = await page.$eval("#planAdv", (el) => !el.checked);
    const netsHidden = !(await vis("#planNets"));
    const sel = await page.evaluate(() => planSelectedNets().length);
    return advOff && netsHidden && sel === 0;
  });

  await check("planNets", async () => {
    // панель «Скелет» живе у ПОПАПІ з липкої плашки (сам список плану займає всю ширину),
    // тож і чекбокс режиму доступний лише звідти - перевіряємо саме цим шляхом
    await page.evaluate(() => { const b = [...document.querySelectorAll("#phActions button")].find((x) => x.textContent.includes("Скелет")); if (b) b.click(); });
    // сам чекбокс візуально схований (`.rchip input{display:none}`) - клікається ЛАБЕЛ, як і людиною
    await page.waitForSelector(".popov #planAdvWrap", { timeout: 4000 });
    await page.click("#planAdvWrap");
    await page.waitForTimeout(200);
    const shown = await vis("#planNets");
    const boxes = await count("#planNets .planNet");
    const sel = await page.evaluate(() => planSelectedNets());
    await page.click("#planAdvWrap"); // вертаємо дефолт CORE
    await page.waitForTimeout(150);
    // попап мусить ВЕРНУТИ панель у її схований хост (інакше drag-drop і обробники загубились би)
    await page.evaluate(() => { const x = document.querySelector(".popov #popX"); if (x) x.click(); });
    await page.waitForTimeout(150);
    const returned = await page.evaluate(() => !!document.querySelector("#skeletonHost #planAdv") && !document.querySelector(".popov"));
    return shown && boxes >= 2 && sel.includes("telegram") && sel.includes("threads") && returned;
  });

  // ---------------------------------------------------------- 7. Інструменти / меню / панелі
  await check("toolsItem", async () => {
    const inMenu = await page.$eval("#userMenu #umTools", (el) => (el.textContent || "").includes("Інструменти")).catch(() => false);
    await page.evaluate(() => document.getElementById("umTools").click());
    await page.waitForTimeout(250);
    return inMenu && (await page.$eval('.viewsec[data-view="tools"]', (el) => el.classList.contains("active")));
  });

  await check("toolsView", async () =>
    (await has("#toolsGdriveHost #gdStatus")) && (await has("#toolsTransHost #ffKey")) &&
    (await has("#toolsPipeline")) && (await has("#viewPrompt")));

  await check("aiSpend", async () => {
    // розріз витрат + ВИДИМИЙ вхід у порівняння моделей (раніше панель була лише в меню аватара,
    // і знайти її було майже неможливо - саме на це й поскаржився Олег)
    await page.evaluate(() => selectView("analytics"));
    await page.waitForFunction(() => document.getElementById("anAbBtn"), undefined, { timeout: 8000 });
    const txt = await $t("#analyticsBox");
    await page.click("#anAbBtn");
    await page.waitForFunction(() => document.querySelector('.viewsec[data-view="tools"]').classList.contains("active"), undefined, { timeout: 6000 });
    return txt.includes("Куди йдуть гроші") && txt.includes("gpt-4o") && txt.includes("post_digest") && txt.includes("$0.0180");
  });

  await check("abPanel", async () => {
    // матеріали й каталог моделей мусять доїхати в селекти, а результат - показатись СЛІПО
    await page.waitForFunction(() => { const s = document.getElementById("abSource"); return s && s.options.length >= 2; }, undefined, { timeout: 6000 });
    const st = await page.evaluate(() => ({
      mats: document.getElementById("abSource").options.length,
      slots: document.querySelectorAll("#abModels .abModel").length,
      first: document.querySelector("#abModels .abModel").value,   // база порівняння = поточна модель
      rest: [...document.querySelectorAll("#abModels .abModel")].slice(1).every((x) => x.value === ""),
      main: document.getElementById("abMain").value,
      msg: document.getElementById("abCatMsg").textContent,
    }));
    // менше двох моделей - порівнювати нічого, і UI мусить сказати це ДО витрати грошей
    await page.click("#abRun");
    await page.waitForTimeout(150);
    const guard = (await $t("#abMsg")).includes("щонайменше дві");
    await page.evaluate(() => { document.querySelectorAll("#abModels .abModel")[1].value = "anthropic/claude-x"; });
    await page.click("#abRun");
    await page.waitForFunction(() => document.querySelectorAll("#abOut .post, #abOut [style*='--danger']").length > 0, undefined, { timeout: 8000 });
    const out = await page.evaluate(() => ({
      blind: !document.getElementById("abOut").textContent.includes("gpt-4o"),
      variants: document.getElementById("abOut").textContent.includes("Варіант"),
      err: document.getElementById("abOut").textContent.includes("валідний JSON"),
      prompt: !!document.getElementById("abPrompt"),
    }));
    await page.click("#abReveal"); // ⟵ назви показуються лише на явну дію
    await page.waitForTimeout(150);
    const revealed = (await $t("#abOut")).includes("anthropic/claude-x");
    return st.mats === 2 && st.slots === 4 && st.first === "openai/gpt-4o" && st.rest && st.main === "openai/gpt-4o" &&
      st.msg.includes("3 моделей") && guard && out.blind && out.variants && out.err && out.prompt && revealed;
  });

  // ---------------------------------------------------------- 7b. Ключі з адмінки + ціни
  await check("adminKeys", async () => {
    // головне тут - НЕ «панель намалювалась», а те, що введений ключ назад не приходить:
    // у DOM після збереження мусить лишитись максимум хвіст із 4 символів
    const SECRET = "kie-live-SuperSecret-7Zq9";
    await page.evaluate(() => { selectView("settings"); setSTab("profile"); });
    await page.waitForFunction(() => {
      const b = document.getElementById("admKeysPanel");
      return b && b.style.display !== "none" && document.querySelectorAll("#admKeys .card").length >= 2;
    }, undefined, { timeout: 8000 });
    const before = await $t("#admKeys");
    await page.evaluate((v) => {
      const c = [...document.querySelectorAll("#admKeys .card")].find((x) => x.getAttribute("data-key") === "KIE_API_KEY");
      c.querySelector("input").value = v;
      c.querySelector(".kSave").click();
    }, SECRET);
    await page.waitForFunction(() => {
      const c = [...document.querySelectorAll("#admKeys .card")].find((x) => x.getAttribute("data-key") === "KIE_API_KEY");
      return c && c.textContent.includes("з адмінки");
    }, undefined, { timeout: 8000 });
    const st = await page.evaluate((v) => {
      const html = document.getElementById("admKeys").innerHTML;
      const c = [...document.querySelectorAll("#admKeys .card")].find((x) => x.getAttribute("data-key") === "KIE_API_KEY");
      return {
        leaked: html.includes(v) || html.includes(v.slice(0, 12)),
        tail: c.textContent.includes("7Zq9"),
        cleared: c.querySelector("input").value === "",
        credits: document.getElementById("admKeys").textContent.includes("кредит"),
      };
    }, SECRET);
    return before.includes("не заданий") && before.includes("з .env") &&
      !st.leaked && st.tail && st.cleared && st.credits;
  });

  await check("spendCap", async () => {
    // стеля має бути видимою ДО того, як людина в неї впреться: бар у Аналітиці з сумою «із $X»,
    // і адмін бачить таблицю по кабінетах із полями для власної стелі
    await page.evaluate(() => selectView("analytics"));
    await page.waitForFunction(() => document.getElementById("capBox"), undefined, { timeout: 8000 });
    const cap = await $t("#capBox");
    const warnBar = await page.$eval("#capBarС", (el) => el.style.width);   // 2.55/3 = 85% → амбер
    await page.evaluate(() => { selectView("settings"); setSTab("profile"); });
    await page.waitForFunction(() => document.querySelectorAll("#admSpend tr[data-ws]").length >= 2, undefined, { timeout: 8000 });
    const rows = await page.$$eval("#admSpend tr[data-ws]", (els) => els.map((e) => e.textContent));
    const zeroCap = await page.$eval('#admSpend tr[data-ws="ws-2"] .sDay', (el) => el.value);
    return cap.includes("$2.55 із $3.00") && cap.includes("$7.10 із $30.00") && warnBar === "85%" &&
      rows[0].includes("smoke@rozum.one") && zeroCap === "0";
  });

  await check("imgCost", async () => {
    // питання Олега було «спершу зрозуміти вартість» - панель мусить давати ЦИФРУ, а не обіцянку
    await page.evaluate(() => { selectView("brand"); setBTab("visual"); });
    await page.waitForSelector("#imgCostBtn", { timeout: 6000 });
    await page.click("#imgCostBtn");
    await page.waitForFunction(() => document.querySelectorAll("#imgCost .card").length >= 3, undefined, { timeout: 8000 });
    const t = await $t("#imgCost");
    return t.includes("$0.003") && t.includes("$0.011") && t.includes("$0.020") && t.includes("kie.ai");
  });

  await check("reelVisual", async () => {
    // перемикач ДОДАТКОВИЙ: стоковий шлях лишається дефолтним, а вибір моделі й ціна зʼявляються
    // лише коли явно ввімкнули AI-відео
    await page.evaluate(() => { selectView("brand"); setBTab("visual"); PRO = true; updateProUI(); });
    await page.waitForSelector("#reelVis", { timeout: 6000 });
    const def = await page.$eval("#reelVis", (el) => el.value);
    const hiddenAtFirst = !(await vis("#reelKieWrap"));
    await page.evaluate(() => { const s = document.getElementById("reelVis"); s.value = "ai"; s.onchange(); });
    await page.waitForFunction(() => {
      const s = document.getElementById("reelKieModel");
      return s && s.options.length >= 2;
    }, undefined, { timeout: 8000 });
    const st = await page.evaluate(() => ({
      shown: document.getElementById("reelKieWrap").style.display !== "none",
      opts: document.getElementById("reelKieModel").options.length,
      cost: document.getElementById("reelKieCost").textContent,
    }));
    await page.evaluate(() => { const s = document.getElementById("reelVis"); s.value = "stock"; s.onchange(); });
    await page.waitForTimeout(150);
    const backHidden = !(await vis("#reelKieWrap"));
    return def === "stock" && hiddenAtFirst && st.shown && st.opts === 2 &&
      st.cost.includes("$0.100") && st.cost.includes("$0.40") && backHidden;
  });

  await check("foldedPanels", async () => {
    await page.evaluate(() => { selectView("brand"); setBTab("voice"); });
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => {
      const pfh = [...document.querySelectorAll(".panel .pfh")];
      const folded = pfh.filter((s) => s.closest(".panel").classList.contains("folded"));
      return { pfh: pfh.length, folded: folded.length, labels: pfh.map((s) => s.textContent) };
    });
    // клік по рядку-заголовку розгортає панель
    await page.evaluate(() => { const s = document.querySelector(".panel.folded .pfh"); if (s) s.click(); });
    await page.waitForTimeout(150);
    const opened = await page.evaluate(() => document.querySelectorAll(".panel .pfh").length - document.querySelectorAll(".panel.folded .pfh").length);
    return st.pfh >= 5 && st.folded === st.pfh && st.labels.some((l) => l.includes("налаштувати")) && opened >= 1;
  });

  await check("topicMode", async () => {
    await page.evaluate(() => openAddMaterial());
    await page.waitForSelector(".modal #amTopic", { timeout: 4000 });
    const st = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll(".modal [data-m]")].map((t) => ({ m: t.dataset.m, on: t.classList.contains("on") }));
      return { tabs, chips: document.querySelectorAll(".modal #amCountChips [data-n]").length, gen: !!document.querySelector(".modal #amGen") };
    });
    await page.evaluate(() => { const x = document.querySelector(".modal #amX"); if (x) x.click(); });
    const topic = st.tabs.find((t) => t.m === "topic");
    return !!topic && topic.on && st.tabs.length === 2 && st.chips === 3 && st.gen;
  });

  await check("obTextFirst", async () => {
    // до апруву Meta текстовий шлях мусить бути ГОЛОВНОЮ кнопкою, а Instagram - другорядною з чесною
    // поміткою «для тестерів»; інакше перший дотик стороннього до сервісу закінчується помилкою OAuth
    await page.evaluate(() => { showOnboarding(); });
    await page.waitForFunction(() => document.getElementById("obNoIg"), undefined, { timeout: 6000 });
    const st = await page.evaluate(() => {
      const oc = document.getElementById("obNoIg").closest("#onboarding");
      const txt = document.getElementById("obNoIg"), ig = [...oc.querySelectorAll("button")].find((b) => b.textContent.includes("Instagram"));
      return { txtPrimary: txt.classList.contains("primary"), igPrimary: ig ? ig.classList.contains("primary") : null,
        order: txt.compareDocumentPosition(ig) & Node.DOCUMENT_POSITION_FOLLOWING ? "text-first" : "ig-first",
        note: oc.textContent.includes("тестерів"), title: document.getElementById("obTitle") ? document.getElementById("obTitle").textContent : oc.textContent.slice(0, 200) };
    });
    await page.evaluate(() => { document.getElementById("onboarding").style.display = "none"; });
    return st.txtPrimary && st.igPrimary === false && st.order === "text-first" && st.note && !/Підключи Instagram/.test(st.title);
  });

  await check("obNoIg", async () => {
    await page.evaluate(() => showOnboarding());
    await page.waitForSelector("#obNoIg", { timeout: 6000 });
    // напис свідомо без «без Instagram»: так текстовий шлях звучав як гірший варіант, а до апруву Meta
    // він - головний
    const ok = (await $t("#obNoIg")).includes("текстом");
    await page.evaluate(() => { document.getElementById("onboarding").style.display = "none"; });
    return ok;
  });

  // ---------------------------------------------------------- 8. 🦉 сова
  await check("owlGuide", async () => {
    await page.evaluate(() => { Guide.on = true; owlInit(); return loadGuide(); });
    await page.waitForFunction(() => { const b = document.getElementById("owlBubble"); return b && b.style.display === "block"; }, undefined, { timeout: 6000 });
    return (await $t("#owlText")).includes("Підключи канал") && (await has("#owlDo"));
  });

  await check("owlHome", async () => {
    // ✕ на бульбашці ЛИШЕ ховає підказку й вертає сову в гніздо (помічник не вимикається)
    await page.click("#owlBubbleX");
    // політ у гніздо триває ~620мс, і саме в його колбеку ставиться atHome - чекаємо на факт, не на таймер
    await page.waitForFunction(() => document.getElementById("owl").dataset.atHome === "1", undefined, { timeout: 5000 });
    const st = await page.evaluate(() => {
      const o = document.getElementById("owl");
      return { bubble: document.getElementById("owlBubble").style.display, atHome: o.dataset.atHome, shown: o.style.display };
    });
    return st.bubble === "none" && st.atHome === "1" && st.shown !== "none";
  });

  await check("owlDrag", async () => {
    const box = await page.$eval("#owlBody", (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const before = await page.$eval("#owl", (el) => el.style.left);
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x - 160, box.y - 120, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => ({ left: document.getElementById("owl").style.left, atHome: document.getElementById("owl").dataset.atHome }));
    return st.left !== before && st.atHome === "0";
  });

  await check("meetingHook", async () => {
    // приймач власного транскрибатора: адреса має доїхати з сервера (а не бути в розмітці),
    // і перевипуск має її ЗМІНИТИ - інакше «засвітилась адреса» лікувати нічим
    await page.evaluate(() => document.getElementById("umTools").click());
    await page.waitForFunction(() => {
      const el = document.querySelector("#toolsTransHost #mtUrl");
      return el && el.value.includes("/api/webhooks/meeting/");
    }, undefined, { timeout: 8000 });
    const before = await page.$eval("#mtUrl", (el) => el.value);
    const hint = await page.$eval("#mtPanel", (el) => el.textContent);
    await page.click("#mtRotate");
    await page.waitForFunction((v) => document.getElementById("mtUrl").value !== v, before, { timeout: 8000 });
    const after = await page.$eval("#mtUrl", (el) => el.value);
    return before.includes("tok-aaaa1111") && after.includes("tok-bbbb2222") &&
      hint.includes("Особисті нотатки") && (await $t("#mtMsg")).includes("нова адреса");
  });

  await check("meetingPull", async () => {
    // звірка - страховка поверх вебхука: перевірка зʼєднання і прохід на вимогу мусять давати
    // ЛЮДСЬКУ відповідь у панелі, інакше налаштувати її можна лише навмання
    const off = await $t("#mtPullState");
    await page.fill("#mtPullUrl", "https://vymova.rozum.one");
    await page.fill("#mtPullToken", "vym_test-token");
    await page.click("#mtPullTest");
    await page.waitForFunction(() => document.getElementById("mtPullState").textContent.includes("Зʼєднання є"), undefined, { timeout: 8000 });
    await page.click("#mtPullNow");
    await page.waitForFunction(() => document.getElementById("mtPullState").textContent.includes("Забрано"), undefined, { timeout: 8000 });
    const done = await $t("#mtPullState");
    // токен назад НЕ приходить - у полі лишається лише те, що ввели, а стан каже «збережено»
    const leak = await page.evaluate(() => document.getElementById("mtPanel").innerHTML.includes("vym_test-token"));
    return off.includes("вимкнена") && done.includes("курсор") && !leak;
  });

  // ---------------------------------------------------------- 12. Telegram Mini App (/tgapp)
  // Окрема сторінка з ПІДМІНЕНИМ SDK Telegram: справжній скрипт telegram.org у пісочниці
  // недосяжний, а без `initData` застосунок свідомо показує заглушку замість екрана.
  const tgPage = await browser.newPage({ viewport: { width: 390, height: 820 } });
  tgPage.on("pageerror", (e) => pageErrors.push("tgapp pageerror: " + e.message));
  await tgPage.route("**/*", (route) => {
    const u = route.request().url();
    return u.includes("127.0.0.1:" + PORT) || u.includes("localhost:" + PORT) ? route.continue() : route.abort();
  });
  await tgPage.addInitScript(() => {
    window.Telegram = { WebApp: { initData: "smoke-signed", ready() {}, expand() {}, HapticFeedback: { notificationOccurred() {} } } };
    window.confirm = () => true; window.alert = () => {}; window.prompt = () => "коротше";
  });
  await tgPage.goto(`http://127.0.0.1:${PORT}/tgapp`, { waitUntil: "domcontentloaded" });
  await tgPage.waitForFunction(() => document.querySelector("#view textarea"), undefined, { timeout: 15000 });
  const tgTab = async (t) => {
    await tgPage.click(`.tab[data-t="${t}"]`);
    await tgPage.waitForTimeout(120);
  };

  // SMOKE_SHOTS=1 - зняти екрани Mini App у .lint/ (вони в .gitignore). Верстку телефона
  // перевірками не побачиш: «дві однакові кнопки Запланувати» знайшлось саме скріншотом.
  if (process.env.SMOKE_SHOTS) {
    const shot = (n) => tgPage.screenshot({ path: join(HERE, `tgapp-${n}.png`), fullPage: true });
    await shot("1-new");
    await tgTab("drafts"); await tgPage.waitForSelector(".card[data-id]", { timeout: 8000 }); await shot("2-drafts");
    await tgPage.click(".card[data-id]"); await tgPage.waitForSelector(".sheet #et", { timeout: 8000 }); await shot("3-editor");
    await tgPage.click("#aWhen"); await tgPage.waitForSelector("#em .when button", { timeout: 6000 }); await shot("4-when");
    await tgPage.click("#aWhen"); await tgPage.click(".sheet #bk"); await tgTab("new"); await tgPage.waitForTimeout(300);
  }
  await check("tgappNew", async () => {
    // канали мусять доїхати з /me, а не бути захардкодженими в розмітці
    const nets = await tgPage.$$eval("#nets .net", (els) => els.map((e) => e.textContent.trim()));
    await tgPage.fill("#view textarea", "Новий пост із Mini App");
    await tgPage.click("#save");
    // збереження одразу відкриває редактор - інакше людина не знає, де шукати створене
    await tgPage.waitForSelector(".sheet #et", { timeout: 8000 });
    const opened = await tgPage.$eval(".sheet #et", (el) => el.value.length > 0);
    await tgPage.click(".sheet #bk");
    await tgPage.waitForTimeout(200);
    return nets.length === 2 && nets[0].includes("Telegram") && opened;
  });

  await check("tgappEditor", async () => {
    // фото з телефона, AI-фото і переписування - саме те, чого в застосунку не було
    await tgTab("drafts");
    await tgPage.waitForSelector(".card[data-id]", { timeout: 8000 });
    await tgPage.click(".card[data-id]");
    await tgPage.waitForSelector(".sheet #et", { timeout: 8000 });
    const acts = await tgPage.$$eval(".sheet .acts button", (els) => els.map((e) => e.textContent.trim()));
    await tgPage.click("#aAi");                              // AI-фото йде ДЖОБОЮ (перший опит «running»)
    await tgPage.waitForSelector(".sheet img.thumb", { timeout: 12000 });
    const pic = await tgPage.$eval(".sheet img.thumb", (el) => el.getAttribute("src"));
    await tgPage.click("#aRw");                              // переписування - теж джоба
    await tgPage.waitForFunction(() => document.querySelector(".sheet #et").value.includes("Переписаний"), undefined, { timeout: 12000 });
    return acts.length === 3 && acts.some((a) => a.includes("Фото")) && pic.includes("ai.jpg");
  });

  await check("tgappApprove", async () => {
    const before = await tgPage.$eval("#aAppr", (el) => el.textContent);
    await tgPage.click("#aAppr");
    await tgPage.waitForFunction(() => document.getElementById("aAppr").textContent.includes("Вернути"), undefined, { timeout: 6000 });
    const badge = await tgPage.$eval(".sheethead", (el) => el.textContent);
    return before.includes("Затвердити") && badge.includes("✅");
  });

  await check("tgappSchedule", async () => {
    await tgPage.click("#aWhen");
    await tgPage.waitForSelector("#em .when button", { timeout: 6000 });
    const slots = await tgPage.$$eval("#em .when button", (els) => els.map((e) => e.textContent));
    await tgPage.click("#em .when button");
    await tgPage.waitForSelector("#aUnsched", { timeout: 8000 });   // після планування видно дату й «скасувати»
    const pill = await tgPage.$eval(".sheet .meta .pill.warn", (el) => el.textContent);
    // план мусить показати той самий пост - без цього «запланував» лишалось словом
    await tgPage.click(".sheet #bk");
    await tgTab("plan");
    await tgPage.waitForSelector(".card[data-id]", { timeout: 8000 });
    const planned = await tgPage.$eval("#view", (el) => el.textContent);
    return slots.length >= 3 && pill.includes("🗓") && planned.includes("Переписаний");
  });

  await check("tgappPublish", async () => {
    await tgTab("drafts");
    await tgPage.waitForSelector(".card[data-id]", { timeout: 8000 });
    await tgPage.click(".card[data-id]");
    await tgPage.waitForSelector("#aPub", { timeout: 8000 });
    await tgPage.click("#aPub");
    // після публікації картка мусить перечитати ФАКТИЧНИЙ стан: канал стає ✓ і зʼявляється лінк
    await tgPage.waitForFunction(() => document.querySelector(".sheet .meta a"), undefined, { timeout: 15000 });
    const st = await tgPage.evaluate(() => ({
      link: document.querySelector(".sheet .meta a").getAttribute("href"),
      locked: !!document.querySelector('.sheet .net[disabled]'),
      noPub: !document.getElementById("aPub"),
      head: document.querySelector(".sheethead").textContent,
    }));
    return st.link.includes("t.me") && st.locked && st.noPub && st.head.includes("Опублікований");
  });

  await check("tgappMaterial", async () => {
    await tgPage.click(".sheet #bk");
    await tgTab("mats");
    await tgPage.waitForSelector("[data-mk]", { timeout: 8000 });
    await tgPage.click("[data-mk]");
    // матеріал → пост іде джобою і одразу відкриває редактор із написаним текстом
    await tgPage.waitForSelector(".sheet #et", { timeout: 15000 });
    return (await tgPage.$eval(".sheet #et", (el) => el.value.length > 5));
  });

  await browser.close();
  server.close();
};

run()
  .then(() => {
    const bad = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
    const n = Object.keys(results).length;
    console.log(JSON.stringify(results, null, 1));
    console.log(`\nsmoke: ${n - bad.length}/${n}` + (bad.length ? "  ❌ " + bad.join(", ") : "  ✅"));
    console.log("errors: " + (pageErrors.length ? "\n  " + pageErrors.join("\n  ") : "none"));
    process.exit(bad.length || pageErrors.length ? 1 : 0);
  })
  .catch((e) => {
    console.error("smoke упав:", e);
    try { server.close(); } catch (_) {}
    process.exit(1);
  });
