import { env } from "./env.js";

// Надсилання через Resend (https://resend.com) — простий REST, без SDK.
async function send(to: string, subject: string, html: string): Promise<void> {
  if (!env.resend.apiKey) {
    console.warn("[email] RESEND_API_KEY не заданий — лист до", to, "НЕ надіслано");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resend.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.resend.from, to, subject, html }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend ${res.status}: ${t.slice(0, 300)}`);
  }
}

const wrap = (title: string, body: string) =>
  `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;padding:8px">
     <div style="font-size:22px;font-weight:800;color:#5b8cff">socialio</div>
     <h3 style="margin:14px 0">${title}</h3>${body}
     <p style="color:#999;font-size:12px;margin-top:26px">Якщо ви цього не робили — просто проігноруйте лист.</p>
   </div>`;

const button = (link: string, label: string) =>
  `<p><a href="${link}" style="display:inline-block;background:#5b8cff;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">${label}</a></p>
   <p style="color:#999;font-size:12px;word-break:break-all">Або відкрийте посилання: ${link}</p>`;

export function sendVerifyEmail(to: string, link: string) {
  return send(to, "Підтвердіть пошту — socialio",
    wrap("Підтвердження пошти",
      `<p>Дякуємо за реєстрацію в socialio! Натисніть, щоб підтвердити пошту й активувати акаунт:</p>${button(link, "Підтвердити пошту")}`));
}
export function sendResetEmail(to: string, link: string) {
  return send(to, "Скидання пароля — socialio",
    wrap("Скидання пароля",
      `<p>Ви запросили скидання пароля. Натисніть, щоб задати новий (посилання дійсне 2 години):</p>${button(link, "Скинути пароль")}`));
}
