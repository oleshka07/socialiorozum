// 🎬 YouTube і TikTok як мережі для відео: правила й протоколи без живих мереж.
//
// Що тут стережемо: (1) як різати файл для TikTok (до 64 МБ - цілим, далі шматки по 10 МБ, залишок -
// з останнім) і що шматки йдуть послідовно з правильним Content-Range; (2) id поста TikTok - 19 цифр, які
// JSON.parse тихо округлює, - посилання мусить вести саме на цей пост; (3) правила TikTok для прямої
// публікації: «Хто бачить» без типового значення, брендований контент не «Лише я», межа тривалості,
// вимкнене автором лишається вимкненим; (4) resumable upload YouTube: 308 «ще не все» з Range, обрив
// посеред шматка - питаємо, скільки дійшло, і продовжуємо звідти, а не з нуля; (5) назва й опис YouTube
// без < і >, посилання Shorts лише для вертикального до 3 хв.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import * as tt from "../dist/tiktok.js";
import * as yt from "../dist/youtube.js";
import { ttOpts, ytOpts, ttPost, ttLine, ytLine, mergeTt, mergeYt, ttPrivacyOf } from "../dist/vidnets.js";
import { outcomeOf } from "../dist/vidpub.js";

const dir = mkdtempSync(join(tmpdir(), "vidnets-"));
const fileOf = (n) => { const b = randomBytes(n); const p = join(dir, `v${n}.mp4`); writeFileSync(p, b); return { p, b }; };
const withFetch = async (impl, fn) => { const orig = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = orig; } };

test("TikTok: як різати файл", () => {
  assert.deepEqual(tt.chunkPlan(1000), { chunkSize: 1000, total: 1, ranges: [[0, 999]] });
  const p64 = tt.chunkPlan(64_000_000);
  assert.equal(p64.total, 1);
  const p = tt.chunkPlan(64_000_001);
  assert.equal(p.chunkSize, 10_000_000);
  assert.equal(p.total, 6);
  assert.deepEqual(p.ranges[0], [0, 9_999_999]);
  assert.deepEqual(p.ranges[5], [50_000_000, 64_000_000]);   // залишок - з останнім шматком
  const big = tt.chunkPlan(500 * 1024 * 1024);
  const last = big.ranges[big.ranges.length - 1];
  assert.equal(last[1], 500 * 1024 * 1024 - 1);
  assert.ok(last[1] - last[0] + 1 < 20_000_000 && last[1] - last[0] + 1 >= 10_000_000);
  for (let i = 1; i < big.ranges.length; i++) assert.equal(big.ranges[i][0], big.ranges[i - 1][1] + 1, "без дірок і перекриттів");
  assert.throws(() => tt.chunkPlan(0));
});

test("TikTok: id поста з сирого тексту - без округлення JSON", () => {
  const raw = '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7302012345678901234],"uploaded_bytes":10},"error":{"code":"ok"}}';
  assert.equal(JSON.parse(raw).data.publicaly_available_post_id[0].toString() === "7302012345678901234", false, "JSON справді округлює");
  assert.deepEqual(tt.postIdsFromRaw(raw), ["7302012345678901234"]);
  assert.deepEqual(tt.postIdsFromRaw('{"data":{"publicaly_available_post_id":["7302012345678901234", 7302012345678901999]}}'), ["7302012345678901234", "7302012345678901999"]);
  assert.deepEqual(tt.postIdsFromRaw('{"data":{"status":"PROCESSING_UPLOAD"}}'), []);
  assert.equal(tt.ttLink("@holos", "7302012345678901234"), "https://www.tiktok.com/@holos/video/7302012345678901234");
  assert.equal(tt.ttLink("", "7302012345678901234"), "");
});

