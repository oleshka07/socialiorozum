// Складання посилань на опубліковані пости. Перевіряти це на живому пості дорого (треба реально
// щось опублікувати), а зіпсувати тихо - легко: забути зрізати префікс -100 у chat_id, віддати
// «https://t.me//123» на порожньому username, зібрати лінк із неповних даних.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tgLink, fbLink, liLink } from "../dist/permalink.js";

test("tgLink: публічний канал за username", () => {
  assert.equal(tgLink("-1001234567890", 42, "mychannel"), "https://t.me/mychannel/42");
  assert.equal(tgLink("-1001234567890", 42, "@mychannel"), "https://t.me/mychannel/42", "@ у username зрізається");
  assert.equal(tgLink("@mychannel", 42), "https://t.me/mychannel/42", "username може лежати в chat_id");
});

test("tgLink: приватний канал - t.me/c/<internal> без префікса -100", () => {
  assert.equal(tgLink("-1001234567890", 42), "https://t.me/c/1234567890/42");
  assert.equal(tgLink("-1001234567890", 42, ""), "https://t.me/c/1234567890/42", "порожній username = приватний лінк");
});

test("tgLink: без посилання там, де його не існує", () => {
  assert.equal(tgLink("-1001234567890", null), "", "нема message_id");
  assert.equal(tgLink("", 42), "", "нема chat_id");
  assert.equal(tgLink("123456789", 42), "", "особистий чат/звичайна група публічного лінка не має");
  assert.equal(tgLink("-1001234567890", "не-число"), "", "message_id мусить бути числом");
});

test("fbLink: id поста вже містить id сторінки", () => {
  assert.equal(fbLink("123456_789012"), "https://www.facebook.com/123456_789012");
  assert.equal(fbLink(null), "");
  assert.equal(fbLink(""), "");
});

test("liLink: URN → посилання на апдейт", () => {
  assert.equal(liLink("urn:li:share:7123456789"), "https://www.linkedin.com/feed/update/urn:li:share:7123456789/");
  assert.equal(liLink("urn:li:ugcPost:7123456789"), "https://www.linkedin.com/feed/update/urn:li:ugcPost:7123456789/");
  assert.equal(liLink("7123456789"), "", "без префікса urn:li: це не URN");
  assert.equal(liLink(null), "");
});
