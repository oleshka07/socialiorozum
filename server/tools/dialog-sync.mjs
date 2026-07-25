#!/usr/bin/env node
/**
 * dialog-sync - нічний збирач інсайтів із власних діалогів Claude Code → socialio.
 *
 * НАВІЩО. Найживіший матеріал для постів - не стороння стаття, а те, що ти САМ сформулював,
 * поки думав уголос. Публічного API для читання історії claude.ai / ChatGPT не існує, зато
 * Claude Code складає кожну сесію локально в ~/.claude/projects/<проєкт>/<uuid>.jsonl -
 * і ось це вже можна читати.
 *
 * ЩО РОБИТЬ (раз на добу):
 *   1. читає всі сесії, у яких були твої повідомлення за останні N годин;
 *   2. викидає шум: команди («так», «давай далі»), tool-результати, slash-команди, службові теги;
 *   3. дає зібране одному виклику `claude -p`, який відповідає на питання
 *      «що людина сьогодні реально зрозуміла, де передумала, який висновок можна розповісти іншому»;
 *   4. якщо цінного нема - НЕ шле нічого (пусті дні бувають, і добивати їх генерикою шкідливо);
 *   5. якщо є - POST у socialio, матеріал лягає з origin='dialog' і генерується в режимі
 *      «з власних слів автора» (факти лише з матеріалу, без вигаданих списків).
 *
 * ЗАПУСК:
 *   node dialog-sync.mjs                        # за останні 24 години
 *   node dialog-sync.mjs --hours 48             # інше вікно
 *   node dialog-sync.mjs --dry                  # дистилювати і показати, але не надсилати
 *   node dialog-sync.mjs --collect              # показати сире зібране, БЕЗ виклику моделі
 *   node dialog-sync.mjs --project socialio     # лише сесії, чий шлях містить підрядок
 *
 * URL вебхука береться з SOCIALIO_DIALOG_URL (див. Інструменти → «Власні діалоги» в кабінеті).
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true) : def;
};
const HOURS = Number(arg("hours", 24)) || 24;
const DRY = !!arg("dry", false);
const COLLECT_ONLY = !!arg("collect", false);
const PROJECT = arg("project", null);
const URL_ = (process.env.SOCIALIO_DIALOG_URL || "").trim();
const ROOT = join(homedir(), ".claude", "projects");
const STATE = join(homedir(), ".claude", "socialio-dialog-sync.json");

// Мінімум, нижче якого й пробувати не варто - у такий день просто не було про що думати вголос.
const MIN_INPUT_CHARS = 1200;

const log = (...a) => console.log("[dialog-sync]", ...a);

// ---- 1. збір власних повідомлень із JSONL Claude Code ----
// Структура рядка: {"type":"user","message":{"role":"user","content":<string|блоки>},"timestamp":"…"}.
// Твоє справжнє повідомлення = type 'user' БЕЗ toolUseResult (то результат інструмента),
// без isMeta (службове) і без isSidechain (повідомлення до сабагента, не твоє).
function collect() {
  if (!existsSync(ROOT)) { log(`нема ${ROOT} - Claude Code тут ще не працював`); return []; }
  const since = Date.now() - HOURS * 3600 * 1000;
  const out = [];
  const dirs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    if (PROJECT && typeof PROJECT === "string" && !d.name.toLowerCase().includes(String(PROJECT).toLowerCase())) continue;
    const dir = join(ROOT, d.name);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      // швидкий відсів: файл, не змінений у вікні, читати немає сенсу (сесії бувають на сотні МБ)
      try { if (statSync(p).mtimeMs < since) continue; } catch { continue; }
      let lines = [];
      try { lines = readFileSync(p, "utf8").split("\n"); } catch { continue; }
      for (const line of lines) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type !== "user" || e.isMeta || e.isSidechain || "toolUseResult" in e) continue;
        const ts = Date.parse(e.timestamp || "");
        if (!ts || ts < since) continue;
        let c = e.message?.content;
        if (Array.isArray(c)) c = c.filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
        if (typeof c !== "string") continue;
        const t = clean(c);
        if (t) out.push({ ts, project: d.name, text: t });
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ---- 2. чистка ----
// Тут навмисно жорстко: у логах сесій 80% твоїх реплік - це керування («так», «роби», «готово»),
// і якщо їх не викинути, модель на них і зафіксується, а справжні думки потонуть.
const NOISE_RX = [
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<github-webhook-activity>[\s\S]*?<\/github-webhook-activity>/g,
];
// Керувальні реплікі без змісту: «так», «давай далі», «готово», «продовжуй», «ок».
const CONTROL_RX = /^(так|ні|ок(ей)?|добре|готово|давай|продовжуй|далі|роби|зроби|завершив\??|дякую|\+|\d+)([\s,.!?:;-]|$)/i;

// ⚠️ ЗАЧИСТКА СЕКРЕТІВ. У логах сесій РЕАЛЬНО лежать вставлені колись ключі (перевірено на живих
// файлах: там знайшовся вставлений google-ключ). Ключ у матеріалі - це ключ у БД сервісу, а звідти
// потенційно і в тексті поста. Тому все, що виглядає як секрет, ріжеться ще на цій машині, ДО того
// як щось поїде в мережу. Список навмисно консервативний: точні префікси відомих провайдерів +
// env-рядки «SOMETHING_KEY=...», без евристики «довгий рядок» (вона зжерла б хеші й id, які є контекстом).
const SECRET_RX = [
  /AIza[0-9A-Za-z_-]{30,}/g,                       // Google API
  /sk-ant-[0-9A-Za-z_-]{20,}/g,                    // Anthropic
  /sk-(?:proj-)?[0-9A-Za-z_-]{20,}/g,              // OpenAI
  /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{20,}/g,   // GitHub
  /\bgithub_pat_[0-9A-Za-z_]{20,}/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/g,               // Slack
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g,                // Telegram bot token
  /\bEAA[0-9A-Za-z]{20,}/g,                        // Meta / Facebook
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/gi, // creds в DSN
  /\b[A-Z][A-Z0-9_]{2,}(?:KEY|SECRET|TOKEN|PASSWORD|PASS|DSN)\s*[=:]\s*\S+/g,           // ENV_KEY=значення
  /\bBearer\s+[0-9A-Za-z._-]{20,}/gi,
];
export function redact(t) {
  let out = t;
  for (const rx of SECRET_RX) out = out.replace(rx, "[секрет вилучено]");
  return out;
}

export function clean(raw) {
  let t = redact(String(raw));
  for (const rx of NOISE_RX) t = t.replace(rx, " ");
  t = t.replace(/\[Request interrupted[^\]]*\]/g, " ").trim();
  if (t.startsWith("/")) return ""; // slash-команда
  // дуже коротке - або керування, або уточнення на пів слова: змісту для поста там нема
  if (t.length < 40) return "";
  if (CONTROL_RX.test(t) && t.length < 120) return "";
  // вставлені портянки (транскрипти, файли, чужі пости) - це НЕ твої слова, беремо лише початок,
  // щоб вони не витіснили контекстом твої власні формулювання
  if (t.length > 4000) t = t.slice(0, 4000) + "\n[…вставлений фрагмент обрізано]";
  return t;
}

// ---- 3. дистиляція одним викликом claude -p ----
const PROMPT = `Нижче - мої власні повідомлення з робочих діалогів за добу (сирі, з різних проєктів; це те, що я писав, без відповідей асистента).

Твоє завдання: витягнути звідси те, що варто записати в мій робочий щоденник - МОЇМИ словами, від першої особи.

Шукай саме це:
- що я сьогодні зрозумів, чого не розумів зранку;
- де я передумав або визнав, що помилявся (це найцінніше);
- яке конкретне рішення я ухвалив і чому саме так;
- яке спостереження про роботу, людей, продукт чи себе я сформулював.

Правила:
- Пиши від першої особи, простою розмовною мовою, як я сам собі. Українською.
- Тільки те, що реально є в матеріалі. НЕ вигадуй за мене думок, висновків і подій.
- Зберігай конкретику: що саме, з ким, який інструмент, яка цифра. Без неї запис нічого не вартий.
- НЕ переказуй, що я робив по коду («попросив пофіксити баг») - це не інсайт. Потрібне те, що я ЗРОЗУМІВ.
- Ніяких вступів, підсумків, заголовків, списків «ключових висновків» і порад читачу.
- 1-3 абзаци. Якщо думка одна - один абзац.

Якщо за цю добу не було нічого, крім технічної роботи й команд - тобто жодного справжнього спостереження чи зміни думки - відповідь має бути рівно одне слово: ПУСТО

Матеріал:
`;

function distill(text) {
  return new Promise((resolve, reject) => {
    // shell:true - на Windows `claude` це .cmd, без шелу execFile його не знайде
    const child = execFile("claude", ["-p", "--"], { shell: true, maxBuffer: 20 * 1024 * 1024, timeout: 300000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`claude -p: ${err.message} ${String(stderr).slice(0, 300)}`));
        resolve(String(stdout).trim());
      });
    child.stdin.end(PROMPT + text, "utf8");
  });
}

// ---- 4. надсилання ----
async function send(title, text) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, text }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`socialio ${r.status}: ${body.slice(0, 300)}`);
  return body;
}

// ---- main ----
// Запуск лише як скрипт: `clean`/`redact` імпортуються юніт-тестом (test/dialog-sync.test.mjs),
// і побічні ефекти при імпорті все б зламали.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) { /* імпорт для тестів - main не виконуємо */ }
else await main();

