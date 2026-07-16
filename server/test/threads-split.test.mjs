// Юніти детермінованої розбивки поста на гілку Threads (фолбек без LLM).
// Запуск: npm test (потрібен попередній npm run build - тести їдять компільований dist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTextForThread } from "../dist/pipeline.js";

test("короткий текст = одна частина без змін", () => {
  const parts = splitTextForThread("Коротка думка.");
  assert.deepEqual(parts, ["Коротка думка."]);
});

test("довгий текст ріжеться по абзацах, кожна частина ≤450", () => {
  const paras = Array.from({ length: 6 }, (_, i) => `Абзац ${i + 1}. ` + "слово ".repeat(40).trim());
  const parts = splitTextForThread(paras.join("\n\n"));
  assert.ok(parts.length >= 2, "має бути кілька частин");
  for (const p of parts) assert.ok(p.length <= 450, `частина довша за 450: ${p.length}`);
  // зміст не губиться: всі абзаци присутні
  const joined = parts.join("\n\n");
  for (let i = 1; i <= 6; i++) assert.ok(joined.includes(`Абзац ${i}.`), `загубився абзац ${i}`);
});

test("суцільний абзац понад ліміт обрізається, а не валить розбивку", () => {
  const parts = splitTextForThread("а".repeat(1000));
  assert.ok(parts.length >= 1);
  for (const p of parts) assert.ok(p.length <= 450);
});

test("порожній вхід не вибухає", () => {
  assert.deepEqual(splitTextForThread(""), []);
});
