// 🎙 Розшифровка голосу: Deepgram + відкат на Whisper.
//
// Чому саме ці межі. Голосове в щоденник неможливо «надиктувати ще раз»: якщо розшифровка
// не вдалась, думка втрачена назавжди. Тому помилка в порядку спроб коштує не зручності, а
// матеріалу - і саме порядок тут покритий найщільніше.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sttOrder, audioMime, deepgramText, humanSttError } from "../dist/stt.js";

const BOTH = { deepgram: true, whisper: true };

test("auto: Deepgram перший, Whisper у запасі", () => {
  assert.deepEqual(sttOrder("auto", BOTH), ["deepgram", "whisper"]);
});

test("явний вибір НЕ скасовує відкат - інакше збій одного сервісу коштував би запису", () => {
  assert.deepEqual(sttOrder("deepgram", BOTH), ["deepgram", "whisper"]);
  assert.deepEqual(sttOrder("whisper", BOTH), ["whisper", "deepgram"]);
});

test("провайдер без ключа не потрапляє в чергу - на нього не витрачається спроба", () => {
  assert.deepEqual(sttOrder("auto", { deepgram: false, whisper: true }), ["whisper"]);
  assert.deepEqual(sttOrder("deepgram", { deepgram: false, whisper: true }), ["whisper"]);
  assert.deepEqual(sttOrder("whisper", { deepgram: true, whisper: false }), ["deepgram"]);
  assert.deepEqual(sttOrder("auto", { deepgram: false, whisper: false }), []);
});

test("audioMime: голосове Telegram - ogg; невідоме розширення не вигадуємо", () => {
  assert.equal(audioMime("voice.ogg"), "audio/ogg");
  assert.equal(audioMime("voice.OGG"), "audio/ogg");
  assert.equal(audioMime("note.m4a"), "audio/mp4");
  assert.equal(audioMime("rec.wav"), "audio/wav");
  assert.equal(audioMime("щось"), "audio/*");
  assert.equal(audioMime("file.xyz"), "audio/*");
});

test("deepgramText дістає текст і не падає на несподіваній формі", () => {
  const okJson = { results: { channels: [{ alternatives: [{ transcript: "  привіт світ  " }] }] } };
  assert.equal(deepgramText(okJson), "привіт світ");
  assert.equal(deepgramText({}), "");
  assert.equal(deepgramText({ results: { channels: [] } }), "");
  assert.equal(deepgramText(null), "");
  assert.equal(deepgramText({ results: { channels: [{ alternatives: [{}] }] } }), "");
});

test("humanSttError: людське речення замість статусу, і воно КАЖЕ, що робити", () => {
  assert.match(humanSttError("deepgram", 401, "x"), /Deepgram.*Ключі провайдерів|Deepgram.*ключ/i);
  assert.match(humanSttError("deepgram", 402, "x"), /кошти/);
  assert.match(humanSttError("whisper", 429, "x"), /Whisper.*ліміт/);
  assert.match(humanSttError("whisper", 503, "x"), /недоступний/);
  // невідомий статус - показуємо суть, але не портянку
  const long = humanSttError("deepgram", 418, "z".repeat(500));
  assert.ok(long.length < 200, long.length);
});
