// 🖼 Карусель: пост із кількома кадрами - модель і всі операції над списком кадрів.
//
// Обкладинка лишається в post.media_id, кадри 2..N лежать у post_slide. Це свідомий вибір:
// «одне фото» знають редактор фото, прев'ю, картка Студії, бот, Mini App і всі мережі, тож кожен
// наявний шлях продовжує працювати й просто редагує обкладинку, а карусель = обкладинка + ще кадри.
// Змінювати список кадрів - лише через setPostMediaOrder: вона тримає обидві половини узгодженими
// (немає «обкладинки нема, а кадри є») і прибирає похідні файли, які більше ніде не стоять.
import { q, one } from "./db.js";
import { deleteMediaFile } from "./media.js";

// Instagram і Telegram більше за 10 кадрів не приймають (Threads і LinkedIn - до 20, але пост іде
// в усі мережі одразу, тож межа - найвужча)
export const MAX_SLIDES = 10;

export type PostMedia = { id: string; filename: string; kind: string; source: string; size?: number | null; duration?: number | null; width?: number | null; height?: number | null };

/** Кадри поста по порядку: обкладинка першою, далі post_slide. */
export async function postMediaList(postId: string): Promise<PostMedia[]> {
  return q<PostMedia>(
    `select m.id, m.filename, m.kind, m.source, m.size, m.duration, m.width, m.height from (
        select media_id, 0 as pos from post where id=$1 and media_id is not null
        union all select media_id, pos from post_slide where post_id=$1
     ) x join media_asset m on m.id = x.media_id
     order by x.pos`, [postId]);
}

/** Скільки кадрів у кожного з постів (для бейджа на картці) - одним запитом. */
export async function mediaCounts(postIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!postIds.length) return out;
  const rows = await q<{ post_id: string; n: number }>(
    `select p.id as post_id, (case when p.media_id is null then 0 else 1 end)
            + (select count(*)::int from post_slide s where s.post_id = p.id) as n
       from post p where p.id = any($1)`, [postIds]);
  for (const r of rows) out.set(r.post_id, Number(r.n) || 0);
  return out;
}

// Похідні файли (кропи, генерації, сток, зібрані слайди) - їх можна прибирати, коли вони ніде не
// стоять. Власні завантаження людини (upload/gdrive/diary/bot/broll) не видаляються ніколи.
export const DERIVED_MEDIA = ["ai", "crop", "pexels", "ai-base", "slide"];

/** Чи стоїть файл хоч десь: обкладинкою, базою під текст чи кадром каруселі (будь-якого поста). */
export async function mediaInUse(mediaId: string, filename: string): Promise<boolean> {
  return !!(await one(
    `select 1 from post where media_id=$1 or image_base=$2
     union all select 1 from post_slide where media_id=$1 limit 1`, [mediaId, filename]));
}

/** Прибрати похідні файли, які більше ніде не стоять (після зміни списку кадрів). */
export async function dropUnusedDerived(ws: string, candidates: Array<{ id?: string | null; filename?: string | null }>): Promise<number> {
  let n = 0;
  for (const c of candidates) {
    const m = c.id
      ? await one<{ id: string; filename: string; source: string }>(`select id, filename, source from media_asset where id=$1 and workspace_id=$2`, [c.id, ws])
      : c.filename
        ? await one<{ id: string; filename: string; source: string }>(`select id, filename, source from media_asset where filename=$1 and workspace_id=$2`, [c.filename, ws])
        : null;
    if (!m || !DERIVED_MEDIA.includes(m.source)) continue;
    if (await mediaInUse(m.id, m.filename)) continue;
    await q(`delete from media_asset where id=$1`, [m.id]);
    await deleteMediaFile(m.filename);
    n++;
  }
  return n;
}

export class SlideError extends Error {}

/**
 * Поставити посту рівно ці кадри в цьому порядку (перший = обкладинка). Єдина точка зміни списку:
 * переставити, прибрати, додати - усе зводиться сюди.
 * keepBase: не чіпати image_base/headline обкладинки (їх виставляє той, хто викликає, - так робить
 * збирач слайдів, у якого база = вихідне фото, а не зібраний кадр).
 */
