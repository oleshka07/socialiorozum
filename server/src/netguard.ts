// 🛡 Захист від SSRF. Сервер сам ходить за адресами, які вписує користувач: RSS-стрічки, сторінки
// статей із цих стрічок, хмара транскрибатора. Без перевірки це двері в мережу самого сервера:
// localhost, сусідні контейнери на тому ж боксі, метадані хмари (169.254.169.254). Тепер кожна така
// адреса - і КОЖНА переадресація - мусить вести в публічний інтернет. Виняток - власний RSSHub
// сервісу: його адресу будуємо ми самі.
//
// Межа, сказана прямо: між перевіркою DNS і самим запитом домен теоретично може «перескочити» на
// інший IP (DNS rebinding). Для автентифікованих користувачів, яким це дає хіба сліпий запит, це
// прийнятний залишок; головні шляхи (пряма внутрішня адреса, редірект усередину) закриті.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "./env.js";

export class BlockedUrlError extends Error {}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254)                  // link-local, метадані хмари
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)        // CGNAT
      || (a === 198 && (b === 18 || b === 19))     // тестові мережі
      || (a === 192 && b === 0 && Number(ip.split(".")[2]) === 0);
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff")) return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (x.startsWith("::ffff:")) return true;      // шістнадцяткова форма змепленої IPv4 - не розбираємо, не пускаємо
    return false;
  }
  return true;
}

const ownOrigin = (u: string): string => { try { return new URL(u).origin; } catch { return ""; } };

/** Кидає BlockedUrlError, якщо адреса веде не в публічний інтернет. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BlockedUrlError("некоректна адреса"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError("адреса має починатись із http:// або https://");
  const hub = ownOrigin(env.rsshub.baseUrl);
  if (hub && u.origin === hub) return u;           // власний RSSHub - адресу будуємо ми
  if (u.username || u.password) throw new BlockedUrlError("адреса з логіном і паролем усередині не приймається");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const blocked = new BlockedUrlError("ця адреса веде у внутрішню мережу сервера - такі не підключаються");
  if (/(^|\.)(localhost|local|internal)$/i.test(host) || (!isIP(host) && !host.includes("."))) throw blocked;
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try { addrs = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address); }
    catch { throw new BlockedUrlError(`домен ${host} не знайдено`); }
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw blocked;
  return u;
}

/** fetch лише в публічний інтернет: адреса й кожна переадресація перевіряються окремо. */
export async function publicFetch(raw: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    await res.body?.cancel().catch(() => {});
    url = new URL(loc, url).toString();
  }
  throw new BlockedUrlError("забагато переадресацій");
}
