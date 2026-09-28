// 👥 Кілька акаунтів однієї мережі в бренді: чисті помічники вибору акаунта. Тут легко тихо помилитись -
// прийняти «@rozum» за іншу Сторінку, порахувати особистий і компанії одним «акаунтом» у запобіжнику
// від дублів або не впізнати обраний акаунт у channels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAccount, postAccount, netKey, isMultiNet } from "../dist/accounts.js";

const FB = [{ id: "111", name: "Oleg Stepeniev", main: true }, { id: "222", name: "Rozum.one", main: false }];
const TH = [{ id: "901", name: "@olegalisio", main: true }, { id: "902", name: "@rozum.one", main: false }];

test("matchAccount: id, @нік, назва Сторінки без регістру", () => {
  assert.equal(matchAccount(FB, "222")?.name, "Rozum.one");
  assert.equal(matchAccount(FB, "rozum.one")?.id, "222");
  assert.equal(matchAccount(TH, "@Rozum.One")?.id, "902");
  assert.equal(matchAccount(TH, "rozum.one")?.id, "902");
  assert.equal(matchAccount(FB, "Oleg")?.id, "111", "частина назви - теж (модель рідко пише назву Сторінки дослівно)");
  assert.equal(matchAccount(TH, "@nobody"), null);
  assert.equal(matchAccount(TH, ""), null);
  assert.equal(matchAccount(TH, "  @  "), null);
});

test("postAccount: обраний акаунт мережі або null (основний)", () => {
  assert.equal(postAccount({ threads: { on: true, account: "902" } }, "threads"), "902");
  assert.equal(postAccount({ threads: { on: true } }, "threads"), null);
  assert.equal(postAccount({ threads: { on: true, account: "  " } }, "threads"), null);
  assert.equal(postAccount(null, "threads"), null);
  assert.equal(postAccount({ threads: { account: 5 } }, "threads"), null, "не рядок - не акаунт");
});

test("netKey: у мережах з кількома акаунтами «та сама мережа» = та сама мережа І той самий акаунт", () => {
  const mains = { facebook: "111", instagram: "igu", threads: "901" };
  assert.equal(netKey("facebook", null, mains), "facebook|111", "без вибору - основний");
  assert.notEqual(netKey("facebook", "222", mains), netKey("facebook", null, mains), "компанія ≠ особиста");
  assert.equal(netKey("facebook", "111", mains), netKey("facebook", null, mains), "явно обраний основний = без вибору");
  assert.equal(netKey("telegram", "x", mains), "telegram", "мережі з одним акаунтом - як і було");
  assert.ok(isMultiNet("threads") && !isMultiNet("linkedin"));
});
