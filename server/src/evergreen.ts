// ♻️ Вічнозелена черга (п.6 дорожньої карти): пости, що добре зайшли, повертаються через кілька тижнів -
// новим постом зі свіжим першим рядком, у найкращий час, щоб їх побачили нові підписники.
// Правила «що, куди й коли» - чисті, в evergreen-plan.ts; тут - бібліотека, повтори й воркер.
//
// Бібліотека: evergreen_item (пост-оригінал; active | off з причиною). Повтори: evergreen_run (кожен
// створений повтор - і тоді, коли людина його потім скасувала: тижневий ліміт рахує саме створені) +
// post.repeat_of у самого повтору. Налаштування - settings_block «evergreen» (типово черга вимкнена).
import { q, one } from "./db.js";
import { env } from "./env.js";
import { chat } from "./openrouter.js";
import { logEvent } from "./log.js";
import { getSetting, getSettingText, setSetting } from "./settings.js";
import { analyticsFor, bestTimesFor, bestTimeAuto } from "./metrics.js";
import { pickTimes } from "./besttime.js";
import { accountChoices, postAccounts, mainAccountIds, isMultiNet } from "./accounts.js";
import { connectedNets } from "./tgcompose.js";
import { enabledNets } from "./publisher.js";
import { repeatVariant } from "./pipeline.js";
import { normEg, dateBound, repeatNets, rankCandidates, hitsFrom, pickRepeatTime, nextEligible,
  type EgSettings, type EgCandidate, type EgPlanned } from "./evergreen-plan.js";

export { normEg, type EgSettings };
export const EG_LEAD_H = 24;       // повтор ставиться щонайменше за добу - людина встигає глянути й скасувати
const EG_HORIZON_DAYS = 8;
const EG_DAYS = 365;               // за скільки днів шукаємо хіти й «×норму» оригіналу

export async function egSettings(ws: string): Promise<EgSettings> {
  return normEg(await getSetting<unknown>(ws, "evergreen", {}));
}
export async function saveEgSettings(ws: string, patch: Partial<EgSettings>): Promise<EgSettings> {
  const next = normEg({ ...(await egSettings(ws)), ...patch });
  await setSetting(ws, "evergreen", next);
  return next;
}

async function wsTz(ws: string): Promise<string> {
  const tz = (await getSettingText(ws, "timezone")).trim() || "Europe/Kyiv";
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return "Europe/Kyiv"; }
}

type Sent = { nets: string[]; accs: Record<string, (string | null)[]>; first: number; last: number };
/** Куди й коли пости вийшли: мережі (по порядку першої публікації), акаунти рядків, перша й остання публікація. */
async function sentInfo(ids: string[]): Promise<Map<string, Sent>> {
  const out = new Map<string, Sent>();
  if (!ids.length) return out;
  const rows = await q<{ post_id: string; net: string; acc: string | null; at: string }>(
    `select post_id, net, acc, created_at as at from (
       select post_id, 'telegram' as net, chat_id as acc, created_at from telegram_publish where status='sent' and post_id = any($1)
       union all select post_id, 'threads', account_id, created_at from threads_publish where status='sent' and post_id = any($1)
       union all select post_id, channel, account_id, created_at from meta_publish where status='sent' and post_id = any($1)
       union all select post_id, 'linkedin', null, created_at from linkedin_publish where status='sent' and post_id = any($1)) x
     order by created_at`, [ids]);
  for (const r of rows) {
    const t = new Date(r.at).getTime();
    const s = out.get(r.post_id) || { nets: [], accs: {}, first: t, last: t };
    if (!s.nets.includes(r.net)) s.nets.push(r.net);
    (s.accs[r.net] = s.accs[r.net] || []).push(r.acc);
    s.first = Math.min(s.first, t); s.last = Math.max(s.last, t);
    out.set(r.post_id, s);
  }
  return out;
}

