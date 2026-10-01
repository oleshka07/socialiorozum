// TikTok Content Posting API (developers.tiktok.com): OAuth v2, «хто публікує» (creator_info), пряма
// публікація (Direct Post, scope video.publish) і чернетка в застосунку TikTok (Upload, scope video.upload),
// заливка файлу частинами з диска і стан обробки.
//
// Правила TikTok для прямої публікації (без них застосунок не пройде аудит, а до аудиту - не працює):
// - перед кожним постом питаємо creator_info: нік автора, які варіанти «Хто бачить» йому доступні, чи
//   ввімкнені коментарі/Duet/Stitch, найдовше відео;
// - «Хто бачить» обирає людина, типового значення нема; коментарі, Duet і Stitch типово вимкнені;
// - позначка реклами («мій бренд» / «брендований контент»), і брендований контент не буває «Лише я»;
// - до аудиту застосунку TikTok пускає пряму публікацію лише в приватний акаунт - тоді відео йде в
//   чернетки (inbox): людина відкриває TikTok і натискає «Опублікувати» сама. Підпис у чернетку TikTok не
//   переносить (inbox приймає лише файл) - його треба вставити там.
//
// Функції без мережі (chunkPlan, checkPost, postInfoBody, postIdsFromRaw, тексти помилок) - чисті й під
// юнітами: саме тут найлегше зробити тиху помилку, а перевірити на живому TikTok дорого.
import { open } from "node:fs/promises";

const AUTH = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";

// Дозволи застосунку: вхід, чернетки і пряма публікація. Просити дозвіл, якого нема в застосунку на
// developers.tiktok.com, не можна - TikTok тоді валить увесь вхід. Тож список можна звузити з адмінки
// (TIKTOK_SCOPES), не чекаючи деплою.
export const TT_SCOPES = "user.info.basic,video.upload,video.publish";
export const TT_TITLE_MAX = 2200;   // підпис до відео, у символах UTF-16 (рівно String.length)

export const PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] as const;
export const PRIVACY_UA: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Усі",
  MUTUAL_FOLLOW_FRIENDS: "Друзі (взаємні підписки)",
  FOLLOWER_OF_CREATOR: "Підписники",
  SELF_ONLY: "Лише я",
};

export class TikTokError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); this.name = "TikTokError"; }
}

// Що сказати людині на код помилки API (error.code у відповіді TikTok). Невідоме - як сказав TikTok.
export function ttHuman(code: string, message = ""): string {
  const m = String(message || "").trim().slice(0, 200);
  switch (code) {
    case "access_token_invalid": return "Доступ до TikTok протух або його відкликали - підключи TikTok ще раз (Налаштування → Канали)";
    case "scope_not_authorized":
    case "scope_permission_missed": return "TikTok не дав Holos потрібного дозволу - підключи TikTok ще раз і погодь усі дозволи";
    case "rate_limit_exceeded": return "TikTok просить зачекати: забагато запитів - спробуй за хвилину";
    case "reached_active_user_cap": return "Застосунок Holos вичерпав денний ліміт людей у TikTok (до аудиту TikTok - кілька на добу) - спробуй завтра";
    case "unaudited_client_can_only_post_to_private_accounts": return "TikTok ще не перевірив застосунок Holos: до аудиту пряма публікація можлива лише в приватний акаунт";
    case "privacy_level_option_mismatch": return "Обраний варіант «Хто бачить» недоступний для цього акаунта TikTok - обери інший у пості";
    case "url_ownership_unverified": return "TikTok не підтвердив домен Holos для завантаження за посиланням";
    case "spam_risk_too_many_posts":
    case "spam_risk_user_banned_from_posting":
    case "spam_risk_text":
    case "spam_risk": return failReasonText(code);
    case "invalid_param": return `TikTok відхилив параметри поста${m ? `: ${m}` : ""}`;
    case "internal_error": return "TikTok тимчасово недоступний - спробуй пізніше";
    default: return `TikTok: ${m || code || "невідома помилка"}`;
  }
}

