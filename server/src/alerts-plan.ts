// 🔔 Сповіщення про збої - ЧИСТІ правила (без бази й мережі, щоб їх можна було перевірити тестами).
//
// Звідки: кожен рядок журналу (logEvent) проходить через classify(). Правило каже, що це за проблема,
// чия вона (сервісу - тоді це справа адміна, чи конкретного користувача), наскільки термінова і як
// її впізнати наступного разу (відбиток fp), щоб 1440 однакових помилок за добу дали ОДНЕ
// сповіщення, а не 1440.
//
// Правила написано за справжнім журналом прода й беті за 30 днів (30.09): «закінчились кошти» у
// OpenRouter/OpenAI/fal, ключ Deepgram/Azure, «Not Found» від Telegram, OAuth, RSS, невдалі входи.

export type Severity = "critical" | "warning";
// now - сповістити одразу; burst - лише коли повторилось N разів за 30 хв; digest - лише в денний
// звіт; none - шум (нічого не робити).
export type Notify = "now" | "burst" | "digest" | "none";
export type Verdict = {
  kind: string;
  severity: Severity;
  notify: Notify;
  burst?: number;
  title: string;
  fp: string;
  provider?: string;
  group: "service" | "users";   // проблема сервісу (адмін лагодить) чи людей (їхні канали, токени)
};

// Хто саме: з тексту помилки. Порядок важливий: «OpenRouter …» часто містить і «openai/gpt-4o».
const PROVIDERS: Array<[RegExp, string]> = [
  [/openrouter/i, "OpenRouter"],
  [/elevenlabs/i, "ElevenLabs"],
  [/deepgram/i, "Deepgram"],
  [/azure/i, "Azure Speech"],
  [/cloudflare/i, "Cloudflare"],
  [/\bkie\b|kie\.ai/i, "kie.ai"],
  [/\bfal\b|fal\.ai/i, "fal.ai"],
  [/gemini|ai\.studio|aistudio/i, "Gemini"],
  [/pexels/i, "Pexels"],
  [/resend/i, "Resend"],
  [/openai|whisper|gpt-image|platform\.openai/i, "OpenAI"],
];
/** Провайдер, згаданий у тексті ПЕРШИМ: «OpenAI: кошти скінчились - запасний маршрут через OpenRouter»
 *  - це про OpenAI, хоч OpenRouter теж у тексті. */
export function providerOf(text: string): string {
  const t = String(text || "");
  let best = "", at = Infinity;
  for (const [re, name] of PROVIDERS) {
    const m = new RegExp(re.source, re.flags.replace("g", "")).exec(t);
    if (m && m.index < at) { at = m.index; best = name; }
  }
  return best;
}

// Де поповнити / перевірити - щоб сповіщення вело одразу на потрібну сторінку, а не «піди знайди»
export const BILLING: Record<string, string> = {
  OpenRouter: "https://openrouter.ai/settings/credits",
  OpenAI: "https://platform.openai.com/settings/organization/billing/overview",
  Gemini: "https://aistudio.google.com/usage",
  "fal.ai": "https://fal.ai/dashboard/billing",
  ElevenLabs: "https://elevenlabs.io/app/subscription",
  Deepgram: "https://console.deepgram.com/",
  "Azure Speech": "https://portal.azure.com/",
  Cloudflare: "https://dash.cloudflare.com/",
  "kie.ai": "https://kie.ai/",
  Pexels: "https://www.pexels.com/api/",
  Resend: "https://resend.com/domains",
};

