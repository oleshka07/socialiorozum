// 📤 Разове посилання на завантаження фото в медіатеку кабінету.
//
// Навіщо: Claude у Cowork чи Claude Code бачить папку з фото на комп'ютері людини, але передати
// файл у конектор через модель неможливо (єдиний канал - текстові аргументи, а фото текстом - це
// мільйони символів). Тож конектор видає посилання, і файли йдуть НАПРЯМУ з комп'ютера на сервер
// однією командою - curl у циклі по папці. Людина те саме посилання може відкрити в браузері й
// просто перетягнути фото.
//
// Межі, які тримають це безпечним навіть якщо посилання потрапить у чужі руки: воно лише ДОДАЄ
// фото в медіатеку одного кабінету (нічого не читає й не показує), живе хвилини, має ліміт файлів,
// а формат токена перевіряється ДО запиту в БД.
import { randomBytes } from "node:crypto";
import { q, one } from "./db.js";
import { env } from "./env.js";

export const UPLOAD_MAX_FILES = 200;

export const isUploadToken = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{48}$/.test(t);

// 5-180 хвилин; за замовчуванням година - на велику папку з повільним інтернетом має вистачити
export function clampMinutes(m: unknown): number {
  const n = Math.round(Number(m));
  return Number.isFinite(n) && n > 0 ? Math.min(180, Math.max(5, n)) : 60;
}

export async function issueUploadLink(ws: string, userId: string | null, minutes: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + clampMinutes(minutes) * 60_000);
  await q(`insert into upload_link(token, workspace_id, user_id, expires_at, files_left) values($1,$2,$3,$4,$5)`,
    [token, ws, userId, expiresAt.toISOString(), UPLOAD_MAX_FILES]);
  return { token, expiresAt };
}

export type UploadLinkState = { ws: string; filesLeft: number; uploaded: number; expiresAt: string } | "expired" | null;

export async function uploadLinkState(token: unknown): Promise<UploadLinkState> {
  if (!isUploadToken(token)) return null;
  const r = await one<{ workspace_id: string; files_left: number; uploaded: number; expires_at: string; live: boolean }>(
    `select workspace_id, files_left, uploaded, expires_at, expires_at > now() as live from upload_link where token=$1`, [token]);
  if (!r) return null;
  if (!r.live) return "expired";
  return { ws: r.workspace_id, filesLeft: r.files_left, uploaded: r.uploaded, expiresAt: r.expires_at };
}

// Місце під файл забирається АТОМАРНО: паралельні запити скрипта інакше разом проскочили б ліміт.
// bytes - розмір файлу: у посилання є ще й байтовий бюджет (відео по 500 МБ інакше дозволили б одним
// посиланням забити диск сервера)
export async function takeUploadSlot(token: string, bytes = 0): Promise<boolean> {
  return !!(await one(`update upload_link set files_left = files_left - 1, bytes_left = bytes_left - $2
                        where token=$1 and files_left > 0 and bytes_left >= $2 and expires_at > now() returning 1`, [token, bytes]));
}
export const markUploaded = (token: string) => q(`update upload_link set uploaded = uploaded + 1 where token=$1`, [token]);
// битий файл (і дубль, який нічого не додав) місця не зʼїдає
export const refundUploadSlot = (token: string, bytes = 0) =>
  q(`update upload_link set files_left = files_left + 1, bytes_left = bytes_left + $2 where token=$1`, [token, bytes]);
export const sweepUploadLinks = () => q(`delete from upload_link where expires_at < now() - interval '1 day'`);

export const uploadUrl = (token: string): string => `${env.appBaseUrl}/mcp/upload/${token}`;

