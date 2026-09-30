// 🎬 Монтаж: чисті правила (субтитри, таймлайн, нарізка сторіс, ASS).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  langCode, wordsFromAlignment, wordsEvenly, restorePunct, groupCues, splitLines, captionChunks, wrapText,
  assColor, assEscape, assTime, karaokeAss, captionsAss, allocate, fitClip, splitPoints, wordsText,
} from "../dist/montage-plan.js";

test("langCode: вільний текст мови кабінету → код для розшифровки й голосу", () => {
  assert.equal(langCode("Українська"), "uk");
  assert.equal(langCode("Чеська"), "cs");
  assert.equal(langCode("Czech"), "cs");
  assert.equal(langCode("čeština"), "cs");
  assert.equal(langCode("English"), "en");
  assert.equal(langCode("Польська"), "pl");
  assert.equal(langCode(""), "uk");
  assert.equal(langCode("клінгонська"), "uk");
});

test("wordsFromAlignment: символи ElevenLabs → слова від першої до останньої літери, зі зсувом", () => {
  const txt = "Ahoj, jak se máte?";
  const chars = [...txt];
  const st = chars.map((_, i) => i * 0.1), en = chars.map((_, i) => i * 0.1 + 0.08);
  const w = wordsFromAlignment({ characters: chars, character_start_times_seconds: st, character_end_times_seconds: en }, 2);
  assert.deepEqual(w.map((x) => x.w), ["Ahoj,", "jak", "se", "máte?"]);
  assert.equal(w[0].s, 2);
  assert.equal(w[0].e, 2.48);             // «,» - 5-й символ: 0.4 + 0.08
  assert.equal(w[1].s, 2.6);
  assert.ok(w.every((x, i) => x.e > x.s && (i === 0 || x.s >= w[i - 1].s)));
  assert.deepEqual(wordsFromAlignment(null), []);
  assert.deepEqual(wordsFromAlignment({ characters: ["a"], character_start_times_seconds: [], character_end_times_seconds: [] }).length, 1);
});

test("wordsEvenly: без розмітки часу слова лягають по порядку в межах звуку, з паузами на крапках", () => {
  const w = wordsEvenly("Tady je fasáda. A tady schodiště", 1, 5);
  assert.equal(w.length, 6);
  assert.equal(w[0].s, 1);
  assert.ok(w[w.length - 1].e <= 5);
  for (let i = 1; i < w.length; i++) assert.ok(w[i].s >= w[i - 1].e - 1e-9, "слова не налазять одне на одне");
  // після «fasáda.» пауза довша, ніж після звичайного слова такої ж довжини
  const gapAfterDot = w[3].s - w[2].e, gapNormal = w[1].s - w[0].e;
  assert.ok(gapAfterDot > gapNormal);
  assert.deepEqual(wordsEvenly("", 0, 3), []);
  assert.deepEqual(wordsEvenly("слово", 3, 3), []);
});

test("restorePunct: Whisper-слова дістають розділові й регістр із суцільного тексту", () => {
  const words = [{ w: "ahoj", s: 0, e: 0.3 }, { w: "jak", s: 0.4, e: 0.6 }, { w: "se", s: 0.6, e: 0.7 }, { w: "máte", s: 0.7, e: 1 }];
  const out = restorePunct(words, "Ahoj, jak se máte?");
  assert.deepEqual(out.map((x) => x.w), ["Ahoj,", "jak", "se", "máte?"]);
  // розбіжність у тексті не ламає решту
  const out2 = restorePunct([{ w: "раз", s: 0, e: 1 }, { w: "три", s: 1, e: 2 }], "Раз, два, три.");
  assert.deepEqual(out2.map((x) => x.w), ["Раз,", "три."]);
});

const W = (arr) => { let t = 0; return arr.map((w) => { const o = { w, s: t, e: t + 0.3 }; t += 0.35; return o; }); };