// Гроші/квота закінчились. Свідомо НЕ ловимо нашу ж фразу «Якщо повторюється - вичерпано квоту
// провайдера» з двозначного 429 - то може бути й просто ліміт частоти.
export const FUNDS_RX = /закінчились кошти|скінчились кошти|скінчились символи|no credits remaining|requires more credits|insufficient[_ ]quota|insufficient (credits|funds|balance)|credit balance|exceeded your current quota|\btop_?up\b|user is locked|prepayment credits|вичерпано квоту або кредити|quota_exceeded|billing_hard_limit/i;
const KEY_RX = /ключ не прийнято|не прийняв ключ|не прийняв токен|invalid[_ ]api[_ ]key|incorrect api key|authentication failed|missing the permission|нема права|missing_permissions|api key (is )?(invalid|expired|revoked)/i;
const LIMIT_RX = /денний ліміт.*вичерпано|daily free allocation/i;
const UNAVAIL_RX = /модель тимчасово недоступна|не відповіла за 60 секунд|тимчасово недоступний|не відповів за \d+|недоступний - спробуй/i;
const DB_RX = /ECONNREFUSED[^\n]*543\d|connection terminated|too many clients|deadlock detected|could not connect to server|relation "[^"]+" does not exist|column "[^"]+" does not exist|syntax error at or near|Connection terminated unexpectedly/i;
const USER_TG_RX = /токен бота недійсний|не впізнав бота|канал не знайдено|chat not found|\bnot found\b|bot was kicked|бота вигнали|нема прав|not enough rights|bot is not a member|telegram: forbidden/i;
const OAUTH_RX = /oauth|callback|state mismatch|без code|redirect|threads testers|threads_basic/i;
const URL_BLOCKED_RX = /url blocked|redirect uri is not whitelisted|redirect_uri_mismatch|не прийняв адресу/i;

const AI_PROVIDERS = new Set(["OpenRouter", "OpenAI", "Gemini", "fal.ai", "ElevenLabs", "Deepgram", "Azure Speech", "Cloudflare", "kie.ai", "Pexels", "Resend"]);
const SOURCE_SCOPES = new Set(["rss", "gdrive", "gdrive-poller", "rss-poller", "meetings", "fireflies"]);
const OAUTH_SCOPES = new Set(["meta", "threads", "linkedin", "google", "youtube", "tiktok", "auth"]);

/** Відбиток: однакові за суттю помилки (різні id, числа, пошти) - одна проблема. */
export function normMsg(s: string): string {
  return String(s || "")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

/** Прибрати з тексту все, що не має їхати в Telegram чи пошту: токени, ключі, адреси конектора. */
export function maskSecrets(s: string): string {
  return String(s || "")
    .replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "<token>")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "<key>")
    .replace(/\/(mcp|upload)\/[0-9a-f]{24,}/gi, "/$1/<token>")
    .replace(/([?&](key|token|access_token|api_key)=)[^&\s]+/gi, "$1<…>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<hex>");
}

