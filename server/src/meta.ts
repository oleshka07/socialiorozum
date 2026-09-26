// Meta Graph API (Facebook Login) — постинг у FB-Сторінку + FB/IG аналітика.
// Окремий від Threads: хост graph.facebook.com, окремий App ID/Secret (META_APP_*).
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
  if (!res.ok || j.error) throw new Error(humanMetaError(res.status, j.error));
  return j as T;
}

// Найчастіші відмови Graph API - людською; решта лишається текстом самої Meta (він зазвичай конкретний).
export function humanMetaError(status: number, err?: { message?: string; code?: number; error_subcode?: number }): string {
  const m = String(err?.message || "");
  const code = Number(err?.code || 0);
  if (code === 190 || /Error validating access token|session has been invalidated|has expired/i.test(m))
    return "Доступ до Facebook/Instagram втрачено (Meta більше не приймає токен) - перепідключи у Налаштування → Канали.";
  if ([4, 17, 32, 613].includes(code) || /request limit|too many calls/i.test(m))
    return "Meta просить зачекати (забагато запитів) - спробуй за кілька хвилин.";
  if (code === 10 || code === 200 || /permission/i.test(m))
    return `Meta не дає на це дозволу (${m.slice(0, 120) || "код " + code}) - можливо, під час підключення не всі галочки було увімкнено: перепідключи у Налаштування → Канали.`;
  return m || `Meta HTTP ${status}`;
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

// Дозволи, які людина реально надала застосунку (а не ті, що ми просили): після кожного підключення.
export async function grantedPermissions(userToken: string): Promise<string[]> {
  const j = await fbFetch<{ data: { permission: string; status: string }[] }>(`${GRAPH}/me/permissions?access_token=${encodeURIComponent(userToken)}`);
  return (j.data || []).filter((p) => p.status === "granted").map((p) => p.permission);
}

// 💬 Коментар під ВЛАСНИМ щойно опублікованим обʼєктом: пост чи відео Сторінки (токен Сторінки,
// дозвіл pages_manage_engagement) або медіа Instagram (той самий токен, instagram_manage_comments).
// Одразу після публікації мережа інколи ще «не бачить» обʼєкт - тоді кілька секунд чекаємо й повторюємо.
export async function commentOn(objectId: string, token: string, message: string): Promise<{ id: string }> {
  const body = new URLSearchParams({ message, access_token: token });
  let last: any = null;
  for (let att = 0; att < 3; att++) {
    try {
      return await fbFetch<{ id: string }>(`${GRAPH}/${objectId}/comments`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
      });
    } catch (e: any) {
      last = e;
      if (!/not available|does not exist|try again|temporar/i.test(String(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (att + 1)));
    }
  }
  throw last || new Error("Meta не прийняла коментар");
}

// публікація тексту у FB-Сторінку
export async function publishToPage(pageId: string, pageToken: string, message: string) {
  const body = new URLSearchParams({ message, access_token: pageToken });
  return fbFetch<{ id: string }>(`${GRAPH}/${pageId}/feed`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

// інсайти опублікованого FB-поста
// Інсайти одного поста/медіа за списком метрик. Значення приходить або в values[0], або в
// total_value; метрика-обʼєкт (реакції за типами) сумується. Метрику, якої немає у відповіді, НЕ
// підставляємо нулем: «мережа не віддала» і «справді нуль» у статистиці - різні речі.
async function insightsOf(objectId: string, token: string, metrics: string[], extra: Record<string, string> = {}, edge = "insights"): Promise<Record<string, number>> {
  const u = new URL(`${GRAPH}/${objectId}/${edge}`);
  u.searchParams.set("metric", metrics.join(","));
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", token);
  const j = await fbFetch<{ data: Array<{ name: string; values?: Array<{ value: any }>; total_value?: { value: any } }> }>(u.toString());
  const out: Record<string, number> = {};
  for (const m of j.data || []) {
    const v = m.total_value?.value ?? m.values?.[0]?.value;
    if (typeof v === "number") out[m.name] = v;
    else if (v && typeof v === "object") out[m.name] = Object.values(v).reduce((a: number, x: any) => a + (Number(x) || 0), 0);
  }
  return out;
}

// Facebook-допис (<сторінка>_<пост>). З листопада 2025 Meta прибрала post_impressions*, заміна -
// post_media_view (перегляди) і post_total_media_view_unique (охоплення); старі імена лишаються
// запасними в collectors (metrics.ts), бо підтримка розходиться між версіями API.
export const fbPostMetrics = (postId: string, token: string, metrics: string[]) => insightsOf(postId, token, metrics, { period: "lifetime" });
// Facebook-відео (голий id без сторінки): окремий edge video_insights
export const fbVideoMetrics = (videoId: string, token: string, metrics: string[]) => insightsOf(videoId, token, metrics, {}, "video_insights");
// Instagram-медіа: views/reach/likes/comments/saved/shares (impressions і plays Meta вимкнула в v22)
export const igMediaMetrics = (mediaId: string, token: string, metrics: string[]) => insightsOf(mediaId, token, metrics);

// Для ручної перевірки одного поста (роут facebook-insights): спершу нові метрики, потім старі.
export async function postInsights(postId: string, pageToken: string): Promise<Record<string, number>> {
  try { return await fbPostMetrics(postId, pageToken, ["post_media_view", "post_total_media_view_unique"]); }
  catch { return fbPostMetrics(postId, pageToken, ["post_impressions", "post_impressions_unique"]); }
}

// Лайки й коментарі Instagram-медіа ПОЛЯМИ: їм вистачає instagram_basic, тож вони є навіть тоді,
// коли інсайтів (instagram_manage_insights) ще не дали. Заодно тип медіа - від нього залежить,
// які метрики інсайтів мережа прийме.
export async function igMediaFields(mediaId: string, token: string): Promise<{ like_count?: number; comments_count?: number; media_type?: string; media_product_type?: string }> {
  const u = new URL(`${GRAPH}/${mediaId}`);
  u.searchParams.set("fields", "like_count,comments_count,media_type,media_product_type");
  u.searchParams.set("access_token", token);
  return fbFetch(u.toString());
}

// Реакції, коментарі й поширення Facebook-допису ПОЛЯМИ (pages_read_engagement), без інсайтів.
// Поле shares Meta не віддає зовсім, коли поширень нуль - тоді це справжній 0, а не «невідомо».
export async function fbPostEngagement(objectId: string, token: string, isVideo = false): Promise<{ reactions: number | null; comments: number | null; shares: number | null }> {
  const sets = isVideo
    ? ["reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)", "reactions.summary(total_count).limit(0)"]
    : ["reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares", "reactions.summary(total_count).limit(0),shares"];
  let last: any;
  for (const fields of sets) {
    const u = new URL(`${GRAPH}/${objectId}`);
    u.searchParams.set("fields", fields);
    u.searchParams.set("access_token", token);
    try {
      const j: any = await fbFetch(u.toString());
      const num = (x: any) => (typeof x === "number" ? x : null);
      return {
        reactions: num(j.reactions?.summary?.total_count),
        comments: fields.includes("comments") ? num(j.comments?.summary?.total_count) : null,
        shares: isVideo ? null : (typeof j.shares?.count === "number" ? j.shares.count : 0),
      };
    } catch (e) { last = e; }
  }
  throw last;
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

// Публічне посилання на ОПУБЛІКОВАНИЙ пост (щоб юзер міг глянути, як воно виглядає в мережі).
// IG віддає permalink лише полем; FB-пост має permalink_url, але для нього достатньо й id
// (<pageId>_<postId> у facebook.com/<id>), тож туди зайвого запиту не робимо.
export async function mediaPermalink(mediaId: string, token: string): Promise<string> {
  const u = new URL(`${GRAPH}/${mediaId}`);
  u.searchParams.set("fields", "permalink");
  u.searchParams.set("access_token", token);
  const j = await fbFetch<{ permalink?: string }>(u.toString());
  return j.permalink || "";
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
// IG приймає MP4/MOV (H.264 або HEVC, AAC), 3 с - 15 хв; найкраще 9:16. share_to_feed - щоб рілс
// показувався і в стрічці профілю, а не лише у вкладці Reels.
export async function publishReelToInstagram(igUserId: string, pageToken: string, videoUrl: string, caption: string, opts?: { shareToFeed?: boolean }) {
  const cbody = new URLSearchParams({ media_type: "REELS", video_url: videoUrl, caption, share_to_feed: opts?.shareToFeed === false ? "false" : "true", access_token: pageToken });
  const c = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: cbody,
  });
  // відео обробляється асинхронно: публікувати можна лише після status_code=FINISHED (до ~5 хв)
  await igWaitFinished(c.id, pageToken, { tries: 60, everyMs: 5000, what: "відео" });
  return igPublishContainer(igUserId, pageToken, c.id);
}

// 📱 Сторіс Instagram: контейнер STORIES з image_url або video_url - без підпису (у сторіс його нема,
// текст має бути на самому кадрі), далі той самий шлях: чекаємо FINISHED → media_publish.
// Одна сторіс = один кадр; відео в сторіс Instagram - до 60 с.
export async function publishStoryToInstagram(igUserId: string, pageToken: string, media: { imageUrl?: string; videoUrl?: string }) {
  const body = new URLSearchParams({ media_type: "STORIES", access_token: pageToken });
  if (media.videoUrl) body.set("video_url", media.videoUrl); else body.set("image_url", String(media.imageUrl || ""));
  const c = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  await igWaitFinished(c.id, pageToken, media.videoUrl ? { tries: 60, everyMs: 5000, what: "відео" } : undefined);
  return igPublishContainer(igUserId, pageToken, c.id);
}

// 📱 Сторіс Facebook-Сторінки, фото: спершу фото НЕопублікованим (published=false, у стрічці не
// зʼявиться), потім /photo_stories з його id.
export async function publishPhotoStoryToPage(pageId: string, pageToken: string, imageUrl: string): Promise<{ postId: string }> {
  const form = { "Content-Type": "application/x-www-form-urlencoded" };
  const ph = await fbFetch<{ id: string }>(`${GRAPH}/${pageId}/photos`, {
    method: "POST", headers: form, body: new URLSearchParams({ url: imageUrl, published: "false", access_token: pageToken }),
  });
  const r = await fbFetch<{ success?: boolean; post_id?: string }>(`${GRAPH}/${pageId}/photo_stories`, {
    method: "POST", headers: form, body: new URLSearchParams({ photo_id: ph.id, access_token: pageToken }),
  });
  return { postId: String(r.post_id || "") };
}

// 📱 Сторіс Facebook-Сторінки, відео: /video_stories start → upload_url на rupload.facebook.com →
// туди заголовок file_url (Meta тягне файл сама) → чекаємо завершення завантаження → finish.
// ⚠️ Шлях саме через upload_url: запит на graph.facebook.com із тим самим file_url Meta мовчки
// ігнорує, і публікація падає з «Problem with file» (помилка 6000).
export const FB_UPLOAD_HOST = "rupload.facebook.com";
export async function publishVideoStoryToPage(pageId: string, pageToken: string, videoUrl: string): Promise<{ postId: string }> {
  const form = { "Content-Type": "application/x-www-form-urlencoded" };
  const st = await fbFetch<{ video_id: string; upload_url: string }>(`${GRAPH}/${pageId}/video_stories`, {
    method: "POST", headers: form, body: new URLSearchParams({ upload_phase: "start", access_token: pageToken }),
  });
  // токен Сторінки віддаємо ЛИШЕ хосту завантаження Meta: адресу приносить відповідь API, і без цієї
  // перевірки підмінена адреса забрала б токен собі
  let up: URL;
  try { up = new URL(st.upload_url); } catch { throw new Error("Facebook не дав адреси завантаження відео сторіс"); }
  if (up.protocol !== "https:" || up.hostname !== FB_UPLOAD_HOST) throw new Error("Facebook дав неочікувану адресу завантаження - публікацію сторіс зупинено");
  const tr = await fetch(st.upload_url, { method: "POST", headers: { Authorization: `OAuth ${pageToken}`, file_url: videoUrl } });
  const tj: any = await tr.json().catch(() => ({}));
  if (!tr.ok || tj.success === false || tj.error) throw new Error(`Facebook не прийняв відео сторіс: ${tj?.error?.message || tj?.debug_info?.message || "HTTP " + tr.status}`);
  for (let i = 0; i < 60; i++) {
    let s: any = {};
    try { s = await fbFetch(`${GRAPH}/${st.video_id}?fields=status&access_token=${encodeURIComponent(pageToken)}`); }
    catch { /* статус ще не віддається */ }
    const err = s?.status?.uploading_phase?.error?.message || s?.status?.processing_phase?.error?.message;
    if (err) throw new Error(`Facebook не зміг обробити відео сторіс: ${err}`);
    if (s?.status?.uploading_phase?.status === "complete") break;
    if (i === 59) throw new Error("Facebook довго завантажує відео сторіс - спробуй ще раз за кілька хвилин");
    await new Promise((r) => setTimeout(r, 5000));
  }
  const fin = await fbFetch<{ success?: boolean; post_id?: string }>(`${GRAPH}/${pageId}/video_stories`, {
    method: "POST", headers: form, body: new URLSearchParams({ upload_phase: "finish", video_id: st.video_id, access_token: pageToken }),
  });
  return { postId: String(fin.post_id || "") };
}

// відео-пост у FB-Сторінку (file_url — Meta сама тягне з нашого /media)
export async function publishVideoToPage(pageId: string, pageToken: string, description: string, videoUrl: string) {
  const body = new URLSearchParams({ file_url: videoUrl, description, access_token: pageToken });
  return fbFetch<{ id: string }>(`${GRAPH}/${pageId}/videos`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

// Instagram: двокроковий публіш (контейнер із image_url+caption -> media_publish).
// НАДІЙНІСТЬ: навіть фото-контейнер обробляється асинхронно (IG ще тягне картинку з нашого /media) -
// media_publish одразу після create періодично падав «Media ID is not available». Тому: чекаємо
// status_code=FINISHED (фото зазвичай 1-3с) і ретраїмо публіш, якщо IG ще «не бачить» медіа.
async function igWaitFinished(containerId: string, pageToken: string, o?: { tries?: number; everyMs?: number; what?: string }): Promise<void> {
  const what = o?.what || "зображення";
  for (let i = 0; i < (o?.tries ?? 20); i++) {
    let st: { status_code?: string; status?: string } = {};
    try { st = await fbFetch<{ status_code?: string; status?: string }>(`${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(pageToken)}`); }
    catch { /* статус інколи недоступний одразу - просто чекаємо далі */ }
    if (st.status_code === "FINISHED") return;
    // у status IG пише причину («Error: … codec …») - без неї людина не знає, що переробити
    if (st.status_code === "ERROR") throw new Error(`Instagram не зміг обробити ${what}` + (st.status ? `: ${String(st.status).slice(0, 200)}` : what === "відео" ? " (потрібно MP4/MOV, H.264, 3 с - 15 хв)" : " (формат/недоступний URL фото)"));
    await new Promise((r) => setTimeout(r, o?.everyMs ?? 2000));
  }
  throw new Error(`Instagram довго обробляє ${what} - спробуй ще раз за кілька хвилин`);
}
async function igPublishContainer(igUserId: string, pageToken: string, creationId: string): Promise<{ mediaId: string }> {
  const pbody = new URLSearchParams({ creation_id: creationId, access_token: pageToken });
  let lastErr: any = null;
  for (let att = 0; att < 4; att++) {
    try {
      const p = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media_publish`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: pbody,
      });
      return { mediaId: p.id };
    } catch (e: any) {
      lastErr = e;
      // «Media ID is not available» = контейнер ще доїжджає - почекати і повторити, не валити публікацію
      if (!/media id is not available|not available/i.test(String(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 4000 * (att + 1)));
    }
  }
  throw lastErr || new Error("Instagram: не вдалося опублікувати");
}
export async function publishToInstagram(igUserId: string, pageToken: string, imageUrl: string, caption: string) {
  const cbody = new URLSearchParams({ image_url: imageUrl, caption, access_token: pageToken });
  const c = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: cbody,
  });
  await igWaitFinished(c.id, pageToken);
  return igPublishContainer(igUserId, pageToken, c.id);
}

// 🖼 Instagram-карусель (2-10 кадрів): контейнер на кожен кадр (is_carousel_item, без підпису) →
// контейнер CAROUSEL з children і підписом → media_publish. Кожен контейнер обробляється асинхронно,
// тож чекаємо FINISHED і в кадрів, і в самої каруселі - інакше IG відповідає «Media ID is not available».
// Усі кадри IG обрізає під пропорцію ПЕРШОГО, тому ми ріжемо їх однаково ще до публікації.
export async function publishCarouselToInstagram(igUserId: string, pageToken: string, imageUrls: string[], caption: string) {
  const urls = imageUrls.slice(0, 10);
  if (urls.length < 2) throw new Error("Для каруселі Instagram потрібно щонайменше 2 фото");
  const children: string[] = [];
  for (const url of urls) {
    const body = new URLSearchParams({ image_url: url, is_carousel_item: "true", access_token: pageToken });
    const c = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    children.push(c.id);
  }
  for (const id of children) await igWaitFinished(id, pageToken);
  const cbody = new URLSearchParams({ media_type: "CAROUSEL", children: children.join(","), caption, access_token: pageToken });
  const car = await fbFetch<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: cbody,
  });
  await igWaitFinished(car.id, pageToken);
  return igPublishContainer(igUserId, pageToken, car.id);
}

// 🖼 Кілька фото в одному пості Сторінки: кожне фото вантажимо НЕопублікованим (published=false) і
// збираємо їхні id в attached_media допису стрічки - так Facebook показує одну публікацію-галерею,
// а не N окремих фото-постів.
export async function publishMultiPhotoToPage(pageId: string, pageToken: string, message: string, imageUrls: string[]) {
  const ids: string[] = [];
  for (const url of imageUrls.slice(0, 10)) {
    const body = new URLSearchParams({ url, published: "false", access_token: pageToken });
    const r = await fbFetch<{ id: string }>(`${GRAPH}/${pageId}/photos`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    ids.push(r.id);
  }
  const body = new URLSearchParams({ message, access_token: pageToken });
  ids.forEach((id, i) => body.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  return fbFetch<{ id: string }>(`${GRAPH}/${pageId}/feed`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}
