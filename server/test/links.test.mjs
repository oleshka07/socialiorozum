// 🔗 Короткі посилання й сторінка в біо: помічники без БД.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findUrls, replaceUrls, withUtm, safeTarget, newCode, isCode, isBot, normSlug, bioHtml } from "../dist/linkutil.js";

test("посилання в тексті: розділові й дужки - не частина посилання, без повторів", () => {
  const t = "Деталі: https://rozum.one/audit. А ще (див. https://example.com/a_(b)) і https://example.com/x, https://rozum.one/audit!\nhttp://t.me/holos»";
  assert.deepEqual(findUrls(t), ["https://rozum.one/audit", "https://example.com/a_(b)", "https://example.com/x", "http://t.me/holos"]);
  assert.deepEqual(findUrls("без посилань, лише rozum.one"), []);
});

test("заміна: лише знайдені, розділові лишаються на місці, довше посилання не ламається коротшим", () => {
  const t = "Тут https://a.com і https://a.com/page. Ще https://a.com!";
  const map = new Map([["https://a.com", "S1"], ["https://a.com/page", "S2"]]);
  assert.equal(replaceUrls(t, map), "Тут S1 і S2. Ще S1!");
  assert.equal(replaceUrls("https://b.com/x", map), "https://b.com/x");
});

test("UTM: лише відсутні мітки, решта адреси як була", () => {
  const u = withUtm("https://rozum.one/audit?ref=x#top", { utm_source: "threads", utm_medium: "social" });
  assert.equal(u, "https://rozum.one/audit?ref=x&utm_source=threads&utm_medium=social#top");
  assert.equal(withUtm("https://a.com/?utm_source=mine", { utm_source: "threads" }), "https://a.com/?utm_source=mine");
  assert.equal(withUtm("mailto:x@y.z", { utm_source: "t" }), "mailto:x@y.z");
});

test("куди можна вести: лише http(s) з нормальним хостом", () => {
  assert.equal(safeTarget(" https://rozum.one/a "), "https://rozum.one/a");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "https://user:pw@evil.com/", "http://localhost/", "ftp://a.com/x", "rozum.one", ""])
    assert.equal(safeTarget(bad), null, bad);
});

test("коди: 7 символів без схожих літер, щоразу інші", () => {
  const set = new Set(Array.from({ length: 500 }, () => newCode()));
  assert.equal(set.size, 500);
  for (const c of set) { assert.match(c, /^[a-km-zA-HJ-NP-Z2-9]{7}$/); assert.ok(isCode(c)); }
  assert.ok(!isCode("../etc")); assert.ok(!isCode("ab"));
});

test("боти-прев'юшники не рахуються, люди у вбудованих браузерах - рахуються", () => {
  for (const ua of ["TelegramBot (like TwitterBot)", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "LinkedInBot/1.0", "WhatsApp/2.23.20.0", "Twitterbot/1.0", "Mozilla/5.0 (compatible; Googlebot/2.1)", "curl/8.4.0", "", undefined])
    assert.equal(isBot(ua), true, String(ua));
  for (const ua of ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36 Telegram-Android/10.12.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 330.0.0.0",
    "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/460.0]", "Mozilla/5.0 (Windows NT 10.0) Chrome/126 Safari/537.36"])
    assert.equal(isBot(ua), false, ua);
});

test("адреса сторінки: латиниця й цифри, без подвійних розділювачів", () => {
  assert.equal(normSlug(" @Rozum.One "), "rozum.one");
  assert.equal(normSlug("vary_servis-kv"), "vary_servis-kv");
  for (const bad of ["ab", "-rozum", "rozum-", "ro..zum", "розум", "a".repeat(31), "rozum one"]) assert.equal(normSlug(bad), null, bad);
});

test("сторінка: усе екрановано, кнопки й плитки ведуть на короткі посилання, noindex на беті", () => {
  const html = bioHtml({ title: "Rozum <b>", bio: "AI для готелів & людей", base: "https://holos.rozum.one", slug: "rozum",
    links: [{ title: "Аудит \"x\"", href: "/s/Abc1234", emoji: "🔎" }], tiles: [{ title: "Пост <script>", href: "/s/Tile777", img: "/thumb/a.jpg" }, { title: "Текстовий", href: "/s/Tile888", img: null }],
    ogImage: "https://holos.rozum.one/media/a.jpg", noindex: true });
  assert.match(html, /<title>Rozum &lt;b&gt;<\/title>/);
  assert.ok(!html.includes("<script>") && html.includes("Пост &lt;script&gt;"));
  assert.match(html, /<a class="btn" href="\/s\/Abc1234" rel="noopener">🔎 Аудит &quot;x&quot;<\/a>/);
  assert.match(html, /class="tile" href="\/s\/Tile777"/);
  assert.match(html, /class="tile txt" href="\/s\/Tile888"/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /og:image" content="https:\/\/holos\.rozum\.one\/media\/a\.jpg"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/holos\.rozum\.one\/@rozum">/);
  assert.ok(!bioHtml({ title: "x", bio: "", base: "b", slug: "abc", links: [], tiles: [], ogImage: null, noindex: false }).includes("noindex"));
});
