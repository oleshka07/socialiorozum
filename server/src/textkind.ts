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
