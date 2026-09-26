// 🎬 Власне відео: заливка частинами, метадані й підписи.
//
// Що тут стережемо: (1) протокол шматків - повтор уже записаного нічого не псує, «дірка» відхиляється
// з тим, скільки в сервера вже є, частково перекритий шматок дописує лише хвіст, а повтор ОСТАННЬОГО
// шматка після обриву вертає той самий результат (файл уже в медіатеці, частин більше нема);
// (2) імʼя файлу приходить і від браузера (percent), і від curl (сирі байти UTF-8, які Node читає
// як latin1) - обидва мусять дати ту саму кирилицю, а шлях у імені - не пройти; (3) відео з телефона
// з поміткою «повернути на 90°» міряється так, як його покаже мережа.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { putChunk, headerFileName, isUid, ChunkError, CHUNK_DIR } from "../dist/chunks.js";
import { probeVideo } from "../dist/media.js";
import { fmtDur, mediaLine } from "../dist/mcp.js";
import { fbVideoLink } from "../dist/permalink.js";

const uid = () => "t" + randomBytes(8).toString("hex");
// частини навмисно недолитих заливок цього тесту не лишаємо в media/tmp (там їх чекає лише сторож)
const h16 = (x) => createHash("sha1").update(x).digest("hex").slice(0, 16);
const cleanup = (scope) => { for (const f of readdirSync(CHUNK_DIR)) if (f.startsWith(h16(scope) + "-")) unlinkSync(join(CHUNK_DIR, f)); };
const collect = async (path) => readFileSync(path);

test("шматки: по черзі, повтор, дірка, перекриття, повтор останнього", async () => {
  const file = randomBytes(250), id = uid(), scope = "test:" + id;
  const put = (off, len) => putChunk(scope, id, "clip.mp4", file.length, off, file.subarray(off, off + len), collect);
  assert.deepEqual(await put(0, 100), { done: false, received: 100, size: 250 });
  assert.deepEqual(await put(0, 100), { done: false, received: 100, size: 250 }, "повтор уже записаного - нічого не дописує");
  await assert.rejects(put(150, 50), (e) => e instanceof ChunkError && e.status === 409 && e.received === 100, "дірка → 409 з received");
  assert.equal((await put(50, 100)).received, 150, "перекриття 50..150 дописує лише 100..150");
  const last = await put(150, 100);
  assert.equal(last.done, true);
  assert.ok(last.result.equals(file), "зібраний файл байт-у-байт той самий");
  const again = await put(150, 100);
  assert.ok(again.done && again.result.equals(file), "повтор останнього шматка - той самий результат");
  const key = `${h16(scope)}-${h16(id)}`;
  assert.deepEqual(readdirSync(CHUNK_DIR).filter((f) => f.startsWith(key)), [], "тимчасових частин цієї заливки не лишилось");
});

test("шматки: межі й сміття відсікаються до роботи з диском", async () => {
  const b = Buffer.alloc(10);
  await assert.rejects(putChunk("t", "../../etc", "a", 10, 0, b, collect), /uid/);
  await assert.rejects(putChunk("t", uid(), "a", 0, 0, b, collect), /size/);
  await assert.rejects(putChunk("t", uid(), "a", 10, -1, b, collect), /offset/);
  await assert.rejects(putChunk("t", uid(), "a", 600 * 1024 * 1024, 0, b, collect), (e) => e.status === 413 && /МБ/.test(e.message));
  await assert.rejects(putChunk("t", uid(), "a", 10, 5, b, collect), (e) => e.status === 409 && e.received === 0, "нова заливка не з нуля - почни спочатку");
  const id = uid();
  await putChunk("t", id, "a", 20, 0, b, collect);
  await assert.rejects(putChunk("t", id, "a", 30, 10, b, collect), /розмір файлу змінився/);
  await assert.rejects(putChunk("t", id, "a", 20, 10, Buffer.alloc(15), collect), /більше, ніж заявлено/);
  cleanup("t");
  assert.equal(isUid("abcdef"), true);
  assert.equal(isUid("abc"), false);
  assert.equal(isUid("a".repeat(65)), false);
});

test("шматки: збій збирання = відмова, і частини прибрано", async () => {
  const id = uid();
  await assert.rejects(putChunk("t", id, "notes.mp4", 5, 0, Buffer.from("hello"), async () => { throw new Error("не відео"); }), /не відео/);
  assert.equal((await putChunk("t", id, "notes.mp4", 5, 0, Buffer.from("hello"), collect)).done, true, "після відмови той самий uid починається з нуля");
  cleanup("t");
});

test("імʼя файлу: браузер (percent) і curl (сирі UTF-8) дають те саме, шлях не проходить", () => {
  const name = "Туман, озеро.mp4";
  assert.equal(headerFileName(encodeURIComponent(name)), name);
  assert.equal(headerFileName(Buffer.from(name, "utf8").toString("latin1")), name, "curl шле байти, Node читає latin1");
  assert.equal(headerFileName("../../etc/passwd"), "....etcpasswd");
  assert.equal(headerFileName("a\u0000b\nc.mp4"), "abc.mp4");
  assert.equal(headerFileName(undefined), "");
  assert.equal(headerFileName("100%"), "100%", "не-percent з відсотком лишається як є");
});

test("тривалість і підписи: 0:06, 6:40, відео в описі поста, лінк на FB-відео", () => {
  assert.equal(fmtDur(6), "0:06");
  assert.equal(fmtDur(400), "6:40");
  assert.equal(fmtDur(0), "");
  assert.equal(fmtDur(null), "");
  assert.equal(mediaLine([{ id: "v", kind: "video", duration: 42 }]), " · відео 0:42");
  assert.equal(mediaLine([{ id: "v", kind: "video" }]), " · відео");
  assert.equal(mediaLine([{ id: "a" }]), " · є фото");
  assert.equal(mediaLine([{ id: "a" }, { id: "b" }]), " · карусель, 2 кадрів");
  assert.equal(fbVideoLink("770012"), "https://www.facebook.com/watch/?v=770012");
  assert.equal(fbVideoLink("pg_12"), "", "не числовий id - не вигадуємо адресу");
  assert.equal(fbVideoLink(null), "");
});

test("вимір відео: поворот телефона враховано (потрібен ffmpeg)", async (t) => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { t.skip("ffmpeg недоступний"); return; }
  const dir = mkdtempSync(join(tmpdir(), "vid-"));
  const src = join(dir, "p.mp4"), rot = join(dir, "r.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x640:rate=10", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-display_rotation", "90", "-i", src, "-c", "copy", rot]);
  const a = await probeVideo(src), b = await probeVideo(rot);
  assert.deepEqual([a.width, a.height, Math.round(a.duration)], [320, 640, 2]);
  assert.deepEqual([b.width, b.height], [640, 320], "закодовано 320×640 + поворот 90° → показується 640×320");
  assert.equal(await probeVideo(join(dir, "нема.mp4")), null);
});
