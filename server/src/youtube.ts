// YouTube - Google OAuth (той самий GOOGLE_CLIENT_ID/SECRET, що й логін і Drive) + Data API v3.
// Вертикальне чи квадратне відео до 3 хв YouTube сам робить Shorts (позначка #Shorts не потрібна).
// Для проду: у Google Cloud (проєкт клієнта входу) має бути ввімкнений «YouTube Data API v3» і доданий
// redirect /api/integrations/youtube/callback. Поки Google не перевірив застосунок, при вході видно
// «застосунок не перевірено», а поки проєкт не пройшов аудит YouTube, усі відео, залиті через API, YouTube
// робить приватними - ми це помічаємо і кажемо людині прямо.
//
// Заливка - resumable (частинами по 16 МБ з диска, обрив відновлюється з того місця, де YouTube зупинився):
// відео автора буває на сотні МБ, а multipart тримав би все в памʼяті й починав би з нуля при обриві.
import { open } from "node:fs/promises";

const OAUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";

export const YT_TITLE_MAX = 100, YT_DESC_MAX = 5000, YT_SHORTS_MAX_SEC = 180;
export type YtPrivacy = "public" | "unlisted" | "private";
export const YT_PRIVACY: YtPrivacy[] = ["public", "unlisted", "private"];
export const YT_PRIVACY_UA: Record<string, string> = { public: "Усі", unlisted: "За посиланням", private: "Лише я" };

export class YouTubeError extends Error {
  constructor(public reason: string, message: string, public status = 0) { super(message); this.name = "YouTubeError"; }
}

// Що сказати людині. reason - з error.errors[0].reason відповіді Google.
export function ytHuman(status: number, reason = "", message = ""): string {
  const r = String(reason || ""), m = String(message || "");
  if (r === "quotaExceeded" || /exceeded your quota/i.test(m))
    return "YouTube: денний ліміт завантажень Holos вичерпано (на весь сервіс) - спробуй завтра, ліміт оновлюється опівночі за тихоокеанським часом";
  if (r === "uploadLimitExceeded") return "YouTube: канал досяг свого ліміту завантажень на добу - спробуй завтра";
  if (r === "youtubeSignupRequired") return "У цього акаунта Google ще нема каналу YouTube - створи канал на youtube.com і підключи YouTube ще раз";
  if (r === "accessNotConfigured" || /YouTube Data API v3 has not been used|is disabled/i.test(m))
    return "У проєкті Google не ввімкнено YouTube Data API v3 - це налаштування адміністратора Holos";
  if (r === "invalidTitle") return "YouTube не прийняв назву відео - зміни назву (до 100 символів, без < і >)";
  if (r === "invalidDescription") return "YouTube не прийняв опис відео - зміни текст (до 5000 символів, без < і >)";
  if (r === "invalidTags") return "YouTube не прийняв теги відео";
  if (r === "invalid_grant" || status === 401 || r === "authError")
    return "Доступ до YouTube протух або його відкликали - підключи YouTube ще раз (Налаштування → Канали)";
  if (r === "forbidden" || r === "insufficientPermissions" || status === 403)
    return "YouTube не дав Holos дозволу на завантаження - підключи YouTube ще раз і погодь усі дозволи";
  if (status === 429 || r === "rateLimitExceeded") return "YouTube просить зачекати - спробуй за кілька хвилин";
  if (status >= 500) return "YouTube тимчасово недоступний - спробуй пізніше";
  return `YouTube: ${m.slice(0, 200) || r || `HTTP ${status}`}`;
}

async function ytParse(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* не JSON */ }
  if (!res.ok) {
    // помилки API: {error:{code,message,errors:[{reason}]}}; OAuth: {error:"invalid_grant", error_description}
    const e = typeof j.error === "object" ? j.error : null;
    const reason = e ? String(e.errors?.[0]?.reason || e.status || "") : String(j.error || "");
    const msg = e ? String(e.message || "") : String(j.error_description || "");
    throw new YouTubeError(reason, ytHuman(res.status, reason, msg), res.status);
  }
  return j;
}
async function ytFetchRes(url: string, init?: RequestInit, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  catch (e: any) {
    if (e && e.name === "AbortError") throw new YouTubeError("timeout", "YouTube не відповів вчасно - спробуй пізніше");
    throw new YouTubeError("network", "немає звʼязку з YouTube - спробуй пізніше");
  } finally { clearTimeout(timer); }
}
async function ytFetch<T = any>(url: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
  return ytParse(await ytFetchRes(url, init, timeoutMs)) as Promise<T>;
}

export function authUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(OAUTH);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly");
  u.searchParams.set("access_type", "offline");   // refresh_token → підключення живе довго
  u.searchParams.set("prompt", "consent");        // інакше Google не поверне refresh_token вдруге
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(clientId: string, secret: string, redirectUri: string, code: string) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: secret });
  return ytFetch<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

