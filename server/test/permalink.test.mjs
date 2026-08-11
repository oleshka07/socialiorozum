// Складання посилань на опубліковані пости. Перевіряти це на живому пості дорого (треба реально
// щось опублікувати), а зіпсувати тихо - легко: забути зрізати префікс -100 у chat_id, віддати
// «https://t.me//123» на порожньому username, зібрати лінк із неповних даних.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tgLink, fbLink, liLink, cabinetPostLink, cabinetMaterialLink } from "../dist/permalink.js";

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

test("cabinetPostLink: deep-link у кабінет на конкретний пост", () => {
  assert.equal(cabinetPostLink("https://beta.socialio.rozum.one", "abc-123"),
    "https://beta.socialio.rozum.one/app#/post/abc-123");
  assert.equal(cabinetPostLink("https://x.ua/", "abc"), "https://x.ua/app#/post/abc", "зайвий слеш зрізається");
  assert.equal(cabinetPostLink("", "abc"), "", "без базового URL лінка нема");
  assert.equal(cabinetPostLink("https://x.ua", ""), "", "без id лінка нема");
});

test("cabinetMaterialLink: deep-link у стрічку Джерел на конкретний матеріал", () => {
  // кнопка «🌐 Перейти» під записом щоденника в боті веде саме сюди
  assert.equal(cabinetMaterialLink("https://beta.socialio.rozum.one", "src-1"),
    "https://beta.socialio.rozum.one/app#/material/src-1");
  assert.equal(cabinetMaterialLink("https://x.ua/", "src-1"), "https://x.ua/app#/material/src-1", "зайвий слеш зрізається");
  assert.equal(cabinetMaterialLink("", "src-1"), "", "без базового URL лінка нема");
  assert.equal(cabinetMaterialLink("https://x.ua", ""), "", "без id лінка нема");
});
