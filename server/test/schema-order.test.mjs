// Порядок інструкцій у schema.sql. Міграція = увесь файл, що проганяється на старті застосунку,
// тож `alter table X` ВИЩЕ за `create table X` валить старт - але лише на БД, де таблиці ще немає.
// На беті й деві таблиця зазвичай уже є, тому помилка невидима саме там, де її шукають, і спливає
// на проді. 30.07 так і сталось: три `alter table post_metric` стояли над його `create table`,
// прод не деплоївся з 09.07 (коли таблицю додали), міграція впала, застосунок не піднявся.
// Цей тест ловить такий порядок статично - на будь-якій машині, без БД.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lines = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8").split("\n");

const created = new Map();   // таблиця -> рядок create table
const refs = [];             // {line, table, kind} для alter table / create index on
lines.forEach((l, i) => {
  const ln = i + 1;
  let m = /^\s*create table if not exists (\w+)/i.exec(l);
  if (m) { if (!created.has(m[1])) created.set(m[1], ln); return; }
  m = /^\s*alter table (\w+)/i.exec(l);
  if (m) { refs.push({ line: ln, table: m[1], kind: "alter table" }); return; }
  m = /create (?:unique )?index if not exists \w+ on (\w+)/i.exec(l);
  if (m) refs.push({ line: ln, table: m[1], kind: "create index" });
});

test("schema.sql: жодного alter/index ПЕРЕД create table тієї ж таблиці", () => {
  const bad = refs
    .filter((r) => created.has(r.table) && r.line < created.get(r.table))
    .map((r) => `рядок ${r.line}: ${r.kind} ${r.table} — а create table на рядку ${created.get(r.table)}`);
  assert.deepEqual(bad, [], "на чистій БД міграція впаде тут:\n" + bad.join("\n"));
});

test("schema.sql: немає посилань на таблиці, яких файл не створює", () => {
  const missing = [...new Set(refs.filter((r) => !created.has(r.table)).map((r) => r.table))];
  assert.deepEqual(missing, [], "ці таблиці ніде не створюються: " + missing.join(", "));
});

test("схема взагалі розібралась (щоб тест не був порожнім при зміні формату)", () => {
  assert.ok(created.size > 20, `знайдено лише ${created.size} таблиць - парсер щось не бачить`);
  assert.ok(refs.length > 20, `знайдено лише ${refs.length} alter/index - парсер щось не бачить`);
});
