// 📝 Композер у Telegram: написати пост із DM, дати йому фото, поправити текст, обрати мережі
// й опублікувати одразу або за розкладом - не заходячи в кабінет.
//
// Навіщо окремий файл: tgbot.ts уже великий, а це самодостатній сценарій зі своїм станом.
//
// СТАН. Розмова в Telegram не має «форми» - бот мусить памʼятати, чого він зараз чекає від
// наступного повідомлення (тексту? фото? дати?). Тримаємо це в settings_block під ключем
// `tg_compose`: {postId, await, chat}. Один активний чернетковий пост на воркспейс - цього
// достатньо (власник один) і не потребує нової таблиці.
import { actorId } from "./actor.js";
import { approvedNotice } from "./team.js";
import { q, one } from "./db.js";
import * as tg from "./telegram.js";
import { getSetting, setSetting } from "./settings.js";
import { saveMedia } from "./media.js";
import { postMediaList, setPostMediaOrder, setPostVideo, MAX_SLIDES } from "./slides.js";
import { appendCroppedSlide } from "./images.js";
import { publishPostToChannels, enabledNets, closeSlotsIfDone, alreadySentNetworks, sentAccountKeys, PUB_NETS, unschedulePost, type PubResult } from "./publisher.js";
import { accountChoices, postAccounts, isAccNet, type AccNet, type AccountChoice } from "./accounts.js";
import { rewritePost } from "./pipeline.js";
import { ttOpts, ytOpts, ttLine, ytLine, VIDEO_NETS } from "./vidnets.js";
import { PRIVACY_UA } from "./tiktok.js";
import { YT_PRIVACY_UA, titleFrom } from "./youtube.js";
import { ttCreator, canDirect } from "./vidpub.js";
import { logEvent } from "./log.js";
import { tgStoryReady, bizLabel, brandBiz } from "./tgstory.js";
import { waReady } from "./wastatus.js";

const KEY = "tg_compose";
type Await = null | "text" | "photo" | "when" | "rewrite";
type ComposeState = { postId: string | null; await: Await; chat: string | null; at?: number };
const EMPTY: ComposeState = { postId: null, await: null, chat: null };
// Очікування відповіді живе 30 хв. Без строку бот «застрягав»: відповідь щоденника через день
// переписувала текст поста, запускала платне переписування або тонула в «Не зрозумів дату».
const AWAIT_TTL_MS = 30 * 60_000;

export async function getCompose(ws: string): Promise<ComposeState> {
  const st = await getSetting<ComposeState>(ws, KEY, EMPTY);
  if (st.await && (!st.at || Date.now() - st.at > AWAIT_TTL_MS)) return { ...st, await: null };
  return st;
}
const setCompose = (ws: string, st: ComposeState) => setSetting(ws, KEY, st);
export const clearCompose = (ws: string) => setSetting(ws, KEY, EMPTY);

// мережі, які реально підключені: показувати кнопку каналу, якого нема, - це обіцянка, яку
// публікація не виконає
const NETS: Array<[string, string]> = [
  ["telegram", "✈️ Telegram"], ["instagram", "📸 Instagram"], ["facebook", "📘 Facebook"],
  ["threads", "🧵 Threads"], ["linkedin", "💼 LinkedIn"], ["youtube", "▶️ YouTube"], ["tiktok", "🎵 TikTok"], ["whatsapp", "🟢 WhatsApp"],
];
// opts.video - пост із відео: тоді й YouTube та TikTok (вони приймають лише відео, тож текстовому
// посту кнопки цих мереж були б обіцянкою, яку публікація не виконає)
// opts.story - мережі сторіс: Instagram і Facebook, Telegram (профіль через Telegram Business, а не канали)
// і WhatsApp-статус (кадри надсилає бот тому, хто ставить статус)
export async function connectedNets(ws: string, opts: { video?: boolean; story?: boolean } = {}): Promise<string[]> {
  if (opts.story) {
    const [m, tgs, wa] = await Promise.all([
      one<{ page_id: string | null; ig_user_id: string | null }>(`select page_id, ig_user_id from meta_config where workspace_id=$1`, [ws]),
      tgStoryReady(ws), waReady(ws)]);
    return [...(m?.ig_user_id ? ["instagram"] : []), ...(m?.page_id ? ["facebook"] : []), ...(tgs ? ["telegram"] : []), ...(wa ? ["whatsapp"] : [])];
  }
  const [t, th, m, li, v] = await Promise.all([
    one<{ n: number }>(`select count(*)::int n from telegram_config where workspace_id=$1 and bot_token is not null and (channel_chat_id is not null or group_chat_id is not null)`, [ws]),
    one<{ n: number }>(`select count(*)::int n from threads_config where workspace_id=$1 and access_token is not null`, [ws]),
    one<{ page_id: string | null; ig_user_id: string | null }>(`select page_id, ig_user_id from meta_config where workspace_id=$1`, [ws]),
    one<{ n: number }>(`select count(*)::int n from linkedin_config where workspace_id=$1 and access_token is not null`, [ws]),
    opts.video ? one<{ yt: boolean; tt: boolean }>(`select exists(select 1 from youtube_config where workspace_id=$1) as yt, exists(select 1 from tiktok_config where workspace_id=$1) as tt`, [ws]) : null,
  ]);
  const out: string[] = [];
  if ((t?.n || 0) > 0) out.push("telegram");
  if (m?.ig_user_id) out.push("instagram");
  if (m?.page_id) out.push("facebook");
  if ((th?.n || 0) > 0) out.push("threads");
  if ((li?.n || 0) > 0) out.push("linkedin");
  if (v?.yt) out.push("youtube");
  if (v?.tt) out.push("tiktok");
  return out;
}

