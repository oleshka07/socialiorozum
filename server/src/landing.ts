// 🏠 Лендинг «/». Статуси мереж беруться з конфігурації сервера, а не пишуться в HTML руками:
// поки Meta й Threads не схвалили застосунок, підключитись можуть лише тестувальники, і сторінка,
// що обіцяє «Instagram працює» кожному, продавала б те, що людина не зможе підключити. Коли
// з'явиться META_PUBLIC=1 (чи THREADS_PUBLIC=1), лендинг сам скаже «працює» - правити HTML не треба.
// Чисті функції - під юнітами (test/landing.test.mjs).

export type NetState = "live" | "invite" | "beta" | "soon";

export type LandingEnv = {
  metaAppId: string;
  metaPublic: boolean;
  threadsAppId: string;
  threadsPublic: boolean;
  linkedinClientId: string;
  googleClientId: string;
  tiktokKey: string;
};

export const NETWORKS = ["telegram", "instagram", "facebook", "threads", "linkedin", "youtube", "tiktok"] as const;
export type Network = (typeof NETWORKS)[number];

export const NET_NAME: Record<Network, string> = {
  telegram: "Telegram", instagram: "Instagram", facebook: "Facebook", threads: "Threads",
  linkedin: "LinkedIn", youtube: "YouTube Shorts", tiktok: "TikTok",
};

export const STATE_LABEL: Record<NetState, string> = {
  live: "працює",
  invite: "за запрошенням",
  beta: "бета",
  soon: "скоро",
};

export function networkStates(e: LandingEnv): Record<Network, NetState> {
  const meta: NetState = !e.metaAppId ? "soon" : e.metaPublic ? "live" : "invite";
  return {
    telegram: "live",
    instagram: meta,
    facebook: meta,
    threads: !e.threadsAppId ? "soon" : e.threadsPublic ? "live" : "invite",
    linkedin: e.linkedinClientId ? "live" : "soon",
    // відео в YouTube і TikTok: публікуються, але до перевірок платформ YouTube показує їх лише автору,
    // а TikTok кладе в чернетки - тож чесно «бета», навіть коли ключі є
    youtube: e.googleClientId ? "beta" : "soon",
    tiktok: e.tiktokKey ? "beta" : "soon",
  };
}

