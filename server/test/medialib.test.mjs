// 🖼 Медіатека: стан файлу, мережі, коли відкласти в архів і коли повернути - чисті правила
import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaUsage, archiveDueAt, archiveAction, normArchiveDays, cleanTitle } from "../dist/medialib-plan.js";

const D = (s) => new Date(s).toISOString();
const post = (o) => ({ id: o.id || "p", review: o.review ?? null, sent: o.sent || [], lastPub: o.lastPub || null, nextAt: o.nextAt || null, nets: o.nets || [] });

test("стан: вільне, монтаж, чернетка, розклад, вийшло, відпрацьоване", () => {
  assert.equal(mediaUsage([]).state, "free");
  assert.equal(mediaUsage([], true).state, "montage");
  assert.equal(mediaUsage([post({ nets: ["instagram"] })]).state, "draft");
  assert.equal(mediaUsage([post({ nets: ["instagram"], nextAt: D("2026-10-12T10:00Z") })]).state, "planned");
  // вийшов і ще стоїть у іншій чернетці
  assert.equal(mediaUsage([post({ id: "a", sent: ["instagram"], lastPub: D("2026-10-01") }), post({ id: "b" })]).state, "published");
  // усі пости вийшли, далі нічого не заплановано
  assert.equal(mediaUsage([post({ sent: ["instagram", "facebook"], lastPub: D("2026-10-01"), nets: ["instagram", "facebook"] })]).state, "done");
  // вийшов не всюди, але решта мереж ніде не запланована - теж відпрацьоване (автоматично вже нічого не вийде)
  assert.equal(mediaUsage([post({ sent: ["instagram"], lastPub: D("2026-10-01"), nets: ["instagram", "telegram"] })]).state, "done");
  // вийшов у частину мереж, решта - у розкладі
  const u = mediaUsage([post({ sent: ["instagram"], lastPub: D("2026-10-01"), nets: ["instagram", "telegram"], nextAt: D("2026-10-12T10:00Z") })]);
  assert.equal(u.state, "planned");
  assert.deepEqual(u.waiting, ["telegram"]);
});

test("відкладений невиданий пост не рахується, а виданий - рахується", () => {
  assert.equal(mediaUsage([post({ review: "archived" })]).state, "free");
  const u = mediaUsage([post({ review: "archived", sent: ["threads"], lastPub: D("2026-09-01") })]);
  assert.equal(u.state, "done");
  assert.deepEqual(u.posts, ["p"]);
});

test("мережі - разом з усіх постів, у порядку кабінету; остання публікація - найпізніша", () => {
  const u = mediaUsage([
    post({ id: "a", sent: ["facebook", "telegram"], lastPub: D("2026-09-01") }),
    post({ id: "b", sent: ["instagram", "telegram"], lastPub: D("2026-10-02") }),
  ]);
  assert.deepEqual(u.sent, ["telegram", "instagram", "facebook"]);
  assert.equal(u.lastPub, D("2026-10-02"));
  assert.deepEqual(u.posts, ["a", "b"]);
});

test("автоархів: через N днів після останньої публікації і лише відпрацьоване", () => {
  const done = { state: "done", lastPub: D("2026-10-01T12:00Z") };
  assert.equal(archiveDueAt(done, 15), D("2026-10-16T12:00Z"));
  assert.equal(archiveDueAt(done, 0), null);                       // вимкнено
  assert.equal(archiveDueAt(done, 15, true), null);                // людина повернула руками - не ховати
  assert.equal(archiveDueAt({ state: "planned", lastPub: done.lastPub }, 15), null);
  assert.equal(archiveDueAt({ state: "published", lastPub: done.lastPub }, 15), null);
  const m = { archived_at: null, archived_by: null, archive_keep: false };
  assert.equal(archiveAction(m, done, 15, Date.parse("2026-10-16T11:59Z")), null);
  assert.equal(archiveAction(m, done, 15, Date.parse("2026-10-16T12:00Z")), "archive");
  assert.equal(archiveAction({ ...m, archive_keep: true }, done, 15, Date.parse("2026-12-01")), null);
});

test("автоархів сам повертає файл, що знову в роботі; відкладене людиною - ні", () => {
  const auto = { archived_at: D("2026-10-05"), archived_by: "auto", archive_keep: false };
  const manual = { ...auto, archived_by: "manual" };
  for (const state of ["draft", "planned", "published"]) {
    assert.equal(archiveAction(auto, { state, lastPub: null }, 15), "restore", state);
    assert.equal(archiveAction(manual, { state, lastPub: null }, 15), null, state);
  }
  assert.equal(archiveAction(auto, { state: "done", lastPub: D("2026-09-01") }, 15), null);
  assert.equal(archiveAction(auto, { state: "free", lastPub: null }, 15), null);
});

test("дні автоархіву: найближче з дозволених, порожнє - типові 30, нуль - вимкнено", () => {
  assert.equal(normArchiveDays(undefined), 30);
  assert.equal(normArchiveDays(null), 30);
  assert.equal(normArchiveDays(0), 0);
  assert.equal(normArchiveDays("0"), 0);
  assert.equal(normArchiveDays(-5), 0);
  assert.equal(normArchiveDays(15), 15);
  assert.equal(normArchiveDays(12), 10);
  assert.equal(normArchiveDays(20), 15);
  assert.equal(normArchiveDays(45), 30);
  assert.equal(normArchiveDays(400), 60);
  assert.equal(normArchiveDays("сміття"), 0);
});

test("назва файлу: без керувальних символів і зайвих пробілів, до 120 знаків", () => {
  assert.equal(cleanTitle("  Фасад \n до   ремонту\t"), "Фасад до ремонту");
  assert.equal(cleanTitle(null), "");
  assert.equal(cleanTitle("x".repeat(300)).length, 120);
});
