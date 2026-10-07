// 👥 Ролі в бренді: хто що може. Тихі помилки тут - найдорожчі: друкарська помилка в переліку маршрутів
// мовчки закриває дію редактору (а він не розуміє чому), а помилка в інший бік - відкриває автору
// публікацію чи «Перегляду» витрати на AI. Тому перевіряємо не лише функції, а й самі переліки проти коду.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  ROLES, ASSIGNABLE, normRole, isAssignable, can, rankOf, routeCap, tgRouteCap, botCap, toolCap, settingCap,
  deniedText, maskEmail, ROUTE_KEYS, TG_ROUTE_KEYS, TOOL_KEYS, ROLE_LABEL, ROLE_ICON, ROLE_HINT,
} from "../dist/roles.js";
import { TOOLS } from "../dist/mcp.js";

const SRC = new URL("../src/", import.meta.url);
const server = readFileSync(new URL("server.ts", SRC), "utf8");
// усі маршрути кабінету, як їх реєструє server.ts: «МЕТОД /api/...»
const ROUTES = new Set([...server.matchAll(/app\.(get|post|put|delete|patch)\("(\/api\/[^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));

test("normRole: давнє member = «Повний доступ», невідоме - найменше, а не більше", () => {
  assert.equal(normRole("member"), "admin");
  assert.equal(normRole("OWNER"), "owner");
  assert.equal(normRole(" editor "), "editor");
  assert.equal(normRole("superuser"), "viewer");
  assert.equal(normRole(null), "viewer");
  assert.equal(normRole(undefined), "viewer");
  assert.deepEqual(ASSIGNABLE, ["admin", "editor", "author", "viewer"]);
  assert.ok(!isAssignable("owner"), "власника не видають запрошенням");
  assert.ok(isAssignable("author"));
  assert.ok(!isAssignable("member"));
});

test("can: сходи ролей - кожна вища вміє все, що нижча", () => {
  const caps = ["read", "draft", "publish", "manage", "team", "owner"];
  const expect = {
    viewer: ["read"],
    author: ["read", "draft"],
    editor: ["read", "draft", "publish"],
    admin: ["read", "draft", "publish", "manage", "team"],
    owner: caps,
  };
  for (const r of ROLES) for (const c of caps) assert.equal(can(r, c), expect[r].includes(c), `${r} × ${c}`);
  // нижча роль ніколи не вміє більше за вищу
  for (const c of caps) for (const a of ROLES) for (const b of ROLES) if (rankOf(a) > rankOf(b) && can(b, c)) assert.ok(can(a, c), `${a} ≥ ${b} на ${c}`);
  // не учасник - лише особисте
  assert.equal(can(null, "read"), false);
  assert.equal(can("", "read"), false);
  assert.equal(can(null, "self"), true);
  assert.equal(can("member", "team"), true, "давній доступ лишається повним");
});

test("routeCap: типово GET - перегляд, усе, що змінює, - лише «Повний доступ»", () => {
  assert.equal(routeCap("GET", "/api/posts/studio"), "read");
  assert.equal(routeCap("HEAD", "/api/posts/studio"), "read");
  assert.equal(routeCap("POST", "/api/невідомий/маршрут"), "manage", "забутий маршрут закритий, а не відкритий");
  assert.equal(routeCap("DELETE", undefined), "manage");
  assert.equal(routeCap("GET", "/api/admin/logs"), "self", "адмін сервісу перевіряється в самому роуті");
  assert.equal(routeCap("GET", "/api/integrations/meta/connect"), "manage", "підключення мережі - не перегляд");
  assert.equal(routeCap("GET", "/api/integrations/threads/callback"), "manage");
  // сходи на ключових діях
  assert.equal(routeCap("PUT", "/api/posts/:postId"), "draft");
  assert.equal(routeCap("POST", "/api/posts/:postId/submit"), "draft");
  assert.equal(routeCap("POST", "/api/posts/:postId/review"), "publish");
  assert.equal(routeCap("POST", "/api/posts/:postId/publish-all"), "publish");
  assert.equal(routeCap("POST", "/api/schedule/auto"), "publish");
  assert.equal(routeCap("POST", "/api/comments/reply"), "publish");
  // PRO-конвеєр замінює готові пости прогону - для автора це було б видалення чужої роботи
  for (const u of ["/api/runs/:id/steps/:step/run", "/api/runs/:id/run-from/:step", "/api/runs/:id/autopilot"]) assert.equal(routeCap("POST", u), "publish", u);
  assert.equal(routeCap("POST", "/api/runs/:id/generate-lite"), "draft", "Lite-генерація додає пости, а не замінює");
  assert.equal(routeCap("PUT", "/api/strategy"), "manage");
  assert.equal(routeCap("POST", "/api/workspaces/invite"), "team");
  assert.equal(routeCap("POST", "/api/account/reset"), "owner");
  assert.equal(routeCap("POST", "/api/workspaces/leave"), "self");
  // секрети й адреси-паролі ховаються навіть від перегляду
  assert.equal(routeCap("GET", "/api/integrations/transcription"), "manage");
  assert.equal(routeCap("GET", "/api/integrations/meeting"), "manage");
  assert.equal(routeCap("GET", "/api/account/export"), "manage");
  // що коштує грошей - не перегляду
  assert.equal(routeCap("GET", "/api/generate/prompt-preview"), "draft");
});

test("settingCap: ритм каналів і найкращий час веде редактор, решту налаштувань бренду - «Повний доступ»", () => {
  assert.equal(settingCap("channel_rhythm"), "publish");
  assert.equal(settingCap("best_time_auto"), "publish");
  for (const k of ["tone_of_voice", "voice_examples", "timezone", "pro", "cta_config", "", undefined, "channel_rhythm "]) assert.equal(settingCap(k), "manage", String(k));
  assert.equal(routeCap("PUT", "/api/settings/:key", { key: "channel_rhythm" }), "publish");
  assert.equal(routeCap("PUT", "/api/settings/:key", { key: "tone_of_voice" }), "manage");
  assert.equal(routeCap("PUT", "/api/settings/:key"), "manage", "без ключа - найсуворіше");
  assert.equal(routeCap("GET", "/api/settings"), "read");
});

test("переліки маршрутів кабінету: кожен справді існує в server.ts (друкарська помилка тихо закрила б дію)", () => {
  assert.ok(ROUTES.size > 200, `знайдено ${ROUTES.size} маршрутів - розбір server.ts зламався?`);
  const missing = ROUTE_KEYS().filter((k) => !ROUTES.has(k));
  assert.deepEqual(missing, [], "у roles.ts є маршрути, яких нема в server.ts");
});

test("Mini App: кожен маршрут із переліку існує; публікація й затвердження - редактор і вище", () => {
  const missing = TG_ROUTE_KEYS().filter((k) => !ROUTES.has(k));
  assert.deepEqual(missing, []);
  assert.equal(tgRouteCap("POST", "/api/tg/post/:postId/publish"), "publish");
  assert.equal(tgRouteCap("POST", "/api/tg/post/:postId/approve"), "publish");
  assert.equal(tgRouteCap("POST", "/api/tg/post/:postId/schedule"), "publish");
  assert.equal(tgRouteCap("POST", "/api/tg/post/:postId/first-comment"), "publish", "дослати коментар - дія в мережі від імені бренду");
  assert.equal(tgRouteCap("POST", "/api/tg/post/:postId/submit"), "draft");
  assert.equal(tgRouteCap("PUT", "/api/tg/post/:postId"), "draft");
  assert.equal(tgRouteCap("GET", "/api/tg/drafts"), "read");
  assert.equal(tgRouteCap("POST", "/api/tg/невідоме"), "manage");
  // усі маршрути Mini App, що змінюють, - перелічені явно (інакше лишились би для «Повного доступу»)
  const tgMut = [...ROUTES].filter((k) => k.includes(" /api/tg/") && !k.startsWith("GET "));
  const unlisted = tgMut.filter((k) => !TG_ROUTE_KEYS().includes(k));
  assert.deepEqual(unlisted, [], "новий маршрут Mini App, що змінює, - додай у TG_CAP у roles.ts");
});

test("кнопки бота: кожен префікс із коду має свідоме рішення", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  const prefixes = new Set();
  for (const f of files) {
    const s = readFileSync(new URL(f, SRC), "utf8");
    // «pub:…» - префікс із хвостом; «plan_gen» - кнопка цілком
    for (const m of s.matchAll(/data: ?[`"]([a-z_0-9]+)([:`"$])/g)) prefixes.add(m[2] === ":" ? m[1] + ":x" : m[1]);
  }
  assert.ok(prefixes.size > 25, `знайдено ${prefixes.size} префіксів - розбір зламався?`);
  // свідомо «Повний доступ»: ще один канал Telegram у бренд
  const MANAGE_ON_PURPOSE = new Set(["cad:x"]);
  for (const p of prefixes) {
    const cap = botCap(p);
    if (MANAGE_ON_PURPOSE.has(p)) assert.equal(cap, "manage", p);
    else assert.notEqual(cap, "manage", `кнопка «${p}» випала в «Повний доступ» за замовчуванням - віднеси її до потрібної ролі в botCap`);
  }
  // ключові
  assert.equal(botCap("pub:1"), "publish");
  assert.equal(botCap("ca:1"), "publish");
  assert.equal(botCap("cs:1:2"), "publish");
  assert.equal(botCap("cb:1"), "publish", "перенести чернетку в інший бренд - як видалити її тут");
  assert.equal(botCap("ce:1"), "draft");
  assert.equal(botCap("csub:1"), "draft");
  assert.equal(botCap("mt:go"), "draft");
  assert.equal(botCap("idea_list"), "read");
  assert.equal(botCap("cm:send:1"), "read", "коментарі перевіряє tgcomments сам");
  assert.equal(botCap("br:1"), "self");
  assert.equal(botCap("al:ok:1"), "self");
  assert.equal(botCap("plan_gen"), "publish");
  assert.equal(botCap("невідоме:1"), "manage");
  assert.equal(botCap(""), "manage");
});

test("інструменти конектора: кожен має явну роль, і переліки збігаються з TOOLS", () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names.filter((n) => !TOOL_KEYS().includes(n) && !["evergreen", "links"].includes(n)), [],
    "новий інструмент без ролі - лише «Повний доступ»; додай його в TOOL_CAP");
  assert.deepEqual(TOOL_KEYS().filter((n) => !names.includes(n)), [], "у TOOL_CAP є інструмент, якого нема в TOOLS");
  assert.equal(toolCap("publish_post"), "publish");
  assert.equal(toolCap("reply_to_comment"), "publish");
  assert.equal(toolCap("create_draft", {}), "draft");
  assert.equal(toolCap("create_draft", { approve: true }), "publish", "затвердити - не автору");
  assert.equal(toolCap("update_post", { text: "x" }), "draft");
  assert.equal(toolCap("update_post", { approve: false }), "publish");
  assert.equal(toolCap("update_post", { evergreen: true }), "publish");
  assert.equal(toolCap("evergreen", {}), "read");
  assert.equal(toolCap("evergreen", { action: "on" }), "manage");
  assert.equal(toolCap("evergreen", { action: "add" }), "publish");
  assert.equal(toolCap("links", { action: "bio" }), "manage");
  assert.equal(toolCap("links", { action: "shorten" }), "draft");
  assert.equal(toolCap("links"), "read");
  assert.equal(toolCap("list_workspaces"), "self");
  assert.equal(toolCap("submit_for_review"), "draft");
  assert.equal(toolCap("невідомий"), "manage");
});

test("deniedText: людською мовою, з роллю й тим, що робити далі", () => {
  const t = deniedText("author", "publish", "Vary Servis");
  assert.match(t, /Твоя роль у бренді «Vary Servis» - 📝 Автор\./);
  assert.match(t, /редактор/);
  assert.match(t, /На затвердження/, "автору - куди натиснути замість публікації");
  assert.match(deniedText("viewer", "draft"), /👁 Перегляд/);
  assert.doesNotMatch(deniedText("viewer", "draft"), /На затвердження/);
  assert.equal(deniedText(null, "read"), "Немає доступу до цього бренду.");
  assert.match(deniedText("editor", "owner"), /лише власник/);
  assert.doesNotMatch(deniedText("editor", "manage"), /—/, "у текстах - звичайний дефіс");
  for (const r of ROLES) { assert.ok(ROLE_LABEL[r] && ROLE_ICON[r] && ROLE_HINT[r], r); assert.doesNotMatch(ROLE_HINT[r], /—/); }
});

test("maskEmail: пошта для тих, кому повна не потрібна", () => {
  assert.equal(maskEmail("oleg@swipescape.eu"), "o***@swipescape.eu");
  assert.equal(maskEmail("a@b.cz"), "a***@b.cz");
  assert.equal(maskEmail("бездомена"), "б***");
  assert.equal(maskEmail(""), "");
});
