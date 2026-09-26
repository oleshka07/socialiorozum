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
import { touchActive } from "./auth.js";
import { randomBytes } from "node:crypto";
import { q, one } from "./db.js";
import { env } from "./env.js";
import { getSettingText } from "./settings.js";
import { listWorkspaces, isMember, workspaceTitle } from "./workspaces.js";
import { issueUploadLink, uploadCommands, uploadUrl, clampMinutes, UPLOAD_MAX_FILES } from "./uploadlink.js";
import { connectedNets, parseWhen, zonedToUtc } from "./tgcompose.js";
import { publishPostToChannels, alreadySentNetworks, reelSentNetworks, closeSlotsIfDone, publishingNow, isPublishingNow, unschedulePost, type PubResult } from "./publisher.js";
import { scheduleConflicts, describeConflicts, schedulable } from "./schedule.js";
import { startJob, getJob } from "./jobs.js";
import { analyticsFor } from "./metrics.js";
import { fmtMult } from "./analytics.js";
import { publicFetch } from "./netguard.js";
import { saveMediaFile, MEDIA_DIR } from "./media.js";
import { writeFile, mkdir, unlink, open as openFile } from "node:fs/promises";
import { join } from "node:path";
import { generatePostsOnePass, normFormat, GOAL_LABELS, CHANNEL_LIMITS } from "./pipeline.js";
import { logEvent } from "./log.js";
import { generateImageForPost, imageProviders, stockPhotoOptions, attachStockPhoto, attachCroppedImage, appendCroppedSlide, cropCopy } from "./images.js";
import { postMediaList, setPostMediaOrder, setPostVideo, MAX_SLIDES, SlideError, altToOriginal } from "./slides.js";
import { renderCarousel, CAROUSEL_THEMES } from "./carousel.js";
import { briefMismatch, brandTextOf } from "./textkind.js";
import { COMMENT_NETS, COMMENT_MAX, COMMENT_PERM, commentFor, commentStates, queueMissingComments, processDue as processDueComments, type CommentState } from "./comments.js";
import { normCollaborators, cleanAlt, IG_MAX_COLLABORATORS } from "./igextras.js";
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
function touchUsed(token: string, userId: string): void {
  const now = Date.now();
  if (now - (usedAt.get(token) || 0) < 5 * 60_000) return;
  usedAt.set(token, now);
  q(`update mcp_token set last_used_at=now() where token=$1`, [token]).catch(() => {});
  // робота через Claude - теж активність: інакше нічний прибиральник вважав би людину, яка місяць
  // працює лише з конектора, неактивною і через 44 дні стер би її контент
  touchActive(userId).catch(() => {});
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
  first_comment: string | null;
};
const POST_SELECT = `select p.id, p.content, p.review, p.channels, p.rubric, p.intent, p.format, p.created_at,
                            p.first_comment, s.origin, ma.filename as media
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

/**
 * 💬 Записати перший коментар у пост. Спільний текст - post.first_comment, свій для мережі -
 * channels.<мережа>.first_comment (порожній рядок = у цій мережі без коментаря), як і в композері.
 * Вертає оновлені канали й рядок для відповіді (null - нічого не мінялось).
 */
export async function applyFirstComment(postId: string, channels: any, fc: unknown, byNet: unknown): Promise<{ channels: any; note: string | null }> {
  const notes: string[] = [];
  let ch = channels;
  if (typeof fc === "string") {
    const t = fc.trim().slice(0, 8000);
    await q(`update post set first_comment=nullif($2,'') where id=$1`, [postId, t]);
    notes.push(t ? "перший коментар задано" : "перший коментар прибрано");
  }
  if (byNet && typeof byNet === "object" && !Array.isArray(byNet)) {
    ch = { ...(channels || {}) };
    for (const n of COMMENT_NETS) if (ch[n] && typeof ch[n] === "object") { const { first_comment: _drop, ...rest } = ch[n]; ch[n] = rest; }
    const own: string[] = [];
    for (const [n, v] of Object.entries(byNet as Record<string, unknown>)) {
      if (!COMMENT_NETS.includes(n) || typeof v !== "string") continue;
      ch[n] = { ...(ch[n] && typeof ch[n] === "object" ? ch[n] : { on: false }), first_comment: v.trim().slice(0, 8000) };
      own.push(`${NET_LABEL[n]}: ${v.trim() ? "свій" : "без коментаря"}`);
    }
    await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify(ch)]);
    notes.push(own.length ? `винятки коментаря - ${own.join(", ")}` : "винятки коментаря прибрано");
  }
  return { channels: ch, note: notes.length ? notes.join(", ") : null };
}

/** Співавтори Instagram у channels.instagram.collaborators. Вертає рядок для відповіді. */
async function applyCollaborators(ws: string, postId: string, channels: any, v: unknown): Promise<{ channels: any; note: string }> {
  const own = (await one<{ ig_username: string | null }>(`select ig_username from meta_config where workspace_id=$1`, [ws]))?.ig_username;
  const r = normCollaborators(v, own);
  const ch = { ...(channels || {}) };
  ch.instagram = { ...(ch.instagram && typeof ch.instagram === "object" ? ch.instagram : { on: false }) };
  if (r.ok.length) ch.instagram.collaborators = r.ok; else delete ch.instagram.collaborators;
  await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify(ch)]);
  const warn = [r.bad.length ? `не схоже на нік Instagram: ${r.bad.join(", ")}` : "", r.extra.length ? `Instagram приймає до ${IG_MAX_COLLABORATORS} - зайві @${r.extra.join(", @")} не додано` : ""].filter(Boolean);
  const note = (r.ok.length ? `співавтори Instagram: ${r.ok.map((u) => "@" + u).join(", ")}` : "співавторів Instagram прибрано")
    + (warn.length ? ` (⚠️ ${warn.join("; ")})` : "") + (r.ok.length && !ch.instagram.on ? " - але Instagram на пості не обрано" : "");
  return { channels: ch, note };
}
/**
 * Опис фото по кадрах поста (у порядку кадрів). emptyClears: "" прибирає опис (update_post) чи лишає
 * наявний (attach_media - там порожній рядок модель ставить як «без опису», а кадр міг успадкувати
 * опис оригіналу). Вертає, скільки фото тепер з описом.
 */
async function applyAltTexts(postId: string, alts: unknown, opts: { onlyLast?: number; emptyClears: boolean }): Promise<{ set: number; photos: number; skippedVideo: boolean }> {
  const list = (Array.isArray(alts) ? alts : [alts]).map((x) => (typeof x === "string" ? cleanAlt(x) : null));
  const frames = await postMediaList(postId);
  const target = opts.onlyLast ? frames.slice(-opts.onlyLast) : frames;
  let skippedVideo = false;
  for (const [i, m] of target.entries()) {
    const alt = i < list.length ? list[i] : null;
    if (alt === null || (alt === "" && !opts.emptyClears)) continue;
    if (m.kind === "video") { skippedVideo = true; continue; }
    await q(`update media_asset set alt_text=nullif($2,'') where id=$1`, [m.id, alt]);
    if (alt) await altToOriginal(m.id, alt);
  }
  const after = await postMediaList(postId);
  const photos = after.filter((m) => m.kind !== "video");
  return { set: photos.filter((m) => m.alt_text).length, photos: photos.length, skippedVideo };
}

/** Як перший коментар піде в кожну обрану мережу: текст, стан, що заважає. Порожньо - коментаря нема. */
export function commentPlanLines(post: { first_comment?: string | null; channels?: any; format?: string | null },
                                 nets: string[], states: CommentState[], sentNets: string[], granted: string | null): string[] {
  const any = nets.some((n) => commentFor(post, n)) || !!String(post.first_comment || "").trim();
  if (!any) return [];
  if (post.format === "story") return ["💬 перший коментар: сторіс коментарів не мають - піде лише у звичайних постах"];
  const master = String(post.first_comment || "").trim();
  const out: string[] = master ? [`💬 перший коментар: «${oneLine(master, 200)}»`] : ["💬 перший коментар:"];
  for (const n of nets) {
    const label = NET_LABEL[n] || n;
    if (!COMMENT_NETS.includes(n)) { if (master) out.push(`— ${label}: без коментаря (коментарі каналу живуть в окремій групі обговорення, бот туди не пише)`); continue; }
    const own = post.channels?.[n]?.first_comment;
    const text = commentFor(post, n);
    if (!text) { if (typeof own === "string") out.push(`— ${label}: без коментаря (так задано для цієї мережі)`); continue; }
    const tag = typeof own === "string" ? ` свій: «${oneLine(text, 120)}»` : "";
    const st = states.find((x) => x.network === n);
    const over = text.length > (COMMENT_MAX[n] || 2000) ? ` ⚠️ довший за ${COMMENT_MAX[n]} знаків (${text.length}) - скороти` : "";
    const perm = COMMENT_PERM[n] && granted != null && !granted.split(",").includes(COMMENT_PERM[n])
      ? " ⚠️ немає дозволу на коментарі - Налаштування → Канали → Facebook + Instagram → «💬 Дозволити коментарі»" : "";
    if (st?.status === "sent") out.push(`— ${label}: ✓ надіслано${tag}`);
    else if (st?.status === "failed") out.push(`— ${label}: ⚠️ не вийшов: ${st.error || "невідома помилка"}${tag} (send_first_comment - спробувати ще раз)`);
    else if (st) out.push(`— ${label}: ⏳ надсилається${st.error ? ` (повтор після збою: ${oneLine(st.error, 120)})` : ""}${tag}`);
    else if (sentNets.includes(n)) out.push(`— ${label}: не надіслано - пост вийшов раніше, ніж зʼявився коментар (send_first_comment)${tag}${over}${perm}`);
    else out.push(`— ${label}: піде одразу після публікації${tag}${over}${perm}`);
  }
  return out;
}

/** 📸 Співавтори й опис фото - рядок для get_post (лише коли Instagram обрано). */
async function igExtrasLine(p: PostRow): Promise<string> {
  if (!p.channels?.instagram?.on || p.format === "story") return "";
  const collab = Array.isArray(p.channels.instagram.collaborators) ? p.channels.instagram.collaborators : [];
  const photos = (await postMediaList(p.id)).filter((m) => m.kind !== "video");
  const alt = photos.filter((m) => m.alt_text).length;
  return `📸 Instagram: ${collab.length ? `співавтори ${collab.map((u: string) => "@" + u).join(", ")}` : "без співавторів"}` +
    (photos.length ? ` · опис фото (alt): ${alt} з ${photos.length}` : "");
}

const COMMENT_UA: Record<string, string> = { sent: "✓", failed: "⚠️ не вийшов", pending: "⏳ повторимо", sending: "⏳ надсилається" };
async function metaGranted(ws: string): Promise<string | null> {
  return (await one<{ granted: string | null }>(`select granted from meta_config where workspace_id=$1`, [ws]))?.granted ?? null;
}

async function sentMap(ids: string[]): Promise<Map<string, { net: string; link: string | null; at: string }[]>> {
  const out = new Map<string, { net: string; link: string | null; at: string }[]>();
  if (!ids.length) return out;
  // час відправки теж: у списках постів людина питає «коли вийшло», а не «коли я це написав»
  const rows = await q<{ post_id: string; net: string; permalink: string | null; at: string }>(
    `select post_id, net, max(permalink) as permalink, min(created_at) as at from (
        select post_id, 'telegram'::text as net, permalink, created_at from telegram_publish where status='sent' and post_id=any($1)
        union all select post_id, 'threads', permalink, created_at from threads_publish where status='sent' and post_id=any($1)
        union all select post_id, channel, permalink, created_at from meta_publish where status='sent' and post_id=any($1)
        union all select post_id, 'linkedin', permalink, created_at from linkedin_publish where status='sent' and post_id=any($1)
      ) x group by post_id, net order by min(created_at)`, [ids]);
  for (const r of rows) {
    const a = out.get(r.post_id) || [];
    a.push({ net: r.net, link: r.permalink, at: r.at });
    out.set(r.post_id, a);
  }
  return out;
}
// найближчий запланований слот кожного поста (для списків «коли вийде»)
async function plannedMap(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  for (const r of await q<{ post_id: string; at: string }>(
    `select post_id, min(scheduled_at) as at from schedule_slot where status='planned' and post_id=any($1) group by post_id`, [ids])) out.set(r.post_id, r.at);
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLOT_STATE: Record<string, string> = { planned: "чекає публікації", posting: "публікується", posted: "опубліковано", failed: "не вийшло" };

// Які САМЕ акаунти підключені: «Threads підключено» без імені не дає звірити, чи це той профіль
// (фідбек тестера). Беремо те, що вже лежить у конфігах мереж, без запитів в API.
async function accountNames(ws: string): Promise<Record<string, string>> {
  const [th, mt, tgc, li] = await Promise.all([
    one<{ username: string | null }>(`select username from threads_config where workspace_id=$1 and access_token is not null`, [ws]),
    one<{ page_name: string | null; ig_username: string | null; page_token: string | null; ig_user_id: string | null }>(
      `select page_name, ig_username, page_token, ig_user_id from meta_config where workspace_id=$1`, [ws]),
    one<{ channel_title: string | null; channel_username: string | null; channel_chat_id: string | null }>(
      `select channel_title, channel_username, channel_chat_id from telegram_config where workspace_id=$1`, [ws]),
    one<{ display_name: string | null }>(`select display_name from linkedin_config where workspace_id=$1`, [ws]),
  ]);
  const out: Record<string, string> = {};
  if (th?.username) out.threads = "@" + th.username.replace(/^@/, "");
  if (mt?.page_token && mt.ig_user_id && mt.ig_username) out.instagram = "@" + mt.ig_username.replace(/^@/, "");
  if (mt?.page_token && mt.page_name) out.facebook = `Сторінка «${mt.page_name}»`;
  if (tgc?.channel_chat_id) out.telegram = [tgc.channel_title ? `«${tgc.channel_title}»` : "", tgc.channel_username ? "@" + tgc.channel_username.replace(/^@/, "") : ""].filter(Boolean).join(" ") || tgc.channel_chat_id;
  if (li?.display_name) out.linkedin = li.display_name;
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
const MEDIA_SRC: Record<string, string> = { upload: "завантажено", gdrive: "Google Drive", diary: "щоденник", bot: "з бота", ai: "AI", pexels: "сток", broll: "b-roll" };
// Де фото вже стоїть: напряму (post.media_id) або через кроп-копію під формат поста, яку
// attachCroppedImage позначає external_id = id оригіналу. Кропи, зроблені до цієї позначки,
// відстежити нема як - такі фото просто виглядають вільними.
// Кадр каруселі (post_slide) рахується так само: фото, що стоїть третім кадром, «уже в пості».
const USED_IN = `(select string_agg(left(u.pid::text, 8), ',' order by u.created_at desc) from (
                    select distinct p.id as pid, p.created_at
                      from post p
                      left join post_slide ps on ps.post_id = p.id
                      left join media_asset c on c.id = p.media_id
                      left join media_asset cs on cs.id = ps.media_id
                     where p.media_id = a.id or ps.media_id = a.id
                        or (c.source = 'crop' and c.external_id = a.id::text)
                        or (cs.source = 'crop' and cs.external_id = a.id::text)) u)`;
export const usedList = (usedIn: string | null | undefined): string =>
  String(usedIn || "").split(",").filter(Boolean).map((x) => "#" + x).join(", ");

// «· є фото» / «· карусель, 5 кадрів» - щоб модель бачила, що в пості вже стоїть
export const fmtDur = (sec: unknown): string => {
  const n = Math.round(Number(sec) || 0);
  return n ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}` : "";
};
export const mediaLine = (media: Array<{ id: string; kind?: string; duration?: number | null }>, format?: string | null): string =>
  format === "story" ? (media.length ? ` · сторіс, ${media.length} ${media.length === 1 ? "кадр" : "кадрів"}` : " · сторіс без кадрів")
    : !media.length ? "" : media[0].kind === "video" ? ` · відео${fmtDur(media[0].duration) ? " " + fmtDur(media[0].duration) : ""}`
    : media.length === 1 ? " · є фото" : ` · карусель, ${media.length} кадрів`;
