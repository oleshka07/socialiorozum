// Фоновий воркер життєвого циклу акаунтів:
//  (1) остаточне видалення soft-deleted акаунтів після grace-періоду,
//  (2) попередження про неактивність → чистка медіа/прогонів,
//  (3) прибирання «осиротілих» файлів медіа з диска.
import { q } from "./db.js";
import { logEvent } from "./log.js";
import { sweepJobs } from "./jobs.js";
import { sweepUploadLinks } from "./uploadlink.js";
import { env } from "./env.js";
import { MEDIA_DIR, deleteMediaFile } from "./media.js";
import { sendInactivityWarningEmail } from "./email.js";
import { backfillDigests } from "./memory.js";
import { purgeWorkspace, soleOwnedBrands } from "./workspaces.js";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const GRACE_DAYS = 14;   // soft-delete -> остаточне видалення
const WARN_DAYS = 30;    // неактивність -> лист-попередження
const CLEAN_DAYS = 14;   // після листа -> чистка медіа/прогонів
const ORPHAN_MS = 24 * 3600 * 1000; // файл без рядка в БД, старший за добу

// Чистка важких даних за неактивність: медіа (файли+рядки) + джерела (каскад прогонів/постів). Акаунт лишається.
async function purgeWorkspaceContent(ws: string): Promise<void> {
  const media = await q<{ filename: string }>(`select filename from media_asset where workspace_id=$1`, [ws]);
  for (const m of media) await deleteMediaFile(m.filename);
  await q(`delete from media_asset where workspace_id=$1`, [ws]);
  await q(`delete from source where workspace_id=$1`, [ws]);
}

// Старі ig-safe копії БЕЗ external_id (створені до дедупу) - невидимі в бібліотеці й ніколи
// не реюзаються → зачищаємо. Нові ig-safe (з external_id) живуть і реюзаються при публікаціях.
async function sweepLegacyIgSafe(): Promise<void> {
  const rows = await q<{ id: string; filename: string }>(
    `select id, filename from media_asset where source='ig-safe' and external_id is null and created_at < now() - interval '1 hour' limit 500`);
  for (const m of rows) {
    await q(`delete from media_asset where id=$1`, [m.id]);
    await deleteMediaFile(m.filename);
  }
  if (rows.length) await logEvent("info", "lifecycle", `зачищено легасі ig-safe копій: ${rows.length}`);
}

// Файли на диску, яким не відповідає жоден media_asset (залишки невдалих видалень) — старші за добу.
async function sweepOrphanMedia(): Promise<void> {
  let files: string[] = [];
  try { files = await readdir(MEDIA_DIR); } catch { return; }
  if (!files.length) return;
  const rows = await q<{ filename: string }>(`select filename from media_asset`);
  const known = new Set(rows.map((r) => r.filename));
  for (const f of files) {
    if (known.has(f)) continue;
    try { const st = await stat(join(MEDIA_DIR, f)); if (Date.now() - st.mtimeMs > ORPHAN_MS) await deleteMediaFile(f); } catch { /* ignore */ }
  }
}

async function tick(): Promise<void> {
  // 1) остаточне видалення soft-deleted після grace
  const toPurge = await q<{ id: string; workspace_id: string; email: string }>(
    `select id, workspace_id, email from app_user where deleted_at is not null and deleted_at < now() - ($1 || ' days')::interval`,
    [String(GRACE_DAYS)]);
  for (const u of toPurge) {
    try {
      // бренди, де людина ЄДИНИЙ власник, ідуть разом з акаунтом - інакше лишились би сиротами
      // без господаря; домашній останнім (каскадом забирає й сам рядок app_user)
      const brands = await soleOwnedBrands(u.id);
      for (const b of brands) await purgeWorkspace(b);
      await purgeWorkspace(u.workspace_id);
      await logEvent("info", "lifecycle", `акаунт остаточно видалено: ${u.email}` + (brands.length ? ` (+ брендів: ${brands.length})` : ""));
    }
    catch (e: any) { await logEvent("error", "lifecycle", `hard purge ${u.email}: ${e.message}`); }
  }
  // 2) попередження про неактивність (>30 днів, ще не попереджали)
  const toWarn = await q<{ id: string; email: string }>(
    `select id, email from app_user where deleted_at is null and inactivity_warned_at is null
       and last_active_at is not null and last_active_at < now() - ($1 || ' days')::interval`,
    [String(WARN_DAYS)]);
  for (const u of toWarn) {
    try { await sendInactivityWarningEmail(u.email, `${env.appBaseUrl}/login`, CLEAN_DAYS); await q(`update app_user set inactivity_warned_at=now() where id=$1`, [u.id]); await logEvent("info", "lifecycle", `лист про неактивність: ${u.email}`); }
    catch (e: any) { await logEvent("error", "lifecycle", `warn ${u.email}: ${e.message}`); }
  }
  // 3) чистка медіа/прогонів через CLEAN_DAYS після листа (якщо так і не повернувся)
  const toClean = await q<{ workspace_id: string; email: string; id: string }>(
    `select id, workspace_id, email from app_user where deleted_at is null and data_purged_at is null
       and inactivity_warned_at is not null and inactivity_warned_at < now() - ($1 || ' days')::interval
       and last_active_at < now() - ($2 || ' days')::interval`,
    [String(CLEAN_DAYS), String(WARN_DAYS)]);
  for (const u of toClean) {
    try { await purgeWorkspaceContent(u.workspace_id); await q(`update app_user set data_purged_at=now() where id=$1`, [u.id]); await logEvent("info", "lifecycle", `чистка медіа/прогонів за неактивність: ${u.email}`); }
    catch (e: any) { await logEvent("error", "lifecycle", `clean ${u.email}: ${e.message}`); }
  }
  // 4) осиротілі файли медіа
  try { await sweepOrphanMedia(); } catch { /* ignore */ }
  try { await sweepLegacyIgSafe(); } catch { /* ignore */ }
  // журнал подій ріс без обмежень (спіймано аудитом): 30 днів історії достатньо і для розбору
  // інцидентів, і для звіту оператора; info-шум - 7 днів, попередження й помилки - 30
  try {
    await q(`delete from app_log where created_at < now() - interval '30 days'`);
    await q(`delete from app_log where level='info' and created_at < now() - interval '7 days'`);
  } catch { /* ignore */ }
  try { await sweepJobs(); } catch { /* ignore */ }
  try { await sweepUploadLinks(); } catch { /* ignore */ }
  // 5) 🧠 памʼять контенту: наздоганяємо пости, опубліковані ДО появи дистиляції. Порційно (ліміт
  // усередині) - кожен артефакт це виклик моделі, і разовий прохід по всьому архіву коштував би
  // відчутних грошей; за кілька проходів воркера архів наздожене себе сам.
  try { await backfillDigests(); } catch { /* ignore */ }
}

let running = false;
export function startLifecycleWorker(): void {
  const run = async () => { if (running) return; running = true; try { await tick(); } catch (e: any) { await logEvent("error", "lifecycle", "tick: " + e.message); } finally { running = false; } };
  setInterval(run, 6 * 3600 * 1000); // кожні 6 год
  setTimeout(run, 60 * 1000);        // перший прохід через хвилину після старту
  console.log("[lifecycle] воркер запущено (кожні 6 год)");
}
