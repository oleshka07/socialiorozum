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
    transcript_markdown: NEW_MD, summary_markdown: "- Виручка 668",
  }, hash);
  assert.equal(r.externalId, "meeting_2026-08-19_15-00.md");
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
