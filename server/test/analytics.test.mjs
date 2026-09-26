// Аналітика 2.0: збір метрик із відступом і чиста арифметика екрана «Аналітика».
// Тут найлегше збрехати тихо: записати «невідомо» нулем (так Facebook показував 0 переглядів
// після того, як Meta вимкнула post_impressions), назвати висновком шум із двох постів, змішати
// мережі різного масштабу або порахувати день тижня за UTC замість часу кабінету.
import { test } from "node:test";
import assert from "node:assert/strict";
import { narrowMetrics, isMetricRequestError, fetchMetrics } from "../dist/metrics.js";
import {
  buildAnalytics, interactionsOf, plural, localParts, daypartOf, hookGroup, lengthGroup, originGroup, driverInsight, median,
  fmtMult, snapAgeH, MATURE_H,
} from "../dist/analytics.js";

// ---------- збір метрик ----------
test("narrowMetrics: Instagram називає зайву метрику - прибираємо саме її", () => {
  const r = narrowMetrics(["views", "reach", "likes", "comments"],
    "(#100) The Media Insights API does not support the views metric for this media product type.");
  assert.deepEqual(r, ["reach", "likes", "comments"]);
});

test("narrowMetrics: Threads називає ДОЗВОЛЕНІ - лишаємо лише їх", () => {
  const req = ["views", "likes", "replies", "reposts", "quotes", "shares"];
  assert.deepEqual(narrowMetrics(req, "Param metric[5] must be one of {views, likes, replies, reposts, quotes} but the value is 'shares'"),
    ["views", "likes", "replies", "reposts", "quotes"]);
  assert.deepEqual(narrowMetrics(req, "(#100) metric[5] must be one of the following values: views, likes, replies, reposts, quotes"),
    ["views", "likes", "replies", "reposts", "quotes"]);
});

test("narrowMetrics: Facebook не називає нічого - null (пробуємо наступний набір)", () => {
  assert.equal(narrowMetrics(["post_media_view", "post_total_media_view_unique"], "(#100) The value must be a valid insights metric"), null);
  // дві наші метрики в тексті - не вгадуємо, яку прибрати
  assert.equal(narrowMetrics(["views", "reach"], "views and reach are not available"), null);
  // одна метрика - прибирати нічого, лишився б порожній запит
  assert.equal(narrowMetrics(["views"], "does not support the views metric"), null);
});

test("isMetricRequestError: доступ, токен і ліміт - не про метрики", () => {
  assert.equal(isMetricRequestError("(#100) The value must be a valid insights metric"), true);
  assert.equal(isMetricRequestError("The Media Insights API does not support the views metric"), true);
  assert.equal(isMetricRequestError("Meta не дає на це дозволу ((#10) Application does not have permission) - перепідключи"), false);
  assert.equal(isMetricRequestError("Доступ до Facebook/Instagram втрачено (Meta більше не приймає токен)"), false);
  assert.equal(isMetricRequestError("Meta просить зачекати (забагато запитів)"), false);
  assert.equal(isMetricRequestError("Application does not have permission for this action"), false);
});

test("fetchMetrics: непідтримана метрика відкидається, робочий набір памʼятається", async () => {
  const calls = [];
  const fn = async (m) => {
    calls.push(m.join(","));
    if (m.includes("views")) throw new Error("(#100) does not support the views metric for this media product type");
    return Object.fromEntries(m.map((x) => [x, 7]));
  };
  const sets = [["views", "reach", "likes"], ["reach"]];
  const v = await fetchMetrics(sets, fn, "t:ig-feed");
  assert.deepEqual(v, { reach: 7, likes: 7 });
  assert.deepEqual(calls, ["views,reach,likes", "reach,likes"]);
  calls.length = 0;
  await fetchMetrics(sets, fn, "t:ig-feed");
  assert.deepEqual(calls, ["reach,likes"], "другий пост іде одразу робочим набором, без зайвого запиту");
});

test("fetchMetrics: порожня відповідь (метрику вимкнули мовчки) веде до наступного набору", async () => {
  const fn = async (m) => (m[0] === "post_media_view" ? {} : { post_impressions: 40 });
  const v = await fetchMetrics([["post_media_view"], ["post_impressions"]], fn);
  assert.deepEqual(v, { post_impressions: 40 });
  const none = await fetchMetrics([["a"], ["b"]], async () => ({}));
  assert.deepEqual(none, {}, "нічого не віддали, але й не відмовили - порожньо, а не виняток");
});

