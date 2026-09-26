// 🗓 Запобіжник від дублів у розкладі (фідбек тестера: «можна поставити два пости в один час і
// один текст двічі»). Не забороняє мовчки: каже, що саме збігається, а людина чи Claude вирішують -
// повторити з force (кабінет питає підтвердження) або обрати інший час / інший текст.
import { q, one } from "./db.js";
import { enabledNets } from "./publisher.js";

export type Conflict = { kind: "time" | "text"; postId: string; at: string | null; nets: string[]; state: string };

const NEAR_MIN = 5; // «той самий час» = ±5 хвилин в одну мережу

/** Інші пости кабінету, з якими цей пост зіткнеться: той самий час у ту саму мережу, або той самий
 *  текст, уже запланований чи опублікований. at=null - перевірка лише тексту (публікація «зараз»). */
export async function scheduleConflicts(ws: string, postId: string, at: Date | null, nets: string[]): Promise<Conflict[]> {
  const out: Conflict[] = [];
  if (at) {
    const rows = await q<{ post_id: string; scheduled_at: string; pch: any; sch: any }>(
      `select ss.post_id, ss.scheduled_at, p.channels as pch, ss.channels as sch
         from schedule_slot ss join post p on p.id=ss.post_id
         join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
        where s.workspace_id=$1 and ss.status='planned' and ss.post_id<>$2
          and ss.scheduled_at between $3::timestamptz - make_interval(mins => ${NEAR_MIN}) and $3::timestamptz + make_interval(mins => ${NEAR_MIN})
        order by ss.scheduled_at`, [ws, postId, at.toISOString()]);
    for (const r of rows) {
      const eff = enabledNets(r.pch).filter((n) => !r.sch || (r.sch[n] && r.sch[n].on));
      const both = eff.filter((n) => nets.includes(n));
      if (both.length) out.push({ kind: "time", postId: r.post_id, at: new Date(r.scheduled_at).toISOString(), nets: both, state: "planned" });
    }
  }
  // той самий текст (без різниці в регістрі й пробілах) - у пості, що вже в розкладі чи вже вийшов
  const same = await q<{ id: string; slot_at: string | null; sent_nets: string[] | null }>(
    `with me as (select lower(regexp_replace(btrim(content), '\\s+', ' ', 'g')) as t from post where id=$2)
     select p2.id,
            (select min(ss.scheduled_at) from schedule_slot ss where ss.post_id=p2.id and ss.status='planned') as slot_at,
            (select array_agg(distinct x.net) from (
               select 'telegram' as net from telegram_publish where post_id=p2.id and status='sent'
               union all select 'threads' from threads_publish where post_id=p2.id and status='sent'
               union all select channel from meta_publish where post_id=p2.id and status='sent'
               union all select 'linkedin' from linkedin_publish where post_id=p2.id and status='sent') x) as sent_nets
       from post p2 join pipeline_run r on r.id=p2.run_id join source s on s.id=r.source_id, me
      where s.workspace_id=$1 and p2.id<>$2 and p2.stage='final' and length(me.t) >= 20
        and lower(regexp_replace(btrim(p2.content), '\\s+', ' ', 'g')) = me.t
      limit 5`, [ws, postId]);
  for (const r of same) {
    const sentHere = (r.sent_nets || []).filter((n) => nets.includes(n));
    if (sentHere.length) out.push({ kind: "text", postId: r.id, at: null, nets: sentHere, state: "sent" });
    else if (r.slot_at) out.push({ kind: "text", postId: r.id, at: new Date(r.slot_at).toISOString(), nets: [], state: "planned" });
  }
  return out;
}

/** Людський опис збігів (одна фраза на збіг) - для конектора й кабінету. */
export function describeConflicts(list: Conflict[], fmt: (iso: string) => string, label: (n: string) => string, short: (id: string) => string): string[] {
  return list.map((c) => c.kind === "time"
    ? `у ${fmt(c.at!)} у ${c.nets.map(label).join(", ")} уже стоїть пост ${short(c.postId)}`
    : c.state === "sent"
      ? `такий самий текст уже опубліковано в ${c.nets.map(label).join(", ")} (пост ${short(c.postId)})`
      : `такий самий текст уже заплановано на ${fmt(c.at!)} (пост ${short(c.postId)})`);
}

/** Пост без жодної мережі чи без тексту - автопостеру нема чого й куди публікувати. */
export async function schedulable(postId: string): Promise<string | null> {
  const p = await one<{ content: string; channels: any; format: string | null }>(`select content, channels, format from post where id=$1`, [postId]);
  if (!p) return "пост не знайдено";
  if (!enabledNets(p.channels).length) return "у поста не обрано жодної мережі - автопостеру нема куди публікувати";
  if (!String(p.content || "").trim() && p.format !== "story") return "пост порожній - спершу додай текст";
  return null;
}