test("groupCues: картки до 5 слів, кінець речення і кома розривають, пауза розриває", () => {
  const cues = groupCues(W(["Fasáda", "je", "hotová.", "Teď", "jdeme", "dovnitř,", "na", "schodiště", "a", "chodbu", "v", "domě"]));
  assert.deepEqual(cues.map((c) => c.words.map((w) => w.w).join(" ")), ["Fasáda je hotová.", "Teď jdeme dovnitř,", "na schodiště a chodbu v", "domě"]);
  // картки не налазять одна на одну й кожна триває хоч трохи
  for (let i = 0; i < cues.length; i++) {
    assert.ok(cues[i].end > cues[i].start);
    if (cues[i + 1]) assert.ok(cues[i].end <= cues[i + 1].start + 1e-9);
  }
  const words = [{ w: "раз", s: 0, e: 0.3 }, { w: "два", s: 2, e: 2.3 }];
  assert.equal(groupCues(words).length, 2, "пауза 1,7 с - нова картка");
  // довге слово не ламає групування
  assert.equal(groupCues([{ w: "x".repeat(40), s: 0, e: 1 }]).length, 1);
});

test("splitLines: у два рядки з найрівнішим розривом", () => {
  assert.deepEqual(splitLines(["Fasáda", "je"], 18), [[0, 2]]);
  const t = ["na", "schodiště", "a", "chodbu", "v", "domě"];
  const [[a, b], [c, d]] = splitLines(t, 18);
  assert.equal(b, c);
  const l1 = t.slice(a, b).join(" ").length, l2 = t.slice(c, d).join(" ").length;
  assert.ok(Math.abs(l1 - l2) <= 8, `рядки рівні: ${l1} vs ${l2}`);
});

test("captionChunks: підпис кліпу ділиться на шматки, що встигають прочитати, в межах кліпу", () => {
  const caps = captionChunks("Fasáda už svítí. Lešení ještě stojí a my jdeme dovnitř škrábat staré nátěry vrstvu po vrstvě.", 2, 8);
  assert.ok(caps.length >= 2);
  assert.equal(caps[0].start, 2);
  assert.ok(caps[caps.length - 1].end <= 8);
  assert.ok(caps.every((c) => c.text.length <= 60));
  // на коротку ділянку - не більше шматків, ніж встигнеш прочитати
  assert.equal(captionChunks("Jedna. Dvě. Tři. Čtyři. Pět.", 0, 2).length, 1);
  assert.deepEqual(captionChunks("", 0, 3), []);
});

test("wrapText: до 3 рядків", () => {
  assert.deepEqual(wrapText("один два три", 20), ["один два три"]);
  assert.equal(wrapText("a ".repeat(60), 10).length, 3);
});

test("ASS: кольори, екранування, час", () => {
  assert.equal(assColor("#FFD23F"), "&H003FD2FF");
  assert.equal(assColor("#000000", 0x80), "&H80000000");
  assert.equal(assEscape("a{\\b1}b\\Nc\nd"), "a/b1b/Nc d");
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(61.237), "0:01:01.24");
  assert.equal(assTime(3725.5), "1:02:05.50");
});

test("karaokeAss: подія на кожне слово, поточне - кольором, рядки картки не стрибають", () => {
  const cues = groupCues(W(["Fasáda", "je", "hotová."]));
  const ass = karaokeAss(cues);
  const ev = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(ev.length, 3);
  assert.match(ev[0], /\{\\1c&H003FD2FF&\}Fasáda\{\\r\} je hotová\./);
  assert.match(ev[2], /Fasáda je \{\\1c&H003FD2FF&\}hotová\.\{\\r\}/);
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Style: Word,DejaVu Sans,76,/);
  // без підсвічування - одна подія на картку
  assert.equal(karaokeAss(cues, {}, false).split("\n").filter((l) => l.startsWith("Dialogue:")).length, 1);
  // дужки з тексту не стають тегами
  const inj = karaokeAss(groupCues([{ w: "{\\fs200}ha", s: 0, e: 1 }]));
  assert.doesNotMatch(inj, /\\fs200/);
});

