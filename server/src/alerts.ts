// 🔔 СПОВІЩЕННЯ АДМІНУ ПРО ЗБОЇ (запит Олега 30.09: «тейки о 8:00 не вийшли, бо на OpenRouter
// закінчились кошти - такі проблеми мають приходити мені в Telegram або на пошту, щоб, коли будуть
// користувачі, я бачив і вчасно виправляв»).
//
// Два джерела:
//  1) журнал (logEvent) - кожен warn/error проходить через правила alerts-plan.ts. Серйозне (кошти,
//     ключі, пошта, база) - одразу; те, що буває випадково (429, 500), - лише коли повторюється;
//     проблеми людей (їхні канали, токени, OAuth) і шум (RSS) - у денний звіт.
//  2) проби раз на 10 хв - те, що в журналі не видно, поки не пізно: баланс OpenRouter (попередити
//     ДО нуля), бекап бази, місце на диску, живий спільний бот, завислі задачі; раз на 2 хв - чи
//     відповідає сусідній інстанс (прод стежить за бетою, бета - за продом: якщо прод упав, скаже бета).
//
// Кожна проблема - один рядок ops_alert з відбитком (fp): 1440 однакових помилок за добу - одне
// сповіщення з лічильником, нагадування - не частіше ніж раз на 6 год (критичне) чи добу. Канали:
// Telegram - приватно адміну спільним ботом (кнопки «✓ Вирішено», «🔕 Тиша 8 год»), пошта - на
// критичне і коли Telegram недоступний (сам бот мертвий - саме тоді пошта і потрібна).
import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { q, one } from "./db.js";
import { env } from "./env.js";
import { setLogHook } from "./log.js";
import { BRAND } from "./brand.js";
import { MEDIA_DIR } from "./media.js";
import { sendOpsEmail } from "./email.js";
import { cabinetPostLink } from "./permalink.js";
import * as tg from "./telegram.js";
import * as P from "./alerts-plan.js";
import { routeFor } from "./openrouter.js";

export type AlertSettings = {
  tg: boolean; email: boolean; emailAll: boolean; emails: string[];
  digest: boolean; digestHour: number; tz: string;
  failover: boolean; orLow: number; muteUntil: string | null; watchUrl: string;
};
const DEFAULTS = (): AlertSettings => ({
  tg: true, email: true, emailAll: false, emails: [],
  digest: true, digestHour: 9, tz: "Europe/Prague",
  failover: env.llm.failover, orLow: 2, muteUntil: null, watchUrl: "",
});
let S: AlertSettings = DEFAULTS();
let started = false;

export const instanceLabel = (): string => `${BRAND} · ${env.beta.pin ? "бета" : "прод"}`;
const isBeta = (): boolean => !!env.beta.pin;
const stackName = (): string => process.env.COMPOSE_PROJECT_NAME || (isBeta() ? "socialio-beta" : "socialio");
export const alertSettings = (): AlertSettings => ({ ...S });
/** Кому листи: з адмінки, інакше ALERT_EMAILS, інакше перший адмін (Олег просив саме свою пошту). */
export const alertEmails = (): string[] => (S.emails.length ? S.emails : env.alerts.emails.length ? env.alerts.emails : env.adminEmails.slice(0, 1));

export async function loadAlertSettings(): Promise<void> {
  const r = await one<{ value: any }>(`select value from app_setting where name='ops_alerts'`).catch(() => null);
  S = { ...DEFAULTS(), ...(r?.value && typeof r.value === "object" ? r.value : {}) };
  env.llm.failover = !!S.failover;
}

