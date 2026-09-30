// 🏢 Бренд у боті. Людина з кількома брендами (Олег: особистий і Vary Servis) пише одному боту, а бот
// досі знав лише один кабінет - той, з якого його колись підключили. 30.09 так рілс про бетон для Vary
// Servis вийшов у особисті Threads, Facebook і Instagram. Тепер:
//  - бот працює з ОБРАНИМ брендом (tg_owner.workspace_id), і його назву видно на кнопці меню й картках;
//  - перемкнути - /brand чи кнопка «🏢 …» (лише бренди, куди в людини є доступ);
//  - чернетку, що ще нікуди не вийшла, можна перенести в інший бренд просто з картки - разом із фото
//    й відео; відкрита сесія монтажу переїжджає разом із брендом.
// Хто людина - знаємо з tg_owner.user_id (привʼязка з кабінету кнопкою «Підключити наш бот»). Старі
// привʼязки без нього бачать лише свій кабінет і підказку, як привʼязатись наново.
import { link, copyFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { q, one, tx } from "./db.js";
import { MEDIA_DIR } from "./media.js";
import { listWorkspaces, isMember } from "./workspaces.js";
import { alreadySentNetworks } from "./publisher.js";

export type Brand = { id: string; title: string };
export type BotBrands = { current: string | null; linked: boolean; list: Brand[] };

/** Бренди, з якими ця людина може працювати в боті. own - власний бот кабінету: лише бренди, де стоїть
 *  саме він (чужий бот не діє в чужих кабінетах). */
export async function botBrands(fromId: number, own: boolean, token: string): Promise<BotBrands> {
  const o = await one<{ workspace_id: string; user_id: string | null }>(`select workspace_id, user_id from tg_owner where tg_user_id=$1`, [fromId]);
  if (!o) return { current: null, linked: false, list: [] };
  const cur = await one<Brand>(`select w.id, coalesce(nullif(btrim(w.title),''), replace(w.name,'user:','')) title from workspace w where w.id=$1`, [o.workspace_id]);
  if (!o.user_id) return { current: o.workspace_id, linked: false, list: cur ? [cur] : [] };
  let list: Brand[] = (await listWorkspaces(o.user_id)).map((w) => ({ id: w.id, title: w.title }));
  if (own) {
    const ok = new Set((await q<{ workspace_id: string }>(`select workspace_id from telegram_config where bot_token=$1`, [token])).map((r) => r.workspace_id));
    list = list.filter((b) => ok.has(b.id));
  }
  if (cur && !list.some((b) => b.id === cur.id)) list.unshift(cur);
  return { current: o.workspace_id, linked: true, list };
}

/** Знайти бренд людини за коротким id (перші 8 знаків - так він їде в кнопці). */
export function pickBrand(b: BotBrands, short: string): Brand | null {
  const s = String(short || "").toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(s)) return null;
  return b.list.find((x) => x.id.startsWith(s)) || null;
}

/** Перемкнути бот на бренд (лише зі списку людини - перевіряє виклик). */
export async function setBotBrand(fromId: number, wsId: string): Promise<void> {
  await q(`update tg_owner set workspace_id=$2 where tg_user_id=$1`, [fromId, wsId]);
}

/** Бренд, до якого людину вже не пускають (доступ забрали, бренд видалили): бот вертається в її
 *  домашній кабінет. null - усе гаразд або людину не знаємо. */
export async function homeIfLost(fromId: number, wsId: string, userId: string | null): Promise<string | null> {
  if (!userId || await isMember(userId, wsId)) return null;
  const h = await one<{ workspace_id: string }>(
    `select u.workspace_id from app_user u join workspace_member m on m.user_id=u.id and m.workspace_id=u.workspace_id where u.id=$1`, [userId]);
  if (!h) return null;
  await setBotBrand(fromId, h.workspace_id);
  return h.workspace_id;
}

const UUID_RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/**
 * Кнопка зі старого повідомлення після перемикання бренду: пост (ідея, матеріал, слот) лежить у
 * попередньому бренді. Беремо бренд самого запису - якщо людина має до нього доступ, - інакше
 * картка чернетки, відкрита до перемикання, казала б «пост не знайдено».
 */
