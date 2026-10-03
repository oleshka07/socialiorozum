// 🏠 Лендинг. Тиха помилка тут - сторінка, що обіцяє «Instagram працює» кожному, поки Meta пускає лише
// тестувальників; шаблон із невставленим %BASE% (canonical і превʼю вели б у нікуди); зламаний JSON-LD
// (пошуковик мовчки його відкидає); robots.txt, що відкриває бету пошуковикам.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { networkStates, renderLanding, inviteNote, networksFaq, robotsTxt, sitemapXml, llmsTxt, NETWORKS, SITEMAP_PAGES } from "../dist/landing.js";

const TPL = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const BASE = "https://holos.rozum.one";
const BEFORE = { metaAppId: "1", metaPublic: false, threadsAppId: "1", threadsPublic: false, linkedinClientId: "1", googleClientId: "1", tiktokKey: "" };
const AFTER = { ...BEFORE, metaPublic: true, threadsPublic: true };

test("статуси мереж: до схвалення Meta/Threads - «за запрошенням», після - «працює»", () => {
  const b = networkStates(BEFORE);
  assert.equal(b.telegram, "live");
  assert.equal(b.instagram, "invite");
  assert.equal(b.facebook, "invite");
  assert.equal(b.threads, "invite");
  assert.equal(b.linkedin, "live");
  assert.equal(b.youtube, "beta");
  assert.equal(b.tiktok, "soon");
  const a = networkStates(AFTER);
  assert.equal(a.instagram, "live");
  assert.equal(a.threads, "live");
  // без ключів застосунку мережа не «працює» і не «за запрошенням» - її просто ще нема
  const none = networkStates({ metaAppId: "", metaPublic: true, threadsAppId: "", threadsPublic: true, linkedinClientId: "", googleClientId: "", tiktokKey: "" });
  for (const n of ["instagram", "facebook", "threads", "linkedin", "youtube", "tiktok"]) assert.equal(none[n], "soon", n);
});

test("речення про «за запрошенням» називає, хто перевіряє, і зникає, коли перевірку пройдено", () => {
  assert.match(inviteNote(networkStates(BEFORE)), /Meta й Threads перевіряють/);
  assert.match(inviteNote(networkStates({ ...BEFORE, threadsPublic: true })), /Meta перевіряє/);
  assert.doesNotMatch(inviteNote(networkStates({ ...BEFORE, threadsPublic: true })), /Threads/);
  assert.equal(inviteNote(networkStates(AFTER)), "");
});

test("FAQ про мережі: групи за статусом, Facebook-профілі чесно «не буде»", () => {
  const f = networksFaq(networkStates(BEFORE));
  assert.match(f, /Працює зараз:<\/b> Telegram \(канали й групи\) і LinkedIn/);
  assert.match(f, /За запрошенням:<\/b> Instagram, Facebook \(Сторінки\) і Threads/);
  assert.match(f, /Скоро:<\/b> TikTok/);
  assert.match(f, /Особисті профілі й групи Facebook/);
});

