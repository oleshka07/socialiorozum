// 📝 Композер у Telegram: написати пост із DM, дати йому фото, поправити текст, обрати мережі
// й опублікувати одразу або за розкладом - не заходячи в кабінет.
//
// Навіщо окремий файл: tgbot.ts уже великий, а це самодостатній сценарій зі своїм станом.
//
// СТАН. Розмова в Telegram не має «форми» - бот мусить памʼятати, чого він зараз чекає від
// наступного повідомлення (тексту? фото? дати?). Тримаємо це в settings_block під ключем
// `tg_compose`: {postId, await, chat}. Один активний чернетковий пост на воркспейс - цього
// достатньо (власник один) і не потребує нової таблиці.
import { q, one } from "./db.js";
import * as tg from "./telegram.js";
import { getSetting, setSetting } from "./settings.js";
import { saveMedia } from "./media.js";
import { publishPostToChannels } from "./publisher.js";
import { rewritePost } from "./pipeline.js";
import { logEvent } from "./log.js";

const KEY = "tg_compose";
type Await = null | "text" | "photo" | "when" | "rewrite";
type ComposeState = { postId: string | null; await: Await; chat: string | null };
const EMPTY: ComposeState = { postId: null, await: null, chat: null };

export const getCompose = (ws: string) => getSetting<ComposeState>(ws, KEY, EMPTY);
const setCompose = (ws: string, st: ComposeState) => setSetting(ws, KEY, st);
export const clearCompose = (ws: string) => setSetting(ws, KEY, EMPTY);

// мережі, які реально підключені: показувати кнопку каналу, якого нема, - це обіцянка, яку
// публікація не виконає
const NETS: Array<[string, string]> = [
  ["telegram", "✈️ Telegram"], ["instagram", "📸 Instagram"], ["facebook", "📘 Facebook"],
  ["threads", "🧵 Threads"], ["linkedin", "💼 LinkedIn"],
];
export async function connectedNets(ws: string): Promise<string[]> {
  const [t, th, m, li] = await Promise.all([
    one<{ n: number }>(`select count(*)::int n from telegram_config where workspace_id=$1 and bot_token is not null and (channel_chat_id is not null or group_chat_id is not null)`, [ws]),
    one<{ n: number }>(`select count(*)::int n from threads_config where workspace_id=$1 and access_token is not null`, [ws]),
    one<{ page_id: string | null; ig_user_id: string | null }>(`select page_id, ig_user_id from meta_config where workspace_id=$1`, [ws]),
    one<{ n: number }>(`select count(*)::int n from linkedin_config where workspace_id=$1 and access_token is not null`, [ws]),
  ]);
  const out: string[] = [];
  if ((t?.n || 0) > 0) out.push("telegram");
  if (m?.ig_user_id) out.push("instagram");
  if (m?.page_id) out.push("facebook");
  if ((th?.n || 0) > 0) out.push("threads");
  if ((li?.n || 0) > 0) out.push("linkedin");
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
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(guess))) if (part.type !== "literal") p[part.type] = part.value;
  const asLocal = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return new Date(guess - (asLocal - guess));
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
    `insert into post(run_id, stage, content, channels) values($1,'final',$2,$3) returning id`,
    [run!.id, body, JSON.stringify(ch)]);
  return p!.id;
}

