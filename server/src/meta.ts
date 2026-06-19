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
