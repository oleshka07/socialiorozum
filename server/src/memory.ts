// 🧠 Памʼять контенту: дистиляція опублікованого поста в структурований артефакт.
//
// Принцип узятий із внутрішньої бази знань Cerebras: сире не зберігають - його спершу проганяють
// через модель і кладуть уже структурованим (питання/підсумок/як вирішили/метадані). Якість там
// упирається не в те, ЧИМ шукаєш, а в те, ЩО поклав.
//
// У нашій задачі це лікує конкретну болячку. `recentContentDigest` (стара версія, лишилась нижче як
// фолбек) на КОЖНІЙ генерації брала 15 останніх опублікованих постів і стискала їх окремим
// LLM-викликом. Два наслідки: платили щоразу за ту саму роботу, і памʼять обривалась на 15 постах -
// усе старше для моделі не існувало, тож теми й гачки поверталися по колу.
//
// Тепер: пост дистилюється ОДИН раз при публікації, а генерація читає збережене й збирає підказку
// ДЕТЕРМІНОВАНО (без виклику моделі). Дешевше, ширше і точніше водночас - стиснення 15 постів у
// 8 буллетів саме по собі втрачало частину того, що якраз і не мало повторюватись.
//
// ⚠️ Файл названий memory.ts, а не digest.ts: digest.ts у нас уже зайнятий ранковим зведенням у
// Telegram - зовсім інша фіча.
import { q, one } from "./db.js";
import { chat, extractJsonObject } from "./openrouter.js";
import { env } from "./env.js";
import { logEvent } from "./log.js";

export type PostDigest = { hook: string; thesis: string; facts: string; cta: string; topics: string };

