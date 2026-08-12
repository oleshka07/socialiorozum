// Ключі з адмінки + розбір живого прайса kie.ai.
//
// Дві речі, які тут стережуться, бо зіпсувати їх легко й непомітно:
//  1) У відповідь адмінки НІКОЛИ не має потрапити значення ключа. Помилку «додам value, щоб
//     показати в полі» неможливо помітити оком у зібраному JSON, а коштує вона витоку секрету.
//  2) Ціна з прайса має бути ЧЕСНОЮ. Якщо запис без usdPrice, її треба порахувати з кредитів;
//     мовчазний нуль замість ціни - гірше за відсутність цифри, бо на нього ухвалять рішення.
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusRow } from "../dist/secrets.js";
import { normalizeRecord, modelIdFromAnchor, USD_PER_CREDIT } from "../dist/kie.js";

const DEF = { name: "OPENAI_API_KEY", label: "OpenAI", hint: "тексти", group: "text" };
const SECRET = "sk-proj-VerySecretValue-9xQz";

test("значення ключа не витікає у відповідь адмінки", () => {
  const row = statusRow(DEF, SECRET, "");
  const json = JSON.stringify(row);
  assert.ok(!json.includes(SECRET), "у відповіді лежить сам ключ: " + json);
  assert.ok(!json.includes(SECRET.slice(0, 10)), "у відповіді лежить початок ключа");
  assert.equal(row.tail, "9xQz", "для впізнавання лишаємо рівно 4 останні символи");
});

test("адмінка перекриває .env, а зняття ключа повертає .env", () => {
  assert.equal(statusRow(DEF, SECRET, "env-value-1234").source, "admin");
  assert.equal(statusRow(DEF, "", "env-value-1234").source, "env", "прибрали з адмінки - працює .env");
  assert.equal(statusRow(DEF, "", "").source, "none");
  assert.equal(statusRow(DEF, "", "").set, false);
  assert.equal(statusRow(DEF, SECRET, "").set, true);
});

test("надто короткий ключ не показує навіть хвоста", () => {
  // інакше на 3-символьному значенні «хвіст» = весь ключ
  assert.equal(statusRow(DEF, "abc", "").tail, "");
});

test("id моделі дістається з посилання прайса", () => {
  assert.equal(modelIdFromAnchor("/pricing?model=qwen3%2Fpro-image-to-image"), "qwen3/pro-image-to-image");
  assert.equal(modelIdFromAnchor("/pricing?x=1&model=google/veo3-fast"), "google/veo3-fast");
  assert.equal(modelIdFromAnchor("/pricing"), "");
  assert.equal(modelIdFromAnchor(""), "");
});

test("ціна рахується з кредитів, коли usdPrice не прийшов", () => {
  const m = normalizeRecord({ interfaceType: "video", creditPrice: 40, anchor: "?model=a/b", creditUnit: "per video" });
  assert.equal(m.usd, 40 * USD_PER_CREDIT);
  assert.equal(m.category, "video");
});

test("явний usdPrice виграє над розрахунком", () => {
  const m = normalizeRecord({ interfaceType: "image", creditPrice: 40, usdPrice: 0.12, anchor: "?model=a/b" });
  assert.equal(m.usd, 0.12);
});

test("непридатні записи відкидаються, а не перетворюються на нульову ціну", () => {
  assert.equal(normalizeRecord({ interfaceType: "chat", creditPrice: 5, anchor: "?model=a/b" }), null, "chat-моделі не наші");
  assert.equal(normalizeRecord({ interfaceType: "video", creditPrice: "хтозна", anchor: "?model=a/b" }), null);
  assert.equal(normalizeRecord({ interfaceType: "video", creditPrice: 10, anchor: "без моделі" }), null);
});

test("music мапиться в audio (інтерфейс kie і наша категорія звуться по-різному)", () => {
  assert.equal(normalizeRecord({ interfaceType: "music", creditPrice: 10, anchor: "?model=suno/v5" }).category, "audio");
});