/** Найкраща «×норма» поста по мережах (з аналітики за рік). */
function multsOf(an: { post_id: string; net: string; mult: number | null }[], postId: string): Record<string, number | null> {
  const m: Record<string, number | null> = {};
  for (const p of an) if (p.post_id === postId && p.mult != null && (m[p.net] == null || p.mult > (m[p.net] as number))) m[p.net] = p.mult;
  return m;
}
const best = (m: Record<string, number | null>) => { const v = Object.values(m).filter((x): x is number => x != null); return v.length ? Math.max(...v) : null; };

type PostRow = { id: string; run_id: string; content: string; channels: any; format: string | null; media_id: string | null; image_prompt: string | null;
  image_base: string | null; headline: string | null; rubric: string | null; intent: string | null; slides_text: string | null; first_comment: string | null;
  reel_video: string | null; repeat_of: string | null; created_at: string };
async function postOf(ws: string, id: string): Promise<PostRow | null> {
  return one<PostRow>(
    `select p.id, p.run_id, p.content, p.channels, p.format, p.media_id, p.image_prompt, p.image_base, p.headline, p.rubric, p.intent,
            p.slides_text, p.first_comment, p.reel_video, p.repeat_of, p.created_at
       from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where p.id=$1 and s.workspace_id=$2`, [id, ws]);
}

// ---------- бібліотека ----------

export type EgAdd = { ok: true; state: "added" | "already" | "reactivated"; postId: string } | { ok: false; error: string };
/** Додати пост у чергу. Повтор додає свій оригінал (той самий пост), сторіс - ні (вона на добу). */
export async function addEvergreen(ws: string, postId: string, by: "user" | "auto" = "user"): Promise<EgAdd> {
  let p = await postOf(ws, postId);
  if (!p) return { ok: false, error: "пост не знайдено" };
  if (p.repeat_of) { const o = await postOf(ws, p.repeat_of); if (o) p = o; }
  if (p.format === "story") return { ok: false, error: "сторіс живе добу - у вічнозелену чергу її не ставимо" };
  const sent = (await sentInfo([p.id])).get(p.id);
  if (!sent) return { ok: false, error: "пост ще не публікувався - повторювати можна те, що вже вийшло" };
  const was = await one<{ status: string }>(`select status from evergreen_item where post_id=$1`, [p.id]);
  if (was?.status === "active") return { ok: true, state: "already", postId: p.id };
  if (was) {
    if (by === "auto") return { ok: true, state: "already", postId: p.id };   // людина прибрала - сам не повертаємо
    await q(`update evergreen_item set status='active', note=null where post_id=$1`, [p.id]);
    return { ok: true, state: "reactivated", postId: p.id };
  }
  await q(`insert into evergreen_item(post_id, workspace_id, added_by) values($1,$2,$3) on conflict (post_id) do nothing`, [p.id, ws, by]);
  return { ok: true, state: "added", postId: p.id };
}
/** Прибрати з черги: рядок лишається зі статусом off - щоб автододавання хітів не повернуло його саме. */
export async function removeEvergreen(ws: string, postId: string): Promise<boolean> {
  const p = await postOf(ws, postId);
  const id = p?.repeat_of || p?.id;
  if (!id) return false;
  const r = await one(`update evergreen_item set status='off', note='прибрано з черги' where post_id=$1 and workspace_id=$2 returning post_id`, [id, ws]);
  return !!r;
}
/** «Повертати все одно»: людина знає, що пост не прив'язаний до дати (або що дата неважлива). */
export async function forceEvergreen(ws: string, postId: string): Promise<boolean> {
  const r = await one(`update evergreen_item set status='active', note=null, force=true where post_id=$1 and workspace_id=$2 returning post_id`, [postId, ws]);
  return !!r;
}