// Один запит (фото через -F) - до 20 МБ: стільки пропускає nginx (client_max_body_size). Більші
// файли (відео) йдуть частинами на /chunk - див. uploadScript нижче.
export const UPLOAD_FILE_MAX = 20 * 1024 * 1024;
export const UPLOAD_TEXT = {
  invalid: "Посилання недійсне.",
  expired: "Посилання протухло - попроси в Claude нове (інструмент media_upload_link).",
  noSlots: "ліміт файлів на це посилання вичерпано - попроси в Claude нове",
  noBytes: "на це посилання вже залито забагато (ліміт 5 ГБ) - попроси в Claude нове",
  video: "це відео - одним запитом лише фото; відео заливай скриптом (команда з media_upload_link) або на сторінці посилання",
  notImage: "це не фото - приймаємо JPG, PNG, WebP, HEIC",
  tooBig: "файл більший за 20 МБ - такі йдуть частинами: скрипт із media_upload_link або сторінка посилання в браузері",
  notMultipart: 'надішли файл як multipart/form-data: curl -F "file=@фото.jpg" <адреса>',
};

const MEDIA_EXTS = ["jpg", "jpeg", "png", "webp", "heic", "heif", "mp4", "mov", "m4v", "webm"];
export const UPLOAD_CHUNK = 15 * 1024 * 1024; // шматок скрипта: під 20 МБ nginx із запасом

/**
 * Скрипт «залий цю папку» (фото й відео). POSIX sh: однаково працює в bash, dash, zsh (як `sh
 * файл`), BusyBox і Git Bash на Windows. Великі файли ріже на шматки по 15 МБ і шле по черзі; обірвався
 * шматок - повторює, сервер каже, з якого байта продовжити. Скрипт лише ЧИТАЄ файли з указаної папки
 * (без підпапок) і шле їх на цю адресу - більше нічого, тож його легко прочитати перед запуском.
 * find, а не глоб: у zsh глоб, що нічого не знайшов, валить усю команду («no matches found»).
 */
export function uploadScript(url: string): string {
  const u = url.replace(/[^A-Za-z0-9:/._-]/g, "");
  const names = MEDIA_EXTS.map((e) => `-iname '*.${e}'`).join(" -o ");
  // String.raw: бекслеші (sed, find \( \), printf '\n') мусять дійти до шелу як є. Тому й «${…}»
  // шелу в скрипті нема - лише наші три підстановки
  return String.raw`#!/bin/sh
# socialio: залити фото й відео з папки в медіатеку кабінету (разове посилання).
# Запуск: sh socialio-upload.sh "/шлях/до/папки"   - лише файли цієї папки, без підпапок.
# Скрипт тільки читає файли з цієї папки й шле їх на адресу нижче. Більше нічого не робить.
U='${u}'
CH=${UPLOAD_CHUNK}
DIR="$1"; [ -n "$DIR" ] || DIR=.
T="$TMPDIR"; [ -n "$T" ] || T=/tmp
[ -d "$DIR" ] || { echo "✗ папки нема: $DIR" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "✗ потрібен curl" >&2; exit 1; }
LIST="$T/socialio-list.$$"
find "$DIR" -maxdepth 1 -type f \( ${names} \) | sort > "$LIST"
total=$(wc -l < "$LIST" | tr -d ' ')
[ "$total" -gt 0 ] || { echo "✗ у папці нема фото чи відео (jpg png webp heic mp4 mov m4v webm)"; rm -f "$LIST"; exit 0; }
echo "Файлів: $total. Заливаю…"
n=0
while IFS= read -r f; do
  n=$((n+1)); name=$(basename "$f"); size=$(wc -c < "$f" | tr -d ' ')
  uid="s$(date +%s)x$$x$n"; off=0; tries=0
  while :; do
    res=$(tail -c +$((off+1)) "$f" | head -c $CH | curl -sS -X POST --data-binary @- -H 'Content-Type: application/octet-stream' -H "X-File-Name: $name" -w '\n%{http_code}' "$U/chunk?uid=$uid&size=$size&offset=$off" 2>&1)
    code=$(printf '%s\n' "$res" | tail -n 1); body=$(printf '%s\n' "$res" | sed '$d')
    case "$code" in
      200) case "$body" in
             "+ "*) off=$(printf '%s' "$body" | sed -n 's/^+ \([0-9]*\)\/.*/\1/p'); tries=0
                    [ -t 1 ] && printf '  %s: %s%%\r' "$name" $((off*100/size)) ;;
             *) printf '%s\n' "$body"; break ;;
           esac ;;
      409) off=$(printf '%s' "$body" | sed -n 's/^! \([0-9]*\).*/\1/p'); [ -n "$off" ] || off=0; tries=$((tries+1)) ;;
      000|429|5*) tries=$((tries+1)); sleep 3 ;;
      *) printf '%s\n' "$body"; break ;;
    esac
    [ "$tries" -ge 5 ] && { echo "✗ $name: не вдалось після 5 спроб ($code)"; break; }
  done
done < "$LIST"
rm -f "$LIST"
echo "Готово. Повертайся в чат - Claude уже бачить ці файли в медіатеці."
`;
}

