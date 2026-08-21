// Приймач зустрічей із зовнішнього транскрибатора.
//
// Чому саме юніти: помилка парсера тут МОВЧАЗНА. Транскрипт не розбереться - зустріч стане
// матеріалом без тіла або з чужими словами, приписаними авторові, і зрозуміти це можна буде
// хіба що по дивних постах через тиждень.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptMarkdown, meetingText, normalizeMeeting } from "../dist/meetings.js";

const hash = (s) => "h" + s.length;

const NEW_MD = `# Кемп Карлсбад: загальна зустріч

**Я** *[00:05]*: Привіт! Давайте пройдемось по звіту.

**Співрозмовник 1** *[00:12]*: Доброго дня, виручка 668 тисяч.

**AI** *[00:20]*: Нагадую про наступний пункт.

---

## Особисті нотатки

домовились про кошторис

---

## Summary (AI)

- Виручка за липень: 668 тис. крон`;

test("новий формат: спікер, час і текст розбираються", () => {
  const p = parseTranscriptMarkdown(NEW_MD);
  assert.equal(p.turns.length, 3);
  assert.deepEqual(p.turns[0], { speaker: "Я", time: "00:05", text: "Привіт! Давайте пройдемось по звіту." });
  assert.equal(p.turns[1].speaker, "Співрозмовник 1");
});

test("старий формат (зустрічі до серпня 2026) теж читається", () => {
  // якби приймач знав лише новий формат, увесь архів мовчки став би порожніми матеріалами
  const p = parseTranscriptMarkdown("**[01:02] Я:** Це старий запис.\n\n**[01:20:33] Співрозмовник 2:** Довга зустріч.");
  assert.equal(p.turns.length, 2);
  assert.equal(p.turns[0].speaker, "Я");
  assert.equal(p.turns[0].text, "Це старий запис.");
  assert.equal(p.turns[1].time, "01:20:33", "години теж бувають");
});

test("секції відокремлюються від реплік і одна від одної", () => {
  const p = parseTranscriptMarkdown(NEW_MD);
  assert.equal(p.notes, "домовились про кошторис");
  assert.ok(p.summary.includes("668"));
  assert.ok(!p.turns.some((t) => t.text.includes("668 тис. крон")), "рядок summary не має стати реплікою");
});

test("імена спікерів ЗАЛИШАЮТЬСЯ в тексті для моделі", () => {
  // без підпису модель припише слова співрозмовника авторові - «наш досвід» про чужу репліку
  const t = meetingText("Зустріч", parseTranscriptMarkdown(NEW_MD));
  assert.ok(t.includes("Я: Привіт"));
  assert.ok(t.includes("Співрозмовник 1: Доброго дня"));
});

test("службові репліки асистента відкидаються", () => {
  // це машинний текст; вчити на ньому голос бренду - те саме, що AI-приклади голосу
  const t = meetingText("Зустріч", parseTranscriptMarkdown(NEW_MD));
  assert.ok(!t.includes("Нагадую про наступний пункт"));
});

test("особисті нотатки позначені як власні слова автора, summary в текст НЕ йде", () => {
  const t = meetingText("Зустріч", parseTranscriptMarkdown(NEW_MD));
  assert.ok(t.includes("## Мої нотатки з зустрічі"));
  assert.ok(t.includes("домовились про кошторис"));
  // AI-підсумок - переказ того, що вже є в транскрипті, машинними словами: подвоювати його в
  // промті означає вчити модель на власному ж машинному тексті
  assert.ok(!t.includes("Виручка за липень"));
});

test("перенос рядка всередині репліки не губиться", () => {
  const p = parseTranscriptMarkdown("**Я** *[00:01]*: Перший рядок\nпродовження думки");
  assert.equal(p.turns.length, 1);
  assert.equal(p.turns[0].text, "Перший рядок продовження думки");
});