/** Хіти за рік (×minMult від норми і більше) - у чергу самі; прибрані людиною не повертаються. */
async function autoAdd(ws: string, s: EgSettings, an: { post_id: string; mult: number | null; media?: string | null }[]): Promise<number> {
  const ids = [...new Set(an.map((p) => p.post_id))];
  if (!ids.length) return 0;
  const reps = await q<{ id: string }>(`select id from post where id = any($1) and (repeat_of is not null or format='story')`, [ids]);
  const hits = hitsFrom(an, s.minMult, new Set(reps.map((r) => r.id)));
  if (!hits.size) return 0;
  const added = await q(`insert into evergreen_item(post_id, workspace_id, added_by) select unnest($2::uuid[]), $1, 'auto' on conflict (post_id) do nothing returning post_id`,
    [ws, [...hits.keys()]]);
  return added.length;
}

// ---------- повтор ----------

async function freshHook(ws: string, content: string, force: boolean, tz: string): Promise<{ timeless: boolean; why: string; text: string }> {
  const tov = (await getSettingText(ws, "tone_of_voice")).trim();
  const today = new Intl.DateTimeFormat("uk-UA", { timeZone: tz, day: "numeric", month: "long", year: "numeric" }).format(new Date());
  const hint = dateBound(content);
  const sys = `Ти редактор соцмереж. Цей пост уже виходив і добре зайшов; його хочуть повторити, щоб побачили нові підписники. Сьогодні ${today}.
1) Визнач, чи пост досі доречний. НЕ доречний, якщо прив'язаний до дати чи події, що вже минула, до акції з дедлайном, до новини, до сезону, що минув, або «сьогодні/завтра/цього тижня» стосується конкретного дня.${hint ? ` Зверни увагу на «${hint}».` : ""}${force ? " Людина попросила повторити все одно - вважай його доречним." : ""}
2) Якщо доречний - перепиши ЛИШЕ перший рядок чи перший абзац (гачок): інші слова, інший кут заходу, та сама суть. Решту тексту поверни ДОСЛІВНО, з тими самими переносами рядків, емодзі й хештегами. Мова - та сама, що в пості.${tov ? `\nГолос бренду: ${tov.slice(0, 800)}` : ""}
Поверни JSON: {"timeless": true або false, "why": "коротко чому ні (порожньо, якщо так)", "text": "повний текст поста з новим першим рядком (порожньо, якщо ні)"}`;
  const out = await chat(env.cheapModel, sys, content, { workspaceId: ws, step: "evergreen", json: true, maxTokens: Math.min(6000, 500 + Math.ceil(content.length * 0.8)) });
  // обʼєкт усередині відповіді: деякі моделі (дешевий Gemini) обгортають JSON у ```json чи дописують слова
  const raw = String(out || ""), a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  let j: any;
  try { j = JSON.parse(raw.slice(a, b + 1)); } catch { throw new Error("модель повернула не JSON"); }
  const timeless = force || j?.timeless !== false;
  let text = String(j?.text || "").trim();
  // сміття чи обрізаний текст - краще дослівний повтор, ніж зіпсований пост
  if (timeless && (!text || text.length < content.length * 0.5 || text.length > content.length * 1.6)) text = content;
  return { timeless, why: String(j?.why || "").trim().slice(0, 200), text };
}

export type EgMade = { ok: true; repeatId: string; at: string; nets: string[] } | { ok: false; why: string; off?: boolean };
/**
 * Створити повтор поста з черги: копія (свіжий перший рядок, ті самі фото, кадри, перший коментар,
 * акаунти) у мережі, куди оригінал вийшов, і слот у календарі на найближчий добрий час.
 * off: true - пост більше не годиться для повтору (дата, акаунтів нема) - воркер знімає його з черги.
 */