const list = (names: string[]): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} і ${names[names.length - 1]}`;

/** Речення під перемикачем мереж: чому частина мереж «за запрошенням». Порожньо, якщо таких нема. */
export function inviteNote(st: Record<Network, NetState>): string {
  const inv = NETWORKS.filter((n) => st[n] === "invite");
  if (!inv.length) return "";
  const who = [inv.some((n) => n === "instagram" || n === "facebook") && "Meta", inv.includes("threads") && "Threads"].filter(Boolean) as string[];
  return `${list(inv.map((n) => NET_NAME[n]))} уже працюють у Holos, але поки ${who.length > 1 ? "Meta й Threads перевіряють" : `${who[0]} перевіряє`} наш застосунок, підключитись можуть лише учасники ранньої бети. Щойно перевірку завершать, відкриємо всім.`;
}

/** Відповідь у FAQ «Які соцмережі працюють зараз?» - згрупована за статусом. */
export function networksFaq(st: Record<Network, NetState>): string {
  const detail: Partial<Record<Network, string>> = {
    telegram: "Telegram (канали й групи)",
    facebook: "Facebook (Сторінки)",
    linkedin: "LinkedIn (особистий профіль)",
  };
  const by = (s: NetState) => NETWORKS.filter((n) => st[n] === s).map((n) => detail[n] || NET_NAME[n]);
  const parts: string[] = [];
  if (by("live").length) parts.push(`<b>Працює зараз:</b> ${list(by("live"))}.`);
  if (by("invite").length) parts.push(`<b>За запрошенням:</b> ${list(by("invite"))} - поки платформа перевіряє застосунок, підключитись можуть учасники ранньої бети.`);
  if (by("beta").length) parts.push(`<b>Бета:</b> ${list(by("beta"))} - відео виходять туди з того самого поста, але поки платформи перевіряють застосунок, YouTube показує їх лише тобі, а TikTok кладе в чернетки, які ти публікуєш у застосунку TikTok.`);
  if (by("soon").length) parts.push(`<b>Скоро:</b> ${list(by("soon"))}.`);
  parts.push("Особисті профілі й групи Facebook Meta через API не відкриває нікому, тож їх не буде ні в нас, ні в інших сервісів.");
  return parts.join(" ");
}

/**
 * Підставляє в шаблон лендингу адресу сервісу й статуси мереж.
 * `%BASE%` - адреса без «/» у кінці; `%ST:мережа%` - підпис статусу; `%SC:мережа%` - клас (st-live…);
 * `%NET_NOTE%` - речення про «за запрошенням»; `%FAQ_NETS%` - відповідь у FAQ.
 */
export function renderLanding(tpl: string, baseUrl: string, e: LandingEnv): string {
  const st = networkStates(e);
  const known = (n: string): n is Network => (NETWORKS as readonly string[]).includes(n);
  return tpl
    .replace(/%BASE%/g, baseUrl.replace(/\/$/, ""))
    .replace(/%ST:([a-z]+)%/g, (_m, n: string) => STATE_LABEL[known(n) ? st[n] : "soon"])
    .replace(/%SC:([a-z]+)%/g, (_m, n: string) => `st-${known(n) ? st[n] : "soon"}`)
    .replace(/%NET_NOTE%/g, inviteNote(st))
    .replace(/%FAQ_NETS%/g, networksFaq(st));
}

/**
 * robots.txt: бета не індексується зовсім; на проді закриті лише технічні адреси.
 * Кабінет - рівно `/app` і `/app?…`: правило-префікс `/app` закривало й `/apple-touch-icon.png`, а іконку
 * сайту для видачі Google бере саме з таких файлів. Вхід, реєстрація й відновлення пароля НЕ закриті:
 * на них ведуть кнопки лендингу, і закрита для обходу адреса може потрапити в індекс голим посиланням
 * («Проіндексовано, хоча заблоковано robots.txt»). Відкриті ж, вони кажуть `noindex` (мета-тег і
 * заголовок X-Robots-Tag), і Google сам їх не бере.
 */
export function robotsTxt(baseUrl: string, closed: boolean): string {
  if (closed) return "User-agent: *\nDisallow: /\n";
  const base = baseUrl.replace(/\/$/, "");
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /app$",
    "Disallow: /app?",
    "Disallow: /api/",
    "Disallow: /tgapp",
    "Disallow: /mcp/",
    "Disallow: /media/",
    "Disallow: /thumb/",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}

/**
 * Сторінки для пошуковиків: лише ті, що віддають 200 і відкриті для індексації. `lastmod` тут - запасна
 * дата: справжню (коли вміст сторінки востаннє змінився) рахує seo.ts за відбитком і передає в sitemapXml.
 */
export const SITEMAP_PAGES: { path: string; lastmod: string }[] = [
  { path: "/", lastmod: "2026-10-03" },
  { path: "/privacy", lastmod: "2026-10-03" },
  { path: "/terms", lastmod: "2026-10-03" },
  { path: "/data-deletion", lastmod: "2026-10-03" },
];

export function sitemapXml(baseUrl: string, lastmod: Record<string, string> = {}): string {
  const base = baseUrl.replace(/\/$/, "");
  const urls = SITEMAP_PAGES.map((p) => `  <url>\n    <loc>${base}${p.path}</loc>\n    <lastmod>${lastmod[p.path] || p.lastmod}</lastmod>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * /llms.txt - стислий опис сервісу для AI-асистентів (ChatGPT, Claude, Perplexity): що це, звідки
 * матеріал, які мережі працюють і на яких умовах, де сторінки. Статуси мереж - ті самі, що на лендингу
 * (з конфігурації), тож асистент не пообіцяє людині мережу, яку вона не зможе підключити.
 */
