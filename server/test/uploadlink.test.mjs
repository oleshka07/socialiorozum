// 📤 Разове посилання на заливку фото з комп'ютера (інструмент конектора media_upload_link).
//
// Що тут стережемо: (1) гард формату токена ДО запиту в БД; (2) команду, яку Claude запустить у
// терміналі людини: вона мусить працювати і в bash, і в zsh (глоб *.{jpg,png} у zsh валить УСЮ
// команду, якщо хоч одного розширення в папці нема), і не ламатись на комі в імені файлу;
// (3) відповідь приймача - рядок на файл, бо саме це Claude читає в терміналі; (4) сторінку для
// людини, куди назва кабінету потрапляє з бази - екранування обовʼязкове.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isUploadToken, clampMinutes, uploadCommands, uploadResultText, uploadPageHtml, UPLOAD_TEXT, UPLOAD_FILE_MAX,
} from "../dist/uploadlink.js";

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

test("команда для папки: find замість глоба, лише фото, адреса не виривається з лапок", () => {
  const c = uploadCommands(URL);
  assert.match(c.unix, /^find "\/шлях\/до\/папки" -maxdepth 1 -type f /);
  assert.doesNotMatch(c.unix, /\*\.\{/, "глоб із дужками валить zsh на папці без якогось розширення");
  for (const ext of ["jpg", "jpeg", "png", "webp", "heic"]) assert.ok(c.unix.includes(`-iname '*.${ext}'`), ext);
  assert.ok(c.unix.includes(`"${URL}"`));
  assert.ok(c.windows.includes(`"${URL}"`) && c.windows.includes("curl.exe"));
  // навіть зіпсована адреса не додає в команду жодної лапки
  const bad = uploadCommands('https://x/mcp/upload/abc"; rm -rf ~; echo "');
  assert.equal((bad.unix.match(/"/g) || []).length, (c.unix.match(/"/g) || []).length);
});

test("команда справді заливає папку: bash, sh і zsh, кома в імені, відео й текст пропущено", (t) => {
  // curl підміняємо записом аргументів: перевіряємо саме те, що побачить справжній curl
  const dir = mkdtempSync(join(tmpdir(), "upl-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const log = join(dir, "calls.log");
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"\necho '--' >> "${log}"\n`);
  chmodSync(join(bin, "curl"), 0o755);
  const photos = join(dir, "фото з відпустки"); mkdirSync(photos);
  for (const f of ["IMG_1.JPG", "море, Одеса.jpeg", "screen.png", "iphone.HEIC", "clip.mp4", "notes.txt"]) writeFileSync(join(photos, f), "x");
  mkdirSync(join(photos, "sub")); writeFileSync(join(photos, "sub", "deep.jpg"), "x");
  const cmd = uploadCommands(URL).unix.replace("/шлях/до/папки", photos);
  for (const shell of ["bash", "sh", "zsh"]) {
    writeFileSync(log, "");
    try { execFileSync(shell, ["-c", cmd], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }); }
    catch (e) { if (e.code === "ENOENT") { t.diagnostic(`${shell} недоступний`); continue; } throw e; }
    const calls = readFileSync(log, "utf8").split("--\n").filter(Boolean);
    const files = calls.map((c) => c.split("\n").find((l) => l.startsWith("file=@"))).sort();
    assert.deepEqual(files, [
      `file=@"${photos}/IMG_1.JPG"`, `file=@"${photos}/iphone.HEIC"`, `file=@"${photos}/screen.png"`, `file=@"${photos}/море, Одеса.jpeg"`,
    ].sort(), `${shell}: мають піти рівно 4 фото з кореня папки, кома - в лапках`);
    assert.ok(calls.every((c) => c.includes(URL)), `${shell}: кожен виклик - на наше посилання`);
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
  assert.ok(ok.includes(`MAX=${UPLOAD_FILE_MAX}`) && ok.includes("Accept:'application/json'"));
  const gone = uploadPageHtml({ state: "expired" });
  assert.ok(gone.includes("протухло") && !gone.includes('id="dz"'));
  assert.ok(!uploadPageHtml({ state: "invalid" }).includes('type="file"'));
});
