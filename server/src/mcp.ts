// 🔌 MCP-сервер socialio: кабінет стає інструментом Claude - БЕЗ API-ключа і без витрат на токени.
//
// НАВІЩО САМЕ ТАК. «Підключити socialio до Claude» через Anthropic API означало б: свій ключ,
// оплата за КОЖЕН токен і власний цикл агента в нас на сервері. MCP (Model Context Protocol)
// перевертає схему: думає той Claude, за якого вже сплачено підпискою (claude.ai, десктоп,
// Claude Code), а socialio дає йому РУКИ - прочитати бренд, покласти чернетку, опублікувати,
// запланувати. Наш AI при цьому не працює взагалі: текст пише Claude у чаті, ми його зберігаємо.
// Єдиний інструмент, що витрачає кредити socialio, - `generate_posts`, і це прямо написано в його
// описі, щоб модель обирала його свідомо, а не за звичкою.
//
// ТРАНСПОРТ. Streamable HTTP зі специфікації MCP: один POST з тілом JSON-RPC 2.0; відповідь -
// JSON або SSE (вирішує Accept клієнта). GET віддає 405: потік «сервер→клієнт» нам не потрібен
// (ми нічого не шлемо самі), і специфікація прямо дозволяє його не підтримувати.
//
// АВТЕНТИФІКАЦІЯ. У формі «Custom connector» на claude.ai можна ввести ЛИШЕ URL - місця під
// заголовок там немає. Тому токен живе в самому шляху: /mcp/<64 hex>. Це той самий підхід, що вже
// працює у вебхуках (Fireflies). Заголовок `Authorization: Bearer` теж приймається - для Claude
// Code, який уміє заголовки. Токен рівносильний паролю від кабінету, тому: показуємо лише
// власнику, перевипуск одним кліком (стара адреса одразу мертва), а ФОРМАТ перевіряємо ДО запиту
// в БД - інакше порожнє чи сміттєве значення зматчилось би з іншим ключем settings_block
// (ця пастка вже траплялась на токені діалогів).
import { randomBytes } from "node:crypto";
import { q, one } from "./db.js";
import { env } from "./env.js";
import { getSettingText, setSetting } from "./settings.js";
import { connectedNets, parseWhen, zonedToUtc } from "./tgcompose.js";
import { publishPostToChannels, alreadySentNetworks } from "./publisher.js";
import { generatePostsOnePass, normFormat, GOAL_LABELS } from "./pipeline.js";
import { logEvent } from "./log.js";

// ============================================================================
// 1. ПРОТОКОЛ (чисті функції - саме вони під юнітами в test/mcp.test.mjs)
// ============================================================================

// Підтримувані ревізії специфікації. Клієнт називає свою в `initialize`; якщо вона нам відома -
// відповідаємо ТІЄЮ САМОЮ (так вимагає специфікація), інакше пропонуємо найновішу свою.
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_LATEST = "2025-06-18";
export const SERVER_INFO = { name: "socialio", title: "socialio - КонтентГров", version: "1.0.0" };

export function negotiateVersion(requested?: unknown): string {
  const v = typeof requested === "string" ? requested : "";
  return MCP_PROTOCOL_VERSIONS.includes(v) ? v : MCP_LATEST;
}

export const isMcpToken = (t: unknown): boolean => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);

// Відповідати SSE лише тоді, коли клієнт JSON НЕ приймає. Специфікація вимагає від клієнта
// Accept з обома типами і лишає вибір серверу; простий JSON надійніший (жодних напіввідкритих
// зʼєднань крізь nginx), тож SSE - це запасний шлях, а не основний.
export function wantsSse(accept?: string): boolean {
  const a = String(accept || "").toLowerCase();
  if (!a.includes("text/event-stream")) return false;
  return !a.includes("application/json") && !a.includes("*/*");
}

export const sseEncode = (payload: unknown): string => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

type RpcId = string | number | null;
export const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

// ============================================================================
// 2. АРГУМЕНТИ (модель може прислати що завгодно - нормалізуємо, а не падаємо)
// ============================================================================

export const NETS = ["telegram", "instagram", "facebook", "threads", "linkedin"];
const NET_LABEL: Record<string, string> = {
  telegram: "Telegram", instagram: "Instagram", facebook: "Facebook", threads: "Threads", linkedin: "LinkedIn",
};