export async function makeRepeat(ws: string, postId: string, o: { manual?: boolean; leadH?: number; an?: { post_id: string; net: string; mult: number | null }[]; s?: EgSettings } = {}): Promise<EgMade> {
  const s = o.s || await egSettings(ws);
  const orig = await postOf(ws, postId);
  if (!orig) return { ok: false, why: "пост не знайдено", off: true };
  const item = await one<{ status: string; force: boolean; added_by: string }>(`select status, force, added_by from evergreen_item where post_id=$1`, [orig.id]);
  const sent = (await sentInfo([orig.id])).get(orig.id);
  if (!sent) return { ok: false, why: "пост ще не публікувався", off: true };
  const an = o.an || (await analyticsFor(ws, EG_DAYS)).posts;
  const mults = multsOf(an, orig.id);
  const nets0 = repeatNets({ sent: sent.nets, mults, manual: !!o.manual || item?.added_by === "user", connected: await connectedNets(ws) });
  // акаунти: ті, якими пост справді вийшов (рядки публікацій), якщо вони досі в бренді
  const choices = await accountChoices(ws);
  const accs: Record<string, string[]> = {};
  const nets: string[] = [];
  for (const n of nets0) {
    const have = new Set(((choices as any)[n] || []).map((c: { id: string }) => c.id));
    const fromRows = isMultiNet(n) ? [...new Set((sent.accs[n] || []).filter((a): a is string => !!a))] : [];
    const chosen = fromRows.length ? fromRows : postAccounts(orig.channels, n);
    if (!chosen.length) { nets.push(n); continue; }                 // за замовчуванням - як і оригінал
    const still = chosen.filter((a) => have.has(a));
    if (!still.length) continue;                                     // акаунта, куди вийшло, вже нема в бренді
    accs[n] = still; nets.push(n);
  }
  if (!nets.length) return { ok: false, why: "мереж і акаунтів, куди пост виходив, уже нема в бренді", off: true };

  // текст: свіжий перший рядок (і перевірка «чи не прив'язаний до дати») або дослівно
  const tz = await wsTz(ws);
  let content = orig.content;
  const perNet: Record<string, string> = {};
  const force = !!item?.force;
  if (s.fresh) {
    let r: { timeless: boolean; why: string; text: string };
    try { r = await freshHook(ws, orig.content, force, tz); }
    catch (e: any) { return { ok: false, why: `свіжий перший рядок не вийшов: ${e.message}` }; }
    if (!r.timeless) return { ok: false, why: `прив'язаний до дати чи події${r.why ? `: ${r.why}` : ""}`, off: true };
    content = r.text;
    for (const n of nets) {
      const t = String(orig.channels?.[n]?.text || "").trim();
      if (t && t !== orig.content.trim()) {
        try { perNet[n] = await repeatVariant(ws, t); } catch { perNet[n] = t; }
      }
    }
  } else {
    const hit = force ? null : dateBound(orig.content);
    if (hit) return { ok: false, why: `схоже, прив'язаний до дати: «${hit}»`, off: true };
    for (const n of nets) { const t = String(orig.channels?.[n]?.text || "").trim(); if (t) perNet[n] = t; }
  }

  // коли: свій ритм мережі → найкращий час з власної статистики → час стратегії
  const rhythm = await getSetting<Record<string, any>>(ws, "channel_rhythm", {});
  const custom = nets.map((n) => rhythm?.[n]).find((r) => r && ((r.days && r.days.length) || r.time || (r.times && r.times.length)));
  const strat = await one<{ data: any }>(`select data from strategy where workspace_id=$1`, [ws]);
  const DMAP: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const stratDays: number[] = Array.isArray(strat?.data?.best_days)
    ? strat!.data.best_days.map((d: string) => DMAP[String(d).toLowerCase().slice(0, 3)]).filter((x: number | undefined) => x != null) : [];
  const stratTimes: string[] = Array.isArray(strat?.data?.times) ? strat!.data.times.map((t: unknown) => String(t)).filter((t: string) => /^\d{1,2}:\d{2}$/.test(t)) : [];
  let times: string[] = [];
  if (custom) times = Array.isArray(custom.times) && custom.times.length ? custom.times : custom.time ? [custom.time] : [];
  if (!times.length && (await bestTimeAuto(ws))) {
    const { items } = await bestTimesFor(ws);
    const mains = await mainAccountIds(ws);
    for (const n of nets) {
      const a = accs[n] || [];
      const pk = pickTimes(items, n, a.length === 1 ? a[0] : a.length ? null : ((mains as any)[n] || null));
      if (pk.times.length) { times = pk.times; break; }
    }
  }
  if (!times.length) times = stratTimes.length ? stratTimes : ["11:00"];
  const dows = custom && Array.isArray(custom.days) && custom.days.length ? custom.days.map(Number) : stratDays.length ? stratDays : null;
  const plannedRows = await q<{ at: string; ch: any; rep: string | null }>(
    `select ss.scheduled_at as at, coalesce(ss.channels, p.channels) as ch, p.repeat_of as rep
       from schedule_slot ss join post p on p.id=ss.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where s.workspace_id=$1 and ss.status='planned' and ss.scheduled_at between now() - interval '1 day' and now() + interval '${EG_HORIZON_DAYS + 2} days'`, [ws]);
  const planned: EgPlanned[] = plannedRows.map((r) => ({ at: new Date(r.at).getTime(), nets: enabledNets(r.ch), repeat: !!r.rep }));
  const slot = pickRepeatTime({ now: Date.now(), tz, leadH: o.leadH ?? EG_LEAD_H, horizonDays: EG_HORIZON_DAYS, dows, times, nets, planned,
    soonest: o.leadH != null && o.leadH < EG_LEAD_H });
  if (!slot) return { ok: false, why: `найближчі ${EG_HORIZON_DAYS} днів нема вільного часу в ${nets.join(", ")}` };

  // сам повтор: копія з тими самими фото, кадрами, першим коментарем; одразу затверджений - людина
  // бачить його в календарі й «Сьогодні» за добу до виходу
  const src = orig.channels && typeof orig.channels === "object" ? orig.channels : {};
  const ch: Record<string, any> = {};
  if (src.manual_adapt) ch.manual_adapt = true;
  if (src.native && nets.includes(src.native)) ch.native = src.native;
  for (const n of nets) {
    const c = src[n] && typeof src[n] === "object" ? { ...src[n] } : {};
    delete c.text; delete c.account; delete c.accounts;
    ch[n] = { ...c, on: true };
    if (perNet[n]) ch[n].text = perNet[n];
    if (accs[n]?.length) ch[n].accounts = accs[n];
  }
  const np = await one<{ id: string }>(
    `insert into post(run_id, stage, content, channels, format, media_id, image_prompt, image_base, headline, rubric, intent,
                      slides_text, first_comment, reel_video, review, repeat_of)
     values($1,'final',$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'approved',$14) returning id`,
    [orig.run_id, content, JSON.stringify(ch), orig.format || "post", orig.media_id, orig.image_prompt, orig.image_base, orig.headline,
      orig.rubric, orig.intent, orig.slides_text, orig.first_comment, orig.reel_video, orig.id]);
  await q(`insert into post_slide(post_id, pos, media_id) select $1, pos, media_id from post_slide where post_id=$2`, [np!.id, orig.id]);
  await q(`insert into schedule_slot(post_id, scheduled_at, status) values($1,$2,'planned')`, [np!.id, slot.at.toISOString()]);
  await q(`update evergreen_item set last_at=$2 where post_id=$1`, [orig.id, slot.at.toISOString()]);
  await q(`insert into evergreen_run(workspace_id, item_post_id, repeat_id, at) values($1,$2,$3,$4)`, [ws, orig.id, np!.id, slot.at.toISOString()]);
  await logEvent("info", "evergreen", `повтор #${orig.id.slice(0, 8)} → #${np!.id.slice(0, 8)} на ${slot.day} ${slot.time} (${nets.join(", ")})`, { ws });
  return { ok: true, repeatId: np!.id, at: slot.at.toISOString(), nets };
}

