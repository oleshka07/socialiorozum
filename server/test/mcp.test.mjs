// 🔌 MCP: протокол і розбір аргументів.
// Тут найлегше зробити тиху помилку, яку не видно ні в tsc, ні очима: пропустити гард формату
// токена (і тоді порожнє значення зматчиться з чужим ключем settings_block), прийняти «14:30» як
// дату, віддати SSE клієнту, який чекає JSON, або зламати схему інструмента - Claude тоді просто
// не побачить половини кабінету, і ніхто не зрозуміє чому.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  negotiateVersion, isMcpToken, wantsSse, sseEncode, pickNets, idPattern, parseIsoAt,
  toolSpecs, handleRpc, handleBody, MCP_LATEST, TOOLS,
} from "../dist/mcp.js";

// Контекст виклику: хто, у якому кабінеті. initialize/ping/tools/list до БД не ходять, тож
// підробленого контексту достатньо - саме ці гілки тут і перевіряються.
const CTX = { token: "a".repeat(64), userId: "u1", wsId: "00000000-0000-0000-0000-000000000000", wsTitle: "Бренд", wsCount: 1 };
const HEX64 = "a".repeat(64);

test("negotiateVersion: відому версію повертаємо ТУ САМУ, невідому - свою найновішу", () => {
  assert.equal(negotiateVersion("2025-03-26"), "2025-03-26");
  assert.equal(negotiateVersion("2024-11-05"), "2024-11-05");
  assert.equal(negotiateVersion("2099-01-01"), MCP_LATEST);
  assert.equal(negotiateVersion(undefined), MCP_LATEST);
  assert.equal(negotiateVersion(42), MCP_LATEST);
});

test("isMcpToken: гард формату (порожнє/коротке/не-hex не проходить)", () => {
  assert.equal(isMcpToken(HEX64), true);
  assert.equal(isMcpToken(""), false);
  assert.equal(isMcpToken("a".repeat(63)), false);
  assert.equal(isMcpToken("A".repeat(64)), false);        // лише нижній регістр - інакше два різні рядки на один токен
  assert.equal(isMcpToken("z".repeat(64)), false);
  assert.equal(isMcpToken(null), false);
  assert.equal(isMcpToken(undefined), false);
});

test("wantsSse: JSON має пріоритет, SSE - лише коли JSON не приймають", () => {
  assert.equal(wantsSse("application/json, text/event-stream"), false);
  assert.equal(wantsSse("*/*"), false);
  assert.equal(wantsSse("text/event-stream, */*"), false);
  assert.equal(wantsSse("text/event-stream"), true);
  assert.equal(wantsSse(""), false);
  assert.equal(wantsSse(undefined), false);
});

test("sseEncode: подія у форматі SSE з порожнім рядком у кінці", () => {
  const out = sseEncode({ ok: 1 });
  assert.equal(out, 'event: message\ndata: {"ok":1}\n\n');
});

test("pickNets: масив, рядок через кому, сміття геть, без дублів", () => {
  assert.deepEqual(pickNets(["telegram", "threads"]), ["telegram", "threads"]);
  assert.deepEqual(pickNets("telegram, threads"), ["telegram", "threads"]);
  assert.deepEqual(pickNets("Telegram"), ["telegram"]);
  assert.deepEqual(pickNets(["telegram", "telegram"]), ["telegram"]);
  assert.deepEqual(pickNets(["twitter", "x"]), []);
  assert.deepEqual(pickNets(undefined), []);
});

