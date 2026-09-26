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
import { getSettingText } from "./settings.js";
import { listWorkspaces, isMember, workspaceTitle } from "./workspaces.js";
import { issueUploadLink, uploadCommands, uploadUrl, clampMinutes, UPLOAD_MAX_FILES } from "./uploadlink.js";
import { connectedNets, parseWhen, zonedToUtc } from "./tgcompose.js";
import { publishPostToChannels, alreadySentNetworks } from "./publisher.js";
import { generatePostsOnePass, normFormat, GOAL_LABELS, CHANNEL_LIMITS } from "./pipeline.js";
import { logEvent } from "./log.js";
import { generateImageForPost, imageProviders, stockPhotoOptions, attachStockPhoto, attachCroppedImage } from "./images.js";
import { getThumb } from "./media.js";
import sharp from "sharp";

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

// Помилка, яку має ПРОЧИТАТИ модель (а не трактувати як збій протоколу): по специфікації такі
// повертаються всередині результату з isError, тоді Claude бачить текст і може виправитись сам.
class ToolError extends Error {}

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

// Токен належить ЛЮДИНІ (таблиця mcp_token), а не кабінету: один конектор у Claude дає доступ до
// всіх брендів, у які людину пустили. Активний кабінет зберігається поруч із токеном - так само,
// як активний кабінет сесії живе в сесії.
export type McpCtx = { token: string; userId: string; wsId: string; wsTitle: string; wsCount: number };

export async function mcpTokenFor(userId: string): Promise<string> {
  const r = await one<{ token: string }>(`select token from mcp_token where user_id=$1 order by created_at desc limit 1`, [userId]);
  return r?.token || "";
}

export async function issueMcpToken(userId: string, activeWsId?: string): Promise<string> {
  const t = randomBytes(32).toString("hex");
  // одна людина - одна адреса: перевипуск має вбивати стару, інакше «відкликав» нічого не значить
  await q(`delete from mcp_token where user_id=$1`, [userId]);
  // стартує в тому кабінеті, з якого адресу створили; далі конектор має власний активний кабінет
  // і НЕ ходить за перемиканням у браузері (інакше клік у кабінеті тихо міняв би бренд у Claude)
  await q(`insert into mcp_token(token, user_id, active_workspace_id) values($1,$2,$3)`, [t, userId, activeWsId ?? null]);
  return t;
}

export const revokeMcpToken = (userId: string) => q(`delete from mcp_token where user_id=$1`, [userId]);
export const mcpUrl = (token: string): string => `${env.appBaseUrl}/mcp/${token}`;
export const mcpLastUsed = async (userId: string): Promise<string> =>
  (await one<{ t: string }>(`select last_used_at::text as t from mcp_token where user_id=$1`, [userId]))?.t || "";

// Один запит на HTTP-виклик: хто це, у якому кабінеті зараз і скільки їх узагалі.
// Членство перевіряється тим самим join - відкликаний доступ повертає людину в домашній кабінет.
export async function resolveToken(token: unknown): Promise<McpCtx | null> {
  if (!isMcpToken(token)) return null;   // гард ДО запиту в БД
  const r = await one<{ user_id: string; ws_id: string; ws_title: string; ws_count: number }>(
    `select t.user_id,
            coalesce(m.workspace_id, u.workspace_id) as ws_id,
            coalesce(nullif(btrim(w.title),''), replace(w.name,'user:','')) as ws_title,
            (select count(*) from workspace_member where user_id = t.user_id)::int as ws_count
       from mcp_token t
       join app_user u on u.id = t.user_id
       left join workspace_member m on m.workspace_id = t.active_workspace_id and m.user_id = t.user_id
       left join workspace w on w.id = coalesce(m.workspace_id, u.workspace_id)
      where t.token = $1 and u.deleted_at is null`, [token]);
  if (!r) return null;
  return { token: String(token), userId: r.user_id, wsId: r.ws_id, wsTitle: r.ws_title || "кабінет", wsCount: r.ws_count || 1 };
}

