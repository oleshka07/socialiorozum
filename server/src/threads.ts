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

// НАДІЙНІСТЬ: контейнер (особливо з фото - Threads тягне його з нашого /media) обробляється
// асинхронно; threads_publish одразу падав «The requested resource does not exist».
// Док Meta: чекати до ~30с. Полимо статус контейнера до FINISHED, потім публікуємо з ретраями.
async function thWaitFinished(token: string, containerId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    let st: { status?: string; error_message?: string } = {};
    try {
      const su = new URL(`${GRAPH}/v1.0/${containerId}`);
      su.searchParams.set("fields", "status,error_message");
      su.searchParams.set("access_token", token);
      st = await thFetch(su.toString());
    } catch { /* статус ще не віддається - чекаємо далі */ }
    if (st.status === "FINISHED") return;
    if (st.status === "ERROR") throw new Error("Threads не зміг обробити медіа" + (st.error_message ? `: ${st.error_message}` : ""));
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Threads довго обробляє медіа - спробуй ще раз за хвилину");
}
async function thPublishContainer(token: string, userId: string, creationId: string): Promise<{ mediaId: string }> {
  const pub = new URL(`${GRAPH}/v1.0/${userId}/threads_publish`);
  pub.searchParams.set("creation_id", creationId);
  pub.searchParams.set("access_token", token);
  let lastErr: any = null;
  for (let att = 0; att < 4; att++) {
    try {
      const p = await thFetch<{ id: string }>(pub.toString(), { method: "POST" });
      return { mediaId: p.id };
    } catch (e: any) {
      lastErr = e;
      if (!/does not exist|not exist|try again/i.test(String(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 4000 * (att + 1))); // контейнер/root ще доїжджає
    }
  }
  throw lastErr || new Error("Threads: не вдалося опублікувати");
}

// двокроковий публіш: текст (+ опційне зображення за URL).
// replyToId - відповідь у гілку (на ВЛАСНИЙ пост це працює з базовим threads_content_publish;
// для відповідей на чужі пости потрібен окремий пермішен threads_manage_replies).
export async function publish(token: string, userId: string, text: string, imageUrl?: string, replyToId?: string) {
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
  if (replyToId) create.searchParams.set("reply_to_id", replyToId);
  const c = await thFetch<{ id: string }>(create.toString(), { method: "POST" });
  await thWaitFinished(token, c.id);
  return thPublishContainer(token, userId, c.id);
}

// 🖼 Карусель Threads (2-20 кадрів; ми тримаємо до 10, як і решта мереж): контейнер IMAGE з
// is_carousel_item на кожен кадр → контейнер CAROUSEL з children і текстом → threads_publish.
export async function publishCarousel(token: string, userId: string, text: string, imageUrls: string[], replyToId?: string) {
  const urls = imageUrls.slice(0, 20);
  if (urls.length < 2) throw new Error("Для каруселі Threads потрібно щонайменше 2 фото");
  const children: string[] = [];
  for (const url of urls) {
    const u = new URL(`${GRAPH}/v1.0/${userId}/threads`);
    u.searchParams.set("media_type", "IMAGE");
    u.searchParams.set("image_url", url);
    u.searchParams.set("is_carousel_item", "true");
    u.searchParams.set("access_token", token);
    const c = await thFetch<{ id: string }>(u.toString(), { method: "POST" });
    children.push(c.id);
  }
  for (const id of children) await thWaitFinished(token, id);
  const car = new URL(`${GRAPH}/v1.0/${userId}/threads`);
  car.searchParams.set("media_type", "CAROUSEL");
  car.searchParams.set("children", children.join(","));
  if (text) car.searchParams.set("text", text);
  if (replyToId) car.searchParams.set("reply_to_id", replyToId);
  car.searchParams.set("access_token", token);
  const c = await thFetch<{ id: string }>(car.toString(), { method: "POST" });
  await thWaitFinished(token, c.id);
  return thPublishContainer(token, userId, c.id);
}

// Публічне посилання на опублікований тред. З media_id його НЕ вивести (у permalink інший
// короткий код), тому це єдиний спосіб - спитати Graph API одним полем.
export async function mediaPermalink(token: string, mediaId: string): Promise<string> {
  const u = new URL(`${GRAPH}/v1.0/${mediaId}`);
  u.searchParams.set("fields", "permalink");
  u.searchParams.set("access_token", token);
  const j = await thFetch<{ permalink?: string }>(u.toString());
  return j.permalink || "";
}

// інсайти ПРОФІЛЮ за період (views - часовий ряд, решта - total_value за since..until;
// followers_count - лише поточне значення, без періоду)
export async function userInsights(token: string, userId: string, metrics: string[], sinceUnix?: number, untilUnix?: number): Promise<Record<string, number>> {
  const u = new URL(`${GRAPH}/v1.0/${userId}/threads_insights`);
  u.searchParams.set("metric", metrics.join(","));
  if (sinceUnix) u.searchParams.set("since", String(sinceUnix));
  if (untilUnix) u.searchParams.set("until", String(untilUnix));
  u.searchParams.set("access_token", token);
  const j = await thFetch<{ data: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> }>(u.toString());
  const out: Record<string, number> = {};
  for (const m of j.data || [])
    out[m.name] = m.total_value?.value ?? (m.values || []).reduce((s, v) => s + (Number(v.value) || 0), 0);
  return out;
}

// демографія підписників (потрібен threads_manage_insights і ≥100 підписників; інакше API поверне помилку)
export async function followerDemographics(token: string, userId: string, breakdown: "age" | "gender" | "country" | "city"): Promise<Array<{ key: string; value: number }>> {
  const u = new URL(`${GRAPH}/v1.0/${userId}/threads_insights`);
  u.searchParams.set("metric", "follower_demographics");
  u.searchParams.set("breakdown", breakdown);
  u.searchParams.set("access_token", token);
  const j = await thFetch<any>(u.toString());
  const res = j?.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
  return res.map((r: any) => ({ key: String((r.dimension_values || []).join(", ")), value: Number(r.value) || 0 }))
    .sort((a: any, b: any) => b.value - a.value);
}

// коментарі (відповіді інших людей) під власним постом - потребує threads_manage_replies
export type ThreadReply = { id: string; text: string; username: string; timestamp: string };
export async function mediaReplies(token: string, mediaId: string): Promise<ThreadReply[]> {
  const u = new URL(`${GRAPH}/v1.0/${mediaId}/replies`);
  u.searchParams.set("fields", "id,text,username,timestamp");
  u.searchParams.set("access_token", token);
  const j = await thFetch<{ data: any[] }>(u.toString());
  return (j.data || []).map((r) => ({
    id: String(r.id || ""), text: String(r.text || ""), username: String(r.username || ""), timestamp: String(r.timestamp || ""),
  })).filter((r) => r.id && r.text);
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