test("captionsAss: підписи стилем Cap, у межах часу", () => {
  const ass = captionsAss([{ text: "Venku už nová barva", start: 0, end: 2 }, { text: "", start: 2, end: 3 }]);
  const ev = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(ev.length, 1);
  assert.match(ev[0], /^Dialogue: 0,0:00:00\.00,0:00:02\.00,Cap,/);
});

test("allocate: без голосу - довжина кліпів, з голосом - пропорційно довжині, з want - як просили", () => {
  assert.deepEqual(allocate([{ avail: 5 }, { avail: 30 }, { avail: 0, still: true }]), [5, 20, 3]);
  const d = allocate([{ avail: 4 }, { avail: 12 }], 24);
  assert.equal(d[0] + d[1], 24);
  assert.equal(d[1], 3 * d[0]);
  const f = allocate([{ avail: 10, want: 2 }, { avail: 4 }, { avail: 4 }], 12);
  assert.equal(f[0], 2);
  assert.equal(f[1], 5); assert.equal(f[2], 5);
  // голос коротший за мінімум - кліп не стає нульовим
  assert.ok(allocate([{ avail: 5 }, { avail: 5 }, { avail: 5 }], 1).every((x) => x >= 0.8));
  // лише кліпи з want: масштаб під голос
  assert.deepEqual(allocate([{ avail: 9, want: 2 }, { avail: 9, want: 2 }], 8), [4, 4]);
});

test("fitClip: обрізаємо з середини (або з from), коротший - сповільнення до 1,6×, решта - стоп-кадр", () => {
  assert.deepEqual(fitClip(10, 4, false), { offset: 3, take: 4, speed: 1, freeze: 0 });
  assert.deepEqual(fitClip(10, 4, true), { offset: 0, take: 4, speed: 1, freeze: 0 });
  const s = fitClip(4, 5, false);
  assert.equal(s.take, 4); assert.equal(s.speed, 1.25); assert.equal(s.freeze, 0);
  const f = fitClip(2, 6, false);
  assert.equal(f.speed, 1.6); assert.equal(f.freeze, 2.8);
});

test("fitClip: повтор k з n бере різні шматки кліпу - від початку до кінця", () => {
  assert.deepEqual(fitClip(10, 4, false, 0, 2), { offset: 0, take: 4, speed: 1, freeze: 0 });
  assert.deepEqual(fitClip(10, 4, false, 1, 2), { offset: 6, take: 4, speed: 1, freeze: 0 });
  assert.equal(fitClip(10, 4, false, 1, 3).offset, 3);
});

// 29.09 Олег: 2 відео (6,2 і 7,57 с) і голосове 23 с. До фіксу в монтаж дійшов один кліп, а він 1,6× і
// далі 11,6 с стоп-кадру - «завис». Жоден кадр не має стояти довше за залишок округлення.
const sumDur = (shots) => Math.round(shots.reduce((a, s) => a + s.dur, 0) * 100) / 100;
const maxFreeze = (shots) => Math.max(0, ...shots.map((s) => s.freeze));
test("planShots: відео коротше за голос - кліпи по колу (1, 2, 1, 2), без стоп-кадру й не швидше за 1,6×", () => {
  const clips = [{ avail: 6.2 }, { avail: 7.57 }];
  const durs = allocate(clips, 23.69);
  const { shots, passes } = planShots(clips, durs, true);
  assert.equal(passes, 2);
  assert.deepEqual(shots.map((s) => s.clip), [0, 1, 0, 1]);
  assert.equal(sumDur(shots), 23.69);
  assert.ok(maxFreeze(shots) <= 0.1, "стоп-кадр " + maxFreeze(shots));
  assert.ok(shots.every((s) => s.speed <= MAX_SLOW && s.take <= clips[s.clip].avail + 1e-9));
  // повтор - інший шматок кліпу
  assert.notEqual(shots[0].offset, shots[2].offset);
  // початки кадрів ідуть підряд
  for (let k = 1; k < shots.length; k++) assert.ok(Math.abs(shots[k].start - (shots[k - 1].start + shots[k - 1].dur)) < 1e-9);
});

