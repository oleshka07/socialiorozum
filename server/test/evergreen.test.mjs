// ♻️ Вічнозелена черга: правила «що повторювати, куди й коли» (чисті, без БД).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normEg, EG_DEFAULTS, dateBound, repeatNets, nextEligible, rankCandidates, hitsFrom, pickRepeatTime } from "../dist/evergreen-plan.js";

const DAY = 864e5, WEEK = 7 * DAY;
const TZ = "Europe/Prague";

test("налаштування: типово вимкнено, межі й сміття", () => {
  assert.deepEqual(normEg(undefined), EG_DEFAULTS);
  assert.equal(normEg({ on: "true" }).on, false);            // лише справжнє true вмикає
  const s = normEg({ on: true, perWeek: 99, gapWeeks: 0, maxRepeats: "4", fresh: false, autoAdd: false, minMult: 1.04 });
  assert.deepEqual(s, { on: true, perWeek: 7, gapWeeks: 2, maxRepeats: 4, fresh: false, autoAdd: false, minMult: 1.2 });
  assert.equal(normEg({ perWeek: "" }).perWeek, 2);          // порожнє поле - типове значення, не 1
});

test("прив'язка до дати: дати, дедлайни, «сьогодні», і не хибить на числах", () => {
  assert.equal(dateBound("Акція діє до 30.09 - встигни!"), "30.09");
  assert.equal(dateBound("Зустрічаємось 28 вересня о 19:00"), "28 вересня");
  assert.equal(dateBound("Сьогодні запускаємо новий тариф"), "Сьогодні");
  assert.equal(dateBound("Sleva platí jen do neděle"), "jen do");
  assert.equal(dateBound("Otevíráme 1. října"), "1. října");
  assert.equal(dateBound("Ціна виросла в 1.5 рази, а ×2.0 - норма"), null);
  assert.equal(dateBound("3 помилки, які коштують бізнесу 20% прибутку"), null);
  assert.equal(dateBound("Завтрашній день починається з плану"), null);   // «завтрашній» - не «завтра»
});

test("куди повторювати: де вийшов і досі підключено; хіт - не там, де помітно не зайшов", () => {
  const sent = ["threads", "facebook", "telegram", "threads"];
  const mults = { threads: 2.4, facebook: 0.6 };
  assert.deepEqual(repeatNets({ sent, mults, manual: false, connected: ["threads", "facebook", "telegram"] }), ["threads", "telegram"]);
  assert.deepEqual(repeatNets({ sent, mults, manual: true, connected: ["threads", "facebook", "telegram"] }), ["threads", "facebook", "telegram"]);
  assert.deepEqual(repeatNets({ sent, mults, manual: true, connected: ["telegram"] }), ["telegram"]);
});

test("черговість: активні, з ліміту, після паузи; спершу найсильніші", () => {
  const now = Date.UTC(2026, 9, 30);
  const s = normEg({ gapWeeks: 6, maxRepeats: 2 });
  const base = { status: "active", repeats: 0, lastAt: null };
  const list = [
    { ...base, postId: "fresh", bestMult: 5, firstSentAt: now - 3 * WEEK },                  // ще рано
    { ...base, postId: "ok-2x", bestMult: 2, firstSentAt: now - 10 * WEEK },
    { ...base, postId: "ok-3x", bestMult: 3, firstSentAt: now - 10 * WEEK },
    { ...base, postId: "used", bestMult: 9, firstSentAt: now - 30 * WEEK, repeats: 2 },      // ліміт вичерпано
    { ...base, postId: "recent-repeat", bestMult: 4, firstSentAt: now - 30 * WEEK, lastAt: now - 2 * WEEK },
    { ...base, postId: "off", status: "off", bestMult: 8, firstSentAt: now - 30 * WEEK },
    { ...base, postId: "no-stats", bestMult: null, firstSentAt: now - 10 * WEEK },
  ];
  assert.deepEqual(rankCandidates(list, s, now).map((c) => c.postId), ["ok-3x", "ok-2x", "no-stats"]);
  assert.equal(nextEligible({ firstSentAt: now - 3 * WEEK, lastAt: null }, 6), now + 3 * WEEK);
  assert.equal(nextEligible({ firstSentAt: null, lastAt: null }, 6), null);
});