async function main() {
const msgs = collect();
if (!msgs.length) { log("за вікно нема власних повідомлень - нічого робити"); process.exit(0); }

const joined = msgs.map((m) => `--- ${new Date(m.ts).toISOString().slice(0, 16).replace("T", " ")} [${m.project}]\n${m.text}`).join("\n\n");
log(`зібрано ${msgs.length} повідомлень, ${joined.length} симв. за ${HOURS} год.`);
if (COLLECT_ONLY) { console.log(joined); process.exit(0); }
if (joined.length < MIN_INPUT_CHARS) { log("замало матеріалу - пропускаю день"); process.exit(0); }

// вікно вводу моделі: беремо СВІЖІШЕ, якщо не влазить (пам'ять дня важливіша за ранок тижня)
const input = joined.length > 60000 ? joined.slice(-60000) : joined;

let distilled;
try { distilled = await distill(input); }
catch (e) { console.error("[dialog-sync] дистиляція не вдалась:", e.message); process.exit(1); }

const empty = /^пусто[\s.!]*$/i.test(distilled.trim());
if (empty || distilled.trim().length < 120) {
  log("модель не знайшла нічого вартого запису - нічого не надсилаю", empty ? "(ПУСТО)" : `(${distilled.trim().length} симв.)`);
  process.exit(0);
}

const d = new Date();
const title = `Діалоги, ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;

if (DRY) { log(`--dry, надіслано б як «${title}»:\n\n${distilled}\n`); process.exit(0); }
if (!URL_) { console.error("[dialog-sync] нема SOCIALIO_DIALOG_URL - візьми URL у кабінеті: Інструменти → Власні діалоги"); process.exit(1); }

try {
  const res = await send(title, distilled);
  log(`надіслано (${distilled.length} симв.):`, res.slice(0, 120));
  try { writeFileSync(STATE, JSON.stringify({ lastRun: d.toISOString(), chars: distilled.length }, null, 2)); } catch {}
} catch (e) {
  console.error("[dialog-sync] надсилання не вдалось:", e.message);
  process.exit(1);
}
}