test("planShots: один кліп 7,57 с під голос 23,7 с - повтор, а не 11,6 с стоп-кадру", () => {
  const clips = [{ avail: 7.57 }];
  const { shots, passes } = planShots(clips, allocate(clips, 23.69), true);
  assert.ok(passes >= 2);
  assert.equal(sumDur(shots), 23.69);
  assert.ok(maxFreeze(shots) <= 0.1, "стоп-кадр " + maxFreeze(shots));
  assert.ok(shots.every((s) => s.speed <= MAX_SLOW));
});

test("planShots: відео вистачає - як і раніше, один кадр на кліп, обрізка з середини чи сповільнення", () => {
  const clips = [{ avail: 10 }, { avail: 4 }];
  const a = planShots(clips, [6, 4], true);
  assert.equal(a.passes, 1);
  assert.deepEqual(a.shots.map((s) => [s.clip, s.offset, s.take, s.speed]), [[0, 2, 6, 1], [1, 0, 4, 1]]);
  const b = planShots(clips, allocate(clips, 20), true);  // 1,43× - ще в межах сповільнення
  assert.equal(b.passes, 1); assert.equal(b.shots.length, 2); assert.ok(maxFreeze(b.shots) <= 0.1);
  // фото тягнеться скільки треба і не множить повторів
  const c = planShots([{ avail: Infinity, still: true }, { avail: 5 }], [12, 6], true);
  assert.equal(c.passes, 1); assert.deepEqual(c.shots.map((s) => s.dur), [12, 6]);
});

test("planShots: кліп із власним текстом (слот) повторюється у своєму місці, сусіди не зсуваються", () => {
  const clips = [{ avail: 2 }, { avail: 8 }];
  const { shots } = planShots(clips, [7, 5], false);  // перший кліп мусить звучати 7 с (AI-голос по кліпах)
  assert.deepEqual(shots.map((s) => s.clip), [0, 0, 0, 1]);
  assert.equal(Math.round((shots[3].start) * 100) / 100, 7);
  assert.ok(maxFreeze(shots) <= 0.1);
});

test("splitPoints: сторіс довше 60 с ріжеться на стику кліпів чи в паузі, не посеред картки", () => {
  assert.deepEqual(splitPoints(50, [10, 20]), []);
  const cuts = splitPoints(100, [20, 45, 58, 80], [{ start: 57, end: 59 }]);
  assert.equal(cuts[0], 45, "58 - посеред картки субтитрів, тож ріжемо на 45");
  assert.ok(cuts.every((c, i) => c - (i ? cuts[i - 1] : 0) <= 59.5));
  assert.ok(100 - cuts[cuts.length - 1] <= 59.5);
  // без безпечних місць - на межі
  const hard = splitPoints(130, []);
  assert.deepEqual(hard, [59.5, 119]);
  // хвіст коротший за 3 с не лишається
  const t = splitPoints(61, [60.5]);
  assert.ok(61 - t[0] >= 3);
  // пауза між картками теж підходить
  assert.deepEqual(splitPoints(70, [], [{ start: 30, end: 40 }, { start: 41, end: 69 }]), [40.5]);
});

test("wordsText: слова → текст без пробілів перед розділовими", () => {
  assert.equal(wordsText([{ w: "Ahoj", s: 0, e: 1 }, { w: ",", s: 1, e: 1.1 }, { w: "světe!", s: 1.2, e: 2 }]), "Ahoj, světe!");
});

// ---- друга хвиля: текст автора по кліпах, режими бота, аудіо, провайдери ----
import { spreadText, planShots, MAX_SLOW } from "../dist/montage-plan.js";
import { mtOpts, mtTextPlan, loopHint, mtLocked } from "../dist/tgmontage.js";
import { sniffKind } from "../dist/media.js";
import { humanElevenError, azureVoice } from "../dist/tts.js";
import { deepgramWords, whisperWords } from "../dist/stt.js";

