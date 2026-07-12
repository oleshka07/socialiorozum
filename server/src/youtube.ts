// YouTube Shorts — Google OAuth (той самий GOOGLE_CLIENT_ID/SECRET, що й логін/Drive) + Data API v3 upload.
// Вертикальне відео <3хв само стає Shorts; #Shorts у назві підсилює. ВАЖЛИВО для проду:
// у Google Cloud Console має бути ввімкнений «YouTube Data API v3» і доданий redirect
// /api/integrations/youtube/callback; scope youtube.upload на верифікованому застосунку.
const OAUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";

async function ytFetch<T = any>(url: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try { res = await fetch(url, { ...init, signal: controller.signal }); }
  catch (e: any) { if (e && e.name === "AbortError") throw new Error("YouTube timeout"); throw e; }
  finally { clearTimeout(timer); }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message ? `YouTube: ${String(j.error.message).slice(0, 200)}` : `YouTube HTTP ${res.status}`);
  return j as T;
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
  return ytFetch<{ access_token: string; refresh_token?: string; expires_in: number }>(TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

export async function refreshAccessToken(clientId: string, secret: string, refreshToken: string) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: secret });
  return ytFetch<{ access_token: string; expires_in: number }>(TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

// назва каналу — щоб у Налаштуваннях показати, ЩО саме підключено
export async function myChannelTitle(accessToken: string): Promise<string> {
  const j = await ytFetch<{ items?: Array<{ snippet?: { title?: string } }> }>(
    `${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return j.items?.[0]?.snippet?.title || "YouTube";
}

// multipart upload (наші рілси ~5-20МБ — резюмоване завантаження не потрібне)
export async function uploadVideo(accessToken: string, video: Buffer, title: string, description: string): Promise<{ videoId: string }> {
  const meta = {
    snippet: { title: title.slice(0, 95) + " #Shorts", description: description.slice(0, 4500), categoryId: "22" },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
  };
  const boundary = "socialio" + Date.now().toString(36);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const j = await ytFetch<{ id: string }>(`${UPLOAD}?part=snippet,status&uploadType=multipart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(Buffer.concat([head, video, tail])),
  }, 180000);
  if (!j.id) throw new Error("YouTube не повернув id відео");
  return { videoId: j.id };
}