async function wsTz(ws: string): Promise<string> {
  const r = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='timezone'`, [ws]);
  return r?.content || "Europe/Kyiv";
}

// Локальний час у поясі воркспейсу → UTC. Двокроково: беремо ту саму стінну дату як UTC, дивимось,
// котра це година В ПОЯСІ, і зсуваємо на різницю. Інакше «завтра о 9:00» поїхало б за UTC і о 9:00
// не опублікувалось би (для Києва це різниця 2-3 години залежно від літнього часу).
export function zonedToUtc(y: number, mo: number, d: number, hh: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, hh, mi, 0);
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  // зсув пояса В ЦЮ МИТЬ (місцевий час мінус UTC)
  const offsetAt = (ms: number): number => {
    const p: Record<string, string> = {};
    for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = part.value;
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - ms;
  };
  // два проходи: зсув, узятий у мить «guess», у день переходу на літній/зимовий час хибить на годину -
  // тож перевіряємо його вже в знайденій миті й за потреби уточнюємо («завтра 09:00» не стає 10:00)
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

// «зараз» у поясі воркспейсу, розкладене на частини (для кнопок «сьогодні/завтра»)
async function nowParts(ws: string): Promise<{ y: number; mo: number; d: number; hh: number; mi: number; tz: string }> {
  const tz = await wsTz(ws);
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date())) if (part.type !== "literal") p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, hh: +p.hour % 24, mi: +p.minute, tz };
}

// ---- створення чернетки з ВЛАСНОГО тексту (без AI: що написав, те й піде) ----
export async function createBotDraft(ws: string, text: string): Promise<string> {
  const body = text.trim();
  const src = await one<{ id: string }>(
    `insert into source(workspace_id, origin, title, transcript) values($1,'bot',$2,$3) returning id`,
    [ws, body.slice(0, 120), body]);
  const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
  // Telegram обираємо за замовчуванням, якщо підключений: це головний канал і саме таку поведінку
  // мала стара кнопка «Опублікувати в Telegram»; решту мереж юзер вмикає свідомо.
  const nets = await connectedNets(ws);
  const ch: Record<string, any> = {};
  if (nets.includes("telegram")) ch.telegram = { on: true, text: "" };
  const p = await one<{ id: string }>(
    `insert into post(run_id, stage, content, channels, created_by) values($1,'final',$2,$3,$4) returning id`,
    [run!.id, body, JSON.stringify(ch), actorId()]);
  return p!.id;
}

type PostRow = { id: string; content: string; channels: any; filename: string | null; review: string | null; format: string | null };
export async function loadPost(ws: string, postId: string): Promise<PostRow | null> {
  return one<PostRow>(
    `select p.id, p.content, p.channels, p.review, p.format, ma.filename from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       left join media_asset ma on ma.id=p.media_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
}