// Кабінет, названий у аргументі: приймаємо id, його початок або частину назви - модель пише як
// їй зручно, а помилитись тут дорого (пост поїхав би не в той бренд).
async function resolveWsArg(userId: string, raw: unknown): Promise<{ id: string; title: string }> {
  // «#2e422005» - рівно так list_workspaces показує id, тож модель його так і передає; без зрізання
  // решітки кабінет «не знаходився», хоча був у списку двома рядками вище
  const want = String(raw ?? "").trim().toLowerCase().replace(/^#/, "");
  const list = await listWorkspaces(userId);
  if (!want) throw new ToolError("Вкажи кабінет. Список: list_workspaces.");
  const hit = list.filter((w) => w.id === want || w.id.startsWith(want) || w.title.toLowerCase().includes(want));
  if (!hit.length) throw new ToolError(`Кабінет «${raw}» не знайдено. Доступні: ${list.map((w) => w.title).join(", ") || "жодного"}.`);
  if (hit.length > 1) throw new ToolError(`Під «${raw}» підходить кілька: ${hit.map((w) => w.title).join(", ")}. Уточни.`);
  return { id: hit[0].id, title: hit[0].title };
}

// «Остання активність конектора» - щоб у кабінеті було видно, що підключення живе. Пишемо не
// частіше разу на 5 хв: інакше кожен tools/call давав би зайвий UPDATE.
const usedAt = new Map<string, number>();
function touchUsed(token: string): void {
  const now = Date.now();
  if (now - (usedAt.get(token) || 0) < 5 * 60_000) return;
  usedAt.set(token, now);
  q(`update mcp_token set last_used_at=now() where token=$1`, [token]).catch(() => {});
}

// ============================================================================
// 4. ДОПОМІЖНЕ ДЛЯ ІНСТРУМЕНТІВ
// ============================================================================


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

/**
 * Як текст піде в кожну мережу - видно ДО публікації, а не після. «Дослівно» чи «спакується моделлю
 * кабінету» - це різниця між текстом, який людина затвердила, і переписаним; раніше її не показував
 * жоден інструмент, і тихе переписування помічали лише в самій мережі.
 */
export function publishPlan(channels: any, content: string): { net: string; mode: "own" | "verbatim" | "auto"; len: number; limit: number }[] {
  return enabledNets(channels).map((net) => {
    const own = String(channels?.[net]?.text || "").trim();
    const mode = own ? "own" : channels?.manual_adapt === true ? "verbatim" : "auto";
    return { net, mode, len: (own || String(content || "")).length, limit: CHANNEL_LIMITS[net] || 0 };
  });
}
// Де перевищення ліміту = відмова мережі. Telegram довгий підпис шле окремим повідомленням, а
// 2000 для Facebook - наша рекомендація, не стіна.
const HARD_WALL = new Set(["threads", "instagram", "linkedin"]);
export function publishPlanLine(plan: ReturnType<typeof publishPlan>): string {
  return plan.map(({ net, mode, len, limit }) => {
    const how = mode === "own" ? "своя версія" : mode === "verbatim" ? "дослівно" : "спакується моделлю кабінету";
    const over = mode !== "auto" && HARD_WALL.has(net) && limit > 0 && len > limit ? " ⚠️ довше за ліміт - мережа не прийме" : "";
    return `${NET_LABEL[net] || net} - ${how} (${len}${limit ? `/${limit}` : " симв."})${over}`;
  }).join(" · ");
}

// Увімкнути мережі, не затираючи вже адаптовані під них тексти (їх пише «✨ підлаштувати»).
function mergeNets(channels: any, nets: string[]): Record<string, any> {
  const cur: Record<string, any> = { ...(channels || {}) };
  for (const k of NETS) if (cur[k] && typeof cur[k] === "object") cur[k] = { ...cur[k], on: nets.includes(k) };
  for (const k of nets) if (!cur[k]) cur[k] = { on: true };
  return cur;
}

/**
 * Мережі поста, текст якого написав Claude. Одна мережа означає, що текст писали САМЕ під неї, тож
 * публікація має взяти його дослівно. Без позначки publishPostToChannels бачить мережу «без своєї
 * версії» і переписує текст моделлю кабінету: платно, з брифом, якого автор міг і не підтверджувати,
 * і всупереч обіцянці create_draft «нічого не переписує». Позначка та сама, що ставить Lite при
 * генерації під одну мережу (manual_adapt + native), тож обидва шляхи поводяться однаково.
 *
 * authoredNow: текст написано в цьому ж виклику. Коли Claude лише обирає, куди відправити ЧУЖИЙ пост
 * (зроблений у кабінеті), позначку не ставимо: довгий майстер-текст там має спакуватись під ліміт,
 * а не впасти на ньому. Кілька мереж = майстер-текст, і авто-упаковка під кожну лишається.
 */
export function authoredChannels(channels: any, nets: string[], authoredNow: boolean): Record<string, any> {
  const cur = mergeNets(channels, nets);
  const authored = authoredNow || typeof cur.native === "string";
  if (authored && nets.length === 1) { cur.manual_adapt = true; cur.native = nets[0]; }
  else if (nets.length !== 1 && typeof cur.native === "string") { delete cur.native; delete cur.manual_adapt; }
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

// Інструмент може віддати не лише текст, а й картинки. Вони йдуть ОКРЕМИМИ блоками MCP: так модель
// бачить, що саме пропонує сток чи що згенерувалось, і обирає очима, а не за підписом фотографа.
export type ToolImage = { data: string; mimeType: string };
export type ToolOut = { text: string; images?: ToolImage[] };

type ToolDef = {
  name: string;
  title: string;
  description: string;
  properties: Record<string, any>;
  required?: string[];
  readOnly?: boolean;
  run: (ws: string, a: Record<string, any>, ctx: McpCtx) => Promise<string | ToolOut>;
};

/** Результат інструмента → content MCP: спершу текст (з назвою кабінету), далі картинки. */
export function toContent(head: string, out: string | ToolOut): unknown[] {
  const o: ToolOut = typeof out === "string" ? { text: out } : out;
  const blocks: unknown[] = [{ type: "text", text: head + (o.text || "Готово.") }];
  for (const im of o.images || []) if (im?.data) blocks.push({ type: "image", data: im.data, mimeType: im.mimeType || "image/jpeg" });
  return blocks;
}

// Мініатюри для відповіді: маленькі (≤320px, JPEG), бо кожна картинка йде в контекст моделі.
async function urlThumb(url: string): Promise<ToolImage | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!res.ok) return null;
    const small = await sharp(Buffer.from(await res.arrayBuffer())).resize(320, 320, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    return { data: small.toString("base64"), mimeType: "image/jpeg" };
  } catch { return null; }
}
async function fileThumb(filename: string): Promise<ToolImage | null> {
  const buf = await getThumb(filename);
  return buf ? { data: buf.toString("base64"), mimeType: "image/jpeg" } : null;
}

