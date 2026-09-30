// 🎬 Монтаж v3: стилі субтитрів бренду, гачок, «до/після», фінальна картка, вирізання пауз, шаблони.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  subLook, normSubPreset, normSubPos, normHex, contrastInk, assHeader, assDoc, karaokeEvents, captionEvents, groupCues,
  hookEvents, hookSpan, hookFallback, cleanHook, baSplit, baWords, labelEvents, endCardText, endEvents,
  speechKeeps, keptSec, isFiller, templatePlan, normTemplate, TEMPLATES, TEMPLATE_ORDER, transitionFor, planShots, SUB_PRESETS, SUB_ORDER,
} from "../dist/montage-plan.js";

test("normHex / contrastInk: колір бренду → ASS і текст на плашці читається", () => {
  assert.equal(normHex("#ff2f78"), "#FF2F78");
  assert.equal(normHex("f27"), "#FF2277");
  assert.equal(normHex("червоний"), null);
  assert.equal(normHex(""), null);
  assert.equal(contrastInk("#FFD23F"), "#101014");   // жовта плашка - чорний текст
  assert.equal(contrastInk("#190D14"), "#FFFFFF");   // винна - білий
  assert.equal(contrastInk("#1E3A8A"), "#FFFFFF");   // темно-синя - білий
});

test("subLook: пресети стилю субтитрів дають різний вигляд, невідомий - класичні", () => {
  assert.equal(normSubPreset("BOX"), "box");
  assert.equal(normSubPreset("неон"), "classic");
  assert.equal(normSubPos("middle"), "middle");
  assert.equal(normSubPos("знизу"), "low");
  assert.deepEqual(SUB_ORDER.slice().sort(), Object.keys(SUB_PRESETS).sort());
  const cl = subLook("classic", "#FF2F78");
  assert.equal(cl.style.highlight, undefined);          // класичні - жовте слово, як і було
  assert.equal(cl.highlight, true);
  assert.equal(subLook("brand", "#ff2f78").style.highlight, "#FF2F78");
  const box = subLook("box");
  assert.equal(box.style.box, true);
  assert.match(assHeader(box.style), /Style: WordBox,[^\n]*,-1,0,0,0,100,100,0,0,3,14,0,2,/);   // BorderStyle 3 = плашка
  assert.match(assHeader(box.style), /Style: Word,[^\n]*,-1,0,0,0,100,100,0,0,1,0,0,2,/);       // текст над нею - без обводки
  // плашка - один шар на картку (без кольорових вставок: вставка ділить рядок, і кожен шматок мав би свою плашку)
  const bev = karaokeEvents(groupCues([{ w: "Dnes", s: 0, e: 0.4 }, { w: "řežeme", s: 0.45, e: 0.9 }]), box.style, true);
  const plates = bev.filter((e) => e.includes(",WordBox,"));
  assert.equal(plates.length, 1);
  assert.match(plates[0], /^Dialogue: 0,.*\{\\1a&HFF&\}Dnes řežeme$/);
  assert.ok(bev.filter((e) => e.includes(",Word,")).every((e) => e.startsWith("Dialogue: 1,")), "текст - над плашкою");
  assert.match(assHeader(subLook("classic").style), /Style: Word,[^\n]*,0,0,1,6,2,2,70,70,560,1/);  // як раніше
  const big = subLook("big", "#00AAFF");
  assert.equal(big.style.upper, true);
  assert.equal(big.cue.maxWords, 2);
  assert.match(assHeader(big.style), /Style: Word,DejaVu Sans,112,[^\n]*,5,70,70,0,1/);      // центр кадру
  assert.equal(subLook("minimal").highlight, false);
  assert.match(assHeader(subLook("classic", null, "middle").style), /Style: Word,[^\n]*,2,5,70,70,0,1/);
});