test("TikTok: правила прямої публікації", () => {
  const info = { nickname: "Holos", username: "holos", avatarUrl: "", privacyOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], commentDisabled: true, duetDisabled: false, stitchDisabled: false, maxDurationSec: 180 };
  const base = { title: "Привіт #holos", privacy: "", allowComment: true, allowDuet: true, allowStitch: false, yourBrand: false, brandedContent: false, aigc: false };
  assert.match(tt.checkPost(base, info), /обери, хто бачитиме/);
  assert.match(tt.checkPost({ ...base, privacy: "FOLLOWER_OF_CREATOR" }, info), /недоступний для @holos/);
  assert.match(tt.checkPost({ ...base, privacy: "SELF_ONLY", brandedContent: true }, info), /брендований/);
  assert.match(tt.checkPost({ ...base, privacy: "PUBLIC_TO_EVERYONE" }, info, 200), /до 3 хв, а тут 3 хв 20 с/);
  assert.equal(tt.checkPost({ ...base, privacy: "PUBLIC_TO_EVERYONE" }, info, 60), null);
  const body = tt.postInfoBody({ ...base, privacy: "PUBLIC_TO_EVERYONE", aigc: true }, info);
  assert.equal(body.privacy_level, "PUBLIC_TO_EVERYONE");
  assert.equal(body.disable_comment, true, "коментарі вимкнув автор у TikTok - лишаються вимкненими");
  assert.equal(body.disable_duet, false);
  assert.equal(body.disable_stitch, true, "не дозволили - вимкнено");
  assert.equal(body.is_aigc, true);
  assert.equal(body.brand_content_toggle, false);
  assert.equal(tt.cutTitle("а".repeat(3000)).length <= tt.TT_TITLE_MAX, true);
});

test("TikTok: тексти помилок і причин", () => {
  assert.match(tt.ttHuman("unaudited_client_can_only_post_to_private_accounts"), /не перевірив/);
  assert.match(tt.ttHuman("access_token_invalid"), /підключи TikTok ще раз/);
  assert.match(tt.ttHuman("spam_risk_too_many_posts"), /ліміт постів/);
  assert.match(tt.ttHuman("щось_нове", "Some message"), /Some message/);
  assert.match(tt.failReasonText("frame_rate_check_failed"), /23 до 60/);
  assert.match(tt.failReasonText("невідоме"), /невідоме/);
  assert.equal(tt.mimeOf("a.MOV"), "video/quicktime");
  assert.equal(tt.mimeOf("a.mp4"), "video/mp4");
});

test("TikTok: заливка шматками - послідовно, з Content-Range, повтор збою", async () => {
  const size = 64_000_000 + 15_000_000;
  const { p, b } = fileOf(size);
  const plan = tt.chunkPlan(size);
  const got = []; let fails = 1;
  await withFetch(async (url, init) => {
    assert.equal(url, "https://upload.test/tt");
    assert.equal(init.method, "PUT");
    const body = Buffer.from(init.body);
    if (fails-- > 0) return new Response("", { status: 503 });   // перший шматок - тимчасовий збій
    got.push({ range: init.headers["Content-Range"], type: init.headers["Content-Type"], body });
    return new Response("", { status: 206 });
  }, () => tt.uploadFile({ publishId: "p1", uploadUrl: "https://upload.test/tt", plan }, p, "video/mp4", size));
  assert.equal(got.length, plan.total);
  assert.equal(got[0].range, `bytes 0-9999999/${size}`);
  assert.equal(got[got.length - 1].range, `bytes ${(plan.total - 1) * 10_000_000}-${size - 1}/${size}`);
  assert.ok(Buffer.concat(got.map((g) => g.body)).equals(b), "байт-у-байт");
  assert.ok(got.every((g) => g.type === "video/mp4"));
});

test("TikTok: стан публікації → що з постом", () => {
  assert.deepEqual(outcomeOf({ status: "PUBLISH_COMPLETE", failReason: "", postIds: ["7302012345678901234"], uploadedBytes: 1 }, "direct", "holos"),
    { state: "sent", ttStatus: "PUBLISH_COMPLETE", videoId: "7302012345678901234", permalink: "https://www.tiktok.com/@holos/video/7302012345678901234", error: "" });
  assert.equal(outcomeOf({ status: "SEND_TO_USER_INBOX", failReason: "", postIds: [], uploadedBytes: 1 }, "inbox", "holos").state, "sent");
  assert.equal(outcomeOf({ status: "SEND_TO_USER_INBOX", failReason: "", postIds: [], uploadedBytes: 1 }, "direct", "holos").state, "processing");
  const f = outcomeOf({ status: "FAILED", failReason: "spam_risk_text", postIds: [], uploadedBytes: 0 }, "direct", "holos");
  assert.equal(f.state, "failed");
  assert.match(f.error, /спамом/);
  assert.equal(outcomeOf({ status: "PROCESSING_UPLOAD", failReason: "", postIds: [], uploadedBytes: 0 }, "direct", "holos").state, "processing");
});

