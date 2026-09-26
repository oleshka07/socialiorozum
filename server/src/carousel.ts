// 🖼 Збирач каруселі: сценарій «Слайд 1: … Слайд 2: …» → готові кадри-картинки.
//
// Навіщо окремо від «кількох фото»: формат «Карусель» у генерації пише текст СЛАЙДАМИ, але до
// збирача цей сценарій цілком їхав ПІДПИСОМ під одним фото - тобто «карусель» у мережі виходила
// звичайним постом із простирадлом тексту. Тепер кадри малюються тут (sharp + SVG, без моделі й без
// грошей), а текст поста стає тим, чим і має бути під каруселлю, - коротким підписом.
//
// Чисті функції (parseSlides, slideTitleBody, layoutSlide) винесені під юніти: саме тут найлегше
// тихо зламати результат - текст, що вилазить за край кадру, чи «Слайд 3:», що лишився в підписі.
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { q, one } from "./db.js";
import { saveMedia, MEDIA_DIR } from "./media.js";
import { wrapPx, textPx, ASPECT_DIM, postAspect, type Aspect } from "./images.js";
import { setPostMediaOrder, MAX_SLIDES, SlideError } from "./slides.js";

// ---------------------------------------------------------------------------
// 1. Сценарій → слайди + підпис
// ---------------------------------------------------------------------------

// «Слайд 3:», «**Слайд 3.**», «Slide 3 -», «### Слайд 3)», «* Слайд 3:» - так пише і наша генерація, і Claude.
// Жирне навколо мітки (група 1) знімаємо лише парою: «Слайд 1: **Обіцянка**» - це вже жирне
// в тексті слайда, і його відкривальні ** не можна сприйняти за кінець мітки.
const SLIDE_MARK = /^\s*[#>\-\s]*(?:\*\s+)?(\*\*|__)?\s*(?:слайд|slide|кадр|frame)\s*№?\s*(\d{1,2})\s*(?:[:.)\-–—]|(?=\s))\s*/i;
// «Підпис:» / «Підпис до каруселі:» / «Caption:» - текст, що піде під каруселлю
const CAPTION_MARK = /^\s*[#>\-\s]*(?:\*\s+)?(\*\*|__)?\s*(?:підпис(?:\s+(?:до|під)\s+каруселл?[юі])?|caption)\s*(?:\*\*|__)?\s*[:\-–—]\s*/i;
// після мітки: закривальне жирне, якщо мітку відкрили жирним («**Слайд 1:** текст»)
function afterMark(line: string, m: RegExpMatchArray): string {
  let rest = line.slice(m[0].length);
  if (m[1] && rest.startsWith(m[1])) rest = rest.slice(m[1].length);
  return rest.trim();
}

export type ParsedCarousel = { slides: string[]; caption: string; marked: boolean };

export function parseSlides(text: string): ParsedCarousel {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const slides: string[] = [];
  const pre: string[] = [], cap: string[] = [];
  let mode: "pre" | "slide" | "caption" = "pre";
  for (const line of lines) {
    const cm = line.match(CAPTION_MARK);
    if (cm) { mode = "caption"; const rest = afterMark(line, cm); if (rest) cap.push(rest); continue; }
    const sm = line.match(SLIDE_MARK);
    if (sm) { mode = "slide"; slides.push(afterMark(line, sm)); continue; }
    if (mode === "caption") cap.push(line);
    else if (mode === "slide") slides[slides.length - 1] += "\n" + line;
    else pre.push(line);
  }
  let out = slides.map((s) => s.trim()).filter(Boolean);
  const marked = out.length > 0;
  // без міток «Слайд N» - розділювач «---» між слайдами (так пишуть і люди, і моделі)
  if (!marked) {
    const parts = String(text || "").split(/\n\s*-{3,}\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) out = parts;
  }
  let caption = cap.join("\n").trim() || (marked ? pre.join("\n").trim() : "");
  // підпису нема ні явного, ні вступу - збираємо з обіцянки (слайд 1) і заклику (останній слайд):
  // краще такий, ніж увесь сценарій під фото
  if (!caption && out.length >= 2) caption = [out[0], out[out.length - 1]].map(stripMarkup).join("\n\n");
  return { slides: out, caption, marked };
}

// ---------------------------------------------------------------------------
// 2. Текст слайда → заголовок + тіло
// ---------------------------------------------------------------------------

// Кольорові емодзі librsvg без відповідного шрифту малює порожніми квадратами - на кадрі їм не
// місце (у підписі під каруселлю лишаються). **жирне** з markdown стає акцентним кольором.
const EMOJI_RX = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu;
export function stripMarkup(s: string): string {
  return String(s || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$|[.,!?:;])/g, "$1$2").trim();
}
function forSlide(s: string): string {
  return String(s || "").replace(EMOJI_RX, "").replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/__(.+?)__/g, "*$1*").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}