// ---- картка поста: що зараз є + що можна зробити ----
export async function composeCard(ws: string, postId: string, brand = ""): Promise<{ text: string; buttons: tg.TgButton[][] } | null> {
  const p = await loadPost(ws, postId);
  if (!p) return null;
  const ch = p.channels || {};
  const list = await postMediaList(postId);
  const frames = list.length, isVideo = list[0]?.kind === "video";
  // YouTube і TikTok - лише для відео-поста (не сторіс); уже обрані показуємо, щоб їх можна було зняти
  const vidPost = isVideo && frames === 1 && p.format !== "story";
  const story = p.format === "story";
  const nets = await connectedNets(ws, { video: vidPost || VIDEO_NETS.some((k) => ch[k]?.on), story });
  const chosen = nets.filter((k) => ch[k] && ch[k].on);
  const slot = await one<{ scheduled_at: string }>(
    `select scheduled_at from schedule_slot where post_id=$1 and status='planned' order by scheduled_at limit 1`, [postId]);
  const tz = await wsTz(ws);
  const when = slot ? new Intl.DateTimeFormat("uk-UA", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(slot.scheduled_at)) : "";

  const body = p.content.length > 600 ? p.content.slice(0, 600) + "…" : p.content;
  // розмітка **…** (sendMessage сам перекладає її в HTML і екранує текст): власні <b> і &amp; тут
  // екранувались удруге, і людина бачила буквальні «<b>Чернетка</b>» та «R&amp;D»
  const choices = await accountChoices(ws);
  const bizName = story && chosen.includes("telegram") ? bizLabel(await brandBiz(ws)) : "";
  const text = `📝 **${p.review === "approved" ? "Затверджено" : "Чернетка"}**${brand ? ` · 🏢 ${brand}` : ""}\n\n${body}\n\n`
    + (isVideo ? `🎬 Відео${list[0].duration ? ` ${Math.floor(Number(list[0].duration) / 60)}:${String(Math.round(Number(list[0].duration)) % 60).padStart(2, "0")}` : ""}\n`
      : `🖼 Фото: ${frames > 1 ? `карусель, ${frames} кадрів` : p.filename ? "є" : "нема"}\n`)
    + `📢 Куди: ${chosen.length ? chosen.map((k) => niceNet(k) + (story && k === "telegram" ? ` (профіль ${bizName || "не підключено"})` : story && k === "whatsapp" ? " (статус - кадри надішлю тобі)" : accountsLabel(k, ch, choices))).join(" · ") : "не обрано"}`
    + (chosen.includes("youtube") ? `\n▶️ YouTube: ${vidPost ? ytLine(ytOpts(ch.youtube), titleFrom(ch.youtube?.text || p.content)) : "⚠️ лише відео - додай відео або зніми YouTube"}` : "")
    + (chosen.includes("tiktok") ? `\n🎵 TikTok: ${vidPost ? ttLine(ttOpts(ch.tiktok)) : "⚠️ лише відео - додай відео або зніми TikTok"}` : "")
    + (when ? `\n🗓 Заплановано: ${when}` : "");

  // ряд каналів: тумблери ✅/⬜ по 2 в рядок, щоб кнопки лишались читабельними на телефоні
  const rows: tg.TgButton[][] = [];
  for (let i = 0; i < nets.length; i += 2) {
    rows.push(nets.slice(i, i + 2).map((k) => ({
      text: `${ch[k] && ch[k].on ? "✅" : "⬜"} ${niceNet(k)}`, data: `cn:${postId}:${k}`,
    })));
  }
  // 👥 у мережі кілька Сторінок / профілів / каналів - обрати, куди саме (той самий пост у кілька - можна).
  // Telegram - навіть з одним каналом: там же «＋ Додати канал» (без цього вибору в боті не видно взагалі)
  // у сторіс Telegram - профіль людини (Telegram Business), а не канали: вибору каналів там нема
  const multi = chosen.filter((k) => isAccNet(k) && !(story && k === "telegram") && (choices[k].length > 1 || (k === "telegram" && choices[k].length > 0)));
  for (let i = 0; i < multi.length; i += 2)
    rows.push(multi.slice(i, i + 2).map((k) => ({ text: `👥 ${niceNet(k).split(" ")[1]}: ${shortPick(k, ch, choices)} ▸`, data: `cac:${postId}:${k}` })));
  // 🌐 один пост - одразу в усі підключені мережі, що приймають такий формат (відео - і YouTube з TikTok)
  const allOff = (await allNetsFor(ws, postId)).filter((k) => !(ch[k] && ch[k].on));
  if (allOff.length >= 2) rows.push([{ text: `🌐 В усі мережі (ще ${allOff.length})`, data: `cal:${postId}` }]);
  // 🎬 як вийде відео в YouTube і TikTok (TikTok вимагає, щоб «хто бачить» обирала людина)
  const vr: tg.TgButton[] = [];
  const sentV = new Set((await alreadySentNetworks(postId)).filter((k) => VIDEO_NETS.includes(k)));
  if (vidPost && chosen.includes("youtube") && !sentV.has("youtube")) vr.push({ text: `▶️ YouTube: ${YT_PRIVACY_UA[ytOpts(ch.youtube).privacy]} ▸`, data: `cyt:${postId}` });
  if (vidPost && chosen.includes("tiktok") && !sentV.has("tiktok")) { const t = ttOpts(ch.tiktok); vr.push({ text: `🎵 TikTok: ${t.mode === "draft" ? "чернетка" : t.privacy ? PRIVACY_UA[t.privacy] : "хто бачить?"} ▸`, data: `ctt:${postId}` }); }
  if (vr.length) rows.push(vr);
  if (brand) rows.push([{ text: `🏢 Бренд: ${brand.slice(0, 28)} ▸`, data: `cb:${postId}` }]);
  // альбом, надісланий у відповідь на «Додати фото», стає каруселлю (перше фото - обкладинка)
  rows.push([{ text: isVideo ? "🎬 Змінити відео" : p.filename ? "🖼 Змінити фото" : "🖼 Фото, альбом чи відео", data: `cp:${postId}` },
             { text: "✍ Текст", data: `ce:${postId}` }]);
  rows.push([{ text: "🤖 Переписати (AI)", data: `cr:${postId}` },
             { text: p.review === "approved" ? "↩ У чернетки" : "✅ Затвердити", data: `ca:${postId}` }]);
  rows.push([{ text: "🚀 Опублікувати", data: `cgo:${postId}` }, { text: "🗓 Запланувати", data: `cs:${postId}` }]);
  return { text, buttons: rows };
}

// ---- 👥 які саме акаунти мережі (Сторінки Facebook, їхній Instagram, профілі Threads, канали Telegram) ----
// Вибір - той самий `channels.<мережа>.accounts`, що в кабінеті й конекторі: порожньо = за замовчуванням
// (основний акаунт; у Telegram - основні канал і група).
function picked(net: string, ch: any, choices: Record<AccNet, AccountChoice[]>): { list: AccountChoice[]; ids: string[] } {
  const list = isAccNet(net) ? choices[net] : [];
  const want = postAccounts(ch, net);
  if (want.length) return { list, ids: want };
  const dflt = net === "telegram" ? list.filter((a) => a.main) : [list.find((a) => a.main) || list[0]].filter(Boolean) as AccountChoice[];
  return { list, ids: dflt.map((a) => a.id) };
}
const accName = (list: AccountChoice[], id: string) => list.find((a) => a.id === id)?.name || "⚠️ акаунт, якого вже нема в бренді";
function accountsLabel(net: string, ch: any, choices: Record<AccNet, AccountChoice[]>): string {
  if (!isAccNet(net) || !choices[net].length) return "";
  const { list, ids } = picked(net, ch, choices);
  return ids.length ? ` (${ids.map((id) => accName(list, id)).join(" + ")})` : "";
}
function shortPick(net: string, ch: any, choices: Record<AccNet, AccountChoice[]>): string {
  const { list, ids } = picked(net, ch, choices);
  const first = ids.length ? accName(list, ids[0]).slice(0, 16) : "-";
  return ids.length > 1 ? `${first} +${ids.length - 1}` : first;
}

