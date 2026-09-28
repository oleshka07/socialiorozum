// 💬 Коментарі в одному місці: чисте правило, які коментарі показувати. Тут легко тихо помилитись -
// показати власну відповідь бренду як «новий коментар», повторити вже оброблений чи той, під яким
// бренд уже відповів у самій мережі (тоді людина відповіла б удруге).
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepComment, isInboxNet } from "../dist/inbox.js";

const own = new Set(["olegalisio", "rozum.one"]);
const done = new Set(["instagram:c9"]);

test("keepComment: коментар людини без відповіді - показуємо", () => {
  assert.equal(keepComment({ net: "instagram", id: "c1", author: "fan1", replyAuthors: [] }, own, done), true);
  assert.equal(keepComment({ net: "instagram", id: "c2", author: "fan2", replyAuthors: ["fan3"] }, own, done), true, "відповіла інша людина - бренд ще ні");
});

test("keepComment: свій (будь-який акаунт бренду), оброблений з Holos, уже з відповіддю бренду - ні", () => {
  assert.equal(keepComment({ net: "instagram", id: "c3", author: "@Rozum.One", replyAuthors: [] }, own, done), false, "свій - без @ і регістру");
  assert.equal(keepComment({ net: "instagram", id: "c9", author: "fan", replyAuthors: [] }, own, done), false, "відповіли чи пропустили з Holos");
  assert.equal(keepComment({ net: "threads", id: "c9", author: "fan", replyAuthors: [] }, own, done), true, "той самий id в іншій мережі - інший коментар");
  assert.equal(keepComment({ net: "instagram", id: "c4", author: "fan", replyAuthors: ["olegalisio"] }, own, done), false, "бренд уже відповів у самій мережі");
  assert.equal(keepComment({ net: "instagram", id: "", author: "fan", replyAuthors: [] }, own, done), false, "без id - нема на що відповідати");
});

test("keepComment: Facebook - свої за id Сторінки бренду", () => {
  const pages = new Set(["111", "222"]);
  assert.equal(keepComment({ net: "facebook", id: "p_1", author: "999", replyAuthors: [] }, pages, new Set()), true);
  assert.equal(keepComment({ net: "facebook", id: "p_2", author: "222", replyAuthors: [] }, pages, new Set()), false, "коментар Сторінки компанії - свій");
  assert.equal(keepComment({ net: "facebook", id: "p_3", author: "", replyAuthors: ["111"] }, pages, new Set()), false, "автор невідомий (Meta не віддала), але Сторінка вже відповіла");
  assert.equal(keepComment({ net: "facebook", id: "p_4", author: "", replyAuthors: [] }, pages, new Set()), true, "автор невідомий - показуємо як «Читач»");
});

test("isInboxNet: лише мережі, де є коментарі", () => {
  assert.ok(isInboxNet("instagram") && isInboxNet("facebook") && isInboxNet("threads"));
  assert.ok(!isInboxNet("telegram") && !isInboxNet("linkedin") && !isInboxNet(""));
});