export async function brandOfCallback(data: string, active: string, userId: string | null, own: boolean, token: string): Promise<string> {
  const m = String(data || "").match(UUID_RX);
  if (!m || !userId) return active;
  const id = m[0].toLowerCase();
  const r = await one<{ ws: string }>(
    `select coalesce(
        (select s.workspace_id from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1),
        (select workspace_id from idea_bank where id=$1),
        (select workspace_id from source where id=$1),
        (select s.workspace_id from schedule_slot ss join post p on p.id=ss.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where ss.id=$1),
        (select workspace_id from media_asset where id=$1)) ws`, [id]).catch(() => null);
  const ws = r?.ws;
  if (!ws || ws === active || !(await isMember(userId, ws))) return active;
  if (own && !(await one(`select 1 from telegram_config where workspace_id=$1 and bot_token=$2`, [ws, token]))) return active;
  return ws;
}

// ---------------------------------------------------------------- перенесення медіа між брендами
// Файл не копіюємо, а робимо другий жорсткий звʼязок (той самий диск - місця не займає): видалення в
// медіатеці одного бренду стирає СВІЙ файл, і фото в іншому бренді не зникає. Рядок, яким більше
// ніщо в старому бренді не користується, просто переїжджає.
async function linkCopy(filename: string): Promise<string> {
  const next = `${randomUUID()}${extname(filename)}`;
  try { await link(join(MEDIA_DIR, filename), join(MEDIA_DIR, next)); }
  catch { await copyFile(join(MEDIA_DIR, filename), join(MEDIA_DIR, next)); }
  return next;
}

/** Медіа → інший бренд. keep - пост, що переїжджає разом (його посилання не рахуються). Вертає нові id. */
export async function moveMedia(ids: string[], from: string, to: string, keep: string | null = null): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of [...new Set(ids.filter(Boolean))]) {
    const m = await one<{ id: string; filename: string }>(`select id, filename from media_asset where id=$1 and workspace_id=$2`, [id, from]);
    if (!m) continue;
    const used = await one(
      `select 1 from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
        where s.workspace_id=$1 and p.id is distinct from $3::uuid
          and (p.media_id=$2 or p.image_base=$4 or p.reel_video=$4
               or exists (select 1 from post_slide ps where ps.post_id=p.id and ps.media_id=$2)) limit 1`, [from, id, keep, m.filename]);
    if (!used) { await q(`update media_asset set workspace_id=$2 where id=$1`, [id, to]); map.set(id, id); continue; }
    const fname = await linkCopy(m.filename);
    const n = await one<{ id: string }>(
      `insert into media_asset(workspace_id, kind, mime, original_name, filename, size, source, external_id, duration, width, height, alt_text)
       select $2, kind, mime, original_name, $3, size, source, external_id, duration, width, height, alt_text from media_asset where id=$1 returning id`, [id, to, fname]);
    if (n) map.set(id, n.id);
  }
  return map;
}

// ---------------------------------------------------------------- чернетка → інший бренд
export type MoveResult = { ok: true } | { ok: false; error: string };
const STORY_LIKE = new Set(["story", "reel"]);

/**
 * Перенести чернетку в інший бренд: текст, фото/кадри/відео, формат. Мережі - ті, що підключені в новому
 * бренді (версії тексту під мережі й обрані акаунти старого бренду скидаються: вони писались під його
 * голос і його Сторінки). Уже опублікований пост не переноситься - він живе там, куди вийшов.
 */