/** Картка вибору акаунтів мережі: галочка на кожен, опубліковане - ✓ і не знімається. */
export async function accountsCard(ws: string, postId: string, net: string): Promise<{ text: string; buttons: tg.TgButton[][] } | null> {
  const p = await loadPost(ws, postId);
  if (!p || !isAccNet(net)) return null;
  const choices = await accountChoices(ws);
  const { list, ids } = picked(net, p.channels || {}, choices);
  const sent = await sentAccountKeys(ws, postId);
  const rows: tg.TgButton[][] = [];
  // обраний раніше акаунт, якого вже нема в бренді, - теж рядком: його треба могти зняти
  for (const id of [...list.map((a) => a.id), ...ids.filter((x) => !list.some((a) => a.id === x))]) {
    const a = list.find((x) => x.id === id);
    const done = sent.has(`${net}|${id}`);
    const mark = done ? "✓" : ids.includes(id) ? "✅" : "⬜";
    rows.push([{ text: `${mark} ${a ? a.name : "⚠️ уже не в бренді"}${a?.main ? " (основн.)" : ""}${done ? " - вийшло" : ""}`.slice(0, 60), data: `cat:${postId}:${net}:${id.slice(-8)}` }]);
  }
  // 📣 ще один канал чи група в бренд - прямо звідси (переслати пост каналу чи @назва)
  if (net === "telegram") rows.push([{ text: "＋ Додати канал чи групу", data: `cad:${postId}` }]);
  rows.push([{ text: "‹ Назад", data: `cc:${postId}` }]);
  const what = net === "telegram" ? "канали й групи" : net === "facebook" ? "Сторінки" : net === "instagram" ? "акаунти Instagram" : "профілі Threads";
  const tgNote = net === "telegram" ? (list.length > 1 ? "Типово пост іде в основні канал і групу." : "Зараз у бренді один канал - «＋ Додати» ще один, і тут з'явиться вибір.") : "";
  return { text: `👥 **${niceNet(net)}** - куди цей пост?

Позначені - отримають пост (кожен окремою публікацією зі своєю статистикою). Можна кілька одразу. ${what === "Сторінки" ? "Instagram обирається окремо." : tgNote}`.trim() + (ids.length ? `

Зараз: ${ids.map((id) => accName(list, id)).join(" + ")}` : ""), buttons: rows };
}

/** Галочка акаунта. Вертає пояснення, якщо змінити не можна (опубліковано / останній). */
export async function toggleAccount(ws: string, postId: string, net: string, suffix: string): Promise<string> {
  const p = await loadPost(ws, postId);
  if (!p || !isAccNet(net)) return "Пост не знайдено";
  const ch = p.channels || {};
  const choices = await accountChoices(ws);
  const { list, ids } = picked(net, ch, choices);
  const id = [...list.map((a) => a.id), ...ids].find((x) => x.slice(-8) === suffix);
  if (!id) return "Цього акаунта вже нема - онови картку";
  let sel = [...ids];
  if (sel.includes(id)) {
    if ((await sentAccountKeys(ws, postId)).has(`${net}|${id}`)) return "Сюди вже опубліковано - лишається";
    if (sel.length === 1) return "Хоч один має лишитись. Щоб не публікувати в цю мережу, вимкни її в картці";
    sel = sel.filter((x) => x !== id);
  } else sel.push(id);
  // порядок - як у списку бренду; рівно «за замовчуванням» не памʼятаємо (зміниться основний - пост піде за ним)
  sel = [...list.map((a) => a.id).filter((x) => sel.includes(x)), ...sel.filter((x) => !list.some((a) => a.id === x))];
  const dflt = net === "telegram" ? list.filter((a) => a.main).map((a) => a.id) : [(list.find((a) => a.main) || list[0])?.id].filter(Boolean) as string[];
  const same = sel.length === dflt.length && sel.every((x) => dflt.includes(x));
  ch[net] = { ...(ch[net] && typeof ch[net] === "object" ? ch[net] : { on: true }) };
  delete ch[net].account;
  if (same) delete ch[net].accounts; else ch[net].accounts = sel;
  await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify(ch)]);
  return "";
}

