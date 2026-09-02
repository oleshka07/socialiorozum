// Стеля витрат на AI. Що тут стережеться: (1) 0 = «без обмеження», а не «заборонено все» - інакше
// порожній .env зупинив би сервіс; (2) повідомлення людське і з цифрами; (3) вікно частоти скидається.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capVerdict, capMessage, overCallRate } from "../dist/spend.js";

test("в межах стелі - дозволено", () => {
  assert.deepEqual(capVerdict({ day: 1.2, month: 10 }, { day: 3, month: 30 }), { ok: true });
});
test("денна стеля вичерпана - блок із причиною", () => {
  assert.deepEqual(capVerdict({ day: 3, month: 10 }, { day: 3, month: 30 }), { ok: false, reason: "day" });
});
test("місячна стеля ловить «по трохи щодня»", () => {
  assert.deepEqual(capVerdict({ day: 0.5, month: 30 }, { day: 3, month: 30 }), { ok: false, reason: "month" });
});
test("0 у стелі = без обмеження (кабінет оператора), а не «нічого не можна»", () => {
  assert.deepEqual(capVerdict({ day: 999, month: 9999 }, { day: 0, month: 0 }), { ok: true });
});
test("повідомлення людське, з сумами і що робити", () => {
  const m = capMessage("day", { day: 3.004, month: 5 }, { day: 3, month: 30 });
  assert.match(m, /\$3\.00 із \$3\.00/); assert.match(m, /опівночі/); assert.match(m, /адміністратор/);
  assert.match(capMessage("month", { day: 0, month: 30 }, { day: 3, month: 30 }), /Місячн/);
  assert.match(capMessage("rate", { day: 0, month: 0 }, { day: 3, month: 30 }), /за хвилину/);
});
test("вікно частоти: N-й виклик проходить, N+1 - ні, за хвилину скидається", () => {
  const ws = "ws-rate-" + Math.random(); let t = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(overCallRate(ws, 5, t), false, "виклик " + (i + 1));
  assert.equal(overCallRate(ws, 5, t), true, "шостий за хвилину - забагато");
  assert.equal(overCallRate(ws, 5, t + 61_000), false, "нова хвилина - знову можна");
  assert.equal(overCallRate("інший-" + ws, 5, t), false, "інший воркспейс не зачеплений");
  assert.equal(overCallRate(ws, 0, t), false, "0 = без обмеження");
});