// Чому TikTok не опублікував уже завантажене відео (fail_reason у стані публікації).
export function failReasonText(reason: string): string {
  switch (String(reason || "")) {
    case "file_format_check_failed": return "TikTok не прийняв формат файлу - потрібне відео MP4, MOV чи WebM (H.264)";
    case "duration_check_failed": return "TikTok не прийняв тривалість відео для цього акаунта";
    case "frame_rate_check_failed": return "TikTok не прийняв частоту кадрів - потрібно від 23 до 60 кадрів на секунду";
    case "picture_size_check_failed": return "TikTok не прийняв розмір кадру - потрібно від 360 до 4096 px по кожній стороні";
    case "internal": return "збій на боці TikTok - спробуй опублікувати ще раз";
    case "video_pull_failed": return "TikTok не зміг забрати відео - спробуй ще раз";
    case "publish_cancelled": return "публікацію скасовано в TikTok";
    case "auth_removed": return "доступ Holos до TikTok відкликали посеред публікації - підключи TikTok ще раз";
    case "spam_risk_too_many_posts": return "TikTok: для цього акаунта вичерпано денний ліміт постів через сторонні застосунки - спробуй завтра";
    case "spam_risk_user_banned_from_posting": return "TikTok заборонив цьому акаунту публікувати";
    case "spam_risk_text": return "TikTok вважає текст підпису спамом - зміни підпис";
    case "spam_risk": return "TikTok вважає пост ризикованим (спам) - зміни текст чи відео";
    default: return `TikTok не опублікував відео${reason ? ` (${reason})` : ""}`;
  }
}

// id поста в TikTok - 19 цифр, більше за Number.MAX_SAFE_INTEGER: якщо TikTok віддає їх числами,
// JSON.parse тихо округлить, і посилання вестиме на чужий пост. Тому id беремо з сирого тексту.
export function postIdsFromRaw(text: string): string[] {
  const m = String(text || "").match(/"publicaly_available_post_id"\s*:\s*\[([^\]]*)\]/);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter((s) => /^\d+$/.test(s));
}

export function ttLink(username: string | null | undefined, videoId: string | null | undefined): string {
  const u = String(username || "").replace(/^@/, "").trim(), id = String(videoId || "").trim();
  if (!u || !/^\d+$/.test(id)) return "";
  return `https://www.tiktok.com/@${u}/video/${id}`;
}

export function mimeOf(filename: string): string {
  const ext = String(filename || "").toLowerCase().split(".").pop() || "";
  if (ext === "mov" || ext === "qt") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  return "video/mp4";
}

// Як різати файл (Media Transfer Guide TikTok): до 64 МБ - одним шматком; більше - шматками по 10 МБ,
// їх кількість = floor(розмір / шматок), а залишок їде разом з останнім (той буває до 128 МБ).
const WHOLE_MAX = 64_000_000, CHUNK = 10_000_000;
export type ChunkPlan = { chunkSize: number; total: number; ranges: Array<[number, number]> };
export function chunkPlan(size: number): ChunkPlan {
  if (!(size > 0)) throw new Error("порожній файл відео");
  if (size <= WHOLE_MAX) return { chunkSize: size, total: 1, ranges: [[0, size - 1]] };
  const total = Math.floor(size / CHUNK);
  if (total > 1000) throw new Error("відео завелике для TikTok");
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < total; i++) ranges.push([i * CHUNK, i === total - 1 ? size - 1 : (i + 1) * CHUNK - 1]);
  return { chunkSize: CHUNK, total, ranges };
}

async function ttFetchRaw(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<{ json: any; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try { res = await fetch(url, { ...init, signal: controller.signal }); }
  catch (e: any) {
    if (e && e.name === "AbortError") throw new TikTokError("timeout", "TikTok не відповів вчасно - спробуй пізніше");
    throw new TikTokError("network", "немає звʼязку з TikTok - спробуй пізніше");
  } finally { clearTimeout(timer); }
  const text = await res.text().catch(() => "");
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* не JSON - нижче скажемо статусом */ }
  // помилки бувають двох форм: Content Posting - {error:{code,message}}, OAuth - {error, error_description}
  const e = json && typeof json.error === "object" ? json.error : null;
  const code = e ? String(e.code || "") : typeof json?.error === "string" ? json.error : "";
  if (!res.ok || (code && code !== "ok")) {
    const msg = e ? String(e.message || "") : String(json?.error_description || "");
    if (code && code !== "ok") throw new TikTokError(code, ttHuman(code, msg), res.status);
    throw new TikTokError(res.status >= 500 ? "internal_error" : `http_${res.status}`,
      res.status >= 500 ? ttHuman("internal_error") : `TikTok відповів помилкою (HTTP ${res.status})`, res.status);
  }
  return { json, text };
}
async function ttFetch<T = any>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  return (await ttFetchRaw(url, init, timeoutMs)).json as T;
}
const jsonPost = (token: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
  body: JSON.stringify(body),
});

