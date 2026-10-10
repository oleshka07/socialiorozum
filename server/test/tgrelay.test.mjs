// 🤖 Свій бот людини (без перехоплення): що з її власних повідомлень береться до вечора, ключ без чату,
// розбір відповіді моделі на ідеї.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteText, noteKey, NOTE_MIN, NOTE_MAX } from "../dist/tgrelay.js";
import { parseChatIdeas } from "../dist/pipeline.js";

test("noteText: коротке, самі посилання й емодзі - не думка", () => {
  assert.equal(noteText("ок, дякую"), "");
  assert.equal(noteText("буду о 5, адреса та сама"), "");
  assert.equal(noteText("https://example.com/a/b/c/d/e/f/g 👍👍👍"), "");
  assert.equal(noteText(null), "");
  const t = "Більшість клієнтів просить знижку не через ціну, а через страх, що переплатять.";
  assert.equal(noteText(t), t);
});

test("noteText: голосове без мітки, пробіли стиснуті, довге обрізане", () => {
  const t = noteText("[голосове]   Я завжди кажу клієнтам: спершу фото до, потім кошторис,\n\n бо інакше сперечаємось про те, чого ніхто не бачив.");
  assert.ok(!t.startsWith("[голосове]"));
  assert.ok(!/\s{2,}/.test(t));
  assert.ok(t.length >= NOTE_MIN);
  assert.equal(noteText("а".repeat(5000)).length, NOTE_MAX);
});

test("noteKey: стабільний, різний для різних повідомлень, не містить id чату", () => {
  const a = noteKey("conn1", 777123, 10), b = noteKey("conn1", 777123, 11), c = noteKey("conn1", 777123, 10);
  assert.equal(a, c);
  assert.notEqual(a, b);
  assert.ok(!a.includes("777123"));
  assert.match(a, /^[0-9a-f]{40}$/);
});

test("parseChatIdeas: обʼєкт, масив, огорожа коду; до 3; рубрика лише з наявних; дублі геть", () => {
  const raw = '```json\n{"ideas":[{"idea":"Чому знижка - це не про гроші, а про страх переплатити","angle":"контр-теза","rubric":"порада","quote":"просять знижку через страх"},' +
    '{"idea":"Чому знижка - це не про гроші, а про страх переплатити","angle":"дубль"},' +
    '{"idea":"Фото до роботи знімає половину суперечок","rubric":"вигадана рубрика"},{"idea":"коротко"},' +
    '{"idea":"Третя думка, яка точно стане постом"},{"idea":"Четверта думка понад ліміт трьох ідей"}]}\n```';
  const out = parseChatIdeas(raw, ["Порада", "Кейс"]);
  assert.equal(out.length, 3);
  assert.equal(out[0].rubric, "Порада");
  assert.equal(out[1].rubric, "");
  assert.ok(out.every((x) => x.idea.length >= 12));
  assert.deepEqual(parseChatIdeas('[{"idea":"Масив без обгортки теж розбирається"}]').map((x) => x.idea), ["Масив без обгортки теж розбирається"]);
  assert.deepEqual(parseChatIdeas('{"ideas":[]}'), []);
  assert.deepEqual(parseChatIdeas("модель відповіла прозою"), []);
});
