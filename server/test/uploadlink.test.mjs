// 📤 Разове посилання на заливку фото з комп'ютера (інструмент конектора media_upload_link).
//
// Що тут стережемо: (1) гард формату токена ДО запиту в БД; (2) скрипт, який Claude запустить у
// терміналі людини: він мусить працювати в bash, dash і zsh (глоб *.{jpg,png} у zsh валить УСЮ
// команду, якщо хоч одного розширення в папці нема), не ламатись на комі в імені файлу, різати
// великі файли на шматки й сам переживати обрив зʼєднання;
// (3) відповідь приймача - рядок на файл, бо саме це Claude читає в терміналі; (4) сторінку для
// людини, куди назва кабінету потрапляє з бази - екранування обовʼязкове.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isUploadToken, clampMinutes, uploadCommands, uploadScript, uploadResultText, uploadPageHtml, UPLOAD_TEXT, UPLOAD_CHUNK,
} from "../dist/uploadlink.js";
import { randomBytes } from "node:crypto";

const URL = "https://beta.socialio.rozum.one/mcp/upload/" + "ab".repeat(24);

test("токен: рівно 48 hex у нижньому регістрі, інакше до бази навіть не йдемо", () => {
  assert.equal(isUploadToken("ab".repeat(24)), true);
  assert.equal(isUploadToken("a".repeat(64)), false, "адреса конектора - не посилання на заливку");
  assert.equal(isUploadToken("AB".repeat(24)), false);
  assert.equal(isUploadToken("ab".repeat(24) + "/"), false);
  assert.equal(isUploadToken(""), false);
  assert.equal(isUploadToken(undefined), false);
});

test("строк дії: 5-180 хвилин, сміття - година", () => {
  assert.equal(clampMinutes(undefined), 60);
  assert.equal(clampMinutes("30"), 30);
  assert.equal(clampMinutes(1), 5);
  assert.equal(clampMinutes(10000), 180);
  assert.equal(clampMinutes(-5), 60);
  assert.equal(clampMinutes("abc"), 60);
});

test("команда для папки: скачати скрипт і запустити через sh, адреса не виривається з лапок", () => {
  const c = uploadCommands(URL);
  assert.equal(c.unix, `curl -fsS "${URL}/sh" -o socialio-upload.sh && sh socialio-upload.sh "/шлях/до/папки"`);
  assert.doesNotMatch(c.unix, /\|\s*(ba)?sh/, "не curl | sh: скрипт спершу лягає файлом - його можна прочитати");
  assert.ok(c.windows.includes(`"${URL}"`) && c.windows.includes("curl.exe"));
  // навіть зіпсована адреса не додає в команду жодної лапки
  const bad = uploadCommands('https://x/mcp/upload/abc"; rm -rf ~; echo "');
  assert.equal((bad.unix.match(/"/g) || []).length, (c.unix.match(/"/g) || []).length);
  assert.doesNotMatch(uploadScript('https://x/mcp/upload/abc\'; rm -rf ~; echo \''), /rm -rf/, "адреса в скрипті - лише безпечні символи");
});

// Підроблений curl, що говорить протоколом /chunk: дописує шматок у файл за uid, відповідає «+ N/S»
// або «✓ …», і вміє раз «обірвати» зʼєднання (000) та раз сказати «! N» (продовжуй з байта N) -
// так перевіряється, що скрипт сам повторює й продовжує, а зібраний файл байт-у-байт той самий.
const FAKE_CURL = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a));