test("fetchMetrics: відмова доступу кидається одразу, без перебору наборів", async () => {
  let n = 0;
  const fn = async () => { n++; throw new Error("Meta не дає на це дозволу (permission) - перепідключи"); };
  await assert.rejects(fetchMetrics([["a", "b"], ["c"]], fn), /дозволу/);
  assert.equal(n, 1);
});

// ---------- дрібні правила ----------
test("interactionsOf: «невідомо» - null, а не 0", () => {
  assert.equal(interactionsOf({ likes: null, replies: null, reposts: null, quotes: null, shares: null, saves: null }), null);
  assert.equal(interactionsOf({ likes: 0, replies: null, reposts: null, quotes: null, shares: null, saves: null }), 0);
  assert.equal(interactionsOf({ likes: 5, replies: 2, reposts: 1, quotes: 0, shares: 3, saves: 4 }), 15);
});

test("plural: українські числівники", () => {
  const w = (n) => `${n} ${plural(n, "пост", "пости", "постів")}`;
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(w),
    ["1 пост", "2 пости", "4 пости", "5 постів", "11 постів", "12 постів", "14 постів", "21 пост", "22 пости", "25 постів", "101 пост", "111 постів"]);
});

test("localParts: день і година - за поясом кабінету, не за UTC", () => {
  // 21:30 UTC у середу 29.07 ще вівторок у UTC, але вже середа 00:30 у Києві
  const p = localParts("2026-07-28T21:30:00Z", "Europe/Kyiv");
  assert.deepEqual(p, { ymd: "2026-07-29", wd: 2, hour: 0 });
  assert.equal(localParts("2026-07-28T21:30:00Z", "UTC").wd, 1);
});

test("daypartOf: межі частин доби", () => {
  assert.deepEqual([5, 6, 10, 11, 15, 16, 20, 21, 23, 0].map(daypartOf), [3, 0, 0, 1, 1, 2, 2, 3, 3, 3]);
});

test("hookGroup / lengthGroup / originGroup", () => {
  assert.equal(hookGroup("Чому ви досі платите за рекламу?\nБо…").key, "question");
  assert.equal(hookGroup("Знаєте, чому? Бо ніхто не рахує.").key, "question");
  assert.equal(hookGroup("5 помилок власника глемпінгу").key, "number");
  assert.equal(hookGroup("Я помилився в найпростішому.").key, "statement");
  assert.equal(hookGroup("").key, "statement");
  assert.equal(lengthGroup(279).key, "short");
  assert.equal(lengthGroup(280).key, "medium");
  assert.equal(lengthGroup(801).key, "long");
  assert.equal(originGroup("diary").key, "own");
  assert.equal(originGroup("mcp").key, "mcp");
  assert.equal(originGroup("rss").key, "feeds");
  assert.equal(originGroup("topic").key, "generated");
  assert.equal(originGroup(null).key, "other");
});

test("driverInsight: групи до 3 постів і різниця менша за 30% - не висновок", () => {
  const g = (key, n, m) => ({ key, label: key, n, median: m, thin: n < 3 });
  assert.equal(driverInsight({ key: "media", title: "x", hint: "", groups: [g("a", 2, 3), g("b", 10, 1)] }), null);
  assert.equal(driverInsight({ key: "media", title: "x", hint: "", groups: [g("a", 5, 1.25), g("b", 10, 1)] }), null);
  const ok = driverInsight({ key: "media", title: "x", hint: "", groups: [g("a", 5, 2), g("b", 10, 1)] });
  assert.ok(ok && ok.ratio === 2);
  assert.match(ok.insight.text, /«a» - ×2\.0 від твоєї норми \(5 постів\), найслабше «b» - ×1\.0 \(10 постів\)/);
});

// ---------- повна збірка ----------
const NOW = Date.parse("2026-09-26T12:00:00Z");
const day = 864e5;
let seq = 0;
function row(over) {
  seq++;
  return {
    post_id: over.post_id || `p${seq}`, net: "threads", created_at: new Date(NOW - (over.ago ?? 1) * day).toISOString(), permalink: null,
    text: "Звичайний пост про роботу.", format: "post", rubric: null, intent: null, origin: "topic", media_kind: "text",
    views: null, reach: null, likes: null, replies: null, reposts: null, quotes: null, shares: null, saves: null, m_error: null, fetched_at: null,
    ...over,
  };
}