/** Зберегти з адмінки: лише відомі поля, з межами. */
export async function saveAlertSettings(patch: any, by: string): Promise<AlertSettings> {
  const n: AlertSettings = { ...S };
  const bool = (k: keyof AlertSettings) => { if (patch?.[k] !== undefined) (n as any)[k] = patch[k] === true || patch[k] === "true"; };
  (["tg", "email", "emailAll", "digest", "failover"] as const).forEach(bool);
  if (patch?.digestHour !== undefined) { const h = Math.round(Number(patch.digestHour)); if (h >= 0 && h <= 23) n.digestHour = h; }
  if (patch?.orLow !== undefined) { const v = Number(patch.orLow); if (Number.isFinite(v) && v >= 0 && v <= 1000) n.orLow = Math.round(v * 100) / 100; }
  if (patch?.tz !== undefined) { const tz = String(patch.tz || "").trim(); try { new Intl.DateTimeFormat("uk", { timeZone: tz }); n.tz = tz; } catch { throw new Error("невідомий часовий пояс"); } }
  if (patch?.emails !== undefined) {
    const list = (Array.isArray(patch.emails) ? patch.emails : String(patch.emails || "").split(/[,\s;]+/)).map((x: any) => String(x).trim().toLowerCase()).filter(Boolean);
    const bad = list.find((x: string) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (bad) throw new Error(`«${bad}» не схоже на адресу пошти`);
    n.emails = [...new Set(list)].slice(0, 5) as string[];
  }
  if (patch?.watchUrl !== undefined) {
    const u = String(patch.watchUrl || "").trim();
    if (u && !/^off$/i.test(u) && !/^https?:\/\/[^\s/]+\.[^\s/]+/.test(u)) throw new Error("адреса для перевірки - https://…/health або off");
    n.watchUrl = u;
  }
  if (patch?.muteHours !== undefined) {
    const h = Number(patch.muteHours);
    n.muteUntil = h > 0 ? new Date(Date.now() + Math.min(h, 72) * 3600_000).toISOString() : null;
  }
  await q(`insert into app_setting(name, value, updated_by) values('ops_alerts',$1,$2)
           on conflict (name) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`, [JSON.stringify(n), by]);
  S = n;
  env.llm.failover = !!S.failover;
  if (!S.muteUntil) scheduleFlush(500);   // тишу зняли - відкладене надсилаємо одразу
  return { ...S };
}

// ---------------- запис проблем ----------------
export type AlertRow = {
  id: string; fp: string; kind: string; severity: P.Severity; title: string; detail: string | null; hint: string | null;
  scope: string | null; source: string; count: number; first_at: string; last_at: string;
  notified_at: string | null; resolved_at: string | null; muted_until: string | null;
};

const failoverVia = (): string => {
  const m = env.llm.failoverModel;
  if (!env.llm.failover) return "";
  if (env.openai.apiKey) return m.startsWith("openai/") ? `OpenAI (${m.slice(7)})` : "OpenAI";
  return env.openrouter.apiKey ? "OpenRouter" : "";
};
const hintCtx = () => ({ failover: env.llm.failover, failoverVia: failoverVia(), hasOpenAI: !!env.openai.apiKey });

async function upsertAlert(v: { fp: string; kind: string; severity: P.Severity; title: string; detail?: string; hint?: string; scope?: string; source: "log" | "probe" }, add = 1): Promise<AlertRow | null> {
  return one<AlertRow>(
    `insert into ops_alert(fp, kind, severity, title, detail, hint, scope, source, count, first_at, last_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
     on conflict (fp) do update set
       kind=excluded.kind, severity=excluded.severity, title=excluded.title, detail=excluded.detail,
       hint=excluded.hint, scope=excluded.scope, source=excluded.source,
       count = case when ops_alert.resolved_at is not null then excluded.count else ops_alert.count + excluded.count end,
       first_at = case when ops_alert.resolved_at is not null then now() else ops_alert.first_at end,
       notified_at = case when ops_alert.resolved_at is not null then null else ops_alert.notified_at end,
       resolved_at = null, last_at = now()
     returning *`,
    [v.fp.slice(0, 200), v.kind, v.severity, v.title.slice(0, 200), (v.detail || "").slice(0, 900), (v.hint || "").slice(0, 600), v.scope || null, v.source, add]);
}

// «повторилось N разів за 30 хв» - у памʼяті процесу: після рестарту рахуємо заново, це безпечно
const bursts = new Map<string, number[]>();
function burstCount(fp: string): number {
  const now = Date.now();
  const arr = (bursts.get(fp) || []).filter((t) => now - t < 30 * 60_000);
  arr.push(now);
  bursts.set(fp, arr);
  if (bursts.size > 2000) bursts.clear();
  return arr.length;
}

/** Хук журналу: кожен warn/error. Ніколи не кидає і не чекає - журнал не повинен гальмувати. */
export function onLogEvent(level: string, scope: string, message: string): void {
  if (!started) return;
  let v: P.Verdict;
  try { v = P.classify(level, scope, message); } catch { return; }
  if (v.notify === "none" || v.notify === "digest") return;
  let add = 1;
  if (v.notify === "burst") {
    const n = burstCount(v.fp), need = v.burst || 3;
    if (n < need) return;
    add = n === need ? need : 1;
  }
  const detail = P.maskSecrets(`${scope}: ${message}`);
  upsertAlert({ fp: v.fp, kind: v.kind, severity: v.severity, title: v.title, detail, hint: P.hintFor(v, hintCtx()), scope, source: "log" }, add)
    .then(() => scheduleFlush())
    .catch(() => { /* сповіщення не повинні валити нічого */ });
}

/** Проба знайшла проблему (баланс, бекап, диск, бот, сусід). */
async function probeRaise(fp: string, kind: string, severity: P.Severity, title: string, detail: string, provider?: string): Promise<void> {
  const prev = await one<{ resolved_at: string | null; severity: string }>(`select resolved_at, severity from ops_alert where fp=$1`, [fp]);
  // проба повторюється кожні 10 хв - лічильник росте лише коли проблема нова або повернулась
  await upsertAlert({ fp, kind, severity, title, detail: P.maskSecrets(detail), hint: P.hintFor({ kind, provider }, hintCtx()), scope: "probe", source: "probe" }, prev && !prev.resolved_at ? 0 : 1);
  scheduleFlush();
}
/** Проба бачить, що минуло: закрити і, якщо про проблему вже писали, - сказати, що полагодилось. */
async function probeResolve(fp: string, note: string): Promise<void> {
  const a = await one<AlertRow>(`update ops_alert set resolved_at=now() where fp=$1 and resolved_at is null returning *`, [fp]);
  if (a?.notified_at) await deliver({ ...a, detail: note }, "resolved").catch(() => {});
}

// ---------------- доставка ----------------
const fmtTime = (d: string | Date | number, withDate = true): string => {
  try {
    return new Intl.DateTimeFormat("uk-UA", { timeZone: S.tz, ...(withDate ? { day: "2-digit", month: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d));
  } catch { return new Date(d).toISOString().slice(5, 16).replace("T", " "); }
};
const dur = (ms: number): string => { const m = Math.max(1, Math.round(ms / 60000)); return m < 90 ? `${m} хв` : m < 48 * 60 ? `${Math.round(m / 60)} год` : `${Math.round(m / 1440)} дн`; };
const shortFp = (fp: string) => createHash("sha1").update(fp).digest("hex").slice(0, 12);
const icon = (a: Pick<AlertRow, "severity">) => (a.severity === "critical" ? "🔴" : "🟠");

type Mode = "new" | "repeat" | "resolved" | "test";
export function alertText(a: Pick<AlertRow, "title" | "detail" | "hint" | "severity" | "count" | "first_at" | "last_at">, mode: Mode): string {
  const head = mode === "resolved" ? `✅ ${instanceLabel()}: вирішено - ${a.title}`
    : mode === "test" ? `🔔 ${instanceLabel()}: тестове сповіщення`
      : `${mode === "repeat" ? "⏰ Досі триває · " : ""}${icon(a)} ${instanceLabel()}: ${a.title}`;
  const lines = [head];
  const det = String(a.detail || "").trim();
  if (det) lines.push("", det.length > 420 ? det.slice(0, 419) + "…" : det);
  if (mode !== "resolved" && a.hint) lines.push("", `Що зробити: ${a.hint}`);
  if (mode === "new" || mode === "repeat") lines.push("", `×${a.count} · вперше ${fmtTime(a.first_at)} · востаннє ${fmtTime(a.last_at)}`);
  if (mode === "resolved") lines.push("", `Тривало ~${dur(Date.now() - new Date(a.first_at).getTime())}.`);
  return lines.join("\n");
}

/** Telegram адміна: хто з адмінів привʼязав свій Telegram до свого кабінету. */
export async function adminChats(): Promise<Array<{ workspace_id: string; chat_id: string }>> {
  return q(`select distinct on (o.tg_user_id) o.workspace_id, o.chat_id
              from tg_owner o
              join app_user u on lower(u.email) = any($1) and u.deleted_at is null
              left join workspace_member m on m.workspace_id = o.workspace_id and m.user_id = u.id
             where o.chat_id is not null
               and (o.user_id = u.id or (o.user_id is null and m.role = 'owner'))
             order by o.tg_user_id, o.created_at desc`, [env.adminEmails]).catch(() => []);
}

async function sendTg(a: Pick<AlertRow, "fp" | "id">, text: string, mode: Mode): Promise<{ n: number; err: string }> {
  if (!S.tg) return { n: 0, err: "вимкнено" };
  const chats = await adminChats();
  if (!chats.length) return { n: 0, err: "Telegram адміна не привʼязано" };
  const { liveSend } = await import("./tgbot.js");
  const buttons: tg.TgButton[][] = [[{ text: "🩺 Відкрити кабінет", url: `${env.appBaseUrl}/app#/settings/profile` }]];
  if (mode === "new" || mode === "repeat") buttons.push([{ text: "✓ Вирішено", data: `al:ok:${a.id}` }, { text: "🔕 Тиша 8 год", data: "al:mute:8" }]);
  let n = 0, err = "";
  for (const c of chats) {
    try { await liveSend(c.workspace_id, c.chat_id, "ops:" + shortFp(a.fp), text, buttons); n++; }
    catch (e: any) { err = String(e?.message || e).slice(0, 160); }
  }
  return { n, err };
}

const escHtml = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function emailHtml(text: string): string {
  const [head, ...rest] = text.split("\n");
  return `<h3 style="margin:10px 0">${escHtml(head)}</h3>` + rest.map((l) => l ? `<p style="margin:6px 0">${escHtml(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>` : "").join("")
    + `<p style="margin-top:18px"><a href="${env.appBaseUrl}/app#/settings/profile" style="display:inline-block;background:#5b8cff;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">Відкрити кабінет</a></p>`;
}

// не більше 12 повідомлень на годину: решта дочекається (лишаються «не сповіщеними» і підуть пізніше
// чи в денний звіт), а не завалить Telegram у ніч, коли падає все одразу
const sentTimes: number[] = [];
function rateOk(): boolean {
  const now = Date.now();
  while (sentTimes.length && now - sentTimes[0] > 3600_000) sentTimes.shift();
  return sentTimes.length < 12;
}

async function deliver(a: AlertRow, mode: Mode): Promise<{ tg: number; email: boolean; err: string }> {
  const text = alertText(a, mode);
  sentTimes.push(Date.now());
  const t = await sendTg(a, text, mode);
  // пошта: критичне (нове й «вирішено»), усе - якщо так налаштовано, і будь-що, коли в Telegram не дійшло
  const wantMail = S.email && (mode === "test" || t.n === 0 || (a.severity === "critical" && mode !== "repeat") || (S.emailAll && mode !== "repeat"));
  let mail = false, err = t.n ? "" : t.err;
  if (wantMail) {
    const to = alertEmails();
    try {
      const subj = mode === "resolved" ? `✅ ${instanceLabel()}: вирішено - ${a.title}` : mode === "test" ? `🔔 ${instanceLabel()}: тестове сповіщення` : `${icon(a)} ${instanceLabel()}: ${a.title}`;
      for (const addr of to) await sendOpsEmail(addr, subj, emailHtml(text));
      mail = to.length > 0;
    } catch (e: any) { err = (err ? err + "; " : "") + "пошта: " + String(e?.message || e).slice(0, 160); }
  }
  if (!t.n && !mail) console.warn(`[alerts] не доставлено «${a.title}»: ${err || "немає каналу"}`);
  return { tg: t.n, email: mail, err };
}

let flushTimer: NodeJS.Timeout | null = null;
function scheduleFlush(ms = 3000): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch((e) => console.warn("[alerts] flush:", e?.message)); }, ms);
}
let flushing = false;
export async function flush(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let n = 0;
  try {
    if (S.muteUntil && new Date(S.muteUntil).getTime() > Date.now()) return 0;
    const rows = await q<AlertRow>(`select * from ops_alert where resolved_at is null order by (severity='critical') desc, last_at desc limit 50`);
    for (const a of rows) {
      if (!P.dueToNotify(a)) continue;
      if (!rateOk()) break;
      const mode: Mode = a.notified_at ? "repeat" : "new";
      const r = await deliver(a, mode);
      // не дійшло нікуди - не позначаємо сповіщеним: спробуємо на наступному проході
      if (r.tg || r.email) { await q(`update ops_alert set notified_at=now(), notified_count=count where id=$1`, [a.id]); n++; }
    }
  } finally { flushing = false; }
  return n;
}

