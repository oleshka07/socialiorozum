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

// Місце під файл забирається АТОМАРНО: паралельні запити скрипта інакше разом проскочили б ліміт
export async function takeUploadSlot(token: string): Promise<boolean> {
  return !!(await one(`update upload_link set files_left = files_left - 1
                        where token=$1 and files_left > 0 and expires_at > now() returning 1`, [token]));
}
export const markUploaded = (token: string) => q(`update upload_link set uploaded = uploaded + 1 where token=$1`, [token]);
// битий файл місця не зʼїдає
export const refundUploadSlot = (token: string) => q(`update upload_link set files_left = files_left + 1 where token=$1`, [token]);
export const sweepUploadLinks = () => q(`delete from upload_link where expires_at < now() - interval '1 day'`);

export const uploadUrl = (token: string): string => `${env.appBaseUrl}/mcp/upload/${token}`;

// Файл на посилання - 20 МБ: стільки пропускає nginx (client_max_body_size), більше однаково не дійде
export const UPLOAD_FILE_MAX = 20 * 1024 * 1024;
export const UPLOAD_TEXT = {
  invalid: "Посилання недійсне.",
  expired: "Посилання протухло - попроси в Claude нове (інструмент media_upload_link).",
  noSlots: "ліміт файлів на це посилання вичерпано - попроси в Claude нове",
  video: "це відео - сюди лише фото",
  notImage: "це не фото - приймаємо JPG, PNG, WebP, HEIC",
  tooBig: "файл більший за 20 МБ - зменш його або завантаж у кабінеті",
  notMultipart: 'надішли файл як multipart/form-data: curl -F "file=@фото.jpg" <адреса>',
};

// Готові команди «залий цю папку». Лише фото: медіатека конектора показує зображення, тож відео
// з тієї ж папки було б сміттям у виборі.
// Unix-варіант через find, а не через глоб *.{jpg,png}: у zsh (типовий шелл macOS) глоб, що нічого
// не знайшов, валить УСЮ команду («no matches found»), тож папка без жодного .webp не залилась би.
// Шлях у -F узято в лапки: так curl не спотикається на комі чи крапці з комою в імені файлу.
export function uploadCommands(url: string): { unix: string; windows: string } {
  const u = url.replace(/["'\\\s]/g, "");
  const exts = ["jpg", "jpeg", "png", "webp", "heic", "heif"];
  const names = exts.map((e) => `-iname '*.${e}'`).join(" -o ");
  return {
    unix: `find "/шлях/до/папки" -maxdepth 1 -type f \\( ${names} \\) -exec curl -sS -F 'file=@"{}"' "${u}" \\;`,
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
  const head = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Фото в socialio</title>
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
  return `${head}<h1>Фото в медіатеку socialio</h1>
<p class="m">Кабінет «${escHtml(p.cabinet || "")}». Посилання діє до ${escHtml(p.until || "")}, можна ще ${p.left ?? 0} фото.</p>
<label class="dz" id="dz"><input type="file" id="f" accept="image/*" multiple>Перетягни фото сюди або натисни, щоб обрати</label>
<div id="st"></div><div id="ls"></div>
<script>
const MAX=${UPLOAD_FILE_MAX}, BIG=${JSON.stringify(UPLOAD_TEXT.tooBig)};
const dz=document.getElementById('dz'), f=document.getElementById('f'), st=document.getElementById('st'), ls=document.getElementById('ls');
['dragover','dragenter'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.add('on');}));
['dragleave','drop'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.remove('on');}));
dz.addEventListener('drop',ev=>send([...ev.dataTransfer.files]));
f.addEventListener('change',()=>send([...f.files]));
async function send(files){
  files=files.filter(x=>/^image\\//.test(x.type)||/\\.(heic|heif)$/i.test(x.name)); if(!files.length){ st.textContent='Тут приймаються лише фото.'; return; }
  let ok=0, dup=0; const bad=[];
  for(let i=0;i<files.length;i++){
    st.textContent='Завантажую '+(i+1)+' з '+files.length+'…';
    if(files[i].size>MAX){ bad.push(files[i].name+': '+BIG); continue; }
    const fd=new FormData(); fd.append('file',files[i]);
    try{ const r=await fetch(location.pathname,{method:'POST',body:fd,headers:{Accept:'application/json'}}); const j=await r.json().catch(()=>({}));
      const sv=(j.saved||[]); ok+=sv.filter(x=>!x.dup).length; dup+=sv.filter(x=>x.dup).length;
      if(!sv.length) bad.push(files[i].name+': '+((j.failed&&j.failed[0]&&j.failed[0].error)||j.error||(r.status===413?BIG:'HTTP '+r.status)));
    }catch(e){ bad.push(files[i].name+': '+e.message); }
  }
  st.innerHTML='<span class="ok">Готово: '+ok+' нових фото в медіатеці'+(dup?' (ще '+dup+' там уже були)':'')+'.</span> Повертайся в чат із Claude - він їх уже бачить.';
  ls.innerHTML=bad.length?'<span class="bad">Не вдалось ('+bad.length+'):</span><br>'+bad.slice(0,20).map(x=>x.replace(/</g,'&lt;')).join('<br>'):'';
  f.value='';
}
</script></div></body></html>`;
}
