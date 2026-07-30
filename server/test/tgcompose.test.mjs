// Композер у Telegram: розбір дати й перерахунок локального часу в UTC.
// Саме тут найлегше зробити тиху помилку: «14:30» прочитати як дату, переплутати день з місяцем,
// або запланувати «завтра о 9:00» за UTC - тоді пост вийде на 2-3 години раніше, ніж людина чекала.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedToUtc, parseWhenAt } from "../dist/tgcompose.js";

const KYIV = "Europe/Kyiv";
const now = { y: 2026, mo: 7, d: 28, tz: KYIV }; // вівторок 28 липня 2026

test("zonedToUtc: літній Київ = UTC+3", () => {
  const at = zonedToUtc(2026, 7, 28, 9, 0, KYIV);
  assert.equal(at.toISOString(), "2026-07-28T06:00:00.000Z");
});

test("zonedToUtc: зимовий Київ = UTC+2 (DST враховано, а не зашито)", () => {
  const at = zonedToUtc(2026, 1, 15, 9, 0, KYIV);
  assert.equal(at.toISOString(), "2026-01-15T07:00:00.000Z");
});

test("zonedToUtc: UTC сам у себе не зсувається", () => {
  assert.equal(zonedToUtc(2026, 7, 28, 9, 0, "UTC").toISOString(), "2026-07-28T09:00:00.000Z");
});

test("parseWhenAt: тільки час = сьогодні", () => {
  const at = parseWhenAt("18:30", now);
  assert.equal(at.toISOString(), "2026-07-28T15:30:00.000Z");
});

test("parseWhenAt: «завтра 09:00»", () => {
  const at = parseWhenAt("завтра 09:00", now);
  assert.equal(at.toISOString(), "2026-07-29T06:00:00.000Z");
});

test("parseWhenAt: «01.08 14:30» - день.місяць, не місяць.день", () => {
  const at = parseWhenAt("01.08 14:30", now);
  assert.equal(at.toISOString(), "2026-08-01T11:30:00.000Z");
});

test("parseWhenAt: ISO-формат", () => {
  const at = parseWhenAt("2026-08-01 18:00", now);
  assert.equal(at.toISOString(), "2026-08-01T15:00:00.000Z");
});

test("parseWhenAt: «14.30» через крапку НЕ вгадуємо - воно неоднозначне", () => {
  // «01.08» це водночас 1 серпня і 01:08. Вгадування тут коштує посту, що вийшов не того дня,
  // тож просимо двокрапку - бот у відповідь показує приклади.
  assert.equal(parseWhenAt("14.30", now), null);
});

test("parseWhenAt: без часу відповіді нема (краще перепитати, ніж вгадати)", () => {
  assert.equal(parseWhenAt("завтра", now), null);
  assert.equal(parseWhenAt("01.08", now), null);
  assert.equal(parseWhenAt("аякже", now), null);
});

test("parseWhenAt: некоректний час відкидається", () => {
  assert.equal(parseWhenAt("25:00", now), null);
  assert.equal(parseWhenAt("12:75", now), null);
});
