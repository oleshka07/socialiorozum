// 🔤 Мовні версії субтитрів: мова мережі, які версії робити, перекладені картки в той самий час,
// запасний поділ перекладу, стиль відео бренду з мовами.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normSubLang, normSubLangs, variantLangs, subLangFor, retextCues, cueLines, spreadByWeights, groupCues, karaokeEvents,
  normMontageStyle, MAX_SUB_VARIANTS, SUB_LANGS, SUB_NETS,
} from "../dist/montage-plan.js";

test("normSubLang: коди, назви, UA/CZ; невідоме - null", () => {
  assert.equal(normSubLang("en"), "en");
  assert.equal(normSubLang("EN"), "en");
  assert.equal(normSubLang("ua"), "uk");
  assert.equal(normSubLang("CZ"), "cs");
  assert.equal(normSubLang("Čeština"), "cs");
  assert.equal(normSubLang("English"), "en");
  assert.equal(normSubLang("українська"), "uk");
  assert.equal(normSubLang("es"), null);       // іспанської серед мов субтитрів нема
  assert.equal(normSubLang("клінгонська"), null);
  assert.equal(normSubLang(""), null);
  assert.equal(normSubLang(null), null);
  for (const k of Object.keys(SUB_LANGS)) assert.equal(normSubLang(k), k);
});

test("normSubLangs: лише відомі мережі й мови", () => {
  assert.deepEqual(normSubLangs({ telegram: "en", whatsapp: "cz", instagram: "", vk: "en", threads: "xx" }), { telegram: "en", whatsapp: "cs" });
  assert.deepEqual(normSubLangs(null), {});
  assert.deepEqual(normSubLangs(["en"]), {});
  assert.ok(SUB_NETS.includes("whatsapp") && SUB_NETS.includes("telegram"));
});

test("variantLangs: без мови оригіналу, без повторів, до MAX_SUB_VARIANTS", () => {
  assert.deepEqual(variantLangs("uk", ["en", "cs", "uk", "en", ""]), ["en", "cs"]);
  assert.deepEqual(variantLangs("uk", ["en", "cs", "sk", "pl", "de"]).length, MAX_SUB_VARIANTS);
  assert.deepEqual(variantLangs("cs", ["CZ", "ua"]), ["uk"]);
  assert.deepEqual(variantLangs("uk", []), []);
});

test("subLangFor: свій вибір поста важить більше за стиль; \"\" - оригінал", () => {
  const style = { telegram: "en", whatsapp: "cs" };
  assert.equal(subLangFor({}, style, "telegram"), "en");
  assert.equal(subLangFor({ telegram: { on: true } }, style, "telegram"), "en");
  assert.equal(subLangFor({ telegram: { on: true, sub_lang: "cs" } }, style, "telegram"), "cs");
  assert.equal(subLangFor({ telegram: { on: true, sub_lang: "" } }, style, "telegram"), null);   // оригінал, хоч стиль каже en
  assert.equal(subLangFor({ telegram: { on: true, sub_lang: null } }, style, "telegram"), "en");
  assert.equal(subLangFor({}, style, "instagram"), null);
  assert.equal(subLangFor(null, {}, "whatsapp"), null);
});

test("retextCues: той самий час картки, слова перекладу всередині неї, рядки наново", () => {
  const words = [
    { w: "Сьогодні", s: 0.2, e: 0.6 }, { w: "ріжемо", s: 0.65, e: 1.0 }, { w: "бетон.", s: 1.05, e: 1.5 },
    { w: "Це", s: 2.4, e: 2.5 }, { w: "займе", s: 2.55, e: 2.9 }, { w: "день.", s: 2.95, e: 3.3 },
  ];
  const cues = groupCues(words);
  assert.equal(cues.length, 2);
  const tr = retextCues(cues, ["Today we cut concrete.", "It takes a day."], 18);
  assert.equal(tr.length, cues.length);
  tr.forEach((c, i) => {
    assert.equal(c.start, cues[i].start);
    assert.equal(c.end, cues[i].end);
    assert.ok(c.words.every((w) => w.s >= c.start - 1e-6 && w.e <= c.end + 1e-6), "слова всередині картки");
  });
  assert.equal(tr[0].words.map((w) => w.w).join(" "), "Today we cut concrete.");
  // порожній переклад - картка як була
  const keep = retextCues(cues, ["", "It takes a day."]);
  assert.deepEqual(keep[0], cues[0]);
  // події без підсвічування: по одній на картку
  const ev = karaokeEvents(tr, {}, false);
  assert.equal(ev.length, 2);
  // довгий рядок - у два рядки (\N), разом - увесь переклад
  assert.ok(ev[0].replace(/\\N/g, " ").includes("Today we cut concrete."), ev[0]);
});

test("cueLines: довгий переклад - до 3 рядків, жоден не довший за межу (якщо слова вміщаються)", () => {
  const toks = "This is a much longer translated subtitle line than the original was".split(" ");
  const lines = cueLines(toks, 18);
  assert.ok(lines.length <= 3);
  assert.equal(lines[0][0], 0);
  assert.equal(lines[lines.length - 1][1], toks.length);
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i][0], lines[i - 1][1]);
  for (const [a, b] of lines.slice(0, -1)) assert.ok(toks.slice(a, b).join(" ").length <= 18);
  // коротке - як splitLines (1-2 рядки)
  assert.deepEqual(cueLines(["Hello", "world"], 18), [[0, 2]]);
});

test("spreadByWeights: увесь переклад по картках підряд, у кожній хоч слово, пропорційно довжині", () => {
  const out = spreadByWeights("one two three four five six seven eight", [10, 30, 10]);
  assert.equal(out.length, 3);
  assert.equal(out.join(" "), "one two three four five six seven eight");
  assert.ok(out.every(Boolean));
  assert.ok(out[1].split(" ").length > out[0].split(" ").length);
  // слів менше, ніж карток - перші отримують по слову, решта порожні (але нічого не губиться)
  const few = spreadByWeights("a b", [1, 1, 1]);
  assert.equal(few.join(" ").trim(), "a b");
  assert.deepEqual(spreadByWeights("", [1, 2]), ["", ""]);
  assert.deepEqual(spreadByWeights("x", []), []);
});

test("normMontageStyle: мова мовлення й мови мереж", () => {
  const st = normMontageStyle({ speech: "ua", langs: { telegram: "EN", whatsapp: "cs", vk: "en" } });
  assert.equal(st.speech, "uk");
  assert.deepEqual(st.langs, { telegram: "en", whatsapp: "cs" });
  const d = normMontageStyle(null);
  assert.equal(d.speech, "");
  assert.deepEqual(d.langs, {});
});
