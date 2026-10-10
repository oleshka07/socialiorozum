// 🖼 Медіатека як окрема сторінка: кожен файл кабінету зі станом (вільний / у чернетці / у розкладі /
// вийшов), мережами, куди вже вийшов, своєю назвою і мʼяким архівом.
//
// АРХІВ - лише позначка «не показувати в списку й у виборі фото». Файл на диску, пости, їхні публікації,
// статистика, повтори хітів (♻️ бере ті самі фото) - не змінюються. Тому архівувати безпечно, а
// повернути - один клік. Видалення - інша справа: воно відкріплює фото від постів (кадри каруселі
// зникають каскадом), тож повтор хіта вийде без фото, а картка в Студії й Аналітиці - без картинки.
// Самі мережі тримають свою копію, тож уже опубліковане й цифри статистики видалення не чіпає.
import { q, one } from "./db.js";
import { getSetting, setSetting } from "./settings.js";
import { logEvent } from "./log.js";
import { MEDIA_DIR } from "./media.js";
import { statfs } from "node:fs/promises";
import { mediaUsage, archiveAction, archiveDueAt, normArchiveDays, type PostUse, type Usage } from "./medialib-plan.js";

// технічні копії не показуються: JPEG-версії для Instagram, основи під текст, кадри, зібрані зі
// сценарію, обкладинки рілсів, мовні версії монтажу і кропи під формат поста (рахуються за оригіналом)
export const LIB_HIDDEN = ["ig-safe", "ai-base", "slide", "cover", "montage-lang", "crop"];
const UUID_RX = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export type LibRow = {
  id: string; kind: string; mime: string | null; original_name: string | null; title: string | null; filename: string;
  size: number | null; source: string; created_at: string; duration: number | null; width: number | null; height: number | null;
  alt_text: string | null; archived_at: string | null; archived_by: string | null; archive_keep: boolean;
};
export type LibItem = LibRow & Usage & { archive_due: string | null };

export const archiveDays = async (ws: string): Promise<number> =>
  normArchiveDays(await getSetting<unknown>(ws, "media_archive_days", null));
export async function setArchiveDays(ws: string, v: unknown): Promise<number> {
  const d = normArchiveDays(v === null || v === undefined || v === "" ? 0 : v);
  await setSetting(ws, "media_archive_days", d);
  return d;
}

/** Хто з файлів кабінету в яких постах: (файл, пост). Кроп під формат рахується за оригіналом, кліп -
 *  за змонтованим із нього відео. Плюс кліпи, що пішли в монтаж (навіть якщо ролик ще без поста). */
async function usageMap(ws: string, ids?: string[]): Promise<{ posts: Map<string, PostUse[]>; montage: Set<string> }> {
  const pairs = await q<{ root: string; post_id: string }>(
    `with m as (select id, source, external_id, made_from from media_asset where workspace_id=$1),
          direct as (
            select p.id as post_id, p.media_id as mid from post p join m on m.id = p.media_id
            union select ps.post_id, ps.media_id from post_slide ps join m on m.id = ps.media_id),
          roots as (
            select case when m.source = 'crop' and m.external_id ~* '${UUID_RX}' then m.external_id::uuid else m.id end as root, d.post_id
              from direct d join m on m.id = d.mid
            union select x.clip, d.post_id from direct d join m on m.id = d.mid cross join lateral unnest(m.made_from) as x(clip))
     select distinct root, post_id from roots${ids ? " where root = any($2::uuid[])" : ""}`,
    ids ? [ws, ids] : [ws]);
  const montage = new Set((await q<{ clip: string }>(
    `select distinct unnest(made_from) as clip from media_asset where workspace_id=$1 and made_from is not null`, [ws])).map((r) => r.clip));
  const postIds = [...new Set(pairs.map((p) => p.post_id))];
  const posts = new Map<string, PostUse>();
  if (postIds.length) {
    const rows = await q<{ id: string; review: string | null; sent: string[] | null; last_pub: string | null; next_at: string | null; nets: string[] | null }>(
      `select p.id, p.review,
              (select array_agg(distinct pp.net) from post_published pp where pp.post_id = p.id) as sent,
              (select max(pp.created_at) from post_published pp where pp.post_id = p.id) as last_pub,
              (select min(coalesce(s.scheduled_at, now())) from schedule_slot s where s.post_id = p.id and s.status in ('planned', 'posting')) as next_at,
              (select array_agg(e.key) from jsonb_each(case when jsonb_typeof(p.channels) = 'object' then p.channels else '{}'::jsonb end) e
                 where jsonb_typeof(e.value) = 'object' and e.value->>'on' = 'true') as nets
         from post p where p.id = any($1::uuid[])`, [postIds]);
    for (const r of rows) posts.set(r.id, {
      id: r.id, review: r.review, sent: r.sent || [], nets: r.nets || [],
      lastPub: r.last_pub ? new Date(r.last_pub).toISOString() : null, nextAt: r.next_at ? new Date(r.next_at).toISOString() : null,
    });
  }
  const byMedia = new Map<string, PostUse[]>();
  for (const p of pairs) {
    const pu = posts.get(p.post_id); if (!pu) continue;
    const arr = byMedia.get(p.root) || []; arr.push(pu); byMedia.set(p.root, arr);
  }
  return { posts: byMedia, montage };
}