export function llmsTxt(baseUrl: string, e: LandingEnv): string {
  const base = baseUrl.replace(/\/$/, "");
  const st = networkStates(e);
  const detail: Partial<Record<Network, string>> = {
    telegram: "Telegram (канали й групи)",
    facebook: "Facebook (Сторінки)",
    linkedin: "LinkedIn (особистий профіль)",
  };
  const by = (s: NetState) => NETWORKS.filter((n) => st[n] === s).map((n) => detail[n] || NET_NAME[n]);
  const nets: string[] = [];
  if (by("live").length) nets.push(`- Працює: ${list(by("live"))}.`);
  if (by("invite").length) nets.push(`- За запрошенням: ${list(by("invite"))} - поки платформа перевіряє застосунок Holos, підключитись можуть учасники ранньої бети.`);
  if (by("beta").length) nets.push(`- Бета: ${list(by("beta"))} - відео виходять туди з того самого поста; до перевірки платформ YouTube показує їх лише автору, а TikTok кладе в чернетки.`);
  if (by("soon").length) nets.push(`- Скоро: ${list(by("soon"))}.`);
  const en = NETWORKS.filter((n) => st[n] === "live").map((n) => NET_NAME[n]);
  return [
    "# Holos by Rozum",
    "",
    "> Holos - AI-сервіс для контенту в соцмережах з українським інтерфейсом. Бере те, що автор уже сказав чи написав (дзвінки, голосові, нотатки, новини ніші, власні пости), знаходить у цьому теми й робить готові пости в голосі автора, планує їх і публікує в підключені мережі. Без затвердження автора нічого не виходить.",
    "",
    "Holos не вигадує фактів і цифр, яких не було в матеріалі, і прибирає шаблонні AI-фрази. Оператор - Swipe Scape s.r.o. (Карлові Вари, Чехія). Ранній доступ: оплату ще не підключено, тож зараз Holos безкоштовний; без картки.",
    "",
    "## Звідки матеріал",
    "",
    "- Транскрипти дзвінків: Fireflies, Grain, MeetGeek або власний транскрибатор.",
    "- Голосові й думки в Telegram-боті: бот розшифровує голос і кладе в щоденник.",
    "- Нотатки й тексти, база бренду (ніша, аудиторія, болі клієнтів, приклади постів).",
    "- Новини ніші: Google News за темою, RSS, публічні Telegram-канали й профілі Threads.",
    "- Фото з Google Drive і власна медіатека; конектор для Claude (MCP): пости з чату лягають у кабінет.",
    "",
    "## Що робить",
    "",
    "- Пости в голосі автора під кожну мережу: своя довжина й подача.",
    "- Каруселі до 10 кадрів, відео й Reels, сторіс в Instagram і Facebook, перший коментар.",
    "- Монтаж сторіс і рілс із власних кліпів: субтитри, гачок, музика, AI-голос.",
    "- Контент-план, календар, автопублікація за розкладом, найкращий час з власної статистики.",
    "- Аналітика постів по мережах і коментарі людей в одному місці з чернетками відповідей.",
    "- Кілька брендів в одному акаунті, доступ колегам за поштою, Telegram-бот і Mini App.",
    "",
    "## Мережі",
    "",
    ...nets,
    "- Особисті профілі й групи Facebook Meta через API не відкриває нікому, тож їх нема ні в Holos, ні в інших сервісів.",
    "",
    "## Сторінки",
    "",
    `- [Головна](${base}/): що таке Holos, як працює, ціни й відповіді на часті питання`,
    `- [Створити акаунт](${base}/register)`,
    `- [Політика конфіденційності](${base}/privacy) (англійською)`,
    `- [Умови користування](${base}/terms) (англійською)`,
    `- [Видалення даних](${base}/data-deletion) (англійською)`,
    "",
    "## In English",
    "",
    `Holos by Rozum is an AI content tool for social media with a Ukrainian interface. It turns what the author already said or wrote (call transcripts, voice notes in Telegram, notes, niche news, their own posts) into ready posts in the author's voice, then plans and publishes them. Nothing is published without the author's approval. Works now: ${en.length ? en.join(", ") : "Telegram"}. Early access, free for now. Operator: Swipe Scape s.r.o., Czech Republic.`,
    "",
  ].join("\n");
}
