// 👥 Кілька акаунтів однієї мережі в бренді: чисті помічники вибору акаунта. Тут легко тихо помилитись -
// прийняти «@rozum» за іншу Сторінку, порахувати особистий і компанії одним «акаунтом» у запобіжнику
// від дублів або не впізнати обраний акаунт у channels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAccount, postAccount, postAccounts, netKey, isMultiNet, isAccNet } from "../dist/accounts.js";

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
  assert.equal(netKey("linkedin", "x", mains), "linkedin", "мережі без вибору акаунта - як і було");
  assert.ok(isMultiNet("threads") && !isMultiNet("linkedin"));
});

test("postAccounts: галочки - кілька акаунтів мережі в одному пості (і давнє одиночне account)", () => {
  assert.deepEqual(postAccounts({ facebook: { on: true, accounts: ["111", "222"] } }, "facebook"), ["111", "222"]);
  assert.deepEqual(postAccounts({ facebook: { on: true, account: "222" } }, "facebook"), ["222"], "пост до галочок");
  assert.deepEqual(postAccounts({ facebook: { on: true, accounts: [], account: "222" } }, "facebook"), [], "масив головніший: порожній = за замовчуванням");
  assert.deepEqual(postAccounts({ telegram: { on: true, accounts: [" -1001 ", "-1001", "", null, "-1002"] } }, "telegram"), ["-1001", "-1002"], "без повторів і порожніх");
  assert.deepEqual(postAccounts({ threads: { on: true } }, "threads"), []);
  assert.deepEqual(postAccounts(null, "threads"), []);
  assert.equal(postAccounts({ threads: { accounts: Array.from({ length: 40 }, (_, i) => String(i)) } }, "threads").length, 20, "межа - щоб зіпсований пост не розсилав у сотню місць");
  assert.equal(postAccount({ facebook: { accounts: ["222", "111"] } }, "facebook"), "222", "перший обраний");
});

test("netKey і isAccNet: у Telegram «куди» - це канал (кілька каналів бренду)", () => {
  const mains = { facebook: "111", instagram: "igu", threads: "901", telegram: "-1001" };
  assert.ok(isAccNet("telegram") && !isAccNet("linkedin"));
  assert.equal(netKey("telegram", null, mains), "telegram|-1001", "без вибору - основний канал");
  assert.notEqual(netKey("telegram", "-1002", mains), netKey("telegram", null, mains), "інший канал - не дубль");
});
