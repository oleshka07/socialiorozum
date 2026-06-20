// Фоновий поллер папок Google Drive: тягне нові зображення -> медіа-бібліотека.
import { q, one } from "./db.js";
import { logEvent } from "./log.js";
import { env } from "./env.js";
import * as gdrive from "./gdrive.js";
import { saveMedia } from "./media.js";

const POLL_MS = 15 * 60 * 1000;
const MAX_PER_TICK = 20;

type Folder = { id: string; workspace_id: string; folder_id: string; name: string | null };

// дійсний access-токен (рефреш, якщо протух); повертає null, якщо немає підключення
async function validToken(ws: string): Promise<string | null> {
  const c = await one<{ access_token: string | null; refresh_token: string | null; token_expires_at: string | null }>(
    `select access_token, refresh_token, token_expires_at from gdrive_config where workspace_id=$1`, [ws]);
  if (!c) return null;
  const exp = c.token_expires_at ? new Date(c.token_expires_at).getTime() : 0;
  if (c.refresh_token && (!c.access_token || (exp && exp - Date.now() < 5 * 60 * 1000))) {
    try {
      const t = await gdrive.refresh(env.google.clientId, env.google.clientSecret, c.refresh_token);
      const newExp = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
      await q(`update gdrive_config set access_token=$2, token_expires_at=$3, updated_at=now() where workspace_id=$1`, [ws, t.access_token, newExp]);
      return t.access_token;
    } catch { return c.access_token; }
  }
  return c.access_token;
}

async function pullFolder(folder: Folder): Promise<number> {
  const token = await validToken(folder.workspace_id);
  if (!token) throw new Error("Google Drive не підключений");
  let files: gdrive.DriveFile[];
  try { files = await gdrive.listImages(token, folder.folder_id); }
  catch (e: any) { await q(`update gdrive_folder set last_error=$2, last_pulled_at=now() where id=$1`, [folder.id, String(e.message).slice(0, 300)]); throw e; }
  let created = 0;
  for (const f of files) {
    if (created >= MAX_PER_TICK) break;
    const dup = await one(`select id from media_asset where workspace_id=$1 and external_id=$2`, [folder.workspace_id, f.id]);
    if (dup) continue;
    try {
      const buf = await gdrive.downloadFile(token, f.id);
      await saveMedia(folder.workspace_id, { buffer: buf, mime: f.mimeType, name: f.name, source: "gdrive", externalId: f.id });
      created++;
    } catch (e: any) { await logEvent("warn", "gdrive", `файл ${f.name}: ${e.message}`); }
  }
  await q(`update gdrive_folder set last_error=null, last_pulled_at=now() where id=$1`, [folder.id]);
  if (created) await logEvent("info", "gdrive", `${folder.name || folder.folder_id}: +${created} фото`);
  return created;
}

async function tick(): Promise<void> {
  const folders = await q<Folder>(`select id, workspace_id, folder_id, name from gdrive_folder where active=true limit 50`);
  for (const f of folders) {
    try { await pullFolder(f); }
    catch (e: any) { await logEvent("warn", "gdrive", `${f.folder_id}: ${e.message}`); }
  }
}

// on-demand: підтягнути одну папку зараз
export async function pullGdriveFolder(folderId: string, ws: string): Promise<number> {
  const f = await one<Folder>(`select id, workspace_id, folder_id, name from gdrive_folder where id=$1 and workspace_id=$2`, [folderId, ws]);
  if (!f) throw new Error("папку не знайдено");
  return pullFolder(f);
}

let running = false;
export function startGdrivePoller(): void {
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); }
    catch (e: any) { await logEvent("error", "gdrive", "tick: " + e.message); }
    finally { running = false; }
  }, POLL_MS);
  console.log("[gdrive] поллер запущено (кожні 15 хв)");
}