test("spreadText: свій текст ділиться по кліпах реченнями, порядок і всі речення на місці", () => {
  const t = "Fasáda je hotová. Lešení ještě stojí. Teď schodiště. Pak prasklina v oblouku. Nakonec barva.";
  const p = spreadText(t, 3);
  assert.equal(p.length, 3);
  assert.equal(p.join(" "), t);
  assert.ok(p.every(Boolean));
  assert.deepEqual(spreadText("Jedna věta.", 3), ["Jedna věta.", "", ""]);
  assert.deepEqual(spreadText("", 2), ["", ""]);
});

test("mtOpts: бот обирає звідки текст - голосове, свій текст (AI-голос чи підписи), AI з кадрів, звук кліпів", () => {
  const st = { chat: "1", clips: [{ id: "a", kind: "video", dur: 5 }, { id: "b", kind: "image", dur: 0 }], voice: null, script: null, mode: "auto", format: "story", at: Date.now() };
  assert.deepEqual(mtOpts({ ...st, voice: { id: "v", dur: 7 } }, true).opts.voice, "audio");
  assert.equal(mtOpts({ ...st, voice: { id: "v", dur: 7 } }, true).opts.audio, "v");
  const own = mtOpts({ ...st, script: "Raz. Dva." }, true);
  assert.equal(own.opts.voice, "tts"); assert.equal(own.opts.script, "Raz. Dva.");
  const ownNoTts = mtOpts({ ...st, script: "Raz. Dva." }, false);
  assert.equal(ownNoTts.opts.voice, "none");
  assert.deepEqual(ownNoTts.opts.clips.map((c) => c.text), ["Raz.", "Dva."]);
  assert.deepEqual(mtOpts({ ...st, mode: "captions" }, false).aiText, { mode: "captions" });
  assert.equal(mtOpts({ ...st, mode: "ai-voice" }, true).opts.voice, "tts");
  assert.deepEqual(mtOpts({ ...st, mode: "ai-voice" }, true).aiText, { mode: "voiceover" });
  // AI-голосу нема - «AI-голос» тихо стає режимом за замовчуванням, а не падає
  assert.equal(mtOpts({ ...st, mode: "ai-voice" }, false).opts.voice, "clips");
  const auto = mtOpts(st, true);
  assert.equal(auto.opts.voice, "clips"); assert.equal(auto.opts.autoCaptions, true);
  assert.match(mtTextPlan({ ...st, voice: { id: "v", dur: 7 } }, true), /голосове \(0:07\)/);
  assert.match(mtTextPlan({ ...st, script: "Ahoj" }, false), /підписами/);
});

test("loopHint: голосове довше за відео - картка каже ДО монтажу, що кліпи підуть по колу", () => {
  const st = { chat: "1", clips: [{ id: "a", kind: "video", dur: 6.2 }, { id: "b", kind: "video", dur: 7.57 }], voice: { id: "v", dur: 23 }, script: null, mode: "auto", format: "story", at: Date.now() };
  assert.match(loopHint(st), /по колу/);
  assert.equal(loopHint({ ...st, voice: { id: "v", dur: 20 } }), "");
  assert.equal(loopHint({ ...st, voice: null }), "");
});

test("mtLocked: дії з сесією одного кабінету - по черзі (альбом не губить кліпи), різні кабінети - паралельно", async () => {
  const log = [];
  const slow = (tag, ms) => async () => { log.push(tag + ">"); await new Promise((r) => setTimeout(r, ms)); log.push("<" + tag); return tag; };
  const r = await Promise.all([mtLocked("w1", slow("a", 30)), mtLocked("w1", slow("b", 5)), mtLocked("w2", slow("c", 5))]);
  assert.deepEqual(r, ["a", "b", "c"]);
  assert.ok(log.indexOf("<a") < log.indexOf("b>"), log.join(" "));
  assert.ok(log.indexOf("c>") < log.indexOf("<a"), log.join(" "));
  // збій однієї дії не блокує наступні
  await assert.rejects(mtLocked("w1", async () => { throw new Error("x"); }));
  assert.equal(await mtLocked("w1", async () => 7), 7);
});

