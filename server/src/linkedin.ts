// LinkedIn API — OAuth (60-денний токен, без програмного рефрешу на базовому доступі) + постинг через /rest/posts.
// Потрібен застосунок у LinkedIn Developer Portal з продуктами «Sign In with LinkedIn using OpenID Connect»
// і «Share on LinkedIn» (scope openid profile w_member_social). Постинг на сторінку компанії — окремий апрув
// Community Management API (додається пізніше тим самим adapter-ом, зміниться лише author URN).
const OAUTH = "https://www.linkedin.com/oauth/v2";
const API = "https://api.linkedin.com";
// 📅 ВЕРСІЯ REST API. LinkedIn версіонує API помісячно (`YYYYMM`) і тримає версію активною ~12 місяців,
// після чого вона вимикається і БУДЬ-ЯКИЙ запит падає з «Requested version … is not active».
// Саме це й сталось: константа "202506" пережила своє вікно, і публікація в LinkedIn померла цілком.
// Хардкодити місяць - значить закласти ту саму поломку рівно через рік, тож версія тепер РАХУЄТЬСЯ
// від поточної дати: беремо позаминулий місяць (він гарантовано вже випущений і глибоко всередині
// 12-місячного вікна). `LINKEDIN_VERSION` у .env перебиває розрахунок, якщо LinkedIn колись зламає
// цю схему і знадобиться прибити конкретне значення руками.
export function linkedinVersion(now: Date = new Date(), monthsBack = 2): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const LI_VERSION = (process.env.LINKEDIN_VERSION || "").trim() || linkedinVersion();

async function liFetch<T = any>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try { res = await fetch(url, { ...init, signal: controller.signal }); }
  catch (e: any) { if (e && e.name === "AbortError") throw new Error("LinkedIn timeout 20s"); throw e; }
  finally { clearTimeout(timer); }
  const text = await res.text();
  let j: any = {}; try { j = text ? JSON.parse(text) : {}; } catch { /* деякі 201 повертають порожнє тіло */ }
  if (!res.ok) throw new Error(j.message ? `LinkedIn: ${String(j.message).slice(0, 200)}` : `LinkedIn HTTP ${res.status}`);
  (j as any).__headers = res.headers;
  return j as T;
}

export function authUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(`${OAUTH}/authorization`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", "openid profile w_member_social");
  return u.toString();
}

export async function exchangeCode(clientId: string, secret: string, redirectUri: string, code: string) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: secret });
  return liFetch<{ access_token: string; expires_in: number }>(`${OAUTH}/accessToken`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
}

// OpenID userinfo: sub = member id → author URN urn:li:person:{sub}
export async function getMe(token: string) {
  return liFetch<{ sub: string; name?: string }>(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
}

// commentary у /rest/posts - «Little Text Format»: службові символи треба екранувати
function escapeCommentary(s: string): string {
  return s.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => "\\" + c);
}

const REST_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "LinkedIn-Version": LI_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
  "Content-Type": "application/json",
});

// двокроковий аплоад зображення: initializeUpload → PUT байтів → URN для поста
export async function uploadImage(token: string, authorUrn: string, imageBuf: Buffer): Promise<string> {
  const init = await liFetch<{ value: { uploadUrl: string; image: string } }>(`${API}/rest/images?action=initializeUpload`, {
    method: "POST", headers: REST_HEADERS(token), body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
  });
  const put = await fetch(init.value.uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array(imageBuf) });
  if (!put.ok) throw new Error(`LinkedIn image upload HTTP ${put.status}`);
  return init.value.image; // urn:li:image:…
}

// публікація поста (текст до 3000 симв, опційно зображення). Кілька зображень = multiImage
// (LinkedIn приймає 2-20), одне - звичайне media.
export async function publish(token: string, authorUrn: string, text: string, images?: Buffer | Buffer[]): Promise<{ postId: string }> {
  const body: any = {
    author: authorUrn,
    commentary: escapeCommentary(text.slice(0, 3000)),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  const bufs = (Array.isArray(images) ? images : images ? [images] : []).slice(0, 20);
  if (bufs.length >= 2) {
    const urns: string[] = [];
    for (const b of bufs) urns.push(await uploadImage(token, authorUrn, b));
    body.content = { multiImage: { images: urns.map((id) => ({ id })) } };
  } else if (bufs.length === 1) {
    const imageUrn = await uploadImage(token, authorUrn, bufs[0]);
    body.content = { media: { id: imageUrn } };
  }
  const j: any = await liFetch(`${API}/rest/posts`, { method: "POST", headers: REST_HEADERS(token), body: JSON.stringify(body) });
  const id = j.__headers?.get?.("x-restli-id") || j.id || "";
  return { postId: String(id) };
}
