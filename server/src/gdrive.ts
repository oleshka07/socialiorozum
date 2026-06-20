// Google Drive — scope drive.file (non-sensitive, БЕЗ верифікації): доступ лише до папок/файлів,
// які користувач сам обрав через Google Picker. Той самий Google-застосунок, що й логін.
const OAUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const DRIVE = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export function authUrl(clientId: string, redirect: string, state: string): string {
  const u = new URL(OAUTH);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline");   // щоб отримати refresh_token
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(clientId: string, secret: string, redirect: string, code: string) {
  const r = await fetch(TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const j: any = await r.json();
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || "token exchange");
  return j as { access_token: string; refresh_token?: string; expires_in?: number };
}

export async function refresh(clientId: string, secret: string, refreshToken: string) {
  const r = await fetch(TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: secret, grant_type: "refresh_token" }),
  });
  const j: any = await r.json();
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || "refresh");
  return j as { access_token: string; expires_in?: number };
}

export async function getEmail(token: string): Promise<string> {
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } });
  const j: any = await r.json().catch(() => ({}));
  return j.email || "";
}

export type DriveFile = { id: string; name: string; mimeType: string };
export async function listImages(token: string, folderId: string): Promise<DriveFile[]> {
  const u = new URL(`${DRIVE}/files`);
  u.searchParams.set("q", `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`);
  u.searchParams.set("fields", "files(id,name,mimeType)");
  u.searchParams.set("pageSize", "100");
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `Drive list HTTP ${r.status}`);
  return (j.files || []) as DriveFile[];
}

export async function downloadFile(token: string, fileId: string): Promise<Buffer> {
  const r = await fetch(`${DRIVE}/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive download HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// folderId тепер надходить напряму з Google Picker — парсинг URL не потрібен.
