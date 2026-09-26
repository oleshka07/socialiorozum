// Чисті хелпери без залежностей (щоб їх могли імпортувати і бот, і роути, і юніти).

// Чи схожий текст із чату на ГОТОВИЙ пост, а не на думку-заготовку для AI.
// Ознаки: достатня довжина або кілька речень. Помилитись у бік «готовий» безпечніше: людина
// побачить свій текст як є і сама натисне «переписати», а от втратити свій текст на користь
// AI-варіанту (фідбек тестера: «написав одне - опублікувалось інше») значно гірше.
export function looksLikeReadyPost(text: string): boolean {
  const t = (text || "").trim();
  if (t.length >= 220) return true;
  const sentences = t.split(/[.!?…]+\s+/).filter((s) => s.trim().length >= 12).length;
  return t.length >= 90 && sentences >= 2;
}

// n часів публікації, рівномірно між from..to годинами (за замовч. 08:00-22:00), формат HH:MM.
// Для «кожні 3 години в Threads»: 8 постів/день → 08:00, 10:00, … 22:00. n=1 → середина вікна.
export function spreadTimes(n: number, from = 8, to = 22): string[] {
  const k = Math.max(1, Math.min(24, Math.round(n) || 1));
  if (k === 1) return [`${String(Math.round((from + to) / 2)).padStart(2, "0")}:00`];
  const step = (to - from) / (k - 1);
  const out: string[] = [];
  for (let i = 0; i < k; i++) {
    const mins = Math.round((from + step * i) * 60 / 15) * 15; // крок 15 хв
    out.push(`${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`);
  }
  return out;
}

// ---- Режим «Написати про тему»: ключові слова й кути ----

const TOPIC_STOP = new Set(["пост", "пости", "постів", "зроби", "зробити", "напиши", "написати", "план", "тред", "тредс", "threads", "телеграм", "telegram", "instagram", "інста", "дуже", "тощо", "також", "який", "яка", "які", "яке", "його", "їхн", "цього", "того", "щоб", "коли", "тема", "теми", "про", "для", "важливість", "актуальність"]);
// Грубий стем: перші 6 літер довгого слова («клієнтську»/«клієнтів» → «клієнт»), коротшому - без останньої
// («базу»/«база» → «баз»). Ловить відмінки без морфологічного словника; трохи шуму краще за нуль збігів.
export function topicKeywords(topic: string): string[] {
  const out: string[] = [];
  for (const w of String(topic || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 4 || TOPIC_STOP.has(w)) continue;
    const stem = w.length >= 7 ? w.slice(0, 6) : w.slice(0, Math.max(3, w.length - 1));
    if (!out.includes(stem)) out.push(stem);
    if (out.length >= 6) break;
  }
  return out;
}

// Кути для N постів на одну тему: замість «кут N: свіжий ракурс» (порожнє побажання) - типи, які
// справді дають різну форму. Порядок свідомий: перші три найбільш «людські» й не потребують цифр.
export const TOPIC_ANGLES = [
  "спостереження з практики: що автор бачить у своїй роботі чи в бізнесах клієнтів, конкретна сцена",
  "розбір помилки: як це роблять зазвичай, чому саме так, і чого це коштує",
  "контр-теза: поширена думка з цієї теми, з якою автор не згоден, і чому",
  "інструкція: як зробити за тиждень, 3-4 конкретні кроки",
  "міні-кейс або приклад (цифри ЛИШЕ якщо є у вхідному матеріалі; нема - приклад без цифр)",
  "особиста історія чи зізнання автора з уроком",
  "одне справжнє питання аудиторії з цієї теми і відповідь автора на нього",
] as const;
export function topicAngles(topic: string, n: number): string[] {
  const k = Math.max(1, Math.min(10, Math.round(n) || 1));
  if (k === 1) return [topic];
  return Array.from({ length: k }, (_, i) => `${topic}\n   КУТ ${i + 1}: ${TOPIC_ANGLES[i % TOPIC_ANGLES.length]}`);
}