test("assHeader: гачок, мітки й фінальна картка мають свої стилі; плашка гачка - колір бренду з читабельним текстом", () => {
  const h = assHeader({ accent: "#190D14" });
  for (const s of ["Word", "Cap", "Hook", "LabelA", "LabelB", "End"]) assert.match(h, new RegExp(`Style: ${s},`));
  // Hook: текст білий (&H00FFFFFF), плашка вином (&H00140D19), BorderStyle 3, вгорі (8), 430 px від верху
  assert.match(h, /Style: Hook,DejaVu Sans,86,&H00FFFFFF,&H00FFFFFF,&H00140D19,[^\n]*,3,18,0,8,80,80,430,1/);
  const y = assHeader({ accent: "#FFD23F" });
  assert.match(y, /Style: Hook,DejaVu Sans,86,&H0014101[0-9A-F],/);   // на жовтій - темний текст
  assert.equal(assDoc({}, ["Dialogue: x"]).trim().split("\n").pop(), "Dialogue: x");
});

test("karaokeEvents / captionEvents: ВЕЛИКІ для «великих слів», поточне слово - кольором бренду", () => {
  const words = [{ w: "Dnes", s: 0, e: 0.3 }, { w: "řežeme", s: 0.35, e: 0.8 }, { w: "beton.", s: 0.85, e: 1.3 }];
  const look = subLook("big", "#FF2F78");
  const cues = groupCues(words, look.cue);
  assert.ok(cues.length >= 2, "по 1-2 слова на картці");
  const ev = karaokeEvents(cues, look.style, look.highlight).join("\n");
  assert.match(ev, /ŘEŽEME/);
  assert.match(ev, /\{\\1c&H00782FFF&\}DNES/);   // рожевий у форматі ASS (BGR)
  const cap = captionEvents([{ text: "Před a po", start: 0, end: 2 }], look.style).join("\n");
  assert.match(cap, /PŘED A PO/);
});

test("гачок: плашка вгорі, до 3 рядків по ~17 символів, фігурні дужки не ламають ASS", () => {
  assert.equal(hookSpan(20), 2.6);
  assert.equal(hookSpan(4), 1.6);
  assert.equal(hookSpan(2), 1.2);
  const ev = hookEvents("Ріжемо бетон під каналізацію {без пилу}", 0, 2.6);
  assert.equal(ev.length, 1);
  assert.match(ev[0], /^Dialogue: 2,0:00:00\.00,0:00:02\.60,Hook,/);
  const text = ev[0].split(",,").pop().replace(/^\{[^}]*\}/, "");
  assert.ok(!/[{}]/.test(text), "дужки з тексту прибрано");
  const lines = text.split("\\N");
  assert.ok(lines.length >= 2 && lines.length <= 3, lines.join(" | "));
  assert.ok(lines.slice(0, -1).every((l) => l.length <= 17), lines.join(" | "));
  assert.deepEqual(hookEvents("   ", 0, 2), []);
  assert.deepEqual(hookEvents("x", 2, 2), []);
});

test("hookFallback / cleanHook: перше речення до 7 слів; відповідь моделі - без лапок і хештегів", () => {
  assert.equal(hookFallback("Dělníci provrtávají beton. Zítra kopeme."), "Dělníci provrtávají beton");
  assert.equal(hookFallback("Раз два три чотири п'ять шість сім вісім девʼять"), "Раз два три чотири п'ять шість сім…");
  assert.equal(hookFallback(""), "");
  assert.equal(cleanHook("«Бетон, який ріжуть вручну» #будівництво"), "Бетон, який ріжуть вручну");
  assert.ok(cleanHook("а".repeat(90)).length <= 61);
});