export function slideTitleBody(raw: string): { title: string; body: string } {
  const t = forSlide(raw);
  if (!t) return { title: "", body: "" };
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return { title: lines[0], body: lines.slice(1).join("\n") };
  const one1 = lines[0] || "";
  if (one1.length <= 90) return { title: one1, body: "" };
  // одне довге речення-абзац: перше речення - заголовок, решта - тіло
  const m = one1.slice(0, 130).match(/^(.{15,}?[.!?…:])\s+(?=\S)/);
  if (m) return { title: m[1].replace(/:$/, ""), body: one1.slice(m[0].length).trim() };
  return { title: one1, body: "" };
}

// ---------------------------------------------------------------------------
// 3. Розкладка: розміри шрифтів і рядки, які ГАРАНТОВАНО влазять у кадр
// ---------------------------------------------------------------------------

type Word = { t: string; a: boolean };
// «*акцент*» → слова з прапорцем a (малюються акцентним кольором)
function words(line: string): Word[] {
  const out: Word[] = [];
  const re = /\*([^*]+)\*|([^*]+)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const acc = m[1] !== undefined;
    for (const w of (m[1] ?? m[2]).split(/\s+/).filter(Boolean)) out.push({ t: w, a: acc });
  }
  return out;
}

// Слово, ширше за кадр навіть саме по собі (посилання, хештег, склеєне слово), ріжемо на шматки,
// які влазять: інакше жоден розмір шрифту не втримав би його в межах кадру
function splitLong(ws: Word[], fs: number, maxW: number): Word[] {
  const out: Word[] = [];
  for (const w of ws) {
    if (textPx(w.t, fs, false) <= maxW) { out.push(w); continue; }
    let cur = "";
    for (const ch of w.t) {
      if (cur && textPx(cur + ch, fs, false) > maxW) { out.push({ t: cur, a: w.a }); cur = ""; }
      cur += ch;
    }
    if (cur) out.push({ t: cur, a: w.a });
  }
  return out;
}

export type SlideLayout = {
  titleFs: number; titleLines: Word[][]; bodyFs: number; bodyLines: Word[][];
  blockH: number; box: { x: number; y: number; w: number; h: number }; truncated: boolean;
};
const TITLE_LH = 1.16, BODY_LH = 1.42;

// story: у сторіс згори - смужки прогресу й імʼя акаунта, знизу - поле відповіді, тож текст тримаємо
// всередині «безпечної зони» (без верхніх 16% і нижніх 22% кадру)
export function layoutSlide(W: number, H: number, title: string, body: string, isCover: boolean, story = false): SlideLayout {
  const pad = Math.round(W * 0.085);
  const top = Math.round(H * (story ? 0.16 : 0.12)), bottom = Math.round(H * (story ? 0.22 : 0.12));
  const box = { x: pad, y: top, w: W - 2 * pad, h: H - top - bottom };
  let tfs = Math.round(W * (isCover ? 0.1 : (body ? 0.07 : 0.085)));
  let bfs = Math.round(W * 0.042);
  const minT = Math.round(W * 0.042), minB = Math.round(W * 0.028);
  const tWords = words(title);
  const bParas = body ? body.split("\n").map(words).filter((p) => p.length) : [];
  const lay = () => {
    const tl = tWords.length ? wrapPx(splitLong(tWords, tfs, box.w), tfs, box.w, false) : [];
    const bl: Word[][] = [];
    for (const p of bParas) bl.push(...wrapPx(splitLong(p, bfs, box.w), bfs, box.w, false));
    const gap = tl.length && bl.length ? Math.round(tfs * 0.55) : 0;
    const h = tl.length * tfs * TITLE_LH + gap + bl.length * bfs * BODY_LH;
    const widest = Math.max(1, ...tl.map((l) => textPx(l.map((w) => w.t).join(" "), tfs, false)), ...bl.map((l) => textPx(l.map((w) => w.t).join(" "), bfs, false)));
    return { tl, bl, h, widest };
  };
  let r = lay();
  // зменшуємо, поки не влізе і вшир (одне довге слово), і ввись
  for (let guard = 0; guard < 30 && (r.h > box.h || r.widest > box.w); guard++) {
    if (tfs <= minT && bfs <= minB) break;
    tfs = Math.max(minT, Math.floor(tfs * 0.93));
    bfs = Math.max(minB, Math.floor(bfs * 0.95));
    r = lay();
  }
  let truncated = false;
  // навіть на мінімальних шрифтах не влізло - ріжемо тіло по рядку з «…» (краще, ніж текст за кадром)
  while (r.h > box.h && r.bl.length > 1) {
    r.bl.pop(); truncated = true;
    const gap = r.tl.length && r.bl.length ? Math.round(tfs * 0.55) : 0;
    r.h = r.tl.length * tfs * TITLE_LH + gap + r.bl.length * bfs * BODY_LH;
  }
  if (truncated && r.bl.length) {
    const last = r.bl[r.bl.length - 1];
    last[last.length - 1] = { ...last[last.length - 1], t: last[last.length - 1].t.replace(/[.,;:!?…]*$/, "") + "…" };
  }
  return { titleFs: tfs, titleLines: r.tl, bodyFs: bfs, bodyLines: r.bl, blockH: Math.round(r.h), box, truncated };
}

