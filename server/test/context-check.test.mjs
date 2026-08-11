// Детермінований шар перевірки контексту + вирізання незаповнених плейсхолдерів.
//
// Звідки це взялось: власник бренду згодував сервісу приклади голосу зі старих прес-релізів,
// автогенерований бриф зі штампами й болі з незаповненими «[доказ?]» - і не розумів, чому пости
// слабкі. Запобіжника від такого входу не було ЗОВСІМ.
//
// Головна річ, яку стережуть ці тести: **приклади сильніші за правила**. Модель імітує зразок
// охочіше, ніж виконує інструкцію, тож знахідка «твої приклади суперечать твоєму ж стоп-листу»
// мусить бути КРИТИЧНОЮ, а не косметичною. Якщо хтось колись послабить її до «info» - тест упаде.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicFindings, contextScore } from "../dist/context-check.js";
import { stripPlaceholders } from "../dist/pipeline.js";

const GOOD = {
  voice_examples: "Ми втратили клієнта на рівному місці. Підрядник зник на два тижні, а я дізнався про це від замовника.\n\n"
    + "Вчора рахували кошторис і знайшли помилку на 40 тисяч. Не в підрядника - у себе. Розповім, як тепер перевіряємо.\n\n"
    + "Питання, яке ставлю кожному новому партнеру перед стартом: хто дзвонить клієнту, коли все пішло не так?",
  tone_of_voice: "коротко, від першої особи, без пафосу",
  strategy_brief: "Працюємо з власниками житла, які будують уперше. Продаємо супровід, а не будівництво.",
  pain_points: "Не знаю, кому довіряти → перевіряємо підрядника → 12 перевірених бригад",
  brand_story: "Почав із власного будинку, який будував два роки й тричі міняв бригаду.",
};
const find = (f, part) => f.find((x) => x.title.includes(part));

test("здоровий контекст не сипле вигаданими проблемами", () => {
  const f = deterministicFindings(GOOD, 100);
  assert.equal(f.filter((x) => x.severity === "critical").length, 0, JSON.stringify(f, null, 1));
});

test("порожні приклади голосу - критично (звідси «пости в усіх однакові»)", () => {
  const f = deterministicFindings({ ...GOOD, voice_examples: "" }, 100);
  const x = find(f, "прикладів твого голосу");
  assert.ok(x, "знахідки нема");
  assert.equal(x.severity, "critical");
  assert.ok(x.fix.length > 20, "порада має бути конкретною, а не «заповніть поле»");
});

test("приклади порушують ВЛАСНИЙ стоп-лист - критично", () => {
  // саме цей конфлікт модель вирішує на користь прикладу, тобто правило не працює взагалі
  const f = deterministicFindings({ ...GOOD, voice_stoplist: "кошторис, синергія" }, 100);
  const x = find(f, "стоп-листа");
  assert.ok(x, "не побачив слово зі стоп-листа у прикладах");
  assert.equal(x.severity, "critical");
  assert.ok(x.fix.includes("кошторис"));
});

test("стоп-лист не спрацьовує на випадковому підрядку", () => {
  // «ти» не має ловитись у «типово» - інакше перевірка стане шумом, і її перестануть читати
  const f = deterministicFindings({ ...GOOD, voice_stoplist: "ти, ми" }, 100);
  assert.equal(find(f, "стоп-листа"), undefined);
});

test("бриф зі штампами - зауваження, бо він помічений як джерело правди", () => {
  const f = deterministicFindings({ ...GOOD, strategy_brief: "У сучасному світі інтеграція AI змінює правила гри. Варто зазначити, що це ключовий тренд." }, 100);
  const x = find(f, "штампами");
  assert.ok(x);
  assert.equal(x.severity, "warn");
});

test("бриф проти анти-асоціацій - критично (два блоки наказують протилежне)", () => {
  const f = deterministicFindings({ ...GOOD, strategy_brief: "Проводимо безкоштовний вебінар для підписників.", brand_antiassoc: "вебінар, інфобізнес" }, 100);
  const x = find(f, "ДНК бренду забороняє");
  assert.ok(x);
  assert.equal(x.severity, "critical");
});

test("незаповнені [доказ?] помічаються, заповнені - ні", () => {
  const withPh = deterministicFindings({ ...GOOD, pain_points: "Не знаю кому довіряти → перевіряємо → [доказ?]" }, 100);
  assert.ok(find(withPh, "[доказ?]"));
  assert.equal(find(deterministicFindings(GOOD, 100), "[доказ?]"), undefined);
});

test("сума часток рубрик - лише інформація, не помилка", () => {
  const f = deterministicFindings(GOOD, 70);
  const x = find(f, "70%");
  assert.ok(x);
  assert.equal(x.severity, "info", "це не ламає тексти - лише не справдить очікування щодо плану");
});

test("кожна знахідка пояснює ЧОМУ і що зробити", () => {
  // без цього перевірка перетворюється на список докорів, з якого нічого не зрозуміло
  const f = deterministicFindings({ voice_examples: "", pain_points: "" }, 40);
  assert.ok(f.length >= 3);
  for (const x of f) {
    assert.ok(x.why && x.why.length > 30, "порожнє «чому» у: " + x.title);
    assert.ok(x.fix && x.fix.length > 15, "порожнє «що зробити» у: " + x.title);
    assert.ok(x.field && x.field.includes("→"), "не сказано, ДЕ це в кабінеті: " + x.title);
  }
});

test("stripPlaceholders прибирає плейсхолдер, але зберігає справжній доказ", () => {
  assert.equal(stripPlaceholders("біль → рішення → [доказ?]"), "біль → рішення");
  assert.equal(stripPlaceholders("біль → рішення → 30% зростання"), "біль → рішення → 30% зростання");
  assert.equal(stripPlaceholders("а → б → [цифра?]\nв → г → 12 кейсів"), "а → б\nв → г → 12 кейсів");
  assert.equal(stripPlaceholders(""), "");
});

test("оцінка не вироджується в одиницю, щойно знахідок стало більше", () => {
  // після розширення розбору проста сума штрафів давала 1/10 практично всім - шкала, що завжди
  // показує одиницю, не несе інформації й не мотивує нічого лагодити
  const mk = (sev, n) => Array.from({ length: n }, () => ({ severity: sev }));
  assert.equal(contextScore([]), 10, "чисто - десятка");
  assert.equal(contextScore(mk("info", 5)), 9, "дрібниці майже не важать");
  assert.ok(contextScore(mk("warn", 4)) >= 6, "чотири зауваження - ще не катастрофа");
  assert.ok(contextScore(mk("critical", 1)) <= 8, "критичне відчутно бʼє");
  assert.ok(contextScore(mk("critical", 3)) <= 5, "три критичних - явно погано");
  assert.ok(contextScore(mk("critical", 20)) >= 1, "але дно існує");
  assert.equal(contextScore(mk("critical", 20)), contextScore(mk("critical", 30)), "стеля штрафу тримає");
});