const name = (args.find((a) => a.startsWith("X-File-Name: ")) || "").slice(13);
const u = new URL(url);
const uid = u.searchParams.get("uid"), size = +u.searchParams.get("size"), off = +u.searchParams.get("offset");
const dir = process.env.RECV;
const body = fs.readFileSync(0);
const f = path.join(dir, uid);
const have = fs.existsSync(f) ? fs.statSync(f).size : 0;
fs.appendFileSync(path.join(dir, "calls.log"), uid + " " + off + " " + body.length + " " + name + "\\n");
const flag = path.join(dir, "flag-" + uid);
// другий шматок першого великого файлу: спершу «обрив», потім «! N» - обидва скрипт мусить пережити
if (off > 0 && name === "big.mp4" && !fs.existsSync(flag + "-000")) { fs.writeFileSync(flag + "-000", ""); process.stdout.write("curl: (56) Recv failure\\n000"); process.exit(0); }
if (off > 0 && name === "big.mp4" && !fs.existsSync(flag + "-409")) { fs.writeFileSync(flag + "-409", ""); process.stdout.write("! " + have + " бракує даних\\n409"); process.exit(0); }
if (off !== have) { process.stdout.write("! " + have + " бракує даних\\n409"); process.exit(0); }
fs.appendFileSync(f, body);
const got = have + body.length;
process.stdout.write((got < size ? "+ " + got + "/" + size + " " + name : "✓ " + name + " → #" + uid.slice(-8)) + "\\n200");
`;

test("скрипт справді заливає папку: bash, dash і zsh, великий файл частинами з обривом, кома в імені", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "upl-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "curl"), FAKE_CURL); chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "sleep"), 0o755); // без справжніх пауз між повторами
  const media = join(dir, "фото з відпустки"); mkdirSync(media);
  const big = randomBytes(UPLOAD_CHUNK * 2 + 12345);             // 3 шматки, останній неповний
  writeFileSync(join(media, "big.mp4"), big);
  const small = { "IMG_1.JPG": "jpg-bytes", "море, Одеса.jpeg": "comma", "iphone.HEIC": "heic", "clip.MOV": "mov" };
  for (const [n, c] of Object.entries(small)) writeFileSync(join(media, n), c);
  writeFileSync(join(media, "notes.txt"), "не медіа"); mkdirSync(join(media, "sub")); writeFileSync(join(media, "sub", "deep.jpg"), "x");
  const script = join(dir, "socialio-upload.sh");
  writeFileSync(script, uploadScript(URL));
  for (const shell of ["bash", "dash", "zsh"]) {
    const recv = join(dir, "recv-" + shell); mkdirSync(recv);
    let out = "";
    try { out = execFileSync(shell, [script, media], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RECV: recv }, encoding: "utf8" }); }
    catch (e) { if (e.code === "ENOENT") { t.diagnostic(`${shell} недоступний`); continue; } throw e; }
    const calls = readFileSync(join(recv, "calls.log"), "utf8").trim().split("\n").map((l) => l.split(" "));
    const names = [...new Set(calls.map((c) => c.slice(3).join(" ")))].sort();
    assert.deepEqual(names, ["IMG_1.JPG", "big.mp4", "clip.MOV", "iphone.HEIC", "море, Одеса.jpeg"].sort(), `${shell}: 5 медіа з кореня, без txt і підпапки`);
    const bigUid = calls.find((c) => c[3] === "big.mp4")[0];
    assert.ok(readFileSync(join(recv, bigUid)).equals(big), `${shell}: великий файл зібрано байт-у-байт, попри обрив і «продовжуй з N»`);
    assert.ok(Math.max(...calls.map((c) => +c[2])) <= UPLOAD_CHUNK, `${shell}: жоден шматок не більший за ${UPLOAD_CHUNK}`);
    for (const [n, c] of Object.entries(small)) {
      const uid = calls.find((x) => x.slice(3).join(" ") === n)[0];
      assert.equal(readFileSync(join(recv, uid), "utf8"), c, `${shell}: ${n} цілий`);
    }
    assert.match(out, /✓ big\.mp4 → #/, `${shell}: рядок результату для кожного файлу`);
    assert.match(out, /✓ море, Одеса\.jpeg → #/);
    assert.match(out, /^Готово/m);
  }
});

test("відповідь приймача: рядок на файл, дубль і збій видно, залишок - в останньому рядку", () => {
  const txt = uploadResultText({
    saved: [{ id: "#aa11bb22", name: "a.jpg", dup: false }, { id: "#cc33dd44", name: "b.jpg", dup: true }],
    failed: [{ name: "c.mp4", error: UPLOAD_TEXT.video }], left: 198,
  });
  assert.equal(txt, `✓ a.jpg → #aa11bb22\n= b.jpg уже в медіатеці → #cc33dd44\n✗ c.mp4: ${UPLOAD_TEXT.video} · лишилось місць: 198\n`);
  assert.equal(uploadResultText({ saved: [], failed: [], left: null }), "✗ файл не надійшов\n");
});

test("сторінка: назва кабінету екранована, протухле посилання не має куди кидати файли", () => {
  const ok = uploadPageHtml({ state: "ok", cabinet: '<img src=x onerror=alert(1)>"', until: "26.09, 18:00", left: 200 });
  assert.ok(!ok.includes("<img src=x"), "назва кабінету приходить з бази - тільки екранованою");
  assert.ok(ok.includes("&lt;img src=x onerror=alert(1)&gt;&quot;"));
  assert.ok(ok.includes("/chunk?uid=") && ok.includes("Accept:'application/json'"), "сторінка шле файли частинами");
  assert.ok(ok.includes('accept="image/*,video/*"'), "і фото, і відео");
  const gone = uploadPageHtml({ state: "expired" });
  assert.ok(gone.includes("протухло") && !gone.includes('id="dz"'));
  assert.ok(!uploadPageHtml({ state: "invalid" }).includes('type="file"'));
});
