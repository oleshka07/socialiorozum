// Самоналаштування тіла запиту під конкретну модель + стеля токенів.
//
// Реальна поломка, знайдена першим же прогоном порівняння моделей:
//  • новіші моделі OpenAI відкидають `max_tokens` (вимагають `max_completion_tokens`) і не приймають
//    фіксовану temperature - тобто перемкнутися на щось свіжіше за gpt-4o було неможливо В ПРИНЦИПІ,
//    запит падав з 400 ще до генерації;
//  • стеля 1200 токенів на ОДИН пост обрізала відповідь багатослівніших моделей, і це виглядало як
//    «модель не тримає наш JSON-контракт» - тобто інструмент порівняння обмовляв нормальні моделі.
// Список моделей у коді тримати не можна (застаріє за місяць), тож правило виводиться з самої
// помилки API. Ця логіка чиста й тестується без мережі.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixUnsupportedParam } from "../dist/openrouter.js";
import { liteMaxTokens } from "../dist/pipeline.js";

const err = (o) => JSON.stringify({ error: o });

test("max_tokens перейменовується на max_completion_tokens", () => {
  const body = { model: "m1", max_tokens: 2700, temperature: 0.7 };
  const fixed = fixUnsupportedParam("m1", body, err({
    message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter",
  }));
  assert.equal(fixed, true, "повтор має сенс");
  assert.equal(body.max_tokens, undefined, "старий параметр прибрано");
  assert.equal(body.max_completion_tokens, 2700, "значення збережено, а не загублено");
});

test("непідтримуваний параметр просто викидається (temperature у reasoning-моделей)", () => {
  const body = { model: "m2", temperature: 0.7, presence_penalty: 0.3, max_tokens: 100 };
  const fixed = fixUnsupportedParam("m2", body, err({
    message: "Unsupported value: 'temperature' does not support 0.7 with this model.",
    param: "temperature", code: "unsupported_value",
  }));
  assert.equal(fixed, true);
  assert.equal(body.temperature, undefined);
  assert.equal(body.presence_penalty, 0.3, "чіпаємо ЛИШЕ те, на що поскаржився API");
  assert.equal(body.max_tokens, 100);
});

test("чужі помилки не чіпаємо - інакше повтор ганяв би запити марно", () => {
  const body = { model: "m3", max_tokens: 100 };
  assert.equal(fixUnsupportedParam("m3", body, err({ message: "You exceeded your current quota", code: "insufficient_quota" })), false);
  assert.equal(fixUnsupportedParam("m3", body, err({ message: "Invalid API key", code: "invalid_api_key" })), false);
  assert.equal(fixUnsupportedParam("m3", body, "<html>502 Bad Gateway</html>"), false, "не-JSON відповідь");
  assert.deepEqual(body, { model: "m3", max_tokens: 100 }, "тіло лишилось недоторканим");
});

test("не зациклюємось: те саме виправлення вдруге вже не пропонується", () => {
  const body = { model: "m4", max_tokens: 500 };
  const payload = err({ message: "Use 'max_completion_tokens' instead.", param: "max_tokens", code: "unsupported_parameter" });
  assert.equal(fixUnsupportedParam("m4", body, payload), true);
  assert.equal(fixUnsupportedParam("m4", body, payload), false, "max_tokens уже нема - повторювати нічого");
});

test("параметра, якого в тілі немає, не «виправляємо»", () => {
  const body = { model: "m5", max_tokens: 500 };
  assert.equal(fixUnsupportedParam("m5", body, err({ message: "Unsupported parameter: 'top_k'", param: "top_k", code: "unsupported_parameter" })), false);
});

test("стеля токенів: одному посту вистачає з запасом, ліміт не зростає нескінченно", () => {
  // саме тут раніше було 1200 на один пост - рівно стільки й з'їдали обрізані відповіді
  assert.ok(liteMaxTokens(1) >= 2500, "на один пост тепер " + liteMaxTokens(1));
  assert.ok(liteMaxTokens(6) > liteMaxTokens(1), "росте з кількістю постів");
  assert.equal(liteMaxTokens(12), 8000, "але впирається у відому безпечну стелю");
  assert.equal(liteMaxTokens(100), 8000);
});
