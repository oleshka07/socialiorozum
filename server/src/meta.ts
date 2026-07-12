// Meta Graph API (Facebook Login) — постинг у FB-Сторінку + FB/IG аналітика.
// Окремий від Threads: хост graph.facebook.com, окремий App ID/Secret (META_APP_*).
// IG публікація НЕ реалізована (IG вимагає зображення; пости socialio — текстові).
const GV = "v23.0"; // версія Graph API (за потреби синхронізувати з Holos)
const GRAPH = `https://graph.facebook.com/${GV}`;
const DIALOG = `https://www.facebook.com/${GV}/dialog/oauth`;

async function fbFetch<T = any>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("Meta timeout 20s");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.message ? String(j.error.message) : `Meta HTTP ${res.status}`);
  return j as T;
}

export function authUrl(appId: string, redirectUri: string, state: string, scopes: string[]): string {
  const u = new URL(DIALOG);
  u.searchParams.set("client_id", appId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopes.join(","));
  u.searchParams.set("state", state);
  return u.toString();
}

// code → короткоживучий user-токен
export async function exchangeCode(appId: string, secret: string, redirectUri: string, code: string) {
  const u = new URL(`${GRAPH}/oauth/access_token`);
  u.searchParams.set("client_id", appId);
  u.searchParams.set("client_secret", secret);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code", code);
  return fbFetch<{ access_token: string; expires_in?: number }>(u.toString());
}

// короткоживучий → довгоживучий user-токен (~60 днів)
export async function exchangeLongLived(appId: string, secret: string, shortToken: string) {
  const u = new URL(`${GRAPH}/oauth/access_token`);
  u.searchParams.set("grant_type", "fb_exchange_token");
  u.searchParams.set("client_id", appId);
  u.searchParams.set("client_secret", secret);
  u.searchParams.set("fb_exchange_token", shortToken);
  return fbFetch<{ access_token: string; expires_in?: number }>(u.toString());
}

// сторінки користувача + прив'язані IG Business акаунти; page-токени довгоживучі
export type FbPage = { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } };
export async function getPages(userToken: string): Promise<FbPage[]> {
  const u = new URL(`${GRAPH}/me/accounts`);
  u.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
  u.searchParams.set("access_token", userToken);
  const j = await fbFetch<{ data: FbPage[] }>(u.toString());
  return j.data || [];
}

