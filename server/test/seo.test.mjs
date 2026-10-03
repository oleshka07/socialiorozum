// 🔎 Пошуковики (seo.ts). Тиха помилка тут: lastmod, що не міняється, коли сторінка змінилась (Google
// перестає йому вірити); IndexNow, що щодеплою шле те саме (протокол просить не повторювати) або не
// повторює неприйняте; ключ не за протоколом (усі запити - 422); IndexNow з бети чи з localhost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcilePages, indexNowEnabled, indexNowBody, indexNowText, newIndexNowKey, isIndexNowKey, pageHash } from "../dist/seo.js";

test("відбитки сторінок: перший старт - усе нове; без змін - нічого; змінене - нова дата лише в нього", () => {
  const h = { "/": pageHash("<h1>A</h1>"), "/privacy": pageHash("privacy v1") };
  const first = reconcilePages(undefined, h, "2026-10-03");
  assert.deepEqual(first.changed.sort(), ["/", "/privacy"]);
  assert.deepEqual(first.pending.sort(), ["/", "/privacy"]);
  assert.equal(first.pages["/"].at, "2026-10-03");
  // IndexNow прийняв обидві
  for (const p of Object.keys(first.pages)) first.pages[p].pinged = first.pages[p].hash;
  const same = reconcilePages(first.pages, h, "2026-10-09");
  assert.deepEqual(same.changed, []);
  assert.deepEqual(same.pending, []);
  assert.equal(same.pages["/"].at, "2026-10-03", "без змін дата не рухається");
  const h2 = { ...h, "/": pageHash("<h1>B</h1>") };
  const next = reconcilePages(same.pages, h2, "2026-10-09");
  assert.deepEqual(next.changed, ["/"]);
  assert.deepEqual(next.pending, ["/"]);
  assert.equal(next.pages["/"].at, "2026-10-09");
  assert.equal(next.pages["/privacy"].at, "2026-10-03");
});

test("відбитки: неприйняте IndexNow лишається в черзі й після рестарту; прибрана сторінка зникає", () => {
  const h = { "/": pageHash("a"), "/terms": pageHash("t") };
  const first = reconcilePages(undefined, h, "2026-10-03");
  first.pages["/terms"].pinged = first.pages["/terms"].hash;      // прийнято лише /terms
  const again = reconcilePages(first.pages, h, "2026-10-04");
  assert.deepEqual(again.changed, []);
  assert.deepEqual(again.pending, ["/"], "не прийнята минулого разу - у черзі");
  assert.equal(again.pages["/"].at, "2026-10-03", "дата - коли змінився вміст, а не коли повторюємо");
  const gone = reconcilePages(first.pages, { "/": h["/"] }, "2026-10-04");
  assert.deepEqual(Object.keys(gone.pages), ["/"]);
});

test("IndexNow лише з відкритого інстансу на справжній https-адресі", () => {
  assert.equal(indexNowEnabled("https://holos.rozum.one", false), true);
  assert.equal(indexNowEnabled("https://holos.rozum.one/", false, ""), true);
  assert.equal(indexNowEnabled("https://beta.holos.rozum.one", true), false, "бета (PIN) - ні");
  assert.equal(indexNowEnabled("https://holos.rozum.one", false, "0"), false, "INDEXNOW=0 - вимкнено");
  assert.equal(indexNowEnabled("https://holos.rozum.one", false, "off"), false);
  for (const u of ["http://holos.rozum.one", "http://localhost:8080", "https://localhost", "https://127.0.0.1", "https://dev.localhost", "https://box.local", "not a url", ""])
    assert.equal(indexNowEnabled(u, false), false, u);
});

test("тіло IndexNow: хост, ключ, файл ключа на тому ж хості, повні адреси", () => {
  const b = indexNowBody("https://holos.rozum.one/", "0123456789abcdef0123456789abcdef", ["/", "/privacy"]);
  assert.deepEqual(b, {
    host: "holos.rozum.one",
    key: "0123456789abcdef0123456789abcdef",
    keyLocation: "https://holos.rozum.one/0123456789abcdef0123456789abcdef.txt",
    urlList: ["https://holos.rozum.one/", "https://holos.rozum.one/privacy"],
  });
});

test("ключ IndexNow за протоколом: 8-128 знаків a-z, A-Z, 0-9 і «-»", () => {
  const k = newIndexNowKey();
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.notEqual(newIndexNowKey(), k);
  assert.ok(isIndexNowKey(k));
  for (const bad of ["", "short", "a".repeat(129), "has space here", "dots.not.allowed", "../etc/passwd", null, 42]) assert.ok(!isIndexNowKey(bad), String(bad));
  assert.ok(isIndexNowKey("abc-DEF-123"));
});

test("відповіді IndexNow людською мовою", () => {
  assert.equal(indexNowText(200), "прийнято");
  assert.match(indexNowText(202), /ключ ще перевіряють/);
  assert.match(indexNowText(403), /файл ключа/);
  assert.match(indexNowText(422), /не з цього сайту/);
  assert.match(indexNowText(429), /повторимо/);
  assert.equal(indexNowText(0), "немає відповіді");
  assert.equal(indexNowText(503), "код 503");
});

test("збій IndexNow не будить адміна: попередження - лише в денний звіт", async () => {
  const { classify } = await import("../dist/alerts-plan.js");
  for (const m of [
    'IndexNow не прийняв 1 стор.: адреси не з цього сайту або ключ не за протоколом - {"code":"InvalidRequestParameters","message":"URLs do not belong to host"}',
    "IndexNow не прийняв 4 стор.: забагато запитів, повторимо пізніше",
    "IndexNow не прийняв 4 стор.: немає відповіді - The operation was aborted due to timeout",
    "IndexNow не прийняв 2 стор.: код 503 - Service Unavailable",
  ]) {
    const v = classify("warn", "seo", m);
    assert.equal(v.notify, "digest", m);
    assert.equal(v.severity, "warning", m);
  }
  assert.equal(classify("info", "seo", "IndexNow: 4 стор. - прийнято (200)").notify, "none");
});
