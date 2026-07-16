// Юніти детермінованого антидетектора AI-слідів (каталог патернів).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanAiTraces } from "../dist/pipeline.js";

const DIRTY = `У сучасному світі варто зазначити, що це не просто пост, а ціла подорож.
Це не тільки текст, але й емоція. Давайте розберемося разом.
Отже, підсумовуючи: ключовий аспект - це ефективність, оптимізація та результативність.`;

const CLEAN = `Вчора клієнт запитав, чому його рілс не залетів. Відповідь була в першому кадрі:
він починався з логотипа. Перші дві секунди вирішують усе. Покажи обличчя або результат.`;

test("брудний AI-текст дає знахідки", () => {
  const f = scanAiTraces(DIRTY);
  assert.ok(f.length >= 2, `очікував ≥2 слідів, отримав ${f.length}: ` + JSON.stringify(f));
  for (const x of f) { assert.ok(x.pattern); assert.ok(x.quote); }
});

test("живий людський текст - нуль знахідок", () => {
  const f = scanAiTraces(CLEAN);
  assert.equal(f.length, 0, "хибні спрацювання: " + JSON.stringify(f));
});
