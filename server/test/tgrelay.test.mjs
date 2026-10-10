// 🤖 Свій бот людини (без перехоплення): що з її власних повідомлень береться до вечора, ключ без чату,
// розбір відповіді моделі на ідеї.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteText, noteKey, NOTE_MIN, NOTE_MAX } from "../dist/tgrelay.js";
import { parseChatIdeas } from "../dist/pipeline.js";

test("noteText: коротке, самі посилання й емодзі - не думка", () => {
  assert.equal(noteText("ок, дякую"), "");
  assert.equal(noteText("буду о 5, адреса та сама"), "");
  assert.equal(noteText("https://example.com/a/b/c/d/e/f/g 👍👍👍"), "");
  assert.equal(noteText(null), "");
  const t = "Більшість клієнтів просить знижку не через ціну, а через страх, що переплатять.";
  assert.equal(noteText(t), t);
});

test("noteText: голосове без мітки, пробіли стиснуті, довге обрізане", () => {
  const t = noteText("[голосове]   Я завжди кажу клієнтам: спершу фото до, потім кошторис,\n\n бо інакше сперечаємось про те, чого ніхто не бачив.");
  assert.ok(!t.startsWith("[голосове]"));
  assert.ok(!/\s{2,}/.test(t));
  assert.ok(t.length >= NOTE_MIN);
  assert.equal(noteText("а".repeat(5000)).length, NOTE_MAX);
});

test("noteKey: стабільний, різний для різних повідомлень, не містить id чату", () => {
  const a = noteKey("conn1", 777123, 10), b = noteKey("conn1", 777123, 11), c = noteKey("conn1", 777123, 10);
  assert.equal(a, c);
  assert.notEqual(a, b);
  assert.ok(!a.includes("777123"));
  assert.match(a, /^[0-9a-f]{40}$/);
});

test("parseChatIdeas: обʼєкт, масив, огорожа коду; до 3; рубрика лише з наявних; дублі геть", () => {
  const raw = '```json\n{"ideas":[{"idea":"Чому знижка - це не про гроші, а про страх переплатити","angle":"контр-теза","rubric":"порада","quote":"просять знижку через страх"},' +
    '{"idea":"Чому знижка - це не про гроші, а про страх переплатити","angle":"дубль"},' +
    '{"idea":"Фото до роботи знімає половину суперечок","rubric":"вигадана рубрика"},{"idea":"коротко"},' +
    '{"idea":"Третя думка, яка точно стане постом"},{"idea":"Четверта думка понад ліміт трьох ідей"}]}\n```';
  const out = parseChatIdeas(raw, ["Порада", "Кейс"]);
  assert.equal(out.length, 3);
  assert.equal(out[0].rubric, "Порада");
  assert.equal(out[1].rubric, "");
  assert.ok(out.every((x) => x.idea.length >= 12));
  assert.deepEqual(parseChatIdeas('[{"idea":"Масив без обгортки теж розбирається"}]').map((x) => x.idea), ["Масив без обгортки теж розбирається"]);
  assert.deepEqual(parseChatIdeas('{"ideas":[]}'), []);
  assert.deepEqual(parseChatIdeas("модель відповіла прозою"), []);
});

// 👥 І питання клієнтів (окрема галочка): знеособлення ДО збереження, без цитат клієнтів
import { scrubPersonal, clientNoteText, quoteFromOwn, CLIENT_MIN } from "../dist/tgrelay.js";

test("scrubPersonal: пошти, посилання, ніки, телефони, рахунки й довгі номери - на мітки", () => {
  const t = scrubPersonal("Пишіть на jana.novak@seznam.cz або +420 773 708 849, (067) 123-45-67, @jana_n, t.me/janashop, https://x.cz/a?b=1, CZ65 0800 0000 1920 0014 5399, картка 4111 1111 1111 1111, замовлення 12345678");
  for (const bad of ["jana.novak", "773", "123-45-67", "@jana_n", "janashop", "x.cz", "0800", "4111", "12345678"]) assert.ok(!t.includes(bad), bad + " → " + t);
  for (const tag of ["[пошта]", "[номер]", "[нік]", "[посилання]", "[рахунок]"]) assert.ok(t.includes(tag), tag + " → " + t);
  // числа, що не персональні, лишаються: площа, ціна, рік
  assert.equal(scrubPersonal("Квартира 60 м2 за 2500 Kč, з 2019 року"), "Квартира 60 м2 за 2500 Kč, з 2019 року");
});

test("clientNoteText: коротке питання береться, «дякую» й самі контакти - ні", () => {
  assert.ok(clientNoteText("А вікна ви теж миєте разом із рамами?").length >= CLIENT_MIN);
  assert.equal(clientNoteText("дякую, домовились"), "");
  assert.equal(clientNoteText("+420 773 708 849 jana@seznam.cz @jana"), "");
  assert.equal(clientNoteText("[голосове повідомлення]"), "");
  const v = clientNoteText("[голосове] Скільки коштує генеральне прибирання після ремонту? Мій номер +420 777 111 222");
  assert.ok(!v.startsWith("[голосове]") && v.includes("[номер]") && !v.includes("777"), v);
});

test("quoteFromOwn: цитата лише зі слів самої людини", () => {
  const own = ["Я завжди кажу: спершу фото до, потім кошторис, бо інакше сперечаємось про те, чого ніхто не бачив."];
  assert.equal(quoteFromOwn("спершу фото до, потім кошторис", own), "спершу фото до, потім кошторис");
  assert.equal(quoteFromOwn("а скільки коштує прибирання після ремонту", own), "");
  assert.equal(quoteFromOwn("будь-що", []), "");
});

test("parseChatIdeas: ідея з питань клієнтів - без цитати", () => {
  const out = parseChatIdeas('{"ideas":[{"idea":"Що входить у генеральне прибирання після ремонту","from":"clients","quote":"а скільки коштує після ремонту"},{"idea":"Чому фото до роботи знімає половину суперечок","from":"author","quote":"спершу фото до"}]}');
  assert.equal(out[0].from, "clients");
  assert.equal(out[0].quote, "");
  assert.equal(out[1].from, "author");
  assert.equal(out[1].quote, "спершу фото до");
});

test("quoteFromOwn: переказ автора з іншими закінченнями слів - його цитата", () => {
  const own = ["Більшість клієнтів просить знижку не через ціну, а через страх переплатити за те, чого не бачать."];
  assert.equal(quoteFromOwn("знижку просять зі страху переплатити", own), "знижку просять зі страху переплатити");
  assert.equal(quoteFromOwn("вся квартира в пилу після ремонту в мене", ["Я завжди кажу: після ремонту прибирання - це три проходи"]), "");
});
