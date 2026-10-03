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
// 📈 дані для екрана Аналітики рахує СПРАВЖНІЙ модуль (dist/analytics.js), а не рукописна заглушка:
// інакше смоук перевіряв би верстку проти форми даних, якої сервер ніколи не віддає
import { buildAnalytics } from "../dist/analytics.js";
// 🏠 лендинг рендерить СПРАВЖНІЙ модуль (dist/landing.js): статуси мереж підставляє сервер
import { renderLanding } from "../dist/landing.js";

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
// 🖼 карусель: P4 відкривається лише в композері (у Студії його нема, тож лічильники інших перевірок
// не рухаються); кадри постів у заглушці СТАНОВІ - додати/переставити/прибрати/зібрати змінюють їх
const P4 = "44444444-4444-4444-4444-444444444444";
const P4POST = { id: P4, content: "Карусель для перевірки", review: "review", channels: { instagram: { on: true }, telegram: { on: true }, threads: { on: true } }, format: "carousel", rubric: "", intent: "", sent: [], links: {} };
const CAR = new Map([
  ["11111111-1111-1111-1111-111111111111", [{ id: "f1", filename: "pic.jpg" }, { id: "f2", filename: "pic2.jpg" }, { id: "f3", filename: "pic3.jpg" }]],
  [P4, [{ id: "g1", filename: "g1.jpg" }, { id: "g2", filename: "g2.jpg" }, { id: "g3", filename: "g3.jpg" }]],
]);
const carCalls = [];
// 🎬 відео-пост: відкривається лише в композері; відео завелике для Telegram (60 МБ) і задовге для Threads (6:40)
const P5 = "55555555-5555-5555-5555-555555555555";
const P5POST = { id: P5, content: "Ранок у глемпінгу", review: "review", channels: { instagram: { on: true }, telegram: { on: true }, threads: { on: true } }, format: "post", rubric: "", intent: "", sent: [], links: {} };
CAR.set(P5, [{ id: "v5", filename: "big.mp4", kind: "video", duration: 400, width: 720, height: 1280, size: 60 * 1048576 }]);
// ⚡ сторіс: 3 кадри (фото, фото, відео); Telegram увімкнено - режим сторіс мусить його затінити
const P7 = "77777777-7777-7777-7777-777777777777";
const P7POST = { id: P7, content: "Ранок у глемпінгу", review: "review", channels: { instagram: { on: true }, facebook: { on: true }, telegram: { on: true } }, format: "story", rubric: "", intent: "", sent: [], links: {} };
CAR.set(P7, [{ id: "s1", filename: "s1.jpg", kind: "image" }, { id: "s2", filename: "s2.jpg", kind: "image" }, { id: "s3", filename: "s3.mp4", kind: "video", duration: 6 }]);
// 💬 перший коментар: P8 - чернетка (Instagram, LinkedIn, Telegram), P9 - уже вийшов в Instagram і
// LinkedIn; коментар в Instagram стоїть, у LinkedIn - не вийшов (стан змінює «Надіслати коментар»)
const P8 = "88888888-8888-8888-8888-888888888888";
const P8POST = { id: P8, content: "Три речі, які беремо в похід", review: "review", channels: { instagram: { on: true }, linkedin: { on: true }, telegram: { on: true } }, format: "post", rubric: "", intent: "", first_comment: "Список речей: https://rozum.one/list", sent: [], links: {} };
CAR.set(P8, [{ id: "c8", filename: "p8.jpg", kind: "image" }]);
const P9 = "99999999-9999-9999-9999-999999999999";
const P9POST = { id: P9, content: "Осінь у горах", review: "approved", channels: { instagram: { on: true }, linkedin: { on: true } }, format: "post", rubric: "", intent: "", first_comment: "Маршрут: https://rozum.one/trail", sent: ["instagram", "linkedin"], links: {} };
CAR.set(P9, [{ id: "c9", filename: "p9.jpg", kind: "image" }]);
// 🎬 YouTube і TikTok: вертикальне відео 45 с, обрано лише Instagram (YouTube і TikTok вмикає кнопка «＋ Увімкнути»)
const P10 = "10101010-1010-1010-1010-101010101010";
// ✍️ «Новий пост»: порожня чернетка (POST /posts/blank); видалення порожньої при закритті пишемо в blankDeletes
const PNEW = "12121212-1212-1212-1212-121212121212";
const PNEWPOST = { id: PNEW, content: "", review: null, channels: {}, format: "post", rubric: "", intent: "", sent: [], links: {} };
const blankDeletes = [];
// ⏳ TikTok ще обробляє відео: стан публікації спершу «processing», з другого запиту - готово з посиланням
const P11 = "13131313-1313-1313-1313-131313131313";
const P11POST = { id: P11, content: "Our own video", review: "approved", channels: { tiktok: { on: true, mode: "direct", privacy: "SELF_ONLY" } }, format: "post", rubric: "", intent: "", sent: [], links: {} };
CAR.set(P11, [{ id: "v11", filename: "v11.mp4", kind: "video", duration: 12, width: 1080, height: 1920, size: 8 * 1048576 }]);
let p11Polls = 0;
const P10POST = { id: P10, content: "Як ми зекономили 3 години на тиждень\nДеталі в описі #holos", review: "review", channels: { instagram: { on: true } }, format: "post", rubric: "", intent: "", sent: [], links: {} };
CAR.set(P10, [{ id: "v10", filename: "v10.mp4", kind: "video", duration: 45, width: 1080, height: 1920, size: 30 * 1048576 }]);
const TT_CREATOR = { ok: true, direct: true, nickname: "Holos", username: "holos_rozum", avatarUrl: "", privacyOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"], commentDisabled: false, duetDisabled: true, stitchDisabled: false, maxDurationSec: 60 };
const FC9 = { comments: [{ network: "instagram", status: "sent" }, { network: "linkedin", status: "failed", error: "LinkedIn не дав застосунку дозволу коментувати від імені профілю." }] };
const fcSends = [];   // POST /posts/:id/first-comment/send
const altPuts = [];   // PUT /media/:id/alt - опис фото
const postPuts = [];  // PUT /posts/:id - що композер зберіг (текст, перший коментар)
// заливка частинами: сервер-заглушка тримає «скільки вже прийшло» на кожен uid, як справжній
const CHUNKS = new Map();
const chunkPuts = [];
const videoCalls = [];
const chanSaves = [];   // що композер зберіг як мережі поста (POST /posts/:id/channels)
const accOps = [];      // 👥 дії з акаунтами в Каналах (додати / основний / прибрати)
const tgOps = [];       // 📣 канали Telegram у Каналах (додати / прибрати)
let P8STATE = null;     // стан публікації P8 для перевірок «вийшло не в усі акаунти»

const POSTS = [
  {
    id: P1, content: "Слайд 1: чому підрядники зникають\nСлайд 2: що з цим робити", review: "review",
    channels: { telegram: { on: true }, threads: { on: true } }, rubric: "Кейси", source_origin: "diary",
    format: "carousel", intent: "awareness", media_filename: "pic.jpg", media_count: 3,
    qa: { director: "partial", aiaudit: 3, storytelling: 5 }, sent: [], links: {},
  },
  {
    id: P2, content: "Затверджений пост про ціни", review: "approved",
    channels: { telegram: { on: true }, instagram: { on: true } }, rubric: "Освіта", source_origin: "manual",
    format: "post", intent: "sale", sent: [], links: {}, repeat_of: "egA",
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
    { id: "sl2", post_id: "egR1", scheduled_at: iso(1, 15), status: "planned", content: "Свіжий гачок про ті самі 3 помилки", channels: null, repeat_of: "egA" },
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
    evergreen: { on: true, next: [{ id: "egR1", of: "egA", at: iso(1, 17), title: "Свіжий гачок про ті самі 3 помилки", nets: ["threads", "telegram"] }] },
  },
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
    saved: { usd: 1.47, calls: 21 },
    cap: { spentDay: 2.55, spentMonth: 7.1, capDay: 3, capMonth: 30 },
  },
  "GET /admin/health": { errorCount: 2, warnCount: 5, spendToday: 1.23, runningJobs: 1, lostJobs: 0, lastBackup: "socialio-db-20260902-0320.dump (164K)",
    errors: [{ level: "error", scope: "publish", message: "Telegram відмовив у доступі (403)", n: 2 }, { level: "warn", scope: "meeting", message: "хеш транскрипта не збігся", n: 5 }] },
  "GET /admin/alerts": { instance: "Holos · бета",
    settings: { tg: true, email: true, emailAll: false, emails: [], digest: true, digestHour: 9, tz: "Europe/Prague", failover: true, orLow: 2, muteUntil: null, watchUrl: "" },
    channels: { tg: { bot: "R_Socialio_bot", chats: 1 }, email: { to: ["o.stepeniev@swipescape.eu"], ok: true } },
    failover: { on: true, via: "OpenAI (gpt-4o)" }, buddy: { url: "https://holos.rozum.one/health", fails: 0 },
    open: [{ id: "7", fp: "ai_funds:OpenRouter", severity: "critical", title: "OpenRouter: закінчились кошти", count: 1440, first_at: "2026-09-26T05:59:00Z", last_at: "2026-09-30T05:00:00Z", notified_at: "2026-09-30T05:00:05Z",
      hint: "Поповни рахунок OpenRouter: https://openrouter.ai/settings/credits." }], recent: [] },
  "GET /admin/spend": { defaults: { day: 3, month: 30, callsPerMin: 40 },
    cli: { up: true, tokenSet: true, busy: 0, queued: 0, cooldown: "" },
    workspaces: [
      { id: "ws-1", emails: "smoke@rozum.one", day: 2.55, month: 7.1, calls: 12, spend_cap_day: null, spend_cap_month: null, cli_enabled: false },
      { id: "ws-2", emails: "oleg@rozum.one", day: 0.4, month: 9.9, calls: 3, spend_cap_day: 0, spend_cap_month: 0, cli_enabled: true },
    ] },
  "GET /media": [{ id: "mv1", filename: "lib.mp4", kind: "video", source: "upload", duration: 75, width: 720, height: 1280, size: 12000000, created_at: iso(0, 9) },
    { id: "md1", filename: "pic.jpg", kind: "image", source: "upload", created_at: iso(0, 8) },
    { id: "md2", filename: "pic2.jpg", kind: "image", source: "upload", created_at: iso(0, 7) },
    { id: "md3", filename: "pic3.jpg", kind: "image", source: "upload", created_at: iso(0, 6) },
    { id: "ma1", filename: "hlas.ogg", kind: "audio", source: "bot", duration: 35, created_at: iso(0, 5) }],
  "GET /sources/recent": [],
  "GET /sources/rss": { feeds: [] },
  "GET /lead-magnets": { magnets: [] },
  "GET /integrations/telegram": { channelChatId: "-1001234567890", groupChatId: "", hasToken: true, sharedBot: true, sharedDm: false, sharedWhy: "env", sharedHost: "", usesShared: true, admin: true, channelTitle: "Мій канал", bot: "holos_rozum_bot", formerBot: "R_Socialio_bot",
    chats: [{ id: "-1001234567890", name: "Мій канал", main: true, kind: "channel", username: "mychan", posts: 0 }, { id: "-1002", name: "Канал компанії", main: false, kind: "extra", username: "", posts: 2 }] },
  "GET /integrations/threads": { connected: true, username: "brand" },
  "GET /integrations/meta": { connected: false },
  "GET /integrations/linkedin": { connected: false, available: false },
  "GET /integrations/youtube": { connected: false, available: false },
  "GET /integrations/tiktok": { connected: false, available: false },
  "GET /integrations/tiktok/creator": TT_CREATOR,
  "GET /integrations/gdrive": { connected: false, available: false },
  "GET /integrations/transcription": { hasKey: false, webhookUrl: "", hasSecret: false, autoRun: false },
  "GET /workspaces": { items: [{ id: "11111111-1111-1111-1111-111111111111", title: "Бренд А", role: "owner" },
                                { id: "22222222-2222-2222-2222-222222222222", title: "Бренд Б", role: "member" }],
                        active: "11111111-1111-1111-1111-111111111111", home: "11111111-1111-1111-1111-111111111111" },
  "GET /workspaces/members": { items: [{ user_id: "u1", email: "smoke@rozum.one", role: "owner" },
                                       { user_id: "u2", email: "friend@rozum.one", role: "member" }], owner: true, me: "u1" },
  "GET /integrations/mcp": { connected: true, url: "https://socialio.rozum.one/mcp/" + "a1b2c3d4".repeat(8), lastUsed: iso(-1, 10), tools: 16 },
  "GET /integrations/images": { provider: "gemini", available: { openai: true, fal: false, gemini: true, cloudflare: true } },
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
const mtCalls = [];
// 🎬 монтаж v3: стиль відео бренду й обкладинка Reels
const styleCalls = [], coverCalls = [];
let MV_STYLE = { subtitle: "classic", color: "#FFD23F", position: "low", hook: true, end: true, endText: "", cut: true };
const MV_CAPS_EXTRA = {
  templates: [
    { id: "standard", label: "🎬 Стандарт", hint: "кліпи по черзі, найкращі моменти, плавні переходи", mood: null },
    { id: "before_after", label: "↔️ До / після", hint: "спершу кліпи «до», потім «після»", mood: "upbeat" },
    { id: "talking", label: "🗣 Говорю в камеру", hint: "мова цілком, без пауз і «еее»", mood: null },
    { id: "process", label: "⚡ Процес", hint: "короткі прискорені шматки роботи", mood: "energetic" },
  ],
  subStyles: [["classic", "Класичні"], ["brand", "Колір бренду"], ["box", "На плашці"], ["big", "Великі слова"], ["minimal", "Мінімальні"]].map(([id, label]) => ({ id, label, hint: "підказка " + id })),
};
const MV_END = { title: "Vary Servis & Úklid", sub: "Karlovy Vary · @servisvary" };
const alertCalls = [];
const AI_JOB_RESULT = new Map();

// Пости: /full і /publish-state обслуговуються окремо (шлях із id).
// Ключі провайдерів: заглушка СТАНОВА, бо перевіряється саме перехід «не заданий → з адмінки»
// і те, що введене значення назад НЕ приходить (у відповіді лише хвіст із 4 символів).
const KEYS = [
  { name: "OPENAI_API_KEY", label: "OpenAI", hint: "тексти й зображення", group: "text", set: true, source: "env", tail: "aB12" },
  { name: "KIE_API_KEY", label: "kie.ai", hint: "AI-відео для рілсів", group: "video", set: false, source: "none", tail: "" },
  { name: "TELEGRAM_BOT_TOKEN", label: "Спільний Telegram-бот", hint: "один бот на всіх", group: "bot", set: true, source: "env", tail: "old1" },
];
const botPuts = [];   // PUT /admin/keys/TELEGRAM_BOT_TOKEN: з force чи без
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
const TG_BRAND = { cur: "w1", calls: [] };
function handleTg(method, path, body) {
  // 🏢 два бренди: перемикач угорі Mini App (той самий вибір, що /brand у боті)
  if (path === "/me") return { ok: true, drafts: 2, materials: 2, nets: ["telegram", "threads"], tz: "Europe/Kyiv",
    brand: TG_BRAND.cur, brands: [{ id: "w1", title: "oleg@test.dev" }, { id: "w2", title: "Vary Servis & Úklid" }] };
  if (method === "POST" && path === "/brand") { TG_BRAND.calls.push(body?.id); TG_BRAND.cur = body?.id; return { ok: true, title: "Vary Servis & Úklid" }; }
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
let mtToken = "tok-aaaa1111", mtPull = false, sttProv = "auto";
const brandDeleted = [];
const mediaPosts = [];   // скільки файлів прийшло в КОЖНОМУ запиті завантаження в медіатеку
const mediaBytes = [];   // і скільки байтів у кожному (nginx на беті пропускає до 20 МБ)

// ---- 📈 синтетичні публікації для Аналітики (детерміновано: той самий набір щоразу) ----
const anQueries = [];
let anRefreshes = 0;
// 💬 коментарі в одному місці: заглушка СТАНОВА - відповідь і «пропустити» прибирають коментар, як на сервері;
// cmNeeds - сценарій «Meta ще не дала дозволу читати коментарі Facebook»
const CM_ITEMS = [
  { net: "instagram", commentId: "igc1", username: "fan1", comment: "Де купити такий рюкзак?", postTitle: "Похід у Карпати", timestamp: iso(0, 1), permalink: "https://instagram.com/p/U1", account: "igu", accountName: "@olegalisio", draft: "Deuter, посилання в профілі 🙂" },
  { net: "instagram", commentId: "igc2", username: "hotel_owner", comment: "А скільки коштує впровадження?", postTitle: "Кейс: AI у готелі", timestamp: iso(0, 2), permalink: null, account: "igr", accountName: "@rozum.one", draft: "Напишіть у Direct - порахуємо" },
  { net: "facebook", commentId: "fbc1", username: "Марія Коваль", comment: "Підкажіть контакти", postTitle: "Допис Сторінки", timestamp: iso(0, 3), permalink: null, account: "pg1", accountName: "", draft: "Пишіть у Messenger" },
  { net: "threads", commentId: "thc1", username: "fan_th", comment: "А як записатись?", postTitle: "Пост про AI", timestamp: iso(0, 4), permalink: null, account: "thr", accountName: "", draft: "Посилання в профілі!" },
];
const cmDone = new Set(), cmCalls = [];
// ⏰ найкращий час з власних даних: заглушка СТАНОВА - перемикач пишеться й читається назад
const BT_ITEMS = [
  // усі пости Threads зі статистикою - @rozum.one: рядок мережі (show: false) лишається лише для календаря
  { key: "threads", net: "threads", account: null, accountName: null, n: 14, ready: true, times: ["19:30"], show: false,
    best: [{ key: "w18", label: "18-21", n: 6, median: 1.4, score: 1.29, time: "19:30" }], worst: { key: "w9", label: "9-12", n: 6, median: 0.6, score: 0.71, time: "09:30" },
    text: "Threads: найкраще о 18-21 - ×1.4 від твоєї норми (6 постів); найслабше о 9-12 - ×0.6 (6 постів). Найкращий час для постів - 19:30." },
  { key: "threads:thr", net: "threads", account: "thr", accountName: "@rozum.one", n: 14, ready: true, times: ["19:30"], show: true,
    best: [{ key: "w18", label: "18-21", n: 6, median: 1.4, score: 1.29, time: "19:30" }], worst: { key: "w9", label: "9-12", n: 6, median: 0.6, score: 0.71, time: "09:30" },
    text: "Threads @rozum.one: найкраще о 18-21 - ×1.4 від твоєї норми (6 постів); найслабше о 9-12 - ×0.6 (6 постів). Найкращий час для постів - 19:30." },
  { key: "threads:thu", net: "threads", account: "thu", accountName: "@olegalisio", n: 0, ready: false, times: [], best: [], worst: null, show: true,
    text: "Threads @olegalisio: своїх постів зі статистикою ще нема - тож календар ставить його пости в час @rozum.one: 19:30. Свій час Holos порахує сам, щойно набереться 10." },
  { key: "facebook:p2", net: "facebook", account: "p2", accountName: "Rozum.one", n: 0, ready: false, times: [], best: [], worst: null, show: false,
    text: "Facebook Rozum.one: поки 0 постів зі статистикою (дозрілі, від 2 діб) - для поради треба 10. Holos порахує сам, щойно їх набереться." },
  { key: "instagram", net: "instagram", account: null, accountName: null, n: 12, ready: true, times: [], best: [], worst: null, show: true,
    text: "Instagram: час публікації майже не впливає (2 вікна доби з 12 постів, різниця менша за 10%) - став, коли зручно." },
];
let btAuto = true;
const btPuts = [];
let cmNeeds = false;
let cmNotify = true; const cmNotifyPuts = [];
function cmInbox(path) {
  const qp = new URL(path, "http://x").searchParams;
  const items = CM_ITEMS.filter((x) => !cmDone.has(x.commentId) && !(cmNeeds && x.net === "facebook"));
  const counts = { instagram: 0, facebook: 0, threads: 0 }; items.forEach((x) => counts[x.net]++);
  const needs = cmNeeds ? [{ net: "facebook", perm: "inbox", text: "Facebook: щоб бачити коментарі під дописами Сторінки, дай дозвіл" }] : [];
  const connected = ["instagram", "facebook", "threads"];
  if (qp.get("countOnly") === "1") return { count: items.length, counts, needs, connected };
  return { items, counts, needs, errors: [], connected, hint: "" };
}
function anRows() {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const DAY = 864e5, now = Date.now(), rows = [];
  const firsts = ["Чому клієнти йдуть після першої зустрічі?", "5 помилок власника глемпінгу", "Я помилився в найпростішому.", "Скільки коштує порожній будиночок у травні", "Що я зрозумів за рік роботи з гостями."];
  const body = " Ми довго думали, що справа в ціні. Виявилось - у тому, як ми відповідаємо на перше повідомлення.";
  const rubrics = ["Кейси", "Поради", "Особисте", "Новини ніші"], intents = ["awareness", "awareness", "nurture", "sale"], origins = ["diary", "topic", "mcp", "rss"];
  let n = 0;
  const add = (net, ago, over) => {
    n++;
    const hour = [8, 13, 19, 22][n % 4], first = firsts[n % firsts.length];
    const at = new Date(now - ago * DAY); at.setUTCHours(hour - 3, 10, 0, 0);
    const text = first + "\n" + body.repeat(1 + (n % 4) * 3);
    rows.push({ post_id: "an-" + n, net, created_at: at.toISOString(), permalink: net === "telegram" ? "https://t.me/mychannel/" + n : null, text,
      format: "post", rubric: rubrics[n % 4], intent: intents[n % 4], origin: origins[n % 4], media_kind: "text",
      views: null, reach: null, likes: null, replies: null, reposts: null, quotes: null, shares: null, saves: null, m_error: null, fetched_at: new Date(now - 3 * 3600e3).toISOString(), ...over(n, hour, first) });
  };
  // Threads: каруселі й вечір - сильніші, питання в першому рядку - слабше; + попередній період
  for (let i = 0; i < 70; i++) add("threads", 1 + i * 2.5, (k, hour, first) => {
    const media = ["text", "text", "photo", "carousel", "text"][k % 5];
    const f = (media === "carousel" ? 2 : media === "photo" ? 1.2 : 1) * (hour === 19 ? 1.4 : hour === 8 ? 0.8 : 1) * (first.endsWith("?") ? 0.8 : 1) * (0.8 + rnd() * 0.4) * (i < 36 ? 1.25 : 1);
    const v = Math.round(1500 * f);
    return { media_kind: media, views: v, likes: Math.round(v * 0.03), replies: Math.round(v * 0.005), reposts: Math.round(v * 0.003), quotes: Math.round(v * 0.001), shares: Math.round(v * 0.002) };
  });
  for (let i = 0; i < 16; i++) add("instagram", 2 + i * 5, (k) => {
    const media = ["photo", "carousel", "video", "photo"][k % 4];
    const v = Math.round(800 * (media === "carousel" ? 1.7 : media === "video" ? 2.4 : 1) * (0.8 + rnd() * 0.4));
    return { media_kind: media, views: v, reach: Math.round(v * 0.8), likes: Math.round(v * 0.05), replies: Math.round(v * 0.004), saves: Math.round(v * 0.01), shares: Math.round(v * 0.006) };
  });
  // Facebook: реакції є, а перегляди Meta не віддала (нема дозволу на статистику постів)
  for (let i = 0; i < 10; i++) add("facebook", 3 + i * 8, () => ({ media_kind: "photo", likes: 4 + (i % 5), replies: i % 3, shares: i % 2, m_error: "перегляди недоступні: Meta не дає на це дозволу ((#10) Application does not have permission) - перепідключи у Налаштування → Канали." }));
  for (let i = 0; i < 20; i++) add("telegram", 1 + i * 4, () => ({ fetched_at: null }));
  return rows;
}
const AN_ROWS = anRows();
function anFollowers() {
  const out = [], now = Date.now();
  const day = (ago) => new Date(now - ago * 864e5).toISOString().slice(0, 10);
  for (let ago = 120; ago >= 0; ago -= 3) {
    out.push({ network: "threads", day: day(ago), followers: 1000 - ago * 2 });
    out.push({ network: "instagram", day: day(ago), followers: 5100 - Math.round(ago * 1.5) });
    out.push({ network: "telegram", day: day(ago), followers: 340 - Math.round(ago / 3) });
  }
  out.push({ network: "facebook", day: day(0), followers: 1200 }); // один знімок - «зміну покаже з наступних днів»
  return out;
}
const AN_FOLLOW = anFollowers();

// ♻️ вічнозелена черга: СТАНОВА заглушка - перевірки доводять «натиснув → збереглось → видно»
const EG = {
  settings: { on: false, perWeek: 2, gapWeeks: 6, maxRepeats: 3, fresh: true, autoAdd: true, minMult: 1.5 },
  items: [
    { postId: "egA", title: "3 помилки, які коштують готелю гостей", addedBy: "auto", status: "active", note: null, force: false, bestMult: 3.2,
      repeats: 1, firstSentAt: iso(-60, 17), lastAt: iso(1, 17), nextAt: iso(43, 17), nets: ["threads", "telegram"] },
    { postId: "egB", title: "Акція до 30.09: знижка 20%", addedBy: "auto", status: "off", note: "прив'язаний до дати чи події: акція з дедлайном", force: false,
      bestMult: 4, repeats: 0, firstSentAt: iso(-20, 10), lastAt: null, nextAt: null, nets: ["instagram"] },
  ],
  upcoming: [{ id: "egR1", of: "egA", at: iso(1, 17), title: "Свіжий гачок про ті самі 3 помилки", nets: ["threads", "telegram"] }],
  hits: [{ postId: "egH", title: "Чому готелі губляться в пошуку", mult: 2.1 }],
};
const egCalls = [];
function egView() { return { settings: EG.settings, tz: "Europe/Kyiv", weekUsed: 1, items: EG.items, upcoming: EG.upcoming, hits: EG.hits }; }
function handleEvergreen(method, path, body) {
  if (method === "GET" && path === "/evergreen") return egView();
  if (method === "PUT" && path.startsWith("/evergreen/settings")) { Object.assign(EG.settings, body || {}); egCalls.push({ k: "settings", body }); return { ok: true, settings: EG.settings }; }
  const m = /^\/evergreen\/([\w-]+)(?:\/(force|repeat))?$/.exec(path);
  if (!m) return null;
  const [, id, act] = m;
  egCalls.push({ k: act || method, id });
  if (method === "DELETE") { const it = EG.items.find((x) => x.postId === id); if (it) { it.status = "off"; it.note = "прибрано з черги"; }
    const sp = POSTS.find((x) => x.id === id); if (sp) sp.evergreen = "off"; return { ok: true }; }
  if (act === "force") { const it = EG.items.find((x) => x.postId === id); if (it) { it.status = "active"; it.note = null; it.force = true; } return { ok: true }; }
  if (act === "repeat") { EG.upcoming.push({ id: "egR2", of: id, at: iso(2, 9), title: "Повтор", nets: ["threads"] }); return { ok: true, repeatId: "egR2", at: iso(2, 9), nets: ["threads"] }; }
  // додати: хіт чи опублікований пост зі Студії
  const hit = EG.hits.find((h) => h.postId === id);
  if (hit) { EG.hits = EG.hits.filter((h) => h !== hit); EG.items.unshift({ postId: id, title: hit.title, addedBy: "user", status: "active", note: null, force: false, bestMult: hit.mult, repeats: 0, firstSentAt: iso(-30, 10), lastAt: null, nextAt: iso(-1, 10), nets: ["threads"] }); }
  const sp = POSTS.find((x) => x.id === id); if (sp) sp.evergreen = "active";
  return { ok: true, state: "added", postId: id };
}

// 🔗 Посилання і сторінка в біо: стан заглушки + журнал викликів (перевірки linksPanel/linksBio)
const LK = {
  settings: { auto: true, utm: true },
  bio: { enabled: true, slug: "kemp.carlsbad", title: "Kemp Carlsbad", bio: "Глемпінг біля Карлових Вар", showPosts: true, views: 5, url: "http://x/@kemp.carlsbad",
    links: [{ id: "a1b2c3", title: "Забронювати", url: "https://rozum.one/glamp", emoji: "🏕" }, { id: "d4e5f6", title: "Instagram", url: "https://instagram.com/kemp.carlsbad", emoji: "" }] },
  stats: { days: 30, total: 3, byNet: { threads: 2, bio: 1 }, bioViews: 5,
    top: [{ code: "Th1abcd", short: "http://x/s/Th1abcd", url: "https://rozum.one/glamp?utm_source=threads", source: "https://rozum.one/glamp", title: null, network: "threads", kind: "post", postId: "p1", postTitle: "Відкрили запис на осінь", clicks: 2, total: 2 },
      { code: "Bio1234", short: "http://x/s/Bio1234", url: "https://rozum.one/glamp?utm_source=bio", source: "https://rozum.one/glamp", title: "Забронювати", network: "bio", kind: "bio", postId: null, postTitle: null, clicks: 1, total: 1 },
      { code: "Bio9999", short: "http://x/s/Bio9999", url: "https://instagram.com/kemp.carlsbad?utm_source=bio", source: "https://instagram.com/kemp.carlsbad", title: "Instagram", network: "bio", kind: "bio", postId: null, postTitle: null, clicks: 0, total: 0 }] },
};
const lkCalls = [];
function handleLinks(method, path, body) {
  if (method === "GET" && path.startsWith("/links") && !path.startsWith("/links/")) return { settings: LK.settings, bio: LK.bio, stats: LK.stats };
  if (method === "PUT" && path === "/links/settings") { lkCalls.push({ k: "settings", body }); Object.assign(LK.settings, body || {}); return { ok: true, settings: LK.settings }; }
  if (method === "PUT" && path === "/links/bio") {
    lkCalls.push({ k: "bio", body });
    const slug = String(body?.slug || "").trim().toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$/.test(slug)) return { __status: 400, error: "Адреса сторінки: 3-30 латинських літер чи цифр, можна «.», «-» і «_» посередині" };
    LK.bio = { ...LK.bio, enabled: !!body.enabled, slug, title: body.title, bio: body.bio, showPosts: body.showPosts !== false,
      links: (body.links || []).filter((l) => l.title || l.url).map((l, i) => ({ id: l.id || "n" + i, title: l.title, url: l.url, emoji: l.emoji || "" })) };
    return { ok: true, bio: LK.bio };
  }
  if (method === "POST" && path === "/links/shorten") {
    lkCalls.push({ k: "shorten", body });
    return /^https?:\/\/[^/]+\.[a-z]/i.test(String(body?.url || "")) ? { ok: true, code: "Man5678", short: "http://x/s/Man5678" } : { __status: 400, error: "Потрібна повна адреса з https://" };
  }
  return null;
}

function handleApi(method, path, body) {
  if (method === "GET" && path.startsWith("/analytics/posts")) {
    const qp = new URL(path, "http://x").searchParams;
    const days = [7, 30, 90, 180, 365].includes(+qp.get("days")) ? +qp.get("days") : 90, net = qp.get("net") || "all";
    anQueries.push({ days, net });
    return { ...buildAnalytics(AN_ROWS, AN_FOLLOW, { days, net, tz: "Europe/Kyiv" }), connected: { threads: true, meta: true, telegram: true, linkedin: false }, best: BT_ITEMS, bestAuto: btAuto };
  }
  if (method === "POST" && path === "/analytics/refresh") {
    anRefreshes++; aiJobPolls = 0; AI_JOB_RESULT.set("job-an", { posts: 7, followers: 3 });
    return { jobId: "job-an" };
  }
  if (path.startsWith("/tg/")) return handleTg(method, path.slice(3), body);
  if (path.startsWith("/evergreen")) { const r = handleEvergreen(method, path, body); if (r) return r; }
  if (path.startsWith("/links")) { const r = handleLinks(method, path, body); if (r) return r; }
  if (method === "DELETE" && /^\/posts\/egR\d$/.test(path)) { egCalls.push({ k: "cancel", id: path.split("/")[2] }); EG.upcoming = EG.upcoming.filter((u) => u.id !== path.split("/")[2]); return { ok: true }; }
  if (method === "GET" && path.startsWith("/best-times")) return { auto: btAuto, tz: "Europe/Kyiv", items: BT_ITEMS, mains: { threads: "thu", instagram: "ig1", facebook: "p1" } };
  if (method === "PUT" && path === "/settings/best_time_auto") { btAuto = String(body?.content) !== "0"; btPuts.push(String(body?.content)); return { ok: true }; }
  if (method === "POST" && path === "/schedule/auto") return { ok: true, count: 3, bestTime: btAuto ? { threads: ["19:30"] } : {} };
  if (path === "/comments/notify") { if (method === "PUT") { cmNotify = body?.on !== false; cmNotifyPuts.push(cmNotify); } return { on: cmNotify, bot: true }; }
  if (method === "GET" && path.startsWith("/comments/inbox")) return cmInbox(path);
  if (method === "POST" && (path === "/comments/reply" || path === "/comments/skip")) {
    cmCalls.push({ path, body });
    // Facebook без дозволу відповідати - відмова (кнопка знову активна, картка не «зроблена»)
    if (path === "/comments/reply" && body?.commentId === "fbc1") return { __status: 400, error: "Facebook: Meta ще не дала дозволу відповідати на коментарі - «💬 Дозволити коментарі»" };
    cmDone.add(body?.commentId);
    const it = CM_ITEMS.find((x) => x.commentId === body?.commentId);
    return path === "/comments/reply" ? { ok: true, id: "r1", accountName: it?.accountName || "@olegalisio" } : { ok: true };
  }
  const key = method + " " + path.split("?")[0];
  if (key === "GET /admin/keys") return { keys: KEYS, kie: { ready: KEYS[1].set, credits: KEYS[1].set ? 1200 : null } };
  if (method === "PUT" && path.startsWith("/admin/keys/")) {
    const name = path.split("/")[3];
    // спільний бот, чий вебхук веде на інший сервіс: перший раз - 409 з питанням, «забрати» - лише з force
    if (name === "TELEGRAM_BOT_TOKEN") {
      botPuts.push(body?.force === true ? "force" : "plain");
      if (body?.force !== true) return { __status: 409, foreign: "holos.rozum.one", error: "Бот @R_Socialio_bot зараз працює на holos.rozum.one: туди веде його вебхук. Забрати його сюди все одно?" };
    }
    const k = KEYS.find((x) => x.name === name);
    const v = String((body && body.value) || "");
    if (k && v) { k.set = true; k.source = "admin"; k.tail = v.slice(-4); }
    return name === "TELEGRAM_BOT_TOKEN" ? { ok: true, bot: "R_Socialio_bot", dm: true, why: "" } : { ok: true };
  }
  // 🎙 Вибір розшифровки голосу. Whisper навмисно БЕЗ ключа - перевірка стежить, що недоступний
  // провайдер лишається видимим, але заблокованим (інакше незрозуміло, чому вибору немає).
  if (key === "POST /workspaces/delete") {
    const ws = API["GET /workspaces"], it = ws.items.find((w) => w.id === body?.id);
    const norm = (v) => String(v || "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!it) return { __status: 404, error: "Такого бренду вже немає." };
    if (norm(body?.confirm) !== norm(it.title)) return { __status: 400, error: `Щоб підтвердити, введи назву бренду точно: «${it.title}».` };
    ws.items = ws.items.filter((w) => w.id !== it.id); ws.active = ws.home; brandDeleted.push(it.id);
    return { ok: true };
  }
  if (key === "GET /integrations/stt") return { provider: sttProv, available: { deepgram: true, whisper: false } };
  if (key === "POST /integrations/stt") { sttProv = String(body?.provider || "auto"); return { ok: true }; }
  // 🤖 Дозвіл на Claude через підписку: заглушка СТАНОВА, щоб перевірка доводила «поставив →
  // збереглось», а не вміння віддати константу
  if (method === "PUT" && path.startsWith("/admin/cli/")) {
    const w = API["GET /admin/spend"].workspaces.find((x) => x.id === path.split("/")[3]);
    if (w) w.cli_enabled = body?.enabled === true;
    return { ok: true, enabled: !!(w && w.cli_enabled) };
  }
  if (key === "GET /pricing/media") {
    const cat = /category=video/.test(path) ? "video" : "image";
    return {
      ours: cat === "image" ? [
        { id: "cloudflare", label: "Cloudflare Workers AI (FLUX.2 klein)", note: "безкоштовно ~100 зображень на день", usd: 0, available: true },
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
  // 🖼 кадри каруселі
  let cm = /^\/posts\/([0-9a-f-]+)\/(slides|carousel)(?:\/([\w-]+))?$/.exec(path);
  if (cm) {
    const [, pid, kind, mid] = cm;
    const list = CAR.get(pid) || [];
    carCalls.push({ method, kind, body, mid });
    if (kind === "carousel") {
      const fr = [1, 2, 3, 4].map((i) => ({ id: "s" + i, filename: "slide" + i + ".jpg" }));
      CAR.set(pid, fr);
      return { ok: true, count: 4, theme: "dark", caption: "Підпис під каруселлю", captionChanged: true, truncated: [], content: "Підпис під каруселлю", slides_text: "Слайд 1: А\nСлайд 2: Б", media: fr };
    }
    if (method === "POST") (body.mediaIds || []).forEach((x) => list.push({ id: "n-" + x, filename: x + ".jpg" }));
    if (method === "PUT") list.sort((a, b) => body.ids.indexOf(a.id) - body.ids.indexOf(b.id));
    if (method === "DELETE") list.splice(list.findIndex((x) => x.id === mid), 1);
    CAR.set(pid, list);
    return { ok: true, media: list };
  }
  // 🎬 відео поста: замінює всі кадри (null - прибрати)
  let vm = /^\/posts\/([0-9a-f-]+)\/video$/.exec(path);
  if (vm && method === "PUT") {
    videoCalls.push({ pid: vm[1], mediaId: body?.mediaId ?? null });
    const list = body?.mediaId ? [{ id: body.mediaId, filename: body.mediaId + ".mp4", kind: "video", duration: 6, width: 720, height: 1280, size: 9 * 1048576 }] : [];
    CAR.set(vm[1], list);
    return { ok: true, media: list };
  }
  if (method === "POST" && path === "/posts/blank") return { id: PNEW };
  if (method === "DELETE" && path === "/posts/" + PNEW) { blankDeletes.push(PNEW); return { ok: true }; }
  let m = /^\/posts\/([0-9a-f-]+)\/full$/.exec(path);
  if (m) {
    const p = m[1] === PNEW ? PNEWPOST : m[1] === P11 ? P11POST : m[1] === P4 ? P4POST : m[1] === P5 ? P5POST : m[1] === P7 ? P7POST : m[1] === P8 ? P8POST : m[1] === P9 ? P9POST : m[1] === P10 ? P10POST : (POSTS.find((x) => x.id === m[1]) || POSTS[0]);
    return { ...p, image_prompt: "", headline: "", has_base: false, slides_text: "", cover_filename: p.id === P5 ? "cov0.jpg" : null, media: CAR.get(p.id) || (p.media_filename ? [{ id: "c0", filename: p.media_filename }] : []) };
  }
  m = /^\/posts\/([0-9a-f-]+)\/publish-state$/.exec(path);
  if (m) {
    if (m[1] === P8 && P8STATE) return P8STATE;
    if (m[1] === P4 || m[1] === P5 || m[1] === P7 || m[1] === P8 || m[1] === P10 || m[1] === PNEW) return { sent: [], links: {}, comments: [] };
    if (m[1] === P11) {
      const done = ++p11Polls > 1, link = "https://www.tiktok.com/@holos_rozum/video/7300000000000000123";
      return { sent: ["tiktok"], links: done ? { tiktok: link } : {}, comments: [], sentTo: [done ? { net: "tiktok", account: "", name: null, link } : { net: "tiktok", account: "", name: null, link: null, state: "processing" }] };
    }
    if (m[1] === P9) {
      // як справжній сервер: кожна публікація окремо (sentTo) зі станом свого коментаря
      const cs = (n) => { const c = FC9.comments.find((x) => x.network === n); return c ? { status: c.status, error: c.error || null, due_at: null } : null; };
      return { sent: ["instagram", "linkedin"], links: { instagram: "https://www.instagram.com/p/X9/" }, comments: FC9.comments,
        sentTo: [{ net: "instagram", account: "", name: null, link: "https://www.instagram.com/p/X9/", comment: cs("instagram") }, { net: "linkedin", account: "", name: null, link: null, comment: cs("linkedin") }] };
    }
    const p = POSTS.find((x) => x.id === m[1]) || POSTS[0];
    return { sent: p.sent || [], links: p.links || {} };
  }
  // адаптація повертає ЗБЕРЕЖЕНИЙ стан мереж (як справжній сервер) - тут із Threads, який людина
  // щойно вимкнула в композері: клієнт мусить узяти лише текст, а не воскресити мережу
  m = /^\/posts\/([0-9a-f-]+)\/adapt$/.exec(path);
  if (method === "POST" && m) return { ok: true, channels: { telegram: { on: true, text: "TG-версія" }, threads: { on: true, text: "TH-версія" } } };
  m = /^\/posts\/([0-9a-f-]+)\/channels$/.exec(path);
  if (method === "POST" && m) { chanSaves.push({ id: m[1], channels: body && body.channels }); return { ok: true }; }
  m = /^\/integrations\/telegram\/chats(\/remove)?$/.exec(path);
  if (method === "POST" && m) { tgOps.push({ op: m[1] ? "remove" : "add", body }); return { ok: true, result: m[1] ? "extra" : "added", posts: 2, chat: { id: "-1003", name: "Новий канал" }, chats: [] }; }
  m = /^\/integrations\/(threads|meta)\/accounts(?:\/(main|remove))?$/.exec(path);
  if (method === "POST" && m) { accOps.push({ net: m[1], op: m[2] || "add", body }); return { ok: true, result: "extra", posts: 0 }; }
  m = /^\/media\/([\w-]+)\/alt$/.exec(path);
  if (method === "PUT" && m) { altPuts.push({ id: m[1], alt: body && body.alt_text }); const a = String((body && body.alt_text) || "").replace(/\s+/g, " ").trim(); return { ok: true, alt_text: a || null }; }
  m = /^\/posts\/([0-9a-f-]+)\/first-comment\/send$/.exec(path);
  if (method === "POST" && m) {
    fcSends.push(m[1]);
    // як справжній сервер: у черзі лише мережа, де коментаря ще нема; далі він «надсилається» й стоїть
    FC9.comments = [{ network: "instagram", status: "sent" }, { network: "linkedin", status: "sending" }];
    setTimeout(() => { FC9.comments = [{ network: "instagram", status: "sent" }, { network: "linkedin", status: "sent" }]; }, 400);
    return { ok: true, queued: ["linkedin"], sent: ["instagram"], none: [], busy: [] };
  }
  m = /^\/posts\/([0-9a-f-]+)$/.exec(path);
  if (method === "PUT" && m) { postPuts.push({ id: m[1], body }); return { ok: true }; }
  if (method === "POST" && path === "/ab/generate") return AB_RESULT;
  if (method === "GET" && path === "/montage/caps") return { tts: true, stt: true, vision: true, music: true, maxClips: 20, ...MV_CAPS_EXTRA, style: MV_STYLE, endPreview: MV_STYLE.end ? (MV_STYLE.endText ? { title: MV_STYLE.endText.split("\n")[0], sub: MV_STYLE.endText.split("\n")[1] || "" } : MV_END) : MV_END };
  if (method === "PUT" && path === "/montage/style") { styleCalls.push(body); MV_STYLE = { ...MV_STYLE, ...body }; return { ...MV_STYLE, endPreview: MV_STYLE.endText ? { title: MV_STYLE.endText.split("\n")[0], sub: MV_STYLE.endText.split("\n")[1] || "" } : MV_END }; }
  const cvm = /^\/posts\/([0-9a-f-]+)\/cover$/.exec(path);
  if (cvm && method === "POST") { coverCalls.push({ pid: cvm[1], ...body }); return { ok: true, cover: body.clear ? null : { id: "cv" + coverCalls.length, filename: "cov" + coverCalls.length + ".jpg" } }; }
  if (method === "PUT" && path === "/admin/alerts") { alertCalls.push({ put: body }); return { ok: true, settings: { ...API["GET /admin/alerts"].settings, ...body } }; }
  if (method === "POST" && path === "/admin/alerts/test") { alertCalls.push({ test: true }); return { ok: true, tg: 1, email: true, err: "", to: ["o.stepeniev@swipescape.eu"] }; }
  if (method === "POST" && /^\/admin\/alerts\/\d+\/resolve$/.test(path)) { alertCalls.push({ resolve: path.split("/")[3] }); API["GET /admin/alerts"].open = []; return { ok: true }; }
  if (method === "POST" && path === "/montage") {
    mtCalls.push(body);
    aiJobPolls = 0;
    AI_JOB_RESULT.set("job-mt", { postId: P1, duration: 16, warnings: [], videos: [{ id: "mvx", filename: "m.mp4", duration: 16 }] });
    return { jobId: "job-mt" };
  }
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
    carCalls.push({ method, kind: "publish", path });
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
    // тіло читаємо, бо перевірка ключів мусить бачити, ЩО САМЕ надіслав клієнт (Buffer - шматки
    // відео бінарні, рядок перекрутив би їхню довжину)
    const bufs = [];
    req.on("data", (c) => { bufs.push(c); });
    req.on("end", () => {
      const rawBuf = Buffer.concat(bufs), raw = rawBuf.toString();
      // ⬆ заливка частинами: offset мусить дорівнювати тому, що вже прийшло (як на справжньому сервері)
      if (req.method === "PUT" && url.startsWith("/api/media/chunk")) {
        const qp = new URL(url, "http://x").searchParams;
        const uid = qp.get("uid"), size = +qp.get("size"), off = +qp.get("offset");
        const name = decodeURIComponent(String(req.headers["x-file-name"] || ""));
        const have = CHUNKS.get(uid) || 0;
        chunkPuts.push({ uid, offset: off, bytes: rawBuf.length, name });
        const send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
        if (off !== have) return send(409, { error: "бракує даних", received: have });
        const got = have + rawBuf.length; CHUNKS.set(uid, got);
        if (got < size) return send(200, { ok: true, done: false, received: got, size });
        const video = /\.(mp4|mov|m4v|webm)$/i.test(name);
        return send(200, { ok: true, done: true, received: got, size, saved: { id: "nv" + chunkPuts.length, kind: video ? "video" : "image", filename: "new" + (video ? ".mp4" : ".jpg"), url: "/media/new.mp4", dup: false } });
      }
      // завантаження в медіатеку: рахуємо файли в запиті - так перевірка бачить, чи кабінет ділить пачку
      if (req.method === "POST" && url.startsWith("/api/media")) {
        const names = [...raw.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
        mediaPosts.push(names.length);
        mediaBytes.push(rawBuf.length);
        // так відповідає nginx на тіло понад client_max_body_size (20 МБ) - HTML, а не JSON
        if (rawBuf.length > 20 * 1024 * 1024) { res.writeHead(413, { "content-type": "text/html" }); res.end("<html><body><h1>413 Request Entity Too Large</h1></body></html>"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        // файл «dup…» сервер уже мав (дедуп за вмістом) - так і каже прапорцем dup
        res.end(JSON.stringify({ ok: true, saved: names.map((nm, i) => ({ id: "up" + i, kind: "image", url: "/media/x.png", dup: nm.startsWith("dup") })), failed: [] }));
        return;
      }
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      const body = handleApi(req.method, url.slice(4), parsed);
      // відповідь-помилка: {__status: 400, error} - щоб перевіряти й гілку відмови, а не лише успіх
      const status = body && typeof body === "object" && body.__status ? body.__status : 200;
      if (status !== 200) delete body.__status;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body === undefined ? {} : body));
    });
    return;
  }
  if (url.startsWith("/thumb/") || url.startsWith("/media/")) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
    return;
  }
  // лендинг: Meta й Threads ще не схвалені - так, як на проді зараз
  if (url.split("?")[0] === "/landing") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderLanding(readFileSync(join(PUB, "index.html"), "utf8"), `http://127.0.0.1:${PORT}`, { metaAppId: "m", metaPublic: false, threadsAppId: "t", threadsPublic: false, linkedinClientId: "l", googleClientId: "g", tiktokKey: "" }));
    return;
  }
  const path0 = url.split("?")[0];   // /app?review=tiktok - та сама сторінка
  const file = path0 === "/app" || path0 === "/" ? "app.html" : path0 === "/tgapp" ? "tgapp.html" : path0.replace(/^\//, "");
  const p = join(PUB, file);
  if (!existsSync(p) || !p.startsWith(PUB)) {
    res.writeHead(404).end("nope");
    return;
  }
  const bin = { ".woff2": "font/woff2", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" }[p.slice(p.lastIndexOf("."))];
  if (bin) { res.writeHead(200, { "content-type": bin }); res.end(readFileSync(p)); return; }
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
// SMOKE_ONLY=назва,назва - прогнати лише ці перевірки (налагодження однієї; у CI - усі)
const ONLY = (process.env.SMOKE_ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
const check = async (name, fn) => {
  if (ONLY.length && !ONLY.includes(name)) return;
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

  await check("commInbox", async () => {
    // вікно з плитки «💬 Коменти»: фільтри з лічильниками, акаунт біля коментаря, AI-чернетка; відповідь іде від
    // потрібного акаунта з правленим текстом; «Пропустити»; відмова мережі видна на картці; набраний текст не
    // губиться при перемиканні фільтра; лічильник на «Сьогодні» зменшується
    // вікно закривається за будь-якого результату - інакше провал цієї перевірки валив би сусідні
    const closeCm = () => page.evaluate(() => document.querySelectorAll(".modal").forEach((m) => { if (m.querySelector(".cmModal")) m.remove(); }));
    try {
    await page.evaluate(() => { const t = [...document.querySelectorAll(".tdTile")].find((x) => /Коменти/.test(x.textContent)); t.click(); });
    await page.waitForSelector(".cmModal .cmCard", { timeout: 8000 });
    const st0 = await page.evaluate(() => {
      const m = document.querySelector(".cmModal");
      return { cards: m.querySelectorAll(".cmCard").length, chips: [...m.querySelectorAll("[data-cmf]")].map((x) => x.textContent.trim()).join("|"),
        accs: [...m.querySelectorAll(".cmAcc")].map((x) => x.textContent).join("|"), draft: m.querySelector(".cmTxt").value };
    });
    // набрати текст у картці Threads, перемкнути на Instagram і назад - текст на місці
    await page.evaluate(() => { const card = [...document.querySelectorAll(".cmModal .cmCard")].find((c) => /Threads/.test(c.querySelector(".cmNet").textContent));
      const ta = card.querySelector(".cmTxt"); ta.value = "Мій власний текст для Threads"; ta.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('[data-cmf="instagram"]').click(); });
    const igOnly = await page.$$eval(".cmModal .cmCard", (a) => a.length);
    await page.evaluate(() => document.querySelector('[data-cmf="all"]').click());
    const kept = await page.evaluate(() => [...document.querySelectorAll(".cmModal .cmCard")].find((c) => /Threads/.test(c.querySelector(".cmNet").textContent)).querySelector(".cmTxt").value);
    // відповісти на коментар під постом компанії з правленим текстом
    await page.evaluate(() => { const card = [...document.querySelectorAll(".cmModal .cmCard")].find((c) => /rozum\.one/.test(c.textContent));
      const ta = card.querySelector(".cmTxt"); ta.value = "Напишіть у Direct - порахуємо під ваш готель"; ta.dispatchEvent(new Event("input", { bubbles: true }));
      card.querySelector(".cmSend").click(); });
    await page.waitForFunction(() => /✓ відповідь від @rozum\.one/.test(document.querySelector(".cmModal").textContent), undefined, { timeout: 6000 });
    // Facebook - відмова мережі: видно причину, картка лишається активною; потім «Пропустити»
    await page.evaluate(() => [...document.querySelectorAll(".cmModal .cmCard")].find((c) => /Facebook/.test(c.querySelector(".cmNet").textContent)).querySelector(".cmSend").click());
    await page.waitForFunction(() => /⚠ Facebook: Meta ще не дала/.test(document.querySelector(".cmModal").textContent), undefined, { timeout: 6000 });
    const fbAfterErr = await page.evaluate(() => { const c = [...document.querySelectorAll(".cmModal .cmCard")].find((x) => /Facebook/.test(x.querySelector(".cmNet").textContent));
      return { done: c.classList.contains("done"), sendOn: !c.querySelector(".cmSend").disabled }; });
    await page.evaluate(() => [...document.querySelectorAll(".cmModal .cmCard")].find((c) => /Facebook/.test(c.querySelector(".cmNet").textContent)).querySelector(".cmSkip").click());
    await page.waitForFunction(() => /пропущено/.test(document.querySelector(".cmModal").textContent), undefined, { timeout: 6000 });
    const st1 = await page.evaluate(() => ({ chips: [...document.querySelectorAll("[data-cmf]")].map((x) => x.textContent.trim()).join("|"),
      done: document.querySelectorAll(".cmModal .cmCard.done").length, tile: document.getElementById("tdComm").textContent }));
    if (process.env.SMOKE_SHOTS) {
      await page.screenshot({ path: join(HERE, "comments-light.png") });
      const th = await page.evaluate(() => document.body.getAttribute("data-theme"));
      await page.evaluate(() => setTheme("dark")); await page.screenshot({ path: join(HERE, "comments-dark.png") });
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
      await page.screenshot({ path: join(HERE, "comments-mobile.png") });
      await page.setViewportSize({ width: 1400, height: 950 }); await page.evaluate((t) => setTheme(t || "light"), th);
    }
    const reply = cmCalls.find((c) => c.path === "/comments/reply" && c.body.commentId === "igc2"), skip = cmCalls.find((c) => c.path === "/comments/skip");
    const good = st0.cards === 4 && st0.chips === "Усі 4|📸 Instagram 2|📘 Facebook 1|🧵 Threads 1" && st0.accs === "@olegalisio|@rozum.one" && st0.draft === "Deuter, посилання в профілі 🙂"
      && igOnly === 2 && kept === "Мій власний текст для Threads"
      && reply && reply.body.net === "instagram" && reply.body.account === "igr" && reply.body.text === "Напишіть у Direct - порахуємо під ваш готель"
      && !fbAfterErr.done && fbAfterErr.sendOn && skip && skip.body.commentId === "fbc1"
      && st1.chips === "Усі 2|📸 Instagram 1|📘 Facebook 0|🧵 Threads 1" && st1.done === 2 && st1.tile === "2";
    if (!good) console.log("   ↳ commInbox:", JSON.stringify({ st0, igOnly, kept, reply, fbAfterErr, skip, st1 }));
    return good;
    } finally { await closeCm(); }
  });

  await check("commNeeds", async () => {
    // Meta не дала дозволу читати коментарі Facebook: у вікні - пояснення і кнопка, що відкриває вікно Meta з ?add=inbox
    cmNeeds = true;
    try {
    await page.evaluate(() => { window.__popups = []; window.connectPopup = (u) => { window.__popups.push(u); return false; }; openComments(); });
    await page.waitForSelector(".cmModal .cmNeed", { timeout: 8000 });
    const st = await page.evaluate(() => { const b = document.querySelector('.cmModal [data-cmperm="inbox"]'); if (b) b.click();
      return { need: document.querySelector(".cmModal .cmNeed").textContent, btn: b && b.textContent, popups: window.__popups,
        cards: document.querySelectorAll(".cmModal .cmCard").length }; });
    const good = /дай дозвіл/.test(st.need) && st.btn === "📥 Дозволити читати коментарі" && st.popups.length === 1 && st.popups[0] === "/api/integrations/meta/connect?add=inbox" && st.cards === 2;
    if (!good) console.log("   ↳ commNeeds:", JSON.stringify(st));
    return good;
    } finally { cmNeeds = false; await page.evaluate(() => document.querySelectorAll(".modal").forEach((m) => { if (m.querySelector(".cmModal")) m.remove(); })); }
  });

  await check("topComments", async () => {
    // 💬 N угорі (відгук Олега 30.09): видно з будь-якого розділу, клік - те саме вікно коментарів із галочкою
    // «в Telegram-бот» (PUT /comments/notify); закриття вікна перечитує лічильник; нуль - кнопка ховається;
    // на телефоні кнопка вміщається в шапку без горизонтального скролу
    const keep = new Set(cmDone);
    try {
      await page.evaluate(() => { selectView("publish"); return loadTopComments(); });
      await page.waitForFunction(() => { const b = document.getElementById("topComments"); return b && b.style.display !== "none" && document.getElementById("topCommN").textContent === "2"; }, undefined, { timeout: 6000 });
      const title = await page.$eval("#topComments", (b) => b.title);
      await page.evaluate(() => document.getElementById("topComments").click());
      await page.waitForSelector(".cmModal .cmCard", { timeout: 8000 });
      const cb0 = await page.evaluate(() => { const c = document.getElementById("cmBotOn"); return { on: !!(c && c.checked), hint: !!c && /Підключити наш бот/.test(c.closest("label").textContent), cards: document.querySelectorAll(".cmModal .cmCard").length }; });
      await page.evaluate(() => { const c = document.getElementById("cmBotOn"); c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); });
      await page.waitForFunction(() => /У бот більше не надсилаю/.test(document.body.textContent), undefined, { timeout: 4000 });
      CM_ITEMS.forEach((x) => cmDone.add(x.commentId));
      // закриття має САМЕ перечитати лічильник: рахуємо виклики через глобальне імʼя (таймер старту кабінету
      // кличе збережену функцію, тож його випадковий запуск у цю мить перевірку не підмінить)
      await page.evaluate(() => { window.__ltc = 0; window.__ltcOrig = window.loadTopComments; window.loadTopComments = function () { window.__ltc++; return window.__ltcOrig.apply(this, arguments); }; });
      await page.evaluate(() => document.getElementById("cmX").click());
      await page.waitForFunction(() => document.getElementById("topComments").style.display === "none", undefined, { timeout: 6000 });
      const gone = await page.evaluate(() => { const g = !document.querySelector(".cmModal") && window.__ltc >= 1; window.loadTopComments = window.__ltcOrig; return g; });
      cmDone.clear(); keep.forEach((x) => cmDone.add(x));
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250);
      await page.evaluate(() => loadTopComments());
      await page.waitForFunction(() => document.getElementById("topComments").style.display !== "none", undefined, { timeout: 6000 });
      const mob = await page.evaluate(() => { const r = document.getElementById("topComments").getBoundingClientRect(); return { right: Math.round(r.right), w: Math.round(r.width), sw: document.documentElement.scrollWidth, vis: r.width > 0 && r.height > 0 }; });
      if (process.env.SMOKE_SHOTS) await page.screenshot({ path: join(HERE, "top-comments-mobile.png") });
      const good = /Instagram: 1/.test(title) && /Threads: 1/.test(title) && cb0.on && !cb0.hint && cb0.cards === 2 && cmNotifyPuts.length === 1 && cmNotifyPuts[0] === false
        && gone && mob.vis && mob.right <= 390 && mob.sw <= 390;
      if (!good) console.log("   ↳ topComments:", JSON.stringify({ title, cb0, puts: cmNotifyPuts, gone, mob }));
      return good;
    } finally {
      await page.evaluate(() => { if (window.__ltcOrig) window.loadTopComments = window.__ltcOrig; }).catch(() => {});
      cmDone.clear(); keep.forEach((x) => cmDone.add(x)); cmNotify = true;
      await page.setViewportSize({ width: 1400, height: 950 });
      await page.evaluate(() => document.querySelectorAll(".modal").forEach((m) => { if (m.querySelector(".cmModal")) m.remove(); }));
    }
  });

  await check("todayFails", async () =>
    (await count(".tdFix")) === 1 && (await $t("#todayWrap")).includes("Не опублікувалось (1)"));

  await check("todayFunnel", async () => {
    const fns = await page.$$eval(".tdFn", (a) => a.map((x) => x.textContent));
    const chans = await page.$$eval(".tdChan", (a) => a.map((x) => x.textContent));
    return fns.length === 3 && fns[0].includes("Новини") && fns[1].includes("Чернетки") && fns[2].includes("Опубліковано") &&
      chans.length === 7 && chans.some((c) => c.includes("✓ підключено")) && (await count(".tdChanGo")) > 0;
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

  await check("escQuotes", async () => {
    // esc() стоїть і всередині атрибутів ="…": лапки мусять екрануватись, інакше назва стрічки чи
    // пошта при вході виходили з атрибута (onmouseover=…) і виконували код у кабінеті
    const out = await page.evaluate(() => esc(`x" onmouseover="alert(1)' <b>`));
    const probe = await page.evaluate(() => { const d = document.createElement("div"); d.innerHTML = '<span title="' + esc('a" onclick="x') + '">t</span>'; return d.firstChild.getAttributeNames().join(","); });
    return out.includes("&quot;") && out.includes("&#39;") && out.includes("&lt;b&gt;") && probe === "title";
  });

  await check("publishKeepsChoice", async () => {
    // «Опублікувати зараз» пакує мережі без своєї версії й бере від сервера ЛИШЕ текст: вимкнена
    // людиною мережа не повертається (раніше збережений стан перезаписував локальний вибір)
    const p1 = POSTS[0], keep = { sent: p1.sent, links: p1.links };
    p1.sent = []; p1.links = {}; chanSaves.length = 0;
    await page.evaluate((id) => openComposer(id), P1);
    await page.waitForSelector('.cmp-ov #cmpChips .netchip[data-net="threads"]', { timeout: 6000 });
    await page.click('#cmpChips .netchip[data-net="threads"]');
    await page.click("#cmpNow");
    await page.waitForFunction(() => /✓ telegram/.test(document.querySelector("#cmpMsg").textContent), undefined, { timeout: 15000 });
    await page.evaluate(() => { const b = document.querySelector("#cmpBack"); if (b) b.click(); });
    await page.waitForTimeout(250);
    Object.assign(p1, keep);
    const last = chanSaves[chanSaves.length - 1];
    const ch = (last && last.channels) || {};
    return !!(ch.telegram && ch.telegram.on && ch.telegram.text === "TG-версія") && !(ch.threads && ch.threads.on);
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
    return st.grps === 7 && st.tgDisabled && st.thEnabled && st.revert === 0 && note.includes("спакується під цю мережу автоматично");
  });

  // 🖼 карусель у композері: смужка кадрів, переставляння, прибирання, додавання з медіатеки
  // попередня перевірка лишає свій композер відкритим - закриваємо, інакше тут було б ДВА оверлеї
  // і селектори чіплялися б за елементи чужого поста
  const closeComposers = () => page.evaluate(() => document.querySelectorAll(".cmp-ov").forEach((o) => { const b = o.querySelector("#cmpBack"); if (b) b.click(); else o.remove(); }));
  await check("carouselStrip", async () => {
    await closeComposers();
    await page.waitForTimeout(200);
    await page.evaluate((id) => openComposer(id), P4);
    await page.waitForSelector(".cmp-ov .slides-strip .slide-th", { timeout: 6000 });
    const st = await page.evaluate(() => ({
      n: document.querySelectorAll("#cmpMediaWrap .slide-th").length,
      cover: document.querySelector("#cmpMediaWrap .slide-th .sn").textContent,
      hint: document.querySelector("#cmpMediaWrap").textContent,
      car: getComputedStyle(document.querySelector("#cmpCarWrap")).display !== "none", // формат «Карусель» → блок сценарію видно
      grid: document.querySelectorAll("#cmpPrev .pv-grid img").length,       // Telegram - сітка-альбом
      wide: !!document.querySelector("#cmpPrev .pv-grid .wide"),             // 3 кадри: перший на всю ширину
      row: document.querySelectorAll("#cmpPrev .pv-row img").length,          // Threads - стрічка
      igCnt: (document.querySelector("#cmpPrev .pv-car .pv-cnt") || {}).textContent,
    }));
    if (!(st.n === 3 && st.cover === "обкл." && /Карусель: 3 кадрів/.test(st.hint) && st.car && st.grid === 3 && st.wide && st.row === 3 && st.igCnt === "1/3"))
      console.log("   ↳ carouselStrip:", JSON.stringify(st));
    return st.n === 3 && st.cover === "обкл." && /Карусель: 3 кадрів/.test(st.hint) && st.car && st.grid === 3 && st.wide && st.row === 3 && st.igCnt === "1/3";
  });

  await check("carouselIgSwipe", async () => {
    await page.evaluate(() => document.querySelector("#cmpPrev .pv-car .pv-next").click());
    await page.waitForFunction(() => (document.querySelector("#cmpPrev .pv-car .pv-cnt") || {}).textContent === "2/3", undefined, { timeout: 3000 });
    const st = await page.evaluate(() => ({ prev: !!document.querySelector("#cmpPrev .pv-car .pv-prev"), dot: [...document.querySelectorAll("#cmpPrev .pv-dots i")].findIndex((i) => i.classList.contains("on")) }));
    return st.prev && st.dot === 1;
  });

  await check("carouselReorder", async () => {
    carCalls.length = 0;
    // › на обкладинці: вона йде другою, другий кадр стає обкладинкою
    await page.evaluate(() => document.querySelector('#cmpMediaWrap [data-mv="0"][data-d="1"]').click());
    await page.waitForFunction(() => /g2\.jpg/.test(document.querySelector("#cmpMediaWrap .slide-th img").getAttribute("src")), undefined, { timeout: 4000 });
    const put = carCalls.find((c) => c.method === "PUT");
    return !!put && put.body.ids.join() === "g2,g1,g3";
  });

  await check("carouselRemove", async () => {
    carCalls.length = 0;
    await page.evaluate(() => document.querySelectorAll("#cmpMediaWrap [data-rm]")[2].click());
    await page.waitForFunction(() => document.querySelectorAll("#cmpMediaWrap .slide-th").length === 2, undefined, { timeout: 4000 });
    const del = carCalls.find((c) => c.method === "DELETE");
    return !!del && del.mid === "g3";
  });

  await check("carouselPick", async () => {
    carCalls.length = 0;
    await page.evaluate(() => document.querySelector("#cmpAddSlides").click());
    await page.waitForSelector(".modal .slide-pick", { timeout: 5000 });
    // клік визначає ПОРЯДОК: спершу третє фото, потім перше
    await page.evaluate(() => { const els = document.querySelectorAll(".modal .slide-pick"); els[2].click(); els[0].click(); });
    const nums = await page.evaluate(() => [...document.querySelectorAll(".modal .slide-pick b")].map((b) => b.textContent));
    const okTxt = await $t("#psOk");
    await page.evaluate(() => document.querySelector("#psOk").click());
    await page.waitForFunction(() => document.querySelectorAll("#cmpMediaWrap .slide-th").length === 4, undefined, { timeout: 4000 });
    const post = carCalls.find((c) => c.method === "POST" && c.kind === "slides");
    return nums.join() === "2,1" && okTxt === "Додати 2" && !!post && post.body.mediaIds.join() === "md3,md1";
  });

  await check("carouselBuild", async () => {
    await page.evaluate(() => document.querySelector("#cmpCarBuild").click());
    await page.waitForFunction(() => document.querySelectorAll("#cmpMediaWrap .slide-th").length === 4 && /slide1/.test(document.querySelector("#cmpMediaWrap img").getAttribute("src")), undefined, { timeout: 5000 });
    const st = await page.evaluate(() => ({ text: document.querySelector("#cmpText").value, slides: document.querySelector("#cmpSlidesTxt").value, msg: document.querySelector("#cmpMsg").textContent }));
    await page.evaluate(() => { const b = document.querySelector("#cmpBack"); if (b) b.click(); });
    await page.waitForTimeout(200);
    // текст поста став підписом, сценарій - у своєму полі, людина бачить, скільки кадрів
    return st.text === "Підпис під каруселлю" && /Слайд 1: А/.test(st.slides) && /4 кадрів/.test(st.msg) && /підпис під каруселлю/.test(st.msg);
  });

  await check("carouselGuard", async () => {
    // формат «Карусель» з одним кадром: публікація питає, бо сценарій пішов би підписом під одним фото
    CAR.set(P4, [{ id: "g1", filename: "g1.jpg" }]);
    carCalls.length = 0;
    await closeComposers();
    await page.waitForTimeout(200);
    await page.evaluate((id) => openComposer(id), P4);
    await page.waitForSelector(".cmp-ov #cmpNow", { timeout: 6000 });
    // смоук глобально ставить window.confirm = () => true (див. вище) - тут потрібна ВІДМОВА людини,
    // тож на час перевірки підміняємо його записувачем, що каже «ні», і потім вертаємо «так»
    await page.evaluate(() => { window.__confirmMsg = ""; window.confirm = (m) => { window.__confirmMsg = String(m); return false; }; });
    await page.click("#cmpNow");
    await page.waitForTimeout(400);
    const dialogMsg = await page.evaluate(() => window.__confirmMsg);
    await page.evaluate(() => { window.confirm = () => true; });
    const st = await page.evaluate(() => ({ fmt: (document.querySelector("#cmpFormat") || {}).value, n: document.querySelectorAll("#cmpMediaWrap .slide-th").length, msg: document.querySelector("#cmpMsg").textContent }));
    await page.evaluate(() => { const b = document.querySelector("#cmpBack"); if (b) b.click(); });
    await page.waitForTimeout(200);
    const good = /кадрів ще не зібрано/.test(dialogMsg) && !carCalls.some((c) => c.kind === "publish");
    if (!good) console.log("   ↳ carouselGuard:", JSON.stringify({ dialogMsg, st, calls: carCalls.map((c) => c.kind) }));
    return good;
  });

  await check("carouselBadge", async () => {
    await closeComposers();
    // P1 уже «опубліковано» перевіркою slowPublish, а опубліковані живуть у своїй вкладці
    await page.evaluate(() => { selectView("create"); setCTab("posts"); StudioFilter = "published"; renderStudio(); });
    await page.waitForFunction((id) => document.querySelector('.pcard[data-post="' + id + '"] .pcard-cnt'), "11111111-1111-1111-1111-111111111111", { timeout: 6000 });
    const txt = await $t('.pcard[data-post="11111111-1111-1111-1111-111111111111"] .pcard-cnt');
    await page.evaluate(() => { StudioFilter = "all"; renderStudio(); });
    return txt === "🖼 3";
  });

  // 🎬 YouTube і TikTok: лише для відео; блок TikTok - як вимагає TikTok перед прямою публікацією
  // (нік автора, «Хто бачить» без типового значення, вимкнене автором - сіре, реклама, згода з музикою)
  await check("vidNets", async () => {
    await closeComposers();
    await page.waitForTimeout(150);
    const orig = API["GET /channels/status"];
    API["GET /channels/status"] = { ...orig, youtube: true, tiktok: true, video: { youtube: { name: "Holos Channel" }, tiktok: { name: "Holos", username: "holos_rozum", direct: true } } };
    await page.evaluate(() => loadChanStatus());
    try {
      // фото-пост: YouTube і TikTok сірі, з поясненням
      await page.evaluate((id) => openComposer(id), P8);
      await page.waitForSelector('.cmp-ov #cmpChips .netchip[data-net="tiktok"]', { timeout: 6000 });
      const photo = await page.evaluate(() => { const c = (k) => document.querySelector('#cmpChips .netchip[data-net="' + k + '"]');
        return { yt: c("youtube").disabled, tt: c("tiktok").disabled, title: c("tiktok").title, box: getComputedStyle(document.querySelector("#cmpTtBox")).display }; });
      await closeComposers();
      await page.waitForTimeout(150);
      // відео-пост: кнопка вмикає обидві мережі
      await page.evaluate((id) => openComposer(id), P10);
      await page.waitForSelector(".cmp-ov #cmpVidNets", { timeout: 6000 });
      const allBtn = await $t("#cmpVidNets");
      await page.evaluate(() => document.querySelector("#cmpVidNets").click());
      // без обраного «Хто бачить» TikTok-блок стоїть на «У чернетки» (так само поводиться й сервер)
      await page.waitForSelector('.cmp-ov #cmpTtBox [name=ttMode][value=draft]:checked', { timeout: 6000 });
      await page.evaluate(() => { const r = document.querySelector('#cmpTtBox [name=ttMode][value=direct]'); r.checked = true; r.dispatchEvent(new Event("change")); });
      await page.waitForSelector(".cmp-ov #cmpTtBox #ttPriv", { timeout: 6000 });
      const st = await page.evaluate(() => ({
        yt: getComputedStyle(document.querySelector("#cmpYtBox")).display !== "none",
        ytPh: document.querySelector("#ytTitle").placeholder,
        who: document.querySelector("#cmpTtBox .vnwho").textContent,
        priv: document.querySelector("#ttPriv").value,
        opts: [...document.querySelectorAll("#ttPriv option")].map((o) => o.textContent),
        duetDis: document.querySelector("#ttDu").disabled, cm: document.querySelector("#ttCm").checked,
        legal: document.querySelector("#cmpTtBox .vnlegal").textContent,
        shorts: /Shorts/.test(document.querySelector("#cmpPrev").textContent), user: document.querySelector("#cmpPrev").textContent.includes("@holos_rozum"),
      }));
      if (process.env.SMOKE_SHOTS) {
        await page.evaluate(() => { const b = document.querySelector("#cmpTtBox"); if (b) b.scrollIntoView({ block: "center" }); });
        await page.screenshot({ path: join(HERE, "vidnets-light.png") });
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark")); await page.waitForTimeout(200);
        await page.screenshot({ path: join(HERE, "vidnets-dark.png") });
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      }
      // без «Хто бачить» публікація не стартує, а пояснює
      const before = carCalls.filter((c) => c.kind === "publish").length;
      await page.evaluate(() => document.querySelector("#cmpNow").click());
      await page.waitForTimeout(250);
      const blocked = await $t("#cmpMsg");
      const started = carCalls.filter((c) => c.kind === "publish").length - before;
      // обрали «Підписники», ввімкнули коментарі, розкрили рекламу → без вибору типу - помилка, «брендований» - «Лише я» вимкнено
      await page.evaluate(() => { const s = document.querySelector("#ttPriv"); s.value = "SELF_ONLY"; s.dispatchEvent(new Event("change")); const c = document.querySelector("#ttCm"); c.checked = true; c.dispatchEvent(new Event("change")); const d = document.querySelector("#ttDisc"); d.checked = true; d.dispatchEvent(new Event("change")); });
      await page.waitForTimeout(100);
      const disc = await $t("#cmpTtBox");
      // «Лише я» → брендований контент сірий (правило TikTok); обрали «Підписники» - тоді можна, а «Лише я» сіре
      const brSelf = await page.evaluate(() => document.querySelector("#ttBr").disabled);
      await page.evaluate(() => { const s = document.querySelector("#ttPriv"); s.value = "FOLLOWER_OF_CREATOR"; s.dispatchEvent(new Event("change")); });
      await page.waitForTimeout(100);
      await page.evaluate(() => { const b = document.querySelector("#ttBr"); b.checked = true; b.dispatchEvent(new Event("change")); });
      await page.waitForTimeout(100);
      const br = await page.evaluate(() => ({ selfOff: document.querySelector('#ttPriv option[value="SELF_ONLY"]').disabled, priv: document.querySelector("#ttPriv").value, legal: document.querySelector("#cmpTtBox .vnlegal").textContent, label: document.querySelector("#cmpTtBox .vnlabel").textContent }));
      // YouTube: своя назва і «за посиланням»
      await page.evaluate(() => { const t = document.querySelector("#ytTitle"); t.value = "Моя <назва>"; t.dispatchEvent(new Event("input")); const p = document.querySelector("#ytPriv"); p.value = "unlisted"; p.dispatchEvent(new Event("change")); });
      chanSaves.length = 0;
      await page.evaluate(() => document.querySelector("#cmpSave").click());
      await page.waitForTimeout(300);
      const saved = (chanSaves.find((x) => x.id === P10) || {}).channels || {};
      // режим «чернетка»: «Хто бачить» зникає, є кнопка скопіювати підпис
      await page.evaluate(() => { const r = document.querySelector('#cmpTtBox [name=ttMode][value=draft]'); r.checked = true; r.dispatchEvent(new Event("change")); });
      await page.waitForTimeout(100);
      const draft = await page.evaluate(() => ({ priv: !!document.querySelector("#ttPriv"), copy: !!document.querySelector("#ttCopy"), pv: document.querySelector("#cmpPrev").textContent.includes("чернетк") }));
      const good = photo.yt && photo.tt && /лише для відео/.test(photo.title) && photo.box === "none"
        && st.yt && st.ytPh.includes("Як ми зекономили 3 години на тиждень") && st.who.includes("Holos") && st.who.includes("@holos_rozum")
        && st.priv === "" && st.opts[0].includes("обери") && st.opts.length === 4 && st.duetDis && !st.cm && /Music Usage Confirmation/.test(st.legal) && st.shorts && st.user
        && /обери «Хто бачить»/.test(blocked) && started === 0
        && /Вкажи, кого рекламує відео/.test(disc) && /не може бути видно «Лише мені»/.test(disc) && brSelf
        && br.selfOff && br.priv === "FOLLOWER_OF_CREATOR" && /Branded Content Policy/.test(br.legal) && /Paid partnership/.test(br.label)
        && saved.tiktok && saved.tiktok.privacy === "FOLLOWER_OF_CREATOR" && saved.tiktok.comment === true && saved.tiktok.branded === true && !saved.tiktok.duet
        && saved.youtube && saved.youtube.title === "Моя назва" && saved.youtube.privacy === "unlisted" && saved.youtube.on === true
        // «🌐 В усі мережі» вмикає всі підключені, а не лише YouTube і TikTok
        && /В усі мережі/.test(allBtn) && saved.telegram && saved.telegram.on === true && saved.threads && saved.threads.on === true
        && !draft.priv && draft.copy && draft.pv;
      if (!good) console.log("   ↳ vidNets:", JSON.stringify({ allBtn, photo, st, blocked, started, disc: disc.slice(0, 400), brSelf, br, saved: { tiktok: saved.tiktok, youtube: saved.youtube, telegram: saved.telegram, threads: saved.threads }, draft }));
      if (process.env.SMOKE_SHOTS) {
        // телефон: композер відкривається вже на вузькому екрані (як у людини), а не стискається відкритим
        await closeComposers(); await page.waitForTimeout(200);
        await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
        await page.evaluate((id) => openComposer(id), P10);
        await page.waitForSelector(".cmp-ov #cmpVidNets", { timeout: 6000 });
        await page.evaluate(() => document.querySelector("#cmpVidNets").click());
        await page.waitForSelector('.cmp-ov #cmpTtBox [name=ttMode][value=direct]', { timeout: 6000 });
        await page.evaluate(() => { const r = document.querySelector('#cmpTtBox [name=ttMode][value=direct]'); r.checked = true; r.dispatchEvent(new Event("change")); });
        await page.waitForSelector(".cmp-ov #cmpTtBox #ttPriv", { timeout: 6000 });
        await page.waitForTimeout(400);
        await page.evaluate(() => { const b = document.querySelector("#cmpTtBox"); if (b) b.scrollIntoView({ block: "start" }); });
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(HERE, "vidnets-mobile.png") });
        const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const geo = await page.evaluate(() => { const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; };
          return { tt: r("#cmpTtBox"), prev: r("#cmpPrev"), foot: r(".cmp-foot") }; });
        console.log("   ↳ vidNets телефон: горизонтальний скрол " + ov + " px · " + JSON.stringify(geo));
        await page.setViewportSize({ width: 1400, height: 950 }); await page.waitForTimeout(200);
      }
      return good;
    } finally {
      API["GET /channels/status"] = orig;
      await page.evaluate(() => loadChanStatus());
      await closeComposers();
    }
  });

  // 📱 композер на телефоні: редактор і прев'ю - один стовпчик, що гортається цілком. Раніше висока стрічка
  // прев'ю (відео 9:16 у кожній мережі) стискала редактор до кількох пікселів, а кнопки малювались посеред прев'ю.
  await check("cmpPhone", async () => {
    await closeComposers();
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
    try {
      await page.evaluate((id) => openComposer(id), P10);
      await page.waitForSelector(".cmp-ov #cmpPrev .phone", { timeout: 6000 });
      await page.waitForTimeout(300);
      const g = await page.evaluate(() => {
        const b = (sel) => document.querySelector(sel).getBoundingClientRect();
        const body = document.querySelector(".cmp-ov .cmp-body"), left = b(".cmp-ov .cmp-left"), right = b(".cmp-ov .cmp-right"), foot = b(".cmp-ov .cmp-foot"), bb = body.getBoundingClientRect();
        return { left: Math.round(left.height), leftScroll: document.querySelector(".cmp-ov .cmp-left").scrollHeight, rightTop: Math.round(right.top), leftBottom: Math.round(left.bottom),
          bodyBottom: Math.round(bb.bottom), footTop: Math.round(foot.top), scrolls: body.scrollHeight > body.clientHeight + 50, hscroll: document.documentElement.scrollWidth - window.innerWidth };
      });
      const good = g.left >= g.leftScroll - 2 && g.rightTop >= g.leftBottom - 1 && g.footTop >= g.bodyBottom - 1 && g.scrolls && g.hscroll <= 0;
      if (!good) console.log("   ↳ cmpPhone:", JSON.stringify(g));
      return good;
    } finally {
      await closeComposers();
      await page.setViewportSize({ width: 1400, height: 950 }); await page.waitForTimeout(200);
    }
  });

  await check("videoComposer", async () => {
    // 🎬 відео-пост: плитка з тривалістю, ліміти мереж видно ДО публікації, прев'ю - плеєр (IG - Reels),
    // а «＋ Кадри каруселі» не відкриває вибір: відео йде окремим постом
    await closeComposers();
    await page.waitForTimeout(150);
    await page.evaluate((id) => openComposer(id), P5);
    await page.waitForSelector(".cmp-ov #cmpVidWarn", { timeout: 6000 });
    const st = await page.evaluate(() => ({
      tile: (document.querySelector("#cmpMediaWrap .slide-th .sn") || {}).textContent,
      warn: document.querySelector("#cmpVidWarn").textContent,
      videos: document.querySelectorAll("#cmpPrev video").length,
      reel: !!document.querySelector("#cmpPrev .pv-video.reel video") && /Reels/.test((document.querySelector("#cmpPrev .pv-video.reel") || {}).textContent || ""),
    }));
    await page.evaluate(() => document.querySelector("#cmpAddSlides").click());
    await page.waitForTimeout(250);
    const msg = await $t("#cmpMsg");
    const picker = await has(".modal .slide-pick");
    const good = st.tile === "▶ 6:40" && /Telegram не прийме відео понад 50 МБ \(це 60 МБ\)/.test(st.warn) && /Threads приймає відео до 5 хв/.test(st.warn)
      && st.videos === 3 && st.reel && /окремим постом/.test(msg) && !picker;
    if (!good) console.log("   ↳ videoComposer:", JSON.stringify({ st, msg, picker }));
    return good;
  });

  await check("videoPick", async () => {
    // вибір відео: у медіатеці - кадр і тривалість; з компʼютера - ЧАСТИНАМИ по 8 МБ (9 МБ = 2 запити),
    // потім відео стає медіа поста, і попередження зникають (6 с, 9 МБ - усім мережам ок)
    chunkPuts.length = 0; videoCalls.length = 0;
    await page.evaluate(() => document.querySelector("#cmpVideo").click());
    await page.waitForSelector(".modal #pvFile", { state: "attached", timeout: 5000 });
    const libBadge = await $t('.modal .slide-pick[data-id="mv1"] .vbadge');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(9 * 1024 * 1024)], "clip.mp4", { type: "video/mp4" }));
      const inp = document.querySelector("#pvFile"); inp.files = dt.files; inp.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(() => /0:06/.test((document.querySelector("#cmpMediaWrap .slide-th .sn") || {}).textContent || ""), undefined, { timeout: 8000 });
    const st = await page.evaluate(() => ({ warn: !!document.querySelector("#cmpVidWarn"), msg: document.querySelector("#cmpMsg").textContent, modal: !!document.querySelector(".modal #pvFile") }));
    await closeComposers();
    const sizes = chunkPuts.map((c) => c.bytes);
    const good = libBadge === "▶ 1:15" && sizes.join(",") === [8 * 1048576, 1048576].join(",") && chunkPuts[1].offset === 8 * 1048576
      && videoCalls.length === 1 && videoCalls[0].pid === P5 && /^nv/.test(videoCalls[0].mediaId) && !st.warn && !st.modal && /відео в пості/.test(st.msg);
    if (!good) console.log("   ↳ videoPick:", JSON.stringify({ libBadge, sizes, videoCalls, st }));
    return good;
  });

  await check("storyComposer", async () => {
    // ⚡ сторіс: мережі без сторіс затінені, прев'ю - кадр 9:16 зі смужками прогресу й гортанням,
    // сценарій - «Кадр N», у смужці кадрів відео підписане тривалістю
    await closeComposers();
    await page.waitForTimeout(150);
    await page.evaluate((id) => openComposer(id), P7);
    await page.waitForSelector(".cmp-ov .pv-story", { timeout: 6000 });
    const st = await page.evaluate(() => {
      const tg = document.querySelector('.cmp-ov .netchip[data-net="telegram"]');
      return {
        tgDim: !!tg && tg.disabled && /Instagram і Facebook/.test(tg.title),
        stories: document.querySelectorAll("#cmpPrev .pv-story").length,
        bars: document.querySelectorAll("#cmpPrev .pv-story")[0].querySelectorAll(".pv-bars i").length,
        cnt: document.querySelector("#cmpPrev .pv-story .pv-cnt").textContent,
        carTitle: (document.querySelector("#cmpCarTitle") || {}).textContent, build: (document.querySelector("#cmpCarBuild") || {}).textContent,
        carShown: document.querySelector("#cmpCarWrap").style.display !== "none",
        vidLabel: [...document.querySelectorAll("#cmpMediaWrap .slide-th .sn")].map((x) => x.textContent).join("|"),
        storyTiles: document.querySelectorAll("#cmpMediaWrap .slide-th.story").length,
      };
    });
    await page.evaluate(() => document.querySelector('#cmpPrev [data-snav="instagram"][data-d="1"]').click());
    const cnt2 = await $t("#cmpPrev .pv-story .pv-cnt");
    const good = st.tgDim && st.stories === 2 && st.bars === 3 && st.cnt === "1/3" && cnt2 === "2/3" && st.carShown
      && st.carTitle === "⚡ Сценарій кадрів сторіс" && st.build === "🎨 Зібрати кадри" && st.vidLabel === "1|2|▶ 0:06" && st.storyTiles === 3;
    if (!good) console.log("   ↳ storyComposer:", JSON.stringify({ st, cnt2 }));
    await closeComposers();
    return good;
  });

  await check("storySwitch", async () => {
    // перемикання формату на «Сторіс» вимикає Telegram і вмикає підключені Instagram/Facebook,
    // а повернення формату вертає рівно той вибір мереж, що був до сторіс
    await page.evaluate(() => { window.__cs = { ...ChanStatus }; ChanStatus.instagram = true; ChanStatus.facebook = true; });
    await page.evaluate((id) => openComposer(id), P2);
    await page.waitForSelector(".cmp-ov #cmpFormat", { timeout: 6000 });
    const on = () => page.evaluate(() => [...document.querySelectorAll(".cmp-ov .netchip.on")].map((b) => b.dataset.net).sort().join(","));
    const before = await on();
    await page.evaluate(() => { const f = document.querySelector("#cmpFormat"); f.value = "story"; f.dispatchEvent(new Event("change")); });
    const inStory = await on();
    const prevOk = await has("#cmpPrev .pv-story");
    await page.evaluate(() => { const f = document.querySelector("#cmpFormat"); f.value = "post"; f.dispatchEvent(new Event("change")); });
    const after = await on();
    await closeComposers();
    await page.evaluate(() => { Object.assign(ChanStatus, window.__cs); });
    const good = before === "instagram,telegram" && inStory === "facebook,instagram" && prevOk && after === "instagram,telegram";
    if (!good) console.log("   ↳ storySwitch:", JSON.stringify({ before, inStory, prevOk, after }));
    return good;
  });

  await check("videoCard", async () => {
    // картка Студії: відео-пост - кадр із ролика й тривалість, клік веде в композер (не в редактор фото)
    const st = await page.evaluate(async () => {
      selectView("create"); setCTab("posts");
      await loadStudioPosts();   // перемикання вкладки саме перечитує Finals - дочекатись, інакше він затре наш пост
      // фільтри Студії могли лишитись від попередніх перевірок - на час перевірки знімаємо, потім вертаємо
      const keep = [StudioFilter, StudioRubric, StudioFormat, StudioOrigin];
      StudioFilter = "all"; StudioRubric = ""; StudioFormat = ""; StudioOrigin = "";
      Finals.push({ id: "66666666-6666-6666-6666-666666666666", content: "Відео-пост", review: "review", channels: { instagram: { on: true } }, media_filename: "reel.mp4", media_kind: "video", media_duration: 42, media_count: 1, sent: [], links: {}, format: "post" });
      renderStudio();
      const el = document.querySelector('.pcard[data-post="66666666-6666-6666-6666-666666666666"] .pcard-img');
      const out = el ? { cnt: (el.querySelector(".pcard-cnt") || {}).textContent, a: el.dataset.a } : null;
      Finals.pop(); [StudioFilter, StudioRubric, StudioFormat, StudioOrigin] = keep; renderStudio();
      return out;
    });
    if (!(st && st.cnt === "▶ 0:42" && st.a === "composer")) console.log("   ↳ videoCard:", JSON.stringify(st));
    return !!st && st.cnt === "▶ 0:42" && st.a === "composer";
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

  await check("bestRhythm", async () => {
    // ⏰ у Ритмі каналів: мережа зі СВОЇМ ритмом (Threads у заглушці) години не отримує - то рішення людини;
    // без свого ритму біля Threads - найкраща година; перемикач вимкнули - годин нема
    const cr = SETTINGS.find((x) => x.key === "channel_rhythm"), saved = cr.content;
    try {
      const render = () => page.evaluate(() => { BestT = null; return renderRhythm(); });
      await render();
      await page.waitForSelector("#rhBestAuto", { timeout: 8000, state: "attached" });
      const custom = await page.evaluate(() => ({ on: document.querySelector("#rhBestAuto").checked, th: !!document.querySelector('#rhythmRows [data-net="threads"] .rhBest') }));
      cr.content = "{}";
      await render();
      await page.waitForFunction(() => document.querySelector('#rhythmRows [data-net="threads"] .rhBest'), undefined, { timeout: 8000 });
      const st0 = await page.evaluate(() => ({ th: document.querySelector('#rhythmRows [data-net="threads"] .rhBest').textContent, tg: !!document.querySelector('#rhythmRows [data-net="telegram"] .rhBest'),
        nested: !!document.querySelector('#rhythmRows [data-net] [data-net]') }));
      await page.evaluate(() => { const c = document.querySelector("#rhBestAuto"); c.checked = false; c.dispatchEvent(new Event("change")); });
      await page.waitForFunction(() => { const c = document.querySelector("#rhBestAuto"); return c && !c.checked && !document.querySelector("#rhythmRows .rhBest"); }, undefined, { timeout: 8000 });
      await page.evaluate(() => { const c = document.querySelector("#rhBestAuto"); c.checked = true; c.dispatchEvent(new Event("change")); });
      await page.waitForFunction(() => { const c = document.querySelector("#rhBestAuto"); return c && c.checked && document.querySelector("#rhythmRows .rhBest"); }, undefined, { timeout: 8000 });
      // рядки мереж - сусіди, а не вкладені один в одного (інакше «свій ритм» однієї мережі забирав дні й часи іншої)
      const good = custom.on && !custom.th && st0.th === "⏰ 19:30" && !st0.tg && !st0.nested && btPuts.slice(-2).join(",") === "0,1";
      if (!good) console.log("   ↳ bestRhythm:", JSON.stringify({ custom, st0, btPuts }));
      return good;
    } finally { cr.content = saved; await page.evaluate(() => renderRhythm()); }
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

  // MCP-панель: адреса підтягнулась із сервера І модалка «Як підключити» реально відкривається -
  // саме в ній найлегше тихо зламати рядок, бо вона будується конкатенацією HTML.
  // Перемикач брендів: зʼявляється лише коли кабінетів кілька, активний позначений, а в Профілі
  // видно учасників. Саме тут легко тихо зламати мульти-воркспейс і не помітити.
  // Бета: спільний бот не приймає DM (вебхук за продом). Кнопка підключення мусить бути ГЛУХА,
  // а причина - написана поруч; інакше людина тисне її й отримує посилання в нікуди.
  await check("tgSharedOff", async () => {
    const box = await page.$eval("#tgSharedOff", (el) => el.style.display + "|" + el.innerText).catch(() => "none|");
    const dis = await page.$eval("#tgConnectBot", (el) => el.disabled).catch(() => false);
    // адміну - головний шлях: окремий спільний бот цього середовища в «Ключах провайдерів», з кнопкою туди
    return box.startsWith("block") && box.includes("не приймає повідомлень") && box.includes("Ключі провайдерів") && dis === true
      && (await has("#tgOpenKeys"));
  });

  // Причина й порада залежать від того, ЧОМУ бот тут мовчить і ХТО дивиться; бренд із власним живим ботом
  // від спільного не залежить - у нього кнопка підключення мусить працювати й на беті.
  await check("tgBetaBot", async () => {
    const orig = API["GET /integrations/telegram"];
    const view = async (patch) => {
      API["GET /integrations/telegram"] = { ...orig, ...patch };
      await page.evaluate(async () => { await loadTelegram(); });
      return page.evaluate(() => ({ shown: document.querySelector("#tgSharedOff").style.display === "block", text: document.querySelector("#tgSharedOff").innerText,
        dis: document.querySelector("#tgConnectBot").disabled, keys: !!document.querySelector("#tgOpenKeys") }));
    };
    const foreign = await view({ sharedWhy: "foreign", sharedHost: "holos.rozum.one" });
    const own = await view({ usesShared: false });
    const user = await view({ admin: false });
    API["GET /integrations/telegram"] = orig;
    await page.evaluate(async () => { await loadTelegram(); });
    const good = foreign.shown && foreign.text.includes("працює на holos.rozum.one") && foreign.text.includes("забрати") && foreign.keys
      && !own.shown && own.dis === false
      && user.shown && user.text.includes("Розширені налаштування") && !user.keys;
    if (!good) console.log("    tgBetaBot:", JSON.stringify({ foreign, own, user }).slice(0, 600));
    return good;
  });

  // Спільного бота змінили: канал підключено через попереднього. Кабінет мусить сказати, що старий
  // бот і далі публікує і як перейти на нового - інакше людина не знає, що взагалі щось змінилось.
  await check("tgFormerBot", async () => {
    const t = await page.$eval("#tgConnMsg", (el) => el.innerText).catch(() => "");
    return t.includes("Мій канал") && t.includes("попереднього бота @R_Socialio_bot") && t.includes("@holos_rozum_bot") && t.includes("Підключити наш бот");
  });

  await check("wsSwitcher", async () => {
    const box = await page.$eval("#wsSwitch", (el) => el.style.display).catch(() => "none");
    const list = await page.$eval("#wsList", (el) => el.innerText).catch(() => "");
    const active = await page.$eval("#wsList", (el) => (el.querySelector("[data-ws]")?.innerText || "")).catch(() => "");
    const mem = await page.$eval("#wsMembers", (el) => el.innerText).catch(() => "");
    return box !== "none" && list.includes("Бренд А") && list.includes("Бренд Б") && active.includes("✓")
      && list.includes("Додати бренд") && mem.includes("friend@rozum.one");
  });

  // Меню аватара мусить бути НАД липкою плашкою розділу. Раніше .pagehead (z-index 45) накривав
  // його зверху, бо z-index 80 у меню діяв лише всередині контексту, який створює .topnav (30).
  // Перевіряємо не стилі, а факт: що саме лежить у точці перетину.
  // ⚠️ Онбординг ХОВАЄМО, а не видаляємо: наступні перевірки (obTextFirst/obNoIg) працюють із тим
  // самим вузлом, і його видалення валить їх - стан сторінки тут спільний на всю сюїту.
  await check("menuOverTop", async () => {
    await page.evaluate(() => {
      const ob = document.getElementById("onboarding");
      if (ob) { ob.dataset.smokePrev = ob.style.display; ob.style.display = "none"; }
      document.getElementById("avatar")?.click();
    });
    await page.waitForTimeout(280);                       // у меню анімація появи - міряємо після неї
    const res = await page.evaluate(() => {
      const menu = document.getElementById("userMenu"), head = document.querySelector(".pagehead");
      const open = !!menu && menu.style.display !== "none";
      if (!open || !head) return { open, hit: "" };
      const m = menu.getBoundingClientRect(), h = head.getBoundingClientRect();
      const y = Math.min(m.bottom, h.bottom) - 6, x = m.left + m.width / 2;
      if (y <= m.top || y <= h.top) return { open, hit: "menu", note: "не перетинаються" };
      // elementsFromPoint (МНОЖИНА) - бо в цій точці може лежати ще щось стороннє (бульбашка сови):
      // питання не «хто зверху за все», а чи меню вище за ПЛАШКУ РОЗДІЛУ.
      const stack = document.elementsFromPoint(x, y);
      const iMenu = stack.findIndex((e) => menu.contains(e));
      const iHead = stack.findIndex((e) => e === head || head.contains(e));
      return { open, iMenu, iHead, hit: iMenu >= 0 && (iHead < 0 || iMenu < iHead) ? "menu" : "pagehead" };
    });
    await page.evaluate(() => {
      document.getElementById("avatar")?.click();
      const ob = document.getElementById("onboarding");
      if (ob) { ob.style.display = ob.dataset.smokePrev || ""; delete ob.dataset.smokePrev; }
    });
    await page.waitForTimeout(120);
    if (!res.open || res.hit !== "menu") console.log("   ↳ menuOverTop:", JSON.stringify(res));
    return res.open && res.hit === "menu";
  });

  await check("mcpPanel", async () => {
    const url = await page.$eval("#mcpUrl", (el) => el.value).catch(() => "");
    if (!url.includes("/mcp/")) return false;
    // тиснемо з JS: мишкою не вийде - зверху висить модалка онбордингу й перехоплює клік
    await page.evaluate(() => document.getElementById("mcpHow").click());
    await page.waitForTimeout(250);
    const got = await page.evaluate(() => {
      const card = [...document.querySelectorAll(".modal .modal-card")].pop(); // своя модалка - остання в body
      if (!card) return null;
      // команда для Claude Code лежить у value інпута, а не в тексті - innerText її НЕ бачить
      return { text: card.innerText, cli: [...card.querySelectorAll("input")].map((i) => i.value).join(" ") };
    });
    await page.evaluate(() => document.querySelector("#mhX")?.click());
    return !!got && got.text.includes("Add custom connector") && got.cli.includes("claude mcp add");
  });

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

  // Спільний бот, чий вебхук веде на інший сервіс (прод ↔ бета): перший запис - 409 з питанням, і лише
  // «так» шле force. Без питання адмін мовчки вимкнув би бота там, де він працює.
  await check("botKeyForce", async () => {
    botPuts.length = 0;
    await page.evaluate(() => { window.__conf = ""; window.confirm = (m) => { window.__conf = m; return true; };
      const c = [...document.querySelectorAll("#admKeys .card")].find((x) => x.getAttribute("data-key") === "TELEGRAM_BOT_TOKEN");
      c.querySelector("input").value = "8859390932:AAtesttesttesttesttesttesttesttest1"; c.querySelector(".kSave").click(); });
    await page.waitForFunction(() => {
      const c = [...document.querySelectorAll("#admKeys .card")].find((x) => x.getAttribute("data-key") === "TELEGRAM_BOT_TOKEN");
      return c && c.textContent.includes("з адмінки");
    }, undefined, { timeout: 8000 }).catch(() => {});
    const conf = await page.evaluate(() => window.__conf);
    const good = botPuts.join(",") === "plain,force" && conf.includes("працює на holos.rozum.one");
    if (!good) console.log("    botKeyForce:", JSON.stringify({ botPuts, conf }));
    return good;
  });

  // 📈 Аналітика 2.0: екран малюється з того, що віддає СПРАВЖНІЙ модуль аналітики; фільтр,
  // сортування, підказки, «таблиця замість графіка», CSV і «Оновити статистику» реально працюють.
  await check("analyticsV2", async () => {
    await page.evaluate(() => { try { localStorage.removeItem("kg_an"); } catch (e) { /* ignore */ } AnData = null; selectView("analytics"); });
    await page.waitForFunction(() => document.querySelector("#anCols svg") && document.querySelectorAll("#anTbl tr").length > 5
      && document.querySelector("#anDrivers .vz-dfacet") && document.querySelector("#anHeat table"), undefined, { timeout: 10000 });
    const st = await page.evaluate(() => ({
      kpi: document.querySelector(".an-kpi").innerText,
      ins: [...document.querySelectorAll(".an-ins li")].map((l) => l.innerText),
      facets: document.querySelectorAll("#anDrivers .vz-dfacet").length,
      heatRows: document.querySelectorAll("#anHeat .vz-heat tr").length,
      legend: document.querySelector("#anCols .vz-legend")?.innerText || "",
      marks: document.querySelectorAll("#anCols svg path, #anCols svg rect:not(.vz-hit)").length,
      follow: [...document.querySelectorAll("#anFollow .vz-facet")].map((f) => ({ t: f.innerText, svg: !!f.querySelector("svg path") })),
      cov: document.querySelector(".ancov")?.innerText || "",
      rows: document.querySelectorAll("#anTbl .an-tbl tr").length - 1,
      more: !!document.getElementById("anMore"),
      fbNa: [...document.querySelectorAll("#anTbl .an-tbl tr")].some((tr) => tr.innerText.includes("Facebook") && tr.querySelector("td.na[title*='дозволу']")),
      // свіжий пост (знімок раніше, ніж за 2 доби після публікації) - «набирає», а не «×0.0» і не ▼
      young: [...document.querySelectorAll("#anTbl td.na")].filter((td) => td.textContent.includes("набирає") && td.title.includes("2 доби")).length,
      youngDown: [...document.querySelectorAll("#anTbl .an-tbl tr")].some((tr) => tr.querySelector("td.na")?.textContent.includes("набирає") && tr.querySelector(".vz-down")),
    }));
    const ok = st.kpi.includes("Публікацій") && st.kpi.includes("Перегляди") && st.kpi.includes("%")
      && st.ins.length >= 2 && st.ins.some((t) => /Тип поста|Час публікації|Перший рядок|День тижня/.test(t))
      && st.facets >= 4 && st.heatRows === 8 && st.legend.includes("Threads") && st.legend.includes("Instagram")
      && st.marks > 10 && st.follow.length === 4 && st.follow.filter((f) => f.svg).length === 3 && st.follow.some((f) => f.t.includes("перший знімок"))
      && st.cov.includes("Facebook: перегляди недоступні") && st.cov.includes("Telegram")
      && st.rows === 30 && st.more && st.fbNa
      && st.young >= 1 && !st.youngDown && /свіж\S* пост\S* ще набира/.test(st.cov);
    if (!ok) console.log("   ↳ analyticsV2:", JSON.stringify(st).slice(0, 1600));
    return ok;
  });

  await check("bestAnalytics", async () => {
    // ⏰ панель найкращого часу в Аналітиці: мережі з порадою й чесне «не впливає»; дубль мережі й акаунт
    // без даних не засмічують; перемикач пише налаштування й панель чесно каже, звідки календар бере час
    await page.waitForSelector("#anBest", { timeout: 8000 });
    const st0 = await page.evaluate(() => ({ items: [...document.querySelectorAll("#anBest li")].map((l) => l.innerText), sub: document.querySelector("#anBest .vz-sub").innerText, btn: document.querySelector("#anBestToggle").innerText }));
    if (process.env.SMOKE_SHOTS) { const el = await page.$("#anBest"); await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: join(HERE, "best-analytics.png") }); }
    await page.evaluate(() => document.querySelector("#anBestToggle").click());
    await page.waitForFunction(() => /зі стратегії/.test((document.querySelector("#anBest .vz-sub") || {}).textContent || ""), undefined, { timeout: 8000 });
    const st1 = await page.evaluate(() => ({ sub: document.querySelector("#anBest .vz-sub").innerText, btn: document.querySelector("#anBestToggle").innerText }));
    await page.evaluate(() => document.querySelector("#anBestToggle").click());
    await page.waitForFunction(() => /ставить пости саме сюди/.test((document.querySelector("#anBest .vz-sub") || {}).textContent || ""), undefined, { timeout: 8000 });
    // показано рівно те, що сервер позначив show: @rozum.one з порадою, @olegalisio - чий час бере календар,
    // Instagram - «не впливає»; рядок мережі-дубль і акаунт без жодних даних - ні
    const good = st0.items.length === 3 && /^⏰\s*Threads @rozum\.one: .*Найкращий час для постів - 19:30/.test(st0.items[0])
      && /@olegalisio: .*календар ставить його пости в час @rozum\.one: 19:30/.test(st0.items[1]) && /майже не впливає/.test(st0.items[2])
      && !st0.items.some((t) => /^\S*\s*Threads: |Rozum\.one: поки/.test(t))
      && /ставить пости саме сюди/.test(st0.sub) && /Не ставити/.test(st0.btn) && /зі стратегії/.test(st1.sub) && /Ставити в календар/.test(st1.btn)
      && btPuts.slice(-2).join(",") === "0,1" && btAuto === true;
    if (!good) console.log("   ↳ bestAnalytics:", JSON.stringify({ st0, st1, btPuts }));
    return good;
  });

  await check("analyticsTip", async () => {
    // підказка при наведенні (стовпчик) і з клавіатури (клітинка теплової карти, рядок «що впливає»)
    const hits = await page.$$("#anCols .vz-hit");
    await hits[hits.length - 1].scrollIntoViewIfNeeded();
    const bb = await hits[hits.length - 1].boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForFunction(() => document.getElementById("vizTip")?.style.display === "block", undefined, { timeout: 4000 });
    const col = await $t("#vizTip");
    await page.evaluate(() => document.querySelector("#anHeat td[tabindex]").focus());
    const heat = await $t("#vizTip");
    await page.evaluate(() => document.querySelector("#anDrivers .vz-drow").focus());
    const drv = await $t("#vizTip");
    await page.evaluate(() => document.activeElement.blur());
    const hidden = await page.evaluate(() => document.getElementById("vizTip").style.display === "none");
    const ok = /Тиждень з/.test(col) && col.includes("Threads") && col.includes("Instagram") && col.includes("разом")
      && heat.includes("від твоєї норми") && drv.includes("від твоєї норми") && hidden;
    if (!ok) console.log("   ↳ analyticsTip:", JSON.stringify({ col, heat, drv, hidden }));
    return ok;
  });

  await check("analyticsSort", async () => {
    // перегляди за спаданням; «невідомо» (Telegram, Facebook без переглядів) - унизу в обох напрямках
    await page.click('#anTbl th button[data-k="views"]');
    await page.evaluate(() => { for (let i = 0; i < 10 && document.getElementById("anMore"); i++) document.getElementById("anMore").click(); });
    const col = await page.$$eval("#anTbl .an-tbl tr", (trs) => trs.slice(1).map((tr) => tr.children[1].textContent));
    await page.click('#anTbl th button[data-k="views"]');
    const asc = await page.$$eval("#anTbl .an-tbl tr", (trs) => trs.slice(1).map((tr) => tr.children[1].textContent));
    const num = (t) => (t === "—" ? null : Number(t.replace(/\s/g, "")));
    const nums = col.map(num), firstNull = nums.indexOf(null);
    const desc = nums.slice(0, firstNull).every((v, i, a) => i === 0 || a[i - 1] >= v) && nums.slice(firstNull).every((v) => v === null);
    const an = asc.map(num), aNull = an.indexOf(null);
    const ascOk = an.slice(0, aNull).every((v, i, a) => i === 0 || a[i - 1] <= v) && an.slice(aNull).every((v) => v === null);
    const aria = await page.$eval('#anTbl th[aria-sort="ascending"] button', (b) => b.dataset.k).catch(() => "");
    await page.click('#anTbl th button[data-k="created_at"]');
    const ok = firstNull > 10 && desc && ascOk && aria === "views";
    if (!ok) console.log("   ↳ analyticsSort:", JSON.stringify({ firstNull, desc, ascOk, aria, col: col.slice(0, 8) }));
    return ok;
  });

  await check("analyticsTableView", async () => {
    await page.click('[data-tv="cols"]');
    const rows = await page.evaluate(() => document.querySelectorAll("#anCols table.vz-tbl tr").length);
    const buckets = await page.evaluate(() => AnData.series.buckets.length);
    await page.click('[data-tv="cols"]');
    const back = await page.evaluate(() => !!document.querySelector("#anCols svg"));
    return rows === buckets + 1 && back;
  });

  await check("analyticsCsv", async () => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }), page.click("#anCsv")]);
    const txt = readFileSync(await dl.path(), "utf8");
    const lines = txt.replace(/^﻿/, "").split("\r\n");
    const total = await page.evaluate(() => AnData.posts.length);
    const ok = txt.startsWith("﻿") && dl.suggestedFilename().startsWith("holos-") && lines[0].startsWith('"Дата";"Мережа";"Пост"') && lines.length - 1 === total;
    if (!ok) console.log("   ↳ analyticsCsv:", JSON.stringify({ name: dl.suggestedFilename(), head: lines[0], n: lines.length, total }));
    return ok;
  });

  await check("analyticsFilter", async () => {
    const before = anQueries.length;
    await page.evaluate(() => [...document.querySelectorAll(".anseg button")].find((b) => b.textContent === "30 днів").click());
    await page.waitForFunction(() => document.querySelector(".anseg button.on")?.textContent === "30 днів", undefined, { timeout: 8000 });
    await page.selectOption("#anNet", "threads");
    await page.waitForFunction(() => document.getElementById("anNet")?.value === "threads"
      && [...document.querySelectorAll("#anTbl .an-tbl tr")].slice(1).every((tr) => tr.innerText.includes("Threads")), undefined, { timeout: 8000 });
    const q = anQueries.slice(before);
    const st = await page.evaluate(() => ({ legend: !!document.querySelector("#anCols .vz-legend"), stored: localStorage.getItem("kg_an") || "",
      follow: document.querySelectorAll("#anFollow .vz-facet").length }));
    // назад на типове, щоб наступні перевірки бачили повну картину
    await page.selectOption("#anNet", "all");
    await page.waitForFunction(() => document.getElementById("anNet")?.value === "all", undefined, { timeout: 8000 });
    await page.evaluate(() => [...document.querySelectorAll(".anseg button")].find((b) => b.textContent === "90 днів").click());
    await page.waitForFunction(() => document.querySelector(".anseg button.on")?.textContent === "90 днів", undefined, { timeout: 8000 });
    const ok = q.some((x) => x.days === 30 && x.net === "all") && q.some((x) => x.days === 30 && x.net === "threads")
      && !st.legend && st.follow === 1 && st.stored.includes('"threads"');
    if (!ok) console.log("   ↳ analyticsFilter:", JSON.stringify({ q, st }));
    return ok;
  });

  await check("analyticsRefresh", async () => {
    const q0 = anQueries.length, r0 = anRefreshes;
    // кліком із JS: бульбашка сови-підказки може лежати над кнопкою (людина її просто закриє)
    await page.evaluate(() => document.getElementById("anRefresh").click());
    await page.waitForFunction((n) => document.getElementById("toast")?.textContent.includes("Оновлено"), q0, { timeout: 10000 });
    await page.waitForTimeout(300);
    const toast = await $t("#toast");
    return anRefreshes === r0 + 1 && anQueries.length > q0 && toast.includes("7 постів") && toast.includes("підписники");
  });

  await check("analyticsMobile", async () => {
    // на телефоні сторінка не їде вбік: широка таблиця гортається у своїй рамці, графіки - по ширині
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => selectView("analytics"));
    await page.waitForTimeout(700);
    const st = await page.evaluate(() => {
      // хто вилазить за правий край (крім того, що живе у власній рамці з гортанням)
      const inScroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true; } return false; };
      const off = [...document.querySelectorAll("#analyticsBox *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !inScroller(el); })
        .slice(0, 6).map((el) => el.tagName + "." + (el.className?.baseVal ?? el.className) + " " + Math.round(el.getBoundingClientRect().right));
      return { sw: document.documentElement.scrollWidth, w: innerWidth, off,
        svgW: document.querySelector("#anCols svg")?.getAttribute("width"), tblScroll: getComputedStyle(document.querySelector("#anTbl > div")).overflowX };
    });
    if (process.env.SMOKE_SHOTS) await page.screenshot({ path: join(HERE, "an-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.waitForTimeout(400);
    const ok = st.sw <= st.w + 1 && !st.off.length && Number(st.svgW) <= 390 && st.tblScroll === "auto";
    if (!ok) console.log("   ↳ analyticsMobile:", JSON.stringify(st));
    return ok;
  });

  if (process.env.SMOKE_SHOTS) {
    await page.evaluate(() => selectView("analytics"));
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(HERE, "an-light.png"), fullPage: true });
    await page.evaluate(() => document.body.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(HERE, "an-dark.png"), fullPage: true });
    await page.evaluate(() => document.body.setAttribute("data-theme", "light"));
  }

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

  await check("sttSwitch", async () => {
    // 🎙 Дві межі: провайдер БЕЗ ключа лишається видимим, але заблокованим (інакше людина не
    // розуміє, чому вибору немає), і вибір реально доїжджає на сервер - заглушка станова, тож
    // перевірка падає, якщо селект декоративний.
    await page.evaluate(() => { selectView("settings"); setSTab("channels"); });
    await page.waitForFunction(() => {
      const s = document.getElementById("sttProv");
      return s && s.options.length === 3;
    }, undefined, { timeout: 8000 });
    const before = await page.$eval("#sttProv", (s) => ({
      value: s.value,
      auto: s.options[0].textContent,
      whisperDisabled: s.options[2].disabled,
      whisperText: s.options[2].textContent,
    }));
    await page.evaluate(() => {
      const s = document.getElementById("sttProv");
      s.value = "deepgram"; s.dispatchEvent(new Event("change"));
    });
    await page.evaluate(() => loadSttProvider());          // перечитуємо з сервера, а не з DOM
    await page.waitForFunction(() => document.getElementById("sttProv").value === "deepgram", undefined, { timeout: 8000 });
    return before.value === "auto" && before.auto.includes("Deepgram першим") &&
      before.whisperDisabled && before.whisperText.includes("нема ключа");
  });

  await check("cliAdmin", async () => {
    // 🤖 Claude через підписку. Дві межі разом: (а) адмін бачить, ЧИ живий сайдкар - без цього рядка
    // «чому мої генерації знову платні» діагностується лише в логах, бо фолбек навмисно тихий;
    // (б) дозвіл ставиться ПОКАБІНЕТНО і реально зберігається - заглушка станова, тож перевірка
    // падає, якщо чекбокс декоративний. Плюс «заощаджено» в Аналітиці: виклики через підписку мають
    // cost=0, тобто в таблиці витрат їх не видно взагалі, і без цього рядка економія недоказова.
    await page.evaluate(() => { selectView("settings"); setSTab("profile"); });
    await page.waitForFunction(() => document.getElementById("admCli"), undefined, { timeout: 8000 });
    const status = await $t("#admCli");
    const was = await page.$eval('#admSpend tr[data-ws="ws-1"] .sCli', (el) => el.checked);
    await page.evaluate(() => {
      const tr = document.querySelector('#admSpend tr[data-ws="ws-1"]');
      tr.dataset.smokeOld = "1";                     // мітка на СТАРОМУ вузлі - див. нижче
      tr.querySelector(".sCli").checked = true;
      tr.querySelector(".sSave").click();
    });
    // Чекаємо саме на ПЕРЕМАЛЬОВАНИЙ рядок (мітки на ньому вже немає), інакше перевірка читала б
    // моє ж DOM-присвоєння й проходила навіть тоді, коли кліком нічого не зберігається.
    await page.waitForFunction(() => {
      const tr = document.querySelector('#admSpend tr[data-ws="ws-1"]');
      return tr && !tr.dataset.smokeOld;
    }, undefined, { timeout: 8000 });
    const saved = await page.$eval('#admSpend tr[data-ws="ws-1"] .sCli', (el) => el.checked);
    await page.evaluate(() => selectView("analytics"));
    await page.waitForFunction(() => document.getElementById("cliSaved"), undefined, { timeout: 8000 });
    const savedLine = await $t("#cliSaved");
    return status.includes("сайдкар живий") && was === false && saved === true &&
      savedLine.includes("$1.47") && savedLine.includes("21");
  });

  // 🧵 Причина збою підключення мережі. Спіймано на тестері: Threads відповів «your user must be in
  // the list of Threads testers», а кабінет показав лише «Не вдалося підключити Threads» - і людина
  // тиснула кнопку знову. Перевіряємо ПРОВОДКУ: повідомлення з поп-апа → людський текст причини.
  await check("oauthWhy", async () => {
    const got = await page.evaluate(async () => {
      const out = [], was = window.alert; window.alert = (m) => out.push(String(m));
      const send = (d) => window.postMessage(Object.assign({ oauth: true }, d), location.origin);
      send({ threads: "error", why: "tester" });
      send({ threads: "error", why: "other", msg: "Threads HTTP 500" });
      send({ meta: "error", why: "session" });
      send({ meta: "error", why: "redirect" });
      send({ threads: "error", why: "redirect" });
      await new Promise((r) => setTimeout(r, 400));
      window.alert = was; return out.concat([location.host, location.origin]);
    });
    if (got.length !== 7) console.log("   ↳ oauthWhy:", JSON.stringify(got));
    const [host, origin] = got.slice(5);
    // msg у повідомленні - спроба підсунути свій текст: він НЕ мусить потрапити у вікно
    // «URL Blocked» (адресу не додано в застосунку Meta) - не «скасовано»: називаємо адресу й поле для адміна
    return got.length === 7 && got[0].includes("тестувальник") && got[0].includes("Website permissions")
      && got[1].includes("журнал") && !got[1].includes("Threads HTTP 500") && got[2].includes("іншому браузері")
      && got[3].includes(host) && got[3].includes("Valid OAuth Redirect URIs") && got[3].includes(origin + "/api/integrations/meta/callback") && !got[3].includes("скасовано")
      && got[4].includes("Redirect Callback URLs") && got[4].includes(origin + "/api/integrations/threads/callback");
  });

  await check("adminHealth", async () => {
    // зріз стану сервісу для оператора: цифри за добу і перелік помилок мусять доїхати з /admin/health
    await page.evaluate(() => { selectView("settings"); setSTab("profile"); });
    await page.waitForFunction(() => document.querySelector("#admHealth .card"), undefined, { timeout: 8000 });
    const t = await $t("#admHealth");
    return t.includes("помилок за добу") && t.includes("$1.23") && t.includes("Telegram відмовив") && t.includes("20260902-0320");
  });

  await check("adminAlerts", async () => {
    // 🔔 сповіщення про збої: куди йдуть (Telegram бота, пошта), запасний маршрут, відкрите з підказкою;
    // «Надіслати тест» спершу зберігає, «✓ Вирішено» закриває і панель перемальовується
    // відкриття Налаштувань саме перемальовує панель: чекаємо саме ЦЕЙ рендер (лічильник), інакше набране
    // в поля затер би рендер, що ще в дорозі
    const n0 = await page.evaluate(() => loadAdminAlerts._n || 0);
    await page.evaluate(() => { selectView("settings"); setSTab("profile"); });
    await page.waitForFunction((n) => (loadAdminAlerts._n || 0) > n && document.querySelector("#admAlerts")?.dataset.v === String(loadAdminAlerts._n)
      && document.querySelector("#admAlerts .alRow"), n0, { timeout: 8000 });
    const t = await $t("#admAlerts");
    await page.evaluate(() => { document.querySelector("#alEmails").value = "o.stepeniev@swipescape.eu, ops@rozum.one"; document.querySelector("#alFo").checked = false; });
    await page.click("#alTest");
    await page.waitForFunction(() => /^Тест:/.test(document.querySelector("#toast")?.textContent || ""), undefined, { timeout: 6000 });
    const toast = await $t("#toast");
    await page.click("#admAlerts .alOk");
    await page.waitForFunction(() => !document.querySelector("#admAlerts .alRow"), undefined, { timeout: 6000 });
    const after = await $t("#admAlerts");
    const put = alertCalls.find((c) => c.put)?.put || {};
    const good = t.includes("@R_Socialio_bot") && t.includes("o.stepeniev@swipescape.eu") && t.includes("через OpenAI (gpt-4o)")
      && t.includes("OpenRouter: закінчились кошти") && t.includes("×1440") && t.includes("openrouter.ai/settings/credits")
      && put.failover === false && put.emails === "o.stepeniev@swipescape.eu, ops@rozum.one" && alertCalls.some((c) => c.test)
      && /Telegram ✓/.test(toast) && /пошта ✓/.test(toast) && alertCalls.some((c) => c.resolve === "7") && after.includes("усе гаразд");
    if (!good) console.log("   ↳ adminAlerts:", JSON.stringify({ t: t.slice(0, 400), toast, put, alertCalls, after: after.slice(-120) }));
    return good;
  });

  await check("imgCost", async () => {
    // питання Олега було «спершу зрозуміти вартість» - панель мусить давати ЦИФРУ, а не обіцянку
    await page.evaluate(() => { selectView("brand"); setBTab("visual"); });
    await page.waitForSelector("#imgCostBtn", { timeout: 6000 });
    await page.click("#imgCostBtn");
    await page.waitForFunction(() => document.querySelectorAll("#imgCost .card").length >= 3, undefined, { timeout: 8000 });
    const t = await $t("#imgCost");
    // безкоштовний провайдер - словом «безкоштовно», а не «$0.000», який читається як помилка прайсу
    return t.includes("$0.003") && t.includes("$0.011") && t.includes("$0.020") && t.includes("kie.ai")
      && t.includes("безкоштовно") && !t.includes("$0.000");
  });

  await check("mediaBatch", async () => {
    // пачка фото в медіатеку йде ПОРЦІЯМИ по 10: одним запитом сервер зберіг би 10, а решта впала б
    // з «reach files limit» - і людина не дізналась би навіть про збережені
    mediaPosts.length = 0;
    const msg = await page.evaluate(async () => {
      selectView("settings"); setSTab("sources");
      const dt = new DataTransfer();
      // два файли сервер «уже мав» - людина має побачити, що копій не зроблено
      for (let i = 0; i < 23; i++) dt.items.add(new File([new Uint8Array(64)], (i < 2 ? "dup" : "p") + i + ".jpg", { type: "image/jpeg" }));
      document.getElementById("mediaFile").files = dt.files;
      document.getElementById("mediaUpload").click();
      const el = document.getElementById("mediaMsg");
      for (let i = 0; i < 80 && !/завантажено/.test(el.textContent); i++) await new Promise((r) => setTimeout(r, 100));
      return el.textContent;
    });
    const want = "завантажено: 23 (з них 2 уже були в медіатеці)";
    if (mediaPosts.join(",") !== "10,10,3" || msg !== want) console.log("   ↳ mediaBatch:", JSON.stringify({ mediaPosts, msg }));
    return mediaPosts.join(",") === "10,10,3" && msg === want;
  });

  await check("mediaBytes", async () => {
    // порція не більша за 20 МБ nginx: 3 фото по 8 МБ ідуть двома запитами, а не одним на 24 МБ,
    // який nginx відбив би цілком; файл на 25 МБ (більший за порцію) іде ЧАСТИНАМИ по 8 МБ і доходить
    mediaPosts.length = 0; mediaBytes.length = 0; chunkPuts.length = 0;
    const msg = await page.evaluate(async () => {
      const dt = new DataTransfer();
      for (const [n, mb] of [["a.jpg", 8], ["b.jpg", 8], ["c.jpg", 8], ["huge.jpg", 25]]) dt.items.add(new File([new Uint8Array(mb * 1024 * 1024)], n, { type: "image/jpeg" }));
      document.getElementById("mediaFile").files = dt.files;
      document.getElementById("mediaUpload").click();
      const el = document.getElementById("mediaMsg");
      for (let i = 0; i < 150 && !/завантажено/.test(el.textContent); i++) await new Promise((r) => setTimeout(r, 100));
      return el.textContent;
    });
    const huge = chunkPuts.filter((c) => c.name === "huge.jpg");
    const MB = 1024 * 1024;
    const good = mediaPosts.join(",") === "2,1" && mediaBytes.every((b) => b <= 20 * MB)
      && huge.map((c) => c.bytes).join(",") === [8 * MB, 8 * MB, 8 * MB, MB].join(",") && huge.every((c, i) => c.offset === i * 8 * MB)
      && msg === "завантажено: 4";
    if (!good) console.log("   ↳ mediaBytes:", JSON.stringify({ mediaPosts, mb: mediaBytes.map((b) => Math.round(b / 1048576)), huge, msg }));
    return good;
  });

  await check("videoLibrary", async () => {
    // відео в медіатеці - кадр-мініатюра з тривалістю, а не <video>, що тягнув би весь файл
    await page.evaluate(() => { selectView("settings"); setSTab("sources"); return loadMedia(); });
    await page.waitForSelector('#mediaGrid [data-id="mv1"] .vbadge', { timeout: 5000 });
    const st = await page.evaluate(() => ({ badge: document.querySelector('#mediaGrid [data-id="mv1"] .vbadge').textContent,
      src: document.querySelector('#mediaGrid [data-id="mv1"] img').getAttribute("src"), videos: document.querySelectorAll("#mediaGrid video").length }));
    if (!(st.badge === "▶ 1:15" && st.src === "/thumb/lib.mp4" && st.videos === 0)) console.log("   ↳ videoLibrary:", JSON.stringify(st));
    return st.badge === "▶ 1:15" && st.src === "/thumb/lib.mp4" && st.videos === 0;
  });

  await check("cfProvider", async () => {
    // ☁️ Cloudflare - перший у списку (безкоштовний) і доступний, коли обидва ключі є; вибір
    // реально їде на сервер
    await page.evaluate(() => { selectView("brand"); setBTab("visual"); return loadImageProvider(); });
    await page.waitForFunction(() => { const s = document.getElementById("imgProv"); return s && s.options.length === 4; }, undefined, { timeout: 8000 });
    const o = await page.$eval("#imgProv", (s) => ({ first: s.options[0].value, text: s.options[0].textContent, dis: s.options[0].disabled, fal: s.options[2].textContent }));
    const sent = await page.evaluate(() => new Promise((resolve) => {
      const was = window.fetch;
      window.fetch = (u, init) => { if (String(u).includes("/integrations/images") && init && init.method === "POST") { window.fetch = was; resolve(init.body); } return was(u, init); };
      const s = document.getElementById("imgProv"); s.value = "cloudflare"; s.dispatchEvent(new Event("change"));
      setTimeout(() => { window.fetch = was; resolve(null); }, 3000);
    }));
    return o.first === "cloudflare" && o.text.includes("безкоштовно") && !o.dis && o.fal.includes("нема ключа")
      && String(sent).includes('"cloudflare"');
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

  // фідбек тестера: «писав текст на 3 публікаціях, перемкнувся на 5 - текст зник»
  await check("topicKeepsText", async () => {
    await page.evaluate(() => openAddMaterial());
    await page.waitForSelector(".modal #amTopic", { timeout: 4000 });
    await page.type(".modal #amTopic", "чому база клієнтів - головний капітал");
    await page.evaluate(() => { const c = document.querySelector('.modal #amCountChips [data-n="5"]'); if (c) c.click(); });
    await page.waitForTimeout(150);
    const st = await page.evaluate(() => ({
      text: (document.querySelector(".modal #amTopic") || {}).value || "",
      five: !!document.querySelector('.modal #amCountChips [data-n="5"].on'),
    }));
    await page.evaluate(() => { const x = document.querySelector(".modal #amX"); if (x) x.click(); });
    return st.five && st.text === "чому база клієнтів - головний капітал";
  });

  // фідбек тестера: «не можу зняти з публікації Telegram» - увімкнена, але НЕ підключена мережа
  // блокувалась як «не підключено» і не знімалась; тепер її можна зняти, а вимкнену - як і раніше, ні
  await check("offNotConnected", async () => {
    await page.evaluate((id) => openComposer(id), P2); // instagram on, у статусі каналів - не підключено
    await page.waitForSelector(".cmp-ov #cmpChips .netgrp", { timeout: 6000 });
    const before = await page.evaluate(() => {
      const ig = document.querySelector('#cmpChips .netchip[data-net="instagram"]');
      const fb = document.querySelector('#cmpChips .netchip[data-net="facebook"]'); // off + не підключено
      return { igOn: ig.classList.contains("on"), igWarn: ig.classList.contains("warn"), igEnabled: !ig.disabled, fbDisabled: fb.disabled, prev: document.querySelectorAll("#cmpPrev .pvcard, #cmpPrev [data-pv]").length };
    });
    await page.evaluate(() => document.querySelector('#cmpChips .netchip[data-net="instagram"]').click());
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => {
      const ig = document.querySelector('#cmpChips .netchip[data-net="instagram"]');
      return { igOn: ig.classList.contains("on"), igDisabled: ig.disabled };
    });
    await page.evaluate(() => { const b = document.querySelector("#cmpBack"); if (b) b.click(); });
    await page.waitForTimeout(200);
    return before.igOn && before.igWarn && before.igEnabled && before.fbDisabled && !after.igOn && after.igDisabled;
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
    return acts.length === 4 && acts.some((a) => a.includes("Фото")) && acts.some((a) => a.includes("Відео")) && pic.includes("ai.jpg");
  });

  await check("tgappVideo", async () => {
    // 🎬 пост із відео в Mini App: плеєр замість фото, «Прибрати відео», без «＋ Ще фото»
    const st = await tgPage.evaluate(() => {
      const keep = { media: cur.media, filename: cur.filename };
      cur.media = ["clip.mp4"]; cur.filename = "clip.mp4"; drawEditor();
      const out = { video: !!document.querySelector(".sheet video.thumb"), del: (document.getElementById("aDelPic") || {}).textContent || "", more: !!document.getElementById("aMore"), vid: !!document.getElementById("aVid") };
      cur.media = keep.media; cur.filename = keep.filename; drawEditor();
      return out;
    });
    return st.video && /Прибрати відео/.test(st.del) && !st.more && st.vid;
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

  await check("tgappBrand", async () => {
    // 🏢 кілька брендів: вибір угорі; зміна - POST /brand і перезавантаження вже з новим брендом
    const opts = await tgPage.$$eval("#brandSel option", (els) => els.map((e) => ({ v: e.value, t: e.textContent, s: e.selected })));
    const shown = await tgPage.$eval("#brandBar", (el) => getComputedStyle(el).display !== "none");
    await Promise.all([tgPage.waitForNavigation({ timeout: 8000 }).catch(() => null), tgPage.selectOption("#brandSel", "w2")]);
    await tgPage.waitForFunction(() => document.querySelector("#view textarea") && document.getElementById("brandSel")?.value, undefined, { timeout: 10000 });
    const after = await tgPage.$eval("#brandSel", (el) => el.value);
    const good = shown && opts.length === 2 && opts[0].s && opts[1].t === "Vary Servis & Úklid" && TG_BRAND.calls.join() === "w2" && after === "w2";
    if (!good) console.log("   ↳ tgappBrand:", JSON.stringify({ opts, shown, calls: TG_BRAND.calls, after }));
    return good;
  });

  await check("fcMetaExtras", async () => {
    // 💬 дозволи Meta на коментарі й статистику - окремими кнопками в картці Facebook + Instagram;
    // наданий дозвіл - «✓ дозволено», кнопка веде у вікно Meta саме з ?add=<що>
    API["GET /integrations/meta"] = { configured: true, hasToken: true, pageName: "Глемпінг", igUsername: "kemp", expiresAt: null, extras: { comments: false, insights: true }, granted: [] };
    const st = await page.evaluate(async () => {
      window.__popups = []; window.connectPopup = (u) => { window.__popups.push(u); return false; };
      selectView("settings"); setSTab("channels"); await loadMeta();
      const ex = document.getElementById("mtExtras");
      const btn = ex && ex.querySelector('[data-mtadd="comments"]'); if (btn) btn.click();
      return { shown: !!ex && ex.style.display !== "none", rows: ex ? ex.querySelectorAll(".card").length : 0,
        commentsBtn: !!btn && /Дозволити коментарі/.test(btn.textContent), insightsOk: !!ex && /Перегляди постів Facebook[\s\S]*✓ дозволено/.test(ex.textContent),
        insightsBtn: !!(ex && ex.querySelector('[data-mtadd="insights"]')), inboxBtn: !!(ex && ex.querySelector('[data-mtadd="inbox"]') && /Дозволити читати коментарі/.test(ex.querySelector('[data-mtadd="inbox"]').textContent)), popups: window.__popups };
    });
    const good = st.shown && st.rows === 3 && st.commentsBtn && st.insightsOk && !st.insightsBtn && st.inboxBtn && st.popups.length === 1 && st.popups[0] === "/api/integrations/meta/connect?add=comments";
    if (!good) console.log("   ↳ fcMetaExtras:", JSON.stringify(st));
    return good;
  });

  await check("fcComposer", async () => {
    // композер: коментар у прев'ю кожної мережі так, як його побачать під постом; Telegram - чесно «не
    // піде»; «без коментаря тут» і «↺ як у всіх» для однієї мережі; лічильник - під найсуворішу межу
    // (LinkedIn 1250); попередження, що Meta ще не дала дозволу (стан з попередньої перевірки)
    await page.evaluate(() => { window.__cs2 = { ...ChanStatus }; ChanStatus.instagram = true; ChanStatus.linkedin = true; });
    await closeComposers();
    await page.evaluate((id) => openComposer(id), P8);
    await page.waitForSelector(".cmp-ov #cmpFc", { timeout: 6000 });
    await page.waitForFunction(() => /дозволу на коментарі/.test((document.querySelector("#cmpFcState") || {}).textContent || ""), undefined, { timeout: 6000 }).catch(() => {});
    const st = await page.evaluate(() => {
      // телефон мережі - перший .phone після її мітки .pv-label
      const ph = (k) => { const l = [...document.querySelectorAll("#cmpPrev .pv-label")].find((x) => x.textContent === k); let n = l && l.nextElementSibling; while (n && !n.classList.contains("phone")) n = n.nextElementSibling; return n; };
      const igPh = ph("Instagram"), liPh = ph("LinkedIn"), tgPh = ph("Telegram");
      return { val: document.querySelector("#cmpFc").value,
        ig: igPh && (igPh.querySelector(".pv-fc .pv-fc-t") || {}).textContent, li: liPh && (liPh.querySelector(".pv-fc .pv-fc-t") || {}).textContent,
        tg: tgPh && (tgPh.querySelector(".pv-fc-off") || {}).textContent, cnt: document.querySelector("#cmpFcCnt").textContent,
        chips: [...document.querySelectorAll("#cmpFcNets .fcchip")].map((x) => x.textContent + (x.classList.contains("off") ? "(off)" : "")).join("|"),
        warn: document.querySelector("#cmpFcState").textContent };
    });
    // Instagram - без коментаря тут; прев'ю й чіп це показують; потім ↺ повертає спільний
    await page.evaluate(() => document.querySelector('#cmpPrev [data-fcoff="instagram"]').click());
    const off = await page.evaluate(() => ({ note: [...document.querySelectorAll("#cmpPrev .pv-fc-off")].map((x) => x.textContent).join("|"),
      chips: [...document.querySelectorAll("#cmpFcNets .fcchip")].map((x) => x.textContent + (x.classList.contains("off") ? "(off)" : "")).join("|") }));
    await page.evaluate(() => document.querySelector('#cmpPrev [data-fcreset="instagram"]').click());
    const back = await page.evaluate(() => document.querySelectorAll("#cmpPrev .pv-fc").length);
    // задовгий для LinkedIn - лічильник червоний саме з межею LinkedIn
    await page.evaluate(() => { const t = document.querySelector("#cmpFc"); t.value = "я".repeat(1300); t.dispatchEvent(new Event("input")); });
    const long = await page.evaluate(() => ({ cnt: document.querySelector("#cmpFcCnt").textContent, red: document.querySelector("#cmpFcCnt").style.color.includes("danger"),
      liWarn: /1300\/1250 - задовгий для LinkedIn/.test(document.querySelector("#cmpPrev").textContent) }));
    await page.evaluate(() => { const t = document.querySelector("#cmpFc"); t.value = "  Коротко: https://x  "; t.dispatchEvent(new Event("input")); });
    postPuts.length = 0; chanSaves.length = 0;
    await page.evaluate(() => document.querySelector("#cmpSave").click());
    await page.waitForFunction(() => /збережено/.test((document.querySelector(".cmp-ov #cmpMsg") || {}).textContent || ""), undefined, { timeout: 6000 }).catch(() => {});
    const put = postPuts.find((x) => x.id === P8);
    const good = st.val === "Список речей: https://rozum.one/list" && st.ig && st.ig.includes("Список речей") && st.li && st.li.includes("Список речей")
      && /у Telegram коментар не піде/.test(st.tg || "") && st.cnt === "36/1250 (LinkedIn)" && st.chips === "Telegram(off)|✓ Instagram|✓ LinkedIn"
      && /Instagram ще не дали дозволу на коментарі/.test(st.warn)
      && /без першого коментаря в Instagram/.test(off.note) && off.chips === "Telegram(off)|Instagram(off)|✓ LinkedIn" && back === 2
      && long.cnt === "1300/1250 (LinkedIn)" && long.red && long.liWarn
      && !!put && put.body.first_comment === "  Коротко: https://x  ";
    if (!good) console.log("   ↳ fcComposer:", JSON.stringify({ st, off, back, long, put }));
    await closeComposers();
    await page.evaluate(() => { Object.assign(ChanStatus, window.__cs2); });
    return good;
  });

  await check("igExtras", async () => {
    // 📸 Instagram: співавтори (до 3, нормалізація, сміття названо) і шапка прев'ю «ваш_профіль і …»;
    // ALT на фото - опис зберігається й кадр показує «ALT ✓»
    await page.evaluate(() => { window.__cs4 = { ...ChanStatus }; ChanStatus.instagram = true; ChanStatus.linkedin = true; });
    await closeComposers();
    await page.evaluate((id) => openComposer(id), P8);
    await page.waitForSelector(".cmp-ov #cmpCollab", { timeout: 6000 });
    await page.evaluate(() => { const i = document.querySelector("#cmpCollab"); i.value = "@Partner.Glamp, friend_1 нік! a"; i.dispatchEvent(new Event("input")); });
    const st = await page.evaluate(() => {
      const lbl = [...document.querySelectorAll("#cmpPrev .pv-label")].find((x) => x.textContent === "Instagram");
      let ph = lbl && lbl.nextElementSibling; while (ph && !ph.classList.contains("phone")) ph = ph.nextElementSibling;
      return { shown: document.querySelector("#cmpIgBox").style.display !== "none", hint: document.querySelector("#cmpCollabHint").textContent,
        head: ph ? ph.querySelector(".phone-h .phone-user").textContent.replace(/\s+/g, " ").trim() : null,
        altBtn: (document.querySelector('#cmpMediaWrap [data-alt="c8"]') || {}).textContent || null };
    });
    await page.evaluate(() => { window.prompt = () => "  Три речі для походу  на столі "; document.querySelector('#cmpMediaWrap [data-alt="c8"]').click(); });
    await page.waitForFunction(() => /ALT ✓/.test((document.querySelector('#cmpMediaWrap [data-alt="c8"]') || {}).textContent || ""), undefined, { timeout: 5000 }).catch(() => {});
    const alt = await page.evaluate(() => { const b = document.querySelector('#cmpMediaWrap [data-alt="c8"]'); return { t: b && b.textContent, on: !!b && b.classList.contains("on"), title: b && b.title }; });
    chanSaves.length = 0;
    await page.evaluate(() => document.querySelector("#cmpSave").click());
    await page.waitForFunction(() => /збережено/.test((document.querySelector(".cmp-ov #cmpMsg") || {}).textContent || ""), undefined, { timeout: 6000 }).catch(() => {});
    const saved = chanSaves.find((x) => x.id === P8);
    // сторіс: блоку Instagram нема (співавторів і опису сторіс не мають)
    await page.evaluate(() => { const f = document.querySelector("#cmpFormat"); f.value = "story"; f.dispatchEvent(new Event("change")); });
    const inStory = await page.evaluate(() => ({ box: document.querySelector("#cmpIgBox").style.display, alt: !!document.querySelector("#cmpMediaWrap [data-alt]") }));
    const good = st.shown && /@partner\.glamp, @friend_1, @a/.test(st.hint) && /не схоже на нік: нік!/.test(st.hint) && st.head === "ваш_профіль і partner.glamp та ще 2"
      && st.altBtn === "ALT" && alt.t === "ALT ✓" && alt.on && /Три речі для походу на столі/.test(alt.title)
      && altPuts.length === 1 && altPuts[0].id === "c8"
      && !!saved && JSON.stringify(saved.channels.instagram.collaborators) === JSON.stringify(["partner.glamp", "friend_1", "a"])
      && inStory.box === "none" && !inStory.alt;
    if (!good) console.log("   ↳ igExtras:", JSON.stringify({ st, alt, altPuts, saved: saved && saved.channels.instagram, inStory }));
    await closeComposers();
    await page.evaluate(() => { Object.assign(ChanStatus, window.__cs4); });
    return good;
  });

  await check("accountPicker", async () => {
    // 👥 кілька акаунтів однієї мережі (особистий і компанії) і кілька каналів Telegram: ГАЛОЧКИ -
    // пост одразу в кілька. Рядок лише для мереж, де акаунтів 2+; прев'ю підписане першим акаунтом і
    // каже, куди ще піде; вибір «як за замовчуванням» не зберігається; прибраний із бренду - червоним
    await page.evaluate(() => { window.__cs5 = JSON.parse(JSON.stringify(ChanStatus)); ChanStatus.facebook = true; ChanStatus.threads = true; ChanStatus.instagram = true; ChanStatus.telegram = true;
      ChanStatus.accounts = { facebook: [{ id: "111", name: "Oleg Stepeniev", main: true }, { id: "222", name: "Rozum.one", main: false }],
        instagram: [{ id: "igu", name: "@olegalisio", main: true }],
        threads: [{ id: "901", name: "@olegalisio", main: true }, { id: "902", name: "@rozum.one", main: false }],
        telegram: [{ id: "-1001", name: "Мій канал", main: true }, { id: "-1002", name: "Канал компанії", main: false }] }; });
    const keep = JSON.parse(JSON.stringify(P8POST.channels));
    P8POST.channels = { facebook: { on: true }, threads: { on: true, account: "999" }, instagram: { on: true }, telegram: { on: true } };
    const head = (net) => { const l = [...document.querySelectorAll("#cmpPrev .pv-label")].find((x) => x.textContent === net); let n = l && l.nextElementSibling; while (n && !n.classList.contains("phone")) n = n.nextElementSibling; return n ? n.querySelector(".phone-h .phone-user").textContent : null; };
    await closeComposers();
    await page.evaluate((id) => openComposer(id), P8);
    await page.waitForSelector(".cmp-ov #cmpAccs .accchk", { timeout: 6000 });
    const rows = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#cmpAccs .accrow")].map((r) => [r.querySelector(".acclab").textContent,
      [...r.querySelectorAll(".accchk")].map((b) => b.textContent.replace(/\s+/g, " ").trim() + (b.classList.contains("bad") ? "(bad)" : ""))])));
    const st = await rows();
    const pv0 = await page.evaluate((h) => { const head = eval(h); return { fb: head("Facebook"), ig: head("Instagram"), tg: head("Telegram") }; }, head.toString());
    const click = (net, txt) => page.evaluate(([n, t]) => { const b = [...document.querySelectorAll(`#cmpAccs .accchk[data-acct="${n}"]`)].find((x) => x.textContent.includes(t)); if (b) b.click(); return !!b; }, [net, txt]);
    await click("facebook", "Rozum.one");            // + компанія
    await click("threads", "прибрано");              // зняли прибраний - пост піде основним
    await click("threads", "@rozum.one");            // + компанія
    await click("telegram", "Канал компанії");       // + другий канал
    const st2 = await rows();
    const pv = await page.evaluate(() => [...document.querySelectorAll("#cmpPrev .pv-accs")].map((x) => x.textContent));
    if (process.env.SMOKE_SHOTS) { await new Promise((r) => setTimeout(r, 900)); await page.screenshot({ path: join(HERE, "accounts-composer.png") }); }
    chanSaves.length = 0;
    await page.evaluate(() => document.querySelector("#cmpSave").click());
    await page.waitForFunction(() => /збережено/.test((document.querySelector(".cmp-ov #cmpMsg") || {}).textContent || ""), undefined, { timeout: 6000 }).catch(() => {});
    const last = chanSaves[chanSaves.length - 1];
    // зняти особисту - лишиться компанія; зняти й її - не можна (остання галочка), лише повідомлення
    await click("facebook", "Oleg Stepeniev");
    await click("facebook", "Rozum.one");
    const lastMsg = await page.evaluate(() => document.querySelector(".cmp-ov #cmpMsg").textContent);
    chanSaves.length = 0;
    await page.evaluate(() => document.querySelector("#cmpSave").click());
    await page.waitForFunction(() => /збережено/.test((document.querySelector(".cmp-ov #cmpMsg") || {}).textContent || ""), undefined, { timeout: 6000 }).catch(() => {});
    const last2 = chanSaves[chanSaves.length - 1];
    const good = JSON.stringify(st) === JSON.stringify({ "Facebook:": ["☑ Oleg Stepeniev основна", "☐ Rozum.one"], "Threads:": ["☐ @olegalisio основний", "☐ @rozum.one", "☑ ⚠ акаунт …999 - прибрано з бренду(bad)"], "Telegram · канали:": ["☑ Мій канал основний", "☐ Канал компанії"] })
      && pv0.fb === "Oleg Stepeniev" && pv0.ig === "olegalisio" && pv0.tg === "Мій канал"
      && JSON.stringify(st2["Facebook:"]) === JSON.stringify(["☑ Oleg Stepeniev основна", "☑ Rozum.one"]) && JSON.stringify(st2["Threads:"]) === JSON.stringify(["☑ @olegalisio основний", "☑ @rozum.one"])
      && pv.some((x) => /піде від: Oleg Stepeniev · Rozum\.one/.test(x)) && pv.some((x) => /у канали: Мій канал · Канал компанії/.test(x))
      && !!last && JSON.stringify(last.channels.facebook.accounts) === '["111","222"]' && JSON.stringify(last.channels.threads.accounts) === '["901","902"]' && !("account" in last.channels.threads)
      && JSON.stringify(last.channels.telegram.accounts) === '["-1001","-1002"]' && !last.channels.instagram.accounts
      && /має лишитись/.test(lastMsg) && !!last2 && JSON.stringify(last2.channels.facebook.accounts) === '["222"]';
    if (!good) console.log("   ↳ accountPicker:", JSON.stringify({ st, pv0, st2, pv, last: last && last.channels, lastMsg, last2: last2 && last2.channels.facebook }));
    await closeComposers();
    P8POST.channels = keep;
    await page.evaluate(() => { ChanStatus = window.__cs5; });
    return good;
  });

  await check("accountPartial", async () => {
    // 👥 пост уже вийшов особистою Сторінкою, а обрано дві: особиста - ✓ з посиланням (зняти не можна),
    // компанія - ще попереду; мережа «◐» (не вся), публікація йде; зняли компанію - мережа ✓
    await page.evaluate(() => { window.__cs6 = JSON.parse(JSON.stringify(ChanStatus)); ChanStatus.facebook = true;
      ChanStatus.accounts = { facebook: [{ id: "111", name: "Oleg Stepeniev", main: true }, { id: "222", name: "Rozum.one", main: false }], instagram: [], threads: [], telegram: [] }; });
    const keep = JSON.parse(JSON.stringify(P8POST.channels));
    P8POST.channels = { facebook: { on: true, accounts: ["111", "222"] } };
    P8STATE = { sent: ["facebook"], links: { facebook: "https://www.facebook.com/111/posts/1" }, accounts: { facebook: "Oleg Stepeniev" },
      comments: [{ network: "facebook", account: "111", status: "sent" }],
      sentTo: [{ net: "facebook", account: "111", name: "Oleg Stepeniev", link: "https://www.facebook.com/111/posts/1", comment: { status: "sent", error: null, due_at: null } }] };
    await closeComposers();
    await page.evaluate((id) => openComposer(id), P8);
    await page.waitForSelector(".cmp-ov #cmpAccs .accchk.sent", { timeout: 6000 });
    const st = await page.evaluate(() => ({
      chip: document.querySelector('#cmpChips .netchip[data-net="facebook"]').textContent.trim(),
      chipDis: document.querySelector('#cmpChips .netchip[data-net="facebook"]').disabled,
      accs: [...document.querySelectorAll("#cmpAccs .accchk")].map((b) => b.textContent.replace(/\s+/g, " ").trim() + (b.classList.contains("sent") ? "(sent)" : "")),
      link: (document.querySelector("#cmpAccs .accchk.sent a") || {}).href || "",
      pv: (document.querySelector("#cmpPrev .pv-accs") || {}).textContent || "",
      cnt: !!document.querySelector("#cmpPrev .cmp-cnt"),
      fcSend: !!document.querySelector("#cmpFcSend") }));
    await page.evaluate(() => { const b = [...document.querySelectorAll('#cmpAccs .accchk[data-acct="facebook"]')].find((x) => x.textContent.includes("Rozum.one")); b.click(); });
    const st2 = await page.evaluate(() => ({ chip: document.querySelector('#cmpChips .netchip[data-net="facebook"]').textContent.trim(), sel: document.querySelectorAll("#cmpAccs .accchk").length }));
    const good = st.chip === "◐ Facebook" && st.chipDis && JSON.stringify(st.accs) === JSON.stringify(["✓ Oleg Stepeniev ↗(sent)", "☑ Rozum.one"]) && /facebook\.com\/111/.test(st.link)
      && /✓ Oleg Stepeniev ↗ · Rozum\.one/.test(st.pv) && st.cnt && !st.fcSend && st2.chip === "✓ Facebook";
    if (!good) console.log("   ↳ accountPartial:", JSON.stringify({ st, st2 }));
    await closeComposers();
    P8POST.channels = keep; P8STATE = null;
    await page.evaluate(() => { ChanStatus = window.__cs6; });
    return good;
  });

  await check("tgChats", async () => {
    // 📣 Канали → Telegram: список каналів бренду (основний позначено, скільки постів чекають),
    // «＋ Додати канал» за @назвою, «Прибрати» з попередженням про пости; «Через бота» - лише коли DM бота живі
    tgOps.length = 0;
    await page.evaluate(async () => { selectView("settings", "channels"); await loadTelegram(); });
    await page.waitForFunction(() => document.querySelectorAll("#tgChats .acc-row").length === 2, undefined, { timeout: 6000 }).catch(() => {});
    const st = await page.evaluate(() => ({ rows: [...document.querySelectorAll("#tgChats .acc-row")].map((r) => [...r.children].map((c) => c.textContent).join(" ").replace(/\s+/g, " ").trim()),
      box: getComputedStyle(document.querySelector("#tgChatsBox")).display !== "none", via: getComputedStyle(document.querySelector("#tgChatViaBot")).display }));
    if (process.env.SMOKE_SHOTS) { await page.evaluate(() => document.querySelector("#tgChatsBox").scrollIntoView({ block: "center" })); await new Promise((r) => setTimeout(r, 500)); await page.screenshot({ path: join(HERE, "tg-chats.png") }); }
    await page.evaluate(() => { document.querySelector("#tgChatIn").value = "@newchan"; document.querySelector("#tgChatAdd").click(); });
    await page.waitForFunction(() => /додано/.test(document.querySelector("#tgChatMsg").textContent), undefined, { timeout: 6000 }).catch(() => {});
    const msg = await page.evaluate(() => document.querySelector("#tgChatMsg").textContent);
    await page.evaluate(() => { window.__conf = ""; window.confirm = (m) => { window.__conf = m; return true; }; document.querySelector('#tgChats [data-tgrm="-1002"]').click(); });
    await new Promise((r) => setTimeout(r, 500));
    const conf = await page.evaluate(() => window.__conf);
    const good = st.box && st.rows.length === 2 && /^Мій канал канал · @mychan основний/.test(st.rows[0]) && /Канал компанії канал.*2 пости чекають на нього.*Прибрати/.test(st.rows[1])
      && st.via === "none" && /✓ «Новий канал» додано/.test(msg)
      && tgOps.some((o) => o.op === "add" && o.body.chat === "@newchan") && tgOps.some((o) => o.op === "remove" && o.body.chatId === "-1002")
      && /Прибрати «Канал компанії»/.test(conf) && /2 пости обрали саме цей канал/.test(conf);
    if (!good) console.log("   ↳ tgChats:", JSON.stringify({ st, msg, conf, ops: tgOps }));
    return good;
  });

  await check("channelsAccounts", async () => {
    // 👥 Канали: список акаунтів Threads і Сторінок (основний, «Зробити основним», «Прибрати» з
    // попередженням про пости, що на нього чекають), Сторінки з входу Meta - «＋ Додати до бренду»
    const keep = { th: API["GET /integrations/threads"], mt: API["GET /integrations/meta"], pages: API["GET /integrations/meta/pages"] };
    API["GET /integrations/threads"] = { configured: true, hasToken: true, username: "olegalisio",
      accounts: [{ userId: "901", username: "olegalisio", main: true, posts: 0 }, { userId: "902", username: "rozum.one", main: false, posts: 2 }] };
    API["GET /integrations/meta"] = { configured: true, hasToken: true, pageName: "Oleg Stepeniev", igUsername: "olegalisio", extras: {},
      accounts: [{ pageId: "111", pageName: "Oleg Stepeniev", igUsername: "olegalisio", main: true, posts: 0 }, { pageId: "222", pageName: "Rozum.one", igUsername: "rozum.one", main: false, posts: 0 }] };
    API["GET /integrations/meta/pages"] = [{ id: "111", name: "Oleg Stepeniev", ig: "olegalisio", current: true, added: true },
      { id: "222", name: "Rozum.one", ig: "rozum.one", added: true }, { id: "333", name: "Vary Servis", ig: "servisvary", added: false }];
    accOps.length = 0;
    await page.evaluate(async () => { selectView("settings", "channels"); await loadThreads(); await loadMeta(); });
    await page.waitForFunction(() => document.querySelectorAll("#mtAccs .acc-row").length >= 3, undefined, { timeout: 6000 }).catch(() => {});
    const st = await page.evaluate(() => ({
      th: [...document.querySelectorAll("#thAccs .acc-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim()),
      add: getComputedStyle(document.querySelector("#thAdd")).display !== "none", dis: document.querySelector("#thDisconnect").textContent,
      mt: [...document.querySelectorAll("#mtAccs .acc-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim()) }));
    if (process.env.SMOKE_SHOTS) {
      await page.evaluate(() => document.querySelector("#thAccs").scrollIntoView({ block: "center" }));
      await new Promise((r) => setTimeout(r, 600));
      await page.screenshot({ path: join(HERE, "accounts-threads.png") });
      await page.evaluate(() => document.querySelector("#mtAccs").scrollIntoView({ block: "center" }));
      await page.screenshot({ path: join(HERE, "accounts-meta.png") });
    }
    await page.evaluate(() => { window.__conf = ""; window.confirm = (m) => { window.__conf = m; return true; }; });
    await page.evaluate(() => document.querySelector('#thAccs [data-thmain="902"]').click());
    await page.evaluate(() => document.querySelector('#thAccs [data-thrm="902"]').click());
    await page.evaluate(() => document.querySelector('#mtAccs [data-mtadd="333"]').click());
    await page.waitForFunction(() => true, undefined, { timeout: 100 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    const conf = await page.evaluate(() => window.__conf);
    const good = st.th.length === 2 && /@olegalisio\s*основний/.test(st.th[0]) && /@rozum\.one.*2 пости чекають.*Зробити основним.*Прибрати/.test(st.th[1])
      && st.add && st.dis === "Відключити всі"
      && st.mt.length === 3 && /Rozum\.one.*IG @rozum\.one.*Зробити основною/.test(st.mt[1]) && /Vary Servis.*Додати до бренду/.test(st.mt[2])
      && accOps.some((o) => o.net === "threads" && o.op === "main" && o.body.userId === "902")
      && accOps.some((o) => o.net === "threads" && o.op === "remove" && o.body.userId === "902")
      && accOps.some((o) => o.net === "meta" && o.op === "add" && o.body.pageId === "333")
      && /2 пости обрали саме цей акаунт/.test(conf);
    if (!good) console.log("   ↳ channelsAccounts:", JSON.stringify({ st, ops: accOps, conf }));
    Object.assign(API, { "GET /integrations/threads": keep.th, "GET /integrations/meta": keep.mt, "GET /integrations/meta/pages": keep.pages });
    await page.evaluate(async () => { window.confirm = () => true; await loadThreads(); await loadMeta(); });
    return good;
  });

  await check("fcSend", async () => {
    // опублікований пост: Instagram - «✓ опубліковано», LinkedIn - «не вийшов» із причиною й кнопкою
    // «↻ Надіслати коментар (LinkedIn)»; після натискання стан перечитується, аж поки коментар не стоїть
    API["GET /integrations/meta"] = { configured: true, hasToken: true, pageName: "Глемпінг", igUsername: "kemp", expiresAt: null, extras: { comments: true, insights: true }, granted: [] };
    await page.evaluate(() => { window.__cs3 = { ...ChanStatus }; ChanStatus.instagram = true; ChanStatus.linkedin = true; });
    await closeComposers();
    await page.evaluate((id) => openComposer(id), P9);
    await page.waitForSelector(".cmp-ov #cmpFcSend", { timeout: 6000 });
    const before = await page.evaluate(() => ({ btn: document.querySelector("#cmpFcSend").textContent,
      prev: document.querySelector("#cmpPrev").textContent.replace(/\s+/g, " "),
      acts: document.querySelectorAll('#cmpPrev [data-fcedit="instagram"], #cmpPrev [data-fcoff="instagram"]').length }));
    await page.evaluate(() => document.querySelector("#cmpFcSend").click());
    await page.waitForFunction(() => /коментар під постом ✓/.test((document.querySelector(".cmp-ov #cmpMsg") || {}).textContent || ""), undefined, { timeout: 12000 }).catch(() => {});
    const after = await page.evaluate(() => ({ msg: document.querySelector(".cmp-ov #cmpMsg").textContent, btn: !!document.querySelector("#cmpFcSend"),
      chips: [...document.querySelectorAll("#cmpFcNets .fcchip")].map((x) => x.textContent).join("|") }));
    const good = before.btn === "↻ Надіслати коментар (LinkedIn)" && /✓ опубліковано/.test(before.prev) && /⚠ не вийшов: LinkedIn не дав/.test(before.prev)
      && before.acts === 0 && fcSends.length === 1 && fcSends[0] === P9 && /коментар під постом ✓/.test(after.msg) && !after.btn && after.chips === "💬✓ Instagram|💬✓ LinkedIn";
    if (!good) console.log("   ↳ fcSend:", JSON.stringify({ before, after, fcSends }));
    await closeComposers();
    await page.evaluate(() => { Object.assign(ChanStatus, window.__cs3); });
    API["GET /integrations/meta"] = { connected: false };
    return good;
  });

  await check("fcStudio", async () => {
    // картка Студії: коментар не вийшов - червоний «💬 ⚠», клік веде в композер (там причина й кнопка)
    const st = await page.evaluate(async () => {
      selectView("create"); setCTab("posts"); await loadStudioPosts();
      const keep = [StudioFilter, StudioRubric, StudioFormat, StudioOrigin];
      StudioFilter = "all"; StudioRubric = ""; StudioFormat = ""; StudioOrigin = "";
      const id = "abababab-abab-abab-abab-abababababab";
      Finals.push({ id, content: "Пост із коментарем, що не вийшов", review: "approved", channels: { instagram: { on: true } }, first_comment: "x", comment: { failed: true, sent: false }, sent: ["instagram"], links: {}, format: "post" });
      Finals.push({ id: id.replace(/a/g, "c"), content: "Пост, коментар стоїть", review: "approved", channels: { instagram: { on: true } }, first_comment: "x", comment: { failed: false, sent: true }, sent: ["instagram"], links: {}, format: "post" });
      StudioFilter = "published"; renderStudio();
      const tag = [...document.querySelectorAll('.pcard[data-post="' + id + '"] .ptag')].find((x) => x.textContent.includes("💬"));
      const okTag = [...document.querySelectorAll('.pcard[data-post="' + id.replace(/a/g, "c") + '"] .ptag')].find((x) => x.textContent.includes("💬"));
      const out = { tag: tag ? tag.textContent : null, a: tag ? tag.dataset.a : null, okTag: okTag ? okTag.textContent : null };
      Finals.splice(-2, 2); [StudioFilter, StudioRubric, StudioFormat, StudioOrigin] = keep; renderStudio();
      return out;
    });
    const good = st.tag === "💬 ⚠" && st.a === "composer" && st.okTag === "💬 ✓";
    if (!good) console.log("   ↳ fcStudio:", JSON.stringify(st));
    return good;
  });

  await check("bestComposer", async () => {
    // ⏰ у композері: кнопка є, коли статистика щось радить; підставляє найближчі 19:30 для Threads
    await closeComposers();
    await page.evaluate((id) => { BestT = null; openComposer(id); }, P5);
    await page.waitForFunction(() => { const b = document.querySelector(".cmp-ov #cmpBest"); return b && b.style.display !== "none"; }, undefined, { timeout: 8000 });
    await page.evaluate(() => document.querySelector(".cmp-ov #cmpBest").click());
    if (process.env.SMOKE_SHOTS) await (await page.$(".cmp-ov .cmp-foot")).screenshot({ path: join(HERE, "best-composer.png") });
    const st = await page.evaluate(() => ({ t: document.querySelector("#cmpTime").value, d: document.querySelector("#cmpDate").value, msg: document.querySelector("#cmpMsg").textContent,
      today: locDate(Date.now()), tomorrow: locDate(Date.now() + 864e5) }));
    await closeComposers();
    const good = st.t === "19:30" && (st.d === st.today || st.d === st.tomorrow) && /Threads: найкращий час з твоєї статистики - 19:30/.test(st.msg);
    if (!good) console.log("   ↳ bestComposer:", JSON.stringify(st));
    return good;
  });

  await check("bestDistribute", async () => {
    // AI-розподіл каже, які мережі поставлено в найкращий час з власної статистики
    await page.evaluate(() => { selectView("publish"); setPTab("cal"); });
    await page.waitForSelector("#aiDistribute", { timeout: 8000 });
    await page.evaluate(() => document.querySelector("#aiDistribute").click());
    await page.waitForFunction(() => /розподілено: 3/.test((document.querySelector("#pubMsg") || {}).textContent || ""), undefined, { timeout: 8000 });
    const m = await page.evaluate(() => document.querySelector("#pubMsg").textContent);
    const good = /⏰ Threads о 19:30 - найкращий час з твоєї статистики/.test(m);
    if (!good) console.log("   ↳ bestDistribute:", m);
    return good;
  });

  await check("egPanel", async () => {
    // ♻️ панель у «План і ритм»: вимкнено → увімкнув (PUT), додав хіт, «повертати все одно», «♻️ Зараз»
    await closeComposers();
    await page.evaluate(() => { selectView("publish"); setPTab("plan"); });
    await page.waitForSelector("#ph_evergreenHost", { timeout: 8000 });
    await page.evaluate(() => document.querySelector("#ph_evergreenHost").click());
    await page.waitForSelector(".popov #egOn", { timeout: 8000 });
    const st0 = await page.evaluate(() => ({ on: document.querySelector("#egOn").checked, up: document.querySelectorAll('.popov .egRow[data-rep]').length,
      items: [...document.querySelectorAll('.popov .egRow[data-item]')].filter((r) => !r.closest("details")).map((r) => r.innerText), hits: document.querySelectorAll('.popov .egRow[data-hit]').length,
      off: /Не повторюються \(1\)/.test(document.querySelector(".popov").innerText) }));
    if (process.env.SMOKE_SHOTS) { await page.evaluate(() => { document.querySelector(".popov details").open = true; }); await page.waitForTimeout(400); await page.screenshot({ path: join(HERE, "evergreen-panel.png") }); }
    await page.evaluate(() => { const c = document.querySelector("#egOn"); c.checked = true; c.dispatchEvent(new Event("change")); });
    await page.waitForFunction(() => /збережено/.test((document.querySelector("#egMsg") || {}).textContent || ""), undefined, { timeout: 8000 });
    await page.evaluate(() => document.querySelector('.popov .egRow[data-hit="egH"] [data-eg="add"]').click());
    await page.waitForFunction(() => document.querySelector('.popov .egRow[data-item="egH"]'), undefined, { timeout: 8000 });
    await page.evaluate(() => document.querySelector('.popov .egRow[data-item="egB"] [data-eg="force"]').click());
    await page.waitForFunction(() => /знову в черзі/.test((document.querySelector("#egMsg") || {}).textContent || ""), undefined, { timeout: 8000 });
    await page.evaluate(() => document.querySelector('.popov .egRow[data-item="egH"] [data-eg="now"]').click());
    await page.waitForFunction(() => /повтор поставлено на/.test((document.querySelector("#egMsg") || {}).textContent || ""), undefined, { timeout: 8000 });
    const st1 = await page.evaluate(() => ({ up: document.querySelectorAll('.popov .egRow[data-rep]').length }));
    await page.evaluate(() => closePop());
    const good = st0.on === false && st0.up === 1 && st0.items.length === 1 && /×3\.2/.test(st0.items[0]) && /1\/3/.test(st0.items[0]) && st0.hits === 1 && st0.off
      && EG.settings.on === true && egCalls.some((c) => c.k === "POST" && c.id === "egH") && egCalls.some((c) => c.k === "force" && c.id === "egB")
      && egCalls.some((c) => c.k === "repeat" && c.id === "egH") && st1.up === 2;
    if (!good) console.log("   ↳ egPanel:", JSON.stringify({ st0, st1, calls: egCalls, on: EG.settings.on }));
    return good;
  });

  await check("egToday", async () => {
    // «Сьогодні»: повтор хіта видно за добу, ✕ скасовує (видаляє повтор-копію)
    await page.evaluate(() => { selectView("today"); });
    await page.waitForSelector("#tdEvergreen .tdEg", { timeout: 8000 });
    const txt = await page.evaluate(() => document.querySelector("#tdEvergreen").innerText);
    await page.evaluate(() => document.querySelector('#tdEvergreen .tdEg[data-act="cancel"]').click());
    for (let i = 0; i < 30 && !egCalls.some((c) => c.k === "cancel"); i++) await page.waitForTimeout(100);
    const good = /Повертаються хіти/.test(txt) && /Свіжий гачок/.test(txt) && egCalls.some((c) => c.k === "cancel" && c.id === "egR1");
    if (!good) console.log("   ↳ egToday:", JSON.stringify({ txt, calls: egCalls }));
    return good;
  });

  await check("egStudio", async () => {
    // Студія: повтор позначено «♻️ повтор»; опублікований оригінал через ⋯ - у чергу, і тег «♻️ у черзі»
    // фільтри Студії могли лишитись від попередніх перевірок (формат, рубрика) - скидаємо
    await page.evaluate(() => { selectView("create"); setCTab("posts"); StudioFilter = "all"; StudioRubric = ""; StudioFormat = ""; StudioOrigin = ""; renderStudio(); });
    await page.waitForSelector('.pcard[data-post="' + P2 + '"]', { timeout: 8000 });
    const p2 = await page.$$eval('.pcard[data-post="' + P2 + '"] .ptag', (a) => a.map((x) => x.textContent));
    // опубліковані живуть у вкладці «✈️ Опубліковані»
    await page.evaluate(() => { StudioFilter = "published"; renderStudio(); });
    await page.waitForSelector('.pcard[data-post="' + P3 + '"]', { timeout: 8000 });
    await page.evaluate((id) => document.querySelector('.pcard[data-post="' + id + '"] [data-a="menu"]').click(), P3);
    await page.waitForSelector(".cardmenu .cm-i", { timeout: 6000 });
    const item = await page.evaluate(() => [...document.querySelectorAll(".cardmenu .cm-i")].map((b) => b.innerText).find((t) => /Повертати цей пост/.test(t)) || "");
    await page.evaluate(() => [...document.querySelectorAll(".cardmenu .cm-i")].find((b) => /Повертати цей пост/.test(b.innerText)).click());
    await page.waitForFunction((id) => [...document.querySelectorAll('.pcard[data-post="' + id + '"] .ptag')].some((x) => /у черзі/.test(x.textContent)), P3, { timeout: 8000 });
    // той самий пункт тепер - «Прибрати з черги»; прибрали - тег зник
    await page.evaluate((id) => document.querySelector('.pcard[data-post="' + id + '"] [data-a="menu"]').click(), P3);
    await page.waitForSelector(".cardmenu .cm-i", { timeout: 6000 });
    const rmItem = await page.evaluate(() => [...document.querySelectorAll(".cardmenu .cm-i")].map((b) => b.innerText).find((t) => /Прибрати з вічнозеленої черги/.test(t)) || "");
    await page.evaluate(() => [...document.querySelectorAll(".cardmenu .cm-i")].find((b) => /Прибрати з вічнозеленої черги/.test(b.innerText)).click());
    await page.waitForFunction((id) => ![...document.querySelectorAll('.pcard[data-post="' + id + '"] .ptag')].some((x) => /у черзі/.test(x.textContent)), P3, { timeout: 8000 });
    // неопублікований пост (P2) - пункту нема
    await page.evaluate(() => { StudioFilter = "all"; renderStudio(); });
    await page.waitForSelector('.pcard[data-post="' + P2 + '"]', { timeout: 8000 });
    await page.evaluate((id) => document.querySelector('.pcard[data-post="' + id + '"] [data-a="menu"]').click(), P2);
    await page.waitForSelector(".cardmenu .cm-i", { timeout: 6000 });
    const p2menu = await page.evaluate(() => [...document.querySelectorAll(".cardmenu .cm-i")].map((b) => b.innerText).join("|"));
    await page.evaluate(() => document.querySelectorAll(".cardmenu,.cardmenu-bg").forEach((x) => x.remove()));
    const good = p2.some((t) => /♻️ повтор/.test(t)) && /вічнозелена черга/.test(item) && egCalls.some((c) => c.k === "POST" && c.id === P3)
      && rmItem && egCalls.some((c) => c.k === "DELETE" && c.id === P3) && !/♻️/.test(p2menu);
    if (!good) console.log("   ↳ egStudio:", JSON.stringify({ p2, item, rmItem, p2menu, calls: egCalls }));
    return good;
  });

  await check("egCalendar", async () => {
    // календар: слот повтору з ♻️
    await page.evaluate(() => { selectView("publish"); setPTab("cal"); });
    await page.waitForFunction(() => [...document.querySelectorAll(".pchip")].some((c) => /Свіжий гачок/.test(c.textContent)), undefined, { timeout: 8000 });
    const chips = await page.$$eval(".pchip", (a) => a.map((x) => x.textContent));
    const good = chips.some((t) => /♻️/.test(t) && /Свіжий гачок/.test(t)) && chips.some((t) => /підрядники/.test(t) && !/♻️/.test(t));
    if (!good) console.log("   ↳ egCalendar:", JSON.stringify(chips));
    return good;
  });

  await check("linksPanel", async () => {
    // 🔗 Інструменти → «Посилання і сторінка в біо»: переходи по мережах, топ без «порожніх» кнопок біо,
    // поля сторінки заповнені з сервера, «Відкрити» веде на /@адресу; вимкнути скорочення - PUT
    await closeComposers();
    await page.evaluate(() => selectView("tools"));
    await page.waitForFunction(() => /переходи/.test((document.querySelector("#lkStats") || {}).textContent || ""), undefined, { timeout: 8000 });
    const st = await page.evaluate(() => ({ stats: document.querySelector("#lkStats").innerText, rows: document.querySelectorAll("#lkStats .lkRow").length,
      auto: document.querySelector("#lkAuto").checked, utm: document.querySelector("#lkUtm").checked, slug: document.querySelector("#bioSlug").value,
      title: document.querySelector("#bioTitle").value, on: document.querySelector("#bioOn").checked, links: document.querySelectorAll("#bioLinks .bioRow").length,
      open: getComputedStyle(document.querySelector("#bioOpen")).display !== "none" ? document.querySelector("#bioOpen").getAttribute("href") : "" }));
    if (process.env.SMOKE_SHOTS) { const el = await page.$("#linksPanel"); await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await el.screenshot({ path: join(HERE, "links-panel.png") }); }
    await page.evaluate(() => { const c = document.querySelector("#lkAuto"); c.checked = false; c.dispatchEvent(new Event("change")); });
    for (let i = 0; i < 40 && !lkCalls.some((c) => c.k === "settings"); i++) await page.waitForTimeout(100);
    const good = /3 переходи за 30 днів/.test(st.stats) && /Threads 2/.test(st.stats) && /сторінка в біо 1/.test(st.stats) && /переглянули 5 разів/.test(st.stats)
      && st.rows === 2 && /Відкрили запис на осінь/.test(st.stats) && st.auto && st.utm && st.slug === "kemp.carlsbad" && st.title === "Kemp Carlsbad" && st.on && st.links === 2
      && /\/@kemp\.carlsbad$/.test(st.open) && lkCalls.some((c) => c.k === "settings" && c.body.auto === false && c.body.utm === true);
    if (!good) console.log("   ↳ linksPanel:", JSON.stringify({ st, calls: lkCalls }));
    return good;
  });

  await check("montageLib", async () => {
    // 🎬 медіатека: запис голосу - плиткою 🎙, у режимі вибору - «Змонтувати» з порядком вибору, вікно
    // з варіантами тексту; свій текст іде на сервер, готовий пост відкривається в композері
    await page.evaluate(() => { MediaSel = null; selectView("settings"); setSTab("sources"); return loadMedia(); });
    await page.waitForSelector('#mediaGrid [data-id="ma1"] .audtile', { timeout: 5000 });
    const tile = await page.$eval('#mediaGrid [data-id="ma1"] .audtile', (el) => el.textContent);
    await page.evaluate(() => { MediaSel = new Set(); return loadMedia(); });
    await page.waitForSelector("#mSelMont", { timeout: 5000 });
    const dis0 = await page.$eval("#mSelMont", (b) => b.disabled);
    // вибір: спершу фото, потім відео, потім голос (голос у монтаж кліпом не йде)
    for (const id of ["md2", "mv1", "ma1"]) { await page.click(`#mediaGrid [data-id="${id}"]`); await page.waitForTimeout(150); }
    const btn = await page.$eval("#mSelMont", (b) => ({ t: b.textContent, d: b.disabled }));
    const order = await page.$$eval("#mediaGrid [data-id] span", (sp) => sp.filter((x) => /^\d$/.test(x.textContent) && x.style.bottom).map((x) => x.closest("[data-id]").dataset.id + ":" + x.textContent));
    await page.click("#mSelMont");
    await page.waitForSelector("#mntSrc", { timeout: 5000 });
    const opts = await page.$$eval("#mntSrc option", (o) => o.map((x) => x.value + (x.disabled ? "!" : "")));
    await page.selectOption("#mntSrc", "own");
    const txtShown = await page.$eval("#mntText", (t) => t.style.display !== "none");
    await page.click("#mntGo");
    const emptyMsg = await page.$eval("#mntMsg", (m) => m.textContent);
    await page.fill("#mntText", "Fasáda hotová. Teď chodba.");
    await page.click('input[name="mntFmt"][value="reel"]');
    // ✨ переходи (типово плавні) і 🎵 музика: свій трек із медіатеки + 5 AI-настроїв; 🎯 найкращі моменти - увімкнено
    const trOpts = await page.$$eval("#mntTr option", (o) => o.map((x) => x.value));
    const muOpts = await page.$$eval("#mntMusic option", (o) => o.map((x) => x.value + (x.disabled ? "!" : "")));
    const smartOn = await page.$eval("#mntSmart", (c) => c.checked);
    await page.selectOption("#mntMusic", "m:calm");
    await page.click("#mntGo");
    await page.waitForFunction(() => !document.querySelector("#mntSrc") && !!document.querySelector(".cmp-ov"), undefined, { timeout: 10000 });
    const sent = mtCalls[mtCalls.length - 1] || {};
    await page.evaluate(() => { document.querySelector(".cmp-ov")?.remove(); MediaSel = null; });
    const good = tile.includes("🎙") && tile.includes("0:35") && dis0 === true && btn.t === "🎬 Змонтувати (2)" && !btn.d
      && order.sort().join(",") === "md2:1,mv1:2" && opts.length === 6 && opts.includes("audio") && txtShown && /Напиши текст/.test(emptyMsg)
      && sent.format === "reel" && sent.ownText === "Fasáda hotová. Teď chodba." && JSON.stringify(sent.clips) === JSON.stringify([{ id: "md2" }, { id: "mv1" }])
      && trOpts.join(",") === ",fade,slide,zoom,flash,mix,none" && muOpts[0] === "" && muOpts.includes("t:ma1") && muOpts.filter((x) => x.startsWith("m:") && !x.endsWith("!")).length === 5
      && smartOn && sent.transition === undefined && sent.smart === true && sent.musicMood === "calm" && !sent.music
      && sent.template === "standard" && sent.hook === true && sent.endCard === true && sent.subStyle === "classic" && sent.cutPauses === undefined;
    if (!good) console.log("   ↳ montageLib:", JSON.stringify({ tile, dis0, btn, order, opts, txtShown, emptyMsg, sent, trOpts, muOpts, smartOn }));
    return good;
  });

  await check("montageV3", async () => {
    // 🧩 шаблони в діалозі монтажу: «до / після» з розподілом кліпів, свій гачок, без фінальної картки,
    // субтитри на плашці, «лишити паузи» - і все це йде на сервер
    await page.evaluate(() => { MediaSel = new Set(); selectView("settings"); setSTab("sources"); return loadMedia(); });
    await page.waitForSelector("#mSelMont", { timeout: 5000 });
    for (const id of ["md2", "mv1"]) { await page.click(`#mediaGrid [data-id="${id}"]`); await page.waitForTimeout(150); }
    await page.click("#mSelMont");
    await page.waitForSelector(".mntTplBtn", { timeout: 5000 });
    const tpls = await page.$$eval(".mntTplBtn", (b) => b.map((x) => x.dataset.t + (x.classList.contains("on") ? "*" : "")));
    const endLbl = await page.$eval("#mntEnd", (c) => c.closest("label").textContent);
    await page.click('.mntTplBtn[data-t="before_after"]');
    const ba = await page.evaluate(() => ({ shown: document.querySelector("#mntBaRow").style.display !== "none", hint: document.querySelector("#mntBaHint").textContent }));
    await page.selectOption("#mntHook", "own");
    const hookShown = await page.$eval("#mntHookText", (i) => i.style.display !== "none");
    if (process.env.SMOKE_SHOTS) {
      await page.screenshot({ path: join(HERE, "montage-v3.png") });
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
      await page.screenshot({ path: join(HERE, "montage-v3-mobile.png") });
      await page.setViewportSize({ width: 1400, height: 950 }); await page.waitForTimeout(200);
    }
    await page.click("#mntGo");
    const needHook = await page.$eval("#mntMsg", (m) => m.textContent);
    await page.fill("#mntHookText", "Ріжемо бетон за день");
    await page.selectOption("#mntSub", "box");
    await page.click("#mntEnd");
    await page.selectOption("#mntSrc", "auto");
    const cutShown = await page.$eval("#mntCutRow", (r) => r.style.display !== "none");
    await page.click("#mntCut");
    await page.click('.mntTplBtn[data-t="talking"]');
    const talkSrc = await page.$eval("#mntSrc", (s) => s.value);
    await page.click('.mntTplBtn[data-t="before_after"]');
    await page.click("#mntGo");
    await page.waitForFunction(() => !document.querySelector("#mntSrc"), undefined, { timeout: 10000 });
    const sent = mtCalls[mtCalls.length - 1] || {};
    // після монтажу композер відкривається асинхронно (пост ще вантажиться) - дочекатись і лише тоді прибрати,
    // інакше він зʼявлявся вже після прибирання й перекривав наступні перевірки
    await page.waitForSelector(".cmp-ov", { timeout: 6000 }).catch(() => {});
    await page.evaluate(() => { document.querySelectorAll(".cmp-ov").forEach((o) => o.remove()); MediaSel = null; });
    const good = tpls.join(",") === "standard*,before_after,talking,process" && /Vary Servis & Úklid · Karlovy Vary · @servisvary/.test(endLbl)
      && ba.shown && ba.hint === "ДО: 1 · ПІСЛЯ: 2" && hookShown && /свій гачок/.test(needHook) && cutShown && talkSrc === "auto"
      && sent.template === "before_after" && sent.beforeCount === 1 && sent.hook === "Ріжемо бетон за день" && sent.endCard === false
      && sent.subStyle === "box" && sent.cutPauses === false && sent.voice === "clips";
    if (!good) console.log("   ↳ montageV3:", JSON.stringify({ tpls, endLbl, ba, hookShown, needHook, cutShown, talkSrc, sent }));
    return good;
  });

  await check("videoStyle", async () => {
    // 🎨 Бренд → Візуал → «🎬 Стиль відео»: значення з сервера, прев'ю міняється одразу, збереження автоматичне
    await page.evaluate(() => { selectView("brand"); setBTab("visual"); });
    await page.waitForFunction(() => document.querySelector("#mvSub") && document.querySelector("#mvSub").options.length === 5, undefined, { timeout: 5000 });
    const init = await page.evaluate(() => ({ sub: $("mvSub").value, hook: $("mvHook").checked, end: $("mvEndHint").textContent, hk: getComputedStyle($("mvPrevHook")).display }));
    const n0 = styleCalls.length;
    await page.selectOption("#mvSub", "box");
    await page.fill("#mvColorHex", "#ff2f78");
    await page.click("#mvHook");
    for (let i = 0; i < 40 && styleCalls.length <= n0; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({ cls: $("mvPrevSub").className, hk: getComputedStyle($("mvPrevHook")).display, word: $("mvPrevSub").querySelector("b").style.color }));
    if (process.env.SMOKE_SHOTS) {
      await page.$eval("#mvPanel", (el) => el.scrollIntoView({ block: "start" })); await page.waitForTimeout(200);
      const el = await page.$("#mvPanel");
      await el.screenshot({ path: join(HERE, "video-style-light.png") });
      const th = await page.evaluate(() => document.body.getAttribute("data-theme"));
      await page.evaluate(() => setTheme("dark")); await page.waitForTimeout(200);
      await el.screenshot({ path: join(HERE, "video-style-dark.png") });
      await page.evaluate((x) => setTheme(x || "light"), th);
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
      await page.$eval("#mvPanel", (el) => el.scrollIntoView({ block: "start" }));
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      if (sw > 391) console.log("   ↳ videoStyle: горизонтальний скрол на телефоні", sw);
      await page.screenshot({ path: join(HERE, "video-style-mobile.png") });
      await page.setViewportSize({ width: 1400, height: 950 }); await page.waitForTimeout(200);
    }
    const last = styleCalls[styleCalls.length - 1] || {};
    const good = init.sub === "classic" && init.hook && /Vary Servis & Úklid · Karlovy Vary · @servisvary/.test(init.end) && init.hk !== "none"
      && /box/.test(after.cls) && after.hk === "none" && /255, 47, 120|ff2f78/i.test(after.word)
      && last.subtitle === "box" && last.hook === false && /ff2f78/i.test(last.color);
    if (!good) console.log("   ↳ videoStyle:", JSON.stringify({ init, after, last, calls: styleCalls.length - n0 }));
    return good;
  });

  await check("coverPicker", async () => {
    // 🖼 обкладинка Reels у композері відео-поста: поточна (кадр із гачком з монтажу), свій кадр повзунком, прибрати
    await closeComposers();
    await page.waitForTimeout(150);
    await page.evaluate((id) => openComposer(id), P5);
    await page.waitForSelector(".cmp-ov #cmpCover", { timeout: 6000 });
    const th0 = await page.$eval("#cmpCover .cmpCoverTh img", (i) => i.getAttribute("src")).catch(() => "");
    await page.click("#cmpCovFrame");
    if (process.env.SMOKE_SHOTS) { await page.$eval("#cmpCover", (el) => el.scrollIntoView({ block: "center" })); await page.waitForTimeout(300); await page.screenshot({ path: join(HERE, "cover-picker.png") }); }
    await page.$eval("#cmpCovAt", (r) => { r.value = "2.5"; r.dispatchEvent(new Event("input")); });
    const tl = await $t("#cmpCovT");
    await page.click("#cmpCovOk");
    await page.waitForFunction(() => /cov\d+\.jpg/.test(document.querySelector("#cmpCover .cmpCoverTh img")?.getAttribute("src") || "") && !/cov0/.test(document.querySelector("#cmpCover .cmpCoverTh img").getAttribute("src")), undefined, { timeout: 4000 }).catch(() => {});
    const th1 = await page.$eval("#cmpCover .cmpCoverTh img", (i) => i.getAttribute("src")).catch(() => "");
    const c1 = coverCalls[coverCalls.length - 1] || {};
    await page.click("#cmpCovClear");
    await page.waitForFunction(() => !document.querySelector("#cmpCover .cmpCoverTh img"), undefined, { timeout: 4000 }).catch(() => {});
    const th2 = await $t("#cmpCover .cmpCoverTh");
    const c2 = coverCalls[coverCalls.length - 1] || {};
    await closeComposers();
    const good = th0 === "/thumb/cov0.jpg" && tl === "2,5 с" && c1.pid === P5 && c1.at === 2.5 && /\/thumb\/cov\d+\.jpg/.test(th1) && th1 !== th0
      && c2.clear === true && /вибере/.test(th2 || "");
    if (!good) console.log("   ↳ coverPicker:", JSON.stringify({ th0, tl, c1, th1, c2, th2 }));
    return good;
  });

  await check("linksBio", async () => {
    // сторінка в біо: ＋ кнопка, ✕ прибрати, збереження несе все по порядку; крива адреса - людська відмова;
    // ручне скорочення показує коротке посилання
    await page.evaluate(() => document.querySelector("#bioAdd").click());
    await page.waitForFunction(() => document.querySelectorAll("#bioLinks .bioRow").length === 3, undefined, { timeout: 6000 });
    await page.evaluate(() => { const r = document.querySelectorAll("#bioLinks .bioRow")[2];
      const set = (sel, v) => { const i = r.querySelector(sel); i.value = v; i.dispatchEvent(new Event("input")); };
      set(".bioE", "💶"); set(".bioT", "Прайс"); set(".bioU", "https://rozum.one/price");
      document.querySelectorAll("#bioLinks .bioRow")[1].querySelector(".bioX").click(); });
    await page.waitForFunction(() => document.querySelectorAll("#bioLinks .bioRow").length === 2, undefined, { timeout: 6000 });
    await page.evaluate(() => { document.querySelector("#bioSlug").value = "bad slug"; document.querySelector("#bioSave").click(); });
    await page.waitForFunction(() => /⚠/.test((document.querySelector("#bioMsg") || {}).textContent || ""), undefined, { timeout: 6000 });
    const err = await page.evaluate(() => document.querySelector("#bioMsg").textContent);
    await page.evaluate(() => { document.querySelector("#bioSlug").value = "Kemp.Glamp"; document.querySelector("#bioSave").click(); });
    await page.waitForFunction(() => /✓ збережено/.test((document.querySelector("#bioMsg") || {}).textContent || ""), undefined, { timeout: 6000 });
    const okMsg = await page.evaluate(() => document.querySelector("#bioMsg").textContent);
    const saved = lkCalls.filter((c) => c.k === "bio").pop()?.body || {};
    await page.evaluate(() => { document.querySelector("#lkUrl").value = "https://rozum.one/audit"; document.querySelector("#lkShorten").click(); });
    await page.waitForFunction(() => /Man5678/.test((document.querySelector("#lkShortOut") || {}).textContent || ""), undefined, { timeout: 6000 });
    const good = /латинських/.test(err) && /kemp\.glamp/.test(okMsg) && saved.enabled === true && saved.showPosts === true
      && JSON.stringify((saved.links || []).map((l) => [l.emoji, l.title, l.url])) === JSON.stringify([["🏕", "Забронювати", "https://rozum.one/glamp"], ["💶", "Прайс", "https://rozum.one/price"]])
      && lkCalls.some((c) => c.k === "shorten" && c.body.url === "https://rozum.one/audit");
    if (!good) console.log("   ↳ linksBio:", JSON.stringify({ err, okMsg, saved, calls: lkCalls.map((c) => c.k) }));
    return good;
  });

  await check("reviewCaptions", async () => {
    // 🎬 /app?review=en: англійська смуга вгорі міняє текст за екраном, відсуває композер (а не
    // перекриває його кнопки) і вимикається ✕
    await closeComposers();
    const st = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      localStorage.setItem("kg_review_en", "1"); startReviewCaptions();
      selectView("analytics"); await wait(800);
      const an = document.getElementById("reviewTxt").textContent;
      selectView("settings"); setSTab("channels"); await wait(800);
      const ch = document.getElementById("reviewTxt").textContent;
      const barH = document.getElementById("reviewBar").offsetHeight;
      window.scrollTo(0, 0);
      const owl = document.getElementById("owl");
      return { an, ch, barH, cls: document.documentElement.classList.contains("review-on"), lang: document.getElementById("reviewBar").lang,
        owlHidden: !owl || getComputedStyle(owl).display === "none" };
    });
    if (process.env.SMOKE_SHOTS) await page.screenshot({ path: join(HERE, "review-channels.png") });
    await page.evaluate((id) => openComposer(id), P8);
    await page.waitForSelector(".cmp-ov #cmpFc", { timeout: 6000 });
    await page.waitForTimeout(800);
    if (process.env.SMOKE_SHOTS) await page.screenshot({ path: join(HERE, "review-composer.png") });
    const cmp = await page.evaluate(() => ({ txt: document.getElementById("reviewTxt").textContent,
      top: document.querySelector(".cmp-ov").getBoundingClientRect().top, barH: document.getElementById("reviewBar").offsetHeight,
      backVisible: (() => { const b = document.querySelector("#cmpBack").getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!e && !!e.closest("#cmpBack"); })() }));
    await closeComposers();
    // вікно коментарів - свій підпис із дозволами читання й відповіді
    await page.evaluate(() => openComments());
    await page.waitForSelector(".cmModal", { timeout: 8000 });
    await page.waitForTimeout(800);
    const cmTxt = await page.evaluate(() => document.getElementById("reviewTxt").textContent);
    await page.evaluate(() => document.querySelectorAll(".modal").forEach((m) => { if (m.querySelector(".cmModal")) m.remove(); }));
    const off = await page.evaluate(() => { document.getElementById("reviewOff").click();
      return { gone: !document.getElementById("reviewBar"), cls: document.documentElement.classList.contains("review-on"), ls: localStorage.getItem("kg_review_en") }; });
    const good = /instagram_manage_insights/.test(st.an) && /pages_show_list/.test(st.ch) && st.cls && st.lang === "en" && st.barH > 20 && st.owlHidden
      && /^Post editor/.test(cmp.txt) && Math.abs(cmp.top - cmp.barH) <= 1 && cmp.backVisible
      && /^Comments inbox/.test(cmTxt) && /pages_read_user_content/.test(cmTxt) && /pages_manage_engagement/.test(cmTxt)
      && off.gone && !off.cls && off.ls === null;
    if (!good) console.log("   ↳ reviewCaptions:", JSON.stringify({ st, cmp, cmTxt, off }));
    return good;
  });

  // 🗑 Видалення бренду. Раніше в «Небезпечній зоні» була лише «Видалити акаунт», і її натиснули,
  // щоб прибрати бренд: акаунт пішов на видалення, людину вилогінило. Тепер зона знає, де ти стоїш.
  // Стоїть ОСТАННЬОЮ: успішне видалення перезавантажує сторінку, а стан сюїти спільний.
  await check("brandDelete", async () => {
    const H = "11111111-1111-1111-1111-111111111111", B = "33333333-3333-3333-3333-333333333333";
    await page.evaluate(() => { selectView("settings"); setSTab("profile"); return loadWorkspaces(); });
    const atHome = await page.evaluate(() => ({ box: document.getElementById("wsDelBox").style.display,
      btn: document.getElementById("accDelete").textContent }));
    // стаємо в бренд, яким володіємо (не домашній)
    API["GET /workspaces"] = { items: [{ id: H, title: "Бренд А", role: "owner" }, { id: B, title: "Тест бренд", role: "owner" },
      { id: "22222222-2222-2222-2222-222222222222", title: "Бренд Б", role: "member" }], active: B, home: H };
    await page.evaluate(() => loadWorkspaces());
    const inBrand = await page.evaluate(() => ({ box: document.getElementById("wsDelBox").style.display,
      name: document.getElementById("wsDelName").textContent, btn: document.getElementById("accDelete").textContent,
      hint: document.getElementById("accDelHint").textContent }));
    // чужа назва - відмова, бренд на місці
    const wrong = await page.evaluate(async () => {
      const out = []; window.alert = (m) => out.push(String(m)); window.prompt = () => "інша назва";
      document.getElementById("wsDelBtn").click();
      await new Promise((r) => setTimeout(r, 500)); return out;
    });
    const stillThere = API["GET /workspaces"].items.some((w) => w.id === B);
    // правильна назва (регістр і пробіли не важать) - бренд стерто, сторінка вертається в домашній
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }),
      page.evaluate(() => { window.prompt = () => "  тест   БРЕНД "; document.getElementById("wsDelBtn").click(); }),
    ]);
    await page.waitForFunction(() => {
      const e = document.getElementById("userEmail"), box = document.getElementById("wsDelBox");
      return e && e.textContent.includes("@") && box && typeof WsHome === "string" && WsHome.length > 0;
    }, undefined, { timeout: 20000 });
    const after = await page.evaluate(() => document.getElementById("wsDelBox").style.display);
    const ok = atHome.box === "none" && atHome.btn === "Видалити акаунт"
      && inBrand.box !== "none" && inBrand.name === "«Тест бренд»" && inBrand.btn === "Видалити акаунт і всі бренди"
      && inBrand.hint.includes("«Тест бренд»") && wrong.length === 1 && wrong[0].includes("введи назву бренду")
      && stillThere && brandDeleted.length === 1 && brandDeleted[0] === B && after === "none";
    if (!ok) console.log("   ↳ brandDelete:", JSON.stringify({ atHome, inBrand, wrong, stillThere, brandDeleted, after }));
    return ok;
  });

  // ---------------------------------------------------------- 13. 🏠 лендинг (/)
  // Шлях матеріалу в hero справді програється; вкладки мереж перемикаються й чесно кажуть «за запрошенням»;
  // на телефоні нема бічного скролу, меню відкривається; «менше руху» - одразу фінальний кадр без анімації.
  const land = async (vp, extra = {}) => {
    const ctx = await browser.newContext({ viewport: vp, ...extra });
    const lp = await ctx.newPage();
    lp.on("pageerror", (e) => pageErrors.push("landing pageerror: " + e.message));
    await lp.route("**/*", (route) => { const u = route.request().url(); return u.includes("127.0.0.1:" + PORT) ? route.continue() : route.abort(); });
    await lp.goto(`http://127.0.0.1:${PORT}/landing`, { waitUntil: "domcontentloaded" });
    return { ctx, lp };
  };
  await check("landingHero", async () => {
    const { ctx, lp } = await land({ width: 1440, height: 900 });
    // до «Опубліковано» шлях іде ~10 с; за ним стежимо по класах, а не таймером
    await lp.waitForFunction(() => document.getElementById("hv").classList.contains("done"), undefined, { timeout: 16000 });
    const r = await lp.evaluate(() => ({
      h1: document.getElementById("h1").textContent,
      rows: [...document.querySelectorAll("#hv .hv-row")].map((x) => getComputedStyle(x).opacity),
      state: document.getElementById("hvState").textContent,
      published: getComputedStyle(document.querySelector("#hv .r5 .t2")).display,
      cta: document.querySelector(".hero .btn-p").getAttribute("href"),
    }));
    await ctx.close();
    const ok = r.h1.includes("Holos знаходить його") && r.rows.every((o) => o === "1") && r.state === "Опубліковано" && r.published !== "none" && r.cta === "/register";
    if (!ok) console.log("   ↳ landingHero:", JSON.stringify(r));
    return ok;
  });
  await check("landingTabs", async () => {
    const { ctx, lp } = await land({ width: 1440, height: 900 });
    // до кліку - лише Telegram (без JS видно всі п'ять, з JS - вкладки)
    const init = await lp.evaluate(() => [...document.querySelectorAll(".tpanel")].filter((p) => !p.hidden).map((p) => p.id).join());
    await lp.click("#t-ig");
    const r = await lp.evaluate(() => ({
      shown: [...document.querySelectorAll(".tpanel")].filter((p) => !p.hidden).map((p) => p.id),
      sel: document.querySelector("#t-ig").getAttribute("aria-selected"),
      badge: document.querySelector("#p-ig .st").textContent + "|" + document.querySelector("#p-ig .st").className,
      tg: document.querySelector("#p-tg .st").textContent,
      cnt: document.querySelector("#p-ig .cnt").textContent,
      note: document.querySelector(".netnote").textContent,
    }));
    await ctx.close();
    const ok = init === "p-tg" && r.shown.join() === "p-ig" && r.sel === "true" && r.badge === "за запрошенням|st st-invite" && r.tg === "працює"
      && /^\d+ з 2200 знаків$/.test(r.cnt) && r.note.includes("перевіряють наш застосунок");
    if (!ok) console.log("   ↳ landingTabs:", JSON.stringify({ init, ...r }));
    return ok;
  });
  await check("landingMobile", async () => {
    const { ctx, lp } = await land({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
    await lp.waitForTimeout(400);
    const before = await lp.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const out = [...document.querySelectorAll("h1, h2, h3, p, .btn, .card, .tpanel, .hv-panel, .cmp, .price")]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > w + 1 || r.left < -1); })
        .map((el) => el.tagName + "." + String(el.className).split(" ")[0]);
      return { out, nav: getComputedStyle(document.getElementById("nav")).display };
    });
    await lp.click("#menu");
    const open = await lp.evaluate(() => ({ nav: getComputedStyle(document.getElementById("nav")).display, exp: document.getElementById("menu").getAttribute("aria-expanded") }));
    await lp.click('#nav a[href="#faq"]');
    await lp.waitForTimeout(300);
    const closed = await lp.evaluate(() => getComputedStyle(document.getElementById("nav")).display);
    await ctx.close();
    const ok = before.out.length === 0 && before.nav === "none" && open.nav === "flex" && open.exp === "true" && closed === "none";
    if (!ok) console.log("   ↳ landingMobile:", JSON.stringify({ before, open, closed }));
    return ok;
  });
  await check("landingReducedMotion", async () => {
    const { ctx, lp } = await land({ width: 1440, height: 900 }, { reducedMotion: "reduce" });
    await lp.waitForTimeout(600);
    const r = await lp.evaluate(() => ({ anim: document.getElementById("hv").classList.contains("anim"), rows: [...document.querySelectorAll("#hv .hv-row")].map((x) => getComputedStyle(x).opacity), rv: [...document.querySelectorAll(".rv")].filter((e) => getComputedStyle(e).opacity !== "1").length }));
    await ctx.close();
    const ok = !r.anim && r.rows.every((o) => o === "1") && r.rv === 0;
    if (!ok) console.log("   ↳ landingReducedMotion:", JSON.stringify(r));
    return ok;
  });

  // 🔗 «Від тієї ж команди»: блок EvidujZdarma видно (зʼявляється при прокрутці), посилання чисті (без rel/target),
  // бейдж - нормальна ціль для пальця; на телефоні нічого не вилазить за край, підвал теж
  await check("landingSister", async () => {
    const one = async (vp, extra) => {
      const { ctx, lp } = await land(vp, extra);
      await lp.evaluate(() => document.getElementById("team").scrollIntoView({ block: "center" }));
      await lp.waitForFunction(() => document.querySelector("#team .sis-in").classList.contains("in"), undefined, { timeout: 6000 });
      await lp.waitForTimeout(700);
      const r = await lp.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const box = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), h: Math.round(b.height) }; };
        const links = [...document.querySelectorAll('a[href^="https://evidujzdarma.cz"]')];
        const badge = document.querySelector("#team .sis-badge");
        const out = [...document.querySelectorAll("#team h2, #team p, #team .sis-badge, footer .copy span")].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > w + 1 || b.left < -1); }).map((el) => el.tagName + "." + el.className);
        return {
          n: links.length, dirty: links.filter((a) => a.rel || a.target || /utm_/.test(a.href)).length,
          first: links[0].textContent, inMain: !!links[0].closest("main"),
          op: getComputedStyle(document.querySelector("#team .sis-in")).opacity, badge: box(badge), badgeText: badge.textContent,
          linkColor: getComputedStyle(document.querySelector("#team p a")).color, out,
          foot: document.querySelector("footer .copy").textContent,
        };
      });
      await ctx.close();
      return r;
    };
    const d = await one({ width: 1440, height: 900 });
    const m = await one({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
    const good = (r) => r.n >= 4 && r.dirty === 0 && r.first === "безкоштовну касу для EET 2.0" && r.inMain && r.op === "1"
      && r.badge.h >= 44 && r.badgeText === "EET 2.0 безкоштовно - EvidujZdarma" && r.linkColor === "rgb(178, 12, 80)" && r.out.length === 0
      && r.foot.includes("Також від нас: EvidujZdarma - безкоштовна каса для EET 2.0");
    const ok = good(d) && good(m);
    if (!ok) console.log("   ↳ landingSister:", JSON.stringify({ d, m }));
    return ok;
  });

  // ✍️ «Новий пост»: порожня чернетка одразу в редакторі, мережі НЕ ввімкнені самі (інакше тестове відео
  // поїхало б у всі підключені), а порожня й закрита - прибирається; з текстом - лишається
  await check("newPost", async () => {
    await closeComposers(); await page.waitForTimeout(150);
    await page.evaluate(() => { selectView("create"); setCTab("posts"); });
    await page.waitForSelector("#newPost", { state: "visible", timeout: 6000 });
    const label = await $t("#newPost");
    await page.evaluate(() => document.querySelector("#newPost").click());
    await page.waitForSelector(".cmp-ov #cmpChips .netchip", { timeout: 6000 });
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => ({ on: document.querySelectorAll(".cmp-ov #cmpChips .netchip.on").length, prev: document.querySelector("#cmpPrev").textContent, txt: document.querySelector("#cmpText").value }));
    const d0 = blankDeletes.length;
    await page.evaluate(() => document.querySelector(".cmp-ov #cmpBack").click());
    await page.waitForTimeout(300);
    const delEmpty = blankDeletes.length - d0;
    // з текстом - не прибирається
    await page.evaluate(() => document.querySelector("#newPost").click());
    await page.waitForSelector(".cmp-ov #cmpText", { timeout: 6000 });
    await page.evaluate(() => { const t = document.querySelector(".cmp-ov #cmpText"); t.value = "Мій власний текст"; t.dispatchEvent(new Event("input")); });
    await page.evaluate(() => document.querySelector(".cmp-ov #cmpBack").click());
    await page.waitForTimeout(300);
    const delTyped = blankDeletes.length - d0 - delEmpty;
    const ok = /Новий пост/.test(label) && st.on === 0 && /Обери канал/.test(st.prev) && st.txt === "" && delEmpty === 1 && delTyped === 0 && !(await has(".cmp-ov"));
    if (!ok) console.log("   ↳ newPost:", JSON.stringify({ label, st, delEmpty, delTyped }));
    return ok;
  });

  // ⏳ TikTok обробляє відео: композер сам перечитує стан, і посилання на пост зʼявляється без перевідкриття
  await check("ttProcessing", async () => {
    await closeComposers(); await page.waitForTimeout(150);
    p11Polls = 0;
    await page.evaluate((id) => openComposer(id), P11);
    await page.waitForSelector(".cmp-ov #cmpPrev", { timeout: 6000 });
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => document.querySelector("#cmpPrev").textContent);
    await page.waitForFunction(() => /Відкрити пост/.test((document.querySelector("#cmpPrev") || {}).textContent || ""), undefined, { timeout: 15000 }).catch(() => {});
    const after = await page.evaluate(() => ({ t: document.querySelector("#cmpPrev").textContent, href: (document.querySelector("#cmpPrev a.pv-open") || {}).href || "" }));
    await closeComposers();
    const ok = /TikTok ще обробляє відео/.test(before) && /Відкрити пост/.test(after.t) && /tiktok\.com\/@holos_rozum\/video\//.test(after.href) && !/ще обробляє/.test(after.t);
    if (!ok) console.log("   ↳ ttProcessing:", JSON.stringify({ before: before.slice(0, 300), after }));
    return ok;
  });

  // 🌐 англійський інтерфейс для запису відео TikTok (/app?review=tiktok): меню, Канали, Чорновики, редактор і
  // блок TikTok - англійською, словами самого TikTok (рецензент шукає саме їх); текст поста людини - як є.
  // SMOKE_I18N_DUMP=1 - показати, що на шляху запису лишилось українською.
  await check("enTikTok", async () => {
    const saved = { st: API["GET /channels/status"], tt: API["GET /integrations/tiktok"] };
    API["GET /channels/status"] = { ...saved.st, youtube: true, tiktok: true, video: { youtube: { name: "Holos Channel" }, tiktok: { name: "Holos", username: "holos_rozum", direct: true } } };
    API["GET /integrations/tiktok"] = { configured: true, hasToken: true, name: "Holos", username: "holos_rozum", avatar: "", direct: true, sandbox: true, admin: true };
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const ep = await ctx.newPage();
    ep.on("pageerror", (e) => pageErrors.push("en pageerror: " + e.message));
    if (process.env.SMOKE_I18N_DUMP) ep.on("console", (m) => { if (m.type() === "error") console.log("   ↳ en console:", m.text()); });
    await ep.route("**/*", (route) => { const u = route.request().url(); return u.includes("127.0.0.1:" + PORT) ? route.continue() : route.abort(); });
    await ep.addInitScript(() => { try { window.confirm = () => true; window.alert = () => {}; } catch (e) {} });
    const cyr = (sel) => ep.evaluate((sel) => {
      const SKIP = ".phone-txt,.phone-b .phone-user,.notr,textarea,[contenteditable]";
      const rx = /[А-ЩЬЮЯЄІЇҐа-щьюяєіїґ]/, out = new Set();
      for (const root of sel ? [...document.querySelectorAll(sel)] : [document.body]) {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); let n;
        while ((n = w.nextNode())) {
          if (n.nodeType === 3) { const p = n.parentElement; if (!p || p.closest(SKIP)) continue; if (!p.offsetParent && getComputedStyle(p).position !== "fixed") continue; const v = n.nodeValue.trim(); if (v && rx.test(v)) out.add(v); }
          else if (n.offsetParent || getComputedStyle(n).position === "fixed") for (const a of ["title", "placeholder"]) { const v = n.getAttribute(a); if (v && rx.test(v)) out.add("[" + a + "] " + v); }
        }
      }
      return [...out];
    }, sel);
    const dump = {};
    try {
      await ep.goto(`http://127.0.0.1:${PORT}/app?review=tiktok#/settings/channels`, { waitUntil: "domcontentloaded" });
      await ep.waitForFunction(() => { const e = document.getElementById("userEmail"); return e && e.textContent.includes("@"); }, undefined, { timeout: 20000 });
      await ep.waitForFunction(() => /Connected as/.test((document.getElementById("ttStatus") || {}).textContent || ""), undefined, { timeout: 8000 });
      await ep.waitForTimeout(700);
      const ch = await ep.evaluate(() => ({
        lang: document.documentElement.lang, title: document.title,
        nav: [...document.querySelectorAll(".topnav .navitem .lbl")].map((x) => x.textContent),
        tt: document.getElementById("ttStatus").closest(".panel").innerText,
        focus: document.getElementById("ttStatus").closest(".panel").classList.contains("rv-focus"),
        conn: document.getElementById("ttConnect").textContent,
        bar: (document.getElementById("reviewTxt") || {}).textContent || "",
      }));
      dump.channels = await cyr("");
      const ttCyr = await cyr("#ttStatus");
      const navCyr = await cyr(".topnav");
      if (process.env.SMOKE_SHOTS) await ep.screenshot({ path: join(HERE, "en-channels.png") });
      // Чорновики: кнопка «Новий пост»
      await ep.evaluate(() => { location.hash = "#/create/posts"; });
      await ep.waitForSelector("#newPost", { state: "visible", timeout: 8000 });
      await ep.waitForTimeout(500);
      const np = await ep.$eval("#newPost", (b) => b.textContent);
      dump.drafts = await cyr("");
      // редактор: відео-пост, TikTok одразу, «Хто бачить», реклама
      await ep.evaluate((id) => openComposer(id), P10);
      await ep.waitForSelector(".cmp-ov #cmpVidNets", { timeout: 6000 });
      await ep.evaluate(() => document.querySelector("#cmpVidNets").click());
      await ep.waitForSelector('.cmp-ov #cmpTtBox [name=ttMode][value=direct]', { timeout: 6000 });
      await ep.evaluate(() => { const r = document.querySelector('#cmpTtBox [name=ttMode][value=direct]'); r.checked = true; r.dispatchEvent(new Event("change")); });
      await ep.waitForSelector(".cmp-ov #cmpTtBox #ttPriv", { timeout: 6000 });
      await ep.waitForTimeout(700);
      const blocked = await ep.evaluate(async () => { document.querySelector("#cmpNow").click(); await new Promise((r) => setTimeout(r, 250)); return document.querySelector("#cmpMsg").textContent; });
      await ep.evaluate(() => { const s = document.querySelector("#ttPriv"); s.value = "SELF_ONLY"; s.dispatchEvent(new Event("change")); });
      await ep.waitForTimeout(100);
      await ep.evaluate(() => { const d = document.querySelector("#ttDisc"); d.checked = true; d.dispatchEvent(new Event("change")); });
      await ep.waitForTimeout(150);
      const tt1 = await ep.evaluate(() => ({ box: document.querySelector("#cmpTtBox").innerText.replace(/\s+/g, " "), brDis: document.querySelector("#ttBr").disabled,
        opts: [...document.querySelectorAll("#ttPriv option")].map((o) => o.textContent) }));
      await ep.evaluate(() => { const o = document.querySelector("#ttOwn"); o.checked = true; o.dispatchEvent(new Event("change")); });
      await ep.waitForTimeout(150);
      const tt2 = await ep.evaluate(() => ({ box: document.querySelector("#cmpTtBox").innerText.replace(/\s+/g, " "), prev: document.querySelector("#cmpPrev").innerText.replace(/\s+/g, " "),
        foot: document.querySelector(".cmp-foot").innerText, bar: (document.getElementById("reviewTxt") || {}).textContent || "" }));
      dump.composer = await cyr(".cmp-ov");
      const boxCyr = await cyr("#cmpTtBox");
      if (process.env.SMOKE_SHOTS) { await ep.evaluate(() => document.querySelector("#cmpTtBox").scrollIntoView({ block: "center" })); await ep.screenshot({ path: join(HERE, "en-composer.png") }); }
      if (process.env.SMOKE_I18N_DUMP) console.log("   ↳ enTikTok лишилось українською:", JSON.stringify(dump, null, 1));
      const conds = {
        lang: ch.lang === "en" && /Holos/.test(ch.title), nav: ch.nav.join("|") === "Today|Create|Publish|Brand & strategy|Analytics" && navCyr.length === 0,
        ttCard: /Connected as/.test(ch.tt) && /@holos_rozum/.test(ch.tt) && /Sandbox/.test(ch.tt) && ttCyr.length === 0 && ch.focus && /Reconnect TikTok/.test(ch.conn),
        barLogin: /Login Kit/.test(ch.bar), newPost: /New post/.test(np), blocked: /choose who can view this video/.test(blocked),
        who: /Posting to TikTok as Holos @holos_rozum/.test(tt1.box), priv: /Who can view this video/.test(tt1.box) && tt1.opts[0] === "Select" && tt1.opts.includes("Only me"),
        allow: /Allow users to:/.test(tt1.box) && /Disclose video content/.test(tt1.box),
        brSelf: tt1.brDis && /Branded content visibility cannot be set to private/.test(tt1.box),
        need: /You need to indicate if your content promotes yourself, a third party, or both/.test(tt1.box),
        label: /Your video will be labeled as “Promotional content”/.test(tt2.box), muc: /By posting, you agree to TikTok’s Music Usage Confirmation/.test(tt2.box),
        processing: /it may take a few minutes for TikTok to process the video/.test(tt2.box), boxEn: boxCyr.length === 0,
        prev: /Who can view: Only me/.test(tt2.prev), foot: /Publish now/.test(tt2.foot), bar: /creator_info/.test(tt2.bar),
      };
      const bad = Object.keys(conds).filter((k) => !conds[k]);
      const ok = bad.length === 0;
      if (!ok) console.log("   ↳ enTikTok:", bad.join(", "), JSON.stringify({ ch, ttCyr, navCyr, np, blocked, tt1, tt2, boxCyr }));
      return ok;
    } finally {
      API["GET /channels/status"] = saved.st; API["GET /integrations/tiktok"] = saved.tt;
      await ctx.close();
    }
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
