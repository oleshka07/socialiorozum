// Перевірка підпису Telegram Mini App. Це межа автентифікації: сюди приходить рядок від клієнта,
// і рішення «пускати чи ні» ухвалюється тут. Тому перевіряємо не лише «правильний підпис проходить»,
// а й що КОЖЕН спосіб зіпсувати його справді відхиляється.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyInitData } from "../dist/tgauth.js";

const TOKEN = "123456:FAKE-BOT-TOKEN-FOR-TESTS";
const NOW = 1785000000000;                       // фіксований «зараз», щоб тест не залежав від годинника

// зібрати валідний initData так само, як це робить Telegram
function makeInitData(fields, token = TOKEN) {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  const p = new URLSearchParams(fields);
  p.set("hash", hash);
  return p.toString();
}
const user = JSON.stringify({ id: 777, username: "oleg", first_name: "Oleg" });
// `signature` присутній у реальному initData сучасних клієнтів - тримаємо його у фікстурі,
// щоб зафіксувати: у підрахунок хеша воно ВХОДИТЬ (виключається лише `hash`).
const fresh = () => ({ user, auth_date: String(Math.floor(NOW / 1000) - 60), query_id: "AAA", signature: "abc123" });

test("валідний підпис → користувач", () => {
  const u = verifyInitData(makeInitData(fresh()), TOKEN, 86400, NOW);
  assert.deepEqual(u, { id: 777, username: "oleg", first_name: "Oleg" });
});

test("чужий токен не проходить (головне: підробити без токена не можна)", () => {
  const data = makeInitData(fresh(), "999:SOMEONE-ELSES-TOKEN");
  assert.equal(verifyInitData(data, TOKEN, 86400, NOW), null);
});

test("підмінений користувач ламає підпис", () => {
  const data = makeInitData(fresh());
  const tampered = data.replace(/user=[^&]*/, "user=" + encodeURIComponent(JSON.stringify({ id: 1, username: "hacker" })));
  assert.equal(verifyInitData(tampered, TOKEN, 86400, NOW), null);
});

test("застарілий підпис відхиляється", () => {
  const old = { ...fresh(), auth_date: String(Math.floor(NOW / 1000) - 3 * 86400) };
  assert.equal(verifyInitData(makeInitData(old), TOKEN, 86400, NOW), null);
});

test("порожнє й сміттєве не проходить", () => {
  assert.equal(verifyInitData("", TOKEN, 86400, NOW), null);
  assert.equal(verifyInitData("hash=zzz&user=%7B%7D", TOKEN, 86400, NOW), null);
  assert.equal(verifyInitData(makeInitData(fresh()), "", 86400, NOW), null, "без токена перевіряти нічим");
});

test("hash не в hex-форматі відкидається ДО обчислень", () => {
  assert.equal(verifyInitData("auth_date=1&user=%7B%7D&hash=not-a-hash", TOKEN, 86400, NOW), null);
});

test("без user підпис валідний, але пускати нікого", () => {
  const noUser = { auth_date: String(Math.floor(NOW / 1000)), query_id: "AAA" };
  assert.equal(verifyInitData(makeInitData(noUser), TOKEN, 86400, NOW), null);
});
