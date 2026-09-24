// Помилка провайдера зображень - людською.
//
// Спіймано живцем 24.09: fal відповів 403 {"detail":"User is locked. Reason: TOP_UP."}, і в кабінеті
// людина побачила б цей JSON як є. Тексти відповідей нижче - дослівні або з документації провайдерів.
import { test } from "node:test";
import assert from "node:assert/strict";
import { humanImageError } from "../dist/images.js";

test("скінчились гроші в fal - дослівна відповідь з беті", () => {
  const t = humanImageError("fal", 403, '{"detail":"User is locked. Reason: TOP_UP."}');
  assert.match(t, /скінчились кошти/);
  assert.match(t, /FLUX/);
  assert.ok(!t.includes("{"), "сирий JSON не мусить доїхати до людини");
});

test("квота OpenAI і Gemini - теж про гроші, а не про ключ", () => {
  assert.match(humanImageError("openai", 429, '{"error":{"code":"insufficient_quota"}}'), /скінчились кошти/);
  assert.match(humanImageError("openai", 400, '{"error":{"code":"billing_hard_limit_reached"}}'), /скінчились кошти/);
  assert.match(humanImageError("gemini", 429, "Your prepayment credits are depleted"), /скінчились кошти/);
});

test("невірний ключ, перевантаження, збій сервера - кожне своєю порадою", () => {
  assert.match(humanImageError("openai", 401, '{"error":{"message":"Incorrect API key provided"}}'), /Ключі провайдерів/);
  assert.match(humanImageError("fal", 429, "rate limited"), /за хвилину/);
  assert.match(humanImageError("gemini", 503, "unavailable"), /тимчасово недоступний/);
  assert.match(humanImageError("openai", 400, '{"error":{"code":"moderation_blocked"}}'), /правилами безпеки/);
});

test("невідома помилка лишається сирою: вгадувати гірше, ніж показати", () => {
  assert.equal(humanImageError("fal", 422, "bad image_size"), "FLUX.1 schnell (fal.ai) 422: bad image_size");
});
