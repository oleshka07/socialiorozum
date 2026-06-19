// Threads API (Meta) — окремий OAuth (threads.net) + хост graph.threads.net.
// Окремий App ID/Secret (НЕ Facebook). Двокроковий publish: контейнер → публікація.
const GRAPH = "https://graph.threads.net";
const AUTHZ = "https://threads.net";

async function thFetch<T = any>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("Threads timeout 20s");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.message ? String(j.error.message) : `Threads HTTP ${res.status}`);
  return j as T;
}

// URL авторизації (користувач логіниться через Threads)
export function authUrl(appId: string, redirectUri: string, state: string, scopes: string[]): string {
  const u = new URL(`${AUTHZ}/oauth/authorize`);
  u.searchParams.set("client_id", appId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopes.join(","));
  u.searchParams.set("state", state);
  return u.toString();
}

// code → короткоживучий токен (+ user_id)
export async function exchangeCode(appId: string, secret: string, redirectUri: string, code: string) {
  const body = new URLSearchParams({
    client_id: appId, client_secret: secret, grant_type: "authorization_code",
    redirect_uri: redirectUri, code,
  });
  return thFetch<{ access_token: string; user_id: string }>(`${GRAPH}/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

// короткоживучий → довгоживучий (60 днів)
export async function exchangeLongLived(secret: string, shortToken: string) {
  const u = new URL(`${GRAPH}/access_token`);
  u.searchParams.set("grant_type", "th_exchange_token");
  u.searchParams.set("client_secret", secret);
  u.searchParams.set("access_token", shortToken);
  return thFetch<{ access_token: string; token_type: string; expires_in: number }>(u.toString());
}

// продовжити довгоживучий токен
export async function refreshToken(longToken: string) {
  const u = new URL(`${GRAPH}/refresh_access_token`);
  u.searchParams.set("grant_type", "th_refresh_token");
  u.searchParams.set("access_token", longToken);
  return thFetch<{ access_token: string; token_type: string; expires_in: number }>(u.toString());
}

export async function getMe(token: string) {
  const u = new URL(`${GRAPH}/v1.0/me`);
  u.searchParams.set("fields", "id,username");
  u.searchParams.set("access_token", token);
  return thFetch<{ id: string; username?: string }>(u.toString());
}

// двокроковий публіш: текст (+ опційне зображення за URL)
export async function publish(token: string, userId: string, text: string, imageUrl?: string) {
  const create = new URL(`${GRAPH}/v1.0/${userId}/threads`);
  create.searchParams.set("access_token", token);
  if (imageUrl) {
    create.searchParams.set("media_type", "IMAGE");
    create.searchParams.set("image_url", imageUrl);
    if (text) create.searchParams.set("text", text);
  } else {
    create.searchParams.set("media_type", "TEXT");
    create.searchParams.set("text", text);
  }
  const c = await thFetch<{ id: string }>(create.toString(), { method: "POST" });
  const pub = new URL(`${GRAPH}/v1.0/${userId}/threads_publish`);
  pub.searchParams.set("creation_id", c.id);
  pub.searchParams.set("access_token", token);
  const p = await thFetch<{ id: string }>(pub.toString(), { method: "POST" });
  return { mediaId: p.id };
}

// інсайти по опублікованому посту
export async function mediaInsights(token: string, mediaId: string): Promise<Record<string, number>> {
  const u = new URL(`${GRAPH}/v1.0/${mediaId}/insights`);
  u.searchParams.set("metric", "views,likes,replies,reposts,quotes");
  u.searchParams.set("access_token", token);
  const j = await thFetch<{ data: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> }>(u.toString());
  const out: Record<string, number> = {};
  for (const m of j.data || []) out[m.name] = m.total_value?.value ?? m.values?.[0]?.value ?? 0;
  return out;
}