test("sniffKind: голос розпізнається за байтами (OGG, MP3, M4A, WAV, FLAC), відео й фото - як раніше", () => {
  const pad = (b) => Buffer.concat([b, Buffer.alloc(32)]);
  assert.deepEqual(sniffKind(pad(Buffer.from("OggS\0\x02", "latin1"))), { kind: "audio", mime: "audio/ogg" });
  assert.deepEqual(sniffKind(pad(Buffer.from("ID3\x04\0", "latin1"))), { kind: "audio", mime: "audio/mpeg" });
  assert.deepEqual(sniffKind(pad(Buffer.from([0xff, 0xfb, 0x90, 0x00]))), { kind: "audio", mime: "audio/mpeg" });
  assert.deepEqual(sniffKind(pad(Buffer.from([0xff, 0xf1, 0x50, 0x80]))), { kind: "audio", mime: "audio/aac" });
  assert.deepEqual(sniffKind(pad(Buffer.from("\0\0\0\x20ftypM4A \0\0\0\0", "latin1"))), { kind: "audio", mime: "audio/mp4" });
  assert.deepEqual(sniffKind(pad(Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"))), { kind: "audio", mime: "audio/wav" });
  assert.deepEqual(sniffKind(pad(Buffer.from("fLaC\0\0\0\x22", "latin1"))), { kind: "audio", mime: "audio/flac" });
  assert.deepEqual(sniffKind(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))), { kind: "image", mime: "image/jpeg" });
  assert.deepEqual(sniffKind(pad(Buffer.from("\0\0\0\x20ftypisom\0\0\0\0", "latin1"))), { kind: "video", mime: "video/mp4" });
  assert.equal(sniffKind(pad(Buffer.from("<html><body>", "latin1"))), null);
});

test("humanElevenError: ліміт, ключ, голос, тариф, перевантаження - людською", () => {
  assert.match(humanElevenError(401, { detail: { status: "quota_exceeded", message: "This request exceeds your quota" } }), /скінчились символи/);
  assert.match(humanElevenError(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }), /ключ не прийнято/);
  assert.match(humanElevenError(401, { detail: { status: "missing_permissions", message: "missing text_to_speech" } }), /Text to Speech/);
  assert.match(humanElevenError(404, { detail: { status: "voice_not_found" } }), /Voice ID/);
  assert.match(humanElevenError(402, { detail: { status: "payment_required", message: "Free users cannot use library voices via the API" } }), /платному тарифі/);
  assert.match(humanElevenError(429, {}), /за хвилину/);
  assert.match(humanElevenError(503, {}), /тимчасово/);
  assert.equal(azureVoice("cs").locale, "cs-CZ");
  assert.equal(azureVoice("xx").locale, "uk-UA");
});

test("слова з розшифровки: Deepgram (з розділовими) і Whisper (без них) - без битих записів", () => {
  const dg = deepgramWords({ results: { channels: [{ alternatives: [{ words: [{ word: "ahoj", punctuated_word: "Ahoj,", start: 0.1, end: 0.4 }, { word: "x", start: "bad", end: 1 }] }] }] } });
  assert.deepEqual(dg, [{ w: "Ahoj,", s: 0.1, e: 0.4 }]);
  assert.deepEqual(whisperWords({ words: [{ word: " světe", start: 0.5, end: 0.9 }] }), [{ w: "světe", s: 0.5, e: 0.9 }]);
  assert.deepEqual(deepgramWords({}), []);
  assert.deepEqual(whisperWords(null), []);
});

// ---------------- 30.09: найкращі моменти, переходи, музика ----------------
import { parseFrameStats, momentScores, bestWindows, planShots as planShots2, normTransition, transitionAt, transitionDur, audioGraph, musicPrompt, normMood, MUSIC_MOODS } from "../dist/montage-plan.js";