test("buildAnalytics: норма, множники, розріз «що в пості», висновок і чесне покриття", () => {
  seq = 0;
  const rows = [];
  // Threads: 6 текстових по ~1000 і 4 каруселі по ~2000 переглядів
  for (let i = 0; i < 6; i++) rows.push(row({ ago: 2 + i * 3, views: 900 + i * 40, likes: 10, replies: 2, media_kind: "text" }));
  for (let i = 0; i < 4; i++) rows.push(row({ ago: 3 + i * 5, views: 2000 + i * 50, likes: 30, replies: 5, media_kind: "carousel" }));
  // Facebook: реакції є, переглядів Meta не дала - «невідомо», а не нуль
  for (let i = 0; i < 3; i++) rows.push(row({ net: "facebook", ago: 4 + i, likes: 3, replies: 1, shares: 0, views: null, m_error: "перегляди недоступні: (#10) permission" }));
  // Telegram: публікації без статистики постів
  rows.push(row({ net: "telegram", ago: 1 }), row({ net: "telegram", ago: 6 }));
  // попередній період: 3 Threads-пости
  for (let i = 0; i < 3; i++) rows.push(row({ ago: 40 + i, views: 500, likes: 5 }));
  // поза обома періодами - не має впливати ні на що
  rows.push(row({ ago: 200, views: 99999 }));

  const a = buildAnalytics(rows, [], { days: 30, net: "all", tz: "Europe/Kyiv", now: NOW });
  assert.equal(a.kpi.posts, 15);
  assert.deepEqual(a.kpi.sendsByNet, { threads: 10, facebook: 3, telegram: 2 });
  assert.equal(a.kpi.measured, 10, "перегляди є лише в 10 Threads-постів");
  assert.equal(a.kpi.postsPrev, 3);
  assert.equal(a.kpi.viewsPrev, 1500);
  assert.ok(!a.norms.facebook, "без переглядів у Facebook норми нема - і множників теж");
  const threadViews = rows.filter((r) => r.net === "threads" && r.views != null && Date.parse(r.created_at) > NOW - 30 * day).map((r) => r.views);
  assert.equal(a.norms.threads.median, median(threadViews));
  assert.equal(a.kpi.views, threadViews.reduce((x, y) => x + y, 0));

  const media = a.drivers.find((d) => d.key === "media");
  const car = media.groups.find((g) => g.key === "carousel"), txt = media.groups.find((g) => g.key === "text");
  assert.equal(car.n, 4); assert.equal(txt.n, 6);
  // норма = медіана всіх 10 = (1060+1100)/2 = 1080; каруселі 2075/1080, текст 1000/1080
  assert.equal(car.median, 1.92); assert.equal(txt.median, 0.93);
  assert.ok(a.insights.some((x) => x.key === "media" && /найкраще «Карусель»/.test(x.text) && /найслабше «Лише текст»/.test(x.text)), JSON.stringify(a.insights));

  assert.equal(a.coverage.facebook.measured, 0);
  assert.equal(a.coverage.facebook.partial, 3);
  assert.match(a.coverage.facebook.error, /перегляди недоступні/);
  assert.equal(a.coverage.telegram.perPost, false);

  // тижневий ряд: лише мережі зі статистикою, сума = усі перегляди періоду
  assert.deepEqual(a.series.nets, ["threads"]);
  assert.equal(a.series.unit, "week");
  const sum = a.series.buckets.reduce((s, b) => s + (b.views.threads || 0), 0);
  assert.equal(sum, a.kpi.views);
  assert.ok(a.series.buckets.length >= 5 && a.series.buckets.length <= 6, `${a.series.buckets.length} тижнів`);

  // таблиця постів: Facebook без переглядів несе причину, ER рахується лише де є перегляди
  const fbRow = a.posts.find((p) => p.net === "facebook");
  assert.equal(fbRow.views, null); assert.equal(fbRow.er, null); assert.match(fbRow.error, /перегляди недоступні/);
  const thRow = a.posts.find((p) => p.net === "threads");
  assert.ok(thRow.er > 0 && thRow.mult > 0);
  assert.equal(a.posts.length, 15);
});

test("buildAnalytics: мало даних - чесне «замало для висновків», а не висновок із шуму", () => {
  seq = 0;
  const rows = [row({ views: 100 }), row({ views: 300, media_kind: "photo" }), row({ views: 200 })];
  const a = buildAnalytics(rows, [], { days: 30, net: "all", tz: "Europe/Kyiv", now: NOW });
  assert.equal(a.insights.length, 1);
  assert.equal(a.insights[0].key, "few");
  assert.match(a.insights[0].text, /Зараз таких 3\./);
});

