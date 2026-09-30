// 🎬 Монтаж: ЧИСТІ правила - без ffmpeg, мережі й бази, тож усе тут покрите юнітами.
//
// Що тут вирішується: які слова стоять разом на екрані (субтитри), скільки секунд дістається кожному
// кліпу, де різати довгу сторіс і як записати субтитри у формат ASS, який уміє ffmpeg (libass).
// Помилка в будь-якому з цих місць не падає, а тихо псує відео: субтитр біжить поперед голосу, кліп
// обривається посеред руху, сторіс ріжеться посеред слова. Тому - окремо й під тестами.

export type Word = { w: string; s: number; e: number };
export type Cue = { start: number; end: number; words: Word[]; lines: Array<[number, number]> };
export type Caption = { text: string; start: number; end: number };

const r2 = (x: number) => Math.round(x * 100) / 100;

// ---- мова контенту кабінету → код мови для розшифровки й голосу ----
// Налаштування «Мова контенту» - вільний текст («Українська», «Чеська», «Czech»), а Deepgram, Whisper
// і Azure чекають код. Невідома мова - українська, як і типова мова кабінету.
const LANGS: Array<[RegExp, string]> = [
  [/укра|ukrain|^uk$/i, "uk"],
  [/чес|czech|češ|cest|^cs$/i, "cs"],
  [/словац|slovak|slovenčin|^sk$/i, "sk"],
  [/польс|polish|polsk|^pl$/i, "pl"],
  [/німец|german|deutsch|^de$/i, "de"],
  [/англ|english|^en$/i, "en"],
  [/іспан|spanish|español|^es$/i, "es"],
  [/франц|french|français|^fr$/i, "fr"],
  [/італ|italian|italiano|^it$/i, "it"],
  [/рос|russ|русск|^ru$/i, "ru"],
];
export function langCode(v?: string | null): string {
  const s = String(v || "").trim();
  for (const [rx, code] of LANGS) if (rx.test(s)) return code;
  return "uk";
}

// ---- слова з часом ----
function fixTimes(words: Word[]): Word[] {
  let prev = 0;
  for (const w of words) {
    if (!isFinite(w.s)) w.s = prev;
    if (w.s < prev) w.s = prev;
    if (!isFinite(w.e) || w.e < w.s + 0.05) w.e = w.s + 0.05;
    prev = w.s;
    w.s = r2(w.s); w.e = r2(w.e);
  }
  return words;
}

/** ElevenLabs віддає час кожного СИМВОЛУ; слово - від першої літери до останньої. */
export function wordsFromAlignment(a: any, offset = 0): Word[] {
  const ch: unknown[] = Array.isArray(a?.characters) ? a.characters : [];
  const st: unknown[] = Array.isArray(a?.character_start_times_seconds) ? a.character_start_times_seconds : [];
  const en: unknown[] = Array.isArray(a?.character_end_times_seconds) ? a.character_end_times_seconds : [];
  const out: Word[] = [];
  let cur: Word | null = null;
  for (let i = 0; i < ch.length; i++) {
    const c = String(ch[i] ?? "");
    if (!c || /^\s+$/.test(c)) { if (cur) { out.push(cur); cur = null; } continue; }
    const s = Number(st[i]), e = Number(en[i]);
    if (!cur) cur = { w: c, s: isFinite(s) ? s + offset : NaN, e: isFinite(e) ? e + offset : NaN };
    else { cur.w += c; if (isFinite(e)) cur.e = e + offset; }
  }
  if (cur) out.push(cur);
  return fixTimes(out);
}

/**
 * Голос без розмітки часу (Azure): розкладаємо слова по тривалості пропорційно їхній довжині, з
 * паузою після крапки й коми. Для караоке це грубо, але речення стоять на своїх місцях.
 */
export function wordsEvenly(text: string, start: number, end: number): Word[] {
  const toks = String(text || "").split(/\s+/).filter(Boolean);
  if (!toks.length || !(end > start)) return [];
  const weight = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, "").length + 1 + (/[.!?…]["»”)]?$/.test(t) ? 3 : /[,;:]$/.test(t) ? 1.5 : 0);
  const ws = toks.map(weight);
  const total = ws.reduce((a, b) => a + b, 0);
  let t = start;
  return fixTimes(toks.map((w, i) => {
    const d = (end - start) * ws[i] / total;
    const o = { w, s: t, e: t + d * 0.92 };
    t += d;
    return o;
  }));
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/**
 * Whisper у словах із часом губить розділові й великі літери - вони є лише в суцільному тексті.
 * Повертаємо їх, звіряючи слова з текстом по порядку (з невеликим запасом на розбіжності).
 */
export function restorePunct(words: Word[], text: string): Word[] {
  const toks = String(text || "").split(/\s+/).filter(Boolean);
  let j = 0;
  return words.map((w) => {
    const n = norm(w.w);
    if (!n) return w;
    for (let k = j; k < Math.min(toks.length, j + 4); k++) {
      if (norm(toks[k]) === n) { j = k + 1; return { ...w, w: toks[k] }; }
    }
    return w;
  });
}

// ---- субтитри: які слова разом на екрані ----
const joined = (ws: Word[]) => ws.map((w) => w.w).join(" ");
/** Розбити слова на 1-2 рядки: якщо в один не влазить - розрив там, де рядки найрівніші. */
export function splitLines(tokens: string[], lineChars: number): Array<[number, number]> {
  const n = tokens.length;
  const len = (a: number, b: number) => tokens.slice(a, b).join(" ").length;
  if (n <= 1 || len(0, n) <= lineChars) return [[0, n]];
  let best = 1, bestW = Infinity;
  for (let k = 1; k < n; k++) {
    const w = Math.max(len(0, k), len(k, n));
    if (w < bestW) { bestW = w; best = k; }
  }
  return [[0, best], [best, n]];
}

/**
 * Слова → «картки» субтитрів: до maxWords слів і maxChars символів, не довше maxDur секунд;
 * картка закінчується на кінці речення, на комі (якщо в ній уже 2+ слова) і на паузі в мовленні.
 * Картка тримається ще трохи після останнього слова, але ніколи не налазить на наступну.
 */
export function groupCues(words: Word[], o: { maxChars?: number; maxWords?: number; maxDur?: number; lineChars?: number; gap?: number } = {}): Cue[] {
  const maxChars = o.maxChars ?? 30, maxWords = o.maxWords ?? 5, maxDur = o.maxDur ?? 2.8, lineChars = o.lineChars ?? 18, gap = o.gap ?? 0.7;
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) { cues.push({ start: cur[0].s, end: cur[cur.length - 1].e, words: cur, lines: [] }); cur = []; } };
  for (const w of words) {
    if (!w.w.trim()) continue;
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const tooLong = joined([...cur, w]).length > maxChars || cur.length >= maxWords || w.e - cur[0].s > maxDur;
      const pause = w.s - prev.e > gap;
      const sentence = /[.!?…]["»”)]?$/.test(prev.w);
      const comma = /[,;:]["»”)]?$/.test(prev.w) && cur.length >= 2;
      if (tooLong || pause || sentence || comma) flush();
    }
    cur.push(w);
  }
  flush();
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const hold = cues[i].end + 0.35;
    let end = next ? Math.min(hold, next.start - 0.02) : hold;
    if (end < cues[i].start + 0.3) end = next ? Math.max(cues[i].end, Math.min(cues[i].start + 0.3, next.start)) : cues[i].start + 0.3;
    cues[i].end = r2(end);
    cues[i].start = r2(cues[i].start);
    cues[i].lines = splitLines(cues[i].words.map((w) => w.w), lineChars);
  }
  return cues;
}