test("до/після: скільки кліпів «до», мітки мовою ролика, стиль «після» - колір бренду", () => {
  assert.equal(baSplit(2), 1);
  assert.equal(baSplit(3), 2);
  assert.equal(baSplit(4), 2);
  assert.equal(baSplit(4, 3), 3);
  assert.equal(baSplit(4, 4), 2);     // «усі - до» не буває
  assert.equal(baSplit(4, 0), 2);
  assert.equal(baSplit(1), 1);
  assert.deepEqual([baWords("cs").before, baWords("cs").after], ["PŘED", "PO"]);
  assert.equal(baWords("xx").after, "ПІСЛЯ");
  const ev = labelEvents([{ text: "PŘED", start: 0, end: 3 }, { text: "PO", start: 3, end: 6, after: true }, { text: "PO", start: 7, end: 9, after: true, y: 1020 }]);
  assert.match(ev[0], /,LabelA,,0,0,0,,\{\\fad\(150,150\)\}PŘED$/);
  assert.match(ev[1], /,LabelB,/);
  assert.match(ev[2], /,LabelB,,0,0,1020,,/);
});

test("фінальна картка: свій текст, назва кабінету з ніком, пошта замість назви - лише нік, нічого - без картки", () => {
  assert.deepEqual(endCardText({ custom: "Vary Servis & Úklid\nNapište nám · 777 123 456" }), { title: "Vary Servis & Úklid", sub: "Napište nám · 777 123 456" });
  assert.deepEqual(endCardText({ custom: "Rozum | rozum.one" }), { title: "Rozum", sub: "rozum.one" });
  assert.deepEqual(endCardText({ title: "Vary Servis & Úklid | Karlovy Vary", handle: "servisvary" }), { title: "Vary Servis & Úklid", sub: "Karlovy Vary · @servisvary" });
  assert.deepEqual(endCardText({ title: "o.stepeniev@swipescape.eu", handle: "@olegalisio" }), { title: "@olegalisio", sub: "" });
  assert.deepEqual(endCardText({ title: "user:x@y.cz" }), null);
  assert.deepEqual(endCardText({}), null);
  const ev = endEvents({ title: "Vary Servis & Úklid", sub: "@servisvary" }, 10, 12.2, "#FF2F78");
  assert.match(ev[0], /^Dialogue: 1,0:00:10\.00,0:00:12\.20,End,/);
  assert.match(ev[0], /\{\\fs75\}Vary Servis & Úklid\\N\{\\fs50\\b0\\1c&H00782FFF&\}@servisvary/);
  const long = endEvents({ title: "Stavební a úklidové služby Karlovy Vary a okolí", sub: "" }, 0, 2)[0];
  assert.match(long, /\{\\fs56\}[^\\]+\\N/);   // дуже довга - дрібно і в два рядки
  assert.deepEqual(endEvents({ title: "", sub: "" }, 0, 2), []);
});

test("isFiller: «еее», «ммм», «хм», «uh» - паразити; справжні короткі слова («а», «i», «a», «ну») - ні", () => {
  for (const w of ["еее", "Ееее,", "ем", "еммм", "ммм", "хм", "uh", "umm", "ehm", "ааа", "e", "э"]) assert.ok(isFiller(w), w);
  for (const w of ["а", "і", "a", "i", "ну", "мама", "ем'яз", "Ema", "ano"]) assert.ok(!isFiller(w), w);
});

test("speechKeeps: паузи між словами довші за 0,45 с і тиша на краях вирізаються, мова лишається", () => {
  const W = (w, s, e) => ({ w, s, e });
  // мова 0,5-1,4 с · пауза 1,6 с · мова 3,0-3,9 · кліп 5 с
  const k = speechKeeps([W("Dnes", 0.5, 0.9), W("řežeme", 1.0, 1.4), W("zítra", 3.0, 3.4), W("kopeme", 3.5, 3.9)], 5);
  assert.deepEqual(k, [[0.3, 1.54], [2.92, 4.25]]);
  assert.equal(keptSec(k), 2.57);
  // «еее» посеред паузи - теж пауза
  const kf = speechKeeps([W("Dnes", 0.5, 0.9), W("řežeme", 1.0, 1.4), W("еее", 1.8, 2.6), W("zítra", 3.0, 3.4), W("kopeme", 3.5, 3.9)], 5);
  assert.deepEqual(kf, k);
  // коротка пауза (0,3 с) не ріжеться; виграш менший за 0,4 с - кліп як є
  assert.equal(speechKeeps([W("a", 0.1, 0.5), W("b", 0.8, 1.2), W("c", 1.5, 1.9)], 2.2), null);
  // мови нема чи одне слово - не чіпаємо
  assert.equal(speechKeeps([], 5), null);
  assert.equal(speechKeeps([W("ahoj", 1, 1.4)], 5), null);
  assert.equal(speechKeeps([W("еее", 1, 2), W("ммм", 2.5, 3)], 5), null);
  // слова за межами кліпу не виводять шматок за край
  const kk = speechKeeps([W("x", 0.05, 0.4), W("y", 2.0, 2.4), W("z", 2.45, 4.98)], 5);
  assert.ok(kk[0][0] === 0 && kk[kk.length - 1][1] === 5, JSON.stringify(kk));
  assert.ok(kk.every(([a, b], i) => b > a && (i === 0 || a > kk[i - 1][1])), "шматки по порядку й не перекриваються");
});

