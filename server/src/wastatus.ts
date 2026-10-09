// 📲 WhatsApp-статус як «ручна мережа». Статусів через офіційний WhatsApp Business Platform немає, а сервіси,
// що входять у WhatsApp як «WhatsApp Web» з чужого номера, ризикують баном номера - цього не робимо. Тож у час
// публікації бот надсилає людині в Telegram готові кадри сторіс (з субтитрами мовою, обраною для WhatsApp),
// і вона пересилає кожен у WhatsApp → «Мій статус»: відкрити відео → «Поділитись» → WhatsApp → «Мій статус».
//
// Кому: тому, хто публікує зараз (кабінет, бот, конектор), якщо його Telegram привʼязаний до Holos; інакше -
// автору поста; інакше - власнику бренду, далі будь-кому, хто в бренді може публікувати. Одна людина на пост.
import { q, one } from "./db.js";
import { env } from "./env.js";
import * as tg from "./telegram.js";
import { MEDIA_DIR } from "./media.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { actorId } from "./actor.js";
import { can, normRole } from "./roles.js";
import * as P from "./montage-plan.js";
import type { PostMedia } from "./slides.js";

type Who = { user_id: string; chat_id: string; tg_user_id: string };

/** Кому з бренду бот може надіслати кадри для WhatsApp (Telegram привʼязаний, може публікувати). */
export async function waRecipient(ws: string, postId: string): Promise<Who | null> {
  const rows = await q<Who & { role: string; created_by: string | null; owner: boolean }>(
    `select o.user_id::text, coalesce(o.chat_id, o.tg_user_id::text) as chat_id, o.tg_user_id::text, m.role,
            (select p.created_by::text from post p where p.id=$2) as created_by, m.role='owner' as owner
       from tg_owner o join workspace_member m on m.user_id=o.user_id and m.workspace_id=$1
      where o.user_id is not null`, [ws, postId]);
  const ok = rows.filter((r) => can(normRole(r.role), "publish"));
  const me = actorId();
  const pick = ok.find((r) => r.user_id === me) || ok.find((r) => r.user_id === r.created_by) || ok.find((r) => r.owner) || ok[0];
  return pick ? { user_id: pick.user_id, chat_id: pick.chat_id, tg_user_id: pick.tg_user_id } : null;
}
/** Чи є в бренді кому доставити WhatsApp-статус (для списку мереж сторіс). */
export async function waReady(ws: string): Promise<boolean> {
  return !!(await one(`select 1 from tg_owner o join workspace_member m on m.user_id=o.user_id and m.workspace_id=$1
                        where m.role in ('owner','admin','member','editor') limit 1`, [ws]));
}

const NO_ONE = "нема кому надіслати кадри для WhatsApp: статус ставиш ти сам, тож бот має знати твій Telegram - Налаштування → Канали → «Підключити наш бот» → Start";

/**
 * Надіслати людині кадри для WhatsApp-статусу: спершу коротка інструкція, далі кожен кадр окремим
 * повідомленням (відео - файлом, щоб WhatsApp отримав його цілим). Вертає, кому й скільки.
 */
export async function deliverWhatsApp(ws: string, postId: string, frames: PostMedia[], lang: string | null): Promise<{ who: Who; ids: number[] }> {
  if (!frames.length) throw new Error("у сторіс немає жодного кадру - додай фото чи відео");
  const who = await waRecipient(ws, postId);
  if (!who) throw new Error(NO_ONE);
  const { wsBotToken } = await import("./tgbot.js");
  const own = await wsBotToken(ws);
  // власний бот бренду людина могла не запускати - тоді спільним (як і решту сповіщень)
  const tokens = [...new Set([own, env.telegram.botToken].filter(Boolean))];
  const brand = (await one<{ title: string | null }>(`select title from workspace where id=$1`, [ws]))?.title || "бренд";
  const lng = lang ? ` · субтитри ${P.SUB_LANGS[lang]?.by || lang}` : "";
  const head = `📲 WhatsApp-статус «${brand}»: ${frames.length} ${frames.length === 1 ? "кадр" : frames.length < 5 ? "кадри" : "кадрів"}${lng}.\n\n` +
    `Відкрий кожне відео нижче → «Поділитись» (↗) → WhatsApp → «Мій статус». Або «Зберегти» і додай у WhatsApp із галереї - по порядку.`;
  let lastErr: any = null;
  for (const token of tokens) {
    const ids: number[] = [];
    try {
      ids.push((await tg.sendMessage(token, who.chat_id, head)).message_id);
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const cap = frames.length > 1 ? `${i + 1}/${frames.length}` : "";
        const r = f.kind === "video"
          ? await tg.sendVideo(token, who.chat_id, Number(f.size) && Number(f.size) <= tg.TG_VIDEO_URL_MAX ? { url: `${env.appBaseUrl}/media/${f.filename}` } : { file: await readFile(join(MEDIA_DIR, f.filename)), name: f.filename }, cap, f)
          : await tg.sendPhoto(token, who.chat_id, `${env.appBaseUrl}/media/${f.filename}`, cap);
        ids.push(r.message_id);
      }
      return { who, ids };
    } catch (e: any) {
      lastErr = e;
      // бот не може написати людині (не запускала цього бота) - пробуємо наступним; інше - одразу кажемо
      if (ids.length || !tg.cantReachUser(e)) throw e;
    }
  }
  throw lastErr || new Error(NO_ONE);
}