test("idPattern: приймає короткий id і повний uuid, відсікає нечисловий сміттєвий ввід", () => {
  assert.equal(idPattern("#a1b2c3d4"), "a1b2c3d4");
  assert.equal(idPattern("A1B2C3D4"), "a1b2c3d4");
  assert.equal(idPattern("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  assert.equal(idPattern("abc"), null);          // закоротко - зматчило б половину кабінету
  assert.equal(idPattern("пост"), null);         // саме це раніше валило б запит до uuid-колонки
  assert.equal(idPattern(""), null);
  assert.equal(idPattern(undefined), null);
});

test("parseIsoAt: гола дата читається в поясі кабінету, явний Z - як UTC", () => {
  assert.equal(parseIsoAt("2026-09-14 09:00", "Europe/Kyiv").toISOString(), "2026-09-14T06:00:00.000Z");
  assert.equal(parseIsoAt("2026-01-15T09:00", "Europe/Kyiv").toISOString(), "2026-01-15T07:00:00.000Z"); // зима = UTC+2
  assert.equal(parseIsoAt("2026-09-14T09:00:00Z", "Europe/Kyiv").toISOString(), "2026-09-14T09:00:00.000Z");
  assert.equal(parseIsoAt("завтра 09:00", "Europe/Kyiv"), null);  // це не ISO - далі розбирає парсер бота
  assert.equal(parseIsoAt("хтозна коли", "Europe/Kyiv"), null);
});

test("toolSpecs: схема кожного інструмента валідна (required є в properties, імена унікальні)", () => {
  const specs = toolSpecs();
  assert.equal(specs.length, TOOLS.length);
  const seen = new Set();
  for (const t of specs) {
    assert.match(t.name, /^[a-z][a-z0-9_]{2,40}$/, `ім'я ${t.name}`);
    assert.equal(seen.has(t.name), false, `дубль імені ${t.name}`);
    seen.add(t.name);
    assert.ok(t.description.length > 20, `опис ${t.name} закороткий`);
    assert.equal(t.inputSchema.type, "object");
    for (const req of t.inputSchema.required || [])
      assert.ok(t.inputSchema.properties[req], `${t.name}: required «${req}» відсутній у properties`);
    for (const [k, v] of Object.entries(t.inputSchema.properties))
      assert.ok(v && typeof v.type === "string", `${t.name}.${k} без типу`);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean");
  }
});

test("toolSpecs: у кожного інструмента є вибір кабінету, крім самих кабінетних", () => {
  // Без цього аргументу разова дія в іншому бренді неможлива, а з ним у list/switch_workspace -
  // безглузда рекурсія («перемкни кабінет у кабінеті»).
  const specs = toolSpecs();
  const meta = ["list_workspaces", "switch_workspace"];
  for (const t of specs) {
    const has = Object.prototype.hasOwnProperty.call(t.inputSchema.properties, "workspace");
    if (meta.includes(t.name)) continue;
    assert.equal(has, true, `${t.name} без аргументу workspace`);
  }
  const sw = specs.find((t) => t.name === "switch_workspace");
  assert.deepEqual(sw.inputSchema.required, ["workspace"]);
  assert.equal(specs.find((t) => t.name === "list_workspaces").annotations.readOnlyHint, true);
});

test("toolSpecs: інструменти лише читають або лише пишуть - readOnly не бреше", () => {
  const byName = Object.fromEntries(toolSpecs().map((t) => [t.name, t]));
  for (const n of ["workspace_info", "brand_voice", "list_drafts", "get_post", "analytics"])
    assert.equal(byName[n].annotations.readOnlyHint, true, `${n} має бути readOnly`);
  for (const n of ["create_draft", "publish_post", "schedule_post", "update_post"])
    assert.equal(byName[n].annotations.readOnlyHint, false, `${n} не readOnly`);
});

test("handleRpc initialize: віддаємо капабіліті, версію й інструкцію", async () => {
  const r = await handleRpc(CTX, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, "2025-03-26");
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, "socialio");
  assert.match(r.result.instructions, /create_draft/);
});

test("handleRpc tools/list: список непорожній і з коректним конвертом JSON-RPC", async () => {
  const r = await handleRpc(CTX, { jsonrpc: "2.0", id: "x", method: "tools/list" });
  assert.equal(r.jsonrpc, "2.0");
  assert.equal(r.id, "x");
  assert.ok(r.result.tools.length >= 10);
});

test("handleRpc: ping, нотифікації без відповіді, невідомий метод = -32601", async () => {
  assert.deepEqual((await handleRpc(CTX, { jsonrpc: "2.0", id: 2, method: "ping" })).result, {});
  assert.equal(await handleRpc(CTX, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const r = await handleRpc(CTX, { jsonrpc: "2.0", id: 3, method: "space/invaders" });
  assert.equal(r.error.code, -32601);
});

test("handleRpc: биті повідомлення - Invalid Request, а не падіння", async () => {
  assert.equal((await handleRpc(CTX, null)).error.code, -32600);
  assert.equal((await handleRpc(CTX, { method: "ping" })).error.code, -32600);        // без jsonrpc
  assert.equal((await handleRpc(CTX, { jsonrpc: "2.0", id: 1 })).error.code, -32600); // без method
});

test("handleBody: батч повертає масив, самі нотифікації - нічого (HTTP 202)", async () => {
  const many = await handleBody(CTX, [
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  assert.equal(many.length, 2);
  assert.deepEqual(many.map((m) => m.id), [1, 2]);
  assert.equal(await handleBody(CTX, [{ jsonrpc: "2.0", method: "notifications/cancelled" }]), null);
});

// ---- authoredChannels: текст, який написав Claude, публікується дослівно ----
// Без позначки publishPostToChannels бачить мережу «без своєї версії» і переписує текст моделлю
// кабінету перед відправкою - платно й з брифом, якого автор міг не підтверджувати. Тихо: жодної
// помилки, просто в Threads виходить не той текст, який людина затвердила.
import { authoredChannels } from "../dist/mcp.js";

test("authoredChannels: одна мережа від автора - дослівно (та сама позначка, що в Lite)", () => {
  assert.deepEqual(authoredChannels({}, ["threads"], true), { threads: { on: true }, manual_adapt: true, native: "threads" });
});

test("authoredChannels: кілька мереж - майстер-текст, авто-упаковка лишається", () => {
  const c = authoredChannels({}, ["threads", "facebook"], true);
  assert.equal(c.manual_adapt, undefined);
  assert.equal(c.native, undefined);
  assert.equal(c.threads.on, true);
  assert.equal(c.facebook.on, true);
});

test("authoredChannels: чужий пост із кабінету, лише відправлений в одну мережу, НЕ позначається", () => {
  // інакше довгий майстер-текст не спакувався б під ліміт Threads, а впав би на ньому
  const c = authoredChannels({ facebook: { on: true } }, ["threads"], false);
  assert.equal(c.manual_adapt, undefined);
  assert.equal(c.native, undefined);
});

test("authoredChannels: авторський пост, перенесений в іншу мережу, лишається авторським", () => {
  const c = authoredChannels({ threads: { on: true }, manual_adapt: true, native: "threads" }, ["facebook"], false);
  assert.equal(c.native, "facebook");
  assert.equal(c.manual_adapt, true);
  assert.equal(c.threads.on, false);
});

test("authoredChannels: авторський пост, розширений на кілька мереж, стає майстер-текстом", () => {
  const c = authoredChannels({ threads: { on: true, text: "своя версія" }, manual_adapt: true, native: "threads" }, ["threads", "facebook"], false);
  assert.equal(c.native, undefined);
  assert.equal(c.manual_adapt, undefined);
  assert.equal(c.threads.text, "своя версія");   // уже адаптовані тексти не затираються
});

test("authoredChannels: стара чернетка без позначки доліковується, коли Claude пересилає текст", () => {
  assert.equal(authoredChannels({ threads: { on: true } }, ["threads"], true).manual_adapt, true);
});

// ---- картинки у відповіді інструмента ----
// Мініатюри стоку й згенерованого зображення йдуть окремими блоками MCP, щоб модель обирала
// очима. Тиха помилка тут - зламати текстовий блок (тоді всі інструменти відповідатимуть порожньо)
// або пропустити в content блок без даних (клієнт відкине всю відповідь).
import { toContent } from "../dist/mcp.js";

test("toContent: рядок - один текстовий блок із назвою кабінету", () => {
  assert.deepEqual(toContent("[Кабінет: А]\n", "готово"), [{ type: "text", text: "[Кабінет: А]\nготово" }]);
});

test("toContent: картинки йдуть окремими блоками ПІСЛЯ тексту", () => {
  const c = toContent("", { text: "варіанти", images: [{ data: "QUJD", mimeType: "image/jpeg" }, { data: "REVG", mimeType: "image/png" }] });
  assert.equal(c.length, 3);
  assert.equal(c[0].type, "text");
  assert.deepEqual(c[1], { type: "image", data: "QUJD", mimeType: "image/jpeg" });
  assert.equal(c[2].mimeType, "image/png");
});

test("toContent: блок без даних не потрапляє у відповідь, порожній текст стає «Готово.»", () => {
  const c = toContent("", { text: "", images: [{ data: "", mimeType: "image/jpeg" }] });
  assert.deepEqual(c, [{ type: "text", text: "Готово." }]);
});

test("нові інструменти: сток безкоштовний і лише читає, генерація прямо каже, що платна", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.ok(byName.find_stock_photos && byName.attach_stock_photo && byName.generate_image);
  assert.equal(byName.find_stock_photos.readOnly, true);
  assert.match(byName.find_stock_photos.description, /БЕЗКОШТОВНО/);
  assert.match(byName.attach_stock_photo.description, /БЕЗКОШТОВНО/);
  assert.match(byName.generate_image.description, /ПЛАТНО/);
  assert.deepEqual(byName.attach_stock_photo.required, ["id", "url"]);
});

// ---- план публікації: видно ДО відправки, дослівно піде текст чи його перепише модель кабінету ----
import { publishPlan, publishPlanLine } from "../dist/mcp.js";

test("publishPlan: позначка «дослівно», своя версія під мережу і авто-упаковка", () => {
  const txt = "x".repeat(472);
  assert.deepEqual(publishPlan({ threads: { on: true }, manual_adapt: true, native: "threads" }, txt),
    [{ net: "threads", mode: "verbatim", len: 472, limit: 500 }]);
  assert.equal(publishPlan({ threads: { on: true } }, txt)[0].mode, "auto");
  const own = publishPlan({ facebook: { on: true, text: "своя" } }, txt)[0];
  assert.equal(own.mode, "own");
  assert.equal(own.len, 4, "довжину рахуємо з тієї версії, яка реально піде");
  assert.deepEqual(publishPlan({ threads: { on: false } }, txt), []);
});

test("publishPlanLine: попереджає, коли дослівний текст не влізе в ліміт мережі", () => {
  const over = publishPlanLine(publishPlan({ threads: { on: true }, manual_adapt: true, native: "threads" }, "x".repeat(612)));
  assert.match(over, /Threads - дослівно \(612\/500\) ⚠️/);
  // авто-упаковка сама вкладеться в ліміт - лякати нема чим
  assert.doesNotMatch(publishPlanLine(publishPlan({ threads: { on: true } }, "x".repeat(612))), /⚠️/);
  // для Facebook 2000 - рекомендація, а не стіна
  assert.doesNotMatch(publishPlanLine(publishPlan({ facebook: { on: true }, manual_adapt: true, native: "facebook" }, "x".repeat(2500))), /⚠️/);
  assert.match(publishPlanLine(publishPlan({ facebook: { on: true } }, "abc")), /спакується моделлю кабінету/);
});

// ---- медіатека в конекторі: власні фото автора, безкоштовно, з позначкою «вже в пості» ----
import { usedList, OWN_MEDIA, GEN_MEDIA } from "../dist/mcp.js";

test("медіатека: інструменти безкоштовні, список лише читає, прикріплення вимагає пост і фото", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.ok(byName.list_media && byName.attach_media);
  assert.equal(byName.list_media.readOnly, true);
  assert.match(byName.list_media.description, /БЕЗКОШТОВНО/);
  assert.match(byName.attach_media.description, /БЕЗКОШТОВНО/);
  assert.deepEqual(byName.attach_media.required, ["id", "media"]);
  // медіатека стоїть у списку ПЕРЕД стоком - модель читає інструменти згори
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.indexOf("list_media") < names.indexOf("find_stock_photos"));
});

test("медіатека: власні фото окремо від згенерованого, кроп-копії не показуються ніде", () => {
  assert.ok(OWN_MEDIA.includes("upload") && OWN_MEDIA.includes("gdrive"));
  for (const hidden of ["crop", "ai-base", "ig-safe"]) {
    assert.ok(!OWN_MEDIA.includes(hidden) && !GEN_MEDIA.includes(hidden), `${hidden} у медіатеці конектора - це копія, а не фото`);
  }
  assert.equal(usedList("ab12cd34,ef56ab78"), "#ab12cd34, #ef56ab78");
  assert.equal(usedList(null), "");
});

test("заливка з комп'ютера: інструмент видає посилання, не читає файлів і стоїть перед стоком", () => {
  const t = TOOLS.find((x) => x.name === "media_upload_link");
  assert.ok(t, "media_upload_link має бути в конекторі");
  assert.notEqual(t.readOnly, true, "видає нове посилання - це не лише читання");
  assert.equal(t.properties.minutes.minimum, 5);
  assert.equal(t.properties.minutes.maximum, 180);
  // головне, що модель мусить зрозуміти з опису: файли йдуть повз чат, а без термінала - посилання людині
  assert.match(t.description, /МИНАЮЧИ чат/);
  assert.match(t.description, /браузер/);
  const names = TOOLS.map((x) => x.name);
  assert.ok(names.indexOf("media_upload_link") < names.indexOf("find_stock_photos"));
});