test("TikTok: помилка API - код і людський текст; 19 цифр у стані", async () => {
  await withFetch(async () => new Response('{"error":{"code":"privacy_level_option_mismatch","message":"x"}}', { status: 400 }),
    async () => {
      await assert.rejects(tt.initInbox("tok", 1000), (e) => e instanceof tt.TikTokError && e.code === "privacy_level_option_mismatch" && /Хто бачить/.test(e.message));
    });
  await withFetch(async (url, init) => {
    assert.match(url, /status\/fetch/);
    assert.deepEqual(JSON.parse(init.body), { publish_id: "v_pub_1" });
    return new Response('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7302012345678901234]},"error":{"code":"ok","message":""}}', { status: 200 });
  }, async () => {
    const st = await tt.fetchStatus("tok", "v_pub_1");
    assert.equal(st.status, "PUBLISH_COMPLETE");
    assert.deepEqual(st.postIds, ["7302012345678901234"]);
  });
});

test("YouTube: назва, опис, посилання", () => {
  assert.equal(yt.cleanTitle("  <b>Привіт</b>\n світ  "), "bПривіт/b світ");
  assert.ok(yt.cleanTitle("слово ".repeat(40)).length <= 100);
  assert.equal(yt.cleanDescription("a < b > c"), "a ‹ b › c");
  assert.equal(yt.titleFrom("#holos #shorts\nhttps://x.com\nЯк ми зекономили 3 години\nдалі"), "Як ми зекономили 3 години");
  assert.equal(yt.titleFrom("#тег"), "");
  assert.equal(yt.ytLink("abcDEF12345", { width: 1080, height: 1920, duration: 45 }), "https://www.youtube.com/shorts/abcDEF12345");
  assert.equal(yt.ytLink("abcDEF12345", { width: 1080, height: 1920, duration: 200 }), "https://www.youtube.com/watch?v=abcDEF12345");
  assert.equal(yt.ytLink("abcDEF12345", { width: 1920, height: 1080, duration: 45 }), "https://www.youtube.com/watch?v=abcDEF12345");
  assert.equal(yt.ytLink("bad id"), "");
  assert.equal(yt.rangeNext("bytes=0-524287"), 524288);
  assert.equal(yt.rangeNext(null), 0);
  const m = yt.uploadMeta({ title: "T", description: "D", privacy: "unlisted", madeForKids: true, synthetic: true });
  assert.deepEqual(m.status, { privacyStatus: "unlisted", selfDeclaredMadeForKids: true, embeddable: true, containsSyntheticMedia: true });
  assert.equal("containsSyntheticMedia" in yt.uploadMeta({ title: "T", description: "", privacy: "public", madeForKids: false, synthetic: true }, false).status, false);
  assert.match(yt.ytHuman(403, "quotaExceeded"), /ліміт завантажень Holos/);
  assert.match(yt.ytHuman(401, ""), /підключи YouTube ще раз/);
  assert.match(yt.ytHuman(403, "youtubeSignupRequired"), /нема каналу/);
});

test("YouTube: resumable - 308, обрив посеред шматка, продовження з того місця", async () => {
  const size = 3 * 256 * 1024 + 1234;
  const { p, b } = fileOf(size);
  const chunk = 256 * 1024;
  let have = 0, dropOnce = true, startMeta = null;
  const calls = [];
  const res = await withFetch(async (url, init) => {
    if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
      startMeta = JSON.parse(init.body);
      assert.equal(init.headers["X-Upload-Content-Length"], String(size));
      return new Response("", { status: 200, headers: { Location: "https://upload.test/session" } });
    }
    assert.equal(url, "https://upload.test/session");
    const cr = init.headers["Content-Range"];
    calls.push(cr);
    if (cr === `bytes */${size}`) return new Response("", { status: 308, headers: have ? { Range: `bytes=0-${have - 1}` } : {} });
    const m = cr.match(/bytes (\d+)-(\d+)\/(\d+)/);
    const start = Number(m[1]), body = Buffer.from(init.body);
    assert.equal(start, have, "продовжуємо рівно з того, що вже є");
    if (start === chunk && dropOnce) {
      // обрив: дійшла лише половина шматка
      dropOnce = false; have += body.length / 2;
      throw new TypeError("fetch failed");
    }
    assert.ok(b.subarray(start, start + body.length).equals(body), "байти шматка - з файлу");
    have = start + body.length;
    if (have === size) return Response.json({ id: "vid123ABC_x", status: { privacyStatus: "private", uploadStatus: "uploaded" } }, { status: 200 });
    return new Response("", { status: 308, headers: { Range: `bytes=0-${have - 1}` } });
  }, () => yt.uploadResumable("tok", p, size, "video/mp4", { title: "Назва <x>", description: "Опис", privacy: "public", madeForKids: false, synthetic: false }, chunk));
  assert.deepEqual(res, { videoId: "vid123ABC_x", privacy: "private", uploadStatus: "uploaded" });
  assert.equal(startMeta.snippet.title, "Назва x");
  assert.ok(calls.includes(`bytes */${size}`), "після обриву спитали, скільки дійшло");
  assert.equal(have, size);
});

