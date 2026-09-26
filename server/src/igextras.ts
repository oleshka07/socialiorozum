// 📸 Instagram: співавтори (collab) і alt-текст фото (п.4 дорожньої карти). Чисті функції - під юніти.
//
// Співавтори (`collaborators`) - до 3 інших акаунтів: кожен отримує запрошення, і після згоди пост
// показується і в його профілі, і в його підписників. Ставляться на фото, карусель (на сам
// контейнер CAROUSEL, не на кадри) і Reels; сторіс - ні.
// Alt-текст (`alt_text`) - опис фото для незрячих і для пошуку. Лише фото (і кадри каруселі):
// Reels і сторіс Instagram його не приймають. Живе на самому файлі (media_asset.alt_text): те саме
// фото в іншому пості описується так само. LinkedIn приймає той самий опис (`altText`).
// Обидва параметри - через дозвіл instagram_content_publish, нових дозволів не треба.

export const IG_MAX_COLLABORATORS = 3;
export const ALT_TEXT_MAX = 1000;

/** Нік Instagram: латиниця, цифри, крапка й підкреслення, до 30 знаків. */
const IG_USERNAME = /^[a-z0-9._]{1,30}$/;

/**
 * Співавтори з того, що дала людина чи модель: масив або рядок «@a, @b c». Прибирає @ і посилання
 * на профіль, зводить до нижнього регістру (ніки в Instagram регістру не мають), відкидає
 * неможливі ніки й дублі, лишає перші 3. Власний нік акаунта (own) співавтором бути не може.
 */
export function normCollaborators(v: unknown, own?: string | null): { ok: string[]; bad: string[]; extra: string[] } {
  const raw = Array.isArray(v) ? v.map((x) => String(x ?? "")) : String(v ?? "").split(/[\s,;]+/);
  const me = String(own || "").replace(/^@/, "").toLowerCase();
  const ok: string[] = [], bad: string[] = [], extra: string[] = [];
  for (const r of raw) {
    let s = r.trim();
    if (!s) continue;
    s = s.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "").replace(/^@/, "").toLowerCase();
    if (!IG_USERNAME.test(s) || s === me) { bad.push(r.trim()); continue; }
    if (ok.includes(s) || extra.includes(s)) continue;
    if (ok.length < IG_MAX_COLLABORATORS) ok.push(s); else extra.push(s);
  }
  return { ok, bad, extra };
}

/** Alt-текст до відправки: без зайвих пробілів і переносів, у межі. Порожнє - без опису. */
export function cleanAlt(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, ALT_TEXT_MAX);
}

/**
 * Чи варто повторити створення контейнера БЕЗ співавторів і alt-тексту. Якщо Instagram відбив саме
 * їх (невідомий нік, акаунт не приймає співавторів, задовгий опис), пост має вийти й без них - а не
 * впасти цілком через доповнення. «Invalid parameter» теж сюди: за ним може стояти будь-який параметр,
 * і повтор без доповнень це розрізнить (не допоможе - впаде з тією ж причиною, що й була б).
 */
export function igExtrasRejected(msg: string): boolean {
  return /collaborat|alt_text|alt text|invalid parameter|\(#100\)|param/i.test(String(msg || ""));
}