export async function moveDraft(postId: string, from: string, to: string): Promise<MoveResult> {
  if (from === to) return { ok: true };
  const p = await one<{ id: string; run_id: string; source_id: string; media_id: string | null; image_base: string | null; reel_video: string | null; channels: any; format: string | null }>(
    `select p.id, p.run_id, r.source_id, p.media_id, p.image_base, p.reel_video, p.channels, p.format
       from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id where p.id=$1 and s.workspace_id=$2`, [postId, from]);
  if (!p) return { ok: false, error: "Пост не знайдено." };
  if ((await alreadySentNetworks(postId)).length) return { ok: false, error: "Пост уже вийшов у мережі цього бренду - переносити пізно. Нові пости піде в інший бренд, якщо перемкнути бренд (/brand)." };

  // медіа поста: обкладинка, кадри каруселі, база під текст на фото, зібраний рілс
  const slides = await q<{ media_id: string }>(`select media_id from post_slide where post_id=$1 order by pos`, [postId]);
  const byName = await q<{ id: string }>(`select id from media_asset where workspace_id=$1 and filename = any($2::text[])`,
    [from, [p.image_base, p.reel_video].filter(Boolean)]);
  const map = await moveMedia([p.media_id || "", ...slides.map((s) => s.media_id), ...byName.map((r) => r.id)], from, to, postId);
  const nameOf = async (fn: string | null): Promise<string | null> => {
    if (!fn) return null;
    const old = await one<{ id: string }>(`select id from media_asset where filename=$1 and workspace_id=$2`, [fn, from]);
    if (!old) return fn;   // рядок переїхав (той самий файл) або його й не було
    const nid = map.get(old.id);
    return nid ? (await one<{ filename: string }>(`select filename from media_asset where id=$1`, [nid]))?.filename || fn : fn;
  };

  // мережі нового бренду: ті, що були ввімкнені й там підключені; нема жодної - типові для формату
  const { connectedNets } = await import("./tgcompose.js");
  const nets = await connectedNets(to);
  const was = Object.keys(p.channels || {}).filter((k) => p.channels[k] && p.channels[k].on);
  let on = was.filter((k) => nets.includes(k));
  if (!on.length) on = STORY_LIKE.has(String(p.format)) || p.reel_video ? nets.filter((k) => k === "instagram" || k === "facebook") : nets.filter((k) => k === "telegram");
  const ch: Record<string, any> = {};
  for (const k of on) ch[k] = { on: true };

  const src = await one<{ origin: string; title: string | null; transcript: string | null }>(`select origin, title, transcript from source where id=$1`, [p.source_id]);
  const [base, reel] = [await nameOf(p.image_base), await nameOf(p.reel_video)];
  await tx(async (c) => {
    const s = await c.one<{ id: string }>(`insert into source(workspace_id, origin, title, transcript) values($1,$2,$3,$4) returning id`,
      [to, src?.origin || "bot", src?.title || null, src?.transcript || null]);
    const r = await c.one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [s!.id]);
    await c.q(`update post set run_id=$2, channels=$3, rubric=null, media_id=$4, image_base=$5, reel_video=$6 where id=$1`,
      [postId, r!.id, JSON.stringify(ch), p.media_id ? (map.get(p.media_id) || p.media_id) : null, base, reel]);
    for (const sl of slides) {
      const nid = map.get(sl.media_id);
      if (nid && nid !== sl.media_id) await c.q(`update post_slide set media_id=$3 where post_id=$1 and media_id=$2`, [postId, sl.media_id, nid]);
    }
    await c.q(`update plan_slot set post_id=null, status=case when match_source_id is not null then 'matched' else 'empty' end where post_id=$1`, [postId]);
  });
  // старий матеріал бота без інших постів більше нічого не тримає (інакше в старому бренді лишився б
  // текст, що «пішов не туди»); матеріали людини (статті, щоденник) не чіпаємо
  await q(`delete from source s where s.id=$1 and s.origin in ('bot','montage','idea')
             and not exists (select 1 from pipeline_run r join post p on p.run_id=r.id where r.source_id=s.id)`, [p.source_id]).catch(() => {});
  return { ok: true };
}

/** Назва бренду для картки, коли в людини їх кілька (одному бренду підпис не потрібен). chatId - особистий
 *  чат, а в Telegram його id і є id людини. */
export async function brandLabel(ws: string, chatId: string): Promise<string> {
  const id = Number(chatId);
  if (!Number.isFinite(id) || id <= 0) return "";
  const o = await one<{ user_id: string | null }>(`select user_id from tg_owner where tg_user_id=$1`, [id]).catch(() => null);
  if (!o?.user_id) return "";
  const list = await listWorkspaces(o.user_id);
  return list.length < 2 ? "" : list.find((w) => w.id === ws)?.title || "";
}