// ---------- стан для кабінету й конектора ----------

export type EgView = {
  settings: EgSettings; tz: string; weekUsed: number;
  items: { postId: string; title: string; addedBy: string; status: string; note: string | null; force: boolean; bestMult: number | null;
    repeats: number; firstSentAt: string | null; lastAt: string | null; nextAt: string | null; nets: string[] }[];
  upcoming: { id: string; of: string; at: string; title: string; nets: string[] }[];
  hits: { postId: string; title: string; mult: number }[];
};
const titleOf = (t: string) => String(t || "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 110) || "(без тексту)";

async function repeatsCount(ws: string): Promise<Map<string, number>> {
  const rows = await q<{ id: string; n: number }>(
    `select r.item_post_id as id, count(*)::int n from evergreen_run r
      where r.workspace_id=$1 and r.repeat_id is not null
        and (exists(select 1 from schedule_slot ss where ss.post_id=r.repeat_id and ss.status in ('planned','posting','posted'))
          or exists(select 1 from threads_publish x where x.post_id=r.repeat_id and x.status='sent')
          or exists(select 1 from meta_publish x where x.post_id=r.repeat_id and x.status='sent')
          or exists(select 1 from telegram_publish x where x.post_id=r.repeat_id and x.status='sent')
          or exists(select 1 from linkedin_publish x where x.post_id=r.repeat_id and x.status='sent'))
      group by 1`, [ws]);
  return new Map(rows.map((r) => [r.id, r.n]));
}

async function candidatesOf(ws: string, an: { post_id: string; net: string; mult: number | null }[]): Promise<EgCandidate[]> {
  const items = await q<{ post_id: string; status: string; last_at: string | null }>(`select post_id, status, last_at from evergreen_item where workspace_id=$1 and status='active'`, [ws]);
  if (!items.length) return [];
  const [sent, reps] = await Promise.all([sentInfo(items.map((i) => i.post_id)), repeatsCount(ws)]);
  return items.map((i) => ({
    postId: i.post_id, status: i.status, bestMult: best(multsOf(an, i.post_id)),
    firstSentAt: sent.get(i.post_id)?.first ?? null, lastAt: i.last_at ? new Date(i.last_at).getTime() : null, repeats: reps.get(i.post_id) || 0,
  }));
}

export async function evergreenView(ws: string): Promise<EgView> {
  const [s, tz, an] = await Promise.all([egSettings(ws), wsTz(ws), analyticsFor(ws, EG_DAYS).then((a) => a.posts)]);
  const rows = await q<{ post_id: string; added_by: string; status: string; note: string | null; force: boolean; last_at: string | null; content: string }>(
    `select e.post_id, e.added_by, e.status, e.note, e.force, e.last_at, p.content
       from evergreen_item e join post p on p.id=e.post_id where e.workspace_id=$1
      order by (e.status='active') desc, e.created_at desc limit 200`, [ws]);
  const [sent, reps, used, upc] = await Promise.all([
    sentInfo(rows.map((r) => r.post_id)), repeatsCount(ws),
    one<{ n: number }>(`select count(*)::int n from evergreen_run where workspace_id=$1 and created_at > now() - interval '7 days'`, [ws]),
    q<{ id: string; of: string; at: string; content: string; ch: any }>(
      `select p.id, p.repeat_of as of, ss.scheduled_at as at, p.content, coalesce(ss.channels, p.channels) as ch
         from schedule_slot ss join post p on p.id=ss.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
        where s.workspace_id=$1 and ss.status='planned' and p.repeat_of is not null order by ss.scheduled_at limit 20`, [ws]),
  ]);
  const items = rows.map((r) => {
    const snt = sent.get(r.post_id);
    const lastAt = r.last_at ? new Date(r.last_at).getTime() : null;
    const nx = r.status === "active" && (reps.get(r.post_id) || 0) < s.maxRepeats ? nextEligible({ firstSentAt: snt?.first ?? null, lastAt }, s.gapWeeks) : null;
    return {
      postId: r.post_id, title: titleOf(r.content), addedBy: r.added_by, status: r.status, note: r.note, force: r.force,
      bestMult: best(multsOf(an, r.post_id)), repeats: reps.get(r.post_id) || 0,
      firstSentAt: snt ? new Date(snt.first).toISOString() : null, lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
      nextAt: nx ? new Date(nx).toISOString() : null, nets: snt?.nets || [],
    };
  });
  // хіти, яких ще нема в черзі (коли автододавання вимкнено - щоб людина додала сама)
  const inLib = new Set(rows.map((r) => r.post_id));
  const repIds = new Set((await q<{ id: string }>(`select id from post where id = any($1) and (repeat_of is not null or format='story')`, [[...new Set(an.map((p) => p.post_id))]])).map((r) => r.id));
  const hitMap = hitsFrom(an, s.minMult, new Set([...repIds, ...inLib]));
  const hits = [...hitMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([postId, mult]) => ({
    postId, mult, title: titleOf(an.find((p) => p.post_id === postId)?.title || ""),
  }));
  return {
    settings: s, tz, weekUsed: used?.n || 0, items,
    upcoming: upc.map((u) => ({ id: u.id, of: u.of, at: new Date(u.at).toISOString(), title: titleOf(u.content), nets: enabledNets(u.ch) })),
    hits,
  };
}

// ---------- воркер ----------

const warned = new Map<string, number>();
async function warnOnce(ws: string, msg: string): Promise<void> {
  const k = `${ws}|${msg.slice(0, 60)}`;
  if (Date.now() - (warned.get(k) || 0) < 6 * 3600e3) return;
  warned.set(k, Date.now());
  await logEvent("warn", "evergreen", msg, { ws });
}

async function tickWorkspace(ws: string, s: EgSettings): Promise<void> {
  const an = (await analyticsFor(ws, EG_DAYS)).posts;
  if (s.autoAdd) {
    const n = await autoAdd(ws, s, an);
    if (n) await logEvent("info", "evergreen", `у чергу додано хітів: ${n}`, { ws });
  }
  const used = await one<{ n: number }>(`select count(*)::int n from evergreen_run where workspace_id=$1 and created_at > now() - interval '7 days'`, [ws]);
  if ((used?.n || 0) >= s.perWeek) return;
  const ranked = rankCandidates(await candidatesOf(ws, an), s, Date.now());
  for (const c of ranked.slice(0, 3)) {
    const r = await makeRepeat(ws, c.postId, { an, s });
    if (r.ok) return;
    if (r.off) { await q(`update evergreen_item set status='off', note=$2 where post_id=$1`, [c.postId, r.why]); continue; }
    await warnOnce(ws, `#${c.postId.slice(0, 8)}: ${r.why}`);
    return;                                   // тимчасове (AI, стеля, нема часу) - наступна спроба за пів години
  }
}

// один прохід на кабінет за раз (воркер і кнопка «увімкнути» не створять два повтори одночасно)
const running = new Set<string>();
/** Прохід черги для одного кабінету: хіти в чергу, і повтор, якщо тижневий ліміт дозволяє. */
export async function evergreenRunFor(ws: string): Promise<void> {
  if (running.has(ws)) return;
  const s = await egSettings(ws);
  if (!s.on) return;
  running.add(ws);
  try { await tickWorkspace(ws, s); }
  catch (e: any) { await warnOnce(ws, `воркер: ${e.message}`); }
  finally { running.delete(ws); }
}

export async function evergreenTick(): Promise<void> {
  const rows = await q<{ workspace_id: string; content: string }>(`select workspace_id, content from settings_block where key='evergreen'`);
  for (const r of rows) {
    let on = false;
    try { on = normEg(JSON.parse(r.content)).on; } catch { continue; }
    if (on) await evergreenRunFor(r.workspace_id);
  }
}

export function startEvergreen(): void {
  // EVERGREEN_TICK_MS=0 - без фонового воркера (тести: проходи лише на вимогу)
  if (process.env.EVERGREEN_TICK_MS === "0") { console.log("[evergreen] фоновий воркер вимкнено (EVERGREEN_TICK_MS=0)"); return; }
  const every = Number(process.env.EVERGREEN_TICK_MS) || 30 * 60e3;
  setTimeout(() => void evergreenTick(), Math.min(every, 90e3));
  setInterval(() => void evergreenTick(), every);
  console.log(`[evergreen] воркер вічнозеленої черги запущено (кожні ${Math.round(every / 60e3)} хв)`);
}