const oneLine = (s: string, n: number) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** Що це за рядок журналу. level info - ніколи не сповіщення. */
export function classify(level: string, scope: string, message: string): Verdict {
  const sc = String(scope || "").toLowerCase();
  const msg = String(message || "");
  const none: Verdict = { kind: "noise", severity: "warning", notify: "none", title: "", fp: "", group: "service" };
  if (level !== "error" && level !== "warn") return none;
  if (sc === "alerts") return none; // власні збої сповіщень не сповіщаємо (інакше коло)
  const prov = providerOf(msg);

  // 1) гроші/квота провайдера - сервіс не працює для всіх, поки адмін не поповнить
  if (FUNDS_RX.test(msg) && (prov || /провайдера моделі/i.test(msg))) {
    const p = prov || "AI-провайдер";
    // запасний маршрут уже підхопив виклики - сервіс працює, але поповнити все одно треба
    const covered = /запасн\S* маршрут/i.test(msg);
    return { kind: "ai_funds", severity: covered ? "warning" : "critical", notify: "now", title: `${p}: закінчились кошти`, fp: `ai_funds:${p}`, provider: p, group: "service" };
  }
  // 2) безкоштовний денний ліміт (Cloudflare) - оновиться сам, але людям уже не генерується
  if (LIMIT_RX.test(msg)) {
    const p = prov || "Cloudflare";
    return { kind: "ai_limit", severity: "warning", notify: "now", title: `${p}: денний ліміт вичерпано`, fp: `ai_limit:${p}`, provider: p, group: "service" };
  }
  // 3) адреса повернення OAuth не додана в застосунок мережі - це налаштування адміна
  if (URL_BLOCKED_RX.test(msg)) {
    const net = /threads/i.test(sc + msg) ? "Threads" : /linkedin/i.test(sc + msg) ? "LinkedIn" : /google|youtube/i.test(sc + msg) ? "Google" : "Meta";
    return { kind: "oauth_config", severity: "warning", notify: "now", title: `${net}: адресу повернення не прийнято`, fp: `oauth_config:${net}`, group: "service" };
  }
  // 4) пошта не надсилається - люди не можуть підтвердити реєстрацію чи скинути пароль
  if (sc === "email" && level === "error") {
    return { kind: "email_send", severity: "critical", notify: "now", title: "Пошта не надсилається (Resend)", fp: `email_send:${normMsg(msg.replace(/^[^:]*\([^)]*\):\s*/, ""))}`, provider: "Resend", group: "service" };
  }
  // 5) ключ провайдера не приймається (Deepgram, Azure, ElevenLabs…). Токени ботів і мереж - нижче
  if (KEY_RX.test(msg) && AI_PROVIDERS.has(prov)) {
    // без ключів текстових моделей і пошти сервіс стоїть для всіх; решта (голос, розшифровка, сток) -
    // окрема функція, часто із запасним шляхом (Deepgram → Whisper, ElevenLabs → Azure)
    const core = prov === "OpenAI" || prov === "OpenRouter" || prov === "Gemini" || prov === "Resend";
    return { kind: "ai_key", severity: core ? "critical" : "warning", notify: "now", title: `${prov}: ключ не приймається`, fp: `ai_key:${prov}`, provider: prov, group: "service" };
  }
  // 6) база даних
  if (DB_RX.test(msg)) {
    return { kind: "db", severity: "critical", notify: "now", title: "База даних: помилка", fp: `db:${normMsg(msg).slice(0, 80)}`, group: "service" };
  }
  // 7) модель не відповідає (429/5xx/таймаут) - буває; сповіщаємо, лише коли це вже не випадковість
  if (UNAVAIL_RX.test(msg) && (prov || /модель/i.test(msg))) {
    const p = prov || "AI-провайдер";
    return { kind: "ai_unavailable", severity: "warning", notify: "burst", burst: 5, title: `${p}: модель не відповідає`, fp: `ai_unavailable:${p}`, provider: p, group: "service" };
  }
  // 8) збій сервера на запиті кабінету / необроблена помилка коду
  if (sc === "http") {
    const route = (/^(\S+ \S+):/.exec(msg) || [])[1] || "запит";
    return { kind: "server", severity: "warning", notify: "burst", burst: 3, title: `Помилка сервера: ${route}`, fp: `server:${normMsg(msg).slice(0, 100)}`, group: "service" };
  }
  if (sc === "process") {
    return { kind: "process", severity: "critical", notify: "now", title: "Збій коду (необроблена помилка)", fp: `process:${normMsg(msg).slice(0, 100)}`, group: "service" };
  }
  // 9) пост людини не вийшов (канал не підключено, бот не адмін тощо) - її канали, не сервіс
  if ((sc === "autopost" || sc === "comment" || sc === "publish") && /не опубліковано|не вийшов|не вийшла/i.test(msg)) {
    const reason = msg.replace(/^.*?не опубліковано:\s*/i, "").replace(/^slot \S+\s*/i, "");
    return { kind: "user_publish", severity: "warning", notify: "digest", title: `Пост не вийшов: ${oneLine(reason, 90)}`, fp: `user_publish:${normMsg(reason).slice(0, 90)}`, group: "users" };
  }
  if (sc === "autopost" && /тимчасовий збій/i.test(msg)) return { ...none, notify: "digest", kind: "retry", title: "Публікація: тимчасовий збій, повтор", fp: "retry:autopost", group: "users" };
  // 10) власні боти й канали людей
  if (USER_TG_RX.test(msg) && /tg|telegram|diary|digest|бот|канал/i.test(sc + " " + msg)) {
    return { kind: "user_tg", severity: "warning", notify: "digest", title: `Telegram людей: ${oneLine(msg.replace(/\(на сьогодні спроби вичерпано\)/, ""), 80)}`, fp: `user_tg:${normMsg(msg).slice(0, 80)}`, group: "users" };
  }
  // 11) підключення мереж людьми (скасували, не тестувальник Threads, стара вкладка)
  if (OAUTH_SCOPES.has(sc) && OAUTH_RX.test(msg)) {
    if (sc === "auth" && /невдалий вхід/i.test(msg)) return { kind: "auth_fail", severity: "warning", notify: "burst", burst: 30, title: "Багато невдалих входів", fp: "auth_fail", group: "users" };
    return { kind: "user_oauth", severity: "warning", notify: "digest", title: `Підключення ${sc}: ${oneLine(msg, 80)}`, fp: `user_oauth:${sc}:${normMsg(msg).slice(0, 60)}`, group: "users" };
  }
  if (sc === "auth" && /невдалий вхід/i.test(msg)) return { kind: "auth_fail", severity: "warning", notify: "burst", burst: 30, title: "Багато невдалих входів", fp: "auth_fail", group: "users" };
  // 12) джерела (RSS, Instagram-сторінки, Google Drive) - шум мережі, у звіт
  if (SOURCE_SCOPES.has(sc)) return { kind: "sources", severity: "warning", notify: "digest", title: "Джерела не читаються (RSS / Instagram / Drive)", fp: "sources", group: "users" };
  if (sc === "brief") return { kind: "user_brief", severity: "warning", notify: "digest", title: "Бриф не збігається з брендом", fp: "user_brief", group: "users" };
  // 13) решта: помилка - сповіщаємо, якщо повторюється; попередження - у звіт
  const fp = `${sc}:${normMsg(msg).slice(0, 100)}`;
  if (level === "error") return { kind: "other", severity: "warning", notify: "burst", burst: 3, title: `${scope}: ${oneLine(msg, 90)}`, fp, provider: prov || undefined, group: "service" };
  return { kind: "other", severity: "warning", notify: "digest", title: `${scope}: ${oneLine(msg, 90)}`, fp, provider: prov || undefined, group: "service" };
}

