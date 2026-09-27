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
    // рілси в YouTube і TikTok - PRO-трек зі збіркою відео; чесно «бета», навіть коли ключі є
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
  if (by("beta").length) parts.push(`<b>Бета:</b> ${list(by("beta"))} - для рілсів у PRO.`);
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

/** robots.txt: закриті - кабінет, API, вхід і технічні адреси; бета не індексується зовсім. */
export function robotsTxt(baseUrl: string, closed: boolean): string {
  if (closed) return "User-agent: *\nDisallow: /\n";
  const base = baseUrl.replace(/\/$/, "");
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /app",
    "Disallow: /api/",
    "Disallow: /login",
    "Disallow: /register",
    "Disallow: /forgot",
    "Disallow: /reset",
    "Disallow: /tgapp",
    "Disallow: /mcp/",
    "Disallow: /media/",
    "Disallow: /thumb/",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}

/** Сторінки для пошуковиків: лише ті, що віддають 200 і відкриті для індексації. */
export const SITEMAP_PAGES: { path: string; lastmod: string }[] = [
  { path: "/", lastmod: "2026-09-27" },
  { path: "/privacy", lastmod: "2026-09-26" },
  { path: "/terms", lastmod: "2026-09-26" },
  { path: "/data-deletion", lastmod: "2026-09-26" },
];

export function sitemapXml(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  const urls = SITEMAP_PAGES.map((p) => `  <url>\n    <loc>${base}${p.path}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