// ---------------------------------------------------------------------------
// 4. Малювання кадру
// ---------------------------------------------------------------------------

export type CarouselTheme = "photo" | "dark" | "light";
export const CAROUSEL_THEMES: CarouselTheme[] = ["photo", "dark", "light"];
const FONT = "'DejaVu Sans','Segoe UI',Arial,sans-serif";
function darken(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v * (1 - f)).toString(16).padStart(2, "0");
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PALETTE: Record<CarouselTheme, { bg: string; title: string; body: string; meta: string }> = {
  photo: { bg: "#111318", title: "#ffffff", body: "#e4e7ec", meta: "#d0d4db" },
  dark: { bg: "#111318", title: "#ffffff", body: "#c9ced6", meta: "#8a919c" },
  light: { bg: "#f7f4ee", title: "#15171b", body: "#454b55", meta: "#7a808a" },
};

export async function renderSlide(o: {
  W: number; H: number; theme: CarouselTheme; accent: string; photo: Buffer | null;
  title: string; body: string; index: number; total: number; handle: string; story?: boolean;
}): Promise<Buffer> {
  const { W, H } = o;
  const pal = PALETTE[o.theme];
  const isCover = o.index === 0;
  // фон
  let base: sharp.Sharp;
  if (o.theme === "photo" && o.photo) {
    const photo = sharp(o.photo).rotate().resize(W, H, { fit: "cover", position: "attention" });
    base = isCover ? photo : photo.blur(26).modulate({ brightness: 0.62 });
  } else {
    base = sharp({ create: { width: W, height: H, channels: 3, background: pal.bg } });
  }
  const L = layoutSlide(W, H, o.title, o.body, isCover, o.story === true);
  // обкладинка на фото - текст унизу над градієнтом (як у стрічці); решта - по центру вільного поля
  const y0 = isCover && o.theme === "photo" && o.photo
    ? L.box.y + L.box.h - L.blockH
    : L.box.y + Math.max(0, Math.round((L.box.h - L.blockH) / 2 - H * 0.02));
  const rawAccent = /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent : "#F6C444";
  // світлий фон: пастельний акцент (жовтий, блакитний) на ньому не читається - темнимо його
  const accent = o.theme === "light" ? darken(rawAccent, 0.45) : rawAccent;
  const line = (ws: Word[], fill: string) => {
    const runs: Word[] = [];
    for (const w of ws) { const last = runs[runs.length - 1]; if (last && last.a === w.a) last.t += " " + w.t; else runs.push({ ...w }); }
    return runs.map((r, k) => `<tspan${r.a ? ` fill="${accent}"` : ` fill="${fill}"`}>${k ? " " : ""}${esc(r.t)}</tspan>`).join("");
  };
  let y = y0; const parts: string[] = [];
  L.titleLines.forEach((ws) => { y += L.titleFs; parts.push(`<text x="${L.box.x}" y="${y}" xml:space="preserve" font-family="${FONT}" font-size="${L.titleFs}" font-weight="800">${line(ws, pal.title)}</text>`); y += Math.round(L.titleFs * (TITLE_LH - 1)); });
  if (L.titleLines.length && L.bodyLines.length) y += Math.round(L.titleFs * 0.55);
  L.bodyLines.forEach((ws) => { y += L.bodyFs; parts.push(`<text x="${L.box.x}" y="${y}" xml:space="preserve" font-family="${FONT}" font-size="${L.bodyFs}" font-weight="500">${line(ws, pal.body)}</text>`); y += Math.round(L.bodyFs * (BODY_LH - 1)); });
  // службове: лічильник з акцентною рискою вгорі, імʼя бренду й «гортай →» унизу
  const mfs = Math.round(W * 0.028), pad = L.box.x;
  const kick = `<text x="${pad}" y="${Math.round(H * 0.07)}" font-family="${FONT}" font-size="${mfs}" font-weight="700" letter-spacing="${Math.round(W * 0.002)}" fill="${o.theme === "light" ? pal.title : accent}">${o.index + 1}/${o.total}</text>`
    + `<rect x="${pad}" y="${Math.round(H * 0.07 + mfs * 0.55)}" width="${Math.round(W * 0.06)}" height="${Math.max(3, Math.round(H * 0.005))}" rx="2" fill="${accent}"/>`;
  const handle = o.handle ? `<text x="${pad}" y="${H - Math.round(H * 0.05)}" font-family="${FONT}" font-size="${mfs}" font-weight="600" fill="${pal.meta}">${esc(o.handle)}</text>` : "";
  const next = o.index < o.total - 1 ? `<text x="${W - pad}" y="${H - Math.round(H * 0.05)}" text-anchor="end" font-family="${FONT}" font-size="${Math.round(mfs * 1.3)}" font-weight="700" fill="${o.theme === "light" ? pal.title : accent}">→</text>` : "";
  // градієнт під текстом обкладинки на фото - інакше білий текст губиться на світлому кадрі
  const grad = isCover && o.theme === "photo" && o.photo
    ? `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.82"/></linearGradient><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs><rect x="0" y="${Math.max(0, y0 - Math.round(H * 0.12))}" width="${W}" height="${H - Math.max(0, y0 - Math.round(H * 0.12))}" fill="url(#g)"/><rect x="0" y="0" width="${W}" height="${Math.round(H * 0.16)}" fill="url(#t)"/>`
    : "";
  // у сторіс лічильник, «→» і нік малює сама мережа (смужки прогресу, акаунт згори) - не дублюємо
  const svg = o.story
    ? `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${grad}${parts.join("")}</svg>`
    : `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${grad}${kick}${parts.join("")}${handle}${next}</svg>`;
  return base.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 90 }).toBuffer();
}

