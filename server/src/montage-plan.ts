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

export type SubStyle = { font?: string; wordSize?: number; capSize?: number; marginV?: number; highlight?: string };
export const SUB_DEFAULTS: Required<SubStyle> = {
  font: "DejaVu Sans",
  wordSize: 76,
  capSize: 62,
  // низ кадру зайнятий: у сторіс - поле відповіді (нижні ~20%), у рілсах - підпис і кнопки; тому
  // текст стоїть вище, приблизно на 70% висоти кадру
  marginV: 560,
  highlight: "#FFD23F",
};

function assHeader(st: Required<SubStyle>): string {
  const white = assColor("#FFFFFF"), ink = assColor("#101014"), shade = assColor("#000000", 0x80);
  return [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Word,${st.font},${st.wordSize},${white},${white},${ink},${shade},-1,0,0,0,100,100,0,0,1,6,2,2,70,70,${st.marginV},1`,
    `Style: Cap,${st.font},${st.capSize},${white},${white},${ink},${shade},-1,0,0,0,100,100,0,0,1,5,2,2,80,80,${st.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");
}

/**
 * Караоке: картка з 1-2 рядків, слово, яке звучить зараз, - кольором. Подія на кожне слово (а не тег
 * \k): так поточне слово світиться рівно стільки, скільки звучить, а рядки картки не стрибають.
 */
export function karaokeAss(cues: Cue[], style: SubStyle = {}, highlight = true): string {
  const st = { ...SUB_DEFAULTS, ...style };
  const hi = assColor(st.highlight);
  const ev: string[] = [];
  for (const c of cues) {
    const toks = c.words.map((w) => assEscape(w.w));
    const text = (cur: number) => c.lines.map(([a, b]) => toks.slice(a, b).map((t, k) => (a + k === cur ? `{\\1c${hi}&}${t}{\\r}` : t)).join(" ")).join("\\N");
    if (!highlight) { ev.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Word,,0,0,0,,${text(-1)}`); continue; }
    for (let i = 0; i < c.words.length; i++) {
      const s = i === 0 ? c.start : c.words[i].s;
      let e = i + 1 < c.words.length ? c.words[i + 1].s : c.end;
      if (e <= s) e = s + 0.01;
      ev.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Word,,0,0,0,,${text(i)}`);
    }
  }
  return assHeader(st) + "\n" + ev.join("\n") + "\n";
}

/** Підписи без голосу: кожен шматок - окрема подія, до 3 рядків. */
export function captionsAss(caps: Caption[], style: SubStyle = {}): string {
  const st = { ...SUB_DEFAULTS, ...style };
  const lineChars = Math.max(12, Math.round(920 / (st.capSize * 0.62)));
  const ev = caps.filter((c) => c.text.trim() && c.end > c.start)
    .map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${wrapText(assEscape(c.text), lineChars).join("\\N")}`);
  return assHeader(st) + "\n" + ev.join("\n") + "\n";
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

/**
 * Як показати кліп тривалістю d, якщо з нього можна взяти avail секунд: довший - обрізаємо (з
 * середини, або з from, якщо його задали), коротший - сповільнюємо до 1,6× (для b-roll непомітно),
 * а що не добрали сповільненням - тримаємо останній кадр.
 */
export function fitClip(avail: number, d: number, fromGiven: boolean): { offset: number; take: number; speed: number; freeze: number } {
  if (avail >= d) return { offset: fromGiven ? 0 : r2((avail - d) / 2), take: r2(d), speed: 1, freeze: 0 };
  const speed = Math.min(1.6, d / Math.max(avail, 0.1));
  const freeze = Math.max(0, d - avail * speed);
  return { offset: 0, take: r2(avail), speed: r2(speed), freeze: r2(freeze) };
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