// Готові команди «залий цю папку». Основна - скрипт: фото й відео будь-якого розміру. Запасна для
// PowerShell - лише фото до 20 МБ (одним запитом); відео з Windows - через Git Bash або сторінку.
export function uploadCommands(url: string): { unix: string; windows: string } {
  const u = url.replace(/["'\\\s]/g, "");
  const exts = ["jpg", "jpeg", "png", "webp", "heic", "heif"];
  return {
    unix: `curl -fsS "${u}/sh" -o socialio-upload.sh && sh socialio-upload.sh "/шлях/до/папки"`,
    windows: `Get-ChildItem "C:\\шлях\\до\\папки\\*" -Include ${exts.map((e) => "*." + e).join(",")} | ForEach-Object { curl.exe -sS -F "file=@$($_.FullName)" "${u}" }`,
  };
}

// Відповідь приймача. curl у терміналі Claude читає її як ТЕКСТ: рядок на файл коротший і
// зрозуміліший за JSON, а 200 файлів - це 200 рядків у контексті моделі. Сторінка в браузері
// просить JSON явним Accept.
export type UploadResult = { saved: { id: string; name: string; dup: boolean }[]; failed: { name: string; error: string }[]; left: number | null };
export function uploadResultText(r: UploadResult): string {
  const lines = [
    ...r.saved.map((x) => x.dup ? `= ${x.name || "файл"} уже в медіатеці → ${x.id}` : `✓ ${x.name || "файл"} → ${x.id}`),
    ...r.failed.map((x) => `✗ ${x.name ? x.name + ": " : ""}${x.error}`),
  ];
  if (!lines.length) lines.push("✗ файл не надійшов");
  if (r.left !== null) lines[lines.length - 1] += ` · лишилось місць: ${r.left}`;
  return lines.join("\n") + "\n";
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Сторінка для людини: те саме посилання, відкрите в браузері (на комп'ютері чи телефоні), дає
// перетягнути фото. Шле по одному файлу - сервер тоді відповідає на кожен окремо, і прогрес чесний.
export function uploadPageHtml(p: { state: "ok" | "expired" | "invalid"; cabinet?: string; until?: string; left?: number }): string {
  const head = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Фото й відео в socialio</title>
<style>:root{--bg:#f7f5f0;--ink:#1d1b16;--muted:#6d665a;--line:#e3ddd0;--brand:#e67e22;--ok:#2e7d32;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#141310;--ink:#f1ede4;--muted:#a59d8e;--line:#2c2922}}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif}.w{max-width:560px;margin:0 auto;padding:28px 16px}
h1{font-size:20px;margin:0 0 6px}.m{color:var(--muted);font-size:14px;margin:0 0 18px}
.dz{display:block;border:2px dashed var(--line);border-radius:14px;padding:34px 16px;text-align:center;cursor:pointer;font-size:15px}.dz.on{border-color:var(--brand)}
input{display:none}#st{margin-top:16px;font-size:15px}#ls{margin-top:8px;font-size:13px;color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}</style></head><body><div class="w">`;
  if (p.state !== "ok") {
    const msg = p.state === "expired" ? "Посилання протухло. Попроси в Claude нове - інструмент «media_upload_link»." : "Посилання недійсне.";
    return `${head}<h1>Фото в socialio</h1><p class="m">${msg}</p></div></body></html>`;
  }
  return `${head}<h1>Фото й відео в медіатеку socialio</h1>
<p class="m">Кабінет «${escHtml(p.cabinet || "")}». Посилання діє до ${escHtml(p.until || "")}, можна ще ${p.left ?? 0} файлів.</p>
<label class="dz" id="dz"><input type="file" id="f" accept="image/*,video/*" multiple>Перетягни фото чи відео сюди або натисни, щоб обрати</label>
<div id="st"></div><div id="ls"></div>
<script>
// кожен файл - шматками по 8 МБ (сервер пропускає до 20 МБ за запит, а відео з телефона - сотні МБ);
// обірвався шматок - повтор, сервер сам каже, з якого байта продовжити
const CH=8*1024*1024;
const dz=document.getElementById('dz'), f=document.getElementById('f'), st=document.getElementById('st'), ls=document.getElementById('ls');
['dragover','dragenter'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.add('on');}));
['dragleave','drop'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.remove('on');}));
dz.addEventListener('drop',ev=>send([...ev.dataTransfer.files]));
f.addEventListener('change',()=>send([...f.files]));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function up(file,onPct){
  const uid='w'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
  let off=0, tries=0;
  for(;;){
    let r=null, j={};
    try{ r=await fetch(location.pathname+'/chunk?uid='+uid+'&size='+file.size+'&offset='+off,{method:'POST',body:file.slice(off,Math.min(off+CH,file.size)),
           headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name),Accept:'application/json'}});
         j=await r.json().catch(()=>({})); }
    catch(e){ if(++tries>=5) throw new Error('немає звʼязку з сервером'); await sleep(3000); continue; }
    if(r.ok&&j.done) return j;
    if(r.ok&&typeof j.received==='number'){ off=j.received; tries=0; onPct(Math.floor(off*100/file.size)); continue; }
    if(r.status===409&&typeof j.received==='number'){ off=j.received; if(++tries>=5) throw new Error(j.error||'не вдалось'); continue; }
    if(r.status===429||r.status>=500){ if(++tries>=5) throw new Error(j.error||('HTTP '+r.status)); await sleep(3000); continue; }
    throw new Error(j.error||('HTTP '+r.status));
  }
}
async function send(files){
  files=files.filter(x=>/^(image|video)\\//.test(x.type)||/\\.(heic|heif|mov|mp4|m4v|webm)$/i.test(x.name)); if(!files.length){ st.textContent='Тут приймаються лише фото й відео.'; return; }
  let ok=0, dup=0; const bad=[];
  for(let i=0;i<files.length;i++){
    const lbl='Завантажую '+(i+1)+' з '+files.length+'…'; st.textContent=lbl;
    try{ const j=await up(files[i],(p)=>{ st.textContent=lbl+' '+p+'%'; }); if(j.saved&&j.saved.dup) dup++; else ok++; }
    catch(e){ bad.push(files[i].name+': '+e.message); }
  }
  st.innerHTML='<span class="ok">Готово: '+ok+' нових файлів у медіатеці'+(dup?' (ще '+dup+' там уже були)':'')+'.</span> Повертайся в чат із Claude - він їх уже бачить.';
  ls.innerHTML=bad.length?'<span class="bad">Не вдалось ('+bad.length+'):</span><br>'+bad.slice(0,20).map(x=>x.replace(/</g,'&lt;')).join('<br>'):'';
  f.value='';
}
</script></div></body></html>`;
}