/** Тест із адмінки: чи доходить у Telegram і на пошту. */
export async function sendTestAlert(): Promise<{ tg: number; email: boolean; err: string; to: string[] }> {
  const now = new Date().toISOString();
  const fake: AlertRow = { id: "0", fp: "test", kind: "test", severity: "warning", title: "тест", count: 1, first_at: now, last_at: now, notified_at: null, resolved_at: null, muted_until: null, scope: null, source: "probe",
    detail: "Якщо ти це читаєш - сповіщення про збої доходять. Сюди прийде, коли в провайдера закінчаться кошти, не прийметься ключ, не створиться бекап, упаде сусідній сервер тощо.", hint: null };
  const r = await deliver(fake, "test");
  return { ...r, to: S.email ? alertEmails() : [] };
}

/** «✓ Вирішено» з кабінету чи з кнопки в Telegram. Журнальна проблема закривається (повториться - відкриється
 *  знову, але не раніше ніж за 15 хв: ще «в дорозі» виклики не мають будити адміна, який щойно полагодив).
 *  Проблему проби (баланс, бекап, сусід) закриває сама проба, коли минуло; кнопка тоді означає «знаю» -
 *  тиша для цієї проблеми на добу, інакше за 10 хв проба підняла б її знову. */
export async function resolveAlert(id: string): Promise<"" | "log" | "probe"> {
  if (!/^\d{1,18}$/.test(String(id))) return "";
  const a = await one<{ source: string }>(
    `update ops_alert set
       resolved_at = case when source='probe' then null else now() end,
       muted_until = now() + (case when source='probe' then interval '24 hours' else interval '15 minutes' end)
     where id=$1 and resolved_at is null returning source`, [id]);
  return a ? (a.source === "probe" ? "probe" : "log") : "";
}
export async function muteAlerts(hours: number, by: string): Promise<string | null> {
  const s = await saveAlertSettings({ muteHours: hours }, by);
  return s.muteUntil;
}
/** Кнопки з Telegram: лише адмін (його Telegram привʼязаний до його кабінету). */
export async function isAdminTg(fromId: number): Promise<boolean> {
  const r = await one<{ n: number }>(
    `select count(*)::int n from tg_owner o join app_user u on lower(u.email) = any($2)
       left join workspace_member m on m.workspace_id=o.workspace_id and m.user_id=u.id
      where o.tg_user_id=$1 and (o.user_id=u.id or (o.user_id is null and m.role='owner'))`, [fromId, env.adminEmails]).catch(() => null);
  return !!r?.n;
}
export async function alertCallback(data: string, fromId: number): Promise<string> {
  if (!(await isAdminTg(fromId))) return "Лише для адміністратора";
  const [, what, arg] = data.split(":");
  if (what === "ok") { const r = await resolveAlert(arg); return r === "probe" ? "✓ Прийнято - нагадаю через добу, якщо не мине" : r ? "✓ Позначено вирішеним" : "Уже вирішено"; }
  if (what === "mute") { const until = await muteAlerts(Number(arg) || 8, "telegram"); return until ? `🔕 Тиша до ${fmtTime(until, false)}` : "Тишу знято"; }
  return "";
}

