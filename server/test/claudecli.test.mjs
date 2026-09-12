// 🤖 Claude через ПІДПИСКУ (сайдкар Claude Code CLI) - місця, де помилка тиха й дорога.
//
// Що саме тут стережеться:
//  • у CLI немає режиму «відповідай лише JSON», тож увесь контракт тримає stripJsonFence. Зламай
//    його - і генерація постів мовчки поверне нуль постів, бо парсер не знайде масиву;
//  • cliModelName має за замовчуванням давати ДЕШЕВУ за квотою модель: opus їсть її ×5, і випадковий
//    дефолт «opus» спалив би підписку за день;
//  • вичерпана квота мусить впізнаватись за ТЕКСТОМ помилки, інакше кожен наступний виклик 3 хвилини
//    чекатиме таймауту замість того, щоб піти в API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCliModel, cliModelName, stripJsonFence, markCliDown, cliCooldown, resetCliCooldown } from "../dist/claudecli.js";
import { parseCliJson, looksLikeLimit } from "../claude-cli/run.mjs";

test("isCliModel відрізняє підписку від API-моделей", () => {
  assert.equal(isCliModel("claude-cli/sonnet"), true);
  assert.equal(isCliModel("openai/gpt-4o"), false);
  assert.equal(isCliModel("anthropic/claude-sonnet-4"), false);   // це ПЛАТНА модель через OpenRouter
  assert.equal(isCliModel(""), false);
});

test("cliModelName: дефолт sonnet, opus лише коли попросили явно", () => {
  assert.equal(cliModelName("claude-cli/sonnet"), "sonnet");
  assert.equal(cliModelName("claude-cli/opus"), "opus");
  assert.equal(cliModelName("claude-cli/haiku"), "haiku");
  assert.equal(cliModelName("claude-cli/"), "sonnet");
  assert.equal(cliModelName("claude-cli/щось-вигадане"), "sonnet");
});

test("stripJsonFence знімає огорожу й вступне слово, не псуючи чистий JSON", () => {
  assert.equal(stripJsonFence('{"a":1}'), '{"a":1}');
  assert.equal(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFence('```\n[1,2]\n```'), "[1,2]");
  assert.equal(stripJsonFence('Ось твої пости:\n{"posts":[]}'), '{"posts":[]}');
  // хвіст після JSON теж треба відрізати - модель любить додати «Готово!» наприкінці
  assert.equal(stripJsonFence('{"a":1}\n\nГотово!'), '{"a":1}');
});

test("stripJsonFence не ламається на дужках ВСЕРЕДИНІ рядків", () => {
  const src = '{"text":"пост про { дужки } і [масиви]","n":2}';
  assert.equal(stripJsonFence("Тримай:\n" + src), src);
  assert.deepEqual(JSON.parse(stripJsonFence("Тримай:\n" + src)).n, 2);
  // екранована лапка всередині рядка не має закривати рядок
  const esc = '{"t":"він сказав \\"так\\" }","k":1}';
  assert.equal(stripJsonFence("ось: " + esc), esc);
});

test("stripJsonFence на вкладених обʼєктах бере ЦІЛИЙ обʼєкт, а не перший закритий", () => {
  const src = '{"a":{"b":{"c":1}},"d":2}';
  assert.equal(stripJsonFence("Результат: " + src), src);
});

test("parseCliJson: чистий обʼєкт і обʼєкт після сміття в stdout", () => {
  assert.equal(parseCliJson('{"result":"ок","is_error":false}').result, "ок");
  assert.equal(parseCliJson('шум у stdout\n{"result":"ок"}').result, "ок");
  assert.equal(parseCliJson(""), null);
  assert.equal(parseCliJson("зовсім не json"), null);
});

test("looksLikeLimit ловить вичерпану квоту і не плутає її зі звичайним збоєм", () => {
  assert.equal(looksLikeLimit("Claude usage limit reached. Resets at 5pm"), true);
  assert.equal(looksLikeLimit("429 Too Many Requests"), true);
  assert.equal(looksLikeLimit("rate_limit_error"), true);
  assert.equal(looksLikeLimit("Invalid API key"), false);
  assert.equal(looksLikeLimit("timeout"), false);
});

test("кулдаун: ліміт тримає довше за мережевий збій, скидання працює", () => {
  resetCliCooldown();
  assert.equal(cliCooldown().down, false);
  const t0 = Date.now();
  markCliDown("net", "сайдкар лежить", t0);
  const net = cliCooldown();
  assert.equal(net.down, true);
  assert.match(net.why, /сайдкар/);
  markCliDown("limit", "ліміт підписки", t0);
  // квота поновлюється годинами, тож ломитись у неї щохвилини - марно палити таймаути
  assert.ok(cliCooldown().untilMs > net.untilMs);
  resetCliCooldown();
  assert.equal(cliCooldown().down, false);
});