// Мініатюри для СПИСКУ дрібніші за звичайні: 12 штук у одній відповіді мають лишатись легкими,
// а щоб обрати фото під пост, 256 пікселів вистачає
async function smallThumb(filename: string): Promise<ToolImage | null> {
  const buf = await getThumb(filename);
  if (!buf) return null;
  try {
    const small = await sharp(buf).resize(256, 256, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 65 }).toBuffer();
    return { data: small.toString("base64"), mimeType: "image/jpeg" };
  } catch { return null; }
}

// ---- медіатека кабінету ----
// Власні фото автора: завантажені в кабінет, із Google Drive, надіслані боту чи в щоденник.
// Похідне (кропи під пости, AI, сток, технічні копії) за замовчуванням не показуємо: це копії
// того, що вже стоїть у постах, і вони лише розмивали б вибір.
export const OWN_MEDIA = ["upload", "gdrive", "diary", "bot"];
export const GEN_MEDIA = ["ai", "pexels"];
const MEDIA_PAGE = 12;
const MEDIA_SRC: Record<string, string> = { upload: "завантажено", gdrive: "Google Drive", diary: "щоденник", bot: "з бота", ai: "AI", pexels: "сток" };
// Де фото вже стоїть: напряму (post.media_id) або через кроп-копію під формат поста, яку
// attachCroppedImage позначає external_id = id оригіналу. Кропи, зроблені до цієї позначки,
// відстежити нема як - такі фото просто виглядають вільними.
const USED_IN = `(select string_agg(left(p.id::text, 8), ',' order by p.created_at desc)
                    from post p left join media_asset c on c.id = p.media_id
                   where p.media_id = a.id or (c.source = 'crop' and c.external_id = a.id::text))`;
export const usedList = (usedIn: string | null | undefined): string =>
  String(usedIn || "").split(",").filter(Boolean).map((x) => "#" + x).join(", ");

const ASPECTS = ["4:5", "1:1", "16:9"];
const aspectArg = (v: unknown): string => (ASPECTS.includes(String(v)) ? String(v) : "4:5");

const S = (description: string, extra: Record<string, any> = {}) => ({ type: "string", description, ...extra });
const N = (description: string, extra: Record<string, any> = {}) => ({ type: "integer", description, ...extra });
const NETS_ARG = { type: "array", items: { type: "string", enum: NETS }, description: "Мережі: telegram, instagram, facebook, threads, linkedin." };
const ASPECT_ARG = { type: "string", enum: ASPECTS, description: "Формат: 4:5 (типово - найбільше місця в стрічці, підходить усім мережам), 1:1, 16:9." };