// ---- 🎵 TikTok у боті: так само, як у композері, - «хто бачить» без типового значення, коментарі/Duet/
// Stitch вимкнені, поки людина їх не ввімкне (вимкнене в самому TikTok - не ввімкнути), реклама, згода ----
const on = (v: boolean) => (v ? "✅" : "⬜");
export async function tiktokCard(ws: string, postId: string): Promise<{ text: string; buttons: tg.TgButton[][] } | null> {
  const p = await loadPost(ws, postId);
  if (!p) return null;
  const ch = p.channels || {};
  const t = ttOpts(ch.tiktok);
  let info: Awaited<ReturnType<typeof ttCreator>> | null = null, err = "";
  try { info = await ttCreator(ws); } catch (e: any) { err = String(e?.message || e).slice(0, 200); }
  const tc = await one<{ scopes: string | null }>(`select scopes from tiktok_config where workspace_id=$1`, [ws]);
  const direct = !!tc && canDirect(tc.scopes) && !err;
  const rows: tg.TgButton[][] = [];
  rows.push([{ text: `${t.mode === "draft" || !direct ? "🔘" : "⚪"} У чернетки TikTok`, data: `ctt:${postId}:m:draft` },
             ...(direct ? [{ text: `${t.mode === "direct" ? "🔘" : "⚪"} Одразу`, data: `ctt:${postId}:m:direct` }] : [])]);
  if (direct && t.mode === "direct") {
    const opts = info?.privacyOptions.length ? info.privacyOptions : Object.keys(PRIVACY_UA);
    for (let i = 0; i < opts.length; i += 2)
      rows.push(opts.slice(i, i + 2).map((o) => ({ text: `${t.privacy === o ? "🔘" : "⚪"} ${PRIVACY_UA[o] || o}${t.branded && o === "SELF_ONLY" ? " 🚫" : ""}`, data: `ctt:${postId}:p:${o}` })));
    rows.push([
      { text: `${info?.commentDisabled ? "🚫" : on(t.comment)} Коментарі`, data: `ctt:${postId}:t:comment` },
      { text: `${info?.duetDisabled ? "🚫" : on(t.duet)} Duet`, data: `ctt:${postId}:t:duet` },
      { text: `${info?.stitchDisabled ? "🚫" : on(t.stitch)} Stitch`, data: `ctt:${postId}:t:stitch` },
    ]);
    // брендований контент не буває «Лише я»: при «Лише я» кнопка сіра (🚫), як вимагає TikTok
    rows.push([{ text: `${on(t.yourBrand)} Реклама мого бренду`, data: `ctt:${postId}:t:your_brand` }, { text: `${t.privacy === "SELF_ONLY" ? "🚫" : on(t.branded)} Співпраця з брендом`, data: `ctt:${postId}:t:branded` }]);
    rows.push([{ text: `${on(t.ai)} Створено з AI`, data: `ctt:${postId}:t:ai` }]);
  }
  rows.push([{ text: "‹ Назад", data: `cc:${postId}` }]);
  const who = info ? `${info.nickname || "TikTok"}${info.username ? ` (@${info.username})` : ""}` : "";
  const text = [
    `🎵 **TikTok**${who ? ` · публікує ${who}` : ""}`,
    err ? `⚠️ ${err}` : "",
    !direct && !err ? "Пряма публікація для Holos у TikTok ще не ввімкнена - відео піде в чернетки TikTok, і ти опублікуєш його в застосунку." : "",
    t.mode === "draft" || !direct
      ? "📥 Відео прийде в TikTok чернеткою: там обереш, хто бачить, і натиснеш «Опублікувати». Підпис TikTok у чернетку не переносить - після публікації я надішлю його тобі окремим повідомленням, щоб скопіювати."
      : [`Хто бачить: ${t.privacy ? PRIVACY_UA[t.privacy] : "не обрано - обери (TikTok не дозволяє обирати це за тебе)"}`,
         "🚫 - вимкнено в налаштуваннях твого TikTok (а співпраця з брендом - коли обрано «Лише я»: так TikTok не дозволяє).",
         t.branded ? "TikTok позначить відео як «Paid partnership»." : t.yourBrand ? "TikTok позначить відео як «Promotional content»." : "",
         (info?.maxDurationSec ? `Найдовше відео для цього акаунта - ${Math.round(info.maxDurationSec / 60) || 1} хв.` : ""),
         `Публікуючи, ти погоджуєшся з Music Usage Confirmation TikTok${t.branded ? " і Branded Content Policy" : ""}. Після публікації TikTok обробляє відео кілька хвилин.`].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n\n");
  return { text, buttons: rows };
}
/** Дія з картки TikTok. Вертає пояснення, якщо так не можна. */
export async function tiktokAction(ws: string, postId: string, action: string): Promise<string> {
  const p = await loadPost(ws, postId); if (!p) return "Пост не знайдено";
  const ch = p.channels || {};
  const t: any = { ...(ch.tiktok && typeof ch.tiktok === "object" ? ch.tiktok : { on: true }) };
  const [kind, val] = [action.slice(0, 1), action.slice(2)];
  let info: Awaited<ReturnType<typeof ttCreator>> | null = null;
  try { info = await ttCreator(ws); } catch { info = null; }
  if (kind === "m") t.mode = val === "direct" ? "direct" : "draft";
  else if (kind === "p") {
    if (!(PRIVACY_UA as Record<string, string>)[val]) return "Невідомий варіант";
    if (info?.privacyOptions.length && !info.privacyOptions.includes(val)) return "Для цього акаунта TikTok такий варіант недоступний";
    if (t.branded && val === "SELF_ONLY") return "Співпраця з брендом не може бути видно «Лише мені»";
    t.privacy = val; t.mode = "direct";
  } else if (kind === "t") {
    const key = ({ comment: "comment", duet: "duet", stitch: "stitch", your_brand: "your_brand", branded: "branded", ai: "ai" } as Record<string, string>)[val];
    if (!key) return "Невідома дія";
    if ((key === "comment" && info?.commentDisabled) || (key === "duet" && info?.duetDisabled) || (key === "stitch" && info?.stitchDisabled))
      return "Це вимкнено в налаштуваннях твого TikTok - увімкнути можна лише там";
    if (key === "branded" && t.branded !== true && t.privacy === "SELF_ONLY") return "Брендований контент не може бути видно «Лише мені» - спершу обери інше «Хто бачить»";
    t[key] = !(t[key] === true);
  } else return "Невідома дія";
  await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify({ ...ch, tiktok: t })]);
  return "";
}
// ---- ▶️ YouTube у боті: хто бачить, «для дітей», позначка AI ----
export async function youtubeCard(ws: string, postId: string): Promise<{ text: string; buttons: tg.TgButton[][] } | null> {
  const p = await loadPost(ws, postId); if (!p) return null;
  const y = ytOpts((p.channels || {}).youtube);
  const rows: tg.TgButton[][] = [
    (["public", "unlisted", "private"] as const).map((v) => ({ text: `${y.privacy === v ? "🔘" : "⚪"} ${YT_PRIVACY_UA[v]}`, data: `cyt:${postId}:p:${v}` })),
    [{ text: `Для дітей: ${y.kids ? "так" : "ні"} ↺`, data: `cyt:${postId}:t:kids` }, { text: `${on(y.ai)} Позначка AI`, data: `cyt:${postId}:t:ai` }],
    [{ text: "‹ Назад", data: `cc:${postId}` }],
  ];
  const title = y.title || titleFrom(p.channels?.youtube?.text || p.content) || "перший рядок тексту";
  return { text: `▶️ **YouTube**\n\nНазва: «${title}» (змінити назву - у кабінеті)\nХто бачить: ${YT_PRIVACY_UA[y.privacy]}\nДля дітей: ${y.kids ? "так" : "ні"} (вимога YouTube: «так» вимикає коментарі й персональну рекламу)\nПозначка «змінений чи синтетичний вміст» (AI-голос, згенеровані обличчя): ${y.ai ? "так" : "ні"}\n\nВертикальне відео до 3 хв YouTube сам покаже як Shorts.`, buttons: rows };
}
export async function youtubeAction(ws: string, postId: string, action: string): Promise<void> {
  const p = await loadPost(ws, postId); if (!p) return;
  const ch = p.channels || {};
  const y: any = { ...(ch.youtube && typeof ch.youtube === "object" ? ch.youtube : { on: true }) };
  const [kind, val] = [action.slice(0, 1), action.slice(2)];
  if (kind === "p" && ["public", "unlisted", "private"].includes(val)) y.privacy = val;
  else if (kind === "t" && val === "kids") y.kids = !(y.kids === true);
  else if (kind === "t" && val === "ai") y.ai = !(y.ai === true);
  else return;
  await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify({ ...ch, youtube: y })]);
}