test("YouTube: невідома позначка AI-вмісту - заливаємо без неї, а не падаємо", async () => {
  const { p } = fileOf(1000);
  let starts = 0;
  const r = await withFetch(async (url, init) => {
    if (url.includes("uploadType=resumable")) {
      starts++;
      const meta = JSON.parse(init.body);
      if ("containsSyntheticMedia" in meta.status) return Response.json({ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "containsSyntheticMedia" at \'resource.status\'', errors: [{ reason: "badRequest" }] } }, { status: 400 });
      return new Response("", { status: 200, headers: { Location: "https://upload.test/s2" } });
    }
    return Response.json({ id: "abcdefgh123", status: { privacyStatus: "public" } }, { status: 201 });
  }, () => yt.uploadResumable("tok", p, 1000, "video/mp4", { title: "T", description: "", privacy: "public", madeForKids: false, synthetic: true }));
  assert.equal(starts, 2);
  assert.equal(r.syntheticDropped, true);
  assert.equal(r.videoId, "abcdefgh123");
});

test("налаштування поста: TikTok і YouTube", () => {
  assert.equal(ttOpts({}).mode, "draft", "без «Хто бачить» - у чернетки");
  assert.equal(ttOpts({ privacy: "SELF_ONLY" }).mode, "direct");
  assert.equal(ttOpts({ privacy: "SELF_ONLY", mode: "draft" }).mode, "draft");
  assert.equal(ttOpts({ privacy: "щось" }).privacy, "");
  const o = ttOpts({ privacy: "PUBLIC_TO_EVERYONE", comment: true, branded: true });
  assert.equal(ttPost(o, "т").brandedContent, true);
  assert.match(ttLine(o), /бачать: Усі.*коментарі.*Paid partnership/);
  assert.match(ttLine(ttOpts({})), /чернетки/);
  assert.equal(ttPrivacyOf("followers"), "FOLLOWER_OF_CREATOR");
  assert.equal(ttPrivacyOf("лише я"), "SELF_ONLY");
  assert.deepEqual(mergeTt({ on: true }, { privacy: "public", allow_comments: true }).value, { on: true, privacy: "PUBLIC_TO_EVERYONE", mode: "direct", comment: true });
  assert.match(mergeTt({}, { privacy: "nobody" }).error, /невідоме/);
  assert.match(mergeTt({}, { privacy: "private", branded_content: true }).error, /брендований/);
  assert.equal(mergeTt({ privacy: "SELF_ONLY", mode: "direct" }, { mode: "draft" }).value.mode, "draft");
  const y = ytOpts({ privacy: "unlisted", kids: true, title: "<Назва>" });
  assert.deepEqual(y, { title: "Назва", privacy: "unlisted", kids: true, ai: false });
  assert.equal(ytOpts({ privacy: "weird" }).privacy, "public");
  assert.match(ytLine(y), /«Назва» · бачать: За посиланням · для дітей/);
  assert.deepEqual(mergeYt({ on: true }, { privacy: "private", made_for_kids: false, ai_generated: true, title: "T" }).value, { on: true, privacy: "private", kids: false, ai: true, title: "T" });
  assert.match(mergeYt({}, { privacy: "secret" }).error, /невідома видимість/);
});