/**
 * Підпис без голосу (текст до кліпу): ділимо на шматки, які встигають прочитати (≈1,4 с на
 * шматок і не довше maxChars), і показуємо по черзі в межах кліпу.
 */
export function captionChunks(text: string, start: number, end: number, maxChars = 44): Caption[] {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean || !(end - start > 0.3)) return [];
  const sentences = clean.match(/[^.!?…]+[.!?…]*["»”)]?/g)?.map((s) => s.trim()).filter(Boolean) || [clean];
  const chunks: string[] = [];
  for (const p of sentences) {
    if (p.length <= maxChars) { chunks.push(p); continue; }
    let cur = "";
    for (const w of p.split(" ")) {
      if (cur && (cur + " " + w).length > maxChars) { chunks.push(cur); cur = w; }
      else cur = cur ? cur + " " + w : w;
    }
    if (cur) chunks.push(cur);
  }
  const dur = end - start;
  const maxN = Math.max(1, Math.floor(dur / 1.4));
  while (chunks.length > maxN) {
    let bi = 0, bl = Infinity;
    for (let i = 0; i < chunks.length - 1; i++) {
      const l = chunks[i].length + chunks[i + 1].length;
      if (l < bl) { bl = l; bi = i; }
    }
    chunks.splice(bi, 2, chunks[bi] + " " + chunks[bi + 1]);
  }
  const weight = (c: string) => c.length + 8;
  const tot = chunks.reduce((a, c) => a + weight(c), 0);
  let t = start;
  return chunks.map((c) => {
    const d = dur * weight(c) / tot;
    const o = { text: c, start: r2(t), end: r2(t + d - 0.05) };
    t += d;
    return o;
  });
}

/** Перенос тексту підпису в рядки до lineChars (до maxLines, решта - в останній). */
export function wrapText(text: string, lineChars: number, maxLines = 3): string[] {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > lineChars && lines.length < maxLines - 1) { lines.push(cur); cur = w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---- ASS (libass у ffmpeg) ----
/** #RRGGBB → &HAABBGGRR (так кольори пише ASS: альфа й порядок каналів навпаки). */
export function assColor(hex: string, alpha = 0): string {
  const h = String(hex || "#ffffff").replace("#", "").padEnd(6, "0").slice(0, 6).toUpperCase();
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}
/** Текст у подію ASS: фігурні дужки - це теги, бекслеш - екранування, тож їх прибираємо. */
export function assEscape(s: string): string {
  return String(s ?? "").replace(/\\/g, "/").replace(/[{}]/g, "").replace(/\r?\n/g, " ").trim();
}
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

export type SubStyle = {
  font?: string; wordSize?: number; capSize?: number; marginV?: number; highlight?: string;
  // 🔤 v3 - стиль субтитрів бренду (subLook): плашка, ВЕЛИКІ літери, місце в кадрі, обводка, колір бренду
  box?: boolean;      // текст на темній плашці (ASS BorderStyle 3: поле плашки = outline)
  upper?: boolean;    // ВЕЛИКИМИ ЛІТЕРАМИ
  align?: number;     // вирівнювання ASS: 2 - низ (на marginV від низу), 5 - центр кадру
  outline?: number;   // товщина обводки; на плашці - її поле
  accent?: string;    // колір бренду: плашка гачка й мітки «після»
};
export const SUB_DEFAULTS: Required<SubStyle> = {
  font: "DejaVu Sans",
  wordSize: 76,
  capSize: 62,
  // низ кадру зайнятий: у сторіс - поле відповіді (нижні ~20%), у рілсах - підпис і кнопки; тому
  // текст стоїть вище, приблизно на 70% висоти кадру
  marginV: 560,
  highlight: "#FFD23F",
  box: false,
  upper: false,
  align: 2,
  outline: 6,
  accent: "#FFD23F",
};

/** Колір тексту на плашці кольору бренду: на світлій - майже чорний, на темній - білий. */
export function contrastInk(hex: string): string {
  const h = String(hex || "").replace("#", "").padEnd(6, "0").slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // контраст із чорним ≥ контрасту з білим - текст чорний
  return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? "#101014" : "#FFFFFF";
}
/** «#ff2f78», «FF2F78», «#f27» → «#FF2F78»; не колір - null. */
export function normHex(x: unknown): string | null {
  let h = String(x ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(h) ? "#" + h.toUpperCase() : null;
}

/**
 * Шапка ASS зі стилями всього, що малюється поверх відео: субтитри (Word - караоке, Cap - підписи),
 * 🪝 гачок (Hook), мітки «до/після» (LabelA/LabelB) і фінальна картка (End). Одна шапка на все: так
 * субтитри, гачок і картка йдуть одним фільтром ass і не можуть розійтися в часі.
 */
export function assHeader(style: SubStyle = {}): string {
  const st = { ...SUB_DEFAULTS, ...style };
  const white = assColor("#FFFFFF"), ink = assColor("#101014"), shade = assColor("#000000", 0x80);
  // плашка субтитрів - чорна на ~70%: читається на будь-якому кадрі, а кадр під нею видно. Під караоке
  // плашка - окремий шар WordBox (текст картки без кольорових вставок): вставка кольору ділить рядок на
  // шматки, і libass малює кожному свою плашку - на стиках виходили темні смуги
  const plate = assColor("#000000", 0x50);
  const acc = normHex(st.accent) || SUB_DEFAULTS.accent;
  const accInk = assColor(contrastInk(acc)), accBox = assColor(acc), dark = assColor("#101014", 0x30);
  return [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...(st.box ? [
      `Style: Word,${st.font},${st.wordSize},${white},${white},${ink},${shade},-1,0,0,0,100,100,0,0,1,0,0,${st.align},70,70,${st.marginV},1`,
      `Style: WordBox,${st.font},${st.wordSize},${white},${white},${plate},${shade},-1,0,0,0,100,100,0,0,3,${st.outline},0,${st.align},70,70,${st.marginV},1`,
      `Style: Cap,${st.font},${st.capSize},${white},${white},${plate},${shade},-1,0,0,0,100,100,0,0,3,${Math.max(1, st.outline - 1)},0,${st.align},80,80,${st.marginV},1`,
    ] : [
      `Style: Word,${st.font},${st.wordSize},${white},${white},${ink},${shade},-1,0,0,0,100,100,0,0,1,${st.outline},2,${st.align},70,70,${st.marginV},1`,
      `Style: Cap,${st.font},${st.capSize},${white},${white},${ink},${shade},-1,0,0,0,100,100,0,0,1,${Math.max(1, st.outline - 1)},2,${st.align},80,80,${st.marginV},1`,
    ]),
    // гачок - вгорі, але нижче за 240 px: сітка профілю Instagram (3:4) зрізає верх і низ кадру 9:16
    `Style: Hook,${st.font},${HOOK_SIZE},${accInk},${accInk},${accBox},${shade},-1,0,0,0,100,100,0,0,3,18,0,8,80,80,${HOOK_TOP},1`,
    `Style: LabelA,${st.font},58,${white},${white},${dark},${shade},-1,0,0,0,100,100,2,0,3,14,0,7,70,70,300,1`,
    `Style: LabelB,${st.font},58,${accInk},${accInk},${accBox},${shade},-1,0,0,0,100,100,2,0,3,14,0,7,70,70,300,1`,
    `Style: End,${st.font},84,${white},${white},${ink},${shade},-1,0,0,0,100,100,0,0,1,4,2,5,80,80,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");
}
/** Документ ASS: шапка стилів + події (субтитри, гачок, мітки, фінальна картка). */
export function assDoc(style: SubStyle, events: string[]): string {
  return assHeader(style) + "\n" + events.join("\n") + "\n";
}
const up = (s: string, on: boolean) => (on ? s.toLocaleUpperCase() : s);

/**
 * Караоке: картка з 1-2 рядків, слово, яке звучить зараз, - кольором. Подія на кожне слово (а не тег
 * \k): так поточне слово світиться рівно стільки, скільки звучить, а рядки картки не стрибають.
 */
export function karaokeEvents(cues: Cue[], style: SubStyle = {}, highlight = true): string[] {
  const st = { ...SUB_DEFAULTS, ...style };
  const hi = assColor(st.highlight);
  const ev: string[] = [];
  for (const c of cues) {
    const toks = c.words.map((w) => up(assEscape(w.w), st.upper));
    const text = (cur: number) => c.lines.map(([a, b]) => toks.slice(a, b).map((t, k) => (a + k === cur ? `{\\1c${hi}&}${t}{\\r}` : t)).join(" ")).join("\\N");
    // плашка на всю картку - одним шматком, текст на ній невидимий (його малюють події Word над нею)
    if (st.box) ev.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},WordBox,,0,0,0,,{\\1a&HFF&}${text(-1)}`);
    if (!highlight) { ev.push(`Dialogue: 1,${assTime(c.start)},${assTime(c.end)},Word,,0,0,0,,${text(-1)}`); continue; }
    for (let i = 0; i < c.words.length; i++) {
      const s = i === 0 ? c.start : c.words[i].s;
      let e = i + 1 < c.words.length ? c.words[i + 1].s : c.end;
      if (e <= s) e = s + 0.01;
      ev.push(`Dialogue: 1,${assTime(s)},${assTime(e)},Word,,0,0,0,,${text(i)}`);
    }
  }
  return ev;
}
export function karaokeAss(cues: Cue[], style: SubStyle = {}, highlight = true): string {
  return assDoc(style, karaokeEvents(cues, style, highlight));
}

/** Підписи без голосу: кожен шматок - окрема подія, до 3 рядків. */
export function captionEvents(caps: Caption[], style: SubStyle = {}): string[] {
  const st = { ...SUB_DEFAULTS, ...style };
  const lineChars = Math.max(12, Math.round(920 / (st.capSize * (st.upper ? 0.72 : 0.62))));
  return caps.filter((c) => c.text.trim() && c.end > c.start)
    .map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${wrapText(up(assEscape(c.text), st.upper), lineChars).join("\\N")}`);
}
export function captionsAss(caps: Caption[], style: SubStyle = {}): string {
  return assDoc(style, captionEvents(caps, style));
}

// ---- таймлайн: скільки секунд кожному кліпу ----
export type Slot = { avail: number; want?: number | null; still?: boolean };
export const MIN_CLIP = 0.8, STILL_SEC = 3, MAX_CLIP = 20;

/**
 * Без голосу (total не задано): кліп іде стільки, скільки його обрізали (до MAX_CLIP), фото - 3 с,
 * або стільки, скільки попросили (want). З голосом: загальна тривалість = голос, кліпи з want
 * лишаються як є, решта ділить час пропорційно своїй довжині - довгий кліп отримує більше.
 */
export function allocate(slots: Slot[], total?: number | null): number[] {
  const base = slots.map((c) => c.want && c.want > 0 ? Math.max(MIN_CLIP, c.want)
    : c.still ? STILL_SEC : Math.min(Math.max(c.avail, MIN_CLIP), MAX_CLIP));
  if (!total || total <= 0) return base.map(r2);
  const fixed = slots.map((c) => !!(c.want && c.want > 0));
  const fixedSum = base.reduce((a, d, i) => a + (fixed[i] ? d : 0), 0);
  const flex = base.map((_, i) => i).filter((i) => !fixed[i]);
  if (!flex.length) {
    const k = total / (fixedSum || 1);
    return base.map((d) => r2(Math.max(MIN_CLIP, d * k)));
  }
  const rest = Math.max(total - fixedSum, flex.length * MIN_CLIP);
  const flexSum = flex.reduce((a, i) => a + base[i], 0) || 1;
  const out = base.slice();
  for (const i of flex) out[i] = Math.max(MIN_CLIP, rest * base[i] / flexSum);
  return out.map(r2);
}

/** Найбільше сповільнення кліпу: для b-roll 1,6× ще не помітно, далі рух стає «ватним». */
export const MAX_SLOW = 1.6;

/**
 * Як показати кліп тривалістю d, якщо з нього можна взяти avail секунд: довший - обрізаємо, коротший -
 * сповільнюємо до 1,6×, а що не добрали сповільненням - тримаємо останній кадр (це лише залишок
 * округлення: довші нестачі planShots закриває повтором кліпу). Якою частиною кліпу обрізати: повтор k
 * з n бере шматки рівномірно від початку до кінця (щоб повтор не показував те саме), один показ - з
 * середини, або з початку, якщо початок (from) задала людина.
 */
export function fitClip(avail: number, d: number, fromGiven: boolean, k = 0, n = 1): { offset: number; take: number; speed: number; freeze: number } {
  if (avail >= d) {
    const pos = n > 1 ? k / (n - 1) : fromGiven ? 0 : 0.5;
    return { offset: r2((avail - d) * pos), take: r2(d), speed: 1, freeze: 0 };
  }
  const speed = Math.min(MAX_SLOW, d / Math.max(avail, 0.1));
  const freeze = Math.max(0, d - avail * speed);
  return { offset: 0, take: r2(avail), speed: r2(speed), freeze: r2(freeze) };
}

// scores/step - оцінки кадрів кліпу (momentScores): з ними шматок береться там, де кадр найкращий, а не з середини
// fast - ⚡ прискорення (шаблон «Процес»): кліп, довший за шматок у fast разів, іде швидше (×2 - «таймлапс»)
export type ShotClip = { avail: number; still?: boolean; fromGiven?: boolean; scores?: number[] | null; step?: number; fast?: number | null };
export type Shot = { clip: number; start: number; dur: number; offset: number; take: number; speed: number; freeze: number };

/**
 * Кадри монтажу по порядку: який кліп, з якого місця, скільки й з якою швидкістю.
 *
 * 29.09 Олег: голосове 23 с, а відео 7,6 с - кліп сповільнився до 1,6× (12 с) і далі 11,6 с стояв на
 * останньому кадрі: «завис». Тепер, коли кліпу не вистачає навіть сповільненого, він не стоїть, а
 * повторюється. continuous (один голос на весь ролик) - уся послідовність іде по колу (1, 2, 1, 2),
 * як змонтувала б людина; інакше в кліпа свій текст і своє місце - він повторюється там же.
 * Повтор бере інший шматок кліпу, якщо кліп довший за шматок. passes - скільки разів ішло по колу.
 */
export function planShots(clips: ShotClip[], durs: number[], continuous: boolean): { shots: Shot[]; passes: number } {
  // скільки показів треба кліпу, щоб жоден не сповільнювався понад MAX_SLOW (фото тягнеться скільки завгодно)
  const need = clips.map((c, i) => c.still ? 1 : Math.max(1, Math.ceil(durs[i] / (Math.max(c.avail, 0.1) * MAX_SLOW) - 1e-6)));
  const passes = continuous ? Math.max(1, ...need) : 1;
  const order: Array<[number, number, number]> = [];  // [кліп, повтор k, із n]
  if (continuous) { for (let k = 0; k < passes; k++) clips.forEach((_, i) => order.push([i, k, passes])); }
  else clips.forEach((_, i) => { for (let k = 0; k < need[i]; k++) order.push([i, k, need[i]]); });
  const shots: Shot[] = [];
  const wins = new Map<number, number[] | null>();   // найкращі шматки кліпу - раз на кліп
  let t = 0;
  for (const [i, k, n] of order) {
    const c = clips[i];
    const dur = durs[i] / n;
    let fit = c.still ? { offset: 0, take: dur, speed: 1, freeze: 0 } : fitClip(c.avail, dur, !!c.fromGiven, k, n);
    // ⚡ прискорення: шматок у fast разів довший за кадр іде швидше (звук при цьому не йде - він був би «бурундучий»)
    const span = !c.still && c.fast && c.fast > 1 && c.avail >= dur * c.fast ? r2(dur * c.fast) : 0;
    if (span) {
      const pos = n > 1 ? k / (n - 1) : c.fromGiven ? 0 : 0.5;
      fit = { offset: r2((c.avail - span) * pos), take: span, speed: Math.round(1000 / c.fast!) / 1000, freeze: 0 };
    }
    // 🎯 є вибір (кліп довший за шматок) і оцінки кадрів - беремо найкращий шматок, а не середину;
    // початок, який задала людина (from), не чіпаємо
    const want = span || dur;
    if (!c.still && !c.fromGiven && c.scores?.length && (fit.speed === 1 || span) && c.avail > want + 0.05) {
      if (!wins.has(i)) wins.set(i, bestWindows(c.scores, c.step || 0.25, c.avail, want, n));
      const w = wins.get(i);
      if (w && w[k] != null) fit = { ...fit, offset: r2(w[k]) };
    }
    shots.push({ clip: i, start: t, dur, ...fit });
    t += dur;
  }
  return { shots, passes: continuous ? passes : Math.max(1, ...need) };
}

// ---------------- 🎯 найкращі моменти кліпу ----------------
// 30.09 Олег: «рушій не дивиться відео і не шукає найкращі моменти (просто бере середину кліпу)».
// Тепер дивиться: ffmpeg проходить кліп 4 кадри на секунду і міряє, наскільки кадр різкий (blurdetect),
// чи не темний/пересвічений (signalstats YAVG) і скільки руху від попереднього кадру (YDIF): трохи руху -
// живий кадр, ривок камери - погано. Безкоштовно, без моделі.
export type FrameStat = { t: number; ydif: number; yavg: number; blur: number | null };
const quant = (arr: number[], p: number): number => {
  if (!arr.length) return 0;
  const srt = [...arr].sort((a, b) => a - b);
  return srt[Math.min(srt.length - 1, Math.max(0, Math.round((srt.length - 1) * p)))];
};
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Вивід ffmpeg metadata=print: блок «frame:N pts:… pts_time:T», далі рядки lavfi.*=значення. */
export function parseFrameStats(txt: string): FrameStat[] {
  const out: FrameStat[] = [];
  let cur: FrameStat | null = null;
  for (const line of String(txt || "").split(/\r?\n/)) {
    const m = /^frame:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*([0-9.]+)/.exec(line);
    if (m) { if (cur) out.push(cur); cur = { t: Number(m[1]), ydif: 0, yavg: 128, blur: null }; continue; }
    const kv = cur && /^lavfi\.([A-Za-z_.]+)=(-?[0-9.]+(?:e[-+]?\d+)?)/.exec(line.trim());
    if (!cur || !kv) continue;
    const v = Number(kv[2]);
    if (!Number.isFinite(v)) continue;
    if (kv[1] === "signalstats.YDIF") cur.ydif = v;
    else if (kv[1] === "signalstats.YAVG") cur.yavg = v;
    else if (kv[1] === "blur") cur.blur = v;
  }
  if (cur) out.push(cur);
  return out;
}

/** Оцінка кожного кадру 0..1: різкий, нормально освітлений, з рухом, але без ривка камери. Перші й останні
 *  пів секунди кліпу - нижче: там зазвичай натискають «запис» і опускають телефон. */
export function momentScores(stats: FrameStat[], dur: number): number[] {
  if (!stats.length) return [];
  const med = quant(stats.map((s) => s.ydif), 0.5);
  const blurs = stats.map((s) => s.blur).filter((b): b is number => b != null && Number.isFinite(b));
  const b5 = quant(blurs, 0.05), b95 = quant(blurs, 0.95);
  const jerk = Math.max(2.5 * med, 6);
  return stats.map((s) => {
    // blurdetect мовчить на кадрі без жодного контуру (темрява, стіна) - такий кадр нецікавий; якщо ж він не
    // дав жодного значення на весь кліп (старий ffmpeg) - різкість не враховуємо
    const sharp = !blurs.length ? 0.6 : s.blur == null ? 0.15 : b95 - b5 < 1e-6 ? 0.6 : 1 - clamp01((s.blur - b5) / (b95 - b5));
    const shake = clamp01((s.ydif - jerk) / jerk);
    const motion = clamp01(s.ydif / Math.max(1.5 * med, 1.5));
    // яскравість у відео - 16..235 (чорний = 16): темніше ~18% - «темно», світліше ~94% - «пересвічено»
    const lum = clamp01((s.yavg - 16) / 219);
    const expo = lum < 0.18 ? lum / 0.18 : lum > 0.94 ? clamp01((1 - lum) / 0.06) : 1;
    const edge = s.t < 0.5 || s.t > dur - 0.5 ? 0.6 : 1;
    return Math.max(0, 0.4 * sharp + 0.2 * motion + 0.4 * expo - 0.7 * shake) * edge;
  });
}

/**
 * n найкращих шматків довжиною take із кліпу довжиною avail за оцінками кадрів (крок step с): шматки по
 * можливості не перекриваються (для повторів по колу - щоразу інший найкращий), початки - по порядку в
 * кліпі. null - оцінок нема або всі шматки однакові (тоді лишається звична середина).
 */
export function bestWindows(scores: number[], step: number, avail: number, take: number, n = 1): number[] | null {
  if (!scores.length || !(step > 0) || !(take > 0)) return null;
  const room = avail - take;
  if (room <= 0.05) return Array.from({ length: n }, () => 0);
  // початок шматка важить трохи більше за кінець (1,2 → 0,8): перші секунди кадру - те, що людина
  // бачить на стику (а в першому кадрі ролику - гачок); серед рівних шматків кращий той, що з доброго починається
  const pre = [0], preI = [0];
  scores.forEach((x, i) => { pre.push(pre[i] + x); preI.push(preI[i] + i * x); });
  const idx = (t: number) => Math.min(scores.length, Math.max(0, Math.round(t / step)));
  const nC = Math.max(2, Math.min(400, Math.floor(room / step) + 1));
  const cand: Array<{ s: number; v: number }> = [];
  for (let c = 0; c < nC; c++) {
    const st = room * c / (nC - 1);
    const a = idx(st), b = Math.max(a + 1, idx(st + take));
    const bb = Math.min(b, scores.length), aa = Math.min(a, bb - 1), L = Math.max(1, bb - aa);
    const S = pre[bb] - pre[aa], SI = preI[bb] - preI[aa];
    // Σ (1.2 - 0.4·(i-aa)/L)·s_i  /  Σ (1.2 - 0.4·(i-aa)/L)
    const num = 1.2 * S - (0.4 / L) * (SI - aa * S);
    const den = 1.2 * L - (0.4 / L) * (L * (L - 1) / 2);
    cand.push({ s: st, v: num / Math.max(1e-9, den) });
  }
  const vs = cand.map((c) => c.v);
  if (Math.max(...vs) - Math.min(...vs) < 0.02) return null;
  const picked: number[] = [];
  for (let k = 0; k < n; k++) {
    let best: { s: number; v: number } | null = null;
    for (const c of cand) {
      if (picked.some((p) => Math.abs(p - c.s) < take * 0.7)) continue;
      if (!best || c.v > best.v + 1e-9) best = c;
    }
    if (!best) break;
    picked.push(best.s);
  }
  while (picked.length < n) picked.push(n > 1 ? room * picked.length / (n - 1) : room / 2);
  return picked.map((x) => Math.round(x * 1000) / 1000).sort((a, b) => a - b);
}

// ---------------- ✨ переходи між кліпами ----------------
// Кожен кадр (крім першого) заходить переходом xfade із ОСТАННЬОГО кадру попереднього: попередній кліп на
// мить зупиняється й перетікає в новий. Так переходу не треба перекривати сегменти на таймлайні (голос і
// субтитри стоять де стояли) і не треба відкривати всі кліпи разом (сервер спільний, памʼять береже).
export type TransitionMode = "none" | "fade" | "slide" | "zoom" | "flash" | "mix";
export const TRANSITIONS: Record<TransitionMode, string> = {
  none: "без переходів", fade: "плавні", slide: "зсув", zoom: "наближення", flash: "спалах", mix: "мікс",
};
const XF: Record<string, string> = { fade: "fade", slide: "slideleft", zoom: "zoomin", flash: "fadewhite" };
const MIX = ["fade", "slideleft", "zoomin", "smoothleft"];
export function normTransition(x: unknown, dflt: TransitionMode = "fade"): TransitionMode {
  const v = String(x ?? "").trim().toLowerCase();
  return (v in TRANSITIONS ? v : dflt) as TransitionMode;
}
/** xfade-перехід на вході кадру k (k ≥ 1); null - різкий стик. */
export function transitionAt(mode: TransitionMode, k: number): string | null {
  if (mode === "none" || k < 1) return null;
  if (mode === "mix") return MIX[(k - 1) % MIX.length];
  return XF[mode] || "fade";
}
/** Скільки триває перехід: до 0,3 с, не більше третини кадру; зовсім короткий кадр - без переходу. */
export function transitionDur(shotDur: number): number {
  return shotDur < 0.6 ? 0 : Math.round(Math.min(0.3, shotDur * 0.35) * 1000) / 1000;
}

// ---------------- 🎵 фонова музика ----------------
export type MusicMood = "calm" | "upbeat" | "inspiring" | "energetic" | "warm";
export const MUSIC_MOODS: Record<MusicMood, { label: string; prompt: string }> = {
  calm: { label: "🌿 Спокійна", prompt: "calm, soft acoustic guitar and light piano, gentle and relaxed" },
  upbeat: { label: "☀️ Бадьора", prompt: "upbeat, bright modern pop with light claps and warm synths, positive" },
  inspiring: { label: "✨ Натхненна", prompt: "inspiring, uplifting cinematic with piano and soft strings, slowly building" },
  energetic: { label: "⚡ Енергійна", prompt: "energetic, punchy modern electronic beat, driving" },
  warm: { label: "☕ Тепла", prompt: "warm lo-fi, mellow keys, soft drums, cozy" },
};
export function normMood(x: unknown): MusicMood | null {
  const v = String(x ?? "").trim().toLowerCase();
  return v in MUSIC_MOODS ? (v as MusicMood) : null;
}
/** Промт для AI-музики. Без назв брендів, імен і артистів - ElevenLabs такі промти відхиляє. */
export function musicPrompt(mood: MusicMood): string {
  return `Instrumental background music for a short vertical social media video. ${MUSIC_MOODS[mood].prompt}. Steady tempo, no vocals, no lyrics, mixed to sit quietly under a voiceover.`;
}

/**
 * Звук фіналу. Вхід 0 - склеєні кліпи (їхній звук), далі - голос (якщо є) і музика (якщо є).
 * Музика: по колу на весь ролик, мʼякий початок і згасання в кінці; під голосом (озвучка чи мова в кліпах)
 * вона сама притихає (sidechaincompress), у паузах повертається. alimiter - щоб сума не хрипіла.
 */
export function audioGraph(o: { total: number; voice: number | null; music: number | null; keep: number; duckOnClips: boolean; musicVol?: number }): string {
  const T = o.total.toFixed(3);
  const L = ["alimiter=limit=0.95", "aresample=48000"].join(",");
  if (o.music == null) {
    return o.voice == null ? "[0:a]anull[a]"
      : `[0:a]volume=${o.keep}[b];[${o.voice}:a]anull[vo];[b][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,aresample=48000[a]`;
  }
  const duck = o.voice != null || o.duckOnClips;
  const mv = o.musicVol ?? (duck ? 0.35 : 0.8);
  const fadeOut = Math.max(0, o.total - 1.8).toFixed(3);
  const m = `[${o.music}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${T},asetpts=N/SR/TB,afade=t=in:st=0:d=0.8,afade=t=out:st=${fadeOut}:d=1.8,volume=${mv}[m0]`;
  // під голосом музика тихішає на ~12 дБ (не зникає зовсім) і повертається за 0,35 с після паузи
  const comp = "sidechaincompress=threshold=0.03:ratio=10:attack=10:release=350";
  if (o.voice != null) {
    return `[0:a]volume=${o.keep}[b];[${o.voice}:a]asplit=2[vo][vsc];${m};[m0][vsc]${comp}[md];[b][vo][md]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,${L}[a]`;
  }
  if (o.duckOnClips) return `[0:a]asplit=2[b][bsc];${m};[m0][bsc]${comp}[md];[b][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${L}[a]`;
  return `[0:a]volume=${o.keep}[b];${m};[b][m0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${L}[a]`;
}

// ---- де різати довгу сторіс ----
/**
 * Сторіс-відео - до 60 с (межа Instagram), тож довше ріжемо на частини. Ріжемо в найпізнішому
 * «безпечному» місці перед межею: на стику кліпів або в паузі між картками субтитрів - але не
 * посеред картки. Частина коротша за min не лишається.
 */
export function splitPoints(total: number, bounds: number[], cues: Array<{ start: number; end: number }> = [], max = 59.5, min = 3): number[] {
  const inCue = (t: number) => cues.some((c) => t > c.start + 0.01 && t < c.end - 0.01);
  const gaps = cues.slice(0, -1).map((c, i) => ({ a: c.end, b: cues[i + 1].start })).filter((g) => g.b - g.a >= 0.15).map((g) => (g.a + g.b) / 2);
  const cands = [...bounds.filter((b) => !inCue(b)), ...gaps].sort((a, b) => a - b);
  const cuts: number[] = [];
  let segStart = 0;
  while (total - segStart > max) {
    const limit = segStart + max;
    const ok = cands.filter((b) => b > segStart + min && b <= limit && total - b >= min);
    const cut = ok.length ? ok[ok.length - 1] : Math.min(limit, total - min);
    cuts.push(r2(cut));
    segStart = cut;
  }
  return cuts;
}

/** Суцільний текст зі слів (для підпису поста й для відповіді конектора). */
export const wordsText = (words: Word[]): string => words.map((w) => w.w).join(" ").replace(/\s+([,.!?…:;])/g, "$1").trim();

/**
 * Свій текст автора без AI-голосу стає підписами: ділимо його по реченнях на n шматків (по кліпу),
 * рівних за довжиною, порядок речень не міняємо. Речень менше за кліпи - решта кліпів без підпису.
 */
export function spreadText(text: string, n: number): string[] {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean || n <= 0) return Array.from({ length: Math.max(0, n) }, () => "");
  const sent = clean.match(/[^.!?…]+[.!?…]*["»”)]?/g)?.map((x) => x.trim()).filter(Boolean) || [clean];
  const out: string[] = Array.from({ length: n }, () => "");
  const m = sent.length;
  // речень не більше, ніж кліпів - розкладаємо рівномірно (перше - завжди на першому кліпі)
  if (m <= n) { sent.forEach((x, i) => { out[Math.floor(i * n / m)] = x; }); return out; }
  // більше - суцільні групи, рівні за довжиною, і жоден кліп без тексту
  const total = sent.reduce((a, x) => a + x.length, 0);
  let acc = 0, prev = -1;
  sent.forEach((x, i) => {
    const ideal = Math.floor(acc / total * n);
    const k = Math.min(Math.max(ideal, prev, n - (m - i)), prev + 1, n - 1);
    out[k] = out[k] ? out[k] + " " + x : x;
    acc += x.length;
    prev = k;
  });
  return out;
}

// =====================================================================================================
// 🎬 Монтаж v3 (30.09, запит Олега: «гачок і тп., шаблони - до/після як один із них, вирізати паузи
// й «еее», обкладинка, стилі субтитрів під бренд»). Усе, що тут, - чисте й під юнітами; ffmpeg - у montage.ts.
// =====================================================================================================

// ---------------- 🔤 стилі субтитрів бренду ----------------
export type SubPreset = "classic" | "brand" | "box" | "big" | "minimal";
export const SUB_PRESETS: Record<SubPreset, { label: string; hint: string }> = {
  classic: { label: "Класичні", hint: "білий жирний текст з обводкою, слово, що звучить, - жовтим" },
  brand: { label: "Колір бренду", hint: "як класичні, але слово, що звучить, - кольором бренду" },
  box: { label: "На плашці", hint: "текст на темній плашці - читається на будь-якому кадрі" },
  big: { label: "Великі слова", hint: "по 1-2 слова великими літерами посередині кадру" },
  minimal: { label: "Мінімальні", hint: "менший білий текст, без підсвічування слова" },
};
export const SUB_ORDER: SubPreset[] = ["classic", "brand", "box", "big", "minimal"];
export function normSubPreset(x: unknown, dflt: SubPreset = "classic"): SubPreset {
  const v = String(x ?? "").trim().toLowerCase();
  return (v in SUB_PRESETS ? v : dflt) as SubPreset;
}
export type SubPos = "low" | "middle";
export const normSubPos = (x: unknown): SubPos => (String(x ?? "").trim().toLowerCase() === "middle" ? "middle" : "low");

export type CueOpts = { maxChars?: number; maxWords?: number; maxDur?: number; lineChars?: number };
export type SubLook = { style: SubStyle; cue: CueOpts; highlight: boolean };
/**
 * Стиль субтитрів → що саме отримує libass: розмір, плашка, місце, колір поточного слова, а для «великих
 * слів» - ще й скільки слів на картці. color - колір бренду (для «Колір бренду», «великих слів», гачка й
 * міток); pos - «низ» (над полем відповіді сторіс і підписом рілса) чи «центр».
 */
export function subLook(preset: SubPreset, color?: string | null, pos?: SubPos | null): SubLook {
  const accent = normHex(color) || SUB_DEFAULTS.accent;
  const base: SubStyle = { accent, ...(pos === "middle" ? { align: 5, marginV: 0 } : {}) };
  switch (preset) {
    case "brand": return { style: { ...base, highlight: accent }, cue: {}, highlight: true };
    case "box": return { style: { ...base, box: true, wordSize: 66, capSize: 58, outline: 14, highlight: accent }, cue: { maxChars: 26, lineChars: 20 }, highlight: true };
    case "big": return { style: { ...base, align: 5, marginV: 0, wordSize: 112, capSize: 92, upper: true, outline: 8, highlight: accent }, cue: { maxWords: 2, maxChars: 14, lineChars: 12, maxDur: 1.4 }, highlight: true };
    case "minimal": return { style: { ...base, wordSize: 60, capSize: 54, outline: 3 }, cue: { maxChars: 36, lineChars: 24 }, highlight: false };
    default: return { style: base, cue: {}, highlight: true };
  }
}

// ---------------- 🪝 гачок: великий текст у перші секунди ----------------
// Верх тексту на 430 px із 1920 (22%): вище - зона, яку сітка профілю Instagram (3:4) зрізає, і
// іконки Stories/Reels; три рядки по 86 px закінчуються на ~38% - до субтитрів (70%) далеко.
export const HOOK_SIZE = 86, HOOK_TOP = 430;
export const HOOK_LINE_CHARS = 17;
/** Скільки тримати гачок: ~2,6 с, на короткому ролику - не більше 40% його довжини. */
export function hookSpan(total: number): number {
  return Math.round(Math.max(1.2, Math.min(2.6, total * 0.4)) * 100) / 100;
}
/** Подія гачка: плашка кольору бренду, до 3 рядків, зʼявляється «пружинкою» і гасне. */
export function hookEvents(text: string, start: number, end: number): string[] {
  const clean = assEscape(text).replace(/\s+/g, " ").trim();
  if (!clean || !(end > start)) return [];
  const lines = wrapText(clean, HOOK_LINE_CHARS, 3);
  const fx = "{\\fad(160,260)\\fscx86\\fscy86\\t(0,220,\\fscx100\\fscy100)}";
  return [`Dialogue: 2,${assTime(start)},${assTime(end)},Hook,,0,0,0,,${fx}${lines.join("\\N")}`];
}
/** Гачок без моделі: перше речення тексту ролика, до maxWords слів (довше - обрізаємо з «…»). */
export function hookFallback(text: string, maxWords = 7): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const first = (clean.match(/^[^.!?…]+[.!?…]?/)?.[0] || clean).trim();
  const words = first.split(" ").filter(Boolean);
  if (words.length <= maxWords) return first.replace(/[.,;:]$/, "");
  return words.slice(0, maxWords).join(" ").replace(/[.,;:!?]$/, "") + "…";
}
/** Відповідь моделі → гачок: без лапок, хештегів і емодзі-хвостів, до 60 символів. */
export function cleanHook(raw: unknown): string {
  let s = String(raw ?? "").replace(/\s+/g, " ").replace(/\s#\S+/g, "").trim();
  s = s.replace(/^["«„“'`]+|["»”“'`]+$/g, "").trim();
  if (s.length > 60) s = s.slice(0, 60).replace(/\s+\S*$/, "") + "…";
  return s;
}

// ---------------- ↔️ «до / після» ----------------
export const BA_WORDS: Record<string, { before: string; after: string; hook: string }> = {
  uk: { before: "ДО", after: "ПІСЛЯ", hook: "До і після" },
  cs: { before: "PŘED", after: "PO", hook: "Před a po" },
  sk: { before: "PRED", after: "PO", hook: "Pred a po" },
  pl: { before: "PRZED", after: "PO", hook: "Przed i po" },
  de: { before: "VORHER", after: "NACHHER", hook: "Vorher und nachher" },
  en: { before: "BEFORE", after: "AFTER", hook: "Before and after" },
  es: { before: "ANTES", after: "DESPUÉS", hook: "Antes y después" },
  fr: { before: "AVANT", after: "APRÈS", hook: "Avant et après" },
  it: { before: "PRIMA", after: "DOPO", hook: "Prima e dopo" },
  ru: { before: "ДО", after: "ПОСЛЕ", hook: "До и после" },
};
export const baWords = (lang: string) => BA_WORDS[lang] || BA_WORDS.uk;
/** Скільки перших кліпів - «до»: як сказала людина (1..n-1), інакше перша половина (з непарних - більша). */
export function baSplit(n: number, before?: number | null): number {
  if (n < 2) return n;
  const b = Math.round(Number(before));
  return Number.isFinite(b) && b >= 1 && b <= n - 1 ? b : Math.ceil(n / 2);
}
/** Мітки «ДО»/«ПІСЛЯ» вгорі зліва (y - відступ зверху; кадр порівняння ставить другу мітку на свою половину). */
export function labelEvents(items: Array<{ text: string; start: number; end: number; after?: boolean; y?: number }>): string[] {
  return items.filter((x) => x.text.trim() && x.end > x.start).map((x) =>
    `Dialogue: 1,${assTime(x.start)},${assTime(x.end)},${x.after ? "LabelB" : "LabelA"},,0,0,${x.y ?? 0},,{\\fad(150,150)}${assEscape(x.text)}`);
}

// ---------------- 🏁 фінальна картка ----------------
export type EndText = { title: string; sub: string };
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Що написати на фінальній картці: свій текст бренду («Назва» чи «Назва | рядок 2» / два рядки), інакше
 * назва кабінету (не пошта й не службова назва) і нік у мережі. Нічого путнього - null (картки не буде).
 */
export function endCardText(o: { custom?: string | null; title?: string | null; handle?: string | null }): EndText | null {
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);
  const handle = String(o.handle || "").trim().replace(/^@?/, "@").replace(/^@$/, "");
  const custom = String(o.custom || "").trim();
  if (custom) {
    const [a, ...rest] = custom.split(/\s*\n\s*|\s+\|\s+/).map((x) => x.trim()).filter(Boolean);
    return a ? { title: cut(a, 40), sub: cut(rest.join(" · "), 60) } : null;
  }
  let title = String(o.title || "").trim();
  if (EMAILISH.test(title) || /^user:/i.test(title)) title = "";
  if (!title) return handle ? { title: handle, sub: "" } : null;
  const [main, ...rest] = title.split(/\s+\|\s+/);
  return { title: cut(main.trim(), 40), sub: cut([...rest.map((x) => x.trim()), handle].filter(Boolean).join(" · "), 60) };
}
export const END_SEC = 2.2;
/** Події фінальної картки: назва великим, другий рядок меншим і кольором бренду, плавна поява. */
export function endEvents(t: EndText, start: number, end: number, accent = SUB_DEFAULTS.accent): string[] {
  if (!t.title || !(end > start)) return [];
  const a = assColor(normHex(accent) || SUB_DEFAULTS.accent);
  // довга назва - дрібніше, а не переносом посеред назви: 17 символів влазять у рядок кеглем 84, далі кегль
  // зменшується до 56 (≈27 символів), і лише тоді - другий рядок
  const t0 = assEscape(t.title);
  const fs = Math.max(56, Math.min(84, Math.round(84 * 17 / Math.max(17, t0.length))));
  const title = `{\\fs${fs}}` + wrapText(t0, Math.floor(920 / (fs * 0.6)), 2).join("\\N");
  const sub = t.sub ? `\\N{\\fs50\\b0\\1c${a}&}${wrapText(assEscape(t.sub), 30, 2).join("\\N")}` : "";
  return [`Dialogue: 1,${assTime(start)},${assTime(end)},End,,0,0,0,,{\\fad(250,0)}${title}${sub}`];
}

// ---------------- ✂️ вирізати паузи й «еее» ----------------
// Deepgram і Whisper «еее» здебільшого не пишуть зовсім - на його місці лишається дірка між словами, і вона
// ріжеться як пауза. Якщо ж розшифровка повернула саме «еее» чи «ммм» словом - воно теж пауза.
const FILLER = /^(?:[еэe]+|[еэe]+[мm]+|[мm]{2,}|[аa]{3,}|[хh][мm]+|u+h+|u+m+|e+r+m*|e+h+m*|ы+|и{3,})$/i;
export const isFiller = (w: string): boolean => FILLER.test(String(w || "").toLowerCase().replace(/[^\p{L}]/gu, ""));
export type Keep = [number, number];
/**
 * Які шматки кліпу лишити, щоб прибрати паузи між словами (довші за maxGap) і «еее»: запас до слова
 * padIn і після padOut - щоб не зʼїсти початок і хвіст звуку; тиша до першого слова - до lead, після
 * останнього - до tail. null - різати нема чого (мови нема, одне слово або виграш < minSave).
 */
export function speechKeeps(words: Word[], dur: number, o: { maxGap?: number; padIn?: number; padOut?: number; lead?: number; tail?: number; minSave?: number } = {}): Keep[] | null {
  const maxGap = o.maxGap ?? 0.45, padIn = o.padIn ?? 0.08, padOut = o.padOut ?? 0.14, lead = o.lead ?? 0.2, tail = o.tail ?? 0.35, minSave = o.minSave ?? 0.4;
  const ws = words.filter((w) => w.w && !isFiller(w.w) && w.e > w.s && w.s < dur).sort((a, b) => a.s - b.s);
  if (ws.length < 2 || !(dur > 0)) return null;
  const raw: Keep[] = [];
  let a = ws[0].s - lead, b = ws[0].e;
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i];
    if (w.s - b > maxGap) { raw.push([a, b + padOut]); a = w.s - padIn; }
    b = Math.max(b, w.e);
  }
  raw.push([a, b + tail]);
  const out: Keep[] = [];
  for (const [x, y] of raw) {
    const s = Math.max(0, x), e = Math.min(dur, y);
    if (!(e > s)) continue;
    const last = out[out.length - 1];
    if (last && s <= last[1] + 0.05) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  const kept = out.reduce((t, [x, y]) => t + (y - x), 0);
  if (!out.length || kept < 0.6 || dur - kept < minSave) return null;
  return out.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000] as Keep);
}
/** Скільки секунд лишиться після вирізання. */
export const keptSec = (k: Keep[]): number => Math.round(k.reduce((t, [a, b]) => t + (b - a), 0) * 100) / 100;

// ---------------- 🧩 шаблони монтажу ----------------
export type TemplateId = "standard" | "before_after" | "talking" | "process";
export const TEMPLATES: Record<TemplateId, { label: string; hint: string }> = {
  standard: { label: "🎬 Стандарт", hint: "кліпи по черзі, найкращі моменти, плавні переходи" },
  before_after: { label: "↔️ До / після", hint: "спершу кліпи «до», потім «після»: мітки, перехід-шторка і кадр порівняння наприкінці" },
  talking: { label: "🗣 Говорю в камеру", hint: "мова цілком, без пауз і «еее», субтитри слово в слово, без переходів" },
  process: { label: "⚡ Процес", hint: "короткі прискорені шматки роботи, динамічні переходи - краще з музикою" },
};
export const TEMPLATE_ORDER: TemplateId[] = ["standard", "before_after", "talking", "process"];
export function normTemplate(x: unknown): TemplateId {
  const v = String(x ?? "").trim().toLowerCase().replace(/[-\s/]+/g, "_");
  return (v in TEMPLATES ? v : v === "beforeafter" || v === "ba" ? "before_after" : "standard") as TemplateId;
}
export type TemplatePlan = {
  transition: TransitionMode;   // переходи всередині ролика
  smart: boolean;               // найкращі моменти кліпу
  cut: boolean;                 // вирізати паузи в кліпах, де говорять (voice: clips)
  wholeSpeech: boolean;         // кліп, де говорять, - цілком (не 20 с з найкращого місця)
  clipSec: number | null;       // скільки секунд на кліп без голосу (null - скільки є, до 20 с)
  fast: number | null;          // прискорення кліпів без мови (×2 - «таймлапс»)
  compare: boolean;             // кадр порівняння «до | після» перед фінальною карткою
  labels: boolean;              // мітки «до»/«після»
  boundary: string | null;      // перехід на стику «до → після»
  mood: MusicMood | null;       // яка музика пасує (порада, сама не вмикається - вона платна)
};
export function templatePlan(t: TemplateId): TemplatePlan {
  const base: TemplatePlan = { transition: "fade", smart: true, cut: true, wholeSpeech: false, clipSec: null, fast: null, compare: false, labels: false, boundary: null, mood: null };
  if (t === "before_after") return { ...base, compare: true, labels: true, boundary: "wipeleft", mood: "upbeat" };
  if (t === "talking") return { ...base, transition: "none", smart: false, wholeSpeech: true };
  if (t === "process") return { ...base, transition: "mix", cut: false, clipSec: 2.2, fast: 2, mood: "energetic" };
  return base;
}
/** Перехід на вході кадру k: на стику «до → після» - шторка довша (до 0,6 с), інакше як задано режимом. */
export function transitionFor(mode: TransitionMode, k: number, shotDur: number, boundary?: { at: number; name: string } | null): { name: string; d: number } | null {
  if (k < 1) return null;
  if (boundary && k === boundary.at) {
    const d = shotDur < 0.8 ? 0 : Math.round(Math.min(0.6, shotDur * 0.4) * 1000) / 1000;
    return d > 0 ? { name: boundary.name, d } : null;
  }
  const name = transitionAt(mode, k);
  const d = name ? transitionDur(shotDur) : 0;
  return name && d > 0 ? { name, d } : null;
}

// ---------------- 🎨 стиль відео бренду (налаштування montage_style) ----------------
export type MontageStyle = { subtitle: SubPreset; color: string; position: SubPos; hook: boolean; end: boolean; endText: string; cut: boolean };
/** Збережене в налаштуваннях → повний стиль із типовими значеннями (гачок, фінальна картка й вирізання пауз - увімкнено). */
export function normMontageStyle(raw: unknown): MontageStyle {
  const o: any = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    subtitle: normSubPreset(o.subtitle),
    color: normHex(o.color) || SUB_DEFAULTS.accent,
    position: normSubPos(o.position),
    hook: o.hook !== false,
    end: o.end !== false,
    endText: String(o.endText ?? o.end_text ?? "").replace(/\r/g, "").trim().slice(0, 200),
    cut: o.cut !== false,
  };
}
