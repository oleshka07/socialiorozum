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
  { key: "strategy_brief", content: "Бриф: підрядники для власників житла." },
];

const API = {
  "GET /auth/me": { email: "smoke@rozum.one" },
  "GET /settings": SETTINGS,
  "GET /channels/status": { telegram: true, threads: true, instagram: false, facebook: false, linkedin: false },
  "GET /tasks": {
    score: 45,
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
  "GET /guide/next": {
    tips: [{ id: "connect", text: "Підключи канал - інакше постам нікуди їхати.", target: "#genPostsBtn", emote: "happy", action: { label: "Показати", view: "settings", tab: "channels" } }],
  },
  "GET /prompts": [],
  "GET /published": [],
  "GET /usage": { prompt_tokens: 1000, completion_tokens: 500, cost: 0.02, calls: 3 },
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
  "GET /account": { email: "smoke@rozum.one", created_at: iso(-30, 8), pro: false },
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

// Пости: /full і /publish-state обслуговуються окремо (шлях із id).
function handleApi(method, path) {
  const key = method + " " + path.split("?")[0];
  if (key in API) return API[key];
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
  if (method === "POST" || method === "PUT" || method === "DELETE") return { ok: true };
  return {};
}

// 1×1 прозорий PNG - щоб /thumb і /media не сипали 404 у консоль
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+H3xvzwAAAABJRU5ErkJggg==", "base64");

const server = createServer((req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/api/")) {
    const body = handleApi(req.method, url.slice(4));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body === undefined ? {} : body));
    return;
  }
  if (url.startsWith("/thumb/") || url.startsWith("/media/")) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
    return;
  }
  const file = url === "/app" || url === "/" ? "app.html" : url.split("?")[0].replace(/^\//, "");
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
  }, { timeout: 20000 });

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
    await page.waitForFunction(() => { const e = document.getElementById("tdComm"); return e && e.textContent === "4"; }, { timeout: 8000 });
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
    await page.waitForTimeout(250);
    return (await vis("#layIdeas")) && (await $t("#ideaBankFeed")).includes("підрядника");
  });

  await check("studioClean", async () => {
    await page.evaluate(() => setCTab("posts"));
    await page.waitForTimeout(200);
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
    await page.waitForTimeout(150);
    const links = await page.$$eval('.pcard[data-post="' + P3 + '"] a.cdot', (a) => a.map((x) => x.getAttribute("href")));
    const ok = links.length === 1 && links[0] === TG_LINK;
    await page.evaluate(() => { StudioFilter = "all"; renderStudio(); }); // не лишаємо фільтр наступним перевіркам
    await page.waitForTimeout(150);
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

  await check("painsPanel", async () =>
    (await has("#brandThesis")) && (await has("#painPoints")) && (await has("#painsSuggest")) && (await vis("#painPoints")));

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

  await check("abPanel", async () => {
    // матеріали й каталог моделей мусять доїхати в селекти, а результат - показатись СЛІПО
    await page.waitForFunction(() => { const s = document.getElementById("abSource"); return s && s.options.length >= 2; }, { timeout: 6000 });
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
    await page.waitForFunction(() => document.querySelectorAll("#abOut .post, #abOut [style*='--danger']").length > 0, { timeout: 8000 });
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

  await check("obNoIg", async () => {
    await page.evaluate(() => showOnboarding());
    await page.waitForSelector("#obNoIg", { timeout: 6000 });
    const ok = (await $t("#obNoIg")).includes("без Instagram");
    await page.evaluate(() => { document.getElementById("onboarding").style.display = "none"; });
    return ok;
  });

  // ---------------------------------------------------------- 8. 🦉 сова
  await check("owlGuide", async () => {
    await page.evaluate(() => { Guide.on = true; owlInit(); return loadGuide(); });
    await page.waitForFunction(() => { const b = document.getElementById("owlBubble"); return b && b.style.display === "block"; }, { timeout: 6000 });
    return (await $t("#owlText")).includes("Підключи канал") && (await has("#owlDo"));
  });

  await check("owlHome", async () => {
    // ✕ на бульбашці ЛИШЕ ховає підказку й вертає сову в гніздо (помічник не вимикається)
    await page.click("#owlBubbleX");
    // політ у гніздо триває ~620мс, і саме в його колбеку ставиться atHome - чекаємо на факт, не на таймер
    await page.waitForFunction(() => document.getElementById("owl").dataset.atHome === "1", { timeout: 5000 });
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