export async function refreshAccessToken(clientId: string, secret: string, refreshToken: string) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: secret });
  return ytFetch<{ access_token: string; expires_in: number }>(TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

// Канал, що стоїть за токеном (при вході Google сам дає обрати канал, якщо їх кілька).
export async function myChannel(accessToken: string): Promise<{ id: string; title: string; handle: string; subscribers: number | null }> {
  const j = await ytFetch<{ items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }> }>(
    `${API}/channels?part=snippet,statistics&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const it = j.items?.[0];
  if (!it) throw new YouTubeError("youtubeSignupRequired", ytHuman(403, "youtubeSignupRequired"), 403);
  const subs = it.statistics?.hiddenSubscriberCount ? null : Number(it.statistics?.subscriberCount);
  return { id: String(it.id || ""), title: it.snippet?.title || "YouTube", handle: String(it.snippet?.customUrl || ""), subscribers: Number.isFinite(subs as number) ? subs : null };
}
export async function myChannelTitle(accessToken: string): Promise<string> {
  return (await myChannel(accessToken)).title;
}

// Назва: YouTube не приймає < і > і обрізає на 100 символах; перенос рядка в назві - теж ні.
export function cleanTitle(s: string): string {
  let t = String(s || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (t.length > YT_TITLE_MAX) t = t.slice(0, YT_TITLE_MAX - 1).replace(/\s+\S*$/, "") + "…";
  return t;
}
// Опис: < і > YouTube теж відкидає - міняємо на схожі ‹ ›, щоб не губити сенс; межа 5000.
export function cleanDescription(s: string): string {
  let t = String(s || "").replace(/</g, "‹").replace(/>/g, "›").trim();
  if (t.length > YT_DESC_MAX) t = t.slice(0, YT_DESC_MAX - 1).replace(/\s+\S*$/, "") + "…";
  return t;
}
// Назва з тексту поста: перший змістовний рядок без хештегів і посилань.
export function titleFrom(text: string): string {
  for (const line of String(text || "").split("\n")) {
    const t = cleanTitle(line.replace(/https?:\/\/\S+/g, "").replace(/(^|\s)#[^\s#]+/g, " "));
    if (t.replace(/[^\p{L}\p{N}]/gu, "").length >= 2) return t;
  }
  return "";
}

// Посилання: вертикальне/квадратне до 3 хв - це Shorts, решта - звичайне відео.
export function ytLink(videoId: string | null | undefined, dims?: { width?: number | null; height?: number | null; duration?: number | null }): string {
  const id = String(videoId || "").trim();
  if (!/^[\w-]{6,20}$/.test(id)) return "";
  const w = Number(dims?.width) || 0, h = Number(dims?.height) || 0, d = Number(dims?.duration) || 0;
  const shorts = w > 0 && h >= w && d > 0 && d <= YT_SHORTS_MAX_SEC;
  return shorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
}

// Відповідь «308 Resume Incomplete» каже, скільки байтів YouTube уже має: «Range: bytes=0-524287».
export function rangeNext(range: string | null | undefined): number {
  const m = String(range || "").match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

export type YtUpload = {
  title: string; description: string;
  privacy: YtPrivacy;
  madeForKids: boolean;     // COPPA: людина відповідає явно; «для дітей» вимикає коментарі й персональну рекламу
  synthetic: boolean;       // реалістичний змінений чи синтетичний вміст (AI-голос, згенеровані кадри)
  categoryId?: string;
};
export function uploadMeta(u: YtUpload, withSynthetic = true): Record<string, any> {
  return {
    snippet: { title: cleanTitle(u.title) || "Відео", description: cleanDescription(u.description), categoryId: u.categoryId || "22" },
    status: {
      privacyStatus: YT_PRIVACY.includes(u.privacy) ? u.privacy : "public",
      selfDeclaredMadeForKids: !!u.madeForKids,
      embeddable: true,
      ...(withSynthetic ? { containsSyntheticMedia: !!u.synthetic } : {}),
    },
  };
}

const CHUNK = 16 * 1024 * 1024; // кратне 256 КіБ - так вимагає YouTube для всіх шматків, крім останнього

export type YtResult = { videoId: string; privacy: string; uploadStatus: string; syntheticDropped?: boolean };
// Resumable upload: відкриваємо сесію (метадані), далі PUT шматками з Content-Range. Обрив чи 5xx -
// питаємо YouTube, скільки він уже має (Content-Range: bytes */розмір), і продовжуємо звідти.
export async function uploadResumable(accessToken: string, filePath: string, size: number, mime: string, u: YtUpload, chunk = CHUNK): Promise<YtResult> {
  if (!(size > 0)) throw new YouTubeError("empty", "файл відео порожній");
  let syntheticDropped = false;
  const start = async (withSynthetic: boolean) => ytFetchRes(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": mime,
    },
    body: JSON.stringify(uploadMeta(u, withSynthetic)),
  });
  let res = await start(true);
  if (res.status === 400) {
    // позначку «синтетичний вміст» YouTube додав пізніше; якщо цей API її ще не знає - без неї, а не без відео
    const t = await res.clone().text().catch(() => "");
    if (/containsSyntheticMedia/i.test(t)) { syntheticDropped = true; res = await start(false); }
  }
  if (!res.ok) await ytParse(res);
  const session = res.headers.get("location");
  if (!session) throw new YouTubeError("no_session", "YouTube не відкрив сесію завантаження - спробуй ще раз");

  const done = async (r: Response): Promise<YtResult> => {
    const j = await ytParse(r);
    if (!j.id) throw new YouTubeError("no_id", "YouTube не повернув id відео");
    return { videoId: String(j.id), privacy: String(j.status?.privacyStatus || ""), uploadStatus: String(j.status?.uploadStatus || ""), ...(syntheticDropped ? { syntheticDropped } : {}) };
  };
  const put = (headers: Record<string, string>, body: BodyInit) =>
    ytFetchRes(session, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, ...headers }, body, redirect: "manual" }, 300000);

  const fh = await open(filePath, "r");
  try {
    let offset = 0, failures = 0, stalls = 0;
    for (;;) {
      const end = Math.min(offset + chunk, size) - 1;
      const len = end - offset + 1;
      let r: Response | null = null;
      try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        if (bytesRead !== len) throw new YouTubeError("file_changed", "файл відео змінився під час заливки - спробуй ще раз");
        r = await put({ "Content-Type": mime, "Content-Range": `bytes ${offset}-${end}/${size}` }, new Uint8Array(buf));
      } catch (e: any) { if (e instanceof YouTubeError && e.reason === "file_changed") throw e; r = null; }
      if (r && (r.status === 200 || r.status === 201)) return done(r);
      if (r && r.status === 308) {
        const next = rangeNext(r.headers.get("range"));
        // YouTube відповідає «ще не все», але байтів не додається - не крутимось вічно
        stalls = next > offset ? 0 : stalls + 1;
        if (stalls >= 3) throw new YouTubeError("upload_stalled", "YouTube не приймає відео далі - спробуй ще раз пізніше");
        offset = next; failures = 0; continue;
      }
      if (r && r.status === 404) throw new YouTubeError("session_gone", "сесія завантаження на YouTube протухла - спробуй ще раз");
      if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) await ytParse(r);
      // мережа, 5xx, 408, 429: питаємо, що вже дійшло, і продовжуємо з того місця
      if (++failures > 5) throw new YouTubeError("upload_failed", "заливка на YouTube раз у раз обривається - спробуй пізніше");
      await new Promise((ok) => setTimeout(ok, 2000 * failures));
      try {
        const st = await put({ "Content-Range": `bytes */${size}` }, "");
        if (st.status === 200 || st.status === 201) return done(st);
        if (st.status === 308) offset = rangeNext(st.headers.get("range"));
        else if (st.status === 404) throw new YouTubeError("session_gone", "сесія завантаження на YouTube протухла - спробуй ще раз");
      } catch (e: any) { if (e instanceof YouTubeError && e.reason === "session_gone") throw e; /* спробуємо ще */ }
    }
  } finally { await fh.close(); }
}

// Видимість відео, як вона є (після аудиту/вручну її могли змінити) - для перевірки «залив приватним».
export async function videoPrivacy(accessToken: string, videoId: string): Promise<string> {
  const j = await ytFetch<{ items?: Array<{ status?: { privacyStatus?: string } }> }>(
    `${API}/videos?part=status&id=${encodeURIComponent(videoId)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return String(j.items?.[0]?.status?.privacyStatus || "");
}

// Перегляди, лайки, коментарі - до 50 відео одним запитом (1 одиниця квоти).
export async function videoStats(accessToken: string, ids: string[]): Promise<Record<string, { views: number | null; likes: number | null; comments: number | null }>> {
  const out: Record<string, { views: number | null; likes: number | null; comments: number | null }> = {};
  const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50).filter((x) => /^[\w-]{6,20}$/.test(x));
    if (!part.length) continue;
    const j = await ytFetch<{ items?: Array<{ id: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> }>(
      `${API}/videos?part=statistics&id=${part.join(",")}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    for (const it of j.items || []) out[it.id] = { views: num(it.statistics?.viewCount), likes: num(it.statistics?.likeCount), comments: num(it.statistics?.commentCount) };
  }
  return out;
}
