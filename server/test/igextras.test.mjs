// 📸 Instagram: співавтори й alt-текст. Тихі помилки тут - «@Partner» чи посилання на профіль замість
// ніка (Instagram відбив би весь пост), четвертий співавтор, власний нік співавтором, або відмова
// через доповнення, яку сприйняли б як відмову самого поста.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normCollaborators, cleanAlt, igExtrasRejected, IG_MAX_COLLABORATORS, ALT_TEXT_MAX } from "../dist/igextras.js";

test("normCollaborators: @, регістр, посилання на профіль, розділювачі", () => {
  const r = normCollaborators("@Partner.Glamp, https://www.instagram.com/friend_1/ ; coffee.shop");
  assert.deepEqual(r.ok, ["partner.glamp", "friend_1", "coffee.shop"]);
  assert.deepEqual(r.bad, []);
  assert.deepEqual(normCollaborators(["@a", "a", "A"]).ok, ["a"], "дублі без урахування регістру");
});

test("normCollaborators: не більше 3, решта - у extra; сміття - у bad; свій нік - ні", () => {
  const r = normCollaborators(["one", "two", "three", "four", "bad nick!", "мій_нік"], "@Me");
  assert.equal(IG_MAX_COLLABORATORS, 3);
  assert.deepEqual(r.ok, ["one", "two", "three"]);
  assert.deepEqual(r.extra, ["four"]);
  assert.ok(r.bad.includes("bad") || r.bad.includes("bad nick!") || r.bad.includes("nick!"), JSON.stringify(r.bad));
  assert.ok(r.bad.includes("мій_нік"), "кирилиця в ніку Instagram неможлива");
  assert.deepEqual(normCollaborators(["me", "other"], "me").ok, ["other"], "власний акаунт співавтором бути не може");
  assert.deepEqual(normCollaborators(undefined).ok, []);
  assert.deepEqual(normCollaborators("").ok, []);
});

test("cleanAlt: пробіли й переноси зведені, межа довжини", () => {
  assert.equal(cleanAlt("  Намет  біля\n\nозера   на світанку "), "Намет біля озера на світанку");
  assert.equal(cleanAlt(null), "");
  assert.equal(cleanAlt("я".repeat(ALT_TEXT_MAX + 50)).length, ALT_TEXT_MAX);
});

test("igExtrasRejected: відмова через співавторів чи опис - повторити без них; інші - ні", () => {
  for (const m of [
    "(#100) Invalid parameter",
    "The user cannot be tagged as a collaborator",
    "Param alt_text must be at most 1000 chars",
    "Invalid collaborators",
  ]) assert.equal(igExtrasRejected(m), true, m);
  for (const m of [
    "Meta просить зачекати (забагато запитів) - спробуй за кілька хвилин.",
    "Доступ до Facebook/Instagram втрачено (Meta більше не приймає токен)",
    "Instagram довго обробляє зображення",
  ]) assert.equal(igExtrasRejected(m), false, m);
});