type PostRow = { id: string; content: string; channels: any; filename: string | null; review: string | null };
async function loadPost(ws: string, postId: string): Promise<PostRow | null> {
  return one<PostRow>(
    `select p.id, p.content, p.channels, p.review, ma.filename from post p
       join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       left join media_asset ma on ma.id=p.media_id
     where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
}

// ---- картка поста: що зараз є + що можна зробити ----
export async function composeCard(ws: string, postId: string): Promise<{ text: string; buttons: tg.TgButton[][] } | null> {
  const p = await loadPost(ws, postId);
  if (!p) return null;
  const ch = p.channels || {};
  const nets = await connectedNets(ws);
  const chosen = nets.filter((k) => ch[k] && ch[k].on);
  const slot = await one<{ scheduled_at: string }>(
    `select scheduled_at from schedule_slot where post_id=$1 and status='planned' order by scheduled_at limit 1`, [postId]);
  const tz = await wsTz(ws);
  const when = slot ? new Intl.DateTimeFormat("uk-UA", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(slot.scheduled_at)) : "";

  const body = p.content.length > 600 ? p.content.slice(0, 600) + "…" : p.content;
  const text = `📝 <b>${p.review === "approved" ? "Затверджено" : "Чернетка"}</b>\n\n${esc(body)}\n\n`
    + `🖼 Фото: ${p.filename ? "є" : "нема"}\n`
    + `📢 Канали: ${chosen.length ? chosen.map(niceNet).join(", ") : "не обрано"}`
    + (when ? `\n🗓 Заплановано: ${when}` : "");

  // ряд каналів: тумблери ✅/⬜ по 2 в рядок, щоб кнопки лишались читабельними на телефоні
  const rows: tg.TgButton[][] = [];
  for (let i = 0; i < nets.length; i += 2) {
    rows.push(nets.slice(i, i + 2).map((k) => ({
      text: `${ch[k] && ch[k].on ? "✅" : "⬜"} ${niceNet(k)}`, data: `cn:${postId}:${k}`,
    })));
  }
  rows.push([{ text: p.filename ? "🖼 Змінити фото" : "🖼 Додати фото", data: `cp:${postId}` },
             { text: "✍ Текст", data: `ce:${postId}` }]);
  rows.push([{ text: "🤖 Переписати (AI)", data: `cr:${postId}` },
             { text: p.review === "approved" ? "↩ У чернетки" : "✅ Затвердити", data: `ca:${postId}` }]);
  rows.push([{ text: "🚀 Опублікувати", data: `cgo:${postId}` }, { text: "🗓 Запланувати", data: `cs:${postId}` }]);
  return { text, buttons: rows };
}

// «затверджено» - той самий прапорець `review`, що в Студії й Mini App: пост, схвалений з телефона,
// має рахуватись схваленим і в кабінеті, інакше це два різні поняття з однією назвою
export async function toggleApprove(ws: string, postId: string): Promise<string> {
  const p = await loadPost(ws, postId); if (!p) throw new Error("пост не знайдено");
  const on = p.review !== "approved";
  await q(`update post set review=$2 where id=$1`, [postId, on ? "approved" : "review"]);
  return on ? "✅ Затверджено" : "↩ Вернуто в чернетки";
}

const niceNet = (k: string) => (NETS.find((n) => n[0] === k) || [k, k])[1];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- дії ----
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
}

export async function attachPhoto(ws: string, postId: string, buffer: Buffer, mime: string, name: string): Promise<void> {
  const m = await saveMedia(ws, { buffer, mime, name, source: "bot" });
  await q(`update post set media_id=$2 where id=$1`, [postId, m.id]);
}

export async function aiRewrite(ws: string, postId: string, instruction?: string): Promise<string> {
  const p = await loadPost(ws, postId); if (!p) throw new Error("пост не знайдено");
  const fresh = await rewritePost(ws, p.content, instruction);
  await q(`update post set content=$2 where id=$1`, [postId, fresh]);
  return fresh;
}

// Публікація: та сама точка, що й у кабінеті (composer/автопостер), тож дедуп «раз на мережу»,
// авто-паковка під мережі й запис permalink працюють однаково.
export async function publishNow(ws: string, postId: string): Promise<string> {
  const p = await loadPost(ws, postId); if (!p) throw new Error("пост не знайдено");
  const nets = Object.keys(p.channels || {}).filter((k) => p.channels[k] && p.channels[k].on);
  if (!nets.length) return "⚠️ Спершу обери хоч один канал.";
  const res = await publishPostToChannels(ws, postId);
  const ok = res.filter((r) => r.status === "sent").map((r) => niceNet(r.channel));
  const skip = res.filter((r) => r.status === "skipped").map((r) => niceNet(r.channel));
  const err = res.filter((r) => r.status === "error");
  // погасити запланований слот, якщо публікуємо руками раніше часу
  await q(`update schedule_slot set status='posted', result='опубліковано з бота' where post_id=$1 and status='planned'`, [postId]);
  let out = ok.length ? `✅ Опубліковано: ${ok.join(", ")}` : "";
  if (skip.length) out += `${out ? "\n" : ""}↩️ Пропущено (вже публікувалось): ${skip.join(", ")}`;
  if (err.length) out += `${out ? "\n" : ""}⚠️ Не вийшло: ${err.map((e) => `${niceNet(e.channel)} - ${e.error}`).join("; ")}`;
  return out || "Нічого не відправлено.";
}

export async function schedule(ws: string, postId: string, at: Date): Promise<string> {
  if (at.getTime() < Date.now() - 60000) return "⚠️ Цей час уже минув - обери майбутній.";
  const p = await loadPost(ws, postId); if (!p) throw new Error("пост не знайдено");
  const nets = Object.keys(p.channels || {}).filter((k) => p.channels[k] && p.channels[k].on);
  if (!nets.length) return "⚠️ Спершу обери хоч один канал.";
  // переносимо наявний слот замість другого INSERT - інакше пост вийшов би двічі
  const ex = await one<{ id: string }>(`select id from schedule_slot where post_id=$1 and status='planned' limit 1`, [postId]);
  if (ex) await q(`update schedule_slot set scheduled_at=$2, updated_at=now() where id=$1`, [ex.id, at.toISOString()]);
  // ⚠️ у schedule_slot НЕМА workspace_id (воркспейс визначається через post → run → source) -
  // insert із ним падав би в рантаймі, а tsc такого не бачить. Той самий набір колонок, що в /api/schedule.
  else await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [postId, at.toISOString()]);
  await q(`update post set review='approved' where id=$1`, [postId]); // запланований = затверджений
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
  await setCompose(ws, { postId, await: what, chat });
}
export async function stopExpecting(ws: string): Promise<void> {
  const st = await getCompose(ws);
  await setCompose(ws, { ...st, await: null });
}
