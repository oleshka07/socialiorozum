// Юніти піксельного переносу оверлея (регресія: CAPS-кирилиця вилазила за край на 4:5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { charFrac, textPx, wrapPx } from "../dist/images.js";

test("класи ширини символів упорядковані розумно", () => {
  assert.ok(charFrac("і", false) < charFrac("а", false), "вузька і < рядкової а");
  assert.ok(charFrac("а", false) < charFrac("А", false), "рядкова < ВЕЛИКОЇ");
  assert.ok(charFrac("А", false) < charFrac("М", false), "звичайна ВЕЛИКА < найширшої М");
  assert.equal(charFrac("х", true), 0.64, "mono - константа");
});

test("ALL-CAPS кирилиця рахується суттєво ширшою за стару оцінку 0.6", () => {
  const fs = 66;
  const w = textPx("НАЙЦІННІШИЙ", fs, false);
  assert.ok(w > "НАЙЦІННІШИЙ".length * fs * 0.6, "нова оцінка має бути більшою за стару константу");
});

test("wrapPx: жоден зібраний рядок не ширший за поле", () => {
  const words = "ЧАС НАЙЦІННІШИЙ РЕСУРС ЯКИЙ У ТЕБЕ Є СЬОГОДНІ".split(" ").map((t) => ({ t, a: false }));
  const fs = 66, maxW = 880;
  const lines = wrapPx(words, fs, maxW, false);
  assert.ok(lines.length >= 2, "довгий CAPS-заголовок має перенестись");
  for (const ws of lines) {
    const lineW = textPx(ws.map((w) => w.t).join(" "), fs, false);
    // єдиний дозволений виняток - рядок з ОДНОГО слова, ширшого за поле (його зменшує shrink-to-fit)
    if (ws.length > 1) assert.ok(lineW <= maxW, `рядок вилазить: ${lineW} > ${maxW}`);
  }
});

test("wrapPx: слово, ширше за поле, стоїть окремим рядком (для shrink-to-fit)", () => {
  const words = [{ t: "НАЙВІДПОВІДАЛЬНІШИЙ", a: false }, { t: "момент", a: false }];
  const lines = wrapPx(words, 66, 300, false);
  assert.equal(lines[0].length, 1, "надширике слово - окремо");
});