// публікація тексту у FB-Сторінку
export async function publishToPage(pageId: string, pageToken: string, message: string) {
  const body = new URLSearchParams({ message, access_token: pageToken });
  return fbFetch<{ id: string }>(`${GRAPH}/${pageId}/feed`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

// інсайти опублікованого FB-поста
export async function postInsights(postId: string, pageToken: string): Promise<Record<string, number>> {
  const u = new URL(`${GRAPH}/${postId}/insights`);
  u.searchParams.set("metric", "post_impressions,post_impressions_unique,post_clicks");
  u.searchParams.set("access_token", pageToken);
  const j = await fbFetch<{ data: Array<{ name: string; values?: Array<{ value: number }> }> }>(u.toString());
  const out: Record<string, number> = {};
  for (const m of j.data || []) out[m.name] = m.values?.[0]?.value ?? 0;
  return out;
}

// базова аналітика акаунтів (надійні поля): FB-Сторінка + IG-акаунт
export async function pageStats(pageId: string, pageToken: string) {
  const u = new URL(`${GRAPH}/${pageId}`);
  u.searchParams.set("fields", "name,followers_count,fan_count");
  u.searchParams.set("access_token", pageToken);
  return fbFetch<{ name?: string; followers_count?: number; fan_count?: number }>(u.toString());
}
export async function igStats(igUserId: string, pageToken: string) {
  const u = new URL(`${GRAPH}/${igUserId}`);
  u.searchParams.set("fields", "username,followers_count,media_count");
  u.searchParams.set("access_token", pageToken);
  return fbFetch<{ username?: string; followers_count?: number; media_count?: number }>(u.toString());
}
// IG account insights (потребує instagram_manage_insights) — охоплення за 28 днів
export async function igInsights(igUserId: string, pageToken: string): Promise<Record<string, number>> {
  const u = new URL(`${GRAPH}/${igUserId}/insights`);
  u.searchParams.set("metric", "reach");
  u.searchParams.set("period", "days_28");
  u.searchParams.set("metric_type", "total_value");
  u.searchParams.set("access_token", pageToken);
  const j = await fbFetch<{ data: Array<{ name: string; total_value?: { value: number }; values?: Array<{ value: number }> }> }>(u.toString());
  const out: Record<string, number> = {};
  for (const m of j.data || []) out[m.name] = m.total_value?.value ?? m.values?.[0]?.value ?? 0;
  return out;
}

// фото-пост у FB-Сторінку (url зображення + підпис)
export async function publishPhotoToPage(pageId: string, pageToken: string, message: string, imageUrl: string) {
  const body = new URLSearchParams({ url: imageUrl, caption: message, access_token: pageToken });
  return fbFetch<{ id: string; post_id?: string }>(`${GRAPH}/${pageId}/photos`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

// останні N постів IG-акаунта (підписи) — для виведення голосу бренду з реальних дописів
export async function getRecentMedia(igUserId: string, pageToken: string, limit = 20): Promise<Array<{ caption: string; like_count?: number; comments_count?: number; timestamp?: string }>> {
  const u = new URL(`${GRAPH}/${igUserId}/media`);
  u.searchParams.set("fields", "caption,media_type,permalink,timestamp,like_count,comments_count");
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("access_token", pageToken);
  const j = await fbFetch<{ data: Array<any> }>(u.toString());
  return (j.data || []).map((m) => ({ caption: m.caption || "", like_count: m.like_count, comments_count: m.comments_count, timestamp: m.timestamp }));
}

// Business Discovery: читання постів ЧУЖОЇ публічної бізнес/креатор-сторінки IG через власний
// підключений акаунт (офіційний API - без кук і скрейпінгу). Особисті акаунти API не віддає.
export async function businessDiscovery(igUserId: string, pageToken: string, targetUsername: string, limit = 12):
  Promise<{ username: string; name?: string; media: Array<{ id: string; caption: string; permalink?: string; timestamp?: string }> }> {
  const u = new URL(`${GRAPH}/${igUserId}`);
  u.searchParams.set("fields", `business_discovery.username(${targetUsername}){username,name,media.limit(${limit}){id,caption,permalink,timestamp}}`);
  u.searchParams.set("access_token", pageToken);
  const j = await fbFetch<any>(u.toString());
  const bd = j.business_discovery;
  if (!bd) throw new Error("акаунт не знайдено або він не бізнес/креатор");
  return {
    username: bd.username, name: bd.name,
    media: ((bd.media && bd.media.data) || []).map((m: any) => ({ id: String(m.id), caption: m.caption || "", permalink: m.permalink, timestamp: m.timestamp })),
  };
}

// Instagram Reels: контейнер media_type=REELS з video_url → чекаємо обробки відео → media_publish.
// IG вимагає MP4 H.264+AAC, 9:16 — саме такий наш рілс із збірки.
export async function publishReelToInstagram(igUserId: string, pageToken: string, videoUrl: string, caption: string) {
  const cbody = new URLSearchParams({ media_type: "REELS", video_url: videoUrl, caption, access_token: pageToken });
  const c = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: cbody,
  });
  // відео обробляється асинхронно: публікувати можна лише після status_code=FINISHED
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await fbFetch<{ status_code?: string }>(`${GRAPH}/${c.id}?fields=status_code&access_token=${encodeURIComponent(pageToken)}`);
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR") throw new Error("Instagram не зміг обробити відео (перевір формат MP4 9:16)");
    if (i === 39) throw new Error("Instagram довго обробляє відео - спробуй ще раз за кілька хвилин");
  }
  const pbody = new URLSearchParams({ creation_id: c.id, access_token: pageToken });
  const p = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media_publish`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: pbody,
  });
  return { mediaId: p.id };
}

// відео-пост у FB-Сторінку (file_url — Meta сама тягне з нашого /media)
export async function publishVideoToPage(pageId: string, pageToken: string, description: string, videoUrl: string) {
  const body = new URLSearchParams({ file_url: videoUrl, description, access_token: pageToken });
  return fbFetch<{ id: string }>(`${GRAPH}/${pageId}/videos`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

// Instagram: двокроковий публіш (контейнер із image_url+caption -> media_publish)
export async function publishToInstagram(igUserId: string, pageToken: string, imageUrl: string, caption: string) {
  const cbody = new URLSearchParams({ image_url: imageUrl, caption, access_token: pageToken });
  const c = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: cbody,
  });
  const pbody = new URLSearchParams({ creation_id: c.id, access_token: pageToken });
  const p = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media_publish`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: pbody,
  });
  return { mediaId: p.id };
}