test("parseFrameStats: вивід ffmpeg metadata=print → час, рух, світло, різкість кадру", () => {
  const txt = "frame:0    pts:0       pts_time:0\nlavfi.signalstats.YAVG=83.9\nlavfi.signalstats.YDIF=0\nlavfi.blur=4.77\nframe:1    pts:3840    pts_time:0.25\nlavfi.signalstats.YAVG=90\nlavfi.signalstats.YDIF=5.5\nlavfi.blur=3.1\n";
  const st = parseFrameStats(txt);
  assert.equal(st.length, 2);
  assert.deepEqual(st[1], { t: 0.25, ydif: 5.5, yavg: 90, blur: 3.1 });
  assert.deepEqual(parseFrameStats(""), []);
});

// синтетичний кліп 9 с: 0-4 с темно, 4-7 с різко й рівно, 7-9 с камеру трясе
const clip9 = () => Array.from({ length: 36 }, (_, i) => {
  const t = i * 0.25;
  if (t < 4) return { t, ydif: 2, yavg: 12, blur: 4 };
  if (t < 7) return { t, ydif: 3, yavg: 120, blur: 2 };
  return { t, ydif: 40, yavg: 120, blur: 9 };
});

test("momentScores: темне і трясуче - низько, різке й освітлене - високо; краї кліпу нижче", () => {
  const sc = momentScores(clip9(), 9);
  const avg = (a, b) => { const x = sc.slice(a * 4, b * 4); return x.reduce((p, c) => p + c, 0) / x.length; };
  assert.ok(avg(4.5, 6.5) > avg(1, 3.5) + 0.3, "світле й різке краще за темне");
  assert.ok(avg(4.5, 6.5) > avg(7.25, 8.5) + 0.3, "рівне краще за трясуче");
  const flat = momentScores(Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, ydif: 3, yavg: 120, blur: 3 })), 5);
  assert.ok(flat[0] < flat[10], "перші пів секунди - нижче");
});

test("bestWindows: шматок 3 с - там, де кадр найкращий, а не посередині", () => {
  const sc = momentScores(clip9(), 9);
  const [w] = bestWindows(sc, 0.25, 9, 3, 1);
  assert.ok(w >= 3.9 && w <= 4.2, "найкраще - з 4 с (середина дала б 3 с, де ще темно): " + w);
  // рівний кліп - без переваг: лишається звична середина
  assert.equal(bestWindows(Array(36).fill(0.8), 0.25, 9, 3, 1), null);
  // кліп рівно на шматок - вибору нема
  assert.deepEqual(bestWindows(sc, 0.25, 3.02, 3, 2), [0, 0]);
});

test("bestWindows: для повторів по колу - різні найкращі шматки, по порядку в кліпі", () => {
  // два добрі місця: 1-3 с і 6-8 с, решта темна
  const st = Array.from({ length: 40 }, (_, i) => { const t = i * 0.25; const good = (t >= 1 && t < 3) || (t >= 6 && t < 8); return { t, ydif: 3, yavg: good ? 120 : 10, blur: good ? 2 : 6 }; });
  const w = bestWindows(momentScores(st, 10), 0.25, 10, 2, 2);
  assert.equal(w.length, 2);
  assert.ok(w[0] >= 0.8 && w[0] <= 1.3 && w[1] >= 5.8 && w[1] <= 6.3, "обидва добрі місця, по порядку: " + w);
});

test("planShots: з оцінками кадрів - шматок із найкращого місця; from людини не чіпаємо", () => {
  const sc = momentScores(clip9(), 9);
  const p = planShots2([{ avail: 9, scores: sc, step: 0.25 }, { avail: 4 }], [3, 3], false);
  assert.ok(p.shots[0].offset >= 3.9 && p.shots[0].offset <= 4.2, "кліп 1 - з 4 с: " + p.shots[0].offset);
  assert.equal(p.shots[1].offset, 0.5, "кліп без оцінок - середина, як раніше");
  const g = planShots2([{ avail: 9, scores: sc, step: 0.25, fromGiven: true }], [3], false);
  assert.equal(g.shots[0].offset, 0, "from задала людина - з нього");
  const slow = planShots2([{ avail: 2, scores: [1, 0, 1, 0, 1, 0, 1, 0], step: 0.25 }], [3], false);
  assert.ok(slow.shots[0].speed > 1 && slow.shots[0].offset === 0, "кліп коротший за шматок - вибору нема");
});