test("справжній шаблон: після рендеру не лишається жодного %ТОКЕНА%, адреса скрізь нова", () => {
  const html = renderLanding(TPL, BASE + "/", BEFORE);
  assert.doesNotMatch(html, /%(BASE|ST:[a-z]+|SC:[a-z]+|NET_NOTE|FAQ_NETS)%/);
  assert.match(html, /<link rel="canonical" href="https:\/\/holos\.rozum\.one\/">/);
  assert.match(html, /property="og:image" content="https:\/\/holos\.rozum\.one\/images\/og\/holos-og-1200x630\.jpg"/);
  assert.doesNotMatch(html, /holos\.rozum\.one\/\//, "подвійний слеш після адреси");
  assert.doesNotMatch(html, /socialio\.rozum\.one/);
});

test("справжній шаблон: бейдж Instagram до схвалення - «за запрошенням», а не «працює»", () => {
  const badge = (html, id) => html.match(new RegExp(`id="${id}"[\\s\\S]*?<span class="st ([a-z-]+)">([^<]+)</span>`)).slice(1);
  const before = renderLanding(TPL, BASE, BEFORE), after = renderLanding(TPL, BASE, AFTER);
  assert.deepEqual(badge(before, "p-ig"), ["st-invite", "за запрошенням"]);
  assert.deepEqual(badge(before, "p-tg"), ["st-live", "працює"]);
  assert.deepEqual(badge(after, "p-ig"), ["st-live", "працює"]);
  assert.deepEqual(badge(after, "p-th"), ["st-live", "працює"]);
});

test("справжній шаблон: JSON-LD - валідний JSON без вигаданих цін і рейтингів", () => {
  const html = renderLanding(TPL, BASE, BEFORE);
  const raw = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  const ld = JSON.parse(raw);
  const types = ld["@graph"].map((n) => n["@type"]);
  assert.deepEqual(types, ["WebSite", "Organization", "WebApplication", "WebPage"]);
  assert.doesNotMatch(raw, /aggregateRating|review|"offers"/);
});

test("справжній шаблон: вкладки мереж і панелі зʼєднані, мережі з токенів відомі", () => {
  const tabs = [...TPL.matchAll(/role="tab" id="([^"]+)" aria-controls="([^"]+)"/g)];
  assert.equal(tabs.length, 5);
  for (const [, id, panel] of tabs) assert.match(TPL, new RegExp(`id="${panel}" aria-labelledby="${id}"`));
  for (const [, n] of TPL.matchAll(/%(?:ST|SC):([a-z]+)%/g)) assert.ok(NETWORKS.includes(n), n);
});

test("тексти лендингу без довгих тире (правило бренду) і без обіцянок, яких нема в продукті", () => {
  assert.doesNotMatch(TPL, /—/);
  // вигадані лічильники й відгуки пакет Костянтина прямо забороняє
  assert.doesNotMatch(TPL, /\+\d+\s*(експерт|користувач)/i);
  assert.doesNotMatch(TPL, /\$400|600\/міс/);
});

// Правила robots.txt так, як їх читає Google: найдовше правило, що збіглося, перемагає; при рівній довжині -
// Allow; «*» - будь-що, «$» - кінець адреси. Перевіряємо не текст файлу, а що він насправді дозволяє.
function robotsAllows(txt, url) {
  const rules = txt.split("\n").map((l) => /^(Allow|Disallow):\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => ({ allow: m[1] === "Allow", p: m[2] }));
  let best = null;
  for (const r of rules) {
    if (!r.p) continue;
    const re = new RegExp("^" + r.p.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (!re.test(url)) continue;
    if (!best || r.p.length > best.p.length || (r.p.length === best.p.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

test("robots.txt: бета закрита цілком, прод - без кабінету й API, з картою сайту", () => {
  assert.equal(robotsTxt(BASE, true), "User-agent: *\nDisallow: /\n");
  const r = robotsTxt(BASE + "/", false);
  assert.match(r, /^User-agent: \*\nAllow: \/\n/);
  assert.match(r, /Sitemap: https:\/\/holos\.rozum\.one\/sitemap\.xml\n/);
  // відкрите: сторінки з карти сайту, іконки (Google бере іконку для видачі з них), llms.txt
  for (const u of ["/", "/privacy", "/terms", "/data-deletion", "/apple-touch-icon.png", "/favicon.ico", "/favicon.svg",
    "/favicon-192x192.png", "/site.webmanifest", "/images/site/hero.webp", "/fonts/inter-cyrillic.woff2", "/llms.txt", "/@my-brand"])
    assert.ok(robotsAllows(r, u), "має бути відкрито: " + u);
  // вхід і реєстрацію пошуковик бачить і читає там noindex (закриті, вони могли б потрапити в індекс голим посиланням)
  for (const u of ["/login", "/register", "/forgot", "/reset?token=x", "/login?next=%2Fapp"]) assert.ok(robotsAllows(r, u), "має бути відкрито (noindex): " + u);
  // закрите: кабінет, API, конектор, медіа людей, Mini App
  for (const u of ["/app", "/app?review=en", "/api/auth/me", "/mcp/abc", "/media/x.jpg", "/thumb/x.jpg", "/tgapp"])
    assert.ok(!robotsAllows(r, u), "має бути закрито: " + u);
  // бета: нічого
  for (const u of ["/", "/privacy", "/llms.txt"]) assert.ok(!robotsAllows(robotsTxt(BASE, true), u), "бета: " + u);
});

test("sitemap.xml: лише відкриті сторінки, адреси без подвійних слешів, дати змін - з відбитків", () => {
  const x = sitemapXml(BASE + "/");
  assert.match(x, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.equal((x.match(/<url>/g) || []).length, SITEMAP_PAGES.length);
  assert.match(x, /<loc>https:\/\/holos\.rozum\.one\/<\/loc>/);
  assert.match(x, /<loc>https:\/\/holos\.rozum\.one\/privacy<\/loc>/);
  assert.doesNotMatch(x, /\/app|\/login|\/register|one\/\//);
  // кожна сторінка - зі своєю датою; без даних - запасна з SITEMAP_PAGES
  const d = sitemapXml(BASE, { "/": "2026-10-05", "/terms": "2026-10-04" });
  assert.match(d, /<loc>https:\/\/holos\.rozum\.one\/<\/loc>\n    <lastmod>2026-10-05<\/lastmod>/);
  assert.match(d, /<loc>https:\/\/holos\.rozum\.one\/terms<\/loc>\n    <lastmod>2026-10-04<\/lastmod>/);
  assert.match(d, new RegExp(`<loc>https://holos\\.rozum\\.one/privacy</loc>\\n    <lastmod>${SITEMAP_PAGES.find((p) => p.path === "/privacy").lastmod}</lastmod>`));
  for (const p of SITEMAP_PAGES) assert.match(p.lastmod, /^\d{4}-\d{2}-\d{2}$/);
});

test("llms.txt: опис для AI-асистентів - ті самі чесні статуси мереж, що на лендингу, повні адреси", () => {
  const b = llmsTxt(BASE + "/", BEFORE);
  assert.match(b, /^# Holos by Rozum\n\n> /);
  assert.match(b, /- Працює: Telegram \(канали й групи\) і LinkedIn \(особистий профіль\)\./);
  assert.match(b, /- За запрошенням: Instagram, Facebook \(Сторінки\) і Threads - поки платформа перевіряє/);
  assert.match(b, /- Бета: YouTube Shorts/);
  assert.match(b, /- Скоро: TikTok\./);
  assert.match(b, /Works now: Telegram, LinkedIn\./);
  const a = llmsTxt(BASE, AFTER);
  assert.match(a, /- Працює: Telegram \(канали й групи\), Instagram, Facebook \(Сторінки\), Threads і LinkedIn/);
  assert.doesNotMatch(a, /За запрошенням/);
  // факти, які не можна переплутати: безкоштовно в ранньому доступі, без публікацій без автора, оператор
  for (const re of [/оплату ще не підключено/, /Без затвердження автора нічого не виходить/, /Swipe Scape s\.r\.o\./, /не вигадує фактів/])
    assert.match(b, re);
  for (const pth of ["/", "/register", "/privacy", "/terms", "/data-deletion"]) assert.ok(b.includes(`(${BASE}${pth})`), pth);
  assert.doesNotMatch(b, /one\/\/|%[A-Z_]+%|—|undefined|null/);
});

// 🔗 Посилання на сестринський проєкт EvidujZdarma (SEO-ТЗ Олега, 03.10): одне в тексті сторінки (у <main>, з
// описовим анкором - найцінніше), назва бренду в підвалі на всіх відкритих сторінках. Чисті: без nofollow/sponsored/
// ugc, без UTM і target. Чесно: каса ще не запущена - «готуємо» / «in preparation».
test("EvidujZdarma: у тексті сторінки і в підвалі, без nofollow і UTM, з чесним «готуємо»", () => {
  const html = renderLanding(TPL, BASE, BEFORE);
  const links = [...html.matchAll(/<a\b[^>]*href="(https:\/\/evidujzdarma\.cz[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.ok(links.length >= 3, "посилань: " + links.length);
  for (const [tag, href] of links) {
    assert.doesNotMatch(tag, /\brel=|\btarget=/, tag);
    assert.doesNotMatch(href, /utm_|[?#]/, href);
  }
  // перше посилання на головну EvidujZdarma - описове, у тексті сторінки (пошуковик бере саме його анкор)
  const first = links.find(([, href]) => href === "https://evidujzdarma.cz/");
  assert.equal(first[2], "безкоштовну касу для EET 2.0");
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  assert.ok(main.includes(first[0]), "описове посилання - у <main>");
  assert.match(main, /готуємо EvidujZdarma/);
  assert.match(main, /href="https:\/\/evidujzdarma\.cz\/musim-evidovat"/);
  const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
  assert.match(footer, /<a href="https:\/\/evidujzdarma\.cz\/">EvidujZdarma<\/a> - безкоштовна каса для EET 2\.0/);
});

test("EvidujZdarma: підвал політики, умов і сторінки видалення даних", () => {
  for (const page of ["privacy", "terms", "data-deletion"]) {
    const h = readFileSync(new URL(`../public/${page}.html`, import.meta.url), "utf8");
    const foot = h.slice(h.lastIndexOf("<footer"), h.lastIndexOf("</footer>"));
    assert.match(foot, /<a href="https:\/\/evidujzdarma\.cz\/">EvidujZdarma<\/a> - a free cash register for the Czech EET 2\.0 sales records, in preparation\./, page);
    assert.match(foot, /<a href="\/">Holos by Rozum<\/a>/, page);
    assert.ok(!foot.includes(`href="/${page}"`), page + ": без посилання на саму себе");
    assert.doesNotMatch(h, /—/, page);
  }
});
