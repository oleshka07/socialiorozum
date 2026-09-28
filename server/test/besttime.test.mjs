// ⏰ Найкращий час з власних даних: правила, на яких календар ставить пости.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bestTimes, timesFor, localMinute, windowOf, shrunk, windowTime, BT_MIN_POSTS } from "../dist/besttime.js";

const TZ = "Europe/Prague";
// пост о HH:MM за Прагою (28.09 - літній час, UTC+2) з множником m
const at = (hh, mm = 0, day = 1) => new Date(Date.UTC(2026, 8, day, hh - 2, mm)).toISOString();
const post = (hh, mm, mult, extra = {}) => ({ net: "threads", account: "a", account_name: "@a", created_at: at(hh, mm), mult, ...extra });

test("час у поясі кабінету і вікна доби", () => {
  assert.equal(localMinute("2026-09-28T17:30:00Z", TZ), 19 * 60 + 30);
  assert.equal(windowOf(19 * 60 + 30).key, "w18");
  assert.equal(windowOf(5 * 60).key, "w0");
  assert.equal(windowOf(23 * 60 + 59).key, "w21");
});

test("обережна оцінка тягнеться до норми, а час - медіана фактичного, у межах вікна", () => {
  assert.equal(shrunk(2, 3), 1.5);
  assert.equal(windowTime([1145, 1170, 1210], { from: 18, to: 21 }), "19:30");
  assert.equal(windowTime([1435], { from: 21, to: 24 }), "23:45");
  assert.equal(windowTime([540], { from: 9, to: 12 }), "09:00");
});

test("менше 10 дозрілих постів - порад нема, людині сказано, скільки бракує", () => {
  const b = bestTimes([post(9, 0, 1), post(19, 0, 2), post(19, 30, 2)], TZ).find((x) => x.key === "threads");
  assert.equal(b.ready, false);
  assert.deepEqual(b.times, []);
  assert.match(b.text, new RegExp(`треба ${BT_MIN_POSTS}`));
});

test("завжди в один час - не «найкраще 9:00», а порада спробувати інший", () => {
  const posts = Array.from({ length: 12 }, (_, i) => post(9 + (i % 3), 10, 1 + (i % 4) / 10));
  const b = bestTimes(posts, TZ).find((x) => x.key === "threads");
  assert.equal(b.ready, false);
  assert.deepEqual(b.times, []);
  assert.match(b.text, /о 9-12 - порівняти нема з чим/);
  assert.match(b.text, /о 18-21/);
});

test("явний переможець: вікно, конкретний час, найслабше", () => {
  const posts = [
    ...[5, 10, 15, 20, 25, 50].map((m) => post(19, m, 2)),        // вечір ×2
    ...[0, 15, 30, 45, 5, 50].map((m) => post(9, m, 0.8)),        // ранок ×0.8
  ];
  const b = bestTimes(posts, TZ).find((x) => x.key === "threads");
  assert.equal(b.ready, true);
  assert.equal(b.best[0].key, "w18");
  assert.equal(b.best.length, 1);
  assert.equal(b.worst.key, "w9");
  assert.deepEqual(b.times, ["19:15"]);
  assert.match(b.text, /найкраще о 18-21 - ×2\.0 від твоєї норми \(6 постів\)/);
  assert.match(b.text, /найслабше о 9-12 - ×0\.8/);
  assert.match(b.text, /Найкращий час для постів - 19:15/);
});

test("різниця менша за 10% - час не впливає, календар бере час зі стратегії", () => {
  const posts = [...Array.from({ length: 6 }, (_, i) => post(9, i * 5, 1)), ...Array.from({ length: 6 }, (_, i) => post(19, i * 5, 1.05))];
  const b = bestTimes(posts, TZ).find((x) => x.key === "threads");
  assert.equal(b.ready, true);
  assert.deepEqual(b.best, []);
  assert.deepEqual(b.times, []);
  assert.match(b.text, /майже не впливає/);
});

test("повторюваність важить: 9 постів ×1.8 перемагають 3 пости ×2.0", () => {
  const posts = [
    ...Array.from({ length: 3 }, (_, i) => post(13, i * 10, 2)),
    ...Array.from({ length: 9 }, (_, i) => post(19, i * 5, 1.8)),
  ];
  const b = bestTimes(posts, TZ).find((x) => x.key === "threads");
  assert.equal(b.best[0].key, "w18");
  assert.equal(b.best[1].key, "w12");
});

test("свіжі й без статистики не рахуються, сторіс - теж", () => {
  const posts = [
    ...Array.from({ length: 10 }, (_, i) => post(19, i * 5, 2)),
    ...Array.from({ length: 5 }, (_, i) => post(9, i * 5, null)),              // свіжі / без цифр
    ...Array.from({ length: 5 }, (_, i) => post(9, i * 5, 5, { media: "story" })),
  ];
  const b = bestTimes(posts, TZ).find((x) => x.key === "threads");
  assert.equal(b.n, 10);
  assert.equal(b.ready, false);                // усі 10 у вечірньому вікні - порівнювати нема з чим
});

test("кілька акаунтів: свій час у кожного, а де замало даних - спільний мережі", () => {
  const posts = [
    ...[0, 10, 20, 30, 40, 50].map((m) => post(19, m, 2, { account: "a", account_name: "@a" })),
    ...[0, 10, 20, 30, 40, 50].map((m) => post(9, m, 0.7, { account: "a", account_name: "@a" })),
    post(12, 0, 1.5, { account: "b", account_name: "@b" }), post(12, 30, 1.2, { account: "b", account_name: "@b" }),
  ];
  const items = bestTimes(posts, TZ);
  assert.deepEqual(items.map((x) => x.key).sort(), ["threads", "threads:a", "threads:b"]);
  const a = items.find((x) => x.key === "threads:a"), b = items.find((x) => x.key === "threads:b");
  assert.equal(a.ready, true);
  assert.equal(b.ready, false);
  assert.match(a.text, /^Threads @a:/);
  assert.deepEqual(timesFor(items, "threads", "a"), a.times);
  assert.deepEqual(timesFor(items, "threads", "b"), items.find((x) => x.key === "threads").times);   // замало в @b - спільний
  assert.deepEqual(timesFor(items, "instagram", "x"), []);                                         // нема даних мережі
});

test("мережі без статистики постів (Telegram, LinkedIn) не з'являються", () => {
  const items = bestTimes([post(9, 0, null, { net: "telegram" }), post(9, 0, null, { net: "linkedin" })], TZ);
  assert.deepEqual(items, []);
});
