// 🎬 Монтаж у Telegram-боті: людина шле кліпи з телефона (і голосове або текст), бот склеює сторіс чи
// рілс із субтитрами, надсилає готове відео назад і відкриває картку поста - опублікувати чи запланувати.
//
// Чому бот, а не чат Claude: відео з телефона найпростіше переслати в Telegram (галерея → поділитись),
// а конектор Claude файлів із чату не отримує. Межа Telegram для ботів - 20 МБ на файл; більше - через
// Mini App («🚀 Кабінет») чи кабінет, а змонтувати їх можна звідти ж або з Claude.
//
// Стан сесії - у settings_block.montage_state (одна людина на кабінет): що вже надіслано й як монтувати.
// Сесія живе 3 години від останньої дії; поки вона відкрита, відео й голосові йдуть у монтаж, а не в
// щоденник.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { q, one } from "./db.js";
import * as tg from "./telegram.js";
import { saveMedia, MEDIA_DIR } from "./media.js";
import { connectedNets } from "./tgcompose.js";
import { liveSend } from "./tgbot.js";
import { startMontage, MONTAGE_MAX_CLIPS, montageStyle, brandEndText, type MontageOpts, type MontageResult } from "./montage.js";
import { ttsReady } from "./tts.js";
import { getJob } from "./jobs.js";
import { spreadText, MAX_SLOW, TRANSITIONS, MUSIC_MOODS, TEMPLATES, TEMPLATE_ORDER, SUB_PRESETS, SUB_ORDER, templatePlan, baSplit, cleanHook, type TransitionMode, type MusicMood, type TemplateId, type SubPreset, type EndText } from "./montage-plan.js";
import { musicReady } from "./tts.js";
import { plural } from "./analytics.js";
import { brandLabel, moveMedia } from "./tgbrand.js";

export type MtMode = "auto" | "captions" | "ai-voice";
export type MtState = {
  chat: string;
  // mid - message_id повідомлення з кліпом: за ним тримається порядок (альбом доходить не по порядку)
  clips: Array<{ id: string; kind: "video" | "image"; dur: number; mid?: number }>;
  // file - прийшов аудіофайлом (а не голосовим): такий можна перемкнути в музику
  voice: { id: string; dur: number; file?: boolean; name?: string } | null;
  script: string | null;
  mode: MtMode;
  format: "story" | "reel";
  at: number;
  job?: string | null;
  transition?: TransitionMode;                          // ✨ переходи (типово плавні)
  music?: { id: string; name: string; dur: number } | null;   // 🎵 свій трек
  mood?: MusicMood | null;                              // 🎵 або AI-музика під настрій
  ownMusic?: { id: string; name: string; dur: number } | null; // надісланий трек, поки обрано інше (щоб «▸» міг повернутись)
  // 🎬 v3 (початкові значення - зі стилю відео бренду, картка показує саме те, що буде)
  template?: TemplateId;
  hook?: string;              // "auto" - AI з тексту ролика, "off" - без, інше - свій текст («гачок: …»)
  ownHook?: string | null;    // свій гачок, поки обрано «AI» чи «без» (щоб «▸» міг до нього повернутись)
  end?: boolean;              // 🏁 фінальна картка
  cut?: boolean;              // ✂️ вирізати паузи й «еее» (коли текст - зі звуку кліпів)
  sub?: SubPreset;            // 🔤 стиль субтитрів
  before?: number | null;     // ↔️ скільки перших кліпів - «до»
};
const TTL = 3 * 3600_000;
const TEXT_WINDOW = 30 * 60_000;

