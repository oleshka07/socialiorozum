import { env } from "./env.js";
import { BRAND, brandedFrom } from "./brand.js";

// Надсилання через Resend (https://resend.com) - простий REST, без SDK.
async function send(to: string, subject: string, html: string): Promise<void> {
  if (!env.resend.apiKey) {
    console.warn("[email] RESEND_API_KEY не заданий - лист до", to, "НЕ надіслано");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resend.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: brandedFrom(env.resend.from), to, subject, html }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend ${res.status}: ${t.slice(0, 300)}`);
  }
}

const wrap = (title: string, body: string) =>
  `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;padding:8px">
     <div style="font-size:22px;font-weight:800;color:#5b8cff">${BRAND}</div>
     <h3 style="margin:14px 0">${title}</h3>${body}
     <p style="color:#999;font-size:12px;margin-top:26px">Якщо ви цього не робили - просто проігноруйте лист.</p>
   </div>`;

const button = (link: string, label: string) =>
  `<p><a href="${link}" style="display:inline-block;background:#5b8cff;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">${label}</a></p>
   <p style="color:#999;font-size:12px;word-break:break-all">Або відкрийте посилання: ${link}</p>`;

// 🔔 Лист адміну про збій (alerts.ts): свій вигляд, без «якщо ви цього не робили» - це не дія людини.
export function sendOpsEmail(to: string, subject: string, bodyHtml: string) {
  return send(to, subject,
    `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;padding:8px">
       <div style="font-size:20px;font-weight:800;color:#5b8cff">${BRAND} · сповіщення про збої</div>${bodyHtml}
       <p style="color:#999;font-size:12px;margin-top:26px">Налаштувати, куди й що приходить: кабінет → Налаштування → Профіль → «🔔 Сповіщення про збої».</p>
     </div>`);
}

export function sendVerifyEmail(to: string, link: string) {
  return send(to, `Підтвердіть пошту - ${BRAND}`,
    wrap("Підтвердження пошти",
      `<p>Дякуємо за реєстрацію в ${BRAND}! Натисніть, щоб підтвердити пошту й активувати акаунт:</p>${button(link, "Підтвердити пошту")}`));
}
export function sendResetEmail(to: string, link: string) {
  return send(to, `Скидання пароля - ${BRAND}`,
    wrap("Скидання пароля",
      `<p>Ви запросили скидання пароля. Натисніть, щоб задати новий (посилання дійсне 2 години):</p>${button(link, "Скинути пароль")}`));
}
export function sendDeletionScheduledEmail(to: string, loginLink: string, days: number) {
  return send(to, `Акаунт заплановано до видалення - ${BRAND}`,
    wrap("Акаунт буде видалено",
      `<p>Ви запросили видалення акаунта ${BRAND}. Усі дані буде остаточно стерто через <b>${days} днів</b>.</p>
       <p>Передумали? Просто увійдіть у застосунок протягом цього часу - видалення скасується автоматично.</p>${button(loginLink, "Скасувати - увійти")}`));
}
export function sendInactivityWarningEmail(to: string, loginLink: string, days: number) {
  return send(to, `Давно не бачились - ${BRAND}`,
    wrap("Ваш контент скоро приберемо",
      `<p>Ви не заходили в ${BRAND} понад місяць. Щоб звільнити місце, ми приберемо ваші завантажені фото та прогони через <b>${days} днів</b>, якщо ви не повернетесь. Налаштування бренду й стратегія залишаться.</p>${button(loginLink, "Повернутись")}`));
}
export function sendEmailChangedNotice(to: string, newEmail: string) {
  return send(to, `Email акаунта змінено - ${BRAND}`,
    wrap("Email змінено",
      `<p>Email вашого акаунта ${BRAND} змінено на <b>${newEmail}</b>.</p><p>Якщо це були не ви - негайно скиньте пароль і зверніться до підтримки.</p>`));
}

// ---------------------------------------------------------------- 👥 команда бренду
// Назви брендів і пошти пишуть люди - у лист вони йдуть лише екранованими.
const escHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
const teamWrap = (title: string, body: string) =>
  `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;padding:8px">
     <div style="font-size:22px;font-weight:800;color:#5b8cff">${BRAND}</div>
     <h3 style="margin:14px 0">${title}</h3>${body}
     <p style="color:#999;font-size:12px;margin-top:26px">Не чекав цього листа - просто проігноруй його: без твого входу нічого не станеться.</p>
   </div>`;
type TeamMail = { to: string; brand: string; by: string; role: string; hint: string; link: string };

/** Людини ще нема в сервісі: запрошення з посиланням (бренд зʼявиться після реєстрації з цією поштою). */
export function sendTeamInviteEmail(m: TeamMail & { days: number }) {
  return send(m.to, `Запрошення в бренд «${m.brand}» - ${BRAND}`,
    teamWrap(`Тебе запрошують у бренд «${escHtml(m.brand)}»`,
      `<p><b>${escHtml(m.by)}</b> запрошує тебе в ${BRAND} - сервіс, де з матеріалів бренду готуються й публікуються пости для соцмереж.</p>
       <p>Твоя роль: <b>${escHtml(m.role)}</b> - ${escHtml(m.hint)}.</p>${button(m.link, "Прийняти запрошення")}
       <p style="color:#555;font-size:13px">Зареєструйся саме з цією поштою (${escHtml(m.to)}) - бренд одразу зʼявиться в тебе. Запрошення діє ${m.days} днів.</p>`));
}
/** Людина вже має акаунт: бренд уже в її списку. */
export function sendTeamAddedEmail(m: TeamMail) {
  return send(m.to, `Тебе додали до бренду «${m.brand}» - ${BRAND}`,
    teamWrap(`Новий бренд у твоєму ${BRAND}`,
      `<p><b>${escHtml(m.by)}</b> додав(ла) тебе до бренду <b>«${escHtml(m.brand)}»</b>.</p>
       <p>Твоя роль: <b>${escHtml(m.role)}</b> - ${escHtml(m.hint)}.</p>${button(m.link, "Відкрити бренд")}
       <p style="color:#555;font-size:13px">Перемикати бренди - у меню аватара, угорі праворуч.</p>`));
}
/** Автор надіслав пост на затвердження - тим, хто затверджує (коли в них нема Telegram-бота). */
export function sendReviewRequestEmail(m: { to: string; brand: string; by: string; firstLine: string; link: string }) {
  return send(m.to, `Пост на затвердження - «${m.brand}»`,
    teamWrap("Пост чекає на затвердження",
      `<p><b>${escHtml(m.by)}</b> надіслав(ла) пост на затвердження в бренді <b>«${escHtml(m.brand)}»</b>:</p>
       <blockquote style="margin:10px 0;padding:8px 12px;border-left:3px solid #5b8cff;color:#333">${escHtml(m.firstLine)}</blockquote>${button(m.link, "Відкрити пост")}`));
}
/** Пост автора затвердили чи повернули з коментарем. */
export function sendReviewResultEmail(m: { to: string; brand: string; by: string; firstLine: string; link: string; approved: boolean; note?: string }) {
  return send(m.to, `${m.approved ? "Пост затверджено" : "Пост повернули на доопрацювання"} - «${m.brand}»`,
    teamWrap(m.approved ? "✅ Пост затверджено" : "↩ Пост повернули на доопрацювання",
      `<p><b>${escHtml(m.by)}</b> ${m.approved ? "затвердив(ла)" : "повернув(ла)"} твій пост у бренді <b>«${escHtml(m.brand)}»</b>:</p>
       <blockquote style="margin:10px 0;padding:8px 12px;border-left:3px solid #5b8cff;color:#333">${escHtml(m.firstLine)}</blockquote>
       ${m.note ? `<p>Коментар: <i>${escHtml(m.note)}</i></p>` : ""}${button(m.link, "Відкрити пост")}`));
}
