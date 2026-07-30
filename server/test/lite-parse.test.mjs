// Розбір відповіді Lite-генерації + вибір головної моделі.
//
// Чому саме це під тестом: `parseLitePosts` - те вузьке місце, де пости губляться МОВЧКИ. Модель
// відповіла прозою, обгорнула JSON у markdown-огорожу, назвала поле `content` замість `text`,
// вигадала свій `intent` - у всіх цих випадках раніше просто виходило «Не вдалося згенерувати пости»
// або пост із порожнім наміром, і зрозуміти, ЧОМУ, можна було лише руками. Тепер той самий парсер
// працює і в бойовій генерації, і в порівнянні моделей - тож його поведінка стала ще важливішою:
// якщо він не тримає формат якоїсь моделі, вона несправедливо виглядатиме «гіршою».
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLitePosts, mainModel, DEFAULT_MAIN_MODEL } from "../dist/pipeline.js";

test("чистий JSON-масив обʼєктів розбирається повністю", () => {
  const out = JSON.stringify([
    { text: "Перший пост", image_prompt: "фото раз", rubric: "Кейси", intent: "sale" },
    { text: "Другий пост", image_prompt: "", rubric: "", intent: "nurture" },
  ]);
  const r = parseLitePosts(out);
  assert.equal(r.length, 2);
  assert.equal(r[0].text, "Перший пост");
  assert.equal(r[0].image_prompt, "фото раз");
  assert.equal(r[0].rubric, "Кейси");
  assert.equal(r[0].intent, "sale");
  assert.equal(r[1].intent, "nurture");
});

test("markdown-огорожа й текст довкола не ламають розбір", () => {
  const out = 'Ось результат:\n```json\n[{"text":"Пост у огорожі"}]\n```\nГотово!';
  const r = parseLitePosts(out);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, "Пост у огорожі");
});

test("альтернативні назви поля тексту (content/post) приймаються", () => {
  // моделі регулярно віддають `content` або `post` замість `text` - це не причина втрачати пост
  const r = parseLitePosts(JSON.stringify([{ content: "через content" }, { post: "через post" }]));
  assert.deepEqual(r.map((p) => p.text), ["через content", "через post"]);
});

test("масив рядків (без обʼєктів) теж приймається", () => {
  const r = parseLitePosts(JSON.stringify(["просто текст поста"]));
  assert.equal(r.length, 1);
  assert.equal(r[0].text, "просто текст поста");
  assert.equal(r[0].intent, "awareness", "намір за замовчуванням");
});

test("невідомий intent падає в awareness, а не протікає в БД", () => {
  const r = parseLitePosts(JSON.stringify([{ text: "х", intent: "виїбони" }, { text: "у", intent: "SALE" }]));
  assert.equal(r[0].intent, "awareness");
  assert.equal(r[1].intent, "sale", "регістр не має значення");
});

test("порожні й пробільні пости відсікаються, рубрика обрізається до 60", () => {
  const r = parseLitePosts(JSON.stringify([
    { text: "   " }, { text: "" }, { text: " справжній ", rubric: "р".repeat(90) },
  ]));
  assert.equal(r.length, 1);
  assert.equal(r[0].text, "справжній", "текст тримується");
  assert.equal(r[0].rubric.length, 60);
});

test("проза замість JSON = порожній масив, а не викид", () => {
  // саме тут раніше вилітало сире «порожня відповідь моделі» без жодного натяку на причину
  assert.deepEqual(parseLitePosts("Вибач, мені потрібно більше контексту. Про що саме писати?"), []);
  assert.deepEqual(parseLitePosts(""), []);
  assert.deepEqual(parseLitePosts('{"text":"це обʼєкт, а не масив"}'), []);
});

test("битий JSON не валить генерацію", () => {
  assert.deepEqual(parseLitePosts('[{"text":"обрізано на півдорозі'), []);
});

test("mainModel: налаштування перебиває дефолт, порожнє - ні", () => {
  assert.equal(mainModel({}), DEFAULT_MAIN_MODEL);
  assert.equal(mainModel({ main_model: "" }), DEFAULT_MAIN_MODEL);
  assert.equal(mainModel({ main_model: "   " }), DEFAULT_MAIN_MODEL, "пробіли - це не вибір моделі");
  assert.equal(mainModel({ main_model: " anthropic/claude-x " }), "anthropic/claude-x");
});