export async function getMt(ws: string): Promise<MtState | null> {
  const r = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='montage_state'`, [ws]);
  if (!r?.content) return null;
  try {
    const st = JSON.parse(r.content) as MtState;
    return st && Date.now() - Number(st.at || 0) < TTL ? st : null;
  } catch { return null; }
}
async function saveMt(ws: string, st: MtState): Promise<void> {
  st.at = Date.now();
  await q(`insert into settings_block(workspace_id, key, content) values($1,'montage_state',$2)
           on conflict (workspace_id, key) do update set content=excluded.content, updated_at=now()`, [ws, JSON.stringify(st)]);
}
export async function clearMt(ws: string): Promise<void> {
  await q(`delete from settings_block where workspace_id=$1 and key='montage_state'`, [ws]);
}

// Одна дія із сесією за раз на кабінет. 29.09 Олег надіслав 2 відео альбомом: Telegram доставив їх
// одночасно, обидва обробники прочитали сесію без кліпів, і другий запис затер перший - у монтаж
// пішов один кліп. Тепер повідомлення й кнопки сесії йдуть чергою (застосунок - один процес), і кожне
// читає свіжий стан; «Змонтувати» чекає, поки кліпи, що вже прийшли, додадуться.
const mtChains = new Map<string, Promise<unknown>>();
export function mtLocked<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  const run = (mtChains.get(ws) || Promise.resolve()).catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  mtChains.set(ws, tail);
  void tail.then(() => { if (mtChains.get(ws) === tail) mtChains.delete(ws); });
  return run;
}

const dur = (s: number) => { const n = Math.round(s || 0); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; };

/** Що вийде при «Змонтувати» - людськими словами (картка показує це ДО монтажу). */
export function mtTextPlan(st: MtState, tts: boolean): string {
  if (st.voice) return `🎙 Озвучка - твоє голосове (${dur(st.voice.dur)}), субтитри слово в слово з нього.`;
  if (st.script) return tts ? `🗣 AI-голос прочитає твій текст, субтитри - під голос: «${st.script.slice(0, 80)}${st.script.length > 80 ? "…" : ""}»`
    : `📝 Твій текст стане підписами по кліпах (AI-голос не підключено): «${st.script.slice(0, 80)}${st.script.length > 80 ? "…" : ""}»`;
  if (st.mode === "ai-voice") return "🗣 AI напише озвучку з того, що в кадрі, і прочитає її голосом; субтитри - під голос.";
  if (st.mode === "captions") return "📝 AI напише короткі підписи з того, що в кадрі; звук кліпів лишається.";
  return "🔊 Якщо в кліпах говорять - субтитри з мови; якщо ні - AI підпише кадри.";
}

/** Голосове довше, ніж кліпи покривають навіть сповільнені - кажемо ДО монтажу, що вони підуть по колу. */
export function loopHint(st: MtState): string {
  if (!st.voice || !st.clips.length || st.clips.some((c) => c.kind === "image")) return "";
  const foot = st.clips.reduce((a, c) => a + c.dur, 0);
  if (foot * MAX_SLOW >= st.voice.dur) return "";
  return `🔁 Голосове (${dur(st.voice.dur)}) довше за відео (${dur(foot)}) - кліпи підуть по колу. Щоб без повторів, додай ще кліпи.`;
}

// ↔️ «ДО: кліпи 1-2 · ПІСЛЯ: 3-4»
export function baLine(st: MtState): string {
  const n = st.clips.length;
  if (n < 2) return "↔️ Для «до / після» потрібно щонайменше 2 кліпи: спершу «до», потім «після».";
  const b = baSplit(n, st.before);
  const span = (a: number, z: number) => (a === z ? `${a}` : `${a}-${z}`);
  return `↔️ ДО: ${b === 1 ? "кліп" : "кліпи"} ${span(1, b)} · ПІСЛЯ: ${n - b === 1 ? "кліп" : "кліпи"} ${span(b + 1, n)}`;
}
/** Звідки текст на відео - чи ріжуться паузи (лише коли текст - зі звуку самих кліпів). */
const clipsVoice = (st: MtState) => !st.voice && !st.script && st.mode === "auto";
function hookLabel(st: MtState): string {
  const h = st.hook || "auto";
  return h === "off" ? "без" : h === "auto" ? "AI з тексту ролика" : `«${h.slice(0, 40)}»`;
}

function mtCard(st: MtState, brand = "", endPreview: EndText | null = null): { text: string; buttons: tg.TgButton[][] } {
  const tts = ttsReady();
  const tpl = st.template || "standard";
  const total = st.clips.reduce((a, c) => a + (c.kind === "image" ? 3 : c.dur), 0);
  const list = st.clips.map((c, i) => `${i + 1}. ${c.kind === "image" ? "фото" : `відео ${dur(c.dur)}`}`).join(" · ");
  const text = [
    `🎬 **Монтаж** · ${st.format === "story" ? "⚡ сторіс (Instagram і Facebook, частини до 60 с)" : "🎞 рілс"}`,
    ...(brand ? [`🏢 Бренд: ${brand} (інший - /brand, сесія переїде разом)`] : []),
    st.clips.length ? `Кліпи (${st.clips.length}, ≈${dur(total)}): ${list}` : "Кліпів ще нема.",
    mtTextPlan(st, tts),
    ...(loopHint(st) ? [loopHint(st)] : []),
    `🧩 Шаблон: ${TEMPLATES[tpl].label.replace(/^\S+\s/, "")} - ${TEMPLATES[tpl].hint}`,
    ...(tpl === "before_after" ? [baLine(st)] : []),
    `🪝 Гачок: ${hookLabel(st)} · 🔤 Субтитри: ${SUB_PRESETS[st.sub || "classic"].label.toLowerCase()}`,
    `🏁 Фінальна картка: ${st.end === false ? "без" : endPreview ? [endPreview.title, endPreview.sub].filter(Boolean).join(" · ") : "нема що показати (назва й нік бренду - у Бренд → Візуал)"}`,
    ...(clipsVoice(st) && tpl !== "process" ? [`✂️ Паузи й «еее» в кліпах, де говорять: ${st.cut === false ? "лишаю" : "вирізаю"}`] : []),
    `✨ Переходи: ${tpl === "talking" && !st.transition ? "без (шаблон)" : TRANSITIONS[st.transition || templatePlan(tpl).transition]} · 🎵 Музика: ${musicLabel(st)}${!st.music && !st.mood && templatePlan(tpl).mood && musicReady() ? ` (до шаблону пасує ${MUSIC_MOODS[templatePlan(tpl).mood!].label.split(" ").slice(1).join(" ").toLowerCase()})` : ""}`,
    tpl === "talking" ? "🗣 Мова йде цілком, без обрізання." : "🎯 З кожного кліпу беру найкращий шматок: різкий, світлий, без трясіння.",
    "",
    st.clips.length
      ? "Ще відео (до 20 МБ) чи фото - надсилай. Голосове - стане озвучкою, mp3 - фоновою музикою, текст - словами для відео, «гачок: …» - своїм гачком. Готово - «✂️ Змонтувати»."
      : "Надсилай відео з галереї (до 20 МБ кожне) чи фото - по черзі або альбомом. Потім голосове (озвучка), mp3 (музика) або текст - і «✂️ Змонтувати».",
  ].join("\n");
  const fmt: tg.TgButton[] = [
    { text: st.format === "story" ? "⚡ Сторіс ✓" : "⚡ Сторіс", data: "mt:fmt:story" },
    { text: st.format === "reel" ? "🎞 Рілс ✓" : "🎞 Рілс", data: "mt:fmt:reel" },
  ];
  const modes: tg.TgButton[] = [{ text: st.mode === "captions" && !st.voice && !st.script ? "📝 Підписи з кадрів ✓" : "📝 Підписи з кадрів", data: "mt:mode:captions" }];
  if (tts) modes.push({ text: st.mode === "ai-voice" && !st.voice && !st.script ? "🗣 AI-голос ✓" : "🗣 AI-голос", data: "mt:mode:ai-voice" });
  const buttons: tg.TgButton[][] = [];
  if (st.clips.length) buttons.push([{ text: "✂️ Змонтувати", data: "mt:build" }]);
  buttons.push(fmt, modes);
  buttons.push([{ text: `🧩 ${TEMPLATES[tpl].label.replace(/^\S+\s/, "")} ▸`, data: "mt:tpl" }, { text: `🪝 Гачок: ${st.hook === "off" ? "без" : st.hook && st.hook !== "auto" ? "свій" : "AI"} ▸`, data: "mt:hook" }]);
  if (tpl === "before_after" && st.clips.length >= 3) buttons.push([{ text: `↔️ «До»: ${baSplit(st.clips.length, st.before)} ${plural(baSplit(st.clips.length, st.before), "кліп", "кліпи", "кліпів")} ▸`, data: "mt:ba" }]);
  buttons.push([{ text: `🔤 ${SUB_PRESETS[st.sub || "classic"].label} ▸`, data: "mt:sub" }, { text: st.end === false ? "🏁 Картка: без ▸" : "🏁 Картка: так ▸", data: "mt:end" }]);
  const row: tg.TgButton[] = [];
  if (clipsVoice(st) && tpl !== "process") row.push({ text: st.cut === false ? "✂️ Паузи: лишаю ▸" : "✂️ Паузи: вирізаю ▸", data: "mt:cut" });
  row.push({ text: `✨ ${tpl === "talking" && !st.transition ? "без переходів" : TRANSITIONS[st.transition || templatePlan(tpl).transition]} ▸`, data: "mt:tr" });
  buttons.push(row);
  buttons.push([{ text: `🎵 ${musicLabel(st)} ▸`, data: "mt:mus" }]);
  // аудіофайл розпізнано не так - одна кнопка міняє роль
  if (st.music) buttons.push([{ text: "🔁 Це голос, а не музика", data: "mt:swap" }]);
  else if (st.voice?.file) buttons.push([{ text: "🔁 Це музика, а не голос", data: "mt:swap" }]);
  const tail: tg.TgButton[] = [];
  if (st.voice || st.script) tail.push({ text: st.voice ? "🔇 Без голосового" : "🧹 Без тексту", data: "mt:clear" });
  if (st.clips.length) tail.push({ text: "↩ Прибрати останній", data: "mt:undo" });
  tail.push({ text: "✕ Скасувати", data: "mt:cancel" });
  buttons.push(tail);
  return { text, buttons };
}

function musicLabel(st: MtState): string {
  if (st.music) return `свій трек «${st.music.name.slice(0, 30)}»`;
  if (st.mood && MUSIC_MOODS[st.mood]) return `AI ${MUSIC_MOODS[st.mood].label.split(" ").slice(1).join(" ").toLowerCase()}`;
  return "без музики";
}
// 🎵 «▸» перебирає: без музики → свій трек (якщо надіслано) → AI-настрої (якщо підключено ElevenLabs) → знову без
export function nextMusic(st: MtState, own: { id: string; name: string; dur: number } | null, ai: boolean): Pick<MtState, "music" | "mood"> {
  const opts: Array<Pick<MtState, "music" | "mood">> = [{ music: null, mood: null }];
  if (own) opts.push({ music: own, mood: null });
  if (ai) for (const m of Object.keys(MUSIC_MOODS) as MusicMood[]) opts.push({ music: null, mood: m });
  const cur = opts.findIndex((o) => (o.music?.id || null) === (st.music?.id || null) && (o.mood || null) === (st.mood || null));
  return opts[(cur + 1) % opts.length];
}
const TR_ORDER: TransitionMode[] = ["fade", "slide", "zoom", "flash", "mix", "none"];

async function showCard(ws: string, chatId: string, st: MtState, note = ""): Promise<void> {
  const style = await montageStyle(ws).catch(() => null);
  const c = mtCard(st, await brandLabel(ws, chatId).catch(() => ""), await brandEndText(ws, style?.endText).catch(() => null));
  await liveSend(ws, chatId, "montage", (note ? note + "\n\n" : "") + c.text, c.buttons);
}

/**
 * 🏢 Людина перемкнула бренд посеред монтажу: сесія (кліпи, голосове, музика) їде з нею - монтаж для
 * нового бренду, а не для старого. Монтаж, що вже йде, не чіпаємо: його пост можна перенести кнопкою
 * «🏢» у картці. Вертає, що сталося, - для відповіді людині.
 */
export async function moveMtSession(from: string, to: string): Promise<"none" | "moved" | "busy" | "taken"> {
  if (from === to) return "none";
  return mtLocked(from, async () => {
    const st = await getMt(from);
    if (!st) return "none";
    if (st.job) { const j = await getJob(st.job); if (j?.status === "running") return "busy"; }
    if (await getMt(to)) return "taken";
    const map = await moveMedia([...st.clips.map((c) => c.id), st.voice?.id || "", st.music?.id || "", st.ownMusic?.id || ""], from, to);
    const re = (id: string) => map.get(id) || id;
    st.clips = st.clips.filter((c) => map.has(c.id)).map((c) => ({ ...c, id: re(c.id) }));
    if (st.voice) st.voice = map.has(st.voice.id) ? { ...st.voice, id: re(st.voice.id) } : null;
    if (st.music) st.music = map.has(st.music.id) ? { ...st.music, id: re(st.music.id) } : null;
    if (st.ownMusic) st.ownMusic = map.has(st.ownMusic.id) ? { ...st.ownMusic, id: re(st.ownMusic.id) } : null;
    st.job = null;
    await mtLocked(to, () => saveMt(to, st));
    await clearMt(from);
    return "moved";
  });
}

/** /montage чи кнопка «🎬 Монтаж»: відкрита сесія - показуємо її, інакше нова. */
export function startMt(ws: string, chatId: string): Promise<void> {
  return mtLocked(ws, async () => {
    const cur = await getMt(ws);
    if (cur) { cur.chat = chatId; await saveMt(ws, cur); await showCard(ws, chatId, cur); return; }
    // 🎨 гачок, фінальна картка, паузи й субтитри - як у стилі відео бренду (картка каже, що саме буде)
    const style = await montageStyle(ws);
    const st: MtState = { chat: chatId, clips: [], voice: null, script: null, mode: "auto", format: "story", at: Date.now(),
      template: "standard", hook: style.hook ? "auto" : "off", end: style.end, cut: style.cut, sub: style.subtitle, before: null };
    await saveMt(ws, st);
    await showCard(ws, chatId, st);
  });
}

const TOO_BIG = "⚠️ Telegram не віддає ботам файли понад 20 МБ. Великі відео - через «🚀 Кабінет» (Mini App → «🎬 Відео») або кабінет, а змонтувати їх можна звідти чи з Claude.";

/**
 * Повідомлення під час сесії: відео/фото - кліп, голосове - озвучка, текст - слова для відео.
 * true - повідомлення забрав монтаж (далі його не обробляти). Стан на момент приходу (_st) не беремо:
 * під замком читаємо свіжий - інше повідомлення альбому могло щойно додати кліп.
 */
export async function montageMessage(ws: string, chatId: string, msg: any, _st: MtState, token: string): Promise<boolean> {
  const doc = msg.document;
  const docMime = String(doc?.mime_type || "");
  const vid = msg.video || msg.video_note || msg.animation || (doc && /^video\//.test(docMime) ? doc : null);
  const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : (doc && /^image\//.test(docMime) ? doc : null);
  // голосове - озвучка; аудіофайл із назвою/виконавцем чи mp3 - музика; решта аудіофайлів (диктофон) - озвучка,
  // картка дає кнопку поміняти роль
  const audFile = msg.audio || (doc && /^audio\//.test(docMime) ? doc : null);
  const voice = msg.voice || audFile;
  const isMusic = !msg.voice && !!audFile && (!!(audFile.title || audFile.performer) || /mpeg|mp3/i.test(String(audFile.mime_type || "")) || /\.mp3$/i.test(String(audFile.file_name || "")));
  const file = vid || photo || voice;
  const text = String(msg.text || "").trim();
  if (!file && !(text && !text.startsWith("/"))) return false;
  return mtLocked(ws, async () => {
    // сесію щойно закрили («Скасувати» чи готовий монтаж) - не воскрешаємо її, повідомлення піде далі
    const cur = await getMt(ws);
    if (!cur) return false;
    if (file) {
      if ((file.file_size || 0) > 19.5 * 1024 * 1024) { await tg.sendMessage(token, chatId, TOO_BIG); return true; }
      if (!voice && cur.clips.length >= MONTAGE_MAX_CLIPS) { await tg.sendMessage(token, chatId, `У монтажі до ${MONTAGE_MAX_CLIPS} кліпів - тисни «✂️ Змонтувати».`); return true; }
      let buf: Buffer;
      try { buf = (await tg.getFileBuffer(token, file.file_id)).buffer; }
      catch (e: any) { await tg.sendMessage(token, chatId, "⚠️ " + (/too big/i.test(String(e.message)) ? TOO_BIG : String(e.message).slice(0, 200))); return true; }
      const mime = vid ? (vid.mime_type || "video/mp4") : photo ? "image/jpeg" : (voice.mime_type || "audio/ogg");
      const name = String(file.file_name || (vid ? "clip.mp4" : photo ? "photo.jpg" : "voice.ogg")).slice(0, 120);
      let saved: { id: string; kind: string };
      try { saved = await saveMedia(ws, { buffer: buf, mime, name, source: "bot", dedupe: true }); }
      catch (e: any) { await tg.sendMessage(token, chatId, "⚠️ " + String(e.message).slice(0, 200)); return true; }
      const row = await one<{ duration: number | null }>(`select duration from media_asset where id=$1`, [saved.id]);
      const d = Number(row?.duration) || 0;
      if (saved.kind === "audio") {
        const title = String(audFile?.title || audFile?.file_name || "").replace(/\.[a-z0-9]{2,4}$/i, "").slice(0, 60) || "трек";
        if (isMusic) {
          cur.music = { id: saved.id, name: [audFile?.performer, title].filter(Boolean).join(" - ").slice(0, 60), dur: d };
          cur.ownMusic = cur.music;
          cur.mood = null;
          await saveMt(ws, cur);
          await showCard(ws, chatId, cur, `🎵 Музика «${cur.music.name}» (${dur(d)}) - піде фоном на весь ролик, під голосом притихне.`);
          return true;
        }
        cur.voice = { id: saved.id, dur: d, file: !msg.voice, name: title };
        await saveMt(ws, cur);
        await showCard(ws, chatId, cur, `🎙 ${msg.voice ? "Голосове" : "Запис"} (${dur(d)}) - буде озвучкою, субтитри з нього.`);
        return true;
      }
      // той самий файл (повтор вебхука чи те саме відео вдруге) - другим кліпом не стає, і людина це бачить
      const had = cur.clips.findIndex((c) => c.id === saved.id);
      if (had < 0) {
        cur.clips.push({ id: saved.id, kind: saved.kind === "image" ? "image" : "video", dur: d, mid: Number(msg.message_id) || 0 });
        // порядок - як людина надсилала (у альбомі - як розклала), а не як Telegram доставив
        cur.clips.sort((a, b) => (a.mid || 0) - (b.mid || 0));
      }
      await saveMt(ws, cur);
      const what = saved.kind === "image" ? "Фото" : `Відео ${dur(d)}`;
      await showCard(ws, chatId, cur, had < 0 ? `✅ ${what} додано - кліпів: ${cur.clips.length}.`
        : `ℹ️ ${saved.kind === "image" ? "Це фото" : "Це відео"} вже в монтажі (кліп ${had + 1}) - вдруге не додаю. Кліпів: ${cur.clips.length}.`);
      return true;
    }
    // 🪝 «гачок: …» - свій гачок (великий текст на перші секунди), а не слова для відео
    const hm = /^\s*(?:🪝\s*)?(?:гачок|hook|háček)\s*[:：-]\s*(.+)$/is.exec(text);
    if (hm) {
      cur.hook = cleanHook(hm[1]) || "auto";
      await saveMt(ws, cur);
      await showCard(ws, chatId, cur, `🪝 Гачок: «${cur.hook}» - великим текстом на перші секунди.`);
      return true;
    }
    // текст - слова для відео, поки людина щойно працювала з монтажем (інакше - звичайна ідея чи щоденник)
    if (Date.now() - Number(cur.at || 0) < TEXT_WINDOW) {
      cur.script = text.slice(0, 3000);
      await saveMt(ws, cur);
      await showCard(ws, chatId, cur, "✍ Текст для відео збережено.");
      return true;
    }
    return false;
  });
}

/** Вибір мереж для нового поста: сторіс - Instagram і Facebook; рілс - вони ж (решту людина вмикає в картці). */
async function netsFor(ws: string): Promise<string[]> {
  return (await connectedNets(ws)).filter((n) => n === "instagram" || n === "facebook");
}

export function mtOpts(st: MtState, tts: boolean): { opts: MontageOpts; aiText: { mode: "captions" | "voiceover" } | null } {
  const clips = st.clips.map((c) => ({ id: c.id }));
  const h = st.hook || "auto";
  const base = { clips, format: st.format, transition: st.transition || null, music: st.music?.id || null, musicMood: st.music ? null : st.mood || null,
    template: st.template || "standard", hook: h === "off" ? false : h === "auto" ? true : h, endCard: st.end !== false,
    cutPauses: st.cut !== false, subStyle: st.sub || null, beforeCount: st.before ?? null } as const;
  if (st.voice) return { opts: { ...base, voice: "audio", audio: st.voice.id }, aiText: null };
  if (st.script) {
    if (tts) return { opts: { ...base, voice: "tts", script: st.script }, aiText: null };
    const parts = spreadText(st.script, clips.length);
    return { opts: { ...base, voice: "none", clips: clips.map((c, i) => ({ ...c, text: parts[i] || null })) }, aiText: null };
  }
  if (st.mode === "ai-voice" && tts) return { opts: { ...base, voice: "tts" }, aiText: { mode: "voiceover" } };
  if (st.mode === "captions") return { opts: { ...base, voice: "none" }, aiText: { mode: "captions" } };
  return { opts: { ...base, voice: "clips", autoCaptions: true }, aiText: null };
}

/** Кнопки картки монтажу (mt:*). openPost - відкрити картку поста (композер бота). */
export async function montageCallback(ws: string, chatId: string, data: string, cbq: any, token: string, openPost: (postId: string) => Promise<void>): Promise<boolean> {
  if (!data.startsWith("mt:")) return false;
  return mtLocked(ws, () => montageTap(ws, chatId, data, cbq, token, openPost));
}
async function montageTap(ws: string, chatId: string, data: string, cbq: any, token: string, openPost: (postId: string) => Promise<void>): Promise<boolean> {
  const st = await getMt(ws);
  if (!st) { await tg.answerCallbackQuery(token, cbq.id, "Сесія монтажу завершилась - /montage, щоб почати нову"); return true; }
  const [, cmd, arg] = data.split(":");
  if (cmd === "cancel") { await clearMt(ws); await tg.answerCallbackQuery(token, cbq.id, "Скасовано"); await liveSend(ws, chatId, "montage", "🎬 Монтаж скасовано. Кліпи лишились у медіатеці. /montage - почати знову."); return true; }
  if (cmd === "fmt") { st.format = arg === "reel" ? "reel" : "story"; await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id); await showCard(ws, chatId, st); return true; }
  if (cmd === "mode") { st.mode = arg === "ai-voice" ? "ai-voice" : arg === "captions" ? "captions" : "auto"; st.voice = null; st.script = null; await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id); await showCard(ws, chatId, st); return true; }
  if (cmd === "clear") { st.voice = null; st.script = null; st.mode = "auto"; await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id); await showCard(ws, chatId, st); return true; }
  if (cmd === "undo") { st.clips.pop(); await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id, "Прибрав останній кліп"); await showCard(ws, chatId, st); return true; }
  if (cmd === "tpl") {
    st.template = TEMPLATE_ORDER[(TEMPLATE_ORDER.indexOf(st.template || "standard") + 1) % TEMPLATE_ORDER.length];
    st.transition = undefined;   // перехід - той, що пасує шаблону (його можна змінити кнопкою «✨»)
    st.before = null;
    await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id, `Шаблон: ${TEMPLATES[st.template].label.replace(/^\S+\s/, "")}`); await showCard(ws, chatId, st); return true;
  }
  if (cmd === "hook") {
    // AI → без → (свій, якщо був) → AI
    const own = st.hook && st.hook !== "auto" && st.hook !== "off" ? st.hook : st.ownHook || null;
    if (own) st.ownHook = own;
    st.hook = st.hook === "auto" || !st.hook ? "off" : st.hook === "off" ? (own || "auto") : "auto";
    await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id, `Гачок: ${hookLabel(st)}`); await showCard(ws, chatId, st); return true;
  }
  if (cmd === "end" || cmd === "cut") {
    if (cmd === "end") st.end = st.end === false; else st.cut = st.cut === false;
    await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id); await showCard(ws, chatId, st); return true;
  }
  if (cmd === "sub") {
    st.sub = SUB_ORDER[(SUB_ORDER.indexOf(st.sub || "classic") + 1) % SUB_ORDER.length];
    await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id, `Субтитри: ${SUB_PRESETS[st.sub].label.toLowerCase()} - ${SUB_PRESETS[st.sub].hint}`); await showCard(ws, chatId, st); return true;
  }
  if (cmd === "ba") {
    const n = st.clips.length;
    const b = baSplit(n, st.before);
    st.before = b + 1 > n - 1 ? 1 : b + 1;
    await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id); await showCard(ws, chatId, st); return true;
  }
  if (cmd === "tr") {
    const tplTr = templatePlan(st.template || "standard").transition;
    st.transition = TR_ORDER[(TR_ORDER.indexOf(st.transition || tplTr) + 1) % TR_ORDER.length];
    await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id, `Переходи: ${TRANSITIONS[st.transition]}`); await showCard(ws, chatId, st); return true;
  }
  if (cmd === "mus") {
    // свій трек памʼятаємо й тоді, коли тимчасово обрали AI чи «без музики»
    const own = st.music || st.ownMusic || null;
    if (st.music) st.ownMusic = st.music;
    Object.assign(st, nextMusic(st, own, musicReady()));
    await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id, `Музика: ${musicLabel(st)}`); await showCard(ws, chatId, st); return true;
  }
  if (cmd === "swap") {
    if (st.music) { st.voice = { id: st.music.id, dur: st.music.dur, file: true, name: st.music.name }; st.music = null; st.ownMusic = null; st.script = null; }
    else if (st.voice?.file) { st.music = { id: st.voice.id, name: st.voice.name || "трек", dur: st.voice.dur }; st.voice = null; st.mood = null; }
    await saveMt(ws, st); await tg.answerCallbackQuery(token, cbq.id); await showCard(ws, chatId, st); return true;
  }
  if (cmd !== "build") return false;
  if (!st.clips.length) { await tg.answerCallbackQuery(token, cbq.id, "Спершу надішли кліпи"); return true; }
  if (st.job) {
    const j = await getJob(st.job);
    if (j?.status === "running") { await tg.answerCallbackQuery(token, cbq.id, "Уже монтую - зачекай"); return true; }
  }
  const tts = ttsReady();
  const { opts, aiText } = mtOpts(st, tts);
  const nets = await netsFor(ws);
  await tg.answerCallbackQuery(token, cbq.id, "Монтую…");
  const job = await startMontage(ws, opts, {
    create: { nets, text: "" },
    aiText,
    notify: async (r: MontageResult | null, err?: string) => {
      if (!r) { await tg.sendMessage(token, chatId, `⚠️ ${err || "Монтаж не вдався"}\n\nКліпи на місці - можна змінити й натиснути «✂️ Змонтувати» ще раз.`).catch(() => {}); return; }
      await sendResult(ws, chatId, r, token);
      await clearMt(ws);
      if (r.postId) await openPost(r.postId);
    },
  });
  st.job = job.id;
  await saveMt(ws, st);
  await liveSend(ws, chatId, "montage", `⏳ Монтую ${st.clips.length} ${st.clips.length === 1 ? "кліп" : "кліпів"}… Зазвичай 1-2 хвилини - надішлю відео сюди.`);
  return true;
}

async function sendResult(ws: string, chatId: string, r: MontageResult, token: string): Promise<void> {
  const sub = [r.template && r.template !== "standard" ? TEMPLATES[r.template].label : "",
    r.subtitles === "karaoke" ? "субтитри під голос" : r.subtitles === "lines" ? "підписи" : "без тексту",
    r.hook ? `🪝 «${r.hook}»` : "", r.cut ? `✂️ паузи -${String(r.cut.saved).replace(".", ",")} с` : "", r.endCard ? "🏁 фінальна картка" : "",
    r.cover ? "🖼 обкладинка Reels - кадр із гачком (інший кадр - у кабінеті)" : "",
    r.transition && r.transition !== "none" ? `✨ ${TRANSITIONS[r.transition]}` : "", r.music ? `🎵 ${r.music}` : "",
    r.smart ? `🎯 найкращі моменти: ${r.smart} ${plural(r.smart, "кліп", "кліпи", "кліпів")}` : ""].filter(Boolean).join(" · ");
  const many = r.videos.length > 1;
  for (let k = 0; k < r.videos.length; k++) {
    const v = r.videos[k];
    const path = join(MEDIA_DIR, v.filename);
    const size = (await stat(path).catch(() => null))?.size || 0;
    const cap = k === 0
      ? `🎬 Готово: ${dur(r.duration)} · ${r.clips} ${plural(r.clips, "кліп", "кліпи", "кліпів")} · ${sub}${many ? ` · ${r.videos.length} частини (у сторіс кожна - окремий кадр)` : ""}.${r.warnings.length ? `\n⚠️ ${r.warnings.join("; ")}` : ""}`
      : `Частина ${k + 1} з ${r.videos.length}`;
    if (size && size <= tg.TG_VIDEO_MAX) {
      await tg.sendVideo(token, chatId, { file: await readFile(path), name: many ? `montage-${k + 1}.mp4` : "montage.mp4" }, cap, { width: 1080, height: 1920, duration: v.duration })
        .catch(async (e: any) => { await tg.sendMessage(token, chatId, `${cap}\n(надіслати відео не вийшло: ${String(e.message).slice(0, 120)} - воно в кабінеті)`).catch(() => {}); });
    } else await tg.sendMessage(token, chatId, `${cap}\nВідео ${Math.round(size / 1048576)} МБ - більше, ніж Telegram дає боту надіслати; воно в кабінеті й у пості нижче.`).catch(() => {});
  }
  void ws;
}
