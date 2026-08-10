// Версія LinkedIn REST API.
//
// Реальна поломка: у коді стояла константа "202506". LinkedIn версіонує API помісячно і тримає
// версію активною близько 12 місяців, тож у серпні 2026 публікація в LinkedIn померла цілком з
// «Requested version 20250601 is not active». Константа - це закладена бомба з річним таймером,
// тому версія тепер рахується від дати. Тест стереже саме розрахунок: помилка тут не впаде на
// збірці й не проявиться в юніті іншого модуля - вона проявиться відмовою публікації в проді.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkedinVersion } from "../dist/linkedin.js";

test("формат рівно YYYYMM", () => {
  assert.match(linkedinVersion(new Date("2026-08-02T00:00:00Z")), /^\d{6}$/);
});

test("береться позаминулий місяць - він точно випущений і глибоко в 12-місячному вікні", () => {
  assert.equal(linkedinVersion(new Date("2026-08-02T00:00:00Z")), "202606");
  assert.equal(linkedinVersion(new Date("2026-08-31T23:59:59Z")), "202606");
});

test("перехід через Новий рік не ламає ні рік, ні місяць", () => {
  // саме тут найлегше отримати «202600» або «202513» наївною арифметикою
  assert.equal(linkedinVersion(new Date("2026-01-15T00:00:00Z")), "202511");
  assert.equal(linkedinVersion(new Date("2026-02-01T00:00:00Z")), "202512");
  assert.equal(linkedinVersion(new Date("2025-12-31T00:00:00Z")), "202510");
});

test("місяць завжди двозначний", () => {
  assert.equal(linkedinVersion(new Date("2026-03-10T00:00:00Z")), "202601");
  assert.equal(linkedinVersion(new Date("2026-11-10T00:00:00Z")), "202609");
});

test("версія ніколи не старша за 12 місяців від дати виклику", () => {
  // головна властивість: саме її порушення й поклало публікацію
  for (let m = 0; m < 36; m++) {
    const now = new Date(Date.UTC(2026, m, 15));
    const v = linkedinVersion(now);
    const y = +v.slice(0, 4), mo = +v.slice(4);
    const ageMonths = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - mo);
    assert.ok(ageMonths >= 1 && ageMonths <= 11, `${now.toISOString().slice(0, 7)} → ${v}, вік ${ageMonths} міс.`);
  }
});