// «затверджено» - той самий прапорець `review`, що в Студії й Mini App: пост, схвалений з телефона,
// має рахуватись схваленим і в кабінеті, інакше це два різні поняття з однією назвою
export async function toggleApprove(ws: string, postId: string): Promise<string> {
  const p = await loadPost(ws, postId); if (!p) throw new Error("пост не знайдено");
  const on = p.review !== "approved";
  await q(`update post set review=$2 where id=$1`, [postId, on ? "approved" : "review"]);
  if (on) approvedNotice(ws, postId, p.review, actorId()).catch(() => {});   // 👥 автор чекав рішення
  // незатверджений пост не має лишатись у календарі: автопостер відправив би його в мережу
  const gone = on ? 0 : await unschedulePost(postId);
  return on ? "✅ Затверджено" : `↩ Вернуто в чернетки${gone ? " і знято з розкладу" : ""}`;
}

const niceNet = (k: string) => (NETS.find((n) => n[0] === k) || [k, k])[1];

// ---- дії ----
/** Мережі, куди цей пост може піти з того, що підключено: сторіс - Instagram, Facebook, профіль Telegram і WhatsApp-статус, відео - усі (з
 * YouTube і TikTok), фото й текст - усі, крім YouTube і TikTok. Уже надіслані не пропонуємо. */
export async function allNetsFor(ws: string, postId: string): Promise<string[]> {
  const p = await loadPost(ws, postId); if (!p) return [];
  const list = await postMediaList(postId);
  const video = list.length === 1 && list[0].kind === "video";
  const conn = await connectedNets(ws, { video, story: p.format === "story" });
  const sent = new Set(await alreadySentNetworks(postId));
  return conn.filter((k) => !sent.has(k));
}
export async function allNetsOn(ws: string, postId: string): Promise<string[]> {
  const p = await loadPost(ws, postId); if (!p) return [];
  const ch = p.channels || {};
  const add = (await allNetsFor(ws, postId)).filter((k) => !(ch[k] && ch[k].on));
  for (const k of add) ch[k] = { ...(ch[k] && typeof ch[k] === "object" ? ch[k] : {}), on: true };
  if (add.length) await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify(ch)]);
  return add;
}

export async function toggleNet(ws: string, postId: string, net: string): Promise<void> {
  const p = await loadPost(ws, postId); if (!p) return;
  const ch = p.channels || {};
  ch[net] = { ...(ch[net] || {}), on: !(ch[net] && ch[net].on) };
  if (!ch[net].on) delete ch[net].text; // вимкнули мережу - її окрема версія тексту більше не потрібна
  await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify(ch)]);
}