const MAX_ROWS = 40;      // скільки артефактів читаємо в підказку
const MIN_ROWS = 3;       // менше - сховище ще порожнє, працюємо старим шляхом
const MAX_CHARS = 1400;   // стеля підказки (промт і так щільний)

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------- дистиляція одного поста
// Ідемпотентна: пост, опублікований у 4 мережі, дистилюється ОДИН раз (перевірка існування ДО
// виклику моделі, потім ON CONFLICT DO NOTHING на гонку паралельних публікацій).
// пост, який не дистилювався (стеля витрат, модель віддала не JSON), бекфіл пробує знову не раніше
// ніж за добу: інакше такі пости стояли на початку черги щоразу й не пускали решту архіву
const digestFailedAt = new Map<string, number>();
export async function ensurePostDigest(workspaceId: string, postId: string): Promise<boolean> {
  const exists = await one<{ post_id: string }>(`select post_id from post_digest where post_id=$1`, [postId]);
  if (exists) return false;
  const post = await one<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where p.id=$1 and s.workspace_id=$2`, [postId, workspaceId]);
  if (!post || !String(post.content || "").trim()) return false;

  const system =
    "Розбери ОДИН опублікований пост і поверни ЛИШЕ JSON-обʼєкт:\n" +
    '{"hook":"перше речення поста дослівно","thesis":"головна теза одним реченням","facts":"конкретні цифри, назви, приклади з тексту через кому","cta":"заклик до дії дослівно","topics":"2-5 тем через кому"}\n' +
    "Нічого не вигадуй: якщо цифр чи заклику в тексті немає - лиши порожній рядок. Не переказуй пост і не оцінюй його.";
  let d: any;
  try {
    const raw = await chat(env.cheapModel, system, String(post.content).slice(0, 4000),
      { workspaceId, step: "post_digest", json: true });
    d = extractJsonObject<any>(raw);
  } catch (e: any) {
    // не критично: памʼять просто не поповнилась цим постом (публікація вже відбулась)
    digestFailedAt.set(postId, Date.now());
    await logEvent("warn", "post_digest", `не вдалось дистилювати пост: ${e.message}`, { ws: workspaceId, postId });
    return false;
  }
  await q(
    `insert into post_digest(post_id, workspace_id, hook, thesis, facts, cta, topics)
     values($1,$2,$3,$4,$5,$6,$7) on conflict (post_id) do nothing`,
    [postId, workspaceId, clean(d.hook, 200), clean(d.thesis, 300), clean(d.facts, 300), clean(d.cta, 200), clean(d.topics, 200)]
  );
  return true;
}

// ---------------------------------------------------------------- збирання підказки
// Чиста функція - саме тому вона під юнітами: тут легко тихо зіпсувати памʼять (загубити дедуп,
// перевищити стелю, віддати порожній блок як непорожній) і помітити це лише за якістю постів.
export function buildUsedDigest(rows: PostDigest[]): string {
  const pick = (get: (r: PostDigest) => string) => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const r of rows) {
      const v = String(get(r) || "").trim();
      if (!v) continue;
      // дедуп без урахування регістру й розділових: «А ви помічали?» і «а ви помічали» - те саме
      const key = v.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key); out.push(v);
    }
    return out;
  };
  const groups: [string, string[]][] = [
    ["Гачки (перші рядки)", pick((r) => r.hook)],
    ["Цифри й приклади", pick((r) => r.facts)],
    ["Заклики", pick((r) => r.cta)],
  ];
  let budget = MAX_CHARS;
  const lines: string[] = [];
  for (const [label, items] of groups) {
    const kept: string[] = [];
    for (const it of items) {
      if (budget - it.length - 3 < 0) break;
      kept.push(it); budget -= it.length + 3;
    }
    if (kept.length) lines.push(`${label}: ${kept.join(" · ")}`);
  }
  if (!lines.length) return "";
  return "\n\nВЖЕ ВИКОРИСТАНО в попередніх постах (НЕ повторюй дослівно чи майже дослівно ці гачки/цифри/заклики):\n"
    + lines.map((l) => `- ${l}`).join("\n");
}

// Підказка для генерації. Читає сховище; поки артефактів майже нема (старий воркспейс до бекфілу) -
// свідомо працює СТАРИМ шляхом, щоб памʼять не зникла на день переходу.
export async function usedDigest(workspaceId: string): Promise<string> {
  let rows: PostDigest[] = [];
  try {
    rows = await q<PostDigest>(
      `select hook, thesis, facts, cta, topics from post_digest where workspace_id=$1 order by created_at desc limit ${MAX_ROWS}`,
      [workspaceId]);
  } catch { rows = []; }
  if (rows.length >= MIN_ROWS) return buildUsedDigest(rows);
  return legacyRecentDigest(workspaceId);
}

// ---------------------------------------------------------------- бекфіл уже опублікованого
// Ліміт свідомо низький: кожен артефакт - це виклик моделі, і разовий прохід по всьому архіву
// коштував би відчутних грошей. Воркер lifecycle крутиться раз на 6 год, тож архів наздоганяється
// поступово й непомітно для гаманця.
export async function backfillDigests(limit = 40): Promise<number> {
  let done = 0;
  try {
    // distinct on вимагає order by починати з нього ж, тому «найновіші перші» доводиться робити
    // зовнішнім order by - інакше порція бекфілу була б випадковою за id, а не найсвіжішою
    // (а саме свіжі пости памʼяті потрібні найбільше).
    const rows = await q<{ post_id: string; workspace_id: string }>(
      `select post_id, workspace_id from (
         select distinct on (u.pid) u.pid as post_id, s.workspace_id, u.at from (
            select tp.post_id as pid, tp.created_at as at from telegram_publish tp where tp.status='sent'
            union all select tp.post_id, tp.created_at from threads_publish tp where tp.status='sent'
            union all select tp.post_id, tp.created_at from meta_publish tp where tp.status='sent'
            union all select tp.post_id, tp.created_at from linkedin_publish tp where tp.status='sent'
          ) u
          join post p on p.id=u.pid join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
          left join post_digest d on d.post_id=u.pid
         where d.post_id is null
         order by u.pid, u.at desc
       ) x order by x.at desc limit $1`, [limit * 5]);
    const now = Date.now();
    const due = rows.filter((r) => now - (digestFailedAt.get(r.post_id) || 0) > 24 * 3600_000).slice(0, limit);
    for (const r of due) if (await ensurePostDigest(r.workspace_id, r.post_id)) done++;
  } catch (e: any) {
    await logEvent("warn", "post_digest", `бекфіл не завершився: ${e.message}`);
  }
  if (done) await logEvent("info", "post_digest", `дистильовано постів: ${done}`);
  return done;
}

// ---------------------------------------------------------------- ФОЛБЕК (стара поведінка)
// Лишений навмисно: доки у воркспейсі ще нема кількох артефактів, генерація має отримувати ту саму
// памʼять, що й раніше, а не порожній блок.
async function legacyRecentDigest(workspaceId: string): Promise<string> {
  const rows = await q<{ pid: string; content: string }>(
    `select p.id as pid, p.content from (
       select tp.post_id as pid, tp.created_at as at from telegram_publish tp where tp.status='sent'
       union all select tp.post_id, tp.created_at from threads_publish tp where tp.status='sent'
       union all select tp.post_id, tp.created_at from meta_publish tp where tp.status='sent'
       union all select tp.post_id, tp.created_at from linkedin_publish tp where tp.status='sent'
     ) u join post p on p.id=u.pid join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
     where s.workspace_id=$1 order by u.at desc limit 60`, [workspaceId]);
  const seen = new Set<string>(); const posts: string[] = [];
  for (const r of rows) { if (seen.has(r.pid)) continue; seen.add(r.pid); posts.push(r.content); if (posts.length >= 15) break; }
  if (!posts.length) return "";
  try {
    const raw = await chat(env.cheapModel,
      "Ось останні опубліковані пости бренду. Виведи КОРОТКИЙ список (до 8 пунктів) - які гачки (перші рядки), конкретні цифри-приклади й заклики до дії вже використані, щоб наступні пости НЕ повторювали їх дослівно чи майже дослівно. Лише буллети, без пояснень і вступів.",
      posts.map((p, i) => `${i + 1}. ${p.slice(0, 400)}`).join("\n---\n"),
      { workspaceId, step: "recent_digest" });
    const text = raw.trim().slice(0, 1200);
    return text ? `\n\nВЖЕ ВИКОРИСТАНО в останніх постах (НЕ повторюй дослівно чи майже дослівно ці гачки/цифри/заклики):\n${text}` : "";
  } catch { return ""; }
}