test("хіти: найкраща мережа поста, без сторіс і повторів", () => {
  const posts = [
    { post_id: "a", mult: 1.2 }, { post_id: "a", mult: 2.1 },   // хіт у другій мережі
    { post_id: "b", mult: 1.4 },
    { post_id: "c", mult: 3, media: "story" },
    { post_id: "d", mult: 4 },                                    // повтор - пропускаємо
    { post_id: "e", mult: null },
  ];
  const h = hitsFrom(posts, 1.5, new Set(["d"]));
  assert.deepEqual([...h.entries()], [["a", 2.1]]);
});

test("час повтору: не раніше ніж за добу, день без постів цих мереж, без зіткнень", () => {
  const now = Date.UTC(2026, 9, 1, 8, 0);          // 1.10 10:00 за Прагою
  const at = (d, hh, mm = 0) => Date.UTC(2026, 9, d, hh - 2, mm);   // жовтень - ще літній час (UTC+2)
  const r1 = pickRepeatTime({ now, tz: TZ, leadH: 24, horizonDays: 8, dows: null, times: ["19:00", "09:00"], nets: ["threads"], planned: [] });
  assert.equal(r1.day, "2026-10-02");              // завтра: сьогодні ближче ніж за добу
  assert.equal(r1.time, "19:00");
  assert.equal(r1.at.toISOString(), new Date(at(2, 19)).toISOString());
  // 2.10 у Threads уже є пост - перший вибір пропускає цей день (заповнюємо паузи)
  const r2 = pickRepeatTime({ now, tz: TZ, leadH: 24, horizonDays: 8, dows: null, times: ["19:00"], nets: ["threads"],
    planned: [{ at: at(2, 11), nets: ["threads"], repeat: false }] });
  assert.equal(r2.day, "2026-10-03");
  // щодня пости - тоді день без іншого повтору, і не на ту саму хвилину (±5 хв)
  const daily = Array.from({ length: 10 }, (_, i) => ({ at: at(1 + i, 19, 3), nets: ["threads"], repeat: false }));
  const r3 = pickRepeatTime({ now, tz: TZ, leadH: 24, horizonDays: 8, dows: null, times: ["19:00", "09:00"], nets: ["threads"],
    planned: [...daily, { at: at(2, 9), nets: ["facebook"], repeat: true }] });
  assert.deepEqual([r3.day, r3.time], ["2026-10-03", "09:00"]);   // 2.10 - вже є повтор; 19:00 зайнято (19:03)
  // лише дозволені дні тижня (стратегія чи свій ритм мережі): 5.10 - понеділок
  const r4 = pickRepeatTime({ now, tz: TZ, leadH: 24, horizonDays: 8, dows: [1], times: ["10:00"], nets: ["threads"], planned: [] });
  assert.equal(r4.day, "2026-10-05");
  // без часів - 11:00; без жодного вільного дня - null
  assert.equal(pickRepeatTime({ now, tz: TZ, leadH: 24, horizonDays: 8, dows: null, times: [], nets: ["x"], planned: [] }).time, "11:00");
  assert.equal(pickRepeatTime({ now, tz: TZ, leadH: 24, horizonDays: 0, dows: null, times: ["09:00"], nets: ["x"], planned: [] }), null);
});

test("час повтору: перехід на зимовий час не зсуває годину", () => {
  const now = Date.UTC(2026, 9, 24, 8, 0);          // 24.10, до переходу (25.10 о 03:00 → 02:00)
  const r = pickRepeatTime({ now, tz: TZ, leadH: 24, horizonDays: 8, dows: null, times: ["19:00"], nets: ["threads"],
    planned: [{ at: Date.UTC(2026, 9, 25, 10), nets: ["threads"], repeat: false }] });   // 25.10 зайнятий
  assert.equal(r.day, "2026-10-26");
  assert.equal(r.at.toISOString(), "2026-10-26T18:00:00.000Z");   // 19:00 за зимовим часом (UTC+1)
});
