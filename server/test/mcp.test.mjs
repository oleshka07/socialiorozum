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