// id файлу з медіатеки: короткий #a1b2c3d4 або повний, лише свій кабінет
async function libraryMediaId(ws: string, raw: unknown): Promise<{ id: string; kind: string }> {
  const pat = idPattern(raw);
  if (!pat) throw new ToolError("Вкажи id з list_media (#a1b2c3d4).");
  const rows = await q<{ id: string; kind: string }>(`select id, kind from media_asset where workspace_id=$1 and id::text like $2 limit 2`, [ws, pat + "%"]);
  if (!rows.length) throw new ToolError(`Файлу ${short(pat)} у медіатеці цього кабінету немає. Візьми id зі списку list_media.`);
  if (rows.length > 1) throw new ToolError(`На «${pat}» починається кілька файлів - дай довший id.`);
  return rows[0];
}
// лише зображення (кадри каруселі, стоп для відео тут, а не в сирій помилці БД)
async function libraryImageId(ws: string, raw: unknown): Promise<string> {
  const m = await libraryMediaId(ws, raw);
  if (m.kind !== "image") throw new ToolError("Це відео, а не фото. Відео прикріплюється саме (attach_media з одним id) - поруч із ним фото не буває.");
  return m.id;
}

const ASPECTS = ["4:5", "1:1", "16:9", "9:16"];
const aspectArg = (v: unknown): string => (ASPECTS.includes(String(v)) ? String(v) : "4:5");

const S = (description: string, extra: Record<string, any> = {}) => ({ type: "string", description, ...extra });
const N = (description: string, extra: Record<string, any> = {}) => ({ type: "integer", description, ...extra });
const NETS_ARG = { type: "array", items: { type: "string", enum: NETS }, description: "Мережі: telegram, instagram, facebook, threads, linkedin." };
const FC_BY_NET_ARG = {
  type: "object",
  description: "Свій перший коментар для окремих мереж, коли спільний не годиться (у LinkedIn - посилання, в Instagram - хештеги). Порожній рядок - у цій мережі без коментаря. Передаєш обʼєкт - він ЗАМІНЮЄ всі винятки: мережі, яких у ньому нема, беруть спільний first_comment.",
  properties: Object.fromEntries(COMMENT_NETS.map((n) => [n, { type: "string" }])),
  additionalProperties: false,
};
const COLLAB_ARG = { type: "array", items: { type: "string" }, description: `Instagram: співавтори (collab) - до ${IG_MAX_COLLABORATORS} ніків (@partner). Кожен отримає запрошення, і після згоди пост зʼявиться і в його профілі. Фото, карусель і Reels; сторіс - ні. У update_post порожній масив прибирає співавторів.` };
const ALT_ARG = { type: "array", items: { type: "string" }, description: "Опис фото (alt-текст) для незрячих і пошуку, по одному на кадр у тому ж порядку (1-2 речення, що на фото); порожній рядок прибирає опис кадру. Іде в Instagram (фото й кадри каруселі) і LinkedIn; у відео й сторіс мережі його не приймають." };
const FC_ARG = S("Перший коментар під постом від імені автора: посилання (у LinkedIn і Facebook воно в тексті ріже охоплення, у коментарі - ні), хештеги для Instagram, заклик. Іде одразу після публікації в Instagram, Facebook, LinkedIn і Threads (там - відповіддю автора). У Telegram і в сторіс коментаря немає. У update_post порожній рядок прибирає коментар.");

