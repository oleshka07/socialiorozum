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