// ---- Чи про ЦЕЙ бренд стратегічний бриф ----
// Бриф генерує модель, і якщо бренд на той момент порожній, вона вигадує компанію сама (у тестувальника
// це був «софт для управління проєктами» у кабінеті консалтингу з продажів). Бриф іде в кожну генерацію
// як «джерело правди - не суперечити», тож чужий бриф тихо тягне пости не в ту нішу. Перевірка груба,
// але без моделі й миттєва: беремо найчастіші змістовні слова брифу (без міток на кшталт «Позиціювання»
// і без загальних слів, що є в будь-якому брифі) і дивимось, скільки з них є в описі бренду.
const BRIEF_LABELS = /(позиціювання|відмінності|аудиторія|болі|бажання|заперечення|голос|робити|уникати|контент-пілери|ключове повідомлення|велика ідея|офер|лід-магніт|м[ʼ']?який cta|жорсткий cta|цінність:промо|hero-hub-hygiene|awareness|consideration|conversion)\s*:?/gi;
// загальні корені, що є в будь-якому брифі будь-якого бізнесу (порівнюються як ПРЕФІКС основи)
const GENERIC_ROOTS = [
  "бізне", "власн", "клієн", "компа", "конте", "аудито", "послу", "ринку", "розви", "резул", "робот", "роби", "проце",
  "систе", "коман", "ефект", "управ", "мало", "серед", "страт", "довір", "цінн", "експе", "підтр", "якіс", "прост",
  "швид", "допом", "рішен", "можли", "перев", "пропо", "конкр", "прикл", "практ", "профе", "друж", "зрозу", "корис",
  "інфор", "людей", "людям", "більш", "кращ", "найкр", "успі", "дізна", "отрим", "почат", "безко", "показ", "говор",
  "підкр", "свого", "своїх", "наших", "вашо", "викор", "склад", "відсут", "продук", "інстр", "потре", "необх", "постій",
  "цільо", "залуч", "зроста", "збіль", "зменш", "підви", "покращ", "забезпеч",
];
const isGeneric = (st: string) => GENERIC_ROOTS.some((r) => st.startsWith(r));
const normUk = (t: string) => String(t || "").toLowerCase().replace(/є/g, "е").replace(/ї/g, "і").replace(/ґ/g, "г").replace(/[ʼ'’]/g, "");
const stemOf = (w: string) => (w.length >= 7 ? w.slice(0, 6) : w.slice(0, Math.max(4, w.length - 1)));

export function briefFit(brief: string, brand: string): { checked: number; found: number; ratio: number; missing: string[] } {
  const words = normUk(String(brief || "").replace(BRIEF_LABELS, " ")).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5);
  const freq = new Map<string, number>();
  for (const w of words) {
    const st = stemOf(w);
    if (isGeneric(st) || TOPIC_STOP.has(w)) continue;
    freq.set(st, (freq.get(st) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
  const b = normUk(brand);
  const missing = top.filter((st) => !b.includes(st));
  const found = top.length - missing.length;
  return { checked: top.length, found, ratio: top.length ? found / top.length : 1, missing };
}

/** Бриф описує інший бізнес, ніж опис бренду. Коли порівнювати нема з чим (бренд чи бриф короткі) - false. */
export function briefMismatch(brief: string, brand: string): boolean {
  if (String(brand || "").trim().length < 200 || String(brief || "").trim().length < 150) return false;
  const f = briefFit(brief, brand);
  return f.checked >= 6 && f.ratio < 0.35;
}
/** Усе, що людина розповіла про бренд, - текст, з яким звіряємо бриф. */
export const brandTextOf = (s: Record<string, string>) =>
  [s.marketing_context, s.brand_thesis, s.pain_points, s.voice_examples, s.offer_low, s.offer_mid, s.offer_high, s.offers_and_prices, s.content_strategy, s.brand_story]
    .filter(Boolean).join("\n");