// ---------------------------------------------------------------------------
// 5. Зібрати карусель поста
// ---------------------------------------------------------------------------

// Підпис на кадрі: @нік мережі, у якій бренд живе (Instagram → Threads → канал Telegram), або назва
// бренду, якщо її задали. Пошту (так зветься домашній кабінет без назви) на кадр не ставимо.
export async function carouselHandle(ws: string): Promise<string> {
  const r = await one<{ ig: string | null; th: string | null; tg: string | null; title: string | null }>(
    `select (select ig_username from meta_config where workspace_id=$1) as ig,
            (select username from threads_config where workspace_id=$1) as th,
            (select channel_username from telegram_config where workspace_id=$1) as tg,
            (select nullif(btrim(title),'') from workspace where id=$1) as title`, [ws]);
  const h = r?.ig || r?.th || r?.tg;
  if (h) return "@" + String(h).replace(/^@/, "");
  return r?.title && !/@/.test(r.title) ? r.title.slice(0, 40) : "";
}

export type RenderResult = { count: number; theme: CarouselTheme; caption: string; captionChanged: boolean; truncated: number[] };

export async function renderCarousel(ws: string, postId: string, opts?: { theme?: string; accent?: string; slides?: string[] }): Promise<RenderResult> {
  const post = await one<{ content: string; slides_text: string | null; image_base: string | null; cover: string | null; cover_source: string | null; channels: any; format: string | null }>(
    `select p.content, p.slides_text, p.image_base, m.filename as cover, m.source as cover_source, p.channels, p.format
       from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
       left join media_asset m on m.id=p.media_id
      where p.id=$1 and s.workspace_id=$2`, [postId, ws]);
  if (!post) throw new SlideError("пост не знайдено");
  // звідки тексти: явний список (конектор) → збережений сценарій → сам текст поста
  // 📱 сторіс: ті самі кадри-картинки, але 9:16, у безпечній зоні, від одного кадру, і текст поста
  // лишається як є (підпису в сторіс немає - уся думка на кадрах)
  const story = post.format === "story";
  const minN = story ? 1 : 2, word = story ? "Кадр" : "Слайд";
  let texts: string[] = [], script = post.slides_text || "", caption = post.content, captionChanged = false;
  const given = (opts?.slides || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (given.length) {
    texts = given;
    script = given.map((t, i) => `${word} ${i + 1}: ${t}`).join("\n\n");
  } else if (post.slides_text && parseSlides(post.slides_text).slides.length >= minN) {
    texts = parseSlides(post.slides_text).slides;
  } else {
    const p = parseSlides(post.content);
    texts = p.slides;
    if (texts.length >= minN) {
      script = post.content;
      if (!story) { caption = p.caption || post.content; captionChanged = caption !== post.content; }
    }
  }
  if (texts.length < minN) throw new SlideError(story
    ? "Для сторіс розпиши кадри рядками «Кадр 1: …», «Кадр 2: …» (або розділи кадри рядком ---)."
    : "Для каруселі потрібно щонайменше 2 слайди: розпиши текст рядками «Слайд 1: …», «Слайд 2: …» (або розділи слайди рядком ---).");
  // понад 10 кадрів мережі не приймуть: лишаємо перші 9 і фінальний заклик
  if (texts.length > MAX_SLIDES) texts = [...texts.slice(0, MAX_SLIDES - 1), texts[texts.length - 1]];

  // фон: вихідне фото обкладинки (база без напису), а не вже зібраний кадр
  const bgFile = post.image_base || (post.cover && post.cover_source !== "slide" ? post.cover : null);
  let photo: Buffer | null = null;
  if (bgFile) { try { photo = await readFile(join(MEDIA_DIR, bgFile)); } catch { photo = null; } }
  const theme: CarouselTheme = (CAROUSEL_THEMES as string[]).includes(String(opts?.theme)) ? opts!.theme as CarouselTheme : (photo ? "photo" : "dark");
  const useTheme: CarouselTheme = theme === "photo" && !photo ? "dark" : theme;
  const aspect: Aspect = story ? "9:16" : photo ? await postAspect(postId) : "4:5";
  const { w: W, h: H } = ASPECT_DIM[aspect];
  const handle = await carouselHandle(ws);

  const ids: string[] = []; const truncated: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const { title, body } = slideTitleBody(texts[i]);
    if (layoutSlide(W, H, title, body, i === 0, story).truncated) truncated.push(i + 1);
    const buf = await renderSlide({ W, H, theme: useTheme, accent: String(opts?.accent || ""), photo, title, body, index: i, total: texts.length, handle, story });
    const saved = await saveMedia(ws, { buffer: buf, mime: "image/jpeg", name: `slide-${i + 1}.jpg`, source: "slide", externalId: `post:${postId}` });
    ids.push(saved.id);
  }
  // кадри стають списком поста; база під текст обкладинки = вихідне фото (щоб його можна було
  // перезібрати чи наклати інший напис), а старі зібрані кадри прибираються самі
  await setPostMediaOrder(ws, postId, ids, { keepBase: true });
  await q(`update post set image_base=$2, headline=null, slides_text=$3, format=$4 where id=$1`, [postId, bgFile, script, story ? "story" : "carousel"]);
  if (captionChanged) {
    // текст поста був сценарієм - тепер це підпис. Версії під мережі робились зі сценарію, тож вони
    // застаріли: скидаємо їх (перемикачі мереж лишаються), при публікації спакується вже підпис
    const ch = post.channels || {};
    for (const k of Object.keys(ch)) if (ch[k] && typeof ch[k] === "object" && "text" in ch[k]) ch[k] = { ...ch[k], text: "" };
    await q(`update post set content=$2, channels=$3 where id=$1`, [postId, caption, JSON.stringify(ch)]);
  }
  return { count: ids.length, theme: useTheme, caption, captionChanged, truncated };
}
