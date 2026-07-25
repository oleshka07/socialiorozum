// Тести збирача власних діалогів (tools/dialog-sync.mjs).
// Найважливіше тут - ЗАЧИСТКА СЕКРЕТІВ: у логах сесій Claude Code реально лежать вставлені колись
// ключі, і якщо регулярка тихо зламається, ключ поїде в БД сервісу як «матеріал», а звідти може
// доїхати й у текст поста. Тому кожен клас секрету має власний тест.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, clean } from "../tools/dialog-sync.mjs";

// ⚠️ Значення нижче СИНТЕТИЧНІ (усі містять FAKE/TEST) - вони лише матчаться регуляркою.
// Ніколи не кладіть у тести справжній ключ, навіть відкликаний: він лишиться в історії git назавжди.
test("redact вирізає ключі відомих провайдерів", () => {
  const cases = [
    "ключ AIzaSyFAKEKEYFORTESTSONLY000000000000000 постав у env",       // Google
    "sk-ant-api03-FAKEKEYFORTESTSONLY0000000000 це антропік",            // Anthropic
    "openai sk-proj-FAKEKEYFORTESTSONLY0000000000",                      // OpenAI
    "токен ghp_FAKEKEYFORTESTSONLY0000000000 для гітхаба",               // GitHub
    "github_pat_FAKEKEYFORTESTSONLY0000000000",
    "slack xoxb-0000000000-FAKEKEYFORTESTS",
    "бот 0000000000:FAKEKEYFORTESTSONLY000000000000000000",              // Telegram
    "EAAFAKEKEYFORTESTSONLY0000000000 токен меты",                       // Meta
    "postgres://user:FAKEPASSWORDFORTESTS@db.host:5432/app",             // DSN з паролем
    "OPENROUTER_API_KEY=FAKE-VALUE-FOR-TESTS",                           // env-рядок
    "Authorization: Bearer FAKEJWTFORTESTSONLY00000000",
  ];
  for (const c of cases) {
    const out = redact(c);
    assert.ok(out.includes("[секрет вилучено]"), `не вирізано: ${c.slice(0, 40)}`);
  }
});

test("redact не чіпає звичайний текст", () => {
  const t = "Сьогодні зрозумів, що нав'язував один інструмент усім партнерам без діагностики. Постачальник будинків просто відмовився.";
  assert.equal(redact(t), t);
});

test("redact не з'їдає uuid і хеші - вони бувають контекстом", () => {
  const t = "у комміті 29958e9 і в рані 2f93516a-7501-59f3-ac8c-3f093c807652 усе видно";
  assert.equal(redact(t), t);
});

test("clean викидає керувальні реплікі без змісту", () => {
  for (const t of ["так", "давай далі", "готово", "ок", "продовжуй", "роби", "+", "3"])
    assert.equal(clean(t), "", `не викинуто: ${t}`);
});

test("clean викидає slash-команди і службові блоки", () => {
  assert.equal(clean("/graphify онови графік проєкту будь ласка зараз"), "");
  assert.equal(clean("<command-name>/loop</command-name><local-command-stdout>ok</local-command-stdout>"), "");
  assert.equal(clean("[Request interrupted by user]"), "");
});

test("clean лишає справжню думку", () => {
  const t = "Зрозумів, що моя помилка була в тому, що я нав'язував одну табличку всім партнерам без діагностики - і бачив потухший погляд, але не робив висновків.";
  assert.equal(clean(t), t);
});

test("clean обрізає вставлені портянки, щоб чужий текст не витіснив власні слова", () => {
  const pasted = "А".repeat(9000);
  const out = clean(pasted);
  assert.ok(out.length < 4200, `не обрізано: ${out.length}`);
  assert.ok(out.includes("вставлений фрагмент обрізано"));
});

test("clean зачищає секрет ДО перевірки довжини (секрет у довгому тексті не проскакує)", () => {
  const out = clean("постав цей ключ у налаштування сервера, він робочий: AIzaSyFAKEKEYFORTESTSONLY000000000000000 - перевір");
  assert.ok(out.length > 0, "текст мав лишитись");
  assert.ok(!/AIza[0-9A-Za-z_-]{30}/.test(out), "ключ лишився в тексті");
  assert.ok(out.includes("[секрет вилучено]"));
});
