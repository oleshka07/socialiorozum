// ⏳ Фонові джоби зі станом у Postgres, а не в памʼяті процесу.
//
// Було: чотири окремі Map (публікація, AI-дії, збірка рілса, публікація рілса). Деплой посеред
// публікації - клієнт бачить `idle` і не знає, чи пост вийшов; Map росли до перезапуску; кожен
// новий тип джоби заводив свою копію того самого коду (спіймано аудитом).
//
// Стало: одна таблиця `job` + одна функція. Контракт для клієнта той самий (`running|done|error|
// idle`), тож фронт не змінюється. Сама РОБОТА як і раніше живе в процесі (це не черга з воркерами) -
// але СТАН переживає рестарт: після старту всі «running» стають `idle` з людською причиною, і клієнт
// перечитує фактичний стан замість вічного спінера.
//
// Ключ (kind, key) дає дедуп: подвійний клік «Опублікувати» не запускає другу публікацію.
import { randomUUID } from "node:crypto";
import { q, one } from "./db.js";
import { logEvent } from "./log.js";

export type JobStatus = "running" | "done" | "error" | "idle";
export type JobRow = { id: string; workspace_id: string | null; kind: string; key: string | null; status: JobStatus; result: any; error: string | null; created_at: string; updated_at: string };

const LOST = "сервер перезапустився під час виконання - перевір фактичний стан";

/** Запустити роботу. Якщо джоба з тим самим (kind,key) уже біжить - повертаємо її (дедуп). */
// подвійний клік: два запити одночасно проходили перевірку «вже біжить?» і запускали ДВІ роботи
// (дві публікації одного поста). Джоби виконуються в цьому ж процесі, тож замок у памʼяті достатній.
const starting = new Map<string, Promise<JobRow>>();
export function startJob(kind: string, key: string | null, ws: string | null, work: () => Promise<any>): Promise<JobRow> {
  if (!key) return startJobNow(kind, key, ws, work);
  const k = kind + ":" + key;
  const pending = starting.get(k);
  if (pending) return pending;
  const p = startJobNow(kind, key, ws, work).finally(() => starting.delete(k));
  starting.set(k, p);
  return p;
}
async function startJobNow(kind: string, key: string | null, ws: string | null, work: () => Promise<any>): Promise<JobRow> {
  if (key) {
    const cur = await one<JobRow>(`select * from job where kind=$1 and key=$2 and status='running' order by created_at desc limit 1`, [kind, key]);
    if (cur) return cur;
  }
  const id = randomUUID();
  const row = await one<JobRow>(
    `insert into job(id, workspace_id, kind, key, status) values($1,$2,$3,$4,'running') returning *`, [id, ws, kind, key]);
  work()
    .then((result) => q(`update job set status='done', result=$2, updated_at=now() where id=$1`, [id, JSON.stringify(result ?? null)]))
    .catch(async (e: any) => {
      const msg = String(e?.message || e).slice(0, 400);
      await q(`update job set status='error', error=$2, updated_at=now() where id=$1`, [id, msg]).catch(() => {});
      await logEvent("warn", "job", `${kind}${key ? " " + key : ""}: ${msg}`, { ws, jobId: id });
    });
  return row!;
}

export async function getJob(id: string): Promise<JobRow | null> {
  return one<JobRow>(`select * from job where id=$1`, [id]);
}
/** Остання джоба цього ключа - для роутів, де клієнт полить за postId, а не за id джоби. */
export async function getJobByKey(kind: string, key: string): Promise<JobRow | null> {
  return one<JobRow>(`select * from job where kind=$1 and key=$2 order by created_at desc limit 1`, [kind, key]);
}

/** У форму, яку клієнт розуміє від першого дня: {status, ...result, error}. */
export function jobView(j: JobRow | null): Record<string, any> {
  if (!j) return { status: "idle" };
  const r = j.result && typeof j.result === "object" ? j.result : (j.result != null ? { result: j.result } : {});
  return { status: j.status, ...r, ...(j.error ? { error: j.error } : {}) };
}

/** На старті: усе, що «бігло» під час рестарту, робота вже не виконує - чесно позначаємо. */
export async function markLostJobs(): Promise<number> {
  const r = await q<{ id: string }>(`update job set status='idle', error=$1, updated_at=now() where status='running' returning id`, [LOST]).catch(() => []);
  if (r.length) await logEvent("warn", "job", `після рестарту позначено втраченими джоб: ${r.length}`);
  return r.length;
}

/** Прибирання: завершені старше доби - геть (клієнт полить хвилини, не дні). */
export async function sweepJobs(): Promise<void> {
  await q(`delete from job where status <> 'running' and updated_at < now() - interval '1 day'`).catch(() => {});
}
