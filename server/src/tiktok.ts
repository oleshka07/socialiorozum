// TikTok Content Posting API — OAuth v2 + завантаження відео в «чернетки» юзера (inbox upload).
// Потрібен застосунок на developers.tiktok.com зі scope user.info.basic + video.upload.
// До проходження аудиту TikTok дозволяє лише inbox-завантаження: відео зʼявляється у юзера
// в TikTok як чернетка, і він публікує її сам у застосунку (прямий пост = після аудиту, scope video.publish).
const AUTH = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";

async function ttFetch<T = any>(url: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try { res = await fetch(url, { ...init, signal: controller.signal }); }
  catch (e: any) { if (e && e.name === "AbortError") throw new Error("TikTok timeout"); throw e; }
  finally { clearTimeout(timer); }
  const j: any = await res.json().catch(() => ({}));
  const err = j.error && j.error.code && j.error.code !== "ok" ? j.error : null;
  if (!res.ok || err) throw new Error(err?.message ? `TikTok: ${String(err.message).slice(0, 200)}` : `TikTok HTTP ${res.status}`);
  return j as T;
}

export function authUrl(clientKey: string, redirectUri: string, state: string): string {
  const u = new URL(AUTH);
  u.searchParams.set("client_key", clientKey);
  u.searchParams.set("scope", "user.info.basic,video.upload");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(clientKey: string, secret: string, redirectUri: string, code: string) {
  const body = new URLSearchParams({ client_key: clientKey, client_secret: secret, code, grant_type: "authorization_code", redirect_uri: redirectUri });
  return ttFetch<{ access_token: string; refresh_token: string; expires_in: number; open_id: string }>(`${API}/oauth/token/`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

export async function refreshToken(clientKey: string, secret: string, refresh: string) {
  const body = new URLSearchParams({ client_key: clientKey, client_secret: secret, grant_type: "refresh_token", refresh_token: refresh });
  return ttFetch<{ access_token: string; refresh_token: string; expires_in: number; open_id: string }>(`${API}/oauth/token/`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

export async function userInfo(accessToken: string): Promise<{ displayName: string }> {
  const j = await ttFetch<{ data?: { user?: { display_name?: string } } }>(`${API}/user/info/?fields=display_name`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  return { displayName: j.data?.user?.display_name || "TikTok" };
}

// inbox upload одним чанком (наші рілси невеликі; TikTok приймає чанк до 64МБ)
export async function uploadToInbox(accessToken: string, video: Buffer): Promise<{ publishId: string }> {
  const init = await ttFetch<{ data?: { publish_id?: string; upload_url?: string } }>(`${API}/post/publish/inbox/video/init/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source_info: { source: "FILE_UPLOAD", video_size: video.length, chunk_size: video.length, total_chunk_count: 1 } }),
  });
  const uploadUrl = init.data?.upload_url, publishId = init.data?.publish_id;
  if (!uploadUrl || !publishId) throw new Error("TikTok не повернув upload_url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${video.length - 1}/${video.length}` },
      body: new Uint8Array(video),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`TikTok upload HTTP ${res.status}`);
  } finally { clearTimeout(timer); }
  return { publishId };
}