// Інструменти кабінетів свідомо БЕЗ аргументу workspace (див. WS_ARG): перемикати кабінет,
// перебуваючи в іншому кабінеті, - це зайва плутанина на рівному місці.
export const TOOLS: ToolDef[] = [
  {
    name: "list_workspaces",
    title: "Кабінети (бренди)",
    description: "Список кабінетів, до яких у власника конектора є доступ, і який зараз активний. Якщо кабінет один - усе працює як завжди, питання вибору не виникає.",
    properties: {},
    readOnly: true,
    run: async (_ws, _a, ctx) => {
      const list = await listWorkspaces(ctx.userId);
      if (list.length < 2) return `Кабінет один: ${ctx.wsTitle}. Усі інструменти працюють із ним.`;
      return ["Кабінети (активний позначено ▸):", ...list.map((w) =>
        `${w.id === ctx.wsId ? "▸" : " "} ${short(w.id)} ${w.title}${w.role === "owner" ? " (власник)" : ""}`),
        "", "Перемкнути: switch_workspace. Разова дія в іншому кабінеті: аргумент workspace у будь-якому інструменті."].join("\n");
    },
  },
  {
    name: "switch_workspace",
    title: "Перемкнути кабінет",
    description: "Зробити інший кабінет (бренд) активним для всіх наступних викликів. Перемикання зберігається між чатами - воно живе на конекторі, а не в розмові.",
    properties: { workspace: S("Назва кабінету або його id зі списку list_workspaces.") },
    required: ["workspace"],
    run: async (_ws, a, ctx) => {
      const w = await resolveWsArg(ctx.userId, a.workspace);
      await q(`update mcp_token set active_workspace_id=$2 where token=$1`, [ctx.token, w.id]);
      return `Активний кабінет: ${w.title}. Наступні виклики підуть саме в нього.`;
    },
  },
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
        enabledNets(p.channels).length ? `публікація: ${publishPlanLine(publishPlan(p.channels, p.content))}` : "",
        sent.length ? `опубліковано: ${sent.map((x) => `${NET_LABEL[x.net]}${x.link ? ` ${x.link}` : ""}`).join(", ")}` : "",
        `\n${p.content}`,
        variants.length ? `\nВерсії під мережі:\n${variants.join("\n")}` : "",
      ].filter(Boolean).join("\n");
    },
  },
  {
    name: "create_draft",
    title: "Зберегти готовий пост",
    description: "ГОЛОВНИЙ інструмент: зберегти в кабінет текст, який ти написав САМ. Нічого не переписує і не витрачає AI-кредитів socialio. Перед цим візьми brand_voice, щоб писати в голосі бренду. Одна мережа на пост - текст опублікується дослівно, тож пиши одразу під неї й тримай її ліміт (Threads 500 символів). Кілька мереж - це майстер-текст, який при публікації спакується під кожну (платний виклик). Далі пост можна опублікувати (publish_post) або запланувати (schedule_post).",
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
        [run!.id, text, JSON.stringify(authoredChannels({}, nets, true)),
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
      if (text) {
        await q(`update post set content=$2 where id=$1`, [p.id, text]);
        done.push("текст оновлено");
        // Текст щойно написав Claude: якщо мережа одна, він має піти дослівно (див. authoredChannels).
        // Це ж і доліковує чернетки, збережені до появи позначки, - досить переслати їхній текст.
        if (a.channels === undefined)
          await q(`update post set channels=$2 where id=$1`, [p.id, JSON.stringify(authoredChannels(p.channels, enabledNets(p.channels), true))]);
      }
      if (a.channels !== undefined) {
        const nets = pickNets(a.channels);
        await q(`update post set channels=$2 where id=$1`, [p.id, JSON.stringify(authoredChannels(p.channels, nets, !!text))]);
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
    name: "list_media",
    title: "Медіатека кабінету",
    description: "БЕЗКОШТОВНО: власні фото автора з медіатеки кабінету (завантажені в кабінет, із Google Drive, надіслані боту) - з мініатюрами, щоб ти обирав очима. Позначено, в яких постах фото вже стоїть. Обране прикріпи через attach_media. Власне фото автора майже завжди краще за сток і генерацію - дивись сюди першим. По 12 на сторінку, новіші перші.",
    properties: {
      unused_only: { type: "boolean", description: "true - лише фото, яких ще немає в жодному пості (щоб не повторюватись)." },
      include_generated: { type: "boolean", description: "true - показати й згенеровані AI та стокові зображення, не лише власні фото автора." },
      page: N("Сторінка (типово 1).", { minimum: 1 }),
    },
    readOnly: true,
    run: async (ws, a) => {
      const sources = a.include_generated === true ? [...OWN_MEDIA, ...GEN_MEDIA] : OWN_MEDIA;
      const unused = a.unused_only === true;
      const where = `a.workspace_id=$1 and a.kind='image' and a.source = any($2::text[])${unused ? ` and ${USED_IN} is null` : ""}`;
      const total = (await one<{ n: number }>(`select count(*)::int as n from media_asset a where ${where}`, [ws, sources]))?.n || 0;
      if (!total) {
        return unused
          ? "Вільних фото в медіатеці немає: усі вже стоять у постах. Можна повторити фото (без unused_only), взяти сток (find_stock_photos) або попросити автора завантажити нові: Налаштування → Джерела → Медіа-бібліотека."
          : "Медіатека порожня. Автор може завантажити фото в кабінеті (Налаштування → Джерела → Медіа-бібліотека, можна одразу пачкою) або підключити там же папку Google Drive. Поки що - сток (find_stock_photos).";
      }
      const pages = Math.ceil(total / MEDIA_PAGE);
      const page = Math.min(int(a.page, 1, 1, 100000), pages);
      const rows = await q<{ id: string; original_name: string | null; filename: string; source: string; created_at: string; used_in: string | null }>(
        `select a.id, a.original_name, a.filename, a.source, a.created_at, ${USED_IN} as used_in
           from media_asset a where ${where} order by a.created_at desc limit ${MEDIA_PAGE} offset $3`,
        [ws, sources, (page - 1) * MEDIA_PAGE]);
      const tz = await wsTz(ws);
      const thumbs = await Promise.all(rows.map((r) => smallThumb(r.filename)));
      // номер у тексті мусить збігатися з порядком мініатюр - тож фото без мініатюри (файл не
      // читається) нумеруємо окремо, а не «пропускаємо», інакше модель прикріпила б не те фото
      const shown = rows.map((r, i) => ({ r, t: thumbs[i] })).filter((x) => x.t);
      const broken = rows.filter((_, i) => !thumbs[i]);
      const line = (r: typeof rows[number], n: number) =>
        `${n}. ${short(r.id)} · ${fmtWhen(r.created_at, tz)} · ${MEDIA_SRC[r.source] || r.source}` +
        (r.original_name ? ` · ${oneLine(r.original_name, 40)}` : "") +
        (r.used_in ? ` · ✓ уже в пості ${usedList(r.used_in)}` : "");
      return {
        text: [
          `Медіатека: ${total} фото${unused ? " без поста" : ""} · сторінка ${page} з ${pages}.`,
          ...shown.map((x, i) => line(x.r, i + 1)),
          broken.length ? `Без мініатюри (файл не читається): ${broken.map((r) => short(r.id)).join(", ")}.` : "",
          shown.length ? `Мініатюри нижче, по черзі: ${shown.map((_, i) => i + 1).join(", ")}.` : "",
          page < pages ? `Далі - page: ${page + 1}.` : "",
          "Обране прикріпи через attach_media (id поста + id фото).",
        ].filter(Boolean).join("\n"),
        images: shown.map((x) => x.t as ToolImage),
      };
    },
  },
  {
    name: "attach_media",
    title: "Прикріпити фото з медіатеки",
    description: "БЕЗКОШТОВНО: прикріпити до поста фото з медіатеки кабінету (id з list_media). Фото обрізається під формат (типово 4:5), тримаючи в кадрі головне, і стає зображенням поста в усіх мережах; оригінал у медіатеці лишається. У відповіді - мініатюра того, що вийшло.",
    properties: {
      id: S("Id поста."),
      media: S("Id фото з list_media (короткий #a1b2c3d4 або повний)."),
      aspect: ASPECT_ARG,
    },
    required: ["id", "media"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const pat = idPattern(a.media);
      if (!pat) throw new ToolError("Вкажи id фото з list_media (#a1b2c3d4).");
      const rows = await q<{ id: string; kind: string; used_in: string | null }>(
        `select a.id, a.kind, ${USED_IN} as used_in from media_asset a where a.workspace_id=$1 and a.id::text like $2 limit 2`, [ws, pat + "%"]);
      if (!rows.length) throw new ToolError(`Фото ${short(pat)} у медіатеці цього кабінету немає. Візьми id зі списку list_media.`);
      if (rows.length > 1) throw new ToolError(`На «${pat}» починається кілька фото - дай довший id.`);
      if (rows[0].kind !== "image") throw new ToolError("Це відео, а не фото - до поста тут прикріплюються лише зображення.");
      const others = usedList(rows[0].used_in).split(", ").filter((x) => x && x !== short(p.id));
      const aspect = aspectArg(a.aspect);
      const r = await attachCroppedImage(ws, p.id, rows[0].id, aspect);
      const thumb = await fileThumb(r.filename);
      return {
        text: `${short(p.id)}: фото ${short(rows[0].id)} з медіатеки прикріплено (${aspect}).` +
          (others.length ? ` Це ж фото вже стоїть у ${others.join(", ")} - якщо повтор небажаний, обери інше (list_media з unused_only).` : ""),
        images: thumb ? [thumb] : [],
      };
    },
  },
  {
    name: "media_upload_link",
    title: "Залити фото з комп'ютера в медіатеку",
    description: "Разове посилання, щоб залити фото з комп'ютера автора в медіатеку кабінету, МИНАЮЧИ чат. Є термінал (Claude Code, Cowork) - запусти готову команду з відповіді на папку з фото: файли підуть із диска прямо на сервер, у твій контекст не потрапить жоден байт, тож відкривати фото перед заливкою не треба. Терміналу нема - віддай посилання людині: у браузері воно відкриває сторінку, куди фото просто перетягуються. Посилання лише ДОДАЄ фото в цей кабінет (нічого не читає), діє обмежений час і до 200 фото; повтор тієї самої папки копій не плодить. Після заливки - list_media з unused_only: true.",
    properties: {
      minutes: N("Скільки хвилин діє посилання: 5-180, типово 60.", { minimum: 5, maximum: 180 }),
    },
    run: async (ws, a, ctx) => {
      const minutes = clampMinutes(a.minutes);
      const { token, expiresAt } = await issueUploadLink(ws, ctx.userId, minutes);
      const url = uploadUrl(token);
      const cmd = uploadCommands(url);
      const title = await workspaceTitle(ws);
      await logEvent("info", "mcp", `посилання на заливку фото в «${title}» на ${minutes} хв`, null);
      return [
        `📤 Посилання для заливки фото в медіатеку «${title}» - діє до ${fmtWhen(expiresAt, await wsTz(ws))}, до ${UPLOAD_MAX_FILES} фото:`,
        url,
        "",
        "Є термінал - залий папку однією командою (підстав справжній шлях):",
        "macOS / Linux / Git Bash:",
        cmd.unix,
        "Windows PowerShell:",
        cmd.windows,
        "Без -maxdepth 1 піде й з підпапками. На кожен файл - рядок: ✓ збережено, = уже було в медіатеці, ✗ причина.",
        "",
        "Терміналу нема - дай посилання людині: у браузері воно відкриває сторінку, куди фото просто перетягуються.",
        "Лише фото (JPG, PNG, WebP, HEIC) до 20 МБ. Далі: list_media з unused_only: true → attach_media.",
      ].join("\n");
    },
  },
  {
    name: "find_stock_photos",
    title: "Підібрати фото зі стоку",
    description: "БЕЗКОШТОВНО: 3 стокові фото (Pexels) під пост, із мініатюрами - щоб ти бачив, що обираєш. Передай query: 2-4 англійські слова про конкретну сцену чи обʼєкти (не абстракції на кшталт success). З query підбір нічого не коштує; без нього запит складе модель кабінету. Обране фото прикріпи через attach_stock_photo.",
    properties: {
      id: S("Id поста."),
      query: S("Пошуковий запит англійською, 2-4 слова: конкретна сцена чи обʼєкти."),
      aspect: ASPECT_ARG,
    },
    required: ["id"],
    readOnly: true,
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const aspect = aspectArg(a.aspect);
      const photos = await stockPhotoOptions(ws, p.content, aspect, str(a.query, 80) || undefined);
      if (!photos.length) throw new ToolError("Сток нічого не знайшов - спробуй інший query: конкретніші обʼєкти сцени.");
      const thumbs = await Promise.all(photos.map((x) => urlThumb(x.thumb || x.url)));
      const shown = thumbs.map((t, i) => (t ? i + 1 : 0)).filter(Boolean);
      return {
        text: [
          `Фото для ${short(p.id)} (формат ${aspect}):`,
          ...photos.map((x, i) => `${i + 1}. ${x.alt || "без опису"} · фото: ${x.photographer || "?"}\n   ${x.url}`),
          shown.length ? `Мініатюри нижче, по черзі: ${shown.join(", ")}.` : "Мініатюри не завантажились - обирай за описом.",
          "Обране передай в attach_stock_photo (url).",
        ].join("\n"),
        images: thumbs.filter((t): t is ToolImage => !!t),
      };
    },
  },
  {
    name: "attach_stock_photo",
    title: "Прикріпити фото зі стоку",
    description: "БЕЗКОШТОВНО: прикріпити до поста фото, знайдене через find_stock_photos. Фото обрізається під формат (типово 4:5) і стає зображенням поста в усіх мережах. У відповіді - мініатюра того, що вийшло.",
    properties: {
      id: S("Id поста."),
      url: S("url фото з find_stock_photos."),
      aspect: ASPECT_ARG,
    },
    required: ["id", "url"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const url = str(a.url, 500);
      // лише Pexels: інакше інструмент став би способом змусити сервер завантажити будь-яку адресу
      if (!/^https:\/\/images\.pexels\.com\//.test(url)) throw new ToolError("Приймаю лише url із find_stock_photos (images.pexels.com).");
      const aspect = aspectArg(a.aspect);
      const r = await attachStockPhoto(ws, p.id, url, aspect);
      const thumb = await fileThumb(r.filename);
      return { text: `${short(p.id)}: фото зі стоку прикріплено (${aspect}).`, images: thumb ? [thumb] : [] };
    },
  },
  {
    name: "generate_image",
    title: "Згенерувати зображення",
    description: "Згенерувати зображення до поста й прикріпити його. ПЛАТНО (AI-кредити кабінету), крім provider cloudflare: у нього безкоштовний денний ліміт ~100 зображень, якщо його підключено. Передай prompt англійською: конкретна сцена, обʼєкти, світло, ракурс; без людей-моделей зі стоку й без тексту (текст на зображення не накладається). Без prompt сцену візьме з першого рядка поста - зазвичай гірше. provider необовʼязковий: cloudflare (безкоштовно), fal (найдешевший платний), gemini, openai; без нього - той, що обрано в кабінеті. У відповіді - мініатюра результату.",
    properties: {
      id: S("Id поста."),
      prompt: S("Опис сцени англійською."),
      provider: { type: "string", enum: ["cloudflare", "openai", "fal", "gemini"], description: "Провайдер (необовʼязково)." },
      aspect: ASPECT_ARG,
    },
    required: ["id"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const avail = imageProviders() as Record<string, boolean>;
      const prov = a.provider ? String(a.provider) : "";
      if (prov && !avail[prov]) {
        const ok = Object.keys(avail).filter((k) => avail[k]);
        throw new ToolError(`Провайдер ${prov} зараз недоступний. ${ok.length ? `Доступні: ${ok.join(", ")}.` : "Жодного - адміністратор має додати ключ у Налаштування → Профіль → Ключі провайдерів."}`);
      }
      const aspect = aspectArg(a.aspect);
      const filename = await generateImageForPost(ws, p.id, { prompt: str(a.prompt, 1200) || undefined, provider: (prov || undefined) as any, aspect });
      const thumb = await fileThumb(filename);
      return { text: `${short(p.id)}: зображення згенеровано й прикріплено (${aspect}${prov ? `, ${prov}` : ""}).`, images: thumb ? [thumb] : [] };
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
      const picked = pickNets(a.channels);
      const nets = picked.length ? picked : enabledNets(p.channels);
      // текст від Claude (origin 'mcp') під одну мережу - дослівно, як і при плануванні
      if (nets.length && (picked.length || p.origin === "mcp"))
        await q(`update post set channels=$2 where id=$1`, [p.id, JSON.stringify(authoredChannels(p.channels, nets, p.origin === "mcp"))]);
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
      const on = nets.length ? nets : enabledNets(p.channels);
      if (!on.length) throw new ToolError("Спершу обери мережі (channels) - інакше автопостеру нема куди публікувати.");
      // Текст, який Claude написав сам (create_draft → origin 'mcp'), під одну мережу йде ДОСЛІВНО.
      // Це ж доліковує чернетки, збережені до появи позначки: досить їх (пере)запланувати. Пост,
      // зроблений у кабінеті, як і раніше не позначаємо - його майстер-текст має спакуватись.
      let chNow = p.channels;
      if (nets.length || p.origin === "mcp") {
        chNow = authoredChannels(p.channels, on, p.origin === "mcp");
        await q(`update post set channels=$2 where id=$1`, [p.id, JSON.stringify(chNow)]);
      }
      // переносимо наявний слот замість другого INSERT - інакше пост вийшов би двічі
      const ex = await one<{ id: string }>(`select id from schedule_slot where post_id=$1 and status='planned' limit 1`, [p.id]);
      if (ex) await q(`update schedule_slot set scheduled_at=$2, updated_at=now() where id=$1`, [ex.id, at.toISOString()]);
      else await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [p.id, at.toISOString()]);
      await q(`update post set review='approved' where id=$1`, [p.id]);   // запланований = затверджений
      return `🗓 ${short(p.id)} заплановано на ${fmtWhen(at, tz)}: ${publishPlanLine(publishPlan(chNow, p.content))}.${ex ? " Наявний слот перенесено." : ""}`;
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
// Разовий вибір кабінету без перемикання: дешевий запобіжник від «опублікував не в той бренд».
const WS_ARG = { type: "string", description: "Кабінет (бренд) для ЦЬОГО виклику, якщо їх кілька: назва або id зі списку list_workspaces. Без нього - активний кабінет." };
const WS_TOOLS = ["list_workspaces", "switch_workspace"];

export function toolSpecs(): unknown[] {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: {
      type: "object",
      properties: WS_TOOLS.includes(t.name) ? t.properties : { ...t.properties, workspace: WS_ARG },
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
  "Зображення: спершу медіатека кабінету (list_media → attach_media) - власні фото автора, вони найкращі й безкоштовні (фото лежать у автора на комп'ютері, а в тебе є термінал - media_upload_link дасть команду, що заллє папку в медіатеку без проходу через чат); далі сток - find_stock_photos з конкретним англійським query і attach_stock_photo, теж безкоштовно; generate_image платний (крім provider cloudflare - безкоштовний денний ліміт ~100 зображень, якщо його підключено), бери його, коли ні медіатека, ні сток не підходять або коли людина просить саме генерацію.",
  "Якщо кабінетів кілька (list_workspaces), спершу переконайся, що активний саме той бренд: перемкни switch_workspace або передай workspace у виклику. Кожна відповідь називає кабінет у першому рядку - звіряйся з ним перед публікацією.",
  "Факти не вигадуй: бери їх з list_materials / get_material або питай автора.",
  "Перед публікацією показуй текст людині - опублікований пост відкликати не можна.",
].join(" ");

// ============================================================================
// 6. ДИСПЕТЧЕР JSON-RPC
// ============================================================================

export async function callTool(ctx: McpCtx, name: string, args: Record<string, any>): Promise<{ content: unknown[]; isError?: boolean }> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { content: [{ type: "text", text: `Невідомий інструмент: ${name}` }], isError: true };
  try {
    const a = args || {};
    // разовий кабінет із аргументу; за замовчуванням - активний
    const target = a.workspace && !WS_TOOLS.includes(name) ? await resolveWsArg(ctx.userId, a.workspace) : null;
    const wsId = target?.id || ctx.wsId;
    if (target && !(await isMember(ctx.userId, wsId))) throw new ToolError("Немає доступу до цього кабінету.");
    const out = await tool.run(wsId, a, ctx);
    // Коли кабінетів кілька, КОЖНА відповідь називає бренд. Без цього людина не побачить, що
    // модель працює не в тому кабінеті, аж поки пост не вийде не там.
    const head = ctx.wsCount > 1 && !WS_TOOLS.includes(name) ? `[Кабінет: ${target?.title || ctx.wsTitle}]\n` : "";
    return { content: toContent(head, out) };
  } catch (e: any) {
    // Помилки інструмента повертаємо В РЕЗУЛЬТАТІ (isError), а не як помилку протоколу: так модель
    // бачить причину й може виправитись сама, а клієнт не рве зʼєднання.
    if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
    await logEvent("error", "mcp", `${name}: ${e?.message || e}`, null);
    return { content: [{ type: "text", text: `Не вийшло: ${e?.message || "невідома помилка"}` }], isError: true };
  }
}

// Одне повідомлення JSON-RPC → одна відповідь (або null для нотифікацій, на які відповідати не можна).
export async function handleRpc(ctx: McpCtx, msg: any): Promise<any | null> {
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
      touchUsed(ctx.token);
      return rpcResult(id, await callTool(ctx, name, msg.params?.arguments || {}));
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
export async function handleBody(ctx: McpCtx, body: any): Promise<any | null> {
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) { const r = await handleRpc(ctx, m); if (r) out.push(r); }
    return out.length ? out : null;
  }
  return handleRpc(ctx, body);
}