test("buildAnalytics: фільтр мережі і підписники", () => {
  seq = 0;
  const rows = [row({ views: 10 }), row({ net: "instagram", views: 50, likes: 5, saves: 2 })];
  const f = [
    { network: "threads", day: "2026-08-20", followers: 900 },   // до періоду - база для дельти
    { network: "threads", day: "2026-09-10", followers: 950 },
    { network: "threads", day: "2026-09-26", followers: 1000 },
    { network: "instagram", day: "2026-09-26", followers: 5000 }, // один знімок - стан, не зміна
  ];
  const a = buildAnalytics(rows, f, { days: 30, net: "threads", tz: "Europe/Kyiv", now: NOW });
  assert.equal(a.posts.length, 1);
  assert.equal(a.posts[0].net, "threads");
  assert.deepEqual(Object.keys(a.followers), ["threads"]);
  assert.equal(a.followers.threads.now, 1000);
  assert.equal(a.followers.threads.delta, 100);
  assert.equal(a.followers.threads.points.length, 2);
  const all = buildAnalytics(rows, f, { days: 30, net: "all", tz: "Europe/Kyiv", now: NOW });
  assert.equal(all.followers.instagram.now, 5000);
  assert.equal(all.followers.instagram.delta, null);
});

test("buildAnalytics: теплова карта і день тижня за часом кабінету", () => {
  seq = 0;
  // неділя 20.09 23:30 за Києвом = 20:30 UTC; у UTC теж неділя, але в Нью-Йорку ще неділя 16:30 - вечір
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push(row({ created_at: "2026-09-20T20:30:00Z", views: 100 + i }));
  for (let i = 0; i < 3; i++) rows.push(row({ created_at: "2026-09-22T06:00:00Z", views: 300 + i }));
  const kyiv = buildAnalytics(rows, [], { days: 30, net: "all", tz: "Europe/Kyiv", now: NOW });
  const sunNight = kyiv.heat.cells.find((c) => c.r === 6 && c.c === 3);
  assert.ok(sunNight && sunNight.n === 3, JSON.stringify(kyiv.heat.cells));
  const tueMorning = kyiv.heat.cells.find((c) => c.r === 1 && c.c === 0);
  assert.ok(tueMorning && tueMorning.n === 3 && tueMorning.median > 1);
  const ny = buildAnalytics(rows, [], { days: 30, net: "all", tz: "America/New_York", now: NOW });
  assert.ok(ny.heat.cells.find((c) => c.r === 6 && c.c === 2), "у Нью-Йорку той самий пост - неділя вечір");
});

test("buildAnalytics: рік групується помісячно", () => {
  seq = 0;
  const rows = [row({ ago: 10, views: 10 }), row({ ago: 100, views: 20 }), row({ ago: 300, views: 30 })];
  const a = buildAnalytics(rows, [], { days: 365, net: "all", tz: "Europe/Kyiv", now: NOW });
  assert.equal(a.series.unit, "month");
  assert.ok(a.series.buckets.length === 13 || a.series.buckets.length === 12, `${a.series.buckets.length} місяців`);
  assert.equal(a.series.buckets.reduce((s, b) => s + (b.views.threads || 0), 0), 60);
  assert.match(a.series.buckets[a.series.buckets.length - 1].label, /^вер 26$/);
});

// ---------- свіжі пости: цифри є, але з нормою ще рано ----------
// Знайдено на живій беті: пост, знятий через 18 хв після публікації, мав «👁 0 · ×0.0» і був
// «найгіршим» постом тижня, хоча його просто ще ніхто не встиг побачити.
const H = 36e5;
test("fmtMult: малий множник не округлюється до нуля", () => {
  assert.equal(fmtMult(0.04), "×0.04");
  assert.equal(fmtMult(0), "×0.0");
  assert.equal(fmtMult(0.1), "×0.1");
  assert.equal(fmtMult(1.24), "×1.2");
  assert.equal(fmtMult(6.08), "×6.1");
});

test("snapAgeH: вік знімка - від measured_at, інакше fetched_at, інакше невідомо", () => {
  const created_at = "2026-09-20T10:00:00Z";
  assert.equal(snapAgeH({ created_at, fetched_at: null, measured_at: null }), null);
  assert.equal(snapAgeH({ created_at, fetched_at: "2026-09-20T13:00:00Z" }), 3);
  // збій оновлює fetched_at, але цифри в рядку - з раннього знімка: рахуємо від measured_at
  assert.equal(snapAgeH({ created_at, fetched_at: "2026-09-25T10:00:00Z", measured_at: "2026-09-20T10:18:00Z" }), 0.3);
});