test("повне тіло Vymova нормалізується", () => {
  const r = normalizeMeeting({
    event: "meeting.completed", app: "vymova", title: "Кемп Карлсбад",
    finished_at: "2026-08-19T16:48:12+02:00", file_name: "meeting_2026-08-19_15-00.md",
    meeting_id: "550e8400-e29b-41d4-a716-446655440000",
    transcript_markdown: NEW_MD, summary_markdown: "- Виручка 668",
  }, hash);
  assert.equal(r.externalId, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(r.speakers, 3);
  assert.equal(r.finishedAt.toISOString(), "2026-08-19T14:48:12.000Z");
  assert.ok(r.summary.includes("668"));
});

test("незнайома подія ігнорується, а не валиться помилкою", () => {
  // інакше відправник ретраїтиме те, що ми свідомо не беремо, і витратить усі 3 спроби
  const r = normalizeMeeting({ event: "meeting.started", transcript_markdown: NEW_MD }, hash);
  assert.ok("ignore" in r);
});

test("мінімальна «загальна» форма {title,text} теж приймається", () => {
  // щоб наступний самописний інструмент підключався без правок на нашому боці
  const r = normalizeMeeting({ title: "Своя нотатка", text: "x".repeat(60), id: "abc-123" }, hash);
  assert.equal(r.externalId, "abc-123");
  assert.equal(r.title, "Своя нотатка");
});

test("без ідентифікатора ключ дедуплікації рахується з вмісту", () => {
  // ретрай відправника (їх до 3) інакше створив би дублікати матеріалу
  const body = { title: "Без id", text: "y".repeat(60) };
  assert.equal(normalizeMeeting(body, hash).externalId, normalizeMeeting(body, hash).externalId);
  assert.ok(normalizeMeeting(body, hash).externalId.startsWith("sha:"));
});

test("порожня зустріч ігнорується, а нерозібраний транскрипт рятується підсумком", () => {
  assert.ok("ignore" in normalizeMeeting({ transcript_markdown: "# Тиша\n\n---" }, hash));
  const r = normalizeMeeting({ title: "Чужий формат", transcript_markdown: "щось геть інше", summary_markdown: "з".repeat(60) }, hash);
  assert.ok(!("ignore" in r), "підсумок є - матеріал не має пропадати мовчки");
  assert.ok(r.text.includes("Чужий формат"));
});

test("ключ дедуплікації - meeting_id, а НЕ file_name", () => {
  // file_name виведений із часу початку: дві зустрічі, розпочаті в одну хвилину на різних
  // пристроях, злиплися б в одну - і друга зникла б без сліду
  const mk = (uuid) => normalizeMeeting({
    meeting_id: uuid, file_name: "meeting_2026-08-19_15-00.md",
    title: "Збіг у часі", transcript_markdown: `# x\n\n**Я** *[00:01]*: ${uuid} - зустріч про бюджет наступного кварталу.`,
  }, hash);
  const a = mk("550e8400-e29b-41d4-a716-446655440000");
  const b = mk("111e8400-e29b-41d4-a716-446655440999");
  assert.equal(a.externalId, "550e8400-e29b-41d4-a716-446655440000");
  assert.notEqual(a.externalId, b.externalId, "однаковий file_name не має злипати різні зустрічі");
});

test("file_name лишається запасним ключем (записи до серпня 2026)", () => {
  const r = normalizeMeeting({ file_name: "old_meeting.md", title: "Старий запис",
    transcript_markdown: "# x\n\n**[00:01] Я:** Запис зі старої версії застосунку про кошторис." }, hash);
  assert.equal(r.externalId, "old_meeting.md");
});

test("є UUID - file_name у перевірку дубля НЕ йде", () => {
  // інакше нова зустріч, чий file_name збігся з уже імпортованою, мовчки вважалась би дублем
  // і зникала б: запобіжник від колізії сам би її й відтворював (спіймано прогоном наскрізь)
  const r = normalizeMeeting({ meeting_id: "uuid-1", file_name: "meeting_2026-08-19.md",
    title: "Нова зустріч", transcript_markdown: "# x\n\n**Я** *[00:01]*: Текст зустрічі про терміни здачі обʼєкта." }, hash);
  assert.equal(r.externalId, "uuid-1");
  assert.ok(!r.altIds.includes("meeting_2026-08-19.md"), "file_name не має свопити чужу зустріч");
  assert.ok(r.altIds.some((x) => x.startsWith("sha:")), "хеш вмісту лишається - байт-у-байт та сама доставка");
});

test("нема UUID - тоді file_name і є ключем, а хеш вмісту запасним", () => {
  const r = normalizeMeeting({ file_name: "old.md", title: "Стара версія застосунку",
    transcript_markdown: "# x\n\n**[00:01] Я:** Запис без UUID про кошторис і терміни." }, hash);
  assert.equal(r.externalId, "old.md");
  assert.ok(r.altIds.every((x) => x.startsWith("sha:")));
});

test("хеш ВІДПРАВНИКА має пріоритет над нашим власним", () => {
  // його рахується з сирого transcript_markdown, тож не залежить від того, як наш парсер
  // сьогодні складає текст: інакше будь-яка правка meetingText тихо зробила б усі раніше
  // прийняті зустрічі «новими»
  const body = { title: "Без ідентифікаторів", content_sha256: "9f2cabc",
    transcript_markdown: "# x\n\n**Я** *[00:01]*: Текст зустрічі про бюджет наступного кварталу." };
  const r = normalizeMeeting(body, hash);
  assert.equal(r.externalId, "sha:9f2cabc");
  assert.ok(r.altIds.some((x) => x.startsWith("sha:") && x !== "sha:9f2cabc"), "наш хеш лишається запасним");
});

test("наш хеш лишається в запасних - зустріч, прийнята до появи content_sha256, не задвоїться", () => {
  const md = "# x\n\n**Я** *[00:01]*: Текст зустрічі про бюджет наступного кварталу.";
  const before = normalizeMeeting({ title: "Т", transcript_markdown: md }, hash);
  const after = normalizeMeeting({ title: "Т", transcript_markdown: md, content_sha256: "новий" }, hash);
  assert.ok(after.altIds.includes(before.externalId), "старий ключ мусить лишитись у перевірці");
});

test("сире transcript_markdown і заявлений хеш віддаються для перевірки цілості", () => {
  const md = "# x\n\n**Я** *[00:01]*: Текст зустрічі про бюджет наступного кварталу.";
  const r = normalizeMeeting({ meeting_id: "u1", title: "Т", transcript_markdown: md, content_sha256: "AABB" }, hash);
  assert.equal(r.rawTranscript, md, "звіряти треба саме сире поле, а не наш перероблений текст");
  assert.equal(r.senderSha, "AABB");
});

test("хеші НЕ виключають одне одного за наявності UUID, а file_name виключається", () => {
  const r = normalizeMeeting({ meeting_id: "u1", file_name: "collide.md", content_sha256: "c1",
    title: "Т", transcript_markdown: "# x\n\n**Я** *[00:01]*: Текст про терміни здачі обʼєкта." }, hash);
  assert.equal(r.externalId, "u1");
  assert.ok(!r.altIds.includes("collide.md"), "file_name колізить за часом - у перевірку не йде");
  assert.ok(r.altIds.includes("sha:c1"), "хеш вмісту не колізить - лишається");
});