export async function setPostMediaOrder(ws: string, postId: string, ids: string[], opts?: { keepBase?: boolean }): Promise<PostMedia[]> {
  const uniq = [...new Set(ids.map(String))];
  if (uniq.length > MAX_SLIDES) throw new SlideError(`У каруселі до ${MAX_SLIDES} кадрів (стільки приймають Instagram і Telegram).`);
  const found = uniq.length
    ? await q<{ id: string; filename: string; kind: string }>(`select id, filename, kind from media_asset where workspace_id=$1 and id = any($2::uuid[])`, [ws, uniq])
    : [];
  const byId = new Map(found.map((m) => [m.id, m]));
  for (const id of uniq) {
    const m = byId.get(id);
    if (!m) throw new SlideError("Файл не знайдено в медіатеці цього кабінету.");
    if (m.kind !== "image" && m.kind !== "video") throw new SlideError("Підтримуються лише фото й відео.");
  }
  // пост - лише цього кабінету (раніше перевірялись тільки файли, а сам пост міг бути чужим)
  const prev = await one<{ media_id: string | null; image_base: string | null; format: string | null }>(
    `select p.media_id, p.image_base, p.format from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!prev) throw new SlideError("пост не знайдено");
  // 🎬 відео - окремий пост (Reels, відео у Facebook, Threads, Telegram, LinkedIn): поруч із ним фото
  // не буває - Facebook-галерея й LinkedIn відео не беруть, а мережі з мішаною каруселлю - не всі.
  // Виняток - 📱 сторіс: там кожен кадр публікується окремо, тож фото й відео змішуються вільно.
  if (prev.format !== "story" && uniq.some((id) => byId.get(id)!.kind === "video") && uniq.length > 1)
    throw new SlideError("Відео публікується окремим постом: у каруселі поки лише фото. Прибери відео або фото (у сторіс змішувати можна).");
  const before = await postMediaList(postId);
  const cover = uniq[0] || null;
  if (cover !== prev.media_id) {
    if (opts?.keepBase) await q(`update post set media_id=$2 where id=$1`, [postId, cover]);
    // нова обкладинка - новий «чистий» кадр під текст: база = вона сама, старий напис уже не про неї.
    // На відео текст не накладається - бази нема.
    else {
      const c = cover ? byId.get(cover)! : null;
      await q(`update post set media_id=$2, image_base=$3, headline=null where id=$1`, [postId, cover, c && c.kind === "image" ? c.filename : null]);
    }
  }
  await q(`delete from post_slide where post_id=$1`, [postId]);
  for (let i = 1; i < uniq.length; i++)
    await q(`insert into post_slide(post_id, pos, media_id) values($1,$2,$3)`, [postId, i, uniq[i]]);
  // що випало зі списку (і стара база під текст, якщо обкладинка змінилась) - прибрати, якщо похідне й ніде не стоїть
  const gone: Array<{ id?: string | null; filename?: string | null }> = before.filter((m) => !uniq.includes(m.id)).map((m) => ({ id: m.id }));
  if (cover !== prev.media_id && prev.image_base && !opts?.keepBase) gone.push({ filename: prev.image_base });
  await dropUnusedDerived(ws, gone);
  return postMediaList(postId);
}

/** 🎬 Поставити посту відео (замість усіх фото/кадрів). */
export async function setPostVideo(ws: string, postId: string, mediaId: string): Promise<PostMedia[]> {
  const m = await one<{ kind: string }>(`select kind from media_asset where id=$1 and workspace_id=$2`, [mediaId, ws]);
  if (!m) throw new SlideError("Відео не знайдено в медіатеці цього кабінету.");
  if (m.kind !== "video") throw new SlideError("Це не відео - фото додаються як обкладинка чи кадри каруселі.");
  return setPostMediaOrder(ws, postId, [mediaId]);
}

/** Додати кадри в кінець (обкладинки нема - перший стає нею). */
export async function appendPostMedia(ws: string, postId: string, ids: string[]): Promise<PostMedia[]> {
  const cur = (await postMediaList(postId)).map((m) => m.id);
  const next = [...cur, ...ids.filter((id) => !cur.includes(id))];
  if (next.length > MAX_SLIDES) throw new SlideError(`У каруселі до ${MAX_SLIDES} кадрів - зараз ${cur.length}, тож додати можна ще ${Math.max(0, MAX_SLIDES - cur.length)}.`);
  return setPostMediaOrder(ws, postId, next);
}

/** Прибрати один кадр (обкладинка - наступний кадр стає нею). */
export async function removePostMedia(ws: string, postId: string, mediaId: string): Promise<PostMedia[]> {
  const cur = (await postMediaList(postId)).map((m) => m.id);
  return setPostMediaOrder(ws, postId, cur.filter((id) => id !== mediaId));
}

/**
 * Обкладинку прибрали, а кадри лишились («Без фото» в редакторі фото, або обкладинка зникла з
 * медіатеки) → першим стає наступний кадр. Інакше карусель мала б «дірку» на місці обкладинки,
 * а все, що знає лише обкладинку, вирішило б, що фото в пості немає.
 */
export async function promoteIfCoverless(ws: string, postId: string): Promise<void> {
  const p = await one<{ media_id: string | null }>(`select media_id from post where id=$1`, [postId]);
  if (!p || p.media_id) return;
  const rest = await q<{ media_id: string }>(`select media_id from post_slide where post_id=$1 order by pos`, [postId]);
  if (rest.length) await setPostMediaOrder(ws, postId, rest.map((r) => r.media_id));
}

/**
 * Обкладинку стерли з медіатеки (FK обнулив post.media_id), а кадри лишились → піднімаємо наступний
 * кадр в обкладинки по всьому кабінету. Викликається після видалень у медіатеці.
 */
export async function healCoverless(ws: string): Promise<void> {
  const rows = await q<{ id: string }>(
    `select p.id from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where s.workspace_id=$1 and p.media_id is null and exists (select 1 from post_slide x where x.post_id=p.id)`, [ws]);
  for (const r of rows) await promoteIfCoverless(ws, r.id);
}
