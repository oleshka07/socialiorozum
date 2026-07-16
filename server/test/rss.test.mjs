// Юніти RSS-парсера (регресія: екранований HTML виживав у тілі матеріалу; CDATA; Atom).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, parseFeed, parseFeedTitle } from "../dist/rss.js";

test("cleanText: подвійно екранований HTML не лишає тегів і сутностей", () => {
  const dirty = "&lt;a href=&quot;https://x&quot;&gt;лінк&lt;/a&gt;&amp;nbsp;текст";
  const out = cleanText(dirty);
  assert.ok(!out.includes("<a"), "тег вижив: " + out);
  assert.ok(!out.includes("&nbsp;"), "сутність вижила: " + out);
  assert.ok(out.includes("лінк") && out.includes("текст"));
});

const RSS = `<?xml version="1.0"?><rss><channel><title>Тестова стрічка</title>
<item><title><![CDATA[Перша новина]]></title><link>https://a/1</link><description><![CDATA[<p>Тіло 1</p>]]></description><guid>g1</guid></item>
<item><title>Друга &amp; новина</title><link>https://a/2</link><description>Тіло 2</description><guid>g2</guid></item>
</channel></rss>`;

test("parseFeed: RSS з CDATA і сутностями", () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Перша новина");
  assert.equal(items[1].title, "Друга & новина");
  assert.ok(!String(items[0].content || items[0].description || "").includes("<p>"), "HTML-тег у тілі");
});

test("parseFeedTitle: назва каналу без item-заголовків", () => {
  assert.equal(parseFeedTitle(RSS), "Тестова стрічка");
});

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Атом-фід</title>
<entry><title>Запис 1</title><link href="https://b/1"/><summary>Опис 1</summary><id>a1</id></entry></feed>`;

test("parseFeed: Atom-формат", () => {
  const items = parseFeed(ATOM);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Запис 1");
});