const ASPECT_ARG = { type: "string", enum: ASPECTS, description: "Формат: 4:5 (типово - найбільше місця в стрічці, підходить усім мережам), 1:1, 16:9, 9:16 (сторіс; для поста формату story - типово)." };

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
               where src.workspace_id=$1 and ss.status='planned'
                 and exists (select 1 from jsonb_each(coalesce(p.channels,'{}'::jsonb)) e
                              where jsonb_typeof(e.value)='object' and e.value->>'on'='true'
                                and e.key in ('telegram','threads','facebook','instagram','linkedin')))::int as planned`, [ws]),
      ]);
      const off = NETS.filter((n) => !nets.includes(n));
      const acc = await accountNames(ws);
      return [
        "КАБІНЕТ socialio (КонтентГров)",
        s.marketing_context ? `Бренд і аудиторія: ${oneLine(s.marketing_context, 400)}` : "Бренд ще не заповнений (Бренд → Голос у кабінеті).",
        s.brand_thesis ? `Позиціонування: ${oneLine(s.brand_thesis, 200)}` : "",
        s.primary_goal && GOAL_LABELS[s.primary_goal] ? `Головна ціль: ${GOAL_LABELS[s.primary_goal]}` : "",
        `Мова контенту: ${s.output_language || "Українська"} · Часовий пояс: ${s.timezone || "Europe/Kyiv"}`,
        `Підключені мережі: ${nets.length ? nets.map((n) => `${NET_LABEL[n]}${acc[n] ? ` (${acc[n]})` : ""}`).join(", ") : "жодної"}${off.length ? ` · не підключені: ${netList(off)}` : ""}`,
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
        briefMismatch(s.strategy_brief || "", brandTextOf(s))
          ? "\n## Стратегічний бриф\n(не показано: бриф описує інший бізнес, ніж опис бренду вище, - його треба перегенерувати в кабінеті. Орієнтуйся на опис бренду й болі.)"
          : block("Стратегічний бриф", s.strategy_brief, 1800),
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
      const [sent, planned] = await Promise.all([sentMap(rows.map((r) => r.id)), plannedMap(rows.map((r) => r.id))]);
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
        // два часи: коли пост створено і коли він вийшов / вийде - «список показує лише створення»
        const when = [`створено ${fmtWhen(r.created_at, tz)}`,
          s.length ? `вийшов ${fmtWhen(s[0].at, tz)}` : "",
          planned.get(r.id) ? `заплановано на ${fmtWhen(planned.get(r.id)!, tz)}` : ""].filter(Boolean).join(" · ");
        return [
          `${short(r.id)} · ${state} · ${when}`,
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
        `select scheduled_at, status from schedule_slot where post_id=$1 order by (status='planned') desc, scheduled_at limit 1`, [p.id]);
      const tz = await wsTz(ws);
      const busy = await publishingNow(p.id);
      const live = isPublishingNow(p.id);
      const variants = NETS.filter((n) => p.channels?.[n]?.text).map((n) => `— ${NET_LABEL[n]}: ${oneLine(p.channels[n].text, 300)}`);
      return [
        `${short(p.id)} · створено ${fmtWhen(p.created_at, tz)} · ${p.review === "approved" ? "затверджено" : "чернетка"}${mediaLine(await postMediaList(p.id), p.format)}`,
        `мережі: ${enabledNets(p.channels).length ? netList(enabledNets(p.channels)) : "не обрані"}${p.rubric ? ` · рубрика: ${p.rubric}` : ""}${p.format && p.format !== "post" ? ` · формат: ${p.format}` : ""}`,
        slot?.scheduled_at ? `заплановано: ${fmtWhen(slot.scheduled_at, tz)} (${SLOT_STATE[slot.status] || slot.status})` : "",
        busy.length ? (live
          ? `⏳ публікується просто зараз: ${busy.map((b) => `${NET_LABEL[b.net] || b.net} (з ${fmtWhen(b.since, tz)})`).join(", ")} - дочекайся результату`
          : `⚠️ публікацію в ${netList(busy.map((b) => b.net))} обірвано посеред роботи - наступний publish_post перейме її одразу`) : "",
        enabledNets(p.channels).length ? `публікація: ${publishPlanLine(publishPlan(p.channels, p.content))}` : "",
        sent.length ? `опубліковано: ${sent.map((x) => `${NET_LABEL[x.net]} ${fmtWhen(x.at, tz)}${x.link ? ` ${x.link}` : ""}`).join(", ")}` : "",
        ...commentPlanLines(p, [...new Set([...enabledNets(p.channels), ...sent.map((x) => x.net)])], await commentStates(p.id), sent.map((x) => x.net), await metaGranted(ws)),
        await igExtrasLine(p),
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
      first_comment: FC_ARG,
      first_comment_by_network: FC_BY_NET_ARG,
      instagram_collaborators: COLLAB_ARG,
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
      const fc = (a.first_comment !== undefined || a.first_comment_by_network !== undefined)
        ? await applyFirstComment(post!.id, authoredChannels({}, nets, true), a.first_comment, a.first_comment_by_network) : null;
      const collab = a.instagram_collaborators !== undefined
        ? await applyCollaborators(ws, post!.id, fc ? fc.channels : authoredChannels({}, nets, true), a.instagram_collaborators) : null;
      const fcPlan = fc ? commentPlanLines({ first_comment: typeof a.first_comment === "string" ? a.first_comment : null, channels: fc.channels, format: normFormat(a.format) },
        nets, [], [], await metaGranted(ws)) : [];
      const twin = (await scheduleConflicts(ws, post!.id, null, NETS)).filter((c) => c.kind === "text");
      const storyOff = normFormat(a.format) === "story" ? nets.filter((n) => n !== "instagram" && n !== "facebook") : [];
      return [
        `Пост збережено: ${short(post!.id)}${a.approve === true ? " (затверджено)" : " (чернетка)"}.`,
        nets.length ? `Мережі: ${netList(nets)}.` : "Мережі не обрані - вкажи їх у publish_post або схвали в кабінеті.",
        normFormat(a.format) === "story" ? "📱 Сторіс: кожен кадр - окрема сторіс в Instagram і Facebook; підпису немає, тож думка має бути на кадрах - додай фото/відео (attach_media, типово 9:16) або намалюй кадри з тексту render_carousel." : "",
        storyOff.length ? `⚠️ Сторіс через API приймають лише Instagram і Facebook - у ${netList(storyOff)} цей пост не піде.` : "",
        notConnected.length ? `⚠️ Не підключені в кабінеті: ${netList(notConnected)} - туди публікація не піде.` : "",
        twin.length ? `⚠️ Такий самий текст уже є: ${twin.map((c) => `${short(c.postId)} (${c.state === "sent" ? "опубліковано" : "заплановано"})`).join(", ")} - можливо, це дубль (delete_post, якщо так).` : "",
        "Далі: publish_post (опублікувати зараз) або schedule_post (на дату й час).",
      ].filter(Boolean).join(" ") + (fcPlan.length ? "\n" + fcPlan.join("\n") : "") + (collab ? `\n👥 ${collab.note}.` : "");
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
      format: S("Формат (необовʼязково): post, carousel, reel, story.", { enum: ["post", "carousel", "reel", "story"] }),
      first_comment: FC_ARG,
      first_comment_by_network: FC_BY_NET_ARG,
      instagram_collaborators: COLLAB_ARG,
      alt_texts: ALT_ARG,
      approve: { type: "boolean", description: "true - затвердити, false - зняти затвердження." },
    },
    required: ["id"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const done: string[] = [];
      if (a.format !== undefined) {
        const f = normFormat(a.format);
        await q(`update post set format=$2 where id=$1`, [p.id, f]);
        done.push(`формат: ${f}` + (f === "story" ? " (сторіс ідуть лише в Instagram і Facebook, кожен кадр - окремо)" : ""));
      }
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
        // без жодної мережі пост нікуди не вийде - у календарі він лише висів би порожнім
        if (!nets.length) { const n = await unschedulePost(p.id); if (n) done.push(`знято з розкладу (${n})`); }
      }
      const rubric = str(a.rubric, 60);
      if (rubric) { await q(`update post set rubric=$2 where id=$1`, [p.id, rubric]); done.push(`рубрика: ${rubric}`); }
      if (a.first_comment !== undefined || a.first_comment_by_network !== undefined) {
        // канали перечитуємо: вище їх могли щойно змінити (мережі, позначка «дослівно»)
        const chNow = (await one<{ channels: any }>(`select channels from post where id=$1`, [p.id]))?.channels;
        const fc = await applyFirstComment(p.id, chNow, a.first_comment, a.first_comment_by_network);
        if (fc.note) done.push(fc.note);
        // куди пост уже вийшов, коментар сам не піде: або дослати, або там він уже стоїть (змінити
        // коментар у мережі можна лише в ній самій - повторно не шлемо)
        const sentNow = (await alreadySentNetworks(p.id)).filter((n) => COMMENT_NETS.includes(n));
        const has = (await commentStates(p.id)).filter((x) => x.status === "sent" || x.status === "sending").map((x) => x.network);
        const late = sentNow.filter((n) => !has.includes(n)), already = sentNow.filter((n) => has.includes(n));
        if (late.length) done.push(`пост уже вийшов у ${netList(late)} - коментар туди не піде сам: send_first_comment`);
        if (already.length) done.push(`у ${netList(already)} перший коментар уже стоїть - новий текст туди не піде (змінити його можна лише в самій мережі)`);
      }
      if (a.instagram_collaborators !== undefined) {
        const chNow = (await one<{ channels: any }>(`select channels from post where id=$1`, [p.id]))?.channels;
        done.push((await applyCollaborators(ws, p.id, chNow, a.instagram_collaborators)).note);
      }
      if (a.alt_texts !== undefined) {
        const r = await applyAltTexts(p.id, a.alt_texts, { emptyClears: true });
        done.push(r.photos ? `опис фото: ${r.set} з ${r.photos}` + (r.skippedVideo ? " (у відео alt-тексту мережі не приймають)" : "") : "у поста нема фото - описувати нічого");
      }
      if (typeof a.approve === "boolean") {
        await q(`update post set review=$2 where id=$1`, [p.id, a.approve ? "approved" : null]);
        done.push(a.approve ? "затверджено" : "затвердження знято");
        // незатверджений текст не має лишатись у календарі: автопостер відправив би його в мережу
        if (!a.approve) { const n = await unschedulePost(p.id); if (n) done.push(`знято з розкладу (${n})`); }
      }
      if (!done.length) throw new ToolError("Нічого не змінено - передай text, channels, rubric, format, first_comment, instagram_collaborators, alt_texts або approve.");
      return `${short(p.id)}: ${done.join(", ")}.`;
    },
  },
  {
    name: "list_media",
    title: "Медіатека кабінету",
    description: "БЕЗКОШТОВНО: власні фото (або з kind: \"video\" - відео) автора з медіатеки кабінету (завантажені в кабінет, із Google Drive, надіслані боту) - з мініатюрами, щоб ти обирав очима; у відео мініатюра - кадр із ролика, плюс тривалість і розмір. Позначено, в яких постах файл уже стоїть. Обране прикріпи через attach_media. Власне фото чи відео автора майже завжди краще за сток і генерацію - дивись сюди першим. По 12 на сторінку, новіші перші.",
    properties: {
      kind: { type: "string", enum: ["image", "video"], description: "image (типово) - фото; video - відео (Reels, відео-пости)." },
      unused_only: { type: "boolean", description: "true - лише фото, яких ще немає в жодному пості (щоб не повторюватись)." },
      include_generated: { type: "boolean", description: "true - показати й згенеровані AI та стокові зображення, не лише власні фото автора." },
      page: N("Сторінка (типово 1).", { minimum: 1 }),
    },
    readOnly: true,
    run: async (ws, a) => {
      const video = a.kind === "video";
      // власні відео автора - це й b-roll для рілсів (завантажені ним самим)
      const sources = video ? [...OWN_MEDIA, "broll"] : a.include_generated === true ? [...OWN_MEDIA, ...GEN_MEDIA] : OWN_MEDIA;
      const unused = a.unused_only === true;
      const where = `a.workspace_id=$1 and a.kind='${video ? "video" : "image"}' and a.source = any($2::text[])${unused ? ` and ${USED_IN} is null` : ""}`;
      const noun = video ? "відео" : "фото";
      const total = (await one<{ n: number }>(`select count(*)::int as n from media_asset a where ${where}`, [ws, sources]))?.n || 0;
      if (!total) {
        if (video) return unused
          ? "Вільних відео в медіатеці немає: усі вже стоять у постах. Нові - media_upload_link (заллє папку з комп'ютера) або кабінет: Налаштування → Джерела → Медіа-бібліотека."
          : "Відео в медіатеці ще немає. Залити з комп'ютера - media_upload_link (великі файли йдуть частинами), або автор завантажить у кабінеті: Налаштування → Джерела → Медіа-бібліотека.";
        return unused
          ? "Вільних фото в медіатеці немає: усі вже стоять у постах. Можна повторити фото (без unused_only), взяти сток (find_stock_photos) або попросити автора завантажити нові: Налаштування → Джерела → Медіа-бібліотека."
          : "Медіатека порожня. Автор може завантажити фото в кабінеті (Налаштування → Джерела → Медіа-бібліотека, можна одразу пачкою) або підключити там же папку Google Drive. Поки що - сток (find_stock_photos).";
      }
      const pages = Math.ceil(total / MEDIA_PAGE);
      const page = Math.min(int(a.page, 1, 1, 100000), pages);
      const rows = await q<{ id: string; original_name: string | null; filename: string; source: string; created_at: string; used_in: string | null; duration: number | null; width: number | null; height: number | null; size: number | null }>(
        `select a.id, a.original_name, a.filename, a.source, a.created_at, ${USED_IN} as used_in, a.duration, a.width, a.height, a.size
           from media_asset a where ${where} order by a.created_at desc limit ${MEDIA_PAGE} offset $3`,
        [ws, sources, (page - 1) * MEDIA_PAGE]);
      const tz = await wsTz(ws);
      const thumbs = await Promise.all(rows.map((r) => smallThumb(r.filename)));
      // номер у тексті мусить збігатися з порядком мініатюр - тож фото без мініатюри (файл не
      // читається) нумеруємо окремо, а не «пропускаємо», інакше модель прикріпила б не те фото
      const shown = rows.map((r, i) => ({ r, t: thumbs[i] })).filter((x) => x.t);
      const broken = rows.filter((_, i) => !thumbs[i]);
      const vmeta = (r: typeof rows[number]) => !video ? "" :
        [fmtDur(r.duration), r.width && r.height ? `${r.width}×${r.height}${r.height > r.width ? " вертикальне" : ""}` : "", r.size ? `${Math.round(r.size / 1048576)} МБ` : ""]
          .filter(Boolean).map((x) => ` · ${x}`).join("");
      const line = (r: typeof rows[number], n: number) =>
        `${n}. ${short(r.id)} · ${fmtWhen(r.created_at, tz)} · ${MEDIA_SRC[r.source] || r.source}` + vmeta(r) +
        (r.original_name ? ` · ${oneLine(r.original_name, 40)}` : "") +
        (r.used_in ? ` · ✓ уже в пості ${usedList(r.used_in)}` : "");
      return {
        text: [
          `Медіатека: ${total} ${noun}${unused ? " без поста" : ""} · сторінка ${page} з ${pages}.`,
          ...shown.map((x, i) => line(x.r, i + 1)),
          broken.length ? `Без мініатюри (файл не читається): ${broken.map((r) => short(r.id)).join(", ")}.` : "",
          shown.length ? `Мініатюри нижче, по черзі: ${shown.map((_, i) => i + 1).join(", ")}.` : "",
          page < pages ? `Далі - page: ${page + 1}.` : "",
          video ? "Обране відео прикріпи через attach_media (id поста + один id відео): Instagram - Reels, Facebook - відео, Threads, Telegram (до 50 МБ), LinkedIn."
            : "Обране прикріпи через attach_media (id поста + id фото).",
        ].filter(Boolean).join("\n"),
        images: shown.map((x) => x.t as ToolImage),
      };
    },
  },
  {
    name: "attach_media",
    title: "Прикріпити фото чи відео з медіатеки (одне, карусель або відео)",
    description: `БЕЗКОШТОВНО: прикріпити до поста фото чи відео з медіатеки кабінету (id з list_media). Кілька id фото масивом = КАРУСЕЛЬ у тому ж порядку (перше - обкладинка), до ${MAX_SLIDES} кадрів: Instagram і Threads отримають карусель, Facebook - галерею, Telegram - альбом, LinkedIn - кілька фото. Кожне фото обрізається під формат (типово 4:5; кадри каруселі - в одній пропорції), оригінали в медіатеці лишаються. ВІДЕО - один id (list_media з kind: "video"): воно замінює всі фото поста й публікується як Reels в Instagram, відео у Facebook, Threads, Telegram (до 50 МБ) і LinkedIn; фото поруч із відео не буває. Без append медіа ЗАМІНЮЄ наявне, з append: true фото додаються в кінець. Переставити чи прибрати кадри - edit_post_media. У відповіді - мініатюри того, що вийшло.`,
    properties: {
      id: S("Id поста."),
      // масив, але рядок теж приймаємо: чати, відкриті до каруселей, памʼятають стару схему (один id)
      media: { type: "array", items: { type: "string" }, description: "Id фото з list_media (#a1b2c3d4) по порядку: одне фото - масив з одного id, кілька - карусель." },
      aspect: ASPECT_ARG,
      append: { type: "boolean", description: "true - додати в кінець наявних кадрів, а не замінити їх." },
      alt_text: { ...ALT_ARG, description: "Опис кожного фото (alt-текст) у тому ж порядку, що й media: 1-2 речення, що на фото - ти бачиш мініатюри в list_media. Для незрячих і пошуку; іде в Instagram і LinkedIn. Порожній рядок чи без аргументу - опис, збережений на фото в медіатеці (якщо є); новий опис зберігається і на фото в медіатеці, якщо там його ще нема." },
    },
    required: ["id", "media"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const raw = Array.isArray(a.media) ? a.media : [a.media];
      const append = a.append === true;
      if (!raw.length) throw new ToolError("Вкажи id фото з list_media (#a1b2c3d4).");
      if (raw.length > MAX_SLIDES) throw new ToolError(`У каруселі до ${MAX_SLIDES} кадрів - передай не більше.`);
      const found = [];
      for (const r of raw) found.push(await libraryMediaId(ws, r));
      // 📱 сторіс: кадри по порядку, фото й відео разом; фото ріжемо 9:16, відео - як є
      if (p.format === "story") {
        const cur = append ? (await postMediaList(p.id)).map((m) => m.id) : [];
        if (cur.length + found.length > MAX_SLIDES) throw new ToolError(`У сторіс до ${MAX_SLIDES} кадрів - зараз ${cur.length}.`);
        const asp = a.aspect ? aspectArg(a.aspect) : "9:16";
        const ids: string[] = [];
        for (const m of found) ids.push(m.kind === "video" ? m.id : (await cropCopy(ws, m.id, asp)).id);
        try { await setPostMediaOrder(ws, p.id, [...cur, ...ids]); }
        catch (e: any) { if (e instanceof SlideError) throw new ToolError(e.message); throw e; }
        const after = await postMediaList(p.id);
        const thumbs = (await Promise.all(after.map((m) => smallThumb(m.filename)))).filter(Boolean) as ToolImage[];
        const longV = after.find((m) => m.kind === "video" && Number(m.duration) > 60);
        return {
          text: `${short(p.id)}: сторіс із ${after.length} ${after.length === 1 ? "кадру" : "кадрів"} (фото ${asp}) - кожен кадр піде окремою сторіс в Instagram і Facebook.` +
            (longV ? ` ⚠️ Відео ${short(longV.id)} довше за 60 с - Instagram таку сторіс не прийме, вріж його.` : "") + " Мініатюри нижче - по порядку кадрів.",
          images: thumbs,
        };
      }
      // 🎬 відео: одне й саме - замінює всі фото поста (без кропу: відео не ріжемо)
      if (found.some((m) => m.kind === "video")) {
        if (found.length > 1 || a.append === true)
          throw new ToolError("Відео публікується окремим постом: передай рівно один id відео без append (фото поруч із відео не буває).");
        try { await setPostVideo(ws, p.id, found[0].id); }
        catch (e: any) { if (e instanceof SlideError) throw new ToolError(e.message); throw e; }
        const v = (await postMediaList(p.id))[0];
        const used = (await one<{ u: string | null }>(`select ${USED_IN} as u from media_asset a where a.id=$1`, [v.id]))?.u;
        const others = usedList(used).split(", ").filter((x) => x && x !== short(p.id));
        const meta = [fmtDur(v.duration), v.width && v.height ? `${v.width}×${v.height}` : "", v.size ? `${Math.round(Number(v.size) / 1048576)} МБ` : ""].filter(Boolean).join(", ");
        const warn: string[] = [];
        if (Number(v.size) > 50 * 1048576) warn.push("Telegram бот не надішле відео понад 50 МБ - зніми Telegram із поста або стисни відео");
        if (Number(v.duration) > 300) warn.push("Threads приймає відео до 5 хв");
        if (v.width && v.height && v.width > v.height) warn.push("горизонтальне - у Reels покажеться з полями (найкраще 9:16)");
        const thumb = await smallThumb(v.filename);
        return {
          text: `${short(p.id)}: відео ${short(v.id)} прикріплено${meta ? ` (${meta})` : ""} - Instagram: Reels, Facebook: відео, Threads, Telegram, LinkedIn; текст поста - підпис.` +
            (warn.length ? ` ⚠️ ${warn.join("; ")}.` : "") +
            (others.length ? ` Це відео вже стоїть у ${others.join(", ")}.` : "") + (thumb ? " Кадр із відео - нижче." : ""),
          images: thumb ? [thumb] : [],
        };
      }
      const ids = found.map((m) => m.id);
      const before = await postMediaList(p.id);
      if (append && before.length + ids.length > MAX_SLIDES)
        throw new ToolError(`У каруселі до ${MAX_SLIDES} кадрів - зараз ${before.length}, тож додати можна ще ${Math.max(0, MAX_SLIDES - before.length)}.`);
      const aspect = aspectArg(a.aspect);
      try {
        if (!append) {
          // перше - обкладинкою (з базою під текст, як у кабінеті), решта - кадрами в тій самій пропорції
          await attachCroppedImage(ws, p.id, ids[0], aspect);
          const cover = (await postMediaList(p.id))[0];
          await setPostMediaOrder(ws, p.id, cover ? [cover.id] : []);
          for (const id of ids.slice(1)) await appendCroppedSlide(ws, p.id, id, aspect);
        } else {
          for (const id of ids) await appendCroppedSlide(ws, p.id, id, before.length ? undefined : aspect);
        }
      } catch (e: any) { if (e instanceof SlideError) throw new ToolError(e.message); throw e; }
      if (a.alt_text !== undefined) await applyAltTexts(p.id, a.alt_text, { onlyLast: ids.length, emptyClears: false });
      const after = await postMediaList(p.id);
      const altN = after.filter((m) => m.kind !== "video" && m.alt_text).length;
      const others = new Set<string>();
      for (const id of ids) {
        const used = (await one<{ u: string | null }>(`select ${USED_IN} as u from media_asset a where a.id=$1`, [id]))?.u;
        usedList(used).split(", ").filter((x) => x && x !== short(p.id)).forEach((x) => others.add(x));
      }
      const thumbs = (await Promise.all(after.map((m) => smallThumb(m.filename)))).filter(Boolean) as ToolImage[];
      // називаємо, ЯКІ саме фото стали кадрами: мініатюри модель бачить, а id - потрібні для наступних кроків
      const what = append
        ? `додано ${ids.length} ${ids.length === 1 ? "кадр" : "кадри"} (${ids.map(short).join(", ")}) - тепер ${after.length > 1 ? `карусель із ${after.length} кадрів` : "одне фото"}`
        : ids.length === 1
          ? `фото ${short(ids[0])} з медіатеки прикріплено (${aspect})`
          : `карусель із ${after.length} кадрів (${aspect}): ${ids.map(short).join(", ")} - перше обкладинка`;
      const repeat = others.size
        ? (ids.length === 1 ? ` Це фото вже стоїть у ${[...others].join(", ")}` : ` Ці фото вже стоять і в ${[...others].join(", ")}`) + " - якщо повтор небажаний, обери інше (list_media з unused_only)."
        : "";
      const altLine = altN ? ` Опис фото (alt): ${altN} з ${after.length}.` : " Опису фото (alt-текст) ще нема - передай alt_text, це допомагає незрячим і пошуку Instagram.";
      return { text: `${short(p.id)}: ${what}.${repeat}${altLine}${after.length > 1 ? " Мініатюри нижче - по порядку кадрів." : ""}`, images: thumbs };
    },
  },
  {
    name: "edit_post_media",
    title: "Кадри поста: показати, переставити, прибрати",
    description: "БЕЗКОШТОВНО: показати фото поста по порядку (з мініатюрами), переставити кадри каруселі чи прибрати зайві. order - повний новий порядок наявних кадрів (id з відповіді цього інструмента); remove - що прибрати. Без order і remove - просто показує кадри. Перший кадр - обкладинка.",
    properties: {
      id: S("Id поста."),
      order: { type: "array", items: { type: "string" }, description: "Новий порядок кадрів (id #a1b2c3d4 з цього інструмента). Кадри, яких нема в списку, прибираються." },
      remove: { type: "array", items: { type: "string" }, description: "Id кадрів, які прибрати." },
    },
    required: ["id"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      let cur = await postMediaList(p.id);
      const pick = (v: unknown): string => {
        const pat = idPattern(v);
        const hit = pat ? cur.filter((m) => m.id.startsWith(pat)) : [];
        if (hit.length !== 1) throw new ToolError(`Кадру ${short(String(v || "?"))} у цьому пості немає - візьми id з edit_post_media без аргументів.`);
        return hit[0].id;
      };
      const changed = Array.isArray(a.order) || Array.isArray(a.remove);
      if (changed) {
        let ids = Array.isArray(a.order) ? a.order.map(pick) : cur.map((m) => m.id);
        const drop = Array.isArray(a.remove) ? a.remove.map(pick) : [];
        ids = ids.filter((id) => !drop.includes(id));
        try { await setPostMediaOrder(ws, p.id, ids); } catch (e: any) { if (e instanceof SlideError) throw new ToolError(e.message); throw e; }
        cur = await postMediaList(p.id);
      }
      if (!cur.length) return `${short(p.id)}: фото немає. Додати - attach_media (з медіатеки), attach_stock_photo, generate_image чи render_carousel (кадри зі сценарію).`;
      const thumbs = (await Promise.all(cur.map((m) => smallThumb(m.filename)))).filter(Boolean) as ToolImage[];
      return {
        text: [
          `${short(p.id)}: ${cur.length > 1 ? `карусель, ${cur.length} кадрів` : "одне фото"}${changed ? " (оновлено)" : ""}:`,
          ...cur.map((m, i) => `${i + 1}. ${short(m.id)}${i === 0 ? " · обкладинка" : ""}`),
          "Мініатюри нижче - у тому ж порядку.",
        ].join("\n"),
        images: thumbs,
      };
    },
  },
  {
    name: "render_carousel",
    title: "Зібрати кадри каруселі зі сценарію",
    description: `БЕЗКОШТОВНО (без моделі, лише верстка): намалювати кадри-картинки каруселі зі сценарію - на кожен слайд окрема картинка з великим заголовком і текстом, лічильник 2/8, нік бренду. Передай slides - тексти слайдів по порядку (2-${MAX_SLIDES}; перший рядок слайда стає заголовком, решта - текстом); тоді текст поста лишається підписом під каруселлю, тож пиши його окремо коротким. Без slides сценарій береться з тексту поста (рядки «Слайд 1: …», «Слайд 2: …»), а текст поста стає підписом (з рядка «Підпис: …», якщо він є). theme: photo (на фоні фото поста, типово, якщо фото є), dark, light. Кадри ЗАМІНЮЮТЬ наявні фото поста. Для поста у форматі story - кадри сторіс 9:16 (від одного, рядки «Кадр 1: …»), текст поста не чіпається. У відповіді - мініатюри.`,
    properties: {
      id: S("Id поста."),
      slides: { type: "array", items: { type: "string" }, description: "Тексти слайдів по порядку (необовʼязково)." },
      theme: { type: "string", enum: CAROUSEL_THEMES, description: "photo | dark | light." },
      accent: S("Акцентний колір #RRGGBB (слова в *зірочках* чи **жирні** на кадрі - цим кольором). Типово жовтий."),
    },
    required: ["id"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const slides = Array.isArray(a.slides) ? a.slides.map((x: unknown) => str(x, 600)).filter(Boolean) : undefined;
      let r;
      try { r = await renderCarousel(ws, p.id, { slides, theme: a.theme ? String(a.theme) : undefined, accent: str(a.accent, 7) }); }
      catch (e: any) { if (e instanceof SlideError) throw new ToolError(e.message); throw e; }
      const cur = await postMediaList(p.id);
      const thumbs = (await Promise.all(cur.map((m) => smallThumb(m.filename)))).filter(Boolean) as ToolImage[];
      return {
        text: `${short(p.id)}: зібрано ${r.count} кадрів${p.format === "story" ? " сторіс 9:16" : ""} (тема ${r.theme}).` +
          (r.captionChanged ? ` Сценарій перенесено в слайди, а текст поста тепер ПІДПИС під каруселлю: «${oneLine(r.caption, 200)}». Перевір і за потреби онови update_post.` : "") +
          (r.truncated.length ? ` ⚠️ На кадрах ${r.truncated.join(", ")} текст не вмістився й обрізаний - скороти ці слайди й збери ще раз.` : "") +
          " Мініатюри нижче - по порядку.",
        images: thumbs,
      };
    },
  },
  {
    name: "media_upload_link",
    title: "Залити фото й відео з комп'ютера в медіатеку",
    description: "Разове посилання, щоб залити фото й ВІДЕО з комп'ютера автора в медіатеку кабінету, МИНАЮЧИ чат. Є термінал (Claude Code, Cowork) - запусти готову команду з відповіді на папку: файли підуть із диска прямо на сервер (великі відео - частинами), у твій контекст не потрапить жоден байт, тож відкривати файли перед заливкою не треба. Терміналу нема - віддай посилання людині: у браузері воно відкриває сторінку, куди фото й відео просто перетягуються. Посилання лише ДОДАЄ файли в цей кабінет (нічого не читає), діє обмежений час, до 200 файлів і 5 ГБ; повтор тієї самої папки копій не плодить. Після заливки - list_media з unused_only: true (для відео - kind: \"video\").",
    properties: {
      minutes: N("Скільки хвилин діє посилання: 5-180, типово 60.", { minimum: 5, maximum: 180 }),
    },
    run: async (ws, a, ctx) => {
      const minutes = clampMinutes(a.minutes);
      const { token, expiresAt } = await issueUploadLink(ws, ctx.userId, minutes);
      const url = uploadUrl(token);
      const cmd = uploadCommands(url);
      const title = await workspaceTitle(ws);
      await logEvent("info", "mcp", `посилання на заливку фото й відео в «${title}» на ${minutes} хв`, null);
      return [
        `📤 Посилання для заливки фото й відео в медіатеку «${title}» - діє до ${fmtWhen(expiresAt, await wsTz(ws))}, до ${UPLOAD_MAX_FILES} файлів:`,
        url,
        "",
        "Є термінал - залий папку однією командою (підстав справжній шлях):",
        "macOS / Linux / Git Bash / Cowork:",
        cmd.unix,
        "Команда завантажує короткий скрипт (його можна прочитати: він лише читає файли з указаної папки й шле їх на це посилання) і запускає його. Фото й відео будь-якого розміру до 500 МБ - великі йдуть частинами по 15 МБ, обрив шматка повторюється сам. На кожен файл - рядок: ✓ збережено, = уже було в медіатеці, ✗ причина.",
        "Windows PowerShell (лише фото до 20 МБ; відео - через Git Bash командою вище або сторінкою):",
        cmd.windows,
        "",
        "Терміналу нема - дай посилання людині: у браузері воно відкриває сторінку, куди фото й відео просто перетягуються.",
        "Фото: JPG, PNG, WebP, HEIC. Відео: MP4, MOV, WebM. Далі: list_media (unused_only: true; для відео kind: \"video\") → attach_media.",
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
    description: "БЕЗКОШТОВНО: прикріпити до поста фото, знайдене через find_stock_photos. Фото обрізається під формат (типово 4:5) і стає зображенням поста в усіх мережах; з append: true - додається кадром каруселі. У відповіді - мініатюра того, що вийшло.",
    properties: {
      id: S("Id поста."),
      url: S("url фото з find_stock_photos."),
      aspect: ASPECT_ARG,
      append: { type: "boolean", description: "true - додати кадром каруселі в кінець, а не замінити обкладинку." },
    },
    required: ["id", "url"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const url = str(a.url, 500);
      // лише Pexels: інакше інструмент став би способом змусити сервер завантажити будь-яку адресу
      if (!/^https:\/\/images\.pexels\.com\//.test(url)) throw new ToolError("Приймаю лише url із find_stock_photos (images.pexels.com).");
      const append = a.append === true && (await postMediaList(p.id)).length > 0;
      const aspect = aspectArg(a.aspect);
      let r;
      try { r = await attachStockPhoto(ws, p.id, url, append ? undefined : aspect, append); }
      catch (e: any) { if (e instanceof SlideError) throw new ToolError(e.message); throw e; }
      const thumb = await fileThumb(r.filename);
      const n = (await postMediaList(p.id)).length;
      return { text: `${short(p.id)}: фото зі стоку ${append ? `додано кадром ${n}` : `прикріплено (${aspect})`}.`, images: thumb ? [thumb] : [] };
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
      append: { type: "boolean", description: "true - додати кадром каруселі в кінець (обкладинка лишається), а не замінити її." },
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
      const append = a.append === true && (await postMediaList(p.id)).length > 0;
      const aspect = aspectArg(a.aspect);
      const filename = await generateImageForPost(ws, p.id, { prompt: str(a.prompt, 1200) || undefined, provider: (prov || undefined) as any, aspect: append ? undefined : aspect, append });
      const thumb = await fileThumb(filename);
      const n = (await postMediaList(p.id)).length;
      return { text: `${short(p.id)}: зображення згенеровано й ${append ? `додано кадром ${n}` : `прикріплено (${aspect}${prov ? `, ${prov}` : ""})`}.`, images: thumb ? [thumb] : [] };
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
    description: "Опублікувати пост у соцмережі ПРЯМО ЗАРАЗ. Публікація йде тим самим шляхом, що й з кабінету: дедуп «раз на мережу», авто-упаковка під формат мережі, посилання після відправки. Якщо мережі обробляють медіа довше за ~40 с, відповідь скаже «триває у фоні» - тоді результат і посилання дивись у get_post, повторно не клич. Такий самий текст, уже опублікований у цю мережу, відхиляється як дубль (свідомо повторити - force: true).",
    properties: {
      id: S("Id поста."),
      channels: { ...NETS_ARG, description: "Мережі (необовʼязково - інакше беруться вже обрані на пості)." },
      force: { type: "boolean", description: "true - опублікувати, навіть якщо такий самий текст уже виходив у цю мережу." },
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
      if (a.force !== true) {
        const tz0 = await wsTz(ws);
        const dup = (await scheduleConflicts(ws, p.id, null, nets)).filter((c) => c.kind === "text" && c.state === "sent");
        if (dup.length) throw new ToolError(`⚠️ Схоже на дубль: ${describeConflicts(dup, (x) => fmtWhen(x, tz0), (n) => NET_LABEL[n] || n, short).join("; ")}. Якщо так і задумано - повтори з force: true.`);
      }
      // Публікація - та сама фонова джоба, що й у кабінеті (дедуп за постом): Instagram і Threads
      // обробляють медіа до хвилини, і один довгий запит упирався в 60-секундну межу проксі - конектор
      // бачив 502, хоча публікація тривала, а повтор натикався на «пост саме зараз публікується».
      const job = await startJob("publish", p.id, ws, async () => {
        const results = await publishPostToChannels(ws, p.id);
        // погасити запланований слот (інакше автопостер відправив би той самий пост удруге) - лише коли
        // вийшло в усі обрані мережі: збій «зараз» не має тихо скасовувати заплановану публікацію
        if (results.some((r) => r.status === "sent")) await closeSlotsIfDone(p.id, "опубліковано з Claude (MCP)");
        return { results };
      });
      let j: any = job;
      // ~40 с - із запасом до 60-секундної межі проксі (у тестах коротше: MCP_PUBLISH_WAIT_MS)
      const waitMs = Number(process.env.MCP_PUBLISH_WAIT_MS) || 40_000;
      for (const t0 = Date.now(); j && j.status === "running" && Date.now() - t0 < waitMs;) { await sleep(500); j = await getJob(job.id); }
      if (!j || j.status === "running")
        return `⏳ Публікація в ${netList(nets)} триває у фоні: мережі ще обробляють медіа. Результат і посилання - у get_post ${short(p.id)} за хвилину. Повторно publish_post не клич: дубля не буде, але й швидше не стане.`;
      if (j.status !== "done") throw new ToolError(`⚠️ Не опубліковано: ${j.error || "публікацію обірвано - спробуй ще раз"}`);
      const res: PubResult[] = (j.result && j.result.results) || [];
      const cms = res.filter((r) => r.status === "sent" && r.comment)
        .map((r) => `${NET_LABEL[r.channel] || r.channel} ${COMMENT_UA[r.comment!.status] || r.comment!.status}${r.comment!.error ? `: ${r.comment!.error}` : ""}`);
      const ok = res.filter((r) => r.status === "sent").map((r) => NET_LABEL[r.channel] || r.channel);
      // пост вийшов, але частина доповнень ні (співавтори/опис фото не прийняті, довгий текст Telegram)
      const notes = res.filter((r) => r.status === "sent" && r.note).map((r) => `${NET_LABEL[r.channel] || r.channel}: ${r.note}`);
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
        cms.length ? `💬 Перший коментар: ${cms.join("; ")}` : "",
        notes.length ? `⚠️ ${notes.join("; ")}` : "",
        links.filter((x) => x.link).map((x) => `${NET_LABEL[x.net]}: ${x.link}`).join("\n"),
      ].filter(Boolean).join("\n") || "Нічого не відправлено.";
    },
  },
  {
    name: "schedule_post",
    title: "Запланувати публікацію",
    description: "Поставити пост у календар на дату й час. Час читається в часовому поясі кабінету. Відправить автопостер - нічого додатково робити не треба. Відмовить, якщо в ту саму мережу ±5 хв уже стоїть інший пост або такий самий текст уже заплановано чи опубліковано (свідомо - force: true). Прибрати з календаря - unschedule_post.",
    properties: {
      id: S("Id поста."),
      at: S("Коли: «2026-09-14 09:00», «завтра 18:30», «14.09 09:00» або ISO з Z."),
      channels: { ...NETS_ARG, description: "Мережі (необовʼязково - інакше вже обрані на пості)." },
      force: { type: "boolean", description: "true - поставити попри збіг часу чи тексту з іншим постом." },
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
      if (!String(p.content || "").trim() && p.format !== "story") throw new ToolError("Пост порожній - спершу додай текст (update_post).");
      if (a.force !== true) {
        const clash = await scheduleConflicts(ws, p.id, at, on);
        if (clash.length) throw new ToolError(`⚠️ Не ставлю, щоб не вийшов дубль: ${describeConflicts(clash, (x) => fmtWhen(x, tz), (n) => NET_LABEL[n] || n, short).join("; ")}. Обери інший час або текст; якщо так і задумано - повтори з force: true.`);
      }
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
      if (ex) await q(`update schedule_slot set scheduled_at=$2, retry_at=null, attempts=0, updated_at=now() where id=$1`, [ex.id, at.toISOString()]);
      else await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [p.id, at.toISOString()]);
      await q(`update post set review='approved' where id=$1`, [p.id]);   // запланований = затверджений
      const fcPlan = commentPlanLines({ ...p, channels: chNow }, on, await commentStates(p.id), await alreadySentNetworks(p.id), await metaGranted(ws));
      return `🗓 ${short(p.id)} заплановано на ${fmtWhen(at, tz)}: ${publishPlanLine(publishPlan(chNow, p.content))}.${ex ? " Наявний слот перенесено." : ""}`
        + (fcPlan.length ? "\n" + fcPlan.join("\n") : "");
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
      const rows = await q<{ id: string; scheduled_at: string; status: string; result: string | null; post_id: string; content: string; channels: any; slot_ch: any; review: string | null }>(
        `select ss.id, ss.scheduled_at, ss.status, ss.result, p.id as post_id, p.content, p.channels, ss.channels as slot_ch, p.review
           from schedule_slot ss
           join post p on p.id=ss.post_id
           join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
          where s.workspace_id=$1 and ss.scheduled_at is not null
            and ss.scheduled_at between now() - interval '2 days' and now() + ($2 || ' days')::interval
          order by ss.scheduled_at`, [ws, String(days)]);
      if (!rows.length) return `На найближчі ${days} дн. нічого не заплановано.`;
      return rows.map((r) => {
        const mark = r.status === "posted" ? "✈️" : r.status === "failed" ? "⚠️" : r.status === "posting" ? "⏳" : "🗓";
        // мережі - як їх візьме автопостер: увімкнені в пості (× підмножина слота, якщо вона є)
        const nets = enabledNets(r.channels).filter((n) => !r.slot_ch || (r.slot_ch[n] && r.slot_ch[n].on));
        const warn = r.status === "planned" && !nets.length ? " · ⚠️ без мереж - не вийде (unschedule_post)" : "";
        const draft = r.status === "planned" && r.review !== "approved" ? " · не затверджено" : "";
        return `${mark} ${fmtWhen(r.scheduled_at, tz)} · ${short(r.post_id)} · ${nets.length ? netList(nets) : "мережі не обрані"}${draft}${warn}${r.status === "failed" && r.result ? ` · помилка: ${oneLine(r.result, 120)}` : ""}\n${oneLine(r.content, 140)}`;
      }).join("\n\n");
    },
  },
  {
    name: "unschedule_post",
    title: "Зняти з розкладу",
    description: "Прибрати пост із календаря: заплановані й невдалі слоти видаляються, сам пост лишається (як чернетка чи затверджений - затвердження не знімається). Опубліковане не чіпає.",
    properties: { id: S("Id поста.") },
    required: ["id"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      const n = await unschedulePost(p.id);
      return n ? `${short(p.id)}: знято з розкладу (${n} ${n === 1 ? "слот" : n < 5 ? "слоти" : "слотів"}). Пост лишився в чернетках.` : `${short(p.id)} у розкладі не стояв.`;
    },
  },
  {
    name: "send_first_comment",
    title: "Дослати перший коментар",
    description: "Поставити перший коментар під постом, який УЖЕ опубліковано: коментар дописали після публікації, раніше не було дозволу або він не вийшов. Можна одразу передати новий текст (text). Іде в Instagram, Facebook, LinkedIn і Threads - туди, куди пост уже вийшов і де коментаря ще нема; другого коментаря не буде. Для ще не опублікованого поста нічого робити не треба: коментар піде сам одразу після публікації.",
    properties: {
      id: S("Id поста."),
      text: S("Новий текст спільного першого коментаря (необовʼязково - інакше береться вже збережений)."),
    },
    required: ["id"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      if (typeof a.text === "string" && a.text.trim()) await applyFirstComment(p.id, p.channels, a.text, undefined);
      const sentNets = (await alreadySentNetworks(p.id)).filter((n) => COMMENT_NETS.includes(n));
      if (!sentNets.length) {
        const nets = enabledNets(p.channels).filter((n) => COMMENT_NETS.includes(n));
        throw new ToolError(nets.length
          ? `${short(p.id)} ще не опубліковано в ${netList(nets)} - коментар піде сам одразу після публікації (publish_post або schedule_post).`
          : `${short(p.id)} не публікувався в мережі з коментарями (Instagram, Facebook, LinkedIn, Threads).`);
      }
      const r = await queueMissingComments(ws, p.id);
      // надсилаємо у фоні й чекаємо ~30 с (межа проксі - 60 с): Meta може повторювати «пост ще не видно»
      const work = r.queued.length ? processDueComments(p.id).catch(() => [] as CommentState[]) : Promise.resolve([] as CommentState[]);
      const waitMs = Number(process.env.MCP_PUBLISH_WAIT_MS) || 30_000;
      await Promise.race([work, sleep(waitMs)]);
      const states = await commentStates(p.id);
      const line = (n: string) => {
        const st = states.find((x) => x.network === n);
        if (!st) return null;
        if (st.status === "sent") return `${NET_LABEL[n]} ✓`;
        if (st.status === "failed") return `${NET_LABEL[n]} ⚠️ ${st.error || "не вийшов"}`;
        return `${NET_LABEL[n]} ⏳ ${st.error ? `повторимо автоматично (${oneLine(st.error, 120)})` : "надсилається - стан у get_post"}`;
      };
      const out = [
        r.queued.length ? `💬 ${r.queued.map(line).filter(Boolean).join("; ")}` : "",
        r.sent.length ? `Уже стоїть раніше: ${netList(r.sent)} - другого коментаря не буде.` : "",
        r.busy.length ? `Саме зараз надсилається: ${netList(r.busy)}.` : "",
        r.none.length ? `Без тексту коментаря: ${netList(r.none)} - передай text або first_comment через update_post.` : "",
      ].filter(Boolean);
      if (!r.queued.length && !r.sent.length && !r.busy.length)
        throw new ToolError(`Нічого надсилати: у ${short(p.id)} немає тексту першого коментаря - передай text.`);
      return `${short(p.id)}: ${out.join("\n")}`;
    },
  },
  {
    name: "delete_post",
    title: "Видалити пост",
    description: "Видалити чернетку чи запланований пост НАЗАВЖДИ (разом із його слотами в календарі). Опублікований пост видалити не можна - він лишається в історії й аналітиці; прибрати його з календаря - unschedule_post. Незворотно: спершу покажи людині, що саме видаляєш.",
    properties: { id: S("Id поста.") },
    required: ["id"],
    run: async (ws, a) => {
      const p = await findPost(ws, a.id);
      if (isPublishingNow(p.id)) throw new ToolError("Пост саме зараз публікується - дочекайся результату (get_post).");
      const sent = [...new Set([...(await alreadySentNetworks(p.id)), ...(await reelSentNetworks(p.id))])];
      if (sent.length) throw new ToolError(`Пост уже опубліковано (${netList(sent)}) - видалення стерло б історію публікацій і аналітику. Прибрати з календаря: unschedule_post.`);
      // скелет плану, що чекав на цей пост, звільняється (інакше слот плану вказував би в нікуди)
      await q(`update plan_slot set status = case when match_source_id is null then 'empty' else 'matched' end, post_id=null
               where post_id=$1 and status in ('drafted','approved','scheduled')`, [p.id]);
      await q(`delete from post where id=$1`, [p.id]);
      await logEvent("info", "mcp", `пост ${short(p.id)} видалено з Claude`, null);
      return `🗑 ${short(p.id)} видалено («${oneLine(p.content, 80)}»).`;
    },
  },
  {
    name: "upload_media",
    title: "Завантажити файл у медіатеку",
    description: "Завантажити ОДНЕ фото чи відео в медіатеку кабінету: за прямим публічним посиланням на файл (url) або вмістом у base64 (лише невеликі файли, до 5 МБ - base64 іде через чат і зʼїдає контекст). Папку з компʼютера чи великі відео краще заливати через media_upload_link: скрипт шле файли напряму, повз чат. Той самий файл удруге не дублюється. Отриманий id передай в attach_media.",
    properties: {
      url: S("Пряме посилання на сам файл (https://…/photo.jpg). Сторінка, на якій картинка, не підійде."),
      base64: S("Вміст файлу в base64 (можна з префіксом data:…), до 5 МБ."),
      filename: S("Імʼя файлу з розширенням, напр. photo.jpg (для base64 бажано)."),
    },
    run: async (ws, a) => {
      const url = str(a.url, 2000);
      const b64 = String(a.base64 ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
      if (!url && !b64) throw new ToolError("Передай url (пряме посилання на файл) або base64. Для папки з компʼютера - media_upload_link.");
      const dir = join(MEDIA_DIR, "tmp");
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `mcp-${randomBytes(8).toString("hex")}`);
      let name = str(a.filename, 120);
      const max = (Number(process.env.UPLOAD_MAX_MB) || 500) * 1048576;
      try {
        if (b64) {
          if (b64.length > 7_000_000) throw new ToolError("base64 завеликий (понад ~5 МБ). Для великих файлів - url або media_upload_link.");
          const buf = Buffer.from(b64, "base64");
          if (buf.length < 64) throw new ToolError("base64 порожній або битий.");
          await writeFile(tmp, buf);
        } else {
          let res: Response;
          try { res = await publicFetch(url, { signal: AbortSignal.timeout(120_000), headers: { "user-agent": "socialio-media-import/1.0" } }); }
          catch (e: any) { throw new ToolError(`Не вдалося завантажити за посиланням: ${e.message}`); }
          if (!res.ok || !res.body) throw new ToolError(`Посилання відповіло ${res.status} - потрібне пряме публічне посилання на файл.`);
          const len = Number(res.headers.get("content-length") || 0);
          if (len > max) throw new ToolError(`Файл ${Math.round(len / 1048576)} МБ - більше за межу ${Math.round(max / 1048576)} МБ.`);
          const fh = await openFile(tmp, "w");
          let got = 0;
          try {
            for await (const chunk of res.body as any) {
              got += chunk.length;
              if (got > max) throw new ToolError(`Файл більший за ${Math.round(max / 1048576)} МБ.`);
              await fh.write(chunk);
            }
          } finally { await fh.close(); }
          if (!name) { try { name = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch { name = ""; } }
        }
        let saved: { id: string; kind: string; existed?: boolean };
        try { saved = await saveMediaFile(ws, tmp, { name: name || "upload", source: "upload", dedupe: true }); }
        catch (e: any) { throw new ToolError(e.message); }
        await logEvent("info", "mcp", `файл у медіатеку з Claude (${saved.kind}${saved.existed ? ", уже був" : ""})`, null);
        return `${saved.existed ? "↩️ Такий файл уже є в медіатеці" : "✅ Завантажено"}: ${saved.kind === "video" ? "відео" : "фото"} ${short(saved.id)}. Далі: attach_media з id ${short(saved.id)} і id поста.`;
      } finally { await unlink(tmp).catch(() => {}); }
    },
  },
  {
    name: "analytics",
    title: "Аналітика публікацій",
    description: "Статистика за період: скільки постів вийшло по мережах, перегляди, лайки, відповіді й коментарі, репости й поширення, збереження, залученість по КОЖНОМУ посту, приріст підписників по мережах, висновки «що працює» (тип поста, перший рядок, довжина, час, рубрика) і найсильніші пости відносно норми мережі. Цифри по постах віддають Threads, Instagram і Facebook (Instagram - ще й скільки людей підписалось після поста); Telegram і LinkedIn через API - лише факт публікації (для Telegram - ще підписники каналу). Статистика оновлюється раз на добу, свіжі пости - кожні 6 годин; з нормою мережі пост порівнюється, коли минуло 2 доби після публікації (раніше він ще набирає перегляди).",
    properties: {
      days: N("Період у днях (1-365, типово 30).", { minimum: 1, maximum: 365 }),
      network: S("Лише одна мережа (необовʼязково).", { enum: ["threads", "instagram", "facebook", "telegram", "linkedin"] }),
      sort: S("Порядок постів: new (типово - новіші перші) або top (найсильніші відносно норми мережі).", { enum: ["new", "top"] }),
      limit: N("Скільки постів показати (1-50, типово 15).", { minimum: 1, maximum: 50 }),
    },
    readOnly: true,
    run: async (ws, a) => {
      const tz = await wsTz(ws);
      const days = int(a.days, 30, 1, 365);
      const net = ["threads", "instagram", "facebook", "telegram", "linkedin"].includes(String(a.network)) ? String(a.network) : "all";
      const an = await analyticsFor(ws, days, net);
      const k = an.kpi;
      if (!k.sends) return `За ${days} дн. публікацій не було${net !== "all" ? ` у ${NET_LABEL[net]}` : ""}.`;
      const nf = (x: number) => Math.round(x).toLocaleString("uk-UA");
      const snapAge = (h: number | null) => (h == null ? "перші години" : h < 1 ? `${Math.max(1, Math.round(h * 60))} хв` : `${Math.round(h)} год`);
      const vsPrev = (cur: number, prev: number) => (prev ? ` (${cur >= prev ? "+" : ""}${Math.round(((cur - prev) / prev) * 100)}% до попередніх ${days} дн.)` : "");
      const lines: string[] = [
        `За ${days} дн. опубліковано ${k.posts} постів (${k.sends} відправок): ${Object.entries(k.sendsByNet).map(([n, c]) => `${NET_LABEL[n] || n} ${c}`).join(" · ")}`,
      ];
      if (k.measured) lines.push(`Перегляди: ${nf(k.views)}${vsPrev(k.views, k.viewsPrev)} · взаємодії: ${nf(k.interactions)} · залученість: ${k.er == null ? "—" : (k.er * 100).toFixed(1) + "%"} (цифри є для ${k.measured} з ${k.sends} публікацій)`);
      const fl = Object.entries(an.followers);
      if (fl.length) lines.push(`Підписники: ${fl.map(([n, f]) => `${NET_LABEL[n] || n} ${f.now == null ? "—" : nf(f.now)}${f.delta != null ? ` (${f.delta >= 0 ? "+" : ""}${nf(f.delta)} з ${f.since})` : ""}`).join(" · ")}`);
      for (const n of ["threads", "instagram", "facebook"]) {
        const c = (an.coverage as any)[n];
        if (c && c.published && !c.measured && c.error) lines.push(`⚠️ ${NET_LABEL[n]}: переглядів нема - ${oneLine(c.error, 170)}`);
      }
      const noPer = ["telegram", "linkedin"].filter((n) => (an.coverage as any)[n]?.published);
      if (noPer.length) lines.push(`${netList(noPer)}: API не віддає переглядів окремих постів - там лише факт публікації.`);
      if (an.insights.length) lines.push("", "Висновки:", ...an.insights.map((i) => `- ${i.text}`));
      const withNums = an.posts.filter((p) => p.views != null || p.likes != null || p.replies != null);
      // «найсильніші»: за множником до норми мережі, а поки норми нема (менше 3 постів) - за переглядами й лайками
      const list = a.sort === "top" ? [...withNums].sort((x, y) => ((y.mult ?? -1) - (x.mult ?? -1)) || ((y.views ?? -1) - (x.views ?? -1)) || ((y.likes ?? -1) - (x.likes ?? -1))) : withNums;
      if (list.length) {
        lines.push("", `${a.sort === "top" ? "Найсильніші пости" : "Пости з цифрами (новіші перші)"}; ×норма = перегляди до медіани своєї мережі за період (пости молодші за 2 доби ще набирають перегляди - з нормою їх не порівнюємо):`);
        for (const p of list.slice(0, int(a.limit, 15, 1, 50))) {
          const m = [
            p.views != null ? `👁 ${nf(p.views)}` : "", p.likes != null ? `❤️ ${nf(p.likes)}` : "",
            p.replies != null ? `💬 ${nf(p.replies)}` : "", p.shares != null ? `🔁 ${nf(p.shares)}` : "",
            p.saves != null ? `🔖 ${nf(p.saves)}` : "", p.follows != null ? `➕ ${nf(p.follows)} підписок` : "",
            p.er != null ? `ER ${(p.er * 100).toFixed(1)}%` : "",
            p.young ? `🕐 ще набирає (цифри за ${snapAge(p.snap_h)} після публікації)` : p.mult != null ? fmtMult(p.mult) : "",
          ].filter(Boolean).join(" · ");
          lines.push(`${fmtWhen(p.created_at, tz)} · ${NET_LABEL[p.net] || p.net} · ${short(p.post_id)} · ${m}${p.permalink ? ` · ${p.permalink}` : ""}\n«${oneLine(p.title, 110)}»`);
        }
      } else if (an.posts.length) lines.push("", "Цифр по постах ще нема: статистика збирається раз на добу після публікації.");
      const cost = await one<{ usd: string }>(
        `select coalesce(sum(cost),0)::text as usd from llm_usage where workspace_id=$1 and created_at > now() - ($2 || ' days')::interval`, [ws, String(days)]);
      lines.push("", `Витрати на AI socialio за період: $${Number(cost?.usd || 0).toFixed(2)}`);
      return lines.join("\n");
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
  `Карусель: кілька фото в одному пості (до ${MAX_SLIDES}) - attach_media масивом id або append: true у attach_media / attach_stock_photo / generate_image; кадри-картинки зі сценарію «Слайд 1: …» малює render_carousel (безкоштовно), і тоді текст поста - це короткий підпис під каруселлю, не сценарій.`,
  "Відео: власні відео автора - list_media з kind: \"video\" → attach_media з одним id; публікується як Reels в Instagram, відео у Facebook, Threads, Telegram (до 50 МБ) і LinkedIn, а текст поста - підпис. Відео з комп'ютера заливає та сама media_upload_link (великі файли - частинами).",
  "Сторіс: create_draft з format: \"story\" і мережами instagram/facebook (інші сторіс через API не приймають) → кадри через attach_media (фото й відео разом, фото ріжуться 9:16) або render_carousel з рядками «Кадр 1: …»; кожен кадр - окрема сторіс, підпису немає.",
  "Якщо кабінетів кілька (list_workspaces), спершу переконайся, що активний саме той бренд: перемкни switch_workspace або передай workspace у виклику. Кожна відповідь називає кабінет у першому рядку - звіряйся з ним перед публікацією.",
  "Файл з інтернету (пряме посилання) чи невеликий файл у base64 - upload_media; папка з компʼютера - media_upload_link.",
  "Календар: schedule_post відмовить, якщо в ту саму мережу майже в той самий час уже стоїть пост або такий текст уже є (свідомо - force: true); прибрати з календаря - unschedule_post, чернетку назавжди - delete_post (опубліковане не видаляється). publish_post, що відповів «триває у фоні», не повторюй - результат у get_post.",
  "Перший коментар (посилання, хештеги, заклик окремо від тексту): first_comment у create_draft / update_post, свій для мережі - first_comment_by_network; іде сам одразу після публікації в Instagram, Facebook, LinkedIn і Threads (у Telegram і сторіс - ні). Посилання в тексті LinkedIn і Facebook ріже охоплення - краще в перший коментар. Дописали коментар після публікації - send_first_comment.",
  "Instagram: опис фото для незрячих і пошуку (alt-текст) - alt_text в attach_media або alt_texts в update_post (ти бачиш мініатюри - опиши, що на фото, 1-2 речення; іде і в LinkedIn); співавтори (collab, до 3 ніків) - instagram_collaborators у create_draft / update_post.",
  "Статистика постів (перегляди, лайки, відповіді, репости, підписники, що працює) - analytics.",
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
      touchUsed(ctx.token, ctx.userId);
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
