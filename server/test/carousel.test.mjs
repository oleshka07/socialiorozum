// 🖼 Карусель: розбір сценарію, текст на кадрі й розкладка.
//
// Що тут стережемо: (1) «Слайд N:» у будь-якому вбранні (жирне, решітки, англійською) розбирається,
// а підпис під каруселлю не підхоплює сценарій; (2) текст на кадрі ніколи не вилазить за край - ні
// вшир (одне довге слово), ні ввись (простирадло), а коли не влазить навіть на мінімальних шрифтах,
// ріжеться з «…» і позначається; (3) на кадр не потрапляють емодзі, які librsvg малює квадратами.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSlides, slideTitleBody, layoutSlide, stripMarkup } from "../dist/carousel.js";
import { textPx } from "../dist/images.js";

test("сценарій: мітки «Слайд N» у будь-якому вбранні, багаторядкові слайди, явний підпис", () => {
  const p = parseSlides([
    "Вступ, який не має стати слайдом",
    "**Слайд 1:** 5 помилок у будні",
    "### Слайд 2) Будні - це 70% ночей",
    "Slide 3 - Помилка перша",
    "Однакова ціна на будні й вихідні.",
    "Слайд 4. Збережи 🔖",
    "Підпис: Коротко про головне. Зберігай!",
  ].join("\n"));
  assert.deepEqual(p.slides, ["5 помилок у будні", "Будні - це 70% ночей", "Помилка перша\nОднакова ціна на будні й вихідні.", "Збережи 🔖"]);
  assert.equal(p.caption, "Коротко про головне. Зберігай!");
  assert.equal(p.marked, true);
});

test("підпис: без «Підпис:» - вступ; без вступу - обіцянка й заклик, але НЕ весь сценарій", () => {
  const withIntro = parseSlides("Про будні в глемпінгу.\nСлайд 1: А\nСлайд 2: Б");
  assert.equal(withIntro.caption, "Про будні в глемпінгу.");
  const bare = parseSlides("Слайд 1: **Обіцянка**\nСлайд 2: Середина\nСлайд 3: Збережи");
  assert.equal(bare.caption, "Обіцянка\n\nЗбережи");
  assert.doesNotMatch(bare.caption, /Середина/);
});

test("без міток - розділювач ---; звичайний текст каруселлю не вважається", () => {
  assert.deepEqual(parseSlides("Перший\n---\nДругий\n\n---\nТретій").slides, ["Перший", "Другий", "Третій"]);
  const plain = parseSlides("Просто пост.\n\nДругий абзац.");
  assert.deepEqual(plain.slides, []);
  assert.equal(plain.caption, "");
});

test("текст на кадрі: заголовок і тіло, акцент із **жирного**, без емодзі", () => {
  assert.deepEqual(slideTitleBody("Помилка №1\nОднакова ціна."), { title: "Помилка №1", body: "Однакова ціна." });
  assert.deepEqual(slideTitleBody("Коротко й крупно"), { title: "Коротко й крупно", body: "" });
  const long = slideTitleBody("Будні - це 70% ночей у році. Якщо вони порожні, бізнес живе лише вихідними, а це лише третина можливого заробітку.");
  assert.equal(long.title, "Будні - це 70% ночей у році.");
  assert.match(long.body, /^Якщо вони порожні/);
  assert.equal(slideTitleBody("Збережи 🔖✨").title, "Збережи");
  assert.equal(slideTitleBody("Це **глемпінг** у будні").title, "Це *глемпінг* у будні");
  assert.equal(stripMarkup("Це **важливо**"), "Це важливо");
});

test("розкладка: ні рядок, ні блок не виходять за межі кадру", () => {
  const W = 1024, H = 1280;
  const cases = [
    ["Коротко", ""],
    ["НАЙВІДПОВІДАЛЬНІШИЙ ПЕРЕДНОВОРІЧНИЙ ЗАГОЛОВОК", "Тіло"],
    ["Заголовок", "Дуже довге тіло слайда ".repeat(40)],
    ["Суперкаліфраджилістикекспіалідоціозність".repeat(2), ""],
  ];
  for (const [title, body] of cases) {
    for (const cover of [true, false]) {
      const L = layoutSlide(W, H, title, body, cover);
      for (const ln of L.titleLines) assert.ok(textPx(ln.map((w) => w.t).join(" "), L.titleFs, false) <= L.box.w + 1, `заголовок ширший за кадр: ${title}`);
      for (const ln of L.bodyLines) assert.ok(textPx(ln.map((w) => w.t).join(" "), L.bodyFs, false) <= L.box.w + 1, "тіло ширше за кадр");
      assert.ok(L.blockH <= L.box.h, `блок вищий за кадр: ${L.blockH} > ${L.box.h}`);
    }
  }
});

test("розкладка: простирадло ріжеться з «…» і це видно викликачу", () => {
  const L = layoutSlide(1024, 1280, "Заголовок", "Слово ".repeat(900), false);
  assert.equal(L.truncated, true);
  const last = L.bodyLines[L.bodyLines.length - 1];
  assert.match(last[last.length - 1].t, /…$/);
  assert.equal(layoutSlide(1024, 1280, "Заголовок", "Одне речення.", false).truncated, false);
});

test("розкладка: обкладинка крупніша за звичайний слайд", () => {
  assert.ok(layoutSlide(1024, 1280, "Обіцянка", "", true).titleFs > layoutSlide(1024, 1280, "Обіцянка", "Тіло", false).titleFs);
});

test("сторіс: «Кадр N» розбирається, текст - у безпечній зоні 9:16 (без верхніх 16% і нижніх 22%)", () => {
  const p = parseSlides("Кадр 1: Ранок у глемпінгу\nКадр 2: Кава на терасі\n**Кадр 3:** Пиши в Direct");
  assert.deepEqual(p.slides, ["Ранок у глемпінгу", "Кава на терасі", "Пиши в Direct"]);
  const W = 1080, H = 1920;
  const L = layoutSlide(W, H, "Заголовок сторіс", "Тіло кадру ".repeat(90), false, true);
  assert.ok(L.box.y >= Math.round(H * 0.16) && L.box.y + L.box.h <= Math.round(H * 0.78), "поле тексту не заходить під смужки згори й поле відповіді знизу");
  assert.ok(L.blockH <= L.box.h, "текст влазить у безпечну зону");
  const feed = layoutSlide(W, H, "Заголовок", "", false);
  assert.ok(feed.box.h > L.box.h, "у звичайного кадру поле більше, ніж у сторіс");
});
