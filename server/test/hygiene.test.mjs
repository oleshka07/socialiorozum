// «Серйозне» з аудиту готовності: кожен тест - відтворення конкретної знахідки, яка дійшла б до
// користувача сирою (текст помилки, «[object Object]» у плані, порожні мітки в промпті, сміття в медіатеці).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBriefText, parseThemes } from "../dist/pipeline.js";
import { sniffKind } from "../dist/media.js";
import { humanTgError } from "../dist/telegram.js";
import { humanNetError } from "../dist/openrouter.js";

test("бриф без порожніх міток і без вигаданих пропорцій", () => {
  const t = renderBriefText({ positioning: "супровід, а не будівництво", icp: { audience: "", pains: [], desires: [] }, offers_and_ctas: {} });
  assert.equal(t, "Позиціювання: супровід, а не будівництво");
  assert.ok(!/Аудиторія: ;|80\/20|Hero-Hub/.test(t), "порожні мітки й дефолт 80/20 не мають потрапляти в «джерело правди»");
});
test("бриф із частково заповненими полями лишає лише заповнені", () => {
  const t = renderBriefText({ icp: { audience: "власники житла", pains: ["не знаю кому довіряти"], desires: [] }, value_promotion_ratio: "70/30" });
  assert.equal(t, "Аудиторія: власники житла; болі: не знаю кому довіряти\nЦінність:промо: 70/30");
});
test("теми плану: обʼєкти без theme не стають «[object Object]»", () => {
  assert.deepEqual(parseThemes('[{"rubric":"Кейси","text":"Чому підрядники зникають"},{"foo":1},"Три помилки в кошторисі",{"title":"Заголовок"}]'),
    ["Чому підрядники зникають", "", "Три помилки в кошторисі", "Заголовок"]);
  assert.deepEqual(parseThemes("проза без масиву"), []);
});
test("тип файлу за вмістом, а не за заявленим mime", () => {
  assert.equal(sniffKind(Buffer.from("<html><script>alert(1)</script></html>")), null, "HTML не є зображенням");
  assert.deepEqual(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), { kind: "image", mime: "image/jpeg" });
  assert.deepEqual(sniffKind(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")), { kind: "image", mime: "image/png" });
  assert.deepEqual(sniffKind(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), { kind: "image", mime: "image/webp" });
  assert.deepEqual(sniffKind(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(8)])), { kind: "video", mime: "video/mp4" });
  assert.deepEqual(sniffKind(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(8)])), { kind: "image", mime: "image/heic" });
  assert.deepEqual(sniffKind(Buffer.concat([Buffer.from("1a45dfa3a3428286", "hex"), Buffer.alloc(8)])), { kind: "video", mime: "video/webm" });
  assert.equal(sniffKind(Buffer.from("MZ")), null, "занадто короткий/бінарник");
});
test("помилки Telegram - людською, з дією", () => {
  assert.match(humanTgError(403, "Forbidden: bot was kicked from the channel chat"), /додай його адміном/);
  assert.match(humanTgError(400, "Bad Request: not enough rights to send text messages to the chat"), /право «Публікувати/);
  assert.match(humanTgError(400, "Bad Request: chat not found"), /Канал не знайдено/);
  assert.match(humanTgError(401, "Unauthorized"), /Токен бота недійсний/);
  assert.match(humanTgError(403, ""), /403/);
  assert.equal(humanTgError(500, ""), "Telegram HTTP 500");
});
test("мережева помилка до моделі - «тимчасово недоступна», а не «fetch failed»", () => {
  assert.match(humanNetError("OpenAI", new TypeError("fetch failed")), /тимчасово недоступна/);
  assert.match(humanNetError("OpenRouter", Object.assign(new Error("x"), { name: "AbortError" })), /не відповіла за 60 секунд/);
  assert.match(humanNetError("OpenAI", Object.assign(new Error("connect"), { cause: { code: "ECONNREFUSED" } })), /нема звʼязку/);
});