// ---------------- проби ----------------
async function probeOpenRouter(): Promise<void> {
  if (!env.openrouter.apiKey) return;
  // хто ходить через OpenRouter: головні моделі кабінетів і дешева модель, яким маршрут - OpenRouter.
  // Нікому - баланс не стережемо взагалі (рішення Олега 30.09: не поповнювати, моделі - OpenAI напряму):
  // інакше «закінчились кошти» нагадувало б щодня про рахунок, яким ніхто не користується.
  const mm = await q<{ content: string }>(`select distinct content from settings_block where key='main_model'`).catch(() => []);
  const routed = [...new Set([...mm.map((m) => String(m.content || "").trim()).filter(Boolean), env.cheapModel])].filter((m) => routeFor(m) === "openrouter");
  if (!routed.length) {
    const why = "Жодна модель кабінетів не йде через OpenRouter - баланс не стежимо.";
    for (const fp of ["ai_funds:OpenRouter", "balance:OpenRouter", "ai_key:OpenRouter"]) await probeResolve(fp, why);
    return;
  }
  let rem: number | null = null;
  try {
    const r = await fetch(`${env.openrouter.baseUrl}/credits`, { headers: { Authorization: `Bearer ${env.openrouter.apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (r.status === 401) { await probeRaise("ai_key:OpenRouter", "ai_key", "warning", "OpenRouter: ключ не приймається", "OpenRouter відповів 401 на перевірку балансу.", "OpenRouter"); return; }
    if (!r.ok) return;
    const j: any = await r.json();
    const d = j?.data || j;
    if (typeof d?.total_credits === "number" && typeof d?.total_usage === "number") rem = d.total_credits - d.total_usage;
  } catch { return; }
  if (rem === null) return;
  const who = ` Через OpenRouter ідуть: ${routed.slice(0, 5).join(", ")}.`;
  // запасний маршрут підхоплює виклики - сервіс працює, тож це попередження, а не пожежа
  const via = failoverVia();
  const covered = via ? ` Генерація не стоїть: виклики йдуть через ${via}.` : "";
  if (rem < 0.05) await probeRaise("ai_funds:OpenRouter", "ai_funds", !via ? "critical" : "warning", "OpenRouter: закінчились кошти", `На рахунку OpenRouter $${Math.max(0, rem).toFixed(2)}.${who}${covered}`, "OpenRouter");
  else if (rem < S.orLow) await probeRaise("balance:OpenRouter", "balance", "warning", `OpenRouter: лишилось $${rem.toFixed(2)}`, `Баланс нижче порогу $${S.orLow}.${who}`, "OpenRouter");
  else {
    await probeResolve("balance:OpenRouter", `Баланс OpenRouter $${rem.toFixed(2)}.`);
    await probeResolve("ai_funds:OpenRouter", `Баланс OpenRouter знову $${rem.toFixed(2)}.`);
  }
}

async function probeElevenLabs(): Promise<void> {
  if (!env.elevenlabs.apiKey) return;
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": env.elevenlabs.apiKey }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;   // ключ лише з правом Text to Speech (як у Олега) - залишок не видно, і це нормально
    const j: any = await r.json();
    const used = Number(j?.character_count), lim = Number(j?.character_limit);
    if (!(lim > 0)) return;
    const left = lim - used;
    if (left < Math.max(2000, lim * 0.1)) await probeRaise("balance:ElevenLabs", "balance", "warning", `ElevenLabs: лишилось ${left} символів`, `Використано ${used} з ${lim} символів тарифу.`, "ElevenLabs");
    else await probeResolve("balance:ElevenLabs", `ElevenLabs: вільно ${left} символів.`);
  } catch { /* мережа - наступного разу */ }
}

async function probeSharedBot(): Promise<void> {
  const token = env.telegram.botToken;
  if (!token) return;
  try {
    const me = await tg.getMe(token);
    await probeResolve("tg_shared", `Спільний бот @${me.username || "?"} знову відповідає.`);
  } catch (e: any) {
    if (e?.tgStatus === 401 || e?.tgStatus === 404)
      await probeRaise("tg_shared", "tg_shared", "critical", "Спільний Telegram-бот не працює", "Telegram не визнає токен спільного бота (відкликано в @BotFather?). Люди не отримують зведень, щоденника й відповідей бота, публікація в канали через нього стоїть.");
    return;
  }
  // вебхук: лише якщо він має вести сюди (бета з TELEGRAM_WEBHOOK_OFF могла свідомо не брати бота)
  try {
    const wi: any = await tg.getWebhookInfo(token);
    const url = String(wi?.url || "");
    let ours = false;
    try { ours = !!url && new URL(url).host === new URL(env.appBaseUrl).host; } catch { /* */ }
    if (!ours) return;
    const fresh = wi.last_error_date && Date.now() / 1000 - wi.last_error_date < 20 * 60;
    if (fresh && (wi.pending_update_count || 0) >= 10)
      await probeRaise("tg_hook", "tg_hook", "warning", "Telegram не може достукатись до бота", `У черзі ${wi.pending_update_count} повідомлень, остання помилка: ${String(wi.last_error_message || "").slice(0, 160)}`);
    else if ((wi.pending_update_count || 0) < 3) await probeResolve("tg_hook", "Telegram знову доставляє повідомлення боту.");
  } catch { /* */ }
}

async function probeBackups(): Promise<void> {
  const dir = process.env.BACKUP_DIR || "/backups";
  let files: string[];
  try { files = await readdir(dir); } catch { return; }   // тека не змонтована (локально) - нема що перевіряти
  const pre = `${stackName()}-db-`;
  const mine = files.filter((f) => f.startsWith(pre) && f.endsWith(".dump")).sort();
  if (!mine.length) { if (files.length) await probeRaise("backup", "backup", "critical", "Бекап бази: жодного файлу", `У ${dir} нема файлів ${pre}*.dump.`); return; }
  const last = mine[mine.length - 1];
  const st = await stat(join(dir, last)).catch(() => null);
  if (!st) return;
  const ageH = (Date.now() - st.mtimeMs) / 3600_000;
  if (ageH > 30 || st.size < 1024) await probeRaise("backup", "backup", "critical", `Бекап бази не створювався ${Math.round(ageH)} год`, `Останній: ${last} (${Math.round(st.size / 1024)} КБ).`);
  else await probeResolve("backup", `Бекап є: ${last}.`);
}

async function probeDisk(): Promise<void> {
  if (isBeta()) return;   // диск спільний - перевіряє прод, інакше два однакові сповіщення
  try {
    const s = await statfs(MEDIA_DIR);
    const free = Number(s.bavail) * Number(s.bsize), total = Number(s.blocks) * Number(s.bsize);
    if (!(total > 0)) return;
    const pct = (free / total) * 100, gb = free / 1024 ** 3;
    if (gb < 3 || pct < 8) await probeRaise("disk", "disk", "critical", `Диск сервера майже повний: вільно ${gb.toFixed(1)} ГБ`, `Вільно ${pct.toFixed(0)}% із ${(total / 1024 ** 3).toFixed(0)} ГБ.`);
    else if (pct < 15) await probeRaise("disk", "disk", "warning", `Диск сервера: вільно ${gb.toFixed(1)} ГБ`, `Вільно ${pct.toFixed(0)}% із ${(total / 1024 ** 3).toFixed(0)} ГБ.`);
    else await probeResolve("disk", `Вільно ${gb.toFixed(1)} ГБ.`);
  } catch { /* statfs нема - пропускаємо */ }
}

async function probeJobs(): Promise<void> {
  const r = await one<{ n: number; kinds: string | null }>(
    `select count(*)::int n, string_agg(distinct kind, ', ') kinds from job where status='running' and updated_at < now() - interval '30 minutes'`).catch(() => null);
  if (r?.n) await probeRaise("jobs", "jobs", "warning", `Фонові задачі висять понад 30 хв: ${r.n}`, `Які: ${r.kinds}.`);
  else await probeResolve("jobs", "Завислих задач нема.");
}

// сусідній інстанс: 3 невдачі поспіль (~6 хв) - тривога; деплой (10-30 с) не встигає її підняти
let buddyFails = 0, buddyDownSince = 0;
export async function probeBuddy(): Promise<void> {
  const url = P.buddyUrl(env.appBaseUrl, S.watchUrl || env.alerts.watchUrl);
  if (!url) return;
  const name = new URL(url).host;
  const prod = !name.startsWith("beta.");
  let ok = false, why = "";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "manual" });
    ok = r.status === 200;
    why = ok ? "" : `HTTP ${r.status}`;
  } catch (e: any) { why = e?.name === "TimeoutError" ? "не відповів за 10 с" : String(e?.cause?.code || e?.message || e).slice(0, 80); }
  if (ok) {
    if (buddyFails >= 3) await probeResolve("buddy", `${name} знову відповідає.`);
    buddyFails = 0; buddyDownSince = 0;
    return;
  }
  buddyFails++;
  if (!buddyDownSince) buddyDownSince = Date.now();
  if (buddyFails === 3 || (buddyFails > 3 && buddyFails % 30 === 0))
    await probeRaise("buddy", "buddy", prod ? "critical" : "warning", `${prod ? "Прод" : "Бета"} (${name}) не відповідає`,
      `Перевірка ${url} не проходить уже ~${dur(Date.now() - buddyDownSince)}: ${why}. Сповіщає ${env.beta.pin ? "бета" : "прод"}, бо сам ${prod ? "прод" : "бета"} сказати про це не може.`);
}

// журнальні проблеми, що давно не повторювались, закриваються самі (без повідомлення): інакше
// одного разу впала - і висить у «відкритих» назавжди
async function autoResolve(): Promise<void> {
  await q(`update ops_alert set resolved_at=now() where resolved_at is null and source='log' and last_at < now() - interval '48 hours'`).catch(() => {});
}

// ---------------- денний звіт ----------------
const localParts = (d: Date) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: S.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)?.value || "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24 };
};

export async function buildDigest(): Promise<string | null> {
  const rows = await q<{ level: string; scope: string; m: string; n: number; last: string }>(
    `select level, scope, left(message, 300) m, count(*)::int n, max(created_at) last from app_log
      where created_at > now() - interval '24 hours' and level in ('error','warn')
      group by 1,2,3 order by n desc limit 400`);
  const map = new Map<string, P.DigestGroup>();
  for (const r of rows) {
    const v = P.classify(r.level, r.scope, r.m);
    if (v.notify === "none") continue;
    const g = map.get(v.fp);
    if (g) { g.n += r.n; if (new Date(r.last) > new Date(g.last)) g.last = r.last; }
    else map.set(v.fp, { title: v.title, n: r.n, last: r.last, severity: v.severity, group: v.group });
  }
  const groups = [...map.values()].map((g) => ({ ...g, last: fmtTime(g.last, false) }));
  const open = (await q<AlertRow>(`select * from ops_alert where resolved_at is null order by (severity='critical') desc, last_at desc limit 10`))
    .map((a) => ({ title: a.title, severity: a.severity, count: a.count, since: fmtTime(a.first_at) }));
  const st = await one<{ published: number; failed: number; users: number; spend: number }>(`select
      (select count(*) from telegram_publish where status='sent' and created_at > now() - interval '24 hours')::int
      + (select count(*) from threads_publish where status='sent' and created_at > now() - interval '24 hours')::int
      + (select count(*) from meta_publish where status='sent' and created_at > now() - interval '24 hours')::int
      + (select count(*) from linkedin_publish where status='sent' and created_at > now() - interval '24 hours')::int as published,
      (select count(*) from schedule_slot where status='failed' and updated_at > now() - interval '24 hours')::int as failed,
      (select count(*) from app_user where created_at > now() - interval '24 hours')::int as users,
      coalesce((select sum(cost) from llm_usage where created_at > now() - interval '24 hours'), 0)::float as spend`).catch(() => null);
  return P.digestText({ instance: instanceLabel(), date: localParts(new Date()).date.slice(5).split("-").reverse().join("."), open, groups,
    stats: { published: st?.published || 0, failed: st?.failed || 0, users: st?.users || 0, spend: st?.spend || 0 } });
}

export async function sendDigest(force = false): Promise<{ sent: boolean; text: string | null }> {
  const text = await buildDigest();
  if (!text) return { sent: false, text: null };
  if (!force && S.muteUntil && new Date(S.muteUntil).getTime() > Date.now()) return { sent: false, text };
  let ok = false;
  if (S.tg) {
    const chats = await adminChats();
    if (chats.length) {
      const { liveSend } = await import("./tgbot.js");
      for (const c of chats) { try { await liveSend(c.workspace_id, c.chat_id, "ops:digest", text, [[{ text: "🩺 Відкрити кабінет", url: `${env.appBaseUrl}/app#/settings/profile` }]]); ok = true; } catch { /* */ } }
    }
  }
  if (S.email) {
    const subj = text.split("\n")[0];
    for (const addr of alertEmails()) { try { await sendOpsEmail(addr, subj, emailHtml(text)); ok = true; } catch { /* */ } }
  }
  return { sent: ok, text };
}

async function maybeDigest(): Promise<void> {
  if (!S.digest) return;
  const { date, hour } = localParts(new Date());
  if (hour < S.digestHour) return;
  const last = await one<{ value: any }>(`select value from app_setting where name='ops_digest_last'`).catch(() => null);
  if (last?.value === date) return;
  // спершу позначаємо: навіть якщо відправка впаде, не повторюємо кожні 10 хв
  await q(`insert into app_setting(name, value, updated_by) values('ops_digest_last', to_jsonb($1::text), 'system')
           on conflict (name) do update set value=excluded.value, updated_at=now()`, [date]);
  await sendDigest();
}

// ---------------- людині: її запланований пост не вийшов ----------------
/** Автопостер: пост не вийшов (не тимчасовий збій) - пишемо власнику кабінету в Telegram, з причиною
 *  і кнопкою на пост. Раніше це видно було лише в «Сьогодні», тобто людина дізнавалась, коли зайде. */
export async function notifyPublishFailed(ws: string, postId: string, errors: Array<{ net: string; error: string }>): Promise<void> {
  try {
    const owners = await q<{ chat_id: string }>(`select chat_id from tg_owner where workspace_id=$1 and chat_id is not null`, [ws]);
    if (!owners.length || !errors.length) return;
    const p = await one<{ content: string }>(`select content from post where id=$1`, [postId]);
    const first = String(p?.content || "").replace(/\s+/g, " ").trim();
    const text = [`⚠️ Запланований пост не вийшов`, first ? `«${first.length > 90 ? first.slice(0, 89) + "…" : first}»` : "",
      "", ...errors.slice(0, 5).map((e) => `• ${e.net}: ${String(e.error).slice(0, 220)}`),
      "", "Відкрий пост, виправ причину й опублікуй ще раз - решта мереж, куди вже вийшло, не задублюється."].filter((x, i, a) => x || a[i - 1]).join("\n");
    const { liveSend } = await import("./tgbot.js");
    for (const o of owners) await liveSend(ws, o.chat_id, "pubfail:" + postId.slice(0, 8), text, [[{ text: "✍ Відкрити пост", url: cabinetPostLink(env.appBaseUrl, postId) }]]).catch(() => {});
  } catch { /* сповіщення людині не повинно ламати автопостер */ }
}

// ---------------- стан для адмінки ----------------
export async function alertsView(): Promise<any> {
  const [open, recent, chats] = await Promise.all([
    q<AlertRow>(`select * from ops_alert where resolved_at is null order by (severity='critical') desc, last_at desc limit 30`),
    q<AlertRow>(`select * from ops_alert where notified_at is not null or resolved_at is not null order by coalesce(notified_at, resolved_at) desc limit 15`),
    adminChats(),
  ]);
  let bot = "";
  if (env.telegram.botToken) { try { bot = (await tg.getMe(env.telegram.botToken)).username || ""; } catch { bot = ""; } }
  const buddy = P.buddyUrl(env.appBaseUrl, S.watchUrl || env.alerts.watchUrl);
  return {
    instance: instanceLabel(), settings: { ...S },
    channels: { tg: { bot, chats: chats.length }, email: { to: alertEmails(), ok: !!env.resend.apiKey } },
    failover: { on: env.llm.failover, via: failoverVia() },
    buddy: { url: buddy, fails: buddyFails },
    open: open.map((a) => ({ ...a, hint: a.hint })), recent,
  };
}

// ---------------- запуск ----------------
let ticking = false;
export async function runProbes(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const f of [probeOpenRouter, probeElevenLabs, probeSharedBot, probeBackups, probeDisk, probeJobs, autoResolve])
      await f().catch((e: any) => console.warn("[alerts] проба:", e?.message));
    await flush();
    await maybeDigest().catch((e: any) => console.warn("[alerts] звіт:", e?.message));
  } finally { ticking = false; }
}

export async function startAlerts(): Promise<void> {
  await loadAlertSettings().catch(() => {});
  setLogHook(onLogEvent);
  started = true;
  const tick = env.alerts.tickMs;
  if (tick > 0) {
    setInterval(() => { runProbes().catch(() => {}); }, tick);
    setTimeout(() => { runProbes().catch(() => {}); }, Math.min(90_000, tick));   // і те, що не встигли надіслати до рестарту
  }
  if (env.alerts.buddyMs > 0) setInterval(() => { probeBuddy().catch(() => {}); }, env.alerts.buddyMs);
  console.log(`[alerts] сповіщення про збої: Telegram ${S.tg ? "так" : "ні"}, пошта ${S.email ? alertEmails().join(", ") : "ні"}, запасний маршрут AI ${env.llm.failover ? "так" : "ні"}`);
}