test("шаблони: чим «до/після», «говорю в камеру» і «процес» відрізняються від стандарту", () => {
  assert.deepEqual(TEMPLATE_ORDER.slice().sort(), Object.keys(TEMPLATES).sort());
  assert.equal(normTemplate("before-after"), "before_after");
  assert.equal(normTemplate("BA"), "before_after");
  assert.equal(normTemplate("vlog"), "standard");
  const st = templatePlan("standard"), ba = templatePlan("before_after"), tk = templatePlan("talking"), pr = templatePlan("process");
  assert.ok(st.smart && st.cut && !st.compare && !st.labels && st.transition === "fade");
  assert.ok(ba.compare && ba.labels && ba.boundary === "wipeleft");
  assert.ok(tk.transition === "none" && !tk.smart && tk.wholeSpeech && tk.cut);
  assert.ok(pr.fast === 2 && pr.clipSec === 2.2 && pr.transition === "mix" && !pr.cut);
  assert.equal(st.mood, null);   // музика платна - шаблон її не вмикає, лише радить
});

test("transitionFor: на стику «до → після» - шторка до 0,6 с, решта - за режимом, перший кадр - без", () => {
  assert.deepEqual(transitionFor("fade", 2, 3, { at: 2, name: "wipeleft" }), { name: "wipeleft", d: 0.6 });
  assert.deepEqual(transitionFor("fade", 2, 1, { at: 2, name: "wipeleft" }), { name: "wipeleft", d: 0.4 });
  assert.deepEqual(transitionFor("fade", 1, 3, { at: 2, name: "wipeleft" }), { name: "fade", d: 0.3 });
  assert.equal(transitionFor("none", 3, 3, null), null);
  assert.deepEqual(transitionFor("none", 2, 3, { at: 2, name: "wipeleft" }), { name: "wipeleft", d: 0.6 });   // стик видно й без переходів
  assert.equal(transitionFor("fade", 0, 3, null), null);
  assert.equal(transitionFor("fade", 1, 0.4, null), null);
});

test("planShots з fast: довгий кліп - прискорений шматок ×2 з середини чи найкращого місця, короткий - як завжди", () => {
  const { shots } = planShots([{ avail: 10, fast: 2 }, { avail: 3, fast: 2 }], [2.2, 2.2], false);
  assert.deepEqual([shots[0].take, shots[0].speed, shots[0].offset], [4.4, 0.5, 2.8]);
  assert.deepEqual([shots[1].take, shots[1].speed, shots[1].offset], [2.2, 1, 0.4]);
  // з оцінками кадрів - прискорений шматок там, де кадр найкращий (кінець кліпу світлий)
  const scores = Array.from({ length: 40 }, (_, i) => (i >= 24 ? 1 : 0.1));
  const s2 = planShots([{ avail: 10, fast: 2, scores, step: 0.25 }], [2.2], false).shots[0];
  assert.equal(s2.speed, 0.5);
  assert.ok(s2.offset >= 5.5, String(s2.offset));
});