/** Що зробити - конкретно, з посиланням. ctx - що зараз є на сервері (запасний маршрут, ключі). */
export function hintFor(v: Pick<Verdict, "kind" | "provider">, ctx: { failover?: boolean; failoverVia?: string; hasOpenAI?: boolean } = {}): string {
  const p = v.provider || "";
  const url = BILLING[p] || "";
  switch (v.kind) {
    case "ai_funds": {
      const alt = p === "OpenRouter"
        ? (ctx.failover && ctx.failoverVia ? ` Поки не поповниш, генерація не стоїть: виклики автоматично йдуть через ${ctx.failoverVia}.` : " Або перемкни «Головну модель» кабінету на openai/gpt-4o (Інструменти).")
        : p === "OpenAI"
          ? (ctx.failover && ctx.failoverVia ? ` Тексти тим часом ідуть через ${ctx.failoverVia}; зображення gpt-image-1 і розшифровка Whisper стоять.` : " Без OpenAI не генеруються тексти за замовчуванням, зображення gpt-image-1 і розшифровка голосу Whisper.")
          : p === "fal.ai" || p === "kie.ai" || p === "Cloudflare" ? " Або обери інший провайдер зображень у Бренд → Візуал." : "";
      return `Поповни рахунок ${p}${url ? `: ${url}` : ""}.${alt}`;
    }
    case "ai_limit": return `Безкоштовний ліміт оновиться вночі (00:00 UTC). Щоб не чекати - інший провайдер зображень у Бренд → Візуал.`;
    case "ai_key": {
      const what = p === "Deepgram" ? " Поки що голосові розшифровує Whisper (OpenAI) - працює, але дорожче."
        : p === "Azure Speech" ? " Без нього AI-голос монтажу працює лише через ElevenLabs."
          : p === "ElevenLabs" ? " Без нього AI-голос монтажу йде через Azure (якщо є) або не працює." : "";
      return `Перевір ключ ${p} у Налаштування → Профіль → 🔑 Ключі провайдерів${url ? ` (кабінет провайдера: ${url})` : ""}.${what}`;
    }
    case "ai_unavailable": return `Провайдер відповідає помилками (ліміт частоти чи перевантаження). Якщо триває годинами - перевір рахунок ${p}${url ? `: ${url}` : ""}.`;
    case "email_send": return "Листи (підтвердження пошти, скидання пароля) не доходять до людей. Перевір домен і ключ у Resend: https://resend.com/domains";
    case "oauth_config": return "Додай адресу повернення цього сайту в налаштування застосунку мережі (Meta: Valid OAuth Redirect URIs; Threads: Redirect Callback URLs). Точна адреса - у кабінеті, у вікні помилки підключення.";
    case "db": return "Перевір, чи живий контейнер бази (docker compose ps) і журнал застосунку. Якщо після деплою - можливо, міграція.";
    case "server": return "Запит кабінету падає з 500. Подробиці - Налаштування → Профіль → Стан сервісу за 24 години.";
    case "process": return "Необроблена помилка в коді. Перешли цей текст розробнику (Claude) - це баг, а не налаштування.";
    case "auth_fail": return "Хтось багато разів вводить неправильний пароль. Вхід уже обмежено за частотою; якщо триває - варто глянути, з яких адрес.";
    case "tg_shared": return "Випусти новий токен у @BotFather (/mybots → бот → API Token → Revoke) і встав його: Налаштування → Профіль → 🔑 Ключі провайдерів → 🤖 Telegram-бот.";
    case "tg_hook": return "Telegram не може достукатись до сервера. Зазвичай минає саме; якщо ні - Налаштування → Профіль → 🔑 Ключі провайдерів → 🤖 Telegram-бот → Зберегти (перереєструє вебхук).";
    case "backup": return "Нічний бекап не створився. На сервері: tail /opt/socialio-backup.log - там причина (зазвичай місце на диску або зупинена база).";
    case "disk": return "Місця на диску сервера мало. Найбільше займають медіа (відео) і бекапи: /opt/socialio-backups тримає 14 днів.";
    case "buddy": return "Відкрий адресу в браузері. Не відкривається - GitHub → Actions → останній деплой (червоний?) або на сервері: docker compose ps і docker compose logs --tail=50 app.";
    case "jobs": return "Фонова задача (монтаж, публікація, генерація) висить понад пів години. Зазвичай допомагає повторити дію; якщо висить знову - журнал сервісу.";
    case "balance": return `Поповни рахунок ${p}${url ? `: ${url}` : ""}, поки не скінчилось зовсім.`;
    default: return "";
  }
}

