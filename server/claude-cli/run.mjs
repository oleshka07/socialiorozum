// HTTP-обгортка над `claude -p`. Слухає ЛИШЕ внутрішню мережу compose (без published ports).
//
// Контракт:
//   GET  /health            → {ok, busy, queued, model}
//   POST /run {system,user,model,maxTurns,timeoutMs}
//        → 200 {ok:true, text, cost, input_tokens, output_tokens, duration_ms, num_turns}
//        → 200 {ok:false, limit:true|false, error}    (завжди 200: збій моделі - НЕ збій транспорту,
//                                                      а мережева помилка тоді однозначно означає
//                                                      «сайдкара немає» → застосунок падає в API)
import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8090);
// Квота підписки спільна з іншими застосунками на цьому хості, і паралельні `claude -p` її просто
// спалять швидше. Черга тут, а не в застосунку: застосунок робить по 4-10 паралельних викликів
// (порівняння моделей, теми плану пачками) і не мусить знати про це обмеження.
const MAX_QUEUE = Number(process.env.CLI_MAX_QUEUE || 24);
const DEFAULT_TIMEOUT = Number(process.env.CLI_TIMEOUT_MS || 240000);
const DEFAULT_TURNS = Number(process.env.CLI_MAX_TURNS || 2);
// Вбудовані інструменти вимкнені: моделі тут нічого не треба читати чи писати на диску, а в промт
// їдуть дані користувачів - тобто будь-яка спроба інʼєкції не має куди дотягнутись.
const NO_TOOLS = "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Agent,NotebookEdit,TodoWrite,Task";

let busy = 0, queued = 0;
let chain = Promise.resolve();
/** Один процес за раз: наступний стартує лише після завершення попереднього. */
function serial(fn) {
  if (queued >= MAX_QUEUE) return Promise.resolve({ ok: false, limit: false, error: "Черга Claude CLI переповнена - спробуй за хвилину" });
  queued++;
  const run = chain.then(async () => { queued--; busy++; try { return await fn(); } finally { busy--; } });
  chain = run.then(() => {}, () => {});
  return run;
}

/** `--output-format json` дає один обʼєкт; якщо CLI домішав рядки логу - беремо останній валідний. */
export function parseCliJson(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* нижче - порядково */ }
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const j = JSON.parse(lines[i]); if (j && typeof j === "object") return j; } catch { /* далі */ }
  }
  return null;
}

/** Вичерпана квота підписки - це «прийди пізніше», а не поломка: застосунок має піти в API. */
export function looksLikeLimit(text) {
  return /\b(usage )?limit\b|rate[_ -]?limit|quota|too many requests|429|resets? at|upgrade to/i.test(String(text || ""));
}

function execClaude({ system, user, model, maxTurns, timeoutMs, appendSystem }) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "json", "--max-turns", String(maxTurns), "--disallowedTools", NO_TOOLS];
    if (model) args.push("--model", model);
    // Системну частину віддаємо окремим прапорцем - інакше вона змішується з матеріалом і модель
    // читає правила бренду як текст для переказу. Якщо прапорця в цій версії CLI немає, впадемо
    // в один суцільний промт (див. виклик нижче) - за самим текстом помилки, а не за списком версій.
    if (system && appendSystem) args.push("--append-system-prompt", system);
    const prompt = system && !appendSystem ? `${system}\n\n---\n\n${user || ""}` : (user || "");

    const child = spawn("claude", args, { cwd: "/home/app/work", env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill("SIGKILL"); } catch { /* вже помер */ } resolve({ ok: false, limit: false, error: `Claude CLI не відповів за ${Math.round(timeoutMs / 1000)}с` }); } }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: false, limit: false, error: "Claude CLI не запустився: " + e.message }); });
    child.on("close", (code) => {
      if (done) return; done = true; clearTimeout(timer);
      const unknownFlag = /unknown option|unrecognized option|--append-system-prompt/i.test(err);
      if (unknownFlag && appendSystem) { resolve({ retryWithoutFlag: true }); return; }
      const j = parseCliJson(out);
      const text = j && typeof j.result === "string" ? j.result : "";
      if (code !== 0 || !j || j.is_error || !text.trim()) {
        const msg = (text || err || `claude завершився з кодом ${code}`).slice(0, 500);
        resolve({ ok: false, limit: looksLikeLimit(msg), error: msg });
        return;
      }
      const u = j.usage || {};
      resolve({
        ok: true, text,
        cost: Number(j.total_cost_usd || 0),
        input_tokens: Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0),
        output_tokens: Number(u.output_tokens || 0),
        duration_ms: Number(j.duration_ms || 0),
        num_turns: Number(j.num_turns || 0),
      });
    });

    try { child.stdin.end(prompt); } catch { /* закриється разом із процесом */ }
  });
}

async function runOnce(body) {
  const opts = {
    system: String(body.system || ""),
    user: String(body.user || ""),
    model: body.model ? String(body.model) : "",
    maxTurns: Number(body.maxTurns) > 0 ? Number(body.maxTurns) : DEFAULT_TURNS,
    timeoutMs: Number(body.timeoutMs) > 0 ? Math.min(Number(body.timeoutMs), 600000) : DEFAULT_TIMEOUT,
    appendSystem: true,
  };
  let r = await execClaude(opts);
  if (r && r.retryWithoutFlag) r = await execClaude({ ...opts, appendSystem: false });
  return r;
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(b) }); res.end(b); };
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) return send(200, { ok: true, busy, queued, tokenSet: !!process.env.CLAUDE_CODE_OAUTH_TOKEN });
  if (req.method !== "POST" || !String(req.url).startsWith("/run")) return send(404, { ok: false, error: "not found" });
  let raw = ""; let tooBig = false;
  req.on("data", (d) => { raw += d; if (raw.length > 2_000_000) { tooBig = true; req.destroy(); } });
  req.on("end", async () => {
    if (tooBig) return send(200, { ok: false, limit: false, error: "Промт завеликий (>2 МБ)" });
    let body; try { body = JSON.parse(raw || "{}"); } catch { return send(200, { ok: false, limit: false, error: "невалідний JSON у тілі" }); }
    try { send(200, await serial(() => runOnce(body))); }
    catch (e) { send(200, { ok: false, limit: false, error: String(e && e.message || e).slice(0, 300) }); }
  });
});

// Слухаємо лише коли файл запущено як програму. Юніти імпортують звідси чисті розбирачі
// (parseCliJson / looksLikeLimit) - якби порт відкривався на імпорт, тест висів би на живому сокеті.
if (process.argv[1] && process.argv[1].endsWith("run.mjs")) {
  server.listen(PORT, "0.0.0.0", () => console.log(`[claude-cli] слухає :${PORT}; токен ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? "заданий" : "НЕ заданий"}`));
}