test("buildAnalytics: свіжий пост не тягне норму вниз і не стає «найгіршим»", () => {
  seq = 0;
  const rows = [];
  // 6 дозрілих Threads-постів, зняті через 3 доби після публікації
  for (let i = 0; i < 6; i++) {
    const created = NOW - (5 + i * 3) * day;
    rows.push(row({ created_at: new Date(created).toISOString(), views: 400 + i * 20, likes: 4,
      measured_at: new Date(created + 72 * H).toISOString(), fetched_at: new Date(created + 72 * H).toISOString() }));
  }
  // щойно опублікований: знятий через 18 хв - 0 переглядів
  const fresh = NOW - 3 * H;
  rows.push(row({ post_id: "fresh", created_at: new Date(fresh).toISOString(), views: 0, likes: 0,
    measured_at: new Date(fresh + 0.3 * H).toISOString(), fetched_at: new Date(fresh + 0.3 * H).toISOString() }));
  // старий пост, у якого вдалий знімок був лише ранній, а потім спроби падали (fetched_at свіжий)
  const old = NOW - 10 * day;
  rows.push(row({ post_id: "early", created_at: new Date(old).toISOString(), views: 3, likes: 0,
    measured_at: new Date(old + 0.5 * H).toISOString(), fetched_at: new Date(NOW - H).toISOString(), m_error: "тимчасово недоступно" }));

  const a = buildAnalytics(rows, [], { days: 30, net: "all", tz: "Europe/Kyiv", now: NOW });
  assert.equal(a.norms.threads.n, 6, "у норму йдуть лише дозрілі цифри");
  assert.equal(a.norms.threads.median, median([400, 420, 440, 460, 480, 500]));
  const f = a.posts.find((p) => p.post_id === "fresh"), e = a.posts.find((p) => p.post_id === "early");
  assert.equal(f.young, true); assert.equal(f.mult, null); assert.equal(f.snap_h, 0.3);
  assert.equal(f.views, 0, "цифри свіжого поста видно - просто без порівняння");
  assert.equal(e.young, true, "ранній знімок лишається раннім, хоч спроба була щойно");
  assert.equal(e.mult, null);
  assert.ok(a.posts.filter((p) => !["fresh", "early"].includes(p.post_id)).every((p) => p.young === false && p.mult > 0));
  // ні теплова карта, ні розрізи їх не бачать
  const heatN = a.heat.cells.reduce((s, c) => s + c.n, 0);
  assert.equal(heatN, 6);
  const wd = a.drivers.find((d) => d.key === "weekday");
  assert.equal(wd.groups.reduce((s, g) => s + g.n, 0), 6);
  // а перегляди в сумі періоду - рахуються (це правда: стільки вже побачили)
  assert.equal(a.kpi.measured, 8);
  assert.equal(a.kpi.views, 400 + 420 + 440 + 460 + 480 + 500 + 0 + 3);
  // рівно на межі - уже дозрілий
  const edge = NOW - 5 * day;
  const b = buildAnalytics([...rows, row({ post_id: "edge", created_at: new Date(edge).toISOString(), views: 450,
    measured_at: new Date(edge + MATURE_H * H).toISOString() })], [], { days: 30, net: "all", tz: "Europe/Kyiv", now: NOW });
  assert.equal(b.posts.find((p) => p.post_id === "edge").young, false);
  assert.equal(b.norms.threads.n, 7);
});

test("buildAnalytics: «замало даних» чесно каже про свіжі пости і мережі без норми", () => {
  seq = 0;
  const rows = [row({ views: 100 }), row({ views: 300 }), row({ views: 200 })];
  const fresh = NOW - 2 * H;
  for (let i = 0; i < 2; i++) rows.push(row({ created_at: new Date(fresh).toISOString(), views: 5, measured_at: new Date(fresh + H).toISOString() }));
  rows.push(row({ net: "instagram", views: 50 }), row({ net: "instagram", views: 70 }));
  const a = buildAnalytics(rows, [], { days: 30, net: "all", tz: "Europe/Kyiv", now: NOW });
  assert.equal(a.insights[0].key, "few");
  assert.match(a.insights[0].text, /Зараз таких 3; ще 2 свіжі пости набирають перегляди; ще 2 пости - у мережі, де поки менше 3 постів/);
});