export function authUrl(clientKey: string, redirectUri: string, state: string, scopes = TT_SCOPES): string {
  const u = new URL(AUTH);
  u.searchParams.set("client_key", clientKey);
  u.searchParams.set("scope", scopes);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export type TtToken = { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in?: number; open_id: string; scope?: string };
// токен приходить або верхнім рівнем, або в data (залежно від версії відповіді)
const tokenOf = (j: any): TtToken => ({ ...(j?.data || {}), ...j });

export async function exchangeCode(clientKey: string, secret: string, redirectUri: string, code: string): Promise<TtToken> {
  const body = new URLSearchParams({ client_key: clientKey, client_secret: secret, code, grant_type: "authorization_code", redirect_uri: redirectUri });
  return tokenOf(await ttFetch(`${API}/oauth/token/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }));
}

export async function refreshToken(clientKey: string, secret: string, refresh: string): Promise<TtToken> {
  const body = new URLSearchParams({ client_key: clientKey, client_secret: secret, grant_type: "refresh_token", refresh_token: refresh });
  return tokenOf(await ttFetch(`${API}/oauth/token/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }));
}

export async function userInfo(accessToken: string): Promise<{ displayName: string; avatarUrl: string }> {
  const j = await ttFetch<{ data?: { user?: { display_name?: string; avatar_url?: string } } }>(`${API}/user/info/?fields=open_id,display_name,avatar_url`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  return { displayName: j.data?.user?.display_name || "TikTok", avatarUrl: j.data?.user?.avatar_url || "" };
}

export type CreatorInfo = {
  nickname: string; username: string; avatarUrl: string;
  privacyOptions: string[];
  commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean;
  maxDurationSec: number;
};
export function creatorFromJson(j: any): CreatorInfo {
  const d = j?.data || {};
  return {
    nickname: String(d.creator_nickname || ""), username: String(d.creator_username || ""), avatarUrl: String(d.creator_avatar_url || ""),
    privacyOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options.map(String) : [],
    commentDisabled: d.comment_disabled === true, duetDisabled: d.duet_disabled === true, stitchDisabled: d.stitch_disabled === true,
    maxDurationSec: Number(d.max_video_post_duration_sec) || 0,
  };
}
// Хто публікує і що йому можна (потрібен video.publish). Кличемо перед КОЖНИМ постом - так вимагає TikTok.
export async function creatorInfo(accessToken: string): Promise<CreatorInfo> {
  return creatorFromJson(await ttFetch(`${API}/post/publish/creator_info/query/`, jsonPost(accessToken, {})));
}

// Налаштування поста в TikTok, які обрала людина (channels.tiktok).
export type TtPost = {
  title: string;
  privacy: string;            // обовʼязково, з creator_info.privacyOptions
  allowComment: boolean; allowDuet: boolean; allowStitch: boolean;
  yourBrand: boolean;         // реклама власного бізнесу → «Promotional content»
  brandedContent: boolean;    // оплачена співпраця з іншим брендом → «Paid partnership»
  aigc: boolean;              // відео створено AI (AI-голос, згенеровані кадри)
  coverMs?: number;           // кадр обкладинки, мс від початку
};

// Чи можна так публікувати (людський текст відмови або null). Тривалість - у секундах, коли відома.
export function checkPost(p: TtPost, info: CreatorInfo, durationSec = 0): string | null {
  if (!p.privacy) return "TikTok: обери, хто бачитиме відео («Хто бачить») - TikTok не дозволяє обирати це за людину";
  if (info.privacyOptions.length && !info.privacyOptions.includes(p.privacy))
    return `TikTok: варіант «${PRIVACY_UA[p.privacy] || p.privacy}» недоступний для @${info.username || info.nickname || "акаунта"} - обери інший («${info.privacyOptions.map((o) => PRIVACY_UA[o] || o).join("», «")}»)`;
  if (p.brandedContent && p.privacy === "SELF_ONLY")
    return "TikTok: брендований контент (оплачена співпраця) не може бути видно «Лише мені» - обери інший варіант «Хто бачить»";
  if (info.maxDurationSec && durationSec > info.maxDurationSec + 0.5)
    return `TikTok цього акаунта приймає відео до ${fmtDur(info.maxDurationSec)}, а тут ${fmtDur(durationSec)} - вріж відео або зніми TikTok із поста`;
  return null;
}
const fmtDur = (s: number) => s >= 60 ? `${Math.floor(s / 60)} хв${Math.round(s % 60) ? ` ${Math.round(s % 60)} с` : ""}` : `${Math.round(s)} с`;

export function cutTitle(t: string): string {
  const s = String(t || "").trim();
  if (s.length <= TT_TITLE_MAX) return s;
  return s.slice(0, TT_TITLE_MAX - 1).replace(/\s+\S*$/, "") + "…";
}

// post_info для прямої публікації. Те, що автор вимкнув у налаштуваннях TikTok, лишається вимкненим.
export function postInfoBody(p: TtPost, info?: CreatorInfo): Record<string, any> {
  const body: Record<string, any> = {
    title: cutTitle(p.title),
    privacy_level: p.privacy,
    disable_comment: !p.allowComment || !!info?.commentDisabled,
    disable_duet: !p.allowDuet || !!info?.duetDisabled,
    disable_stitch: !p.allowStitch || !!info?.stitchDisabled,
    brand_content_toggle: !!p.brandedContent,
    brand_organic_toggle: !!p.yourBrand,
    is_aigc: !!p.aigc,
  };
  if (Number.isFinite(p.coverMs) && (p.coverMs as number) >= 0) body.video_cover_timestamp_ms = Math.round(p.coverMs as number);
  return body;
}

const sourceInfo = (size: number) => {
  const plan = chunkPlan(size);
  return { plan, body: { source: "FILE_UPLOAD", video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.total } };
};

export type TtInit = { publishId: string; uploadUrl: string; plan: ChunkPlan };
// Пряма публікація: пост виходить сам із налаштуваннями людини.
export async function initDirect(accessToken: string, p: TtPost, info: CreatorInfo, size: number): Promise<TtInit> {
  const src = sourceInfo(size);
  const j = await ttFetch<{ data?: { publish_id?: string; upload_url?: string } }>(`${API}/post/publish/video/init/`,
    jsonPost(accessToken, { post_info: postInfoBody(p, info), source_info: src.body }));
  if (!j.data?.publish_id || !j.data?.upload_url) throw new TikTokError("no_upload_url", "TikTok не повернув адресу для завантаження відео - спробуй ще раз");
  return { publishId: j.data.publish_id, uploadUrl: j.data.upload_url, plan: src.plan };
}
// Чернетка: відео приходить людині в застосунок TikTok, далі вона публікує сама (підпис inbox не приймає).
export async function initInbox(accessToken: string, size: number): Promise<TtInit> {
  const src = sourceInfo(size);
  const j = await ttFetch<{ data?: { publish_id?: string; upload_url?: string } }>(`${API}/post/publish/inbox/video/init/`,
    jsonPost(accessToken, { source_info: src.body }));
  if (!j.data?.publish_id || !j.data?.upload_url) throw new TikTokError("no_upload_url", "TikTok не повернув адресу для завантаження відео - спробуй ще раз");
  return { publishId: j.data.publish_id, uploadUrl: j.data.upload_url, plan: src.plan };
}

// Заливка шматками з диска, по черзі (TikTok вимагає послідовно). Шматок - до 3 спроб.
export async function uploadFile(init: TtInit, filePath: string, mime: string, size: number): Promise<void> {
  const fh = await open(filePath, "r");
  try {
    for (const [start, end] of init.plan.ranges) {
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      if (bytesRead !== len) throw new Error("файл відео змінився під час заливки - спробуй ще раз");
      let last = "";
      for (let att = 0; att < 3; att++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);
        try {
          const res = await fetch(init.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": mime, "Content-Range": `bytes ${start}-${end}/${size}` },
            body: new Uint8Array(buf), signal: controller.signal,
          });
          if (res.ok) { last = ""; break; }
          last = `HTTP ${res.status}`;
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break; // не тимчасове
        } catch (e: any) { last = e?.name === "AbortError" ? "таймаут" : "мережа"; }
        finally { clearTimeout(timer); }
        await new Promise((r) => setTimeout(r, 2000 * (att + 1)));
      }
      if (last) throw new TikTokError("upload_failed", `TikTok не прийняв частину відео (${last}) - спробуй ще раз`);
    }
  } finally { await fh.close(); }
}

export type TtStatus = { status: string; failReason: string; postIds: string[]; uploadedBytes: number };
export async function fetchStatus(accessToken: string, publishId: string): Promise<TtStatus> {
  const { json, text } = await ttFetchRaw(`${API}/post/publish/status/fetch/`, jsonPost(accessToken, { publish_id: publishId }));
  const d = json?.data || {};
  return { status: String(d.status || ""), failReason: String(d.fail_reason || ""), postIds: postIdsFromRaw(text), uploadedBytes: Number(d.uploaded_bytes) || 0 };
}