const str = (v: unknown, max = 8000): string => String(v ?? "").trim().slice(0, max);
const int = (v: unknown, def: number, min: number, max: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// Мережі: приймаємо і масив, і рядок «telegram, threads» - модель пише то так, то так, і падати
// через це посеред публікації безглуздо. Невідомі назви тихо відкидаємо (їх однаково нікуди слати).
export function pickNets(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\s]+/) : [];
  const out: string[] = [];
  for (const x of raw) {
    const k = String(x ?? "").trim().toLowerCase();
    if (NETS.includes(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

// Ідентифікатор поста/матеріалу. У списках ми показуємо КОРОТКИЙ id (#a1b2c3d4) - повний uuid у
// кожному рядку з'їдав би контекст ні за що. Тому приймаємо і префікс, і повний uuid, а шукаємо
// через `id::text like` - заодно це знімає цілий клас 500-к: «abc» у uuid-колонці валить запит,
// а тут просто нічого не знаходить.
export function idPattern(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/^#/, "");
  return /^[0-9a-f][0-9a-f-]{5,35}$/.test(s) ? s : null;
}

// Час публікації. Пріоритет - явний UTC/офсет в ISO; голу «стінну» дату читаємо в поясі
// воркспейсу (інакше «завтра о 9:00» вийшло б на 2-3 години раніше), а вільні фрази
// («завтра 14:30») віддаємо вже наявному парсеру бота.
export function parseIsoAt(raw: string, tz: string): Date | null {
  const s = raw.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const zoned = /(z|[+-]\d{2}:?\d{2})$/i.test(s);
  const at = zoned ? new Date(s) : zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
  return isNaN(at.getTime()) ? null : at;
}

// ============================================================================
// 3. ТОКЕН І ВОРКСПЕЙС
// ============================================================================

const TOKEN_KEY = "mcp_token";
const USED_KEY = "mcp_last_used";

export async function mcpToken(ws: string): Promise<string> {
  const cur = await getSettingText(ws, TOKEN_KEY);
  return isMcpToken(cur) ? cur : "";
}

export async function issueMcpToken(ws: string): Promise<string> {
  const t = randomBytes(32).toString("hex");
  await setSetting(ws, TOKEN_KEY, t);
  return t;
}

export const mcpUrl = (token: string): string => `${env.appBaseUrl}/mcp/${token}`;

export async function workspaceByToken(token: unknown): Promise<string | null> {
  if (!isMcpToken(token)) return null;   // гард ДО запиту в БД: інакше сміття зматчиться з іншим ключем
  const r = await one<{ workspace_id: string }>(
    `select workspace_id from settings_block where key=$1 and content=$2`, [TOKEN_KEY, token]);
  return r?.workspace_id ?? null;
}

// «Остання активність конектора» - щоб у кабінеті було видно, що підключення живе. Пишемо не
// частіше разу на 5 хв: інакше кожен tools/call давав би зайвий UPDATE.
const usedAt = new Map<string, number>();
function touchUsed(ws: string): void {
  const now = Date.now();
  if (now - (usedAt.get(ws) || 0) < 5 * 60_000) return;
  usedAt.set(ws, now);
  setSetting(ws, USED_KEY, new Date().toISOString()).catch(() => {});
}
export const mcpLastUsed = (ws: string) => getSettingText(ws, USED_KEY);

// ============================================================================
// 4. ДОПОМІЖНЕ ДЛЯ ІНСТРУМЕНТІВ
// ============================================================================

// Помилка, яку має ПРОЧИТАТИ модель (а не трактувати як збій протоколу): по специфікації такі
// повертаються всередині результату з isError, тоді Claude бачить текст і може виправитись сам.
class ToolError extends Error {}

const wsTz = async (ws: string) => (await getSettingText(ws, "timezone")) || "Europe/Kyiv";
const short = (id: string) => "#" + String(id).slice(0, 8);
const oneLine = (s: unknown, n = 140) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const fmtWhen = (d: Date | string, tz: string) =>
  new Intl.DateTimeFormat("uk-UA", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
const netList = (a: string[]) => a.map((n) => NET_LABEL[n] || n).join(", ");
const ORIGIN_LABEL: Record<string, string> = {
  mcp: "з Claude", bot: "з бота", diary: "щоденник", manual: "нотатка", rss: "RSS", topic: "тема",
  idea: "ідея", brand: "з бренду", plan: "з плану", gdrive: "Drive", takes: "тейк",
  fireflies: "транскрипт", grain: "транскрипт", meetgeek: "транскрипт",
};
const originLabel = (o: string) => ORIGIN_LABEL[o] || o;

type PostRow = {
  id: string; content: string; review: string | null; channels: any; rubric: string | null;
  intent: string | null; format: string | null; created_at: string; origin: string; media: string | null;
};
const POST_SELECT = `select p.id, p.content, p.review, p.channels, p.rubric, p.intent, p.format, p.created_at,
                            s.origin, ma.filename as media
                       from post p
                       join pipeline_run r on r.id=p.run_id
                       join source s on s.id=r.source_id
                       left join media_asset ma on ma.id=p.media_id`;

async function findPost(ws: string, raw: unknown): Promise<PostRow> {
  const pat = idPattern(raw);
  if (!pat) throw new ToolError("Вкажи id поста - короткий (#a1b2c3d4) або повний. Список: list_drafts.");
  const rows = await q<PostRow>(`${POST_SELECT} where s.workspace_id=$1 and p.id::text like $2 limit 2`, [ws, pat + "%"]);
  if (!rows.length) throw new ToolError(`Пост ${short(pat)} не знайдено в цьому кабінеті. Візьми id зі списку list_drafts.`);
  if (rows.length > 1) throw new ToolError(`На «${pat}» починається кілька постів - дай довший id.`);
  return rows[0];
}

const enabledNets = (channels: any): string[] =>
  NETS.filter((k) => channels?.[k] && channels[k].on);

// Увімкнути мережі, не затираючи вже адаптовані під них тексти (їх пише «✨ підлаштувати»).
function mergeNets(channels: any, nets: string[]): Record<string, any> {
  const cur: Record<string, any> = { ...(channels || {}) };
  for (const k of NETS) if (cur[k] && typeof cur[k] === "object") cur[k] = { ...cur[k], on: nets.includes(k) };
  for (const k of nets) if (!cur[k]) cur[k] = { on: true };
  return cur;
}

async function sentMap(ids: string[]): Promise<Map<string, { net: string; link: string | null }[]>> {
  const out = new Map<string, { net: string; link: string | null }[]>();
  if (!ids.length) return out;
  const add = (pid: string, net: string, link: string | null) => {
    const a = out.get(pid) || [];
    if (!a.some((x) => x.net === net)) a.push({ net, link });
    out.set(pid, a);
  };
  const [tg, th, mt, li] = await Promise.all([
    q<{ post_id: string; permalink: string | null }>(`select distinct post_id, permalink from telegram_publish where status='sent' and post_id=any($1)`, [ids]),
    q<{ post_id: string; permalink: string | null }>(`select distinct post_id, permalink from threads_publish where status='sent' and post_id=any($1)`, [ids]),
    q<{ post_id: string; channel: string; permalink: string | null }>(`select distinct post_id, channel, permalink from meta_publish where status='sent' and post_id=any($1)`, [ids]),
    q<{ post_id: string; permalink: string | null }>(`select distinct post_id, permalink from linkedin_publish where status='sent' and post_id=any($1)`, [ids]),
  ]);
  tg.forEach((r) => add(r.post_id, "telegram", r.permalink));
  th.forEach((r) => add(r.post_id, "threads", r.permalink));
  mt.forEach((r) => r.channel && add(r.post_id, r.channel, r.permalink));
  li.forEach((r) => add(r.post_id, "linkedin", r.permalink));
  return out;
}

// ============================================================================
// 5. ІНСТРУМЕНТИ
// ============================================================================

type ToolDef = {
  name: string;
  title: string;
  description: string;
  properties: Record<string, any>;
  required?: string[];
  readOnly?: boolean;
  run: (ws: string, a: Record<string, any>) => Promise<string>;
};

const S = (description: string, extra: Record<string, any> = {}) => ({ type: "string", description, ...extra });
const N = (description: string, extra: Record<string, any> = {}) => ({ type: "integer", description, ...extra });
const NETS_ARG = { type: "array", items: { type: "string", enum: NETS }, description: "Мережі: telegram, instagram, facebook, threads, linkedin." };

export const TOOLS: ToolDef[] = [
  {
    name: "workspace_info",
    title: "Стан кабінету",
    description: "Огляд кабінету socialio: бренд, підключені мережі, скільки чернеток, матеріалів, ідей і запланованих публікацій. Почни з цього, якщо не знаєш стану.",
    properties: {},
    readOnly: true,
    run: async (ws) => {
      const rows = await q<{ key: string; content: string }>(
        `select key, content from settings_block where workspace_id=$1 and key in ('marketing_context','brand_thesis','timezone','output_language','primary_goal')`, [ws]);
      const s: Record<string, string> = {};
      for (const r of rows) s[r.key] = r.content || "";
      const [nets, counts] = await Promise.all([
        connectedNets(ws),
        one<{ drafts: number; approved: number; materials: number; ideas: number; planned: number }>(
          `select
             (select count(*) from post p join pipeline_run r on r.id=p.run_id join source src on src.id=r.source_id
               where src.workspace_id=$1 and p.stage='final' and (p.review is null or p.review<>'archived'))::int as drafts,
             (select count(*) from post p join pipeline_run r on r.id=p.run_id join source src on src.id=r.source_id
               where src.workspace_id=$1 and p.stage='final' and p.review='approved')::int as approved,
             (select count(*) from source where workspace_id=$1 and archived=false and coalesce(transcript,'')<>'')::int as materials,
             (select count(*) from idea_bank where workspace_id=$1 and status='new')::int as ideas,
             (select count(*) from schedule_slot ss join post p on p.id=ss.post_id
                join pipeline_run r on r.id=p.run_id join source src on src.id=r.source_id
               where src.workspace_id=$1 and ss.status='planned')::int as planned`, [ws]),
      ]);
      const off = NETS.filter((n) => !nets.includes(n));
      return [
        "КАБІНЕТ socialio (КонтентГров)",
        s.marketing_context ? `Бренд і аудиторія: ${oneLine(s.marketing_context, 400)}` : "Бренд ще не заповнений (Бренд → Голос у кабінеті).",
        s.brand_thesis ? `Позиціонування: ${oneLine(s.brand_thesis, 200)}` : "",
        s.primary_goal && GOAL_LABELS[s.primary_goal] ? `Головна ціль: ${GOAL_LABELS[s.primary_goal]}` : "",
        `Мова контенту: ${s.output_language || "Українська"} · Часовий пояс: ${s.timezone || "Europe/Kyiv"}`,
        `Підключені мережі: ${nets.length ? netList(nets) : "жодної"}${off.length ? ` (не підключені: ${netList(off)})` : ""}`,
        `Чернеток: ${counts?.drafts ?? 0} (затверджених ${counts?.approved ?? 0}) · Матеріалів: ${counts?.materials ?? 0} · Ідей у банку: ${counts?.ideas ?? 0} · Заплановано: ${counts?.planned ?? 0}`,
      ].filter(Boolean).join("\n");
    },
  },
  {
    name: "brand_voice",
    title: "Голос бренду",
    description: "Повний брендовий контекст для письма: ніша, аудиторія, tone of voice, реальні приклади постів автора, рубрики, болі клієнта, стоп-слова, підпис. ВИКЛИЧ ЦЕ ПЕРЕД ТИМ, ЯК ПИСАТИ ПОСТ САМОМУ - тоді текст буде в голосі бренду і не коштуватиме кредитів socialio.",
    properties: {},
    readOnly: true,
    run: async (ws) => {
      const rows = await q<{ key: string; content: string }>(`select key, content from settings_block where workspace_id=$1`, [ws]);
      const s: Record<string, string> = {};
      for (const r of rows) s[r.key] = r.content || "";
      const rubs = await q<{ name: string; share: number; description: string }>(
        `select name, share, description from rubric where workspace_id=$1 order by idx`, [ws]);
      const block = (title: string, body: string, cap = 1200) => (body || "").trim() ? `\n## ${title}\n${body.trim().slice(0, cap)}` : "";
      return [
        "ГОЛОС БРЕНДУ (пиши пости САМЕ так; факти не вигадуй - бери з матеріалів або питай автора)",
        block("Бренд і аудиторія", s.marketing_context, 1800),
        block("Позиціонування", s.brand_thesis, 400),
        block("Болі клієнта", s.pain_points, 1200),
        block("Tone of voice", s.tone_of_voice || s.tone_of_voice_derived, 1800),
        block("Стратегічний бриф", s.strategy_brief, 1800),
        s.voice_address || s.voice_signature || s.voice_stoplist || s.voice_emoji
          ? `\n## Паспорт голосу\n${[
              s.voice_address ? `Звертання: ${s.voice_address}` : "",
              s.voice_signature ? `Підпис/фірмова фраза: ${s.voice_signature}` : "",
              s.voice_stoplist ? `Стоп-слова (НЕ вживати): ${s.voice_stoplist}` : "",
              s.voice_emoji ? `Емодзі: ${s.voice_emoji}` : "",
            ].filter(Boolean).join("\n")}`
          : "",
        rubs.length ? `\n## Рубрики (пропорції набору)\n${rubs.map((r) => `- ${r.name} ~${r.share}%${r.description ? `: ${r.description}` : ""}`).join("\n")}` : "",
        block("Приклади реальних постів автора (еталон ритму й лексики, зміст НЕ копіюй)", s.voice_examples, 2500),
        block("Правила де-AI", s.deai_rules, 400),
        `\n## Мова\n${s.output_language || "Українська"}`,
        "\nГотовий текст зберігай інструментом create_draft - він нічого не переписує і не витрачає кредитів.",
      ].filter(Boolean).join("\n");
    },
  },
  {
    name: "list_materials",
    title: "Матеріали",
    description: "Стрічка матеріалів-сировини кабінету (нотатки, щоденник, статті з RSS, транскрипти) - з оцінкою цікавості. Уривок; повний текст бери через get_material.",
    properties: { limit: N("Скільки матеріалів повернути (1-50, типово 15).", { minimum: 1, maximum: 50 }) },
    readOnly: true,
    run: async (ws, a) => {
      const tz = await wsTz(ws);
      const rows = await q<{ id: string; origin: string; title: string; preview: string; chars: number; created_at: string; ai_score: number | null }>(
        `select id, origin, coalesce(title,'(без назви)') as title, left(coalesce(transcript,''),180) as preview,
                length(transcript) as chars, created_at, ai_score
           from source where workspace_id=$1 and archived=false and coalesce(transcript,'')<>''
         order by (origin='diary') desc, created_at desc limit $2`, [ws, int(a.limit, 15, 1, 50)]);
      if (!rows.length) return "Матеріалів немає. Можеш покласти свій текст через add_material.";
      return rows.map((r) =>
        `${short(r.id)} · ${fmtWhen(r.created_at, tz)} · ${originLabel(r.origin)}${r.ai_score ? ` · ⭐${r.ai_score}/10` : ""} · ${r.chars} симв.\n${r.title}\n${oneLine(r.preview, 160)}`
      ).join("\n\n");
    },
  },
  {
    name: "get_material",
    title: "Матеріал повністю",
    description: "Повний текст одного матеріалу за id зі списку list_materials - сировина, з якої можна писати пост.",
    properties: { id: S("Id матеріалу (короткий #a1b2c3d4 або повний).") },
    required: ["id"],
    readOnly: true,
    run: async (ws, a) => {
      const pat = idPattern(a.id);
      if (!pat) throw new ToolError("Вкажи id матеріалу зі списку list_materials.");
      const rows = await q<{ id: string; title: string; origin: string; transcript: string; created_at: string }>(
        `select id, coalesce(title,'(без назви)') as title, origin, transcript, created_at
           from source where workspace_id=$1 and id::text like $2 limit 2`, [ws, pat + "%"]);
      if (!rows.length) throw new ToolError(`Матеріал ${short(pat)} не знайдено.`);
      if (rows.length > 1) throw new ToolError(`На «${pat}» починається кілька матеріалів - дай довший id.`);
      const m = rows[0];
      return `${short(m.id)} · ${originLabel(m.origin)} · ${fmtWhen(m.created_at, await wsTz(ws))}\n${m.title}\n\n${String(m.transcript || "").slice(0, 12000)}`;
    },
  },
  {
    name: "add_material",
    title: "Додати матеріал",
    description: "Покласти в кабінет сировину (нотатку, транскрипт дзвінка, чернетку думки, статтю). Це НЕ пост - матеріал лягає у стрічку, з нього потім робляться пости.",
    properties: { text: S("Текст матеріалу."), title: S("Назва (необовʼязково - інакше візьмемо перший рядок).") },
    required: ["text"],
    run: async (ws, a) => {
      const text = str(a.text, 60000);
      if (text.length < 10) throw new ToolError("Замало тексту для матеріалу (мінімум 10 символів).");
      const title = str(a.title, 120) || oneLine(text, 90);
      const src = await one<{ id: string }>(
        `insert into source(workspace_id, origin, title, transcript) values($1,'mcp',$2,$3) returning id`, [ws, title, text]);
      await q(`insert into pipeline_run(source_id) values($1)`, [src!.id]);
      return `Матеріал збережено: ${short(src!.id)} «${title}». Він у стрічці Матеріали в кабінеті.`;
    },
  },
  {
    name: "list_ideas",
    title: "Банк ідей",
    description: "Невикористані ідеї з Банку ідей кабінету (їх кладуть з чату, бота чи AI).",
    properties: { limit: N("Скільки ідей повернути (1-50, типово 20).", { minimum: 1, maximum: 50 }) },
    readOnly: true,
    run: async (ws, a) => {
      const rows = await q<{ id: string; text: string; angle: string | null; rubric: string | null; origin: string }>(
        `select id, text, angle, rubric, origin from idea_bank where workspace_id=$1 and status='new'
         order by created_at desc limit $2`, [ws, int(a.limit, 20, 1, 50)]);
      if (!rows.length) return "Банк ідей порожній. Клади ідеї через add_idea.";
      return rows.map((r) => `${short(r.id)} · ${r.origin}${r.rubric ? ` · ${r.rubric}` : ""}\n${oneLine(r.text, 200)}${r.angle ? `\nкут: ${oneLine(r.angle, 120)}` : ""}`).join("\n\n");
    },
  },
  {
    name: "add_idea",
    title: "Додати ідею",
    description: "Зберегти ідею поста в Банк ідей (без генерації тексту).",
    properties: {
      text: S("Суть ідеї."),
      angle: S("Кут подачі (необовʼязково)."),
      rubric: S("Рубрика (необовʼязково)."),
    },
    required: ["text"],
    run: async (ws, a) => {
      const text = str(a.text, 500);
      if (!text) throw new ToolError("Порожня ідея.");
      const r = await one<{ id: string }>(
        `insert into idea_bank(workspace_id, text, angle, rubric, origin) values($1,$2,$3,$4,'bot') returning id`,
        [ws, text, str(a.angle, 300) || null, str(a.rubric, 60) || null]);
      return `Ідею збережено: ${short(r!.id)}.`;
    },
  },
  {
    name: "list_drafts",
    title: "Пости кабінету",
    description: "Пости воркспейсу: чернетки, затверджені або вже опубліковані (з посиланнями). Уривок тексту; повний - через get_post.",
    properties: {
      status: S("Фільтр: all (типово), draft (не затверджені), approved (затверджені), published (вже опубліковані).", { enum: ["all", "draft", "approved", "published"] }),
      limit: N("Скільки постів повернути (1-50, типово 15).", { minimum: 1, maximum: 50 }),
    },
    readOnly: true,
    run: async (ws, a) => {
      const tz = await wsTz(ws);
      const status = ["all", "draft", "approved", "published"].includes(String(a.status)) ? String(a.status) : "all";
      const rows = await q<PostRow>(
        `${POST_SELECT} where s.workspace_id=$1 and p.stage='final' and (p.review is null or p.review<>'archived')
         order by p.created_at desc limit 120`, [ws]);
      const sent = await sentMap(rows.map((r) => r.id));
      const limit = int(a.limit, 15, 1, 50);
      const picked = rows.filter((r) => {
        const isSent = sent.has(r.id);
        if (status === "published") return isSent;
        if (status === "approved") return !isSent && r.review === "approved";
        if (status === "draft") return !isSent && r.review !== "approved";
        return true;
      }).slice(0, limit);
      if (!picked.length) return `Постів за фільтром «${status}» немає.`;
      return picked.map((r) => {
        const s = sent.get(r.id) || [];
        const state = s.length ? `опубліковано: ${netList(s.map((x) => x.net))}` : r.review === "approved" ? "затверджено" : "чернетка";
        const nets = enabledNets(r.channels);
        return [
          `${short(r.id)} · ${fmtWhen(r.created_at, tz)} · ${state}`,
          [nets.length ? `мережі: ${netList(nets)}` : "", r.rubric ? `рубрика: ${r.rubric}` : "", r.format && r.format !== "post" ? `формат: ${r.format}` : "", r.media ? "є фото" : ""].filter(Boolean).join(" · "),
          oneLine(r.content, 180),
          s.filter((x) => x.link).map((x) => `${NET_LABEL[x.net]}: ${x.link}`).join(" · "),
        ].filter(Boolean).join("\n");
      }).join("\n\n");
    },
  },
  {
    name: "get_post",
    title: "Пост повністю",
    description: "Повний текст поста, обрані мережі, персональні версії тексту під мережі, статус публікації й посилання.",
    properties: { id: S("Id поста (короткий #a1b2c3d4 або повний).") },
    required: ["id"],
    readOnly: true,
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const sent = (await sentMap([p.id])).get(p.id) || [];
      const slot = await one<{ scheduled_at: string; status: string }>(
        `select scheduled_at, status from schedule_slot where post_id=$1 order by scheduled_at limit 1`, [p.id]);
      const tz = await wsTz(ws);
      const variants = NETS.filter((n) => p.channels?.[n]?.text).map((n) => `— ${NET_LABEL[n]}: ${oneLine(p.channels[n].text, 300)}`);
      return [
        `${short(p.id)} · створено ${fmtWhen(p.created_at, tz)} · ${p.review === "approved" ? "затверджено" : "чернетка"}${p.media ? " · є фото" : ""}`,
        `мережі: ${enabledNets(p.channels).length ? netList(enabledNets(p.channels)) : "не обрані"}${p.rubric ? ` · рубрика: ${p.rubric}` : ""}${p.format && p.format !== "post" ? ` · формат: ${p.format}` : ""}`,
        slot?.scheduled_at ? `заплановано: ${fmtWhen(slot.scheduled_at, tz)} (${slot.status})` : "",
        sent.length ? `опубліковано: ${sent.map((x) => `${NET_LABEL[x.net]}${x.link ? ` ${x.link}` : ""}`).join(", ")}` : "",
        `\n${p.content}`,
        variants.length ? `\nВерсії під мережі:\n${variants.join("\n")}` : "",
      ].filter(Boolean).join("\n");
    },
  },
  {
    name: "create_draft",
    title: "Зберегти готовий пост",
    description: "ГОЛОВНИЙ інструмент: зберегти в кабінет текст, який ти написав САМ. Нічого не переписує і не витрачає AI-кредитів socialio. Перед цим візьми brand_voice, щоб писати в голосі бренду. Далі пост можна опублікувати (publish_post) або запланувати (schedule_post).",
    properties: {
      text: S("Готовий текст поста."),
      channels: NETS_ARG,
      rubric: S("Рубрика (необовʼязково)."),
      format: S("Формат: post (типово), carousel, reel, story.", { enum: ["post", "carousel", "reel", "story"] }),
      intent: S("Намір: awareness (знайомство), nurture (прогрів), sale (продаж).", { enum: ["awareness", "nurture", "sale"] }),
      approve: { type: "boolean", description: "true - одразу позначити затвердженим (готовий до календаря)." },
    },
    required: ["text"],
    run: async (ws, a) => {
      const text = str(a.text, 20000);
      if (text.length < 10) throw new ToolError("Замало тексту для поста (мінімум 10 символів).");
      let nets = pickNets(a.channels);
      const connected = await connectedNets(ws);
      const notConnected = nets.filter((n) => !connected.includes(n));
      if (!nets.length && connected.includes("telegram")) nets = ["telegram"];
      const src = await one<{ id: string }>(
        `insert into source(workspace_id, origin, title, transcript) values($1,'mcp',$2,$3) returning id`,
        [ws, oneLine(text, 90), text]);
      const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
      const post = await one<{ id: string }>(
        `insert into post(run_id, stage, content, channels, rubric, format, intent, review)
         values($1,'final',$2,$3,$4,$5,$6,$7) returning id`,
        [run!.id, text, JSON.stringify(Object.fromEntries(nets.map((n) => [n, { on: true }]))),
         str(a.rubric, 60) || null, normFormat(a.format),
         ["awareness", "nurture", "sale"].includes(String(a.intent)) ? String(a.intent) : null,
         a.approve === true ? "approved" : null]);
      await logEvent("info", "mcp", `чернетку створено з Claude (${text.length} симв.)`, null);
      return [
        `Пост збережено: ${short(post!.id)}${a.approve === true ? " (затверджено)" : " (чернетка)"}.`,
        nets.length ? `Мережі: ${netList(nets)}.` : "Мережі не обрані - вкажи їх у publish_post або схвали в кабінеті.",
        notConnected.length ? `⚠️ Не підключені в кабінеті: ${netList(notConnected)} - туди публікація не піде.` : "",
        "Далі: publish_post (опублікувати зараз) або schedule_post (на дату й час).",
      ].filter(Boolean).join(" ");
    },
  },
  {
    name: "update_post",
    title: "Змінити пост",
    description: "Поправити текст поста, обрані мережі, рубрику чи затвердити його. Текст замінюється на твій дослівно, без переписування.",
    properties: {
      id: S("Id поста."),
      text: S("Новий текст (необовʼязково)."),
      channels: NETS_ARG,
      rubric: S("Рубрика (необовʼязково)."),
      approve: { type: "boolean", description: "true - затвердити, false - зняти затвердження." },
    },
    required: ["id"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const done: string[] = [];
      const text = str(a.text, 20000);
      if (text) { await q(`update post set content=$2 where id=$1`, [p.id, text]); done.push("текст оновлено"); }
      if (a.channels !== undefined) {
        const nets = pickNets(a.channels);
        await q(`update post set channels=$2 where id=$1`, [p.id, JSON.stringify(mergeNets(p.channels, nets))]);
        done.push(nets.length ? `мережі: ${netList(nets)}` : "мережі знято");
      }
      const rubric = str(a.rubric, 60);
      if (rubric) { await q(`update post set rubric=$2 where id=$1`, [p.id, rubric]); done.push(`рубрика: ${rubric}`); }
      if (typeof a.approve === "boolean") {
        await q(`update post set review=$2 where id=$1`, [p.id, a.approve ? "approved" : null]);
        done.push(a.approve ? "затверджено" : "затвердження знято");
      }
      if (!done.length) throw new ToolError("Нічого не змінено - передай text, channels, rubric або approve.");
      return `${short(p.id)}: ${done.join(", ")}.`;
    },
  },
  {
    name: "generate_posts",
    title: "Згенерувати пости (AI socialio)",
    description: "Попросити ВЛАСНИЙ AI socialio написати N постів на тему. ⚠️ Витрачає AI-кредити кабінету. Якщо можеш написати текст сам - краще create_draft: результат той самий, кредити не витрачаються.",
    properties: {
      topic: S("Про що писати."),
      count: N("Скільки постів (1-10, типово 3).", { minimum: 1, maximum: 10 }),
      channels: NETS_ARG,
    },
    required: ["topic"],
    run: async (ws, a) => {
      const topic = str(a.topic, 1000);
      if (!topic) throw new ToolError("Напиши, про що робити пости.");
      const count = int(a.count, 3, 1, 10);
      const nets = pickNets(a.channels);
      const src = await one<{ id: string }>(
        `insert into source(workspace_id, origin, title, transcript) values($1,'topic',$2,$3) returning id`,
        [ws, topic.slice(0, 200), `Напрям для постів (пиши САМЕ про це, у голосі бренду): ${topic}`]);
      const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
      const ideas = Array.from({ length: count }, (_, i) => count > 1 ? `${topic} (кут ${i + 1}: свіжий ракурс, не повторюй попередні)` : topic);
      await generatePostsOnePass(run!.id, count, ideas);
      if (nets.length) {
        const patch = JSON.stringify(Object.fromEntries(nets.map((n) => [n, { on: true }])));
        await q(`update post set channels=coalesce(channels,'{}'::jsonb) || $2::jsonb where run_id=$1 and stage='final'`, [run!.id, patch]);
      }
      const made = await q<{ id: string; content: string }>(`select id, content from post where run_id=$1 and stage='final' order by created_at`, [run!.id]);
      return [`Згенеровано ${made.length} чернеток:`, ...made.map((m) => `${short(m.id)} ${oneLine(m.content, 160)}`)].join("\n");
    },
  },
  {
    name: "publish_post",
    title: "Опублікувати зараз",
    description: "Опублікувати пост у соцмережі ПРЯМО ЗАРАЗ. Публікація йде тим самим шляхом, що й з кабінету: дедуп «раз на мережу», авто-упаковка під формат мережі, посилання після відправки.",
    properties: {
      id: S("Id поста."),
      channels: { ...NETS_ARG, description: "Мережі (необовʼязково - інакше беруться вже обрані на пості)." },
    },
    required: ["id"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const connected = await connectedNets(ws);
      let nets = pickNets(a.channels);
      if (nets.length) await q(`update post set channels=$2 where id=$1`, [p.id, JSON.stringify(mergeNets(p.channels, nets))]);
      else nets = enabledNets(p.channels);
      if (!nets.length)
        throw new ToolError(`Не обрано жодної мережі. Підключені в кабінеті: ${connected.length ? netList(connected) : "жодної - спершу підключи канал у Налаштуваннях"}.`);
      const offline = nets.filter((n) => !connected.includes(n));
      const res = await publishPostToChannels(ws, p.id);
      // погасити запланований слот: інакше автопостер відправив би той самий пост удруге
      await q(`update schedule_slot set status='posted', result='опубліковано з Claude (MCP)' where post_id=$1 and status='planned'`, [p.id]);
      const ok = res.filter((r) => r.status === "sent").map((r) => NET_LABEL[r.channel] || r.channel);
      const skip = res.filter((r) => r.status === "skipped").map((r) => NET_LABEL[r.channel] || r.channel);
      const err = res.filter((r) => r.status === "error");
      const links = (await sentMap([p.id])).get(p.id) || [];
      if (!ok.length && err.length)
        throw new ToolError([`⚠️ Не опубліковано: ${err.map((e) => `${NET_LABEL[e.channel] || e.channel} - ${e.error}`).join("; ")}`,
          offline.length ? `Не підключені в кабінеті: ${netList(offline)} - підключи канал у Налаштуваннях.` : ""].filter(Boolean).join("\n"));
      return [
        ok.length ? `✅ Опубліковано: ${ok.join(", ")}` : "",
        skip.length ? `↩️ Пропущено (вже публікувалось): ${skip.join(", ")}` : "",
        err.length ? `⚠️ Не вийшло: ${err.map((e) => `${NET_LABEL[e.channel] || e.channel} - ${e.error}`).join("; ")}` : "",
        offline.length ? `⚠️ Не підключені: ${netList(offline)}` : "",
        links.filter((x) => x.link).map((x) => `${NET_LABEL[x.net]}: ${x.link}`).join("\n"),
      ].filter(Boolean).join("\n") || "Нічого не відправлено.";
    },
  },
  {
    name: "schedule_post",
    title: "Запланувати публікацію",
    description: "Поставити пост у календар на дату й час. Час читається в часовому поясі кабінету. Відправить автопостер - нічого додатково робити не треба.",
    properties: {
      id: S("Id поста."),
      at: S("Коли: «2026-09-14 09:00», «завтра 18:30», «14.09 09:00» або ISO з Z."),
      channels: { ...NETS_ARG, description: "Мережі (необовʼязково - інакше вже обрані на пості)." },
    },
    required: ["id", "at"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const tz = await wsTz(ws);
      const raw = str(a.at, 60);
      const at = parseIsoAt(raw, tz) || (await parseWhen(ws, raw));
      if (!at) throw new ToolError("Не зрозумів дату. Приклади: «2026-09-14 09:00», «завтра 18:30» (час обовʼязково через двокрапку).");
      if (at.getTime() < Date.now() - 60_000) throw new ToolError(`Цей час уже минув (${fmtWhen(at, tz)}). Обери майбутній.`);
      const nets = pickNets(a.channels);
      if (nets.length) await q(`update post set channels=$2 where id=$1`, [p.id, JSON.stringify(mergeNets(p.channels, nets))]);
      const on = nets.length ? nets : enabledNets(p.channels);
      if (!on.length) throw new ToolError("Спершу обери мережі (channels) - інакше автопостеру нема куди публікувати.");
      // переносимо наявний слот замість другого INSERT - інакше пост вийшов би двічі
      const ex = await one<{ id: string }>(`select id from schedule_slot where post_id=$1 and status='planned' limit 1`, [p.id]);
      if (ex) await q(`update schedule_slot set scheduled_at=$2, updated_at=now() where id=$1`, [ex.id, at.toISOString()]);
      else await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [p.id, at.toISOString()]);
      await q(`update post set review='approved' where id=$1`, [p.id]);   // запланований = затверджений
      return `🗓 ${short(p.id)} заплановано на ${fmtWhen(at, tz)} (${netList(on)}).${ex ? " Наявний слот перенесено." : ""}`;
    },
  },
  {
    name: "list_schedule",
    title: "Календар",
    description: "Що заплановано до публікації найближчими днями (і що не вийшло відправити).",
    properties: { days: N("Горизонт у днях (1-60, типово 14).", { minimum: 1, maximum: 60 }) },
    readOnly: true,
    run: async (ws, a) => {
      const tz = await wsTz(ws);
      const days = int(a.days, 14, 1, 60);
      const rows = await q<{ id: string; scheduled_at: string; status: string; result: string | null; post_id: string; content: string; channels: any }>(
        `select ss.id, ss.scheduled_at, ss.status, ss.result, p.id as post_id, p.content, coalesce(ss.channels, p.channels) as channels
           from schedule_slot ss
           join post p on p.id=ss.post_id
           join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
          where s.workspace_id=$1 and ss.scheduled_at is not null
            and ss.scheduled_at between now() - interval '2 days' and now() + ($2 || ' days')::interval
          order by ss.scheduled_at`, [ws, String(days)]);
      if (!rows.length) return `На найближчі ${days} дн. нічого не заплановано.`;
      return rows.map((r) => {
        const mark = r.status === "posted" ? "✈️" : r.status === "failed" ? "⚠️" : "🗓";
        return `${mark} ${fmtWhen(r.scheduled_at, tz)} · ${short(r.post_id)} · ${netList(enabledNets(r.channels))}${r.status === "failed" && r.result ? ` · помилка: ${oneLine(r.result, 120)}` : ""}\n${oneLine(r.content, 140)}`;
      }).join("\n\n");
    },
  },
  {
    name: "analytics",
    title: "Аналітика публікацій",
    description: "Скільки постів вийшло по мережах за період і останні опубліковані з посиланнями.",
    properties: { days: N("Період у днях (1-365, типово 30).", { minimum: 1, maximum: 365 }) },
    readOnly: true,
    run: async (ws, a) => {
      const tz = await wsTz(ws);
      const days = int(a.days, 30, 1, 365);
      const rows = await q<{ channel: string; created_at: string; permalink: string | null; content: string; post_id: string }>(
        `select x.channel, x.created_at, x.permalink, p.content, p.id as post_id from (
             select 'telegram' as channel, post_id, created_at, permalink from telegram_publish where status='sent'
             union all select 'threads', post_id, created_at, permalink from threads_publish where status='sent'
             union all select channel, post_id, created_at, permalink from meta_publish where status='sent'
             union all select 'linkedin', post_id, created_at, permalink from linkedin_publish where status='sent'
           ) x
           join post p on p.id=x.post_id
           join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
          where s.workspace_id=$1 and x.created_at > now() - ($2 || ' days')::interval
          order by x.created_at desc`, [ws, String(days)]);
      if (!rows.length) return `За ${days} дн. публікацій не було.`;
      const perNet = new Map<string, number>();
      for (const r of rows) perNet.set(r.channel, (perNet.get(r.channel) || 0) + 1);
      const recent = rows.slice(0, 10).map((r) =>
        `${fmtWhen(r.created_at, tz)} · ${NET_LABEL[r.channel] || r.channel} · ${short(r.post_id)}${r.permalink ? ` · ${r.permalink}` : ""}\n${oneLine(r.content, 120)}`);
      const cost = await one<{ usd: string }>(
        `select coalesce(sum(cost),0)::text as usd from llm_usage where workspace_id=$1 and created_at > now() - ($2 || ' days')::interval`, [ws, String(days)]);
      return [
        `За ${days} дн. опубліковано ${rows.length} постів.`,
        [...perNet.entries()].map(([n, c]) => `${NET_LABEL[n] || n}: ${c}`).join(" · "),
        `Витрати на AI socialio за період: $${Number(cost?.usd || 0).toFixed(2)}`,
        "",
        "Останні публікації:",
        ...recent,
      ].join("\n");
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Опис інструментів у вигляді, якого чекає клієнт MCP.
export function toolSpecs(): unknown[] {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: {
      type: "object",
      properties: t.properties,
      ...(t.required?.length ? { required: t.required } : {}),
      additionalProperties: false,
    },
    annotations: {
      title: t.title,
      readOnlyHint: !!t.readOnly,
      destructiveHint: false,
      idempotentHint: !!t.readOnly,
      openWorldHint: !t.readOnly,
    },
  }));
}

// Підказка клієнту, ЯК користуватись кабінетом. Без неї Claude тягнеться до generate_posts (бо
// «згенеруй» звучить знайомо) і витрачає наші кредити там, де мав би написати текст сам.
export const SERVER_INSTRUCTIONS = [
  "socialio (КонтентГров) - кабінет SMM-контенту власника цього конектора.",
  "Робочий порядок: 1) brand_voice - прочитай голос бренду; 2) напиши текст САМ у цьому голосі;",
  "3) create_draft - збережи; 4) publish_post або schedule_post. Так генерація нічого не коштує власнику.",
  "generate_posts викликай лише коли тебе прямо просять «згенеруй силами socialio» - він витрачає AI-кредити кабінету.",
  "Факти не вигадуй: бери їх з list_materials / get_material або питай автора.",
  "Перед публікацією показуй текст людині - опублікований пост відкликати не можна.",
].join(" ");

// ============================================================================
// 6. ДИСПЕТЧЕР JSON-RPC
// ============================================================================

export async function callTool(ws: string, name: string, args: Record<string, any>): Promise<{ content: unknown[]; isError?: boolean }> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { content: [{ type: "text", text: `Невідомий інструмент: ${name}` }], isError: true };
  try {
    const text = await tool.run(ws, args || {});
    return { content: [{ type: "text", text: text || "Готово." }] };
  } catch (e: any) {
    // Помилки інструмента повертаємо В РЕЗУЛЬТАТІ (isError), а не як помилку протоколу: так модель
    // бачить причину й може виправитись сама, а клієнт не рве зʼєднання.
    if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
    await logEvent("error", "mcp", `${name}: ${e?.message || e}`, null);
    return { content: [{ type: "text", text: `Не вийшло: ${e?.message || "невідома помилка"}` }], isError: true };
  }
}

// Одне повідомлення JSON-RPC → одна відповідь (або null для нотифікацій, на які відповідати не можна).
export async function handleRpc(ws: string, msg: any): Promise<any | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return rpcError(msg?.id ?? null, -32600, "Invalid Request");
  const id: RpcId = msg.id === undefined ? null : msg.id;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: negotiateVersion(msg.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: toolSpecs() });
    case "tools/call": {
      const name = String(msg.params?.name || "");
      touchUsed(ws);
      return rpcResult(id, await callTool(ws, name, msg.params?.arguments || {}));
    }
    // Ресурсів і промтів ми не оголошуємо, але деякі клієнти все одно їх питають - порожній
    // список дешевший за помилку в їхньому інтерфейсі.
    case "resources/list": return rpcResult(id, { resources: [] });
    case "resources/templates/list": return rpcResult(id, { resourceTemplates: [] });
    case "prompts/list": return rpcResult(id, { prompts: [] });
    default:
      if (isNotification || msg.method.startsWith("notifications/")) return null;  // нотифікації відповіді не мають
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

// Тіло запиту (одне повідомлення або батч 2025-03-26) → тіло відповіді; null = відповідати нічим (202).
export async function handleBody(ws: string, body: any): Promise<any | null> {
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) { const r = await handleRpc(ws, m); if (r) out.push(r); }
    return out.length ? out : null;
  }
  return handleRpc(ws, body);
}