/** Сусідній інстанс для взаємної перевірки: прод стежить за бетою, бета - за продом. */
export function buddyUrl(appBaseUrl: string, override?: string): string {
  const o = String(override || "").trim();
  if (o) return /^off$|^0$|^no$/i.test(o) ? "" : o;
  let host = "";
  try { host = new URL(appBaseUrl).host; } catch { return ""; }
  if (!host || !host.includes(".") || /^(localhost|127\.|0\.0\.0\.0|\[)/.test(host)) return "";
  return host.startsWith("beta.") ? `https://${host.slice(5)}/health` : `https://beta.${host}/health`;
}

/** Чи час нагадати ще раз: уперше - одразу; далі - лише якщо повторилось і минув проміжок. */
export function dueToNotify(a: { notified_at: string | Date | null; last_at: string | Date; severity: Severity; muted_until?: string | Date | null }, now = Date.now()): boolean {
  if (a.muted_until && new Date(a.muted_until).getTime() > now) return false;
  if (!a.notified_at) return true;
  const n = new Date(a.notified_at).getTime(), last = new Date(a.last_at).getTime();
  const remindMs = (a.severity === "critical" ? 6 : 24) * 3600_000;
  return last > n && now - n >= remindMs;
}

export type DigestGroup = { title: string; n: number; last: string; severity: Severity; group: "service" | "users"; hint?: string };
/** Денний звіт: що лишилось відкритим і що було за добу. Порожній звіт не шлемо (null). */
export function digestText(o: {
  instance: string; date: string;
  open: Array<{ title: string; severity: Severity; count: number; since: string }>;
  groups: DigestGroup[];
  stats: { published: number; failed: number; users: number; spend: number };
}): string | null {
  const svc = o.groups.filter((g) => g.group === "service").sort((a, b) => (a.severity === b.severity ? b.n - a.n : a.severity === "critical" ? -1 : 1));
  const usr = o.groups.filter((g) => g.group === "users").sort((a, b) => b.n - a.n);
  if (!o.open.length && !svc.length && !usr.length) return null;
  const L: string[] = [`🩺 ${o.instance} - звіт за добу (${o.date})`];
  if (o.open.length) {
    L.push("", "Відкрите:");
    for (const a of o.open.slice(0, 8)) L.push(`${a.severity === "critical" ? "🔴" : "🟠"} ${a.title} - з ${a.since}, ×${a.count}`);
  }
  if (svc.length) {
    L.push("", "Сервіс:");
    for (const g of svc.slice(0, 10)) L.push(`• ${g.title} ×${g.n} (востаннє ${g.last})`);
    if (svc.length > 10) L.push(`• …і ще ${svc.length - 10}`);
  }
  if (usr.length) {
    L.push("", "У людей:");
    for (const g of usr.slice(0, 8)) L.push(`• ${g.title} ×${g.n}`);
    if (usr.length > 8) L.push(`• …і ще ${usr.length - 8}`);
  }
  L.push("", `За добу: опубліковано ${o.stats.published}${o.stats.failed ? `, не вийшло ${o.stats.failed}` : ""} · нових людей ${o.stats.users} · AI $${o.stats.spend.toFixed(2)}`);
  return L.join("\n");
}
