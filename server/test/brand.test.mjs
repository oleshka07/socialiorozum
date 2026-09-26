// 🏷 Переїзд на Holos і нову адресу. Тихі помилки тут - редірект вебхука чи конектора Claude на нову
// адресу (Telegram і Claude не йдуть за 301 з POST - повідомлення й виклики просто губляться),
// редірект на ТІЙ САМІЙ адресі (нескінченне коло), або відправник листів, що лишився «socialio».
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND, brandedFrom, legacyHosts, legacyRedirect, isOurHookUrl, hostOf } from "../dist/brand.js";

const BASE = "https://holos.rozum.one";

test("brandedFrom: стару назву відправника підміняємо, решту поважаємо", () => {
  assert.equal(BRAND, "Holos");
  assert.equal(brandedFrom("socialio <noreply@rozum.one>"), "Holos <noreply@rozum.one>");
  assert.equal(brandedFrom('"Socialio" <noreply@rozum.one>'), "Holos <noreply@rozum.one>");
  assert.equal(brandedFrom("ROZUM <hello@rozum.one>"), "ROZUM <hello@rozum.one>");
  assert.equal(brandedFrom("noreply@rozum.one"), "noreply@rozum.one");
});

test("legacyHosts: лише стара адреса ЦЬОГО інстансу; до перемикання - жодної", () => {
  assert.deepEqual([...legacyHosts(BASE)], ["socialio.rozum.one"]);
  assert.deepEqual([...legacyHosts("https://beta.holos.rozum.one")], ["beta.socialio.rozum.one"]);
  // до перемикання: прод і бета живуть на старих адресах - редіректів і перенесень нема
  assert.deepEqual([...legacyHosts("https://socialio.rozum.one")], []);
  assert.deepEqual([...legacyHosts("https://beta.socialio.rozum.one")], []);
  // прод після перемикання НЕ вважає адресу беті своєю (інакше вкрав би вебхуки ботів беті)
  assert.equal(legacyHosts(BASE).has("beta.socialio.rozum.one"), false);
  assert.deepEqual([...legacyHosts(BASE, " https://Old.example.com/ , holos.rozum.one")], ["old.example.com"]);
  assert.equal(hostOf("не адреса"), "");
});

test("legacyRedirect: сторінки зі старої адреси - на нову з тим самим шляхом і query", () => {
  const legacy = legacyHosts(BASE);
  const r = (host, url, method = "GET") => legacyRedirect({ host, method, url, baseUrl: BASE, legacy });
  assert.equal(r("socialio.rozum.one", "/"), BASE + "/");
  assert.equal(r("socialio.rozum.one", "/app"), BASE + "/app");
  assert.equal(r("SOCIALIO.rozum.one:443", "/login?review=en"), BASE + "/login?review=en", "регістр і порт не важать");
  assert.equal(r("socialio.rozum.one", "/api/auth/verify?token=abc"), BASE + "/api/auth/verify?token=abc", "лист підтвердження - вхід уже на новій адресі");
  assert.equal(r("socialio.rozum.one", "/privacy", "HEAD"), BASE + "/privacy");
});

test("legacyRedirect: вебхуки, конектор, медіа, Mini App і API на старій адресі - без редіректу", () => {
  const legacy = legacyHosts(BASE);
  const r = (url, method = "GET", host = "socialio.rozum.one") => legacyRedirect({ host, method, url, baseUrl: BASE, legacy });
  for (const u of ["/api/webhooks/telegram/abc", "/mcp/" + "a".repeat(64), "/mcp/upload/" + "b".repeat(48), "/media/x.jpg",
    "/thumb/x.jpg", "/tgapp", "/api/tg/posts", "/health", "/app.js?v=1", "/favicon.svg", "/api/integrations/meta/callback?code=1"])
    assert.equal(r(u), null, u);
  assert.equal(r("/api/webhooks/telegram/abc", "POST"), null);
  assert.equal(r("/app", "POST"), null, "лише GET/HEAD");
  assert.equal(r("/app", "GET", "holos.rozum.one"), null, "на новій адресі - жодного кола");
  assert.equal(r("/app", "GET", "127.0.0.1:8080"), null, "перевірка здоровʼя з самого сервера");
  assert.equal(r("/app", "GET", ""), null);
});

test("isOurHookUrl: вебхук власного бота на цьому сервісі - і на новій, і на старій адресі; чужий - ні", () => {
  const legacy = legacyHosts(BASE);
  assert.equal(isOurHookUrl(BASE + "/api/webhooks/telegram/bot/123", BASE, legacy), true);
  assert.equal(isOurHookUrl("https://socialio.rozum.one/api/webhooks/telegram/bot/123", BASE, legacy), true);
  assert.equal(isOurHookUrl("https://socialio.rozum.one/api/webhooks/telegram/" + "c".repeat(48), BASE, legacy), true);
  assert.equal(isOurHookUrl("https://other.example.com/api/webhooks/telegram/bot/123", BASE, legacy), false);
  assert.equal(isOurHookUrl("https://socialio.rozum.one/somewhere-else", BASE, legacy), false);
  assert.equal(isOurHookUrl("", BASE, legacy), false);
  // бета (і до, і після перемикання): вебхук на прод-адресі для неї чужий
  for (const betaBase of ["https://beta.socialio.rozum.one", "https://beta.holos.rozum.one"])
    assert.equal(isOurHookUrl("https://socialio.rozum.one/api/webhooks/telegram/bot/1", betaBase, legacyHosts(betaBase)), false, betaBase);
  // прод після перемикання: вебхук на беті - чужий
  assert.equal(isOurHookUrl("https://beta.socialio.rozum.one/api/webhooks/telegram/bot/1", BASE, legacy), false);
});
