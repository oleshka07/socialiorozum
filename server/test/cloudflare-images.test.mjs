// ☁️ Cloudflare Workers AI як безкоштовний провайдер зображень.
//
// Що тут стережемо: (1) розміри для FLUX.2 [klein] - кратні 16 (вимога моделі) і не більші за 2×2
// плитки 512, бо від плиток залежить, чи вистачить безкоштовного ліміту на ~100 кадрів на день;
// (2) коли йти на запасну модель, а коли ні - ліміт і ключ спільні, запасна там нічого не врятує;
// (3) людські тексти: «денний ліміт» - це «зачекай до завтра», а не «поповни рахунок».
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CF_KLEIN_SIZE, cfShouldFallback, cfImageB64, sniffImageMime, humanImageError, imageCosts,
} from "../dist/images.js";

test("klein: кожен формат кратний 16, пропорція правильна і не більше 4 плиток 512×512", () => {
  const want = { "1:1": 1, "4:5": 0.8, "16:9": 16 / 9 };
  for (const [aspect, { w, h }] of Object.entries(CF_KLEIN_SIZE)) {
    assert.equal(w % 16, 0, `${aspect}: ширина не кратна 16`);
    assert.equal(h % 16, 0, `${aspect}: висота не кратна 16`);
    assert.ok(Math.abs(w / h - want[aspect]) < 0.01, `${aspect}: пропорція ${w}x${h}`);
    assert.ok(Math.ceil(w / 512) * Math.ceil(h / 512) <= 4, `${aspect}: ${w}x${h} - більше 4 плиток, безкоштовних кадрів стане менше`);
    assert.ok(w >= 256 && h >= 256 && w <= 1920 && h <= 1920, `${aspect}: поза межами моделі 256-1920`);
  }
});

test("запасна модель: так - на збій моделі, ні - на ліміт, ключ чи акаунт", () => {
  assert.equal(cfShouldFallback(400, '{"errors":[{"code":5007,"message":"No such model"}]}'), true);
  assert.equal(cfShouldFallback(500, "Internal"), true);
  assert.equal(cfShouldFallback(504, "Cloudflare не відповів за 90 секунд"), true);
  // ліміт у моделей спільний - запасна витратила б ще один запит на ту саму відмову
  assert.equal(cfShouldFallback(429, '{"errors":[{"code":4006,"message":"AiError: you have used up your daily free allocation of 10,000 neurons"}]}'), false);
  assert.equal(cfShouldFallback(401, '{"errors":[{"code":10000,"message":"Authentication error"}]}'), false);
  assert.equal(cfShouldFallback(403, "forbidden"), false);
  assert.equal(cfShouldFallback(400, '{"errors":[{"code":7003,"message":"Could not route to /client/v4/accounts/x/ai/run, perhaps your object identifier is invalid?"}]}'), false);
});

test("людські помилки Cloudflare: ліміт - «зачекай», акаунт, токен", () => {
  const quota = humanImageError("cloudflare", 429, '{"errors":[{"code":4006,"message":"AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade"}]}');
  assert.match(quota, /денний ліміт/);
  assert.match(quota, /00:00 UTC/);
  assert.doesNotMatch(quota, /Поповни/, "на Free-плані платити нема куди - «поповни» тут неправда");
  assert.match(humanImageError("cloudflare", 400, '{"errors":[{"code":7003,"message":"Could not route to /client/v4/accounts/bad/ai/run"}]}'), /Account ID/);
  assert.match(humanImageError("cloudflare", 401, '{"errors":[{"code":10000,"message":"Authentication error"}]}'), /Workers AI \(Read і Edit\)/);
  // невідоме - сирим, як і в інших провайдерів
  assert.match(humanImageError("cloudflare", 418, "teapot"), /418: teapot/);
});

test("відповідь Workers AI: зображення з конверта result, порожнє - не зображення", () => {
  const b64 = "A".repeat(200);
  assert.equal(cfImageB64({ result: { image: b64 }, success: true, errors: [] }), b64);
  assert.equal(cfImageB64({ image: b64 }), b64);
  assert.equal(cfImageB64({ result: { image: "" }, success: true }), null);
  assert.equal(cfImageB64({ result: null, success: false, errors: [{ code: 4006 }] }), null);
  assert.equal(cfImageB64(null), null);
});

test("тип файлу за байтами, а не за обіцянкою відповіді", () => {
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "image/png");
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
});

test("у прайсі Cloudflare безкоштовний і стоїть першим", () => {
  const c = imageCosts();
  const cf = c.find((x) => x.id === "cloudflare");
  assert.ok(cf, "Cloudflare має бути в прайсі");
  assert.equal(cf.usd, 0);
  assert.equal(c[0].id, "cloudflare", "прайс відсортований від дешевшого");
  assert.match(cf.note, /100/);
});
