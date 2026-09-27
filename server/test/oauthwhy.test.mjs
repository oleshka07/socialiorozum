// Причина збою підключення мережі.
//
// Спіймано на живому тестері: Threads тричі поспіль відповів «This action requires the
// threads_basic permission... your user must be in the list of Threads testers», а кабінет
// показав лише «Не вдалося підключити Threads». Тексти нижче - дослівні відповіді мереж.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oauthWhy, oauthFailQuery } from "../dist/oauthwhy.js";

test("акаунт не в тестувальниках - дослівна відповідь Threads з журналу беті", () => {
  const live = "This action requires the threads_basic permission. You must submit for app review, or your user must be in the list of Threads testers.";
  assert.equal(oauthWhy(live), "tester");
  // та сама причина, навіть якщо мережа прислала її як відмову в адресі колбека
  assert.equal(oauthWhy(live, "provider"), "tester");
});

test("інші формулювання того самого бар'єра в Meta та Instagram", () => {
  assert.equal(oauthWhy("Insufficient developer role"), "tester");
  assert.equal(oauthWhy("App not active: This app is not currently accessible and the app developer is aware of the issue."), "tester");
});

test("адресу повернення не додано в застосунку - дослівні тексти вікна Meta (англ. і укр.)", () => {
  // 28.09: бета переїхала на нову адресу; Meta повернула це в колбек як error_message, а кабінет
  // сказав «скасовано, натисни «Дозволити»» - і людина шукала власну помилку
  const en = "URL Blocked: This redirect failed because the redirect URI is not whitelisted in the app’s Client OAuth Settings. Make sure Client and Web OAuth Login are on and add all your app domains as Valid OAuth Redirect URIs.";
  const uk = "URL-адресу заблоковано: Це перенаправлення не вдалося, тому що ідентифікатор URI перенаправлення не входить до списку дозволених в налаштуваннях клієнта OAuth додатка. Переконайтеся, що ввімкнено вхід в OAuth за допомогою клієнта та через інтернет, і додайте всі домени додатка як дійсні URI для перенаправлення OAuth.";
  for (const stage of ["provider", "exchange"]) {
    assert.equal(oauthWhy(en, stage), "redirect");
    assert.equal(oauthWhy(uk, stage), "redirect");
  }
  assert.equal(oauthWhy("Can't Load URL: The domain of this URL isn't included in the app's domains.", "provider"), "redirect");
  assert.equal(oauthWhy("Invalid redirect_uri", "provider"), "redirect");
  assert.equal(oauthWhy("URL-адрес заблокирован: не удалось выполнить перенаправление, так как URI перенаправления не внесен в список разрешенных", "provider"), "redirect");
  // «заблоковано» без адреси повернення - не про налаштування застосунку
  assert.notEqual(oauthWhy("Ваш акаунт тимчасово заблоковано", "provider"), "redirect");
});

test("протухлий або вже використаний код - просто спробувати ще раз", () => {
  assert.equal(oauthWhy("This authorization code has expired."), "retry");
  assert.equal(oauthWhy("This authorization code has been used."), "retry");
});

test("скасування у вікні мережі і колбек без коду - це відмова людини, а не поломка", () => {
  assert.equal(oauthWhy("Permissions error", "provider"), "denied");
  assert.equal(oauthWhy("access_denied", "provider"), "denied");
  assert.equal(oauthWhy("", "provider"), "denied");
});

test("незнайома помилка обміну - «other»; «denied» у тексті ОБМІНУ не робить її відмовою людини", () => {
  assert.equal(oauthWhy("Threads HTTP 500"), "other");
  // людина вже натиснула «Дозволити» - слово «denied» тут про токен, а не про її вибір
  assert.equal(oauthWhy("Access denied for this token type"), "other");
});

test("в адресу їде ЛИШЕ код: текст мережі в кабінеті був би дверима для чужого тексту в нашому вікні", () => {
  assert.equal(oauthFailQuery("tester"), "&why=tester");
  assert.equal(oauthFailQuery("other"), "&why=other");
  const codes = new Set(["redirect", "tester", "denied", "session", "retry", "other"]);
  for (const raw of ["", "x", "<script>alert(1)</script>", "Your account is blocked, call +1 555", "a&b=c".repeat(40)])
    for (const stage of ["provider", "exchange"]) {
      const q = oauthFailQuery(oauthWhy(raw, stage));
      assert.ok(codes.has(q.slice("&why=".length)), q);
    }
});