export async function setText(ws: string, postId: string, text: string): Promise<void> {
  await q(`update post set content=$2 where id=$1 and id in (
             select p.id from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
             where p.id=$1 and s.workspace_id=$3)`, [postId, text.trim(), ws]);
  await masterChanged(ws, postId, text.trim());
}

// Майстер-текст змінили в боті: версії під мережі, зроблені зі СТАРОГО тексту, більше не правда - інакше
// після правки в мережу, де вже була своя версія, пішов би текст до правки. Для ще не надісланих мереж
// скидаємо їх (публікація спакує заново); текст, написаний під одну мережу (native), оновлюємо дослівно.
export async function masterChanged(ws: string, postId: string, text: string): Promise<void> {
  const p = await loadPost(ws, postId); if (!p) return;
  const ch = p.channels || {};
  const sent = new Set(await alreadySentNetworks(postId));
  let changed = false;
  for (const k of PUB_NETS) {
    if (!ch[k] || sent.has(k)) continue;
    if (ch.manual_adapt && ch.native === k) { ch[k] = { ...ch[k], text }; changed = true; }
    else if (ch[k].text) { delete ch[k].text; changed = true; }
  }
  if (ch.manual_adapt && !ch.native) { delete ch.manual_adapt; changed = true; }
  if (changed) await q(`update post set channels=$2 where id=$1`, [postId, JSON.stringify(ch)]);
}

export async function attachPhoto(ws: string, postId: string, buffer: Buffer, mime: string, name: string): Promise<void> {
  if (!(await loadPost(ws, postId))) throw new Error("пост не знайдено");
  const m = await saveMedia(ws, { buffer, mime, name, source: "bot" });
  await q(`update post set media_id=$2 where id=$1`, [postId, m.id]);
}

// 🖼 перше фото альбому: фото поста замінюються альбомом, обкладинка - кроп 4:5 (найбільше місця в
// стрічці й валідна пропорція для всіх мереж; решта кадрів ріжеться під неї)
export async function setAlbumCover(ws: string, postId: string, buffer: Buffer): Promise<void> {
  const m = await saveMedia(ws, { buffer, mime: "image/jpeg", name: "tg-post.jpg", source: "bot" });
  await setPostMediaOrder(ws, postId, []);
  await appendCroppedSlide(ws, postId, m.id, "4:5");
}

// 🎬 відео, надіслане боту: замінює фото поста (відео публікується окремим постом)
export async function attachVideo(ws: string, postId: string, buffer: Buffer, name: string): Promise<void> {
  const m = await saveMedia(ws, { buffer, mime: "video/mp4", name, source: "bot", dedupe: true });
  if (m.kind !== "video") throw new Error("це не відео - приймаю MP4, MOV, WebM");
  await setPostVideo(ws, postId, m.id);
}

// 🖼 кадр каруселі з альбому: у кінець, у пропорції обкладинки (до 10 кадрів - решту відкидаємо)
export async function appendPhoto(ws: string, postId: string, buffer: Buffer, mime: string, name: string): Promise<void> {
  if ((await postMediaList(postId)).length >= MAX_SLIDES) return;
  const m = await saveMedia(ws, { buffer, mime, name, source: "bot" });
  await appendCroppedSlide(ws, postId, m.id);
}

export async function aiRewrite(ws: string, postId: string, instruction?: string): Promise<string> {
  const p = await loadPost(ws, postId); if (!p) throw new Error("пост не знайдено");
  const fresh = await rewritePost(ws, p.content, instruction);
  await q(`update post set content=$2 where id=$1`, [postId, fresh]);
  await masterChanged(ws, postId, fresh);
  return fresh;
}

// Публікація: та сама точка, що й у кабінеті (composer/автопостер), тож дедуп «раз на мережу»,
// авто-паковка під мережі й запис permalink працюють однаково.
export async function publishNow(ws: string, postId: string): Promise<string> {
  const p = await loadPost(ws, postId); if (!p) throw new Error("пост не знайдено");
  const nets = enabledNets(p.channels);
  if (!nets.length) return "⚠️ Спершу обери хоч один канал.";
  const res = await publishPostToChannels(ws, postId);
  // кілька акаунтів мережі в пості (дві Сторінки, два канали) - результат називає кожен
  const lbl = (r: PubResult) => niceNet(r.channel) + (r.accountName ? ` (${r.accountName})` : "");
  const ok = res.filter((r) => r.status === "sent").map(lbl);
  const skip = res.filter((r) => r.status === "skipped").map(lbl);
  const err = res.filter((r) => r.status === "error");
  const notes = res.filter((r) => r.note).map((r) => `${lbl(r)}: ${r.note}`);
  // погасити запланований слот, якщо публікуємо руками раніше часу - але лише коли вийшло в УСІ
  // обрані мережі: збій «зараз» не має тихо скасовувати завтрашню публікацію
  await closeSlotsIfDone(postId, "опубліковано з бота");
  let out = ok.length ? `✅ Опубліковано: ${ok.join(", ")}` : "";
  if (skip.length) out += `${out ? "\n" : ""}↩️ Пропущено (вже публікувалось): ${skip.join(", ")}`;
  if (err.length) out += `${out ? "\n" : ""}⚠️ Не вийшло: ${err.map((e) => `${lbl(e)} - ${e.error}`).join("; ")}`;
  if (notes.length) out += `${out ? "\n" : ""}ℹ️ ${notes.join("; ")}`;
  // 🎵 чернетка TikTok: підпис туди не переноситься - даємо його окремим блоком, щоб скопіювати
  const ttDraft = res.some((r) => r.channel === "tiktok" && r.status === "sent" && /чернетк/.test(r.note || ""));
  if (ttDraft) out += `\n\n📋 Підпис для TikTok (скопіюй і встав у чернетку):\n${String((p.channels?.tiktok?.text) || p.content).trim().slice(0, 2200)}`;
  return out || "Нічого не відправлено.";
}

