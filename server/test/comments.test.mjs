// 💬 Перший коментар: який текст іде в яку мережу, які збої повторювати, що бачить Claude.
// Тихі помилки тут дорогі: вважати тимчасову відмову остаточною - коментар так і не зʼявиться; вважати
// відмову в дозволі тимчасовою - три зайві запити в Meta й людина не знає, що натиснути; забути про
// сторіс чи Telegram - коментар «піде» туди, де коментарів не буває.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentFor, humanCommentError, COMMENT_NETS, COMMENT_MAX } from "../dist/comments.js";
import { commentPlanLines } from "../dist/mcp.js";

test("commentFor: свій текст мережі перекриває спільний, порожній свій = без коментаря", () => {
  const post = { first_comment: "  Спільний  ", channels: { linkedin: { on: true, first_comment: "Свій LI" }, threads: { on: true, first_comment: "" } } };
  assert.equal(commentFor(post, "instagram"), "Спільний");
  assert.equal(commentFor(post, "linkedin"), "Свій LI");
  assert.equal(commentFor(post, "threads"), "", "порожній свій текст - свідомо без коментаря, а не «взяти спільний»");
  assert.equal(commentFor({ first_comment: null, channels: {} }, "facebook"), "");
});

test("commentFor: Telegram і сторіс - ніколи", () => {
  assert.equal(commentFor({ first_comment: "x", channels: { telegram: { on: true, first_comment: "y" } } }, "telegram"), "");
  assert.equal(commentFor({ first_comment: "x", format: "story", channels: {} }, "instagram"), "");
  assert.deepEqual(COMMENT_NETS, ["instagram", "facebook", "linkedin", "threads"]);
  assert.equal(COMMENT_MAX.linkedin, 1250);
  assert.equal(COMMENT_MAX.threads, 500);
});

test("humanCommentError: відмова в дозволі - постійна, з назвою кнопки", () => {
  const ig = humanCommentError("instagram", "Meta не дає на це дозволу ((#10) Application does not have permission) - перепідключи");
  assert.equal(ig.permanent, true);
  assert.match(ig.text, /Дозволити коментарі/);
  const li = humanCommentError("linkedin", "LinkedIn HTTP 403");
  assert.equal(li.permanent, true);
  assert.match(li.text, /LinkedIn не дав застосунку дозволу/);
  const lost = humanCommentError("facebook", "Доступ до Facebook/Instagram втрачено (Meta більше не приймає токен)");
  assert.equal(lost.permanent, true);
  assert.match(lost.text, /перепідключи мережу/);
});

test("humanCommentError: ліміти, 5xx і загальна відмова Meta - тимчасові (повторимо)", () => {
  for (const [net, msg] of [
    ["facebook", "Meta просить зачекати (забагато запитів) - спробуй за кілька хвилин."],
    ["instagram", "An unexpected error has occurred. Please retry your request later."],   // Meta code 2
    ["instagram", "An unknown error has occurred."],                                         // Meta code 1
    ["threads", "Application request limit reached"],
    ["linkedin", "LinkedIn HTTP 429"],
    ["linkedin", "LinkedIn: Resource level throttle limit for calls to this resource is reached."],
    ["linkedin", "LinkedIn HTTP 503"],
    ["instagram", "Media ID is not available"],
    ["threads", "fetch failed"],
    ["facebook", "Meta timeout 20s"],
  ]) assert.equal(humanCommentError(net, msg).permanent, false, `${net}: «${msg}» мало б повторюватись`);
});

test("humanCommentError: невідома відмова (пост видалено, кривий параметр) - одразу людині, без повторів", () => {
  const r = humanCommentError("facebook", "(#100) Unsupported post request. Object with ID 'x' does not exist");
  assert.equal(r.permanent, true);
  assert.ok(r.text.length <= 300);
});

test("commentPlanLines: що піде куди - до публікації, після, зі збоєм, без дозволу", () => {
  const post = { first_comment: "Посилання: https://x", channels: { instagram: { on: true }, linkedin: { on: true, first_comment: "Свій" }, threads: { on: true, first_comment: "" }, telegram: { on: true } } };
  const nets = ["telegram", "instagram", "threads", "linkedin", "facebook"];
  const lines = commentPlanLines(post, nets,
    [{ network: "instagram", status: "sent" }, { network: "linkedin", status: "failed", error: "LinkedIn не дав застосунку дозволу" }],
    ["instagram", "linkedin"], "public_profile,pages_manage_posts");
  const text = lines.join("\n");
  assert.match(lines[0], /💬 перший коментар: «Посилання: https:\/\/x»/);
  assert.match(text, /— Telegram: без коментаря/);
  assert.match(text, /— Instagram: ✓ надіслано/);
  assert.match(text, /— Threads: без коментаря \(так задано/);
  assert.match(text, /— LinkedIn: ⚠️ не вийшов: LinkedIn не дав .* свій: «Свій»/);
  assert.match(text, /— Facebook: піде одразу після публікації ⚠️ немає дозволу на коментарі/, "дозволу нема в переліку - кажемо ДО публікації");
});

test("commentPlanLines: без коментаря - порожньо; сторіс - одним рядком; пост вийшов раніше за коментар", () => {
  assert.deepEqual(commentPlanLines({ first_comment: null, channels: { instagram: { on: true } } }, ["instagram"], [], [], null), []);
  const st = commentPlanLines({ first_comment: "x", format: "story", channels: {} }, ["instagram"], [], [], null);
  assert.equal(st.length, 1);
  assert.match(st[0], /сторіс коментарів не мають/);
  const late = commentPlanLines({ first_comment: "Пізній", channels: { instagram: { on: true } } }, ["instagram"], [], ["instagram"], null).join("\n");
  assert.match(late, /не надіслано - пост вийшов раніше, ніж зʼявився коментар \(send_first_comment\)/);
  const long = commentPlanLines({ first_comment: "я".repeat(600), channels: { threads: { on: true } } }, ["threads"], [], [], null).join("\n");
  assert.match(long, /довший за 500 знаків \(600\)/);
  // дозвіл невідомий (null - підключено до того, як ми його памʼятали) - не лякаємо попередженням
  assert.doesNotMatch(commentPlanLines({ first_comment: "x", channels: { facebook: { on: true } } }, ["facebook"], [], [], null).join("\n"), /немає дозволу/);
});