const ROW_COLS = `id, kind, mime, original_name, title, filename, size, source, created_at, duration, width, height, alt_text, archived_at, archived_by, archive_keep`;

/** Уся медіатека кабінету зі станом кожного файлу - для сторінки «🖼 Медіатека». */
export async function libraryItems(ws: string, opts: { ids?: string[] } = {}): Promise<LibItem[]> {
  const rows = await q<LibRow>(
    `select ${ROW_COLS} from media_asset where workspace_id=$1 and source <> all($2::text[])${opts.ids ? " and id = any($3::uuid[])" : ""}
      order by created_at desc limit 3000`, opts.ids ? [ws, LIB_HIDDEN, opts.ids] : [ws, LIB_HIDDEN]);
  if (!rows.length) return [];
  const [{ posts, montage }, days] = await Promise.all([usageMap(ws, opts.ids), archiveDays(ws)]);
  return rows.map((r) => {
    const u = mediaUsage(posts.get(r.id) || [], montage.has(r.id));
    return { ...r, ...u, archive_due: r.archived_at ? null : archiveDueAt(u, days, r.archive_keep) };
  });
}

/** Скільки місця займають файли кабінету (з технічними копіями й мовними версіями - це справжній диск). */
export async function libraryStats(ws: string): Promise<{ files: number; bytes: number; archived: number; archivedBytes: number }> {
  const r = await one<{ files: number; bytes: string; archived: number; archived_bytes: string }>(
    `select count(*) filter (where source <> all($2::text[]))::int as files,
            coalesce(sum(size), 0)::bigint as bytes,
            count(*) filter (where archived_at is not null and source <> all($2::text[]))::int as archived,
            coalesce(sum(size) filter (where archived_at is not null), 0)::bigint as archived_bytes
       from media_asset where workspace_id=$1`, [ws, LIB_HIDDEN]);
  return { files: r?.files || 0, bytes: Number(r?.bytes || 0), archived: r?.archived || 0, archivedBytes: Number(r?.archived_bytes || 0) };
}

/** Вільне місце на диску сервера (для адміна: чи взагалі треба економити). */
export async function diskSpace(): Promise<{ free: number; total: number } | null> {
  try { const s = await statfs(MEDIA_DIR); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; }
  catch { return null; }
}

/** Відкласти в архів чи повернути руками. Повернене з архіву людиною більше не ховається саме. */
export async function setArchived(ws: string, ids: string[], archive: boolean): Promise<number> {
  if (!ids.length) return 0;
  const rows = archive
    ? await q(`update media_asset set archived_at=now(), archived_by='manual', archive_keep=false
                where workspace_id=$1 and id = any($2::uuid[]) and source <> all($3::text[]) and archived_at is null returning id`, [ws, ids, LIB_HIDDEN])
    : await q(`update media_asset set archived_at=null, archived_by=null, archive_keep=true
                where workspace_id=$1 and id = any($2::uuid[]) and archived_at is not null returning id`, [ws, ids]);
  return rows.length;
}

/** Автоархів одного кабінету: відпрацьоване (усі пости з файлом вийшли, далі нічого не заплановано) -
 *  через N днів після останньої публікації в архів; відкладене автоматично, але знову потрібне (новий
 *  пост, повтор хіта) - назад. Повертає скільки відкладено й скільки повернуто. */
export async function archiveSweepWorkspace(ws: string, now = Date.now()): Promise<{ archived: number; restored: number }> {
  const days = await archiveDays(ws);
  const items = await libraryItems(ws);
  const toArchive: string[] = [], toRestore: string[] = [];
  for (const it of items) {
    const a = archiveAction(it, it, days, now);
    if (a === "archive") toArchive.push(it.id); else if (a === "restore") toRestore.push(it.id);
  }
  if (toArchive.length) await q(`update media_asset set archived_at=now(), archived_by='auto' where workspace_id=$1 and id = any($2::uuid[]) and archived_at is null`, [ws, toArchive]);
  if (toRestore.length) await q(`update media_asset set archived_at=null, archived_by=null where workspace_id=$1 and id = any($2::uuid[]) and archived_by='auto'`, [ws, toRestore]);
  if (toArchive.length || toRestore.length)
    await logEvent("info", "medialib", `автоархів: відкладено ${toArchive.length}, повернуто ${toRestore.length} (через ${days} дн.)`, { ws });
  return { archived: toArchive.length, restored: toRestore.length };
}

/** Прохід по всіх кабінетах, де є файли в постах (воркер життєвого циклу, раз на 6 год). */
export async function archiveSweep(): Promise<void> {
  const wss = await q<{ workspace_id: string }>(
    `select distinct workspace_id from media_asset where archived_at is not null or source <> all($1::text[])`, [LIB_HIDDEN]);
  for (const w of wss) {
    try { await archiveSweepWorkspace(w.workspace_id); }
    catch (e: any) { await logEvent("warn", "medialib", "автоархів: " + String(e?.message || e).slice(0, 300), { ws: w.workspace_id }); }
  }
}

/** Назва файлу (порожня - прибрати). */
export async function setTitle(ws: string, id: string, title: string): Promise<boolean> {
  const r = await one(`update media_asset set title=nullif($3,'') where id=$1 and workspace_id=$2 returning id`, [id, ws, title]);
  return !!r;
}