test("переходи: режими, xfade-назви, тривалість", () => {
  assert.equal(normTransition("SLIDE"), "slide");
  assert.equal(normTransition("щось"), "fade");
  assert.equal(normTransition(undefined, "none"), "none");
  assert.equal(transitionAt("fade", 0), null, "перший кадр - без переходу");
  assert.equal(transitionAt("fade", 3), "fade");
  assert.equal(transitionAt("slide", 1), "slideleft");
  assert.equal(transitionAt("zoom", 1), "zoomin");
  assert.equal(transitionAt("flash", 1), "fadewhite");
  assert.equal(transitionAt("none", 2), null);
  assert.deepEqual([1, 2, 3, 4, 5].map((k) => transitionAt("mix", k)), ["fade", "slideleft", "zoomin", "smoothleft", "fade"]);
  assert.equal(transitionDur(3), 0.3);
  assert.equal(transitionDur(0.7), 0.245);
  assert.equal(transitionDur(0.5), 0, "кадр пів секунди - різкий стик");
});

test("audioGraph: музика притихає під голосом, під мовою кліпів, без голосу - просто фон", () => {
  const none = audioGraph({ total: 20, voice: null, music: null, keep: 1, duckOnClips: false });
  assert.equal(none, "[0:a]anull[a]");
  const v = audioGraph({ total: 20, voice: 1, music: 2, keep: 0.18, duckOnClips: false });
  assert.match(v, /\[1:a\]asplit=2\[vo\]\[vsc\]/);
  assert.match(v, /\[2:a\].*atrim=0:20\.000.*afade=t=in.*afade=t=out:st=18\.200:d=1\.8.*volume=0\.35\[m0\]/);
  assert.match(v, /\[m0\]\[vsc\]sidechaincompress/);
  assert.match(v, /amix=inputs=3.*alimiter/);
  const c = audioGraph({ total: 12, voice: null, music: 1, keep: 1, duckOnClips: true });
  assert.match(c, /\[0:a\]asplit=2\[b\]\[bsc\]/);
  assert.match(c, /\[m0\]\[bsc\]sidechaincompress/);
  const m = audioGraph({ total: 12, voice: null, music: 1, keep: 0, duckOnClips: false });
  assert.match(m, /\[0:a\]volume=0\[b\]/);
  assert.match(m, /volume=0\.8\[m0\]/, "без голосу музика гучніша");
  assert.ok(!/sidechaincompress/.test(m));
});

test("музика: настрої і промт без імен", () => {
  assert.equal(normMood("UPBEAT"), "upbeat");
  assert.equal(normMood("rock"), null);
  for (const k of Object.keys(MUSIC_MOODS)) {
    const p = musicPrompt(k);
    assert.match(p, /Instrumental/); assert.match(p, /no vocals/);
    assert.ok(p.length < 400);
  }
});

test("bestWindows: шматок довший за гарну частину - гарне на початку, темне в кінці (гачок!)", () => {
  // 12 с: 0-7 темно, 7-11 світло, 11-12 темно; шматок 4,65 с - 0,65 с темряви неминучі: хай будуть у кінці
  const st = Array.from({ length: 48 }, (_, i) => { const t = i * 0.25; const good = t >= 7 && t < 11; return { t, ydif: good ? 2 : 0, yavg: good ? 126 : 20, blur: good ? 4 : null }; });
  const [w] = bestWindows(momentScores(st, 12), 0.25, 12, 4.65, 1);
  assert.ok(w >= 6.9 && w <= 7.1, "починається зі світлого (7 с), а не з темряви (6,35): " + w);
});