export async function schedule(ws: string, postId: string, at: Date): Promise<string> {
  if (at.getTime() < Date.now() - 60000) return "⚠️ Цей час уже минув - обери майбутній.";
  const p = await loadPost(ws, postId); if (!p) throw new Error("пост не знайдено");
  const nets = enabledNets(p.channels);
  if (!nets.length) return "⚠️ Спершу обери хоч один канал.";
  // переносимо наявний слот замість другого INSERT - інакше пост вийшов би двічі
  const ex = await one<{ id: string }>(`select id from schedule_slot where post_id=$1 and status='planned' limit 1`, [postId]);
  if (ex) await q(`update schedule_slot set scheduled_at=$2, retry_at=null, attempts=0, updated_at=now() where id=$1`, [ex.id, at.toISOString()]);
  // ⚠️ у schedule_slot НЕМА workspace_id (воркспейс визначається через post → run → source) -
  // insert із ним падав би в рантаймі, а tsc такого не бачить. Той самий набір колонок, що в /api/schedule.
  else await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [postId, at.toISOString()]);
  await q(`update post set review='approved' where id=$1`, [postId]); // запланований = затверджений
  approvedNotice(ws, postId, p.review, actorId()).catch(() => {});
  const tz = await wsTz(ws);
  const when = new Intl.DateTimeFormat("uk-UA", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at);
  await logEvent("info", "tgbot", `заплановано з бота на ${when}`, null);
  return `🗓 Заплановано на ${when} (${nets.map(niceNet).join(", ")}).\nАвтопостер відправить сам.`;
}

// ---- вибір часу: 4 типові слоти + своя дата ----
export async function whenButtons(ws: string, postId: string): Promise<{ text: string; buttons: tg.TgButton[][] }> {
  const n = await nowParts(ws);
  const mk = (dayShift: number, hh: number) => {
    const base = zonedToUtc(n.y, n.mo, n.d + dayShift, hh, 0, n.tz);
    return { at: base, label: `${dayShift === 0 ? "Сьогодні" : "Завтра"} ${String(hh).padStart(2, "0")}:00` };
  };
  const opts = [
    ...(n.hh < 17 ? [mk(0, 18)] : []),          // «сьогодні 18:00» пропонуємо, лише поки воно попереду
    ...(n.hh < 11 ? [mk(0, 12)] : []),
    mk(1, 9), mk(1, 12), mk(1, 18),
  ];
  const rows: tg.TgButton[][] = [];
  for (let i = 0; i < opts.length; i += 2)
    rows.push(opts.slice(i, i + 2).map((o) => ({ text: o.label, data: `cw:${postId}:${o.at.getTime()}` })));
  rows.push([{ text: "✏️ Своя дата й час", data: `cwx:${postId}` }]);
  rows.push([{ text: "‹ Назад", data: `cc:${postId}` }]);
  return { text: "🗓 Коли опублікувати?", buttons: rows };
}

// Розбір ручного вводу дати: «01.08 14:30», «2026-08-01 14:30», «завтра 14:30», «14:30» (сьогодні).
// Свідомо приймаємо кілька форматів - у чаті людина пише як звикла, а не як зручно парсеру.
export async function parseWhen(ws: string, raw: string): Promise<Date | null> {
  return parseWhenAt(raw, await nowParts(ws));
}
// чиста частина (без БД) - саме її покривають юніти: «14:30» не має читатись як дата,
// «01.08 14:30» не має переплутати день з місяцем, «завтра» має рахуватись від локальної дати
export function parseWhenAt(raw: string, n: { y: number; mo: number; d: number; tz: string }): Date | null {
  const s = raw.trim().toLowerCase();
  // Час - ЛИШЕ через двокрапку. Крапка тут неоднозначна: «01.08» це і 1 серпня, і 01:08, і вгадувати
  // тут дорого (вгадаємо часом - людина отримає пост не того дня). Краще перепитати з прикладами.
  const time = s.match(/(\d{1,2}):(\d{2})/);
  if (!time) return null;
  const hh = +time[1], mi = +time[2];
  if (hh > 23 || mi > 59) return null;
  let y = n.y, mo = n.mo, d = n.d;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  const dmy = s.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; }
  else if (/завтра/.test(s)) { d = n.d + 1; }
  else if (dmy && dmy.index !== time.index) {   // «14:30» саме по собі не є датою - не плутаємо
    d = +dmy[1]; mo = +dmy[2];
    if (dmy[3]) y = dmy[3].length === 2 ? 2000 + +dmy[3] : +dmy[3];
  }
  const at = zonedToUtc(y, mo, d, hh, mi, n.tz);
  return isNaN(at.getTime()) ? null : at;
}

// ---- стан очікування наступного повідомлення ----
export async function expect(ws: string, postId: string, what: Await, chat: string): Promise<void> {
  await setCompose(ws, { postId, await: what, chat, at: Date.now() });
}
export async function stopExpecting(ws: string): Promise<void> {
  const st = await getCompose(ws);
  await setCompose(ws, { ...st, await: null });
}
