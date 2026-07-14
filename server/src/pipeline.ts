import { createHash } from "node:crypto";
import { q, one } from "./db.js";
import { chat, extractJsonArray, extractJsonObject } from "./openrouter.js";
import { env } from "./env.js";

// порядок кроків кишки (strategy = v2)
export const STEP_ORDER = ["extract_ideas", "drafts", "tone", "format", "deai", "strategy"] as const;
export type StepKey = (typeof STEP_ORDER)[number];

// РЕДАГОВАНІ промпти - ЛИШЕ обробка/стилістика. Технічну частину (формат JSON, контекст бренду)
// додає код нижче (STEP_CONTEXT/STEP_FORMAT), щоб правки промпта не ламали парсинг.
export const DEFAULT_PROMPTS: Record<StepKey, { model: string; content: string }> = {
  extract_ideas: {
    model: "openai/gpt-4o-mini",
    content: "Ти контент-стратег. Знайди в транскрипті окремі контент-ідеї, кожна зі своїм кутом подачі.",
  },
  drafts: {
    model: "anthropic/claude-sonnet-4.5",
    content:
      "Зроби пост СУВОРО на основі змісту сесії (першоджерело нижче) - використовуй конкретні приклади, думки й формулювання саме з неї, не вигадуй загальних порад «з повітря». " +
      "Структура: гачок, 2-4 абзаци користі, м'який заклик. Поверни лише текст поста.",
  },
  tone: {
    model: "anthropic/claude-sonnet-4.5",
    content: "Перепиши пост у голосі бренду, не змінюючи зміст. Поверни лише текст.",
  },
  format: {
    model: "openai/gpt-4o-mini",
    content: "Зроби чистий, готовий до публікації формат: короткі абзаци, помірні емодзі. Поверни лише текст.",
  },
  deai: {
    model: "anthropic/claude-sonnet-4.5",
    content: "Прибери ознаки AI. Збережи зміст, голос і формат (абзаци, емодзі, хештеги). Поверни лише текст.",
  },
  strategy: {
    model: "openai/gpt-4o-mini",
    content: "Признач кожному готовому посту (по порядку) тип і рекомендований зсув у днях від старту, спираючись на контент-стратегію.",
  },
};

// Наскрізне правило стилю для ВСІЄЇ генерації тексту: широке тире («—») - типовий AI-маркер.
const NO_DASH_RULE = "\n\nПунктуація: НІКОЛИ не використовуй широке тире («—») чи середнє тире («–») у тексті. Замінюй їх комою, двокрапкою, дефісом або розбивай на окремі речення.";

// Бан хук-кліше + принцип кульмінації («Хук-майстер»): відкриття з найсильнішого моменту, не зі штучної інтриги.
const HOOK_RULE = "\n\nГачки-кліше ЗАБОРОНЕНІ (штучна інтрига): «СТОП», «не гортай», «зупинись», «99% не знають», «шок», «ти не повіриш», «зараз розкажу», «УВАГА». Натомість знайди КУЛЬМІНАЦІЮ матеріалу (найсильніший факт, цифру, момент чи висновок) і відкрий пост прямо з неї.";

// Компактний каталог AI-слідів для української («Антидетектор»): детерміновані заборони поверх deai_rules юзера.
const ANTI_AI_RULE = "\n\nAI-сліди, які ЗАБОРОНЕНО вживати: конструкція «не просто X, а Y»; канцелярит («здійснювати», «забезпечувати», «варто зазначити», «наразі», «даний»); пусті вступи («у сучасному світі», «давайте розберемось», «як відомо»); фінальні підсумки («отже, підсумуємо», «сподіваюсь, було корисно»); симетричні парні речення; слова-паразити «ключовий», «важливо розуміти», «варто памʼятати»; три однорідні прикметники поспіль.";

// «Сходи офферів» + принцип «знання безкоштовно - продаємо виконання»: CTA обирається за теплотою
// поста і веде на відповідну сходинку, а продає історія клієнта з результатом, не пряме «купи».
export function offerLadder(s: Record<string, string>): string {
  const rungs: string[] = [];
  if ((s.offer_low || "").trim()) rungs.push(`низький поріг: ${s.offer_low.trim().slice(0, 150)}`);
  if ((s.offer_mid || "").trim()) rungs.push(`середній: ${s.offer_mid.trim().slice(0, 150)}`);
  if ((s.offer_high || "").trim()) rungs.push(`преміум: ${s.offer_high.trim().slice(0, 150)}`);
  if (!rungs.length) return "";
  return `\n\nСХОДИ ОФФЕРІВ бренду: ${rungs.join(" → ")}. Правила продажу: заклик відповідає теплоті поста (холодний освітній → лід-магніт чи підписка; теплий → нижча сходинка; гарячий кейс → вища); знання віддаємо безкоштовно ПОВНІСТЮ - продаємо виконання, супровід і глибину; продає конкретна історія клієнта з результатом і цифрами + мʼякий заклик («як Х отримав Y - повна система в …»), НІКОЛИ не голе «купуй». Продажний пуш без цінності витрачає довіру.`;
}

// Зняття заперечень (VSL-принцип): читач весь час скептичний («чому вірити? а в моєму випадку?»)
// - хороший пост знімає головний скепсис у самому тексті, а не лишає його на коментарі.
const OBJECTION_RULE = "\n\nСкепсис читача: подумки назви ГОЛОВНЕ заперечення аудиторії до цієї тези («чому цьому вірити?», «а в моєму випадку спрацює?», «що мені з цього?») і зніми його прямо в тексті - фактом, прикладом чи цифрою. Без фраз на кшталт «ви можете подумати» чи «багато хто скаже».";

// «Директор»: головна бізнес-ціль контенту - фільтр «веде до цілі чи контент заради контенту».
export const GOAL_LABELS: Record<string, string> = {
  money: "продажі та гроші (контент має підводити до покупки)",
  leads: "ліди й заявки (контент має вести до звернення чи заявки)",
  growth: "зростання аудиторії (охоплення, підписки, поширення)",
  authority: "авторитет і експертність (довіра та репутація в ніші)",
  quality: "якість аудиторії (утримання й залучення саме цільових людей)",
};
const goalRule = (s: Record<string, string>): string =>
  s.primary_goal && GOAL_LABELS[s.primary_goal]
    ? `\n\nГОЛОВНА БІЗНЕС-ЦІЛЬ контенту: ${GOAL_LABELS[s.primary_goal]}.${(s.goal_metric || "").trim() ? ` Метрика і строк: ${s.goal_metric.trim().slice(0, 160)}.` : ""} Кожен пост має конкретно просувати до цієї цілі. Жодного «контенту заради контенту».`
    : "";

// «Паспорт голосу» (брендбук): структуровані поля поверх вільного ToV - звертання, підпис, стоп-лист, емодзі.
// Інʼєктується поруч із tone_of_voice у всі точки генерації.
export function voicePassport(s: Record<string, string>): string {
  const parts: string[] = [];
  if (s.voice_address === "ty") parts.push("звертання до читача - на «ти»");
  if (s.voice_address === "vy") parts.push("звертання до читача - на «ви»");
  if (s.voice_emoji === "no") parts.push("емодзі НЕ вживати взагалі");
  if (s.voice_emoji === "min") parts.push("емодзі - максимум 1-2 на пост, без емодзі-буллетів");
  if ((s.voice_stoplist || "").trim()) parts.push(`СТОП-ЛИСТ (ці слова і фрази НІКОЛИ не вживати): ${s.voice_stoplist.trim().slice(0, 400)}`);
  if ((s.voice_signature || "").trim()) parts.push(`фірмовий підпис наприкінці поста, точним формулюванням, коли доречно: «${s.voice_signature.trim().slice(0, 120)}»`);
  return parts.length ? `\n\nПАСПОРТ ГОЛОСУ (обовʼязково): ${parts.join("; ")}.` : "";
}
// чи відкалібрований голос узагалі (для чесного бейджа в UI)
export function voiceCalibrated(s: Record<string, string>): boolean {
  return !!((s.tone_of_voice || "").trim() || (s.voice_examples || "").trim());
}

// «ДНК бренду»: бренд = навмисне парування асоціацій. Юзер задає, з чим бренд МАЄ асоціюватись
// і з чим НІКОЛИ (анти-список - головний захист бренду), + історію бренду (каталіст / переконання /
// доказ / переломні моменти) як ЄДИНЕ джерело особистих фактів - щоб AI не вигадував біографію.
// Інʼєктується поруч із voicePassport у точки генерації.
export function brandDna(s: Record<string, string>): string {
  const parts: string[] = [];
  if ((s.brand_assoc || "").trim())
    parts.push(`бренд навмисно асоціюємо з: ${s.brand_assoc.trim().slice(0, 300)} - кожен пост має підсилювати ці асоціації`);
  if ((s.brand_antiassoc || "").trim())
    parts.push(`бренд НІКОЛИ не асоціюємо з: ${s.brand_antiassoc.trim().slice(0, 300)} - жодних таких тем, прикладів, порівнянь, жартів чи тону`);
  const dna = parts.length ? `\n\nДНК БРЕНДУ: ${parts.join("; ")}.` : "";
  const story = (s.brand_story || "").trim();
  const st = story
    ? `\n\nІСТОРІЯ БРЕНДУ (єдине джерело особистих фактів автора - шлях, невдачі, переломні моменти; НІКОЛИ не вигадуй подій, яких нема тут чи у вхідному матеріалі):\n${story.slice(0, 1200)}`
    : "";
  return dna + st;
}

// ХАРДКОД (не редагується юзером): контекст бренду + контракт формату відповіді.
const STEP_CONTEXT: Record<StepKey, (s: Record<string, string>) => string> = {
  extract_ideas: (s) => (s.marketing_context ? `\n\nКонтекст бренду й аудиторії: ${s.marketing_context}` : ""),
  drafts:        (s) => (s.marketing_context ? `\n\nКонтекст бренду й аудиторії: ${s.marketing_context}` : ""),
  tone:          (s) => (s.tone_of_voice ? `\n\nГолос бренду (Tone of Voice): ${s.tone_of_voice}` : ""),
  format:        () => "",
  deai:          (s) => (s.deai_rules ? `\n\nПравила де-AI: ${s.deai_rules}` : ""),
  strategy:      (s) => (s.content_strategy ? `\n\nКонтент-стратегія: ${s.content_strategy}` : ""),
};
const STEP_FORMAT: Partial<Record<StepKey, string>> = {
  extract_ideas: `\n\nПоверни ЛИШЕ валідний JSON-масив, без жодного тексту довкола: [{"idea":"...","angle":"..."}]`,
  strategy: `\n\nПоверни ЛИШЕ валідний JSON-масив рівно по одному обʼєкту на пост, у тому ж порядку: [{"type":"користь|історія|рефлексія|заклик","dayOffset":0}]`,
};

// Вивести tone of voice із прикладів постів (Базa бренду). Пропонує (пише в tone_of_voice_derived), не чіпає tone_of_voice.
export async function deriveVoice(workspaceId: string): Promise<string> {
  const settings = await loadSettings(workspaceId);
  const examples = (settings.voice_examples || "").trim();
  if (!examples) throw new Error("Спершу встав 3-5 прикладів постів");
  const lang = (settings.output_language || "Українська").trim();
  const system =
    "Проаналізуй приклади постів автора і опиши його tone of voice (голос бренду) СТРУКТУРОВАНО, як робочу інструкцію для AI-копірайтера:\n" +
    "1) Тон і звертання (ти/ви, енергія, дистанція) - 2-3 речення.\n" +
    "2) РОБИ: 5 характерних прийомів автора (ритм, довжина абзаців, як будує гачки, як завершує).\n" +
    "3) НЕ РОБИ: 5 речей, які зламали б цей голос.\n" +
    "4) Фірмова лексика: 5-10 слів/зворотів, які автор реально вживає.\n" +
    "5) Емодзі: які, скільки, де.\n" +
    "Стисло, без преамбул і води." +
    `\n\nМова опису: ${lang}.`;
  const derived = await chat("anthropic/claude-sonnet-4.5", system, `Приклади постів:\n---\n${examples}`, { workspaceId, step: "tone" });
  await q(
    `insert into settings_block(workspace_id, key, content) values($1,'tone_of_voice_derived',$2)
     on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
    [workspaceId, derived]
  );
  return derived;
}

// Згенерувати контент-стратегію (L2) із Бази бренду. Зберігає у strategy.data (draft).
// Аналіз реальних постів автора (Instagram) -> ніша/аудиторія, голос, контент-нотатки, мова. Один виклик.
export async function deriveBrandFromText(workspaceId: string, text: string): Promise<{ tone_of_voice: string; marketing_context: string; content_strategy: string; language: string }> {
  const system = "Проаналізуй реальні пости автора нижче й поверни:\n" +
    "1) marketing_context - ніша, тематика й цільова аудиторія (2-4 речення);\n" +
    "2) tone_of_voice - стислий опис тону й стилю автора;\n" +
    "3) content_strategy - короткі нотатки про теми/рубрики, які варто публікувати;\n" +
    "4) language - мова, якою переважно пише автор (назва УКРАЇНСЬКОЮ, напр.: Українська, Англійська, Чеська, Польська, Німецька, Іспанська, Французька, Італійська).\n" +
    "Поверни ЛИШЕ валідний JSON: {\"marketing_context\":\"…\",\"tone_of_voice\":\"…\",\"content_strategy\":\"…\",\"language\":\"…\"}.";
  const raw = await chat("openai/gpt-4o-mini", system, "Пости автора:\n---\n" + text.slice(0, 12000), { workspaceId, step: "derive_brand" });
  const o = (extractJsonObject<any>(raw)) || {};
  return {
    tone_of_voice: String(o.tone_of_voice || "").trim(),
    marketing_context: String(o.marketing_context || "").trim(),
    content_strategy: String(o.content_strategy || "").trim(),
    language: String(o.language || "").trim(),
  };
}

export async function generateStrategy(workspaceId: string): Promise<any> {
  const s = await loadSettings(workspaceId);
  if (s.prompt_engine !== "legacy") return generateStrategyV2(workspaceId, s);
  const lang = (s.output_language || "Українська").trim();
  const system =
    "Ти контент-стратег. На основі ніші, аудиторії й голосу бренду згенеруй контент-стратегію. " +
    'Поверни ЛИШЕ валідний JSON-обʼєкт: {"rubrics":[{"name":"...","emoji":"...","description":"...","share":40}],' +
    '"frequency":{"posts_per_week":4},"best_days":["mon","wed","fri"],"times":["11:00","18:00"],' +
    '"channels":["telegram"],"schedule_rationale":"чому саме ці дні й час для цієї ніші та каналу","monthly_themes":["...","..."]}. ' +
    "4-6 рубрик, сума share = 100. Дні й час публікацій підбери за найкращими практиками саме для цієї ніші та каналу: " +
    "best_days - короткі коди (пн=mon … нд=sun); times - формат HH:MM, 1-3 значення (скільки значень - стільки постів на день)." +
    `\n\nМова текстів (rubrics, schedule_rationale, monthly_themes): ${lang}.`;
  const user = `Ніша й аудиторія: ${s.marketing_context || ""}\nГолос бренду: ${s.tone_of_voice || ""}\nНотатки стратегії: ${s.content_strategy || ""}`;
  const raw = await chat("openai/gpt-4o-mini", system, user, { workspaceId, step: "strategy" });
  const parsed = extractJsonObject(raw);
  await q(
    `insert into strategy(workspace_id,data,status,updated_at) values($1,$2,'draft',now())
     on conflict (workspace_id) do update set data=excluded.data, status='draft', updated_at=now()`,
    [workspaceId, JSON.stringify(parsed)]
  );
  return parsed;
}

// ---- V2 (Strategy Brief): єдиний бриф-джерело правди (Prompt 1) ----
// Надбудова над legacy: видає СУПЕРСЕТ JSON (rubrics/best_days/times/channels лишаються,
// щоб календар і рубрики працювали) + поля брифу. Компактний бриф пишеться в settings_block.strategy_brief
// для інʼєкції у Lite та канальні плани. Прапорець: settings_block.prompt_engine='v2'.
async function generateStrategyV2(workspaceId: string, s: Record<string, string>): Promise<any> {
  const lang = (s.output_language || "Українська").trim();
  const system =
    "Ти топовий SMM- і контент-стратег із 15+ роками побудови органічного зростання. " +
    "На основі бізнесу, ніші, аудиторії й голосу бренду побудуй ЄДИНИЙ стратегічний бриф (Strategy Brief) - джерело правди для всього контенту. " +
    "Застосуй перевірені фреймворки: Jobs-to-Be-Done, StoryBrand (клієнт = герой, бренд = провідник), контент-пілери, правило 80/20 (цінність/промо), Hero-Hub-Hygiene (~10/30/60). " +
    "Будь конкретним і рішучим - займай позицію, не лий води. " +
    'Поверни ЛИШЕ валідний JSON-обʼєкт точно такої форми: {' +
    '"positioning":"одне речення позиціювання",' +
    '"differentiators":["…","…","…"],' +
    '"icp":{"audience":"хто це","jtbd":["…"],"pains":["…"],"desires":["…"],"objections":["…"]},' +
    '"brandscript":"герой(клієнт) / його проблема / бренд як провідник / план / заклик / успіх / провал",' +
    '"brand_voice":{"tone":"…","dos":["…"],"donts":["…"]},' +
    '"content_pillars":[{"name":"…","why":"чому виграє","jtbd":"яку задачу закриває","funnel":"awareness|consideration|conversion","angles":["…","…"]}],' +
    '"messaging":{"value_prop":"…","proof_points":["…"],"big_idea":"…"},' +
    '"offers_and_ctas":{"primary_offer":"…","lead_magnet":"…","soft_cta":"…","hard_cta":"…"},' +
    '"value_promotion_ratio":"80/20","hhh_split":"10/30/60",' +
    '"rubrics":[{"name":"…","emoji":"…","description":"…","share":40}],' +
    '"frequency":{"posts_per_week":4},"best_days":["mon","wed","fri"],"times":["11:00","18:00"],' +
    '"channels":["telegram"],"schedule_rationale":"чому саме ці дні й час для цієї ніші та каналу","monthly_themes":["…","…"]' +
    "}. " +
    "3-5 рубрик (узгоджені з content_pillars за темами), сума share = 100. " +
    "best_days - короткі коди (пн=mon … нд=sun); times - формат HH:MM, 1-3 значення." +
    `\n\nМова всіх текстів брифу: ${lang}.`;
  const user =
    `Бізнес, ніша й аудиторія: ${s.marketing_context || ""}\n` +
    `Голос бренду: ${s.tone_of_voice || ""}\n` +
    `Нотатки стратегії: ${s.content_strategy || ""}\n` +
    `Продукти/офери/ціни: ${s.offers_and_prices || ""}`;
  const raw = await chat("openai/gpt-4o", system, user, { workspaceId, step: "strategy" });
  const parsed: any = extractJsonObject(raw) || {};
  await q(
    `insert into strategy(workspace_id,data,status,updated_at) values($1,$2,'draft',now())
     on conflict (workspace_id) do update set data=excluded.data, status='draft', updated_at=now()`,
    [workspaceId, JSON.stringify(parsed)]
  );
  const briefText = renderBriefText(parsed);
  if (briefText)
    await q(
      `insert into settings_block(workspace_id,key,content) values($1,'strategy_brief',$2)
       on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
      [workspaceId, briefText]
    );
  return parsed;
}

// Компактний текстовий рендер брифу для інʼєкції у промти (Lite/канальні плани/атомізація).
function renderBriefText(b: any): string {
  if (!b || typeof b !== "object") return "";
  const arr = (x: any) => (Array.isArray(x) ? x.filter(Boolean).join("; ") : "");
  const pillars = Array.isArray(b.content_pillars)
    ? b.content_pillars.map((p: any) => `${p?.name || ""} (${p?.funnel || ""}: ${arr(p?.angles)})`).filter(Boolean).join(" | ")
    : "";
  const lines = [
    b.positioning && `Позиціювання: ${b.positioning}`,
    Array.isArray(b.differentiators) && b.differentiators.length && `Відмінності: ${arr(b.differentiators)}`,
    b.icp && `Аудиторія: ${b.icp.audience || ""}; болі: ${arr(b.icp.pains)}; бажання: ${arr(b.icp.desires)}; заперечення: ${arr(b.icp.objections)}`,
    b.brand_voice && `Голос: ${b.brand_voice.tone || ""}; робити: ${arr(b.brand_voice.dos)}; уникати: ${arr(b.brand_voice.donts)}`,
    pillars && `Контент-пілери: ${pillars}`,
    b.messaging && `Ключове повідомлення: ${b.messaging.value_prop || ""}; велика ідея: ${b.messaging.big_idea || ""}`,
    b.offers_and_ctas && `Офер: ${b.offers_and_ctas.primary_offer || ""}; лід-магніт: ${b.offers_and_ctas.lead_magnet || ""}; мʼякий CTA: ${b.offers_and_ctas.soft_cta || ""}; жорсткий CTA: ${b.offers_and_ctas.hard_cta || ""}`,
    `Цінність:промо = ${b.value_promotion_ratio || "80/20"}; Hero-Hub-Hygiene = ${b.hhh_split || "10/30/60"}`,
  ].filter(Boolean);
  return lines.join("\n");
}

async function loadSettings(workspaceId: string): Promise<Record<string, string>> {
  const rows = await q<{ key: string; content: string }>(
    `select key, content from settings_block where workspace_id=$1`,
    [workspaceId]
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.content]));
}

function fillPrompt(t: string, settings: Record<string, string>): string {
  return t.replace(/\{\{(\w+)\}\}/g, (_, k) => settings[k] ?? "");
}

async function resolvePrompt(workspaceId: string, step: StepKey) {
  const tpl = await one<{ content: string; model: string; version: number }>(
    `select content, model, version from prompt_template
     where workspace_id=$1 and step_key=$2 and is_active=true
     order by version desc limit 1`,
    [workspaceId, step]
  );
  return tpl ?? { ...DEFAULT_PROMPTS[step], version: 0 };
}

function hash(s: string) {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

// контекст прогону
async function runContext(runId: string) {
  const row = await one<{ source_id: string; workspace_id: string; transcript: string }>(
    `select r.source_id, s.workspace_id, s.transcript
     from pipeline_run r join source s on s.id=r.source_id where r.id=$1`,
    [runId]
  );
  if (!row) throw new Error("run не знайдено");
  // Кап вхідного матеріалу: gpt-4o на Tier-1 OpenAI має ліміт 30k токенів/хв (TPM). Повний транскрипт
  // (години розмови) не влазить у один запит → 429 "Request too large". ~32k символів (≈12-20k токенів)
  // більш ніж достатньо, щоб згенерувати пости, і лишає запас під TPM.
  if (row.transcript && row.transcript.length > 32000) row.transcript = row.transcript.slice(0, 32000);
  return row;
}

const stageOf: Record<string, string> = { drafts: "draft", tone: "toned", format: "formatted", deai: "final" };

async function getPosts(runId: string, stage: string) {
  return q<{ id: string; content: string }>(
    `select id, content from post where run_id=$1 and stage=$2 order by created_at`,
    [runId, stage]
  );
}

async function upsertStepRun(runId: string, step: StepKey, patch: any) {
  await q(
    `insert into step_run(run_id, step_key, model, prompt_version, input_hash, status, output, error, updated_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (run_id, step_key) do update set
       model=excluded.model, prompt_version=excluded.prompt_version, input_hash=excluded.input_hash,
       status=excluded.status, output=excluded.output, error=excluded.error, updated_at=now()`,
    [runId, step, patch.model ?? null, patch.prompt_version ?? null, patch.input_hash ?? null,
     patch.status, patch.output ? JSON.stringify(patch.output) : null, patch.error ?? null]
  );
}

// позначити всі наступні кроки як stale
async function markDownstreamStale(runId: string, step: StepKey) {
  const idx = STEP_ORDER.indexOf(step);
  const downstream = STEP_ORDER.slice(idx + 1);
  if (!downstream.length) return;
  await q(
    `update step_run set status='stale', updated_at=now()
     where run_id=$1 and step_key = any($2) and status <> 'idle'`,
    [runId, downstream]
  );
}

/** Виконати один крок кишки, зберегти результат, позначити downstream як stale. */
export async function executeStep(runId: string, step: StepKey, opts?: { count?: number; rubrics?: string[] }) {
  const { workspace_id, transcript } = await runContext(runId);
  const settings = await loadSettings(workspace_id);
  const tpl = await resolvePrompt(workspace_id, step);
  const lang = (settings.output_language || "Українська").trim();
  let rubricsText = "", countText = "";
  if (step === "extract_ideas" || step === "drafts" || step === "strategy") {
    let rubs = await q<{ name: string; share: number; description: string }>(
      `select name, share, description from rubric where workspace_id=$1 order by idx`, [workspace_id]);
    if (step === "extract_ideas" && Array.isArray(opts?.rubrics) && opts!.rubrics.length)
      rubs = rubs.filter((r) => opts!.rubrics!.includes(r.name));
    if (rubs.length) rubricsText = "\n\nРубрики контенту (орієнтир для тем і пропорцій у наборі постів): " +
      rubs.map((r) => `${r.name} ~${r.share}%${r.description ? ` (${r.description})` : ""}`).join("; ") + ".";
  }
  if (step === "extract_ideas") countText = `\n\nЗнайди до ${Math.max(1, Math.min(12, Number(opts?.count) || 6))} контент-ідей.`;
  const system = fillPrompt(tpl.content, settings) + STEP_CONTEXT[step](settings) + (STEP_FORMAT[step] || "")
    + countText + goalRule(settings) + (step === "drafts" ? HOOK_RULE : "") + NO_DASH_RULE + ANTI_AI_RULE + `\n\nМова всього тексту у відповіді: ${lang}.` + rubricsText;
  const ctx = { workspaceId: workspace_id, step };
  await upsertStepRun(runId, step, { status: "running", model: tpl.model, prompt_version: tpl.version });

  try {
    if (step === "extract_ideas") {
      const out = await chat(tpl.model, system, `Транскрипт:\n---\n${transcript}`, ctx);
      const ideas = extractJsonArray<{ idea: string; angle?: string }>(out);
      await q(`delete from idea where run_id=$1`, [runId]);
      for (let i = 0; i < ideas.length; i++)
        await q(`insert into idea(run_id, idx, idea, angle, selected) values($1,$2,$3,$4,true)`,
          [runId, i, ideas[i].idea, ideas[i].angle ?? ""]);
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version,
        input_hash: hash(transcript), output: ideas });
    } else if (step === "drafts") {
      const ideas = await q<{ id: string; idea: string; angle: string }>(
        `select id, idea, angle from idea where run_id=$1 and selected=true order by idx`, [runId]);
      if (!ideas.length) throw new Error("немає відібраних ідей");
      await q(`delete from post where run_id=$1 and stage='draft'`, [runId]);
      const outs: string[] = [];
      for (const it of ideas) {
        const txt = await chat(tpl.model, system,
          `Зміст сесії (першоджерело):\n---\n${transcript}\n---\nЗроби пост за цією ідеєю, спираючись на конкретику сесії вище:\nІдея: ${it.idea}\nКут: ${it.angle}`, ctx);
        outs.push(txt);
        await q(`insert into post(run_id, idea_id, stage, content) values($1,$2,'draft',$3)`,
          [runId, it.id, txt]);
      }
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version, output: outs });
    } else if (step === "tone" || step === "format" || step === "deai") {
      const inputStage = step === "tone" ? "draft" : step === "format" ? "toned" : "formatted";
      const stage = stageOf[step];
      const src = await getPosts(runId, inputStage);
      if (!src.length) throw new Error(`немає вхідних постів стадії ${inputStage}`);
      await q(`delete from post where run_id=$1 and stage=$2`, [runId, stage]);
      const outs: string[] = [];
      for (const p of src) {
        const txt = await chat(tpl.model, system, `---\n${p.content}`, ctx);
        outs.push(txt);
        await q(`insert into post(run_id, stage, content) values($1,$2,$3)`, [runId, stage, txt]);
      }
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version, output: outs });
    } else if (step === "strategy") {
      const finals = await getPosts(runId, "final");
      if (!finals.length) throw new Error("немає фінальних постів");
      // AI радить лише тип і день для КОЖНОГО готового поста (по порядку) - самі пости не змінюємо
      const out = await chat(tpl.model, system,
        "Готові пости (по порядку):\n" + finals.map((p, i) => `[${i}] ${p.content}`).join("\n\n"), ctx);
      let advice: { type?: string; dayOffset?: number }[] = [];
      try { advice = extractJsonArray<{ type?: string; dayOffset?: number }>(out); } catch { advice = []; }
      await q(`delete from content_plan where run_id=$1`, [runId]);
      const cp = await one<{ id: string }>(`insert into content_plan(run_id) values($1) returning id`, [runId]);
      for (let i = 0; i < finals.length; i++) {
        const a = advice[i] ?? {};
        const title = (finals[i].content.split("\n")[0] || `Пост ${i + 1}`).slice(0, 80);
        await q(`insert into plan_item(plan_id, post_id, title, type, day_offset) values($1,$2,$3,$4,$5)`,
          [cp!.id, finals[i].id, title, a.type ?? null, a.dayOffset ?? i * 2]);
      }
      await upsertStepRun(runId, step, { status: "fresh", model: tpl.model, prompt_version: tpl.version, output: advice });
    }

    await markDownstreamStale(runId, step);
    return { ok: true };
  } catch (e: any) {
    await upsertStepRun(runId, step, { status: "error", error: e.message, model: tpl.model });
    throw e;
  }
}

/** Перегенерувати один текст через промпт/модель заданого кроку (для кнопки «Перегенерувати»). */
export async function rewriteWithStep(workspaceId: string, step: StepKey, text: string): Promise<string> {
  const settings = await loadSettings(workspaceId);
  const tpl = await resolvePrompt(workspaceId, step);
  const lang = (settings.output_language || "Українська").trim();
  const system = fillPrompt(tpl.content, settings) + STEP_CONTEXT[step](settings) + NO_DASH_RULE + `\n\nМова всього тексту у відповіді: ${lang}.`;
  return chat(tpl.model, system, `---\n${text}`, { workspaceId, step });
}

// AI-адаптація поста під кожну соцмережу (один виклик -> JSON {channel: text})
export async function adaptForChannels(workspaceId: string, content: string, channels: string[]): Promise<Record<string, string>> {
  const rules: Record<string, string> = {
    telegram: "Telegram: короткі абзаци, помірні емодзі, 1-2 хештеги.",
    instagram: "Instagram: чіпкий підпис + 5-10 релевантних хештегів наприкінці.",
    threads: "Threads: ЖОРСТКИЙ ліміт 500 символів (довший пост НЕ опублікується - скороти безжально), без хештегів, розмовний тон, перший рядок = гачок, наприкінці питання або кодове слово (НЕ «лайкни/підпишись» - це ріжеться алгоритмом).",
    facebook: "Facebook: 1-3 абзаци, нейтральний тон, без надлишку хештегів.",
    linkedin: "LinkedIn: професійний, але живий тон від першої особи; сильний перший рядок (він видимий до «…more»); 2-4 короткі абзаци з особистим досвідом/висновком; 3-5 хештегів наприкінці; без емодзі-спаму.",
  };
  const want = channels.filter((c) => rules[c]);
  if (!want.length) return {};
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const v2 = s.prompt_engine !== "legacy";
  const tone = (s.tone_of_voice ? `\nГолос бренду (зберігай): ${s.tone_of_voice}` : "") + voicePassport(s);
  const deai = s.deai_rules ? `\nПравила «без AI» (зберігай): ${s.deai_rules}` : "";
  // V2: адаптація успадковує бриф і ПОВНІ плейбуки каналів (алгоритми 2025-26), не однорядкові правила
  const brief = v2 ? (s.strategy_brief || "").trim() : "";
  const playbooks = v2
    ? "\nПлейбуки каналів (перекладай пост у нативний формат, НЕ вигадуй новий зміст):\n" + want.map((c) => `[${c}] ${CHANNEL_PLAYBOOK[c] || rules[c]}\nФормат: ${rules[c]}`).join("\n")
    : "\nПравила:\n" + want.map((c) => "- " + rules[c]).join("\n");
  const critique = v2 ? "\nПеред видачею перевір кожну версію: гачок працює саме для цього каналу; довжина й формат нативні; голос не зламано. Слабке перепиши." : "";
  // «Дистриб'ютор»: CTA, замаршрутизований під механіку кожної площадки (settings_block.cta_config).
  let ctaCfg: Record<string, { type?: string; value?: string }> = {};
  try { ctaCfg = JSON.parse(s.cta_config || "{}"); } catch { /* некоректний JSON - без CTA */ }
  const ctaLines = want.map((c) => {
    const cc = ctaCfg[c]; if (!cc || !String(cc.value || "").trim()) return "";
    const v = String(cc.value).trim().slice(0, 200);
    const mech = cc.type === "keyword"
      ? `заклич написати кодове слово «${v}» у коментар або дірект (посилання в цій мережі не клікаються)`
      : cc.type === "action" ? `заклич до дії: ${v}`
      : `заклич перейти за посиланням ${v}`;
    return `\n[${c}] ${mech}`;
  }).filter(Boolean).join("");
  const ctaRule = ctaLines
    ? `\n\nКонверсійний заклик наприкінці кожної версії - ОДИН заклик = ОДНА дія, нативно вплетений:${ctaLines}` +
      "\nЕталон CTA. Погано: «Підписуйся, став лайк і пиши в дірект» (три прохання = нуль дій). Добре: «Напиши в коментарях слово ГАЙД - надішлю шаблон» (одна дія, одна механіка, вимірний результат)."
    : "";
  const structRules = "\n\nСтруктурні правила: telegram - ПЕРШИЙ рядок має чіпляти до згортання «…ще»; linkedin - скелет утримання: сильний перший рядок (видимий до «…more») → чому це важливо зараз (ставки) → 2-3 блоки, кожен закінчується власним висновком-пейофом → синтез → CTA.";
  // Формат постів під конкретну мережу (settings_block.channel_format): короткий/стандарт/довгий + нотатка стилю.
  // Закриває кейс «Threads під тренди на 50-100 символів» - юзер задає формат один раз у Налаштуваннях.
  let fmtCfg: Record<string, { len?: string; note?: string }> = {};
  try { fmtCfg = JSON.parse(s.channel_format || "{}"); } catch { /* некоректний JSON - стандартні формати */ }
  const FMT_RULES: Record<string, string> = {
    short: "ЦІЛЬОВА довжина: КОРОТКО, 50-150 символів, 1-2 живі речення, одна думка, без хештегів і без вступів",
    long: "ЦІЛЬОВА довжина: розгорнуто, використовуй більшу частину ліміту мережі",
  };
  const fmtLines = want.map((c) => {
    const fc = fmtCfg[c]; if (!fc) return "";
    const parts = [FMT_RULES[String(fc.len || "")] || "", String(fc.note || "").trim().slice(0, 300)].filter(Boolean);
    return parts.length ? `\n[${c}] ${parts.join(". ")}` : "";
  }).filter(Boolean).join("");
  const fmtRule = fmtLines ? `\n\nФормат, який обрав користувач для конкретних мереж (ПРІОРИТЕТ над плейбуком):${fmtLines}` : "";
  const system = "Адаптуй пост під кожну вказану соцмережу, зберігаючи зміст, голос бренду й живу людську мову." +
    (brief ? `\n\n<strategy_brief>\n${brief}\n</strategy_brief>` : "") +
    tone + deai + playbooks + critique + goalRule(s) + ctaRule + offerLadder(s) + structRules + fmtRule +
    "\n\nЖОРСТКІ ліміти довжини версій (НЕ перевищуй, це технічні ліміти мереж): telegram 1024, threads 500, instagram 2200, facebook 2000, linkedin 3000 символів." +
    NO_DASH_RULE + ANTI_AI_RULE + `\n\nПоверни ЛИШЕ валідний JSON-обʼєкт виду {${want.map((c) => `"${c}":"…"`).join(",")}}. Мова: ${lang}.`;
  const raw = await chat(v2 ? "openai/gpt-4o" : "openai/gpt-4o-mini", system, `Пост:\n---\n${content}`, { workspaceId, step: "format" });
  const obj = extractJsonObject(raw) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const c of want) if (obj && obj[c]) out[c] = String(obj[c]);
  // LLM інколи ігнорує ліміти («до 500 симв.» у Threads) - перевіряємо КОДОМ і скорочуємо повторним викликом.
  const HARD_LIMITS: Record<string, number> = { telegram: 1024, threads: 500, instagram: 2200, facebook: 2000, linkedin: 3000 };
  for (const c of want) {
    const lim = HARD_LIMITS[c];
    if (!out[c] || !lim || out[c].length <= lim) continue;
    try {
      const short = await chat(v2 ? "openai/gpt-4o" : "openai/gpt-4o-mini",
        `Скороти пост до МАКСИМУМ ${lim - 40} символів (жорсткий технічний ліміт мережі ${c}), зберігши гачок, головну думку, голос і заклик.` + NO_DASH_RULE + `\nПоверни лише текст поста. Мова: ${lang}.`,
        out[c], { workspaceId, step: "format" });
      if (short && short.trim()) out[c] = short.length <= lim ? short.trim() : short.slice(0, lim - 1).replace(/\s+\S*$/, "") + "…";
    } catch { /* лишаємо як є - композер підсвітить перевищення червоним */ }
  }
  return out;
}

// ---- LITE: один зібраний промт (усі кроки кишки в одному) ----
// Зібрати спільний системний промт Lite-генерації (для самої генерації + для перегляду користувачем).
export async function buildLitePrompt(workspaceId: string, count: number, ideas?: string[]): Promise<{ system: string; model: string }> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const rubs = await q<{ name: string; share: number; description: string }>(
    `select name, share, description from rubric where workspace_id=$1 order by idx`, [workspaceId]);
  const rubricsText = rubs.length
    ? "\n\nРубрики (орієнтир тем і пропорцій у наборі): " + rubs.map((r) => `${r.name} ~${r.share}%${r.description ? ` (${r.description})` : ""}`).join("; ") + "."
    : "";
  const ideasText = (ideas && ideas.length)
    ? "\n\nНапиши рівно по ОДНОМУ посту на кожну з цих тем (у тому ж порядку):\n" + ideas.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "";
  const n = ideas && ideas.length ? ideas.length : count;
  const v2 = s.prompt_engine !== "legacy";
  const outputFormat = `Поверни ЛИШЕ валідний JSON-масив обʼєктів: [{"text":"повний текст поста","image_prompt":"короткий опис зображення англійською для генерації - сцена/обʼєкти/настрій, без тексту на зображенні","rubric":"назва рубрики поста${rubs.length ? " (СТРОГО одна з переліку рубрик вище)" : ""}"}, …]. Мова текстів постів: ${lang}.`;

  if (v2) {
    // V2 (бібліотека промтів): XML-структура + multishot (реальні пости автора) + меню гачків +
    // фреймворк під воронку + само-критика. Порядок секцій: роль → бриф → бренд → зразки → правила → задача → формат.
    const brief = (s.strategy_brief || "").trim();
    const examples = (s.voice_examples || "").trim().slice(0, 3000);
    const system =
      "<role>Ти елітний direct-response копірайтер і SMM-автор із 15+ роками досвіду. Пишеш нативно для соцмереж і НІКОЛИ не звучиш як AI чи «загальний» контент.</role>" +
      (brief ? `\n\n<strategy_brief>\nДжерело правди - не суперечити:\n${brief}\n</strategy_brief>` : "") +
      "\n\n<brand>" +
      (s.marketing_context ? `\nБренд і аудиторія: ${s.marketing_context}` : "") +
      (s.tone_of_voice ? `\nГолос бренду (суворо дотримуйся): ${s.tone_of_voice}` : "") + voicePassport(s) + brandDna(s) +
      (s.deai_rules ? `\nПравила «без AI»: ${s.deai_rules}` : "") +
      "\n</brand>" +
      (examples ? `\n\n<voice_examples>\nРЕАЛЬНІ пости автора - еталон голосу. Відтворюй ритм, лексику, звертання й розмір абзаців САМЕ як тут, але НЕ копіюй зміст:\n---\n${examples}\n---\n</voice_examples>` : "") +
      (s.primary_goal && GOAL_LABELS[s.primary_goal] ? `\n\n<business_goal>\nГоловна бізнес-ціль контенту: ${GOAL_LABELS[s.primary_goal]}. Кожен пост має конкретно просувати до неї - жодного контенту заради контенту.${offerLadder(s)}\n</business_goal>` : offerLadder(s)) +
      "\n\n<rules>" +
      "\n- Кожен пост ОДРАЗУ фінальний: жива людська мова, без канцеляризмів, без «варто зазначити/у сучасному світі», без шаблонних списків заради списків." +
      "\n- Фреймворк під стадію воронки поста: AIDA або PAS - холодна аудиторія (awareness); BAB - короткі залучальні пости; FAB/4P - тепла аудиторія (consideration/conversion); СТОРІ - для постів-історій: гачок з кульмінації → проблема зі ставками (читач бачить у ній себе) → шлях з «брудною серединою» (реальні сумніви, помилки, невизначеність - НЕ суцільні перемоги) → урок з конкретними кроками → мʼякий CTA." +
      "\n- Конкретика замість епітетів: не «я працьовитий», а історія чи цифра, що це ДОВОДИТЬ (не «винахідливий», а «стіл зробив із дверей»). Прогрес резонує сильніше за перфектність; невдачі будують довіру сильніше за перемоги - але бери їх ЛИШЕ з матеріалу чи історії бренду, не вигадуй." +
      "\n- Гачок (перший рядок вирішує все): подумки склади 3 варіанти різних типів (цікавісний розрив, патерн-перебій, контр-теза, попередження про помилку, число/список, пряма обіцянка) і залиш у пості НАЙСИЛЬНІШИЙ." +
      "\n- Один чіткий мʼякий заклик на пост, не більше." +
      rubricsText +
      NO_DASH_RULE.replace(/^\n+/, "\n- ") +
      HOOK_RULE.replace(/^\n+/, "\n- ") +
      ANTI_AI_RULE.replace(/^\n+/, "\n- ") +
      OBJECTION_RULE.replace(/^\n+/, "\n- ") +
      "\n</rules>" +
      `\n\n<task>\nЗгенеруй рівно ${n} різних постів за вхідним матеріалом.${ideasText}\nПеред видачею САМО-КРИТИКА кожного поста за 5 критеріями: (а) гачок зупиняє скрол; (б) голос як у зразках; (в) один чіткий CTA; (г) нативний формат; (д) реальна користь для читача. Усе, що слабке, перепиши до видачі.\n</task>` +
      `\n\n<output_format>\n${outputFormat}\n</output_format>`;
    return { system, model: "openai/gpt-4o" };
  }

  // LEGACY (prompt_engine != v2) - незмінний класичний промт
  const system =
    "Ти досвідчений SMM-копірайтер. За вхідним матеріалом нижче згенеруй готові до публікації пости. " +
    "Кожен пост ОДРАЗУ фінальний: у голосі бренду, живою людською мовою без ознак AI (без канцеляризмів, без «варто зазначити/у сучасному світі», без шаблонних списків заради списків), з чітким гачком, користю та мʼяким закликом." +
    (s.marketing_context ? `\n\nБренд і аудиторія: ${s.marketing_context}` : "") +
    (s.tone_of_voice ? `\n\nГолос бренду (суворо дотримуйся): ${s.tone_of_voice}` : "") + voicePassport(s) + brandDna(s) +
    (s.deai_rules ? `\n\nПравила «без AI»: ${s.deai_rules}` : "") +
    rubricsText + ideasText + goalRule(s) + offerLadder(s) + HOOK_RULE + ANTI_AI_RULE + OBJECTION_RULE +
    NO_DASH_RULE + `\n\nЗгенеруй рівно ${n} різних постів. ${outputFormat}`;
  return { system, model: "openai/gpt-4o" };
}

// Lite-генерація: ОДИН виклик LLM -> N готових постів (замість 5 кроків кишки).
export async function generatePostsOnePass(runId: string, count: number, ideas?: string[]): Promise<number> {
  const { workspace_id, transcript } = await runContext(runId);
  const sel = (ideas || []).map((t) => String(t).trim()).filter(Boolean);
  const n = Math.max(1, Math.min(12, sel.length ? sel.length : (Number(count) || 6)));
  const { system, model } = await buildLitePrompt(workspace_id, n, sel.length ? sel : undefined);
  const out = await chat(model, system, `Вхідний матеріал:\n---\n${transcript}`, { workspaceId: workspace_id, step: "lite" });
  let posts: { text: string; image_prompt: string; rubric: string }[] = [];
  try {
    posts = extractJsonArray<any>(out).map((x) => typeof x === "string"
      ? { text: x, image_prompt: "", rubric: "" }
      : { text: String(x?.text || x?.content || x?.post || ""), image_prompt: String(x?.image_prompt || x?.image || ""), rubric: String(x?.rubric || "") })
      .map((p) => ({ text: p.text.trim(), image_prompt: p.image_prompt.trim(), rubric: p.rubric.trim().slice(0, 60) })).filter((p) => p.text);
  } catch { posts = []; }
  if (!posts.length) throw new Error("Не вдалося згенерувати пости (порожня відповідь моделі)");
  await q(`delete from post where run_id=$1 and stage='final'`, [runId]);
  for (const p of posts) await q(`insert into post(run_id, stage, content, image_prompt, rubric) values($1,'final',$2,$3,$4)`, [runId, p.text, p.image_prompt || null, p.rubric || null]);
  return posts.length;
}

// ---- V2 Крок 3: контент-план по каналах (Prompts 2-7, лише канали socialio) ----
const CHANNEL_PLAYBOOK: Record<string, string> = {
  telegram:
    "Telegram: алгоритмічної стрічки немає - кожен пост іде всім підписникам через push. Завдання - утримання, щільність користі й воронка, не «вірусність». Архітектура: канал (broadcast) + група (спільнота) + бот (лід-магніт/автоматизація). ~80/20 користь/продаж; кілька якісних постів/тиждень > обсяг. Нативні формати: розмітка тексту, опитування, голосові, закріплене повідомлення з офером.",
  instagram:
    "Instagram (Mosseri, 2025): головні сигнали - час перегляду, sends-per-reach (поширення в DM), saves. Reels = охоплення/нові люди; каруселі (до 20 слайдів) = збереження й глибоке залучення; Stories = стосунки. Гачок у перші 3 сек (інакше ~50% відвалюються). Тільки ОРИГІНАЛЬНИЙ контент (без водяних знаків). Ключові слова в підписі (social SEO), 3-5 релевантних тегів.",
  threads:
    "Threads (доказова база 2025-26): ліміт 500 символів; підписники майже не важать - кожен пост змагається з нуля, алгоритм важить РАННЄ залучення і швидкість/якість відповідей (розмова > трансляція; Мосері: «відповідай більше, ніж постиш»). Пиши як розмову в курилці: одна думка = один пост, короткі речення, повітря між абзацами, перший рядок = гачок (без нього - скрол повз). Робочі формати: короткий тейк/спостереження з життя, питання до аудиторії, нумерований список/чек-лист (збирає сейви), особиста історія чи чесний провал з уроком, факт із конкретною цифрою, контр-теза до загальноприйнятого. Сейви й репости важать більше за лайки - давай те, що хочеться зберегти собі. CTA: кодове слово у відповідь АБО питання, що провокує відповіді; НІКОЛИ «постав лайк / підпишись / тегни друга» (engagement-bait алгоритм ріже). Без хештегів. Посилання не штрафуються, але сильніше працює окремою відповіддю, коли пост уже розганяється.",
  facebook:
    "Facebook: усе відео тепер Reels (охоплення поза підписниками); зберігання/поширення > лайки; фото добре заходять у стрічці (підписи 40-80 символів). Групи дають значно більше органіки, ніж сторінки - спільнота в групі, анонси на сторінці. Оригінальність винагороджується.",
};

export async function generateChannelPlan(workspaceId: string, channel: string, horizonDays: number, postsPerWeek: number): Promise<any[]> {
  const playbook = CHANNEL_PLAYBOOK[channel];
  if (!playbook) throw new Error("Канал не підтримується: " + channel);
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const brief = (s.strategy_brief || "").trim();
  const system =
    `Ти старший контент-стратег каналу ${channel}, що знає його алгоритм 2025-2026. ` +
    "Розширюй ЄДИНУ стратегію на цей канал, НЕ суперечачи брифу - перекладай позиціювання, пілери, голос і офери у нативний для каналу контент, а не вигадуй наново. " +
    (brief
      ? `\n\nСТРАТЕГІЧНИЙ БРИФ:\n${brief}`
      : `\n\nКонтекст бренду: ${s.marketing_context || ""}\nГолос: ${s.tone_of_voice || ""}`) +
    `\n\nПравила каналу:\n${playbook}` +
    `\n\nПобудуй контент-план на ${horizonDays} днів за темпу ${postsPerWeek} постів/тиждень. ` +
    "Кожен пункт прив'яжи до пілера й стадії воронки; тримай 80/20 користь/промо та розподіл Hero/Hub/Hygiene. " +
    'Поверни ЛИШЕ валідний JSON-масив обʼєктів: [{"day":1,"pillar":"…","hhh":"hero|hub|hygiene","funnel":"awareness|consideration|conversion","format":"…","hook":"чіпкий гачок/робоча назва","message":"ключова думка","cta":"…","kpi":"головна метрика"}]. ' +
    `Мова всіх текстів: ${lang}.`;
  const raw = await chat("openai/gpt-4o", system, "Згенеруй контент-план.", { workspaceId, step: "channel_plan" });
  let rows: any[] = [];
  try { rows = extractJsonArray<any>(raw); } catch { rows = []; }
  await q(
    `insert into settings_block(workspace_id,key,content) values($1,$2,$3)
     on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
    [workspaceId, "channel_plan_" + channel, JSON.stringify(rows)]
  );
  return rows;
}

// ---- 🧵 Threads: гілка (root + відповіді) та щоденні тейки ----
// Розбити майстер-текст на гілку Threads: частина 1 = гачок + обіцянка, далі по тезі на ветку.
// «Перелив-пости» з практики: у стрічці видно лише root + першу відповідь → клік = глибоке
// залучення = сигнал утримання для алгоритму. Кожна частина має читатися самостійно.
export async function threadsSplit(workspaceId: string, content: string): Promise<string[]> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const system =
    "Розбий пост на гілку Threads: root-пост + відповіді автора самому собі." +
    "\nПравила: кожна частина ≤450 символів і читається САМОСТІЙНО (людина може побачити її без сусідніх); частина 1 = гачок + обіцянка того, що буде далі (БЕЗ спойлера висновку); далі одна теза/крок на частину, нумеруй «2/», «3/»…; остання частина - висновок + мʼяке питання до читача. Разом 2-6 частин. НЕ вигадуй нового змісту - лише перепаковуй." +
    (s.tone_of_voice ? `\nГолос бренду (зберігай): ${s.tone_of_voice}` : "") + voicePassport(s) +
    NO_DASH_RULE + ANTI_AI_RULE +
    `\nПоверни ЛИШЕ валідний JSON-масив рядків: ["частина 1","частина 2",…]. Мова: ${lang}.`;
  let parts: string[] = [];
  try {
    const raw = await chat("openai/gpt-4o", system, `Пост:\n---\n${content}`, { workspaceId, step: "threads_split" });
    parts = extractJsonArray<any>(raw).map((x) => String(x || "").trim()).filter(Boolean);
  } catch { parts = []; }
  if (!parts.length) {
    // фолбек без LLM: детермінований зріз по абзацах ≤450 символів
    const paras = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let cur = "";
    for (const p of paras) {
      if ((cur ? cur + "\n\n" + p : p).length <= 450) cur = cur ? cur + "\n\n" + p : p;
      else { if (cur) parts.push(cur); cur = p.length <= 450 ? p : p.slice(0, 449); }
    }
    if (cur) parts.push(cur);
  }
  // страховка ліміту API (500) на кожній частині
  parts = parts.map((p) => (p.length <= 495 ? p : p.slice(0, 494).replace(/\s+\S*$/, "") + "…")).slice(0, 8);
  return parts.length ? parts : [content.slice(0, 495)];
}

// 🧵 Тейки: N коротких самостійних Threads-постів з живого палива (Банк ідей + щоденник + бренд).
// Threads = полігон тестування: дешеві мікропости → бенчмарки покажуть, що залетіло → у рілс/гілку.
// Створює source origin='takes' + run + чернетки з channels={threads:on}. Повертає кількість.
export async function generateThreadsTakes(workspaceId: string, count: number): Promise<number> {
  const n = Math.max(1, Math.min(7, Number(count) || 5));
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const [ideas, diary] = await Promise.all([
    q<{ text: string }>(`select text from idea_bank where workspace_id=$1 and status='new' order by created_at desc limit 10`, [workspaceId]),
    q<{ transcript: string }>(`select transcript from source where workspace_id=$1 and origin='diary' order by created_at desc limit 3`, [workspaceId]),
  ]);
  const fuel = [
    ideas.length ? "Ідеї з банку автора:\n" + ideas.map((i) => "- " + i.text).join("\n") : "",
    diary.length ? "Свіжі записи щоденника автора (живі історії - найцінніше паливо):\n" + diary.map((d) => (d.transcript || "").slice(0, 700)).join("\n---\n") : "",
  ].filter(Boolean).join("\n\n") || "Живого палива нема - бери теми зі стратегії і болей аудиторії бренду.";
  const system =
    "Ти автор Threads, який пише короткі живі тейки у голосі бренду." +
    (s.marketing_context ? `\nБренд і аудиторія: ${s.marketing_context}` : "") +
    (s.tone_of_voice ? `\nГолос бренду (суворо): ${s.tone_of_voice}` : "") + voicePassport(s) + brandDna(s) +
    `\n\nПравила тейків: кожен ≤280 символів; ОДНА самостійна думка; перший рядок чіпляє; розмовно, як думка вголос у курилці, не «пост із стрічки бренду»; міксуй типи - спостереження з життя/роботи, контр-теза до загальноприйнятого, пряме питання до аудиторії, факт із конкретною цифрою, чесне зізнання. Без хештегів, без емодзі-декору, без закликів лайкнути/підписатися.` +
    goalRule(s) + NO_DASH_RULE + HOOK_RULE + ANTI_AI_RULE +
    `\n\nЗгенеруй рівно ${n} різних тейків. Поверни ЛИШЕ валідний JSON-масив рядків: ["тейк 1",…]. Мова: ${lang}.`;
  const raw = await chat("openai/gpt-4o", system, fuel, { workspaceId, step: "threads_takes" });
  let takes: string[] = [];
  try { takes = extractJsonArray<any>(raw).map((x) => String(x || "").trim()).filter(Boolean).slice(0, n); } catch { takes = []; }
  takes = takes.map((t) => (t.length <= 495 ? t : t.slice(0, 494).replace(/\s+\S*$/, "") + "…"));
  if (!takes.length) throw new Error("Не вдалося згенерувати тейки (порожня відповідь моделі)");
  const src = await one<{ id: string }>(
    `insert into source(workspace_id, origin, title, transcript) values($1,'takes',$2,$3) returning id`,
    [workspaceId, "🧵 Тейки для Threads", takes.join("\n\n")]);
  const run = await one<{ id: string }>(`insert into pipeline_run(source_id) values($1) returning id`, [src!.id]);
  for (const t of takes)
    await q(`insert into post(run_id, stage, content, channels) values($1,'final',$2,$3::jsonb)`,
      [run!.id, t, JSON.stringify({ threads: { on: true } })]);
  return takes.length;
}

// ---- Lite-скелет плану: ДЕТЕРМІНОВАНО зі стратегії (рубрики × best_days × теми) ----
// Канало-незалежний, не залежить від крихкого LLM-плану → порожнім не буде, якщо є стратегія.
export async function buildLiteSkeleton(workspaceId: string, horizonDays: number, postsPerWeek = 4): Promise<{ day: number; rubric: string; theme: string; hook: string }[]> {
  const strat = await one<{ data: any }>(`select data from strategy where workspace_id=$1`, [workspaceId]);
  const data: any = strat?.data || {};
  const rubrics: { name: string; share?: number }[] = Array.isArray(data.rubrics) ? data.rubrics.filter((r: any) => r?.name) : [];
  if (!rubrics.length) throw new Error("Спершу згенеруй стратегію (розділ Стратегія) - зі стратегії будується скелет плану.");
  const DMAP: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  let bestDays: number[] = Array.isArray(data.best_days) ? data.best_days.map((d: string) => DMAP[String(d).toLowerCase().slice(0, 3)]).filter((x: any) => x != null) : [];
  if (!bestDays.length) bestDays = [1, 3, 5];
  // зважений «мішок» рубрик за share
  const bag: string[] = [];
  for (const r of rubrics) { const w = Math.max(1, Math.round((Number(r.share) || 25) / 10)); for (let k = 0; k < w; k++) bag.push(r.name); }
  // кількість слотів = «постів на тиждень» × кількість тижнів у горизонті
  const ppw = Math.max(1, Math.min(14, Math.round(postsPerWeek) || 4));
  const totalTarget = Math.max(1, Math.min(120, Math.round((horizonDays / 7) * ppw)));
  // Розкладка: слоти РІВНОМІРНО по всьому горизонту, БЕЗ дублювання дат (поки target ≤ днів).
  // best_days - лише «магніт»: якщо поруч (±2 дні) є вільний найкращий день, слот присувається туди.
  // Друге коло (target > днів) знову йде рівномірно - по 2-й пост на день. Так «30 днів × 10/тиж»
  // дає рівно 43 слоти, а не купку постів у ті самі 3 дні тижня.
  const isBest = (d: number) => bestDays.includes(new Date(Date.now() + d * 864e5).getUTCDay());
  const countByDay = new Map<number, number>();
  const days: number[] = [];
  for (let i = 0; i < totalTarget; i++) {
    const round = Math.floor(i / horizonDays); // 0 = перше коло: кожна дата максимум один раз
    const idxInRound = i % horizonDays;
    const perRound = Math.min(totalTarget - round * horizonDays, horizonDays);
    const ideal = Math.max(1, Math.min(horizonDays, Math.round(((idxInRound + 0.5) * horizonDays) / perRound)));
    const free = (d: number) => d >= 1 && d <= horizonDays && (countByDay.get(d) || 0) <= round;
    let pick = -1;
    for (const off of [0, 1, -1, 2, -2]) { const d = ideal + off; if (free(d) && isBest(d)) { pick = d; break; } }
    if (pick < 0) for (const off of [0, 1, -1, 2, -2, 3, -3]) { const d = ideal + off; if (free(d)) { pick = d; break; } }
    if (pick < 0) pick = ideal;
    countByDay.set(pick, (countByDay.get(pick) || 0) + 1);
    days.push(pick);
  }
  days.sort((a, b) => a - b);
  const slots: { day: number; rubric: string; theme: string; hook: string }[] = [];
  const s = await loadSettings(workspaceId);
  // Контент-мікс (курс-фреймворки 80/20 і 70/20/10):
  //  - ~20% слотів «Особисте» (interest stacking): інтереси автора поза нішею - точки дотику з аудиторією;
  //  - ~10% слотів «🧪 експеримент»: формат/тема, яких бренд ще не робив (без експериментів - плато).
  const interests = (s.brand_interests || "").trim();
  let bi = 0;
  for (const day of days) slots.push({ day, rubric: bag[bi++ % bag.length], theme: "", hook: "" });
  const isInterest = (i: number) => !!interests && slots.length >= 5 && i % 5 === 2;
  const isExperiment = (i: number) => slots.length >= 8 && i % 10 === 6 && !isInterest(i);
  slots.forEach((x, i) => { if (isInterest(i)) x.rubric = "Особисте"; });
  // теми: ОДИН дешевий виклик; фолбек - рубрика (щоб ніколи не порожньо)
  if (slots.length) {
    try {
      const lang = (s.output_language || "Українська").trim();
      const themes = Array.isArray(data.monthly_themes) ? data.monthly_themes.filter(Boolean).map(String) : [];
      const system = "Ти контент-стратег. Для кожного слота (рубрика задана) придумай коротку конкретну тему поста (до 12 слів) у ніші бренду." +
        (s.strategy_brief ? `\nБриф: ${s.strategy_brief.slice(0, 1500)}` : (s.marketing_context ? `\nНіша: ${s.marketing_context}` : "")) +
        (themes.length ? `\nОрієнтир тем: ${themes.slice(0, 10).join("; ")}` : "") +
        (interests ? `\nСлоти з позначкою [ОСОБИСТЕ] - НЕ про нішу, а «людські» теми з інтересів автора (${interests.slice(0, 300)}): особистий погляд, історія чи спостереження, що робить автора живою людиною.` : "") +
        "\nСлоти з позначкою [ЕКСПЕРИМЕНТ] - тема чи формат, яких бренд ще НЕ робив: незвичний кут, інший жанр подачі, сміливіша теза." +
        `\n\nПоверни ЛИШЕ валідний JSON-масив рівно з ${slots.length} рядків-тем, у тому ж порядку, що рубрики нижче. Мова: ${lang}.`;
      const user = slots.map((x, i) => `${i + 1}. [${x.rubric}]${isInterest(i) ? " [ОСОБИСТЕ]" : ""}${isExperiment(i) ? " [ЕКСПЕРИМЕНТ]" : ""}`).join("\n");
      const raw = await chat(env.cheapModel, system, user, { workspaceId, step: "plan_themes" });
      const arr = extractJsonArray<any>(raw).map((x: any) => String(x?.theme || x || "").trim());
      slots.forEach((x, i) => { x.theme = ((isExperiment(i) ? "🧪 " : "") + ((arr[i] || "").slice(0, 300) || `${x.rubric}: ідея дня`)).slice(0, 300); });
    } catch { slots.forEach((x, i) => { x.theme = x.theme || `${(isExperiment(i) ? "🧪 " : "")}${x.rubric}: ідея дня`; }); }
  }
  return slots;
}

// ---- V2 Крок 4: атомізація (Prompt 10) - 1 пілерний пост → варіанти під усі канали ----
export async function atomizePost(workspaceId: string, content: string, channels: string[]): Promise<{ atoms: string[]; matrix: any[] }> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const brief = (s.strategy_brief || "").trim();
  const chans = (channels || []).filter((c) => CHANNEL_PLAYBOOK[c]);
  const targets = chans.length ? chans.join(", ") : "telegram, instagram, threads, facebook";
  const system =
    "Ти стратег ре-використання контенту (create once, publish everywhere / COPE). " +
    (brief ? `\nСТРАТЕГІЧНИЙ БРИФ (тримай бренд):\n${brief}\n` : "") +
    "1) Витягни 12-30 «атомів» із пілерного матеріалу: статистика, цитати, кроки, історії, контр-думки, FAQ, помилки. " +
    "2) Зістав атоми з нативними форматами для кожного каналу зі своїм свіжим гачком (НЕ копіюй однаковий текст між каналами). " +
    `\n\nКанали: ${targets}.` +
    ' Поверни ЛИШЕ валідний JSON-обʼєкт: {"atoms":["…"],"matrix":[{"atom":"…","channel":"…","format":"…","hook":"нативний гачок","cta":"…","best":false}]}. ' +
    "Познач best:true для топ-варіантів на канал. " +
    `Мова всіх текстів: ${lang}.`;
  const raw = await chat("openai/gpt-4o", system, `Пілерний матеріал:\n---\n${(content || "").slice(0, 8000)}`, { workspaceId, step: "atomize" });
  const o: any = extractJsonObject(raw) || {};
  return { atoms: Array.isArray(o.atoms) ? o.atoms : [], matrix: Array.isArray(o.matrix) ? o.matrix : [] };
}

// ---- Стрічка матеріалів: витягнути ідеї з одного матеріалу (модалка «Ідеї з матеріалу») ----
// «Розвідник»: не тема, а ТЕЙК (кут + чорновий гачок). mode за походженням матеріалу:
// 'signal' (стороння новина/RSS - що бренд каже від себе), 'story' (власний кейс - кути подачі), default - універсальний.
export async function extractIdeasFromText(workspaceId: string, text: string, count = 6, rubricsFilter?: string[], mode?: "signal" | "story"): Promise<{ idea: string; angle: string; hook: string; rubric: string }[]> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const rubs = await q<{ name: string }>(`select name from rubric where workspace_id=$1 order by idx`, [workspaceId]);
  const picked = (rubricsFilter || []).map((r) => String(r).trim()).filter(Boolean);
  const rubList = (picked.length ? rubs.filter((r) => picked.includes(r.name)) : rubs).map((r) => r.name).join(", ");
  const lead = mode === "signal"
    ? "Це СТОРОННЯ новина/чужий матеріал («Сигнал»). Знайди, що бренд може сказати ВІД СЕБЕ з цього приводу: позиція, висновок, застосування для своєї аудиторії. Кожна ідея - ТЕЙК (власна думка), а не переказ. Еталон: «розповісти про нову модель ШІ» - шум; «нова модель вбиває відмовку „ШІ не вміє писати“ - ось що це означає для тих, хто досі не користується» - сигнал. ПЕРША ідея в списку = найшвидший виграш (що постити СЬОГОДНІ, поки гаряче)."
    : mode === "story"
    ? "Це ВЛАСНИЙ кейс/думка автора («Історія»). Розклади на кути за СІМОМА ТИПАМИ (бери лише ті, що РЕАЛЬНО є в матеріалі, не натягуй): «урок» (висновок напряму - найочевидніший, тому ніколи не єдиний), «контрхід» (частина історії, що сперечається із загальноприйнятим у ніші), «фреймворк» (повторювана система з того, що сталося), «доказ» (історія як пруф тези), «релейтбл» (людський вразливий момент, що будує зв'язок сильніше за інформацію), «шлях» (origin story: як автор до цього дійшов - найрелейтебельніший тип для холодної аудиторії, бо теперішній рівень автора не релейтбл, а шлях до нього - так), «провал» (реальна помилка + що вона коштувала + урок: вразливості довіряють більше, ніж перемогам; не соррі-сторі - обовʼязково з уроком, який читач забере собі). Контрхід і фреймворк - найцінніші, шукай їх першими. НЕ вигадуй подій і деталей, яких автор не називав."
    : "Знайди в матеріалі окремі контент-ідеї для соцмереж, кожна зі своїм кутом подачі. Перша ідея = найсильніша.";
  const system =
    "Ти контент-розвідник. Даєш ТЕЙК, а не тему. " + lead +
    (s.marketing_context ? `\nБренд і аудиторія: ${s.marketing_context}` : "") + brandDna(s) +
    goalRule(s) +
    (rubList ? `\nРубрики бренду: ${rubList}. Кожній ідеї признач НАЙБЛИЖЧУ рубрику з цього переліку.` : "") +
    `\n\nЗнайди до ${Math.max(1, Math.min(10, count))} ідей. Для кожної: idea - суть одним реченням; angle - кут 2-4 словами${mode === "story" ? " (почни з типу: урок/контрхід/фреймворк/доказ/релейтбл/шлях/провал)" : ""}; format - якнайкращий формат: "пост" | "карусель" | "рілс"; hook - чорновий перший рядок (з кульмінації, без кліше «СТОП/99% не знають»). Ранжуй за релевантністю цілі й аудиторії, не за гучністю. Поверни ЛИШЕ валідний JSON-масив: [{"idea":"…","angle":"…","format":"…","hook":"…","rubric":"назва рубрики"}]. Мова: ${lang}.`;
  const raw = await chat(env.cheapModel, system, `Матеріал:\n---\n${(text || "").slice(0, 20000)}`, { workspaceId, step: "ideas" });
  let out: { idea: string; angle: string; hook: string; rubric: string; format?: string }[] = [];
  try {
    out = extractJsonArray<any>(raw).map((x) => ({
      idea: String(x?.idea || x || "").trim(), angle: String(x?.angle || "").trim(),
      hook: String(x?.hook || "").trim(), rubric: String(x?.rubric || "").trim(),
      format: ["пост", "карусель", "рілс"].includes(String(x?.format || "")) ? String(x.format) : undefined,
    })).filter((x) => x.idea);
  } catch { out = []; }
  return out;
}

// ---- Хештеги для поста (кнопка «# Хештеги» у композері): 5-8 релевантних, у ніші бренду ----
export async function suggestHashtags(workspaceId: string, text: string): Promise<string[]> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const system =
    "Ти SMM-фахівець. Підбери 5-8 релевантних хештегів для цього поста: суміш нішевих і ширших, без пробілів усередині тега, без дублів, реально вживаних. " +
    (s.marketing_context ? `\nНіша бренду: ${s.marketing_context}` : "") +
    `\n\nПоверни ЛИШЕ валідний JSON-масив рядків, кожен починається з #. Мова тегів: ${lang}.`;
  const raw = await chat(env.cheapModel, system, `Пост:\n---\n${(text || "").slice(0, 4000)}`, { workspaceId, step: "hashtags" });
  let tags: string[] = [];
  try {
    tags = extractJsonArray<any>(raw).map((x) => String(x || "").trim())
      .map((t) => (t.startsWith("#") ? t : "#" + t)).map((t) => t.replace(/\s+/g, "")).filter((t) => t.length > 1);
  } catch { tags = []; }
  return [...new Set(tags)].slice(0, 8);
}

// ---- Оцінка цікавості матеріалів для аудиторії бренду (1-10, ОДИН виклик безкоштовного Gemini на батч) ----
const SCORE_MODEL = "google/gemini-2.5-flash"; // free tier; без GEMINI_API_KEY chat() сам піде через OpenRouter
export async function scoreMaterials(workspaceId: string, items: { id: string; title: string; excerpt: string }[]): Promise<number> {
  if (!items.length) return 0;
  const s = await loadSettings(workspaceId);
  const ctx = [s.marketing_context, s.audience, (s.strategy_brief || "").slice(0, 800)].filter(Boolean).join("\n").slice(0, 1500);
  const system = "Ти редактор контенту бренду. Оціни КОЖЕН матеріал за шкалою 1-10: наскільки тема цікава й резонансна САМЕ для нашої аудиторії (актуальність, близькість до ніші, потенціал обговорення й емоційного відгуку; 1-3 = офтоп/нудно, 8-10 = гаряча тема для поста)." +
    (ctx ? `\n\nБренд і аудиторія:\n${ctx}` : "") +
    `\n\nПоверни ЛИШЕ валідний JSON-масив рівно з ${items.length} обʼєктів у тому ж порядку: [{"i":1,"score":7,"why":"одне коротке речення чому"}] . Мова why: українська.`;
  const user = items.map((m, i) => `${i + 1}. ${m.title}\n${m.excerpt.slice(0, 250)}`).join("\n\n");
  const raw = await chat(SCORE_MODEL, system, user, { workspaceId, step: "score" });
  let arr: any[] = [];
  try { arr = extractJsonArray(raw); } catch { return 0; }
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const a = arr[i] || arr.find((x) => Number(x?.i) === i + 1);
    const score = Math.max(1, Math.min(10, Math.round(Number(a?.score)) || 0));
    if (!score) continue;
    await q(`update source set ai_score=$2, ai_score_why=$3 where id=$1`, [items[i].id, score, String(a?.why || "").slice(0, 300) || null]);
    n++;
  }
  return n;
}

// ---- Метчинг: які матеріали підходять під порожні слоти плану (дешевий один виклик) ----
export async function matchPlanSlots(workspaceId: string): Promise<number> {
  const slots = await q<{ id: string; theme: string; rubric: string }>(
    `select id, theme, coalesce(rubric,'') as rubric from plan_slot where workspace_id=$1 and status='empty' order by slot_date limit 20`, [workspaceId]);
  const mats = await q<{ id: string; title: string; transcript: string }>(
    `select id, coalesce(title,'') as title, left(transcript, 300) as transcript from source
     where workspace_id=$1 and archived=false and coalesce(transcript,'') <> '' order by created_at desc limit 30`, [workspaceId]);
  if (!slots.length || !mats.length) return 0;
  const system =
    "Зістав теми контент-плану з наявними матеріалами. Метч признач ЛИШЕ якщо матеріал реально розкриває тему слота (не за поверхневою схожістю слів). Один матеріал може підійти кільком слотам, слот отримує максимум один матеріал." +
    '\n\nПоверни ЛИШЕ валідний JSON-масив (порожній, якщо метчів нема): [{"slotId":"…","sourceId":"…"}].';
  const user =
    "СЛОТИ ПЛАНУ:\n" + slots.map((s) => `${s.id} | [${s.rubric}] ${s.theme}`).join("\n") +
    "\n\nМАТЕРІАЛИ:\n" + mats.map((m) => `${m.id} | ${m.title}: ${m.transcript.replace(/\n+/g, " ")}`).join("\n");
  const raw = await chat(env.cheapModel, system, user, { workspaceId, step: "plan_match" });
  let pairs: { slotId: string; sourceId: string }[] = [];
  try { pairs = extractJsonArray<any>(raw).map((x) => ({ slotId: String(x?.slotId || ""), sourceId: String(x?.sourceId || "") })); } catch { pairs = []; }
  const slotIds = new Set(slots.map((s) => s.id)); const matIds = new Map(mats.map((m) => [m.id, m.title]));
  let n = 0;
  for (const p of pairs) {
    if (!slotIds.has(p.slotId) || !matIds.has(p.sourceId)) continue;
    await q(`update plan_slot set status='matched', match_source_id=$2, match_note=$3 where id=$1 and status='empty'`,
      [p.slotId, p.sourceId, `метч: «${String(matIds.get(p.sourceId)).slice(0, 80)}»`]);
    n++;
  }
  return n;
}

// Перегенерація одного поста зі СПІЛЬНИМ контекстом (голос + де-AI + бриф) - для кнопки «Переробити».
// instruction - конкретна правка від користувача («зроби коротшим», «прибери смайли», «додай приклад»):
// виконується ПОВЕРХ повного контексту, тож правка не губить голос/стратегію.
export async function rewritePost(workspaceId: string, text: string, instruction?: string): Promise<string> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const instr = (instruction || "").trim();
  const brief = s.prompt_engine !== "legacy" ? (s.strategy_brief || "").trim() : "";
  const task = instr
    ? `Внеси в цей пост конкретну правку, яку просить користувач, зберігаючи решту тексту, зміст, голос бренду й живу людську мову (без ознак AI).\n\nПРАВКА ВІД КОРИСТУВАЧА: ${instr.slice(0, 600)}`
    : "Перепиши цей пост іншими словами, зберігаючи зміст і структуру, у голосі бренду й живою людською мовою (без ознак AI).";
  const system = task +
    (brief ? `\n\nСТРАТЕГІЧНИЙ БРИФ (тримай бренд): ${brief}` : "") +
    (s.tone_of_voice ? `\n\nГолос бренду: ${s.tone_of_voice}` : "") + voicePassport(s) + brandDna(s) +
    (s.deai_rules ? `\n\nПравила «без AI»: ${s.deai_rules}` : "") +
    goalRule(s) + ANTI_AI_RULE +
    NO_DASH_RULE + `\n\nПоверни лише текст поста. Мова: ${lang}.`;
  return chat("openai/gpt-4o", system, `---\n${text}`, { workspaceId, step: "regenerate" });
}

// ---- «Директор»: вердикт, чи веде чернетка до головної бізнес-цілі ----
export async function directorVerdict(workspaceId: string, content: string): Promise<{ verdict: string; reason: string; fix: string; sharper: string; trust: string; trustWhy: string }> {
  const s = await loadSettings(workspaceId);
  const goal = GOAL_LABELS[s.primary_goal || ""];
  if (!goal) throw new Error("Спершу вибери головну ціль контенту (розділ Стратегія → 🎯 Головна ціль)");
  const metric = (s.goal_metric || "").trim();
  const anti = (s.brand_antiassoc || "").trim();
  const system = `Ти суворий контент-директор. Головна бізнес-ціль бренду: ${goal}.${metric ? ` Метрика і строк: ${metric.slice(0, 160)}.` : ""}` +
    (s.marketing_context ? `\nНіша й аудиторія: ${s.marketing_context.slice(0, 400)}` : "") +
    (anti ? `\nЗАБОРОНЕНІ асоціації бренду: ${anti.slice(0, 300)}. Якщо пост зачіпає щось із цього (тема, приклад, порівняння, тон) - verdict "no" і назви, що саме.` : "") +
    "\nОціни чернетку ЧЕСНО: реально веде до цілі, частково, чи це «контент заради контенту». Скіл марний, якщо штампує «одобрено» на все. Ніколи не просто суди - автор має піти з дією." +
    "\nДруга вісь - ДОВІРА: пост ДАЄ читачу цінність (будує довіру) чи лише ПРОСИТЬ і продає (витрачає довіру)? Довіра - валюта, що передує транзакції: продажний пуш без цінності шкодить бренду, навіть коли формально веде до цілі." +
    '\nПоверни ЛИШЕ валідний JSON: {"verdict":"yes"|"partial"|"no","reason":"одне речення чому","fix":"конкретна правка одним реченням","sharper":"ГОСТРІША ВЕРСІЯ: перепиши перший абзац поста так, щоб та сама ідея тягла до цілі сильніше (2-3 речення, голос збережи)","trust":"builds"|"spends","trust_why":"одне речення: що пост дає читачу або чого просить, не давши"}. Мова: Українська.';
  const raw = await chat(env.cheapModel, system, `Чернетка:\n---\n${(content || "").slice(0, 4000)}`, { workspaceId, step: "director" });
  const o = extractJsonObject<any>(raw) || {};
  const verdict = ["yes", "partial", "no"].includes(o.verdict) ? o.verdict : "partial";
  // лічильник промахів за сьогодні (для дайджеста: «третя ідея повз ціль - що відводить?»)
  if (verdict === "no") {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const row = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='director_misses'`, [workspaceId]);
      let d: any = {}; try { d = JSON.parse(row?.content || "{}"); } catch { d = {}; }
      const count = (d.date === today ? Number(d.count) || 0 : 0) + 1;
      await q(`insert into settings_block(workspace_id,key,content) values($1,'director_misses',$2)
               on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`,
        [workspaceId, JSON.stringify({ date: today, count })]);
    } catch { /* лічильник не критичний */ }
  }
  return {
    verdict,
    reason: String(o.reason || "").slice(0, 300),
    fix: String(o.fix || "").slice(0, 300),
    sharper: String(o.sharper || "").slice(0, 600),
    trust: o.trust === "spends" ? "spends" : "builds",
    trustWhy: String(o.trust_why || "").slice(0, 300),
  };
}

// ---- «Антидетектор» 2.0: гібридний аудит AI-слідів ----
// Каталог портовано з humanizer-ru (52 патерни, MIT) на українську: детермінований сканер (код,
// 100% надійний) + LLM для тонких патернів (ритм, регістр, «фінгерпринти 2025-26»).
// До кожного детермінованого патерна - ЗАМІНА для точкової правки (HARD BAN → чим замінити).
const AI_TRACE_RX: [string, RegExp, string][] = [
  // — тире й пунктуаційний ритм —
  ["широке тире «—»", /—/, "заміни на « - », кому або крапку (тире максимум раз на 3-4 речення)"],
  ["середнє тире «–»", /–/, "заміни на « - », кому або крапку"],
  // — HARD BANS: фірмові формули ШІ —
  ["«не просто X, а Y»", /не просто[^.\n]{0,60}?,\s*а\s/i, "скажи прямо «Y», без протиставлення"],
  ["«не тільки X, а й Y»", /не (тільки|лише)[^.\n]{0,60}?,\s*(а й|але й)\s/i, "«X. І ще Y» або просто перелічи"],
  ["«це не про X, це про Y»", /це не про [^.\n]{0,40}?[.,]\s*це про /i, "скажи прямо, про що це"],
  ["«у сучасному світі»", /у сучасному світі/i, "видали, почни з факту або питання"],
  ["«не секрет, що»", /не секрет,? що/i, "видали преамбулу, почни з суті"],
  ["«варто зазначити»", /варто (зазначити|відзначити)/i, "скажи напряму, без преамбули"],
  ["«важливо розуміти»", /важливо (розуміти|памʼятати|зазначити)/i, "видали або «Тут ось що:»"],
  ["«давайте розберемось»", /давайте (розберемо|розглянемо)/i, "видали анонс, одразу роби"],
  ["«розглянемо детальніше»", /розглянемо (детальніше|докладніше)/i, "видали (читач і так бачить новий абзац)"],
  ["«як відомо»", /(?<![а-щьюяіїєґ])як відомо(?![а-щьюяіїєґ])/i, "видали або назви конкретне джерело"],
  ["фінальний підсумок «отже…»", /(?<![а-щьюяіїєґ])(отже|таким чином),?\s+(підсумуємо|памʼятай|головне|можна зробити висновок)/i, "видали формульний висновок або почни з дії"],
  ["«підводячи підсумок»", /підводячи підсумок/i, "видали або дай нову думку, а не переказ"],
  ["«сподіваюсь, було корисно»", /сподіва(юсь|ємось),? (було|стане) корисно/i, "видали артефакт чат-бота"],
  // — розмиті авторитети й роздування —
  ["«на думку експертів»", /(на думку експертів|експерти (кажуть|вважають)|дослідження показують)/i, "назви конкретне джерело або утверджуй від себе"],
  ["«грає ключову роль»", /(грає|відіграє) (важливу|ключову|велику) роль/i, "покажи ЧОМУ важливо, через факт чи цифру"],
  ["«неможливо переоцінити»", /неможливо переоцінити/i, "скинь пафос, дай конкретику"],
  // — маркетингові кліше-усилювачі —
  ["«розкрити потенціал»", /розкри(ти|ває) потенціал/i, "конкретний результат у цифрах"],
  ["«вийти на новий рівень»", /(вийти|вихід) на нов(ий|і) (рівень|рівні|горизонти)/i, "що конкретно зміниться - назви"],
  ["«відкриває нові горизонти»", /відкриває нові (горизонти|можливості)/i, "що конкретно стає можливим"],
  ["«інноваційне рішення»", /інноваційн(е|і|ий) (рішення|підхід|інструмент)/i, "що нового - по факту"],
  ["«комплексний підхід»", /комплексн(ий|е) (підхід|рішення)/i, "перелічи, що саме входить"],
  ["«ідеально підходить для»", /ідеально підходить (для|під)/i, "кому і навіщо - конкретно"],
  ["«змінює правила гри»", /змінює правила гри/i, "конкретний результат замість кліше"],
  // — канцелярит і кальки —
  ["слово-паразит «ключовий»", /(?<![а-щьюяіїєґ])ключов(ий|а|е|і|ого|ої)(?![а-щьюяіїєґ])/i, "прибери або заміни конкретним словом"],
  ["«наразі»/«даний»", /(?<![а-щьюяіїєґ])(наразі|дан(ий|а|е|ої|ого))(?![а-щьюяіїєґ])/i, "«зараз» / «цей»"],
  ["канцелярит «здійснювати/забезпечувати»", /(здійсню(є|вати|ють)|забезпечу(є|вати|ють)|реалізаці(я|ю)|впровадження)/i, "верни дієслово: «здійснили впровадження» = «впровадили»"],
  ["«в рамках»", /(?<![а-щьюяіїєґ])в рамках(?![а-щьюяіїєґ])/i, "«у», «під час», «всередині» - або перебудуй"],
  ["«з метою»", /(?<![а-щьюяіїєґ])з метою(?![а-щьюяіїєґ])/i, "«щоб»"],
  ["«відповідний/певний»", /(?<![а-щьюяіїєґ])(відповідн(ий|і|у)|певн(і|ий) (аспекти|моменти|кроки))(?![а-щьюяіїєґ])/i, "назви конкретно або прибери"],
  // — артефакти чат-бота —
  ["артефакт чат-бота", /(відмінне питання|чудове питання|радий допомогти|звісно[,!]\s)/i, "видали повністю"],
  ["псевдо-емпатія-вступ", /(я розумію, як це (непросто|складно)|знайома ситуація, правда)/i, "видали, переходь до суті"],
  // — кліше-гачки —
  ["кліше-гачок", /(СТОП[!.\s]|не гортай|зупинись|99\s?%|ти не повіриш|шок(уюч)?|алгоритм (ховає|приховує)|додивись до кінця)/i, "відкрий з кульмінації - найсильнішого факту чи цифри"],
  // — фінгерпринти 2025-26 —
  ["симетрична тріада-резюме", /(?<=[.!?]\s|^)[А-ЯІЇЄҐ][а-яіїєґ'’]+\.\s[А-ЯІЇЄҐ][а-яіїєґ'’]+\.\s[А-ЯІЇЄҐ][а-яіїєґ'’]+\.(?=\s|$)/m, "збери в нормальну фразу або залиш одне слово"],
  ["емодзі-декор (3+ поспіль)", /(\p{Extended_Pictographic}\s*){3,}/u, "залиш максимум один емодзі або прибери"],
  ["заголовок-обіцянка трансформації", /(зміни(ть)? (мислення|життя|підхід) за \d+|переверне тв(ій|оє))/i, "конкретика: що саме зміниться"],
];
// список для промта точкової правки: патерн → чим замінити
const HARD_BAN_HINTS = new Map(AI_TRACE_RX.map(([name, , fix]) => [name, fix]));
export function scanAiTraces(content: string): { pattern: string; quote: string }[] {
  const t = String(content || "");
  const out: { pattern: string; quote: string }[] = [];
  for (const [name, rx] of AI_TRACE_RX) {
    const m = t.match(rx);
    if (m && m.index != null) {
      const from = Math.max(0, m.index - 20);
      out.push({ pattern: name, quote: t.slice(from, m.index + m[0].length + 25).replace(/\n/g, " ").trim() });
    }
  }
  return out;
}
export async function aiAudit(workspaceId: string, content: string): Promise<{ pattern: string; quote: string }[]> {
  const hard = scanAiTraces(content); // детермінована частина - завжди спрацьовує
  let soft: { pattern: string; quote: string }[] = [];
  try {
    const system = "Ти редактор, що знаходить ТОНКІ сліди AI-тексту в українській (очевидні тире/кліше/канцелярит уже перевірені кодом - їх НЕ шукай). Принцип: ШІ вибирає статистично найтиповіше продовження; людський текст - навмисне відхилення. Шукай:" +
      "\n- рвана медитативність: короткі рубані псевдоінсайти поспіль («Точно. Окремо. Глибоко.»)" +
      "\n- псевдо-сократичні питання: сам спитав - сам відповів заради ритму («Навіщо? А ось навіщо.»)" +
      "\n- псевдо-терапевтичний регістр: тепла пустота коуч-бота («і це нормально», «ти не помиляєшся, що так відчуваєш»)" +
      "\n- рівномірна глибина: кожне речення претендує на інсайт, нема прохідних зв'язок" +
      "\n- симетричні парні речення-близнюки; три однорідні прикметники поспіль" +
      "\n- кардіограма ритму: всі речення однакової довжини, всі абзаци рівні (назви це одним знахідком)" +
      "\n- шаблонні переходи ланцюжком («крім того», «водночас», «більше того»)" +
      "\n- водянистість: порожні узагальнення без конкретики" +
      '\nЗнайди лише РЕАЛЬНІ входження (нічого не вигадуй; якщо чисто - порожній масив). Поверни ЛИШЕ валідний JSON-масив: [{"pattern":"назва","quote":"точна цитата до 60 симв"}]. Мова: Українська.';
    const raw = await chat(env.cheapModel, system, `Текст:\n---\n${(content || "").slice(0, 4000)}`, { workspaceId, step: "ai_audit" });
    soft = extractJsonArray<any>(raw)
      .map((x) => ({ pattern: String(x?.pattern || "").slice(0, 80), quote: String(x?.quote || "").slice(0, 80) }))
      .filter((x) => x.pattern);
  } catch { /* детермінованих знахідок достатньо */ }
  return [...hard, ...soft].slice(0, 20);
}

// «Антидетектор» 2.0, режим ТОЧКОВОЇ правки: замінює ЛИШЕ знайдені фрагменти, решта тексту не рухається
// (безпечно для вже вилизаних текстів). Quad-pass-цикл: правка → повторний скан → добивка (макс 2 проходи).
export async function deAiFix(workspaceId: string, content: string): Promise<{ content: string; findings: { pattern: string; quote: string }[]; remaining: { pattern: string; quote: string }[] }> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const findings = await aiAudit(workspaceId, content);
  if (!findings.length) return { content, findings: [], remaining: [] };
  let text = content;
  let toFix = findings;
  for (let pass = 0; pass < 2 && toFix.length; pass++) {
    const list = toFix.map((f, i) => `${i + 1}. [${f.pattern}] фрагмент: «${f.quote}»${HARD_BAN_HINTS.get(f.pattern) ? ` → ${HARD_BAN_HINTS.get(f.pattern)}` : ""}`).join("\n");
    const system = "Ти редактор точкових правок. У тексті знайдено сліди AI - виправ ЛИШЕ перелічені фрагменти (мінімальна заміна за підказкою після «→»), а РЕШТУ тексту відтвори ДОСЛІВНО, символ у символ: не перефразовуй, не скорочуй, не «покращуй» нічого поза списком. Заміна має природно вписатись у речення." +
      (s.tone_of_voice ? `\nГолос бренду (для замін): ${s.tone_of_voice.slice(0, 400)}` : "") +
      NO_DASH_RULE + `\n\nСПИСОК ПРАВОК:\n${list}\n\nПоверни ЛИШЕ повний виправлений текст. Мова: ${lang}.`;
    const fixed = (await chat("openai/gpt-4o", system, `---\n${text}`, { workspaceId, step: "deai_fix" })).trim();
    // страховка: якщо модель переписала все (довжина попливла) - лишаємо попередню версію
    if (fixed.length < text.length * 0.5 || fixed.length > text.length * 1.6) break;
    text = fixed;
    toFix = scanAiTraces(text); // другий прохід - лише детермінований скан (дешево і точно)
  }
  return { content: text, findings, remaining: scanAiTraces(text) };
}

// ---- «Хук-майстер» 2.0: кульмінація + 3 відкриття + м'який місток + список артефактів на видалення ----
export type HookResult = { culmination: string; hooks: string[]; soft: string; remove: string[] };
export async function suggestHooks(workspaceId: string, text: string): Promise<HookResult> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const system = "Ти майстер перших рядків. Хук - це не накручена інтрига, а найцікавіше, що є в матеріалі, сказане ПЕРШИМ. Зроби чотири речі:" +
    "\n1) culmination: назви КУЛЬМІНАЦІЮ - єдиний найсильніший факт/цифру/момент/висновок усього тексту (це ПРАВДА з матеріалу, нічого не вигадуй);" +
    "\n2) hooks: 3 РІЗНІ відкриття прямо з кульмінації (різкий факт/цифра; контр-теза; особистий момент) - кожне 1-2 короткі речення, органічно веде в наявний текст;" +
    "\n3) soft: м'який варіант-місток - лагідніша версія, якщо різке відкриття чуже голосу, але цікаве все одно попереду;" +
    "\n4) remove: хук-артефакти, ЗНАЙДЕНІ в поточному тексті, які треба видалити («СТОП, не гортай», «99% не знають», «алгоритм ховає», «додивись до кінця», накручена інтрига) - точними цитатами; якщо чисто, порожній масив." +
    (s.tone_of_voice ? `\nГолос бренду: ${s.tone_of_voice.slice(0, 600)}` : "") + voicePassport(s) +
    HOOK_RULE + NO_DASH_RULE +
    `\n\nПоверни ЛИШЕ валідний JSON: {"culmination":"…","hooks":["…","…","…"],"soft":"…","remove":["точна цитата",…]}. Мова: ${lang}.`;
  const raw = await chat("openai/gpt-4o", system, `Пост:\n---\n${(text || "").slice(0, 4000)}`, { workspaceId, step: "hooks" });
  try {
    const o = extractJsonObject<any>(raw);
    return {
      culmination: String(o?.culmination || "").slice(0, 300),
      hooks: (Array.isArray(o?.hooks) ? o.hooks : []).map((x: any) => String(x || "").trim()).filter(Boolean).slice(0, 3),
      soft: String(o?.soft || "").trim().slice(0, 400),
      remove: (Array.isArray(o?.remove) ? o.remove : []).map((x: any) => String(x || "").trim()).filter(Boolean).slice(0, 6),
    };
  } catch { return { culmination: "", hooks: [], soft: "", remove: [] }; }
}

// ---- «Архітектор» (принцип непересічення): заголовок на картинку, що ДОПОВНЮЄ текст, а не дублює його ----
export async function suggestHeadline(workspaceId: string, text: string): Promise<string> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const system = "Запропонуй короткий заголовок на зображення поста: 2-5 слів, ВЕЛИКИЙ сенс маленькими словами. ПРАВИЛО НЕПЕРЕСІЧЕННЯ: заголовок НЕ повторює перший рядок і жодну фразу поста - він додає другий кут (емоцію, наслідок, питання), щоб картинка і текст працювали в парі, а не дублювались. Без крапки в кінці, без лапок." +
    `\n\nПоверни ЛИШЕ сам заголовок одним рядком. Мова: ${lang}.`;
  const raw = await chat(env.cheapModel, system, `Пост:\n---\n${(text || "").slice(0, 2500)}`, { workspaceId, step: "headline" });
  return raw.replace(/^["«»']+|["«»'.]+$/g, "").trim().slice(0, 60);
}

// цільова довжина рілса → скільки бітів писати (біт ≈ 8-10с озвучки разом з паузою)
function reelLenRule(targetSec?: number): { label: string; bits: string } {
  const t = Number(targetSec) || 45;
  if (t <= 20) return { label: "до 15-20 секунд", bits: "РІВНО 2 БІТИ" };
  if (t <= 35) return { label: "до 30 секунд", bits: "РІВНО 3 БІТИ" };
  return { label: "45-60 секунд", bits: "4-5 БІТІВ" };
}

// ---- «Сценарист»: повний сценарій Reels/Shorts (текстовий деліверабл - юзер знімає сам) ----
export async function reelsScript(workspaceId: string, text: string, targetSec?: number): Promise<string> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const brief = (s.strategy_brief || "").trim();
  const len = reelLenRule(targetSec);
  const system = `Ти сценарист коротких відео (Reels/Shorts/TikTok). Цільова тривалість ролика: ${len.label} - НЕ перевищуй її. За матеріалом напиши ГОТОВИЙ ДО ЗЙОМКИ сценарій:` +
    "\n- ХУК (0-2с): відкриття з кульмінації, без кліше." +
    `\n- ${len.bits}: один біт = ОДНА думка = ОДИН короткий рядок озвучки + [візуал: що в кадрі/на екрані]. Потрібно два рядки - значить це два біти.` +
    "\nЕталон біта. Погано: «Розкажи, що брендбук допомагає нейромережі писати у твоєму стилі і це дуже важливо для бренду» (дві думки, довго, нічого знімати). Добре: «Секрет не в промті, а в брендбуку» [візуал: файл брендбука на екрані] (одна думка, один рядок, зрозумілий кадр)." +
    "\n- CTA: один заклик = одна дія." +
    "\n- ТЕКСТ НА ЕКРАН: 3-5 ключових слів/фраз, які виносимо великими титрами в кадр (акценти, не субтитри)." +
    "\nФормат виводу рівно такий:\n🎬 СЦЕНАРІЙ REELS: <назва 3-5 слів>\n\nХУК (0-2с): <рядок>\n[візуал: <що в кадрі>]\n\nБІТ 1: <рядок>\n[візуал: <…>]\n(і так далі)\n\nCTA: <рядок>\n[візуал: <…>]\n\nТЕКСТ НА ЕКРАН: <слова через ·>" +
    (brief ? `\n\nСТРАТЕГІЧНИЙ БРИФ: ${brief.slice(0, 1200)}` : (s.marketing_context ? `\n\nБренд і аудиторія: ${s.marketing_context}` : "")) +
    (s.tone_of_voice ? `\nГолос бренду: ${s.tone_of_voice.slice(0, 600)}` : "") + voicePassport(s) + brandDna(s) +
    goalRule(s) + HOOK_RULE + ANTI_AI_RULE + NO_DASH_RULE +
    `\n\nПоверни лише сценарій. Мова: ${lang}.`;
  return chat("openai/gpt-4o", system, `Матеріал:\n---\n${(text || "").slice(0, 12000)}`, { workspaceId, step: "reels" });
}

// ---- підпис до готового відео-рілса (для IG/FB/YouTube: не переказ сценарію, а чіпкий підпис) ----
export async function reelCaption(workspaceId: string, script: string): Promise<string> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const system = "Із сценарію короткого відео зроби ПІДПИС до опублікованого рілса: 1-2 чіпкі речення (інтрига чи головна користь, БЕЗ переказу всього ролика) + 3-5 релевантних хештегів останнім рядком." +
    voicePassport(s) + HOOK_RULE + ANTI_AI_RULE + NO_DASH_RULE +
    `\n\nПоверни лише підпис. Мова: ${lang}.`;
  const raw = await chat(env.cheapModel, system, (script || "").slice(0, 3000), { workspaceId, step: "reel_caption" });
  return raw.trim().slice(0, 1800);
}

// ---- «Що спрацювало»: розбір топ-постів за ×N → 1-2 повторювані патерни → готове правило голосу ----
// Принцип: вчимось ЛИШЕ на топ-контенті і беремо тільки те, що повторюється у ВСІХ хітах (решта - шум).
export async function topPatterns(workspaceId: string): Promise<{ patterns: { pattern: string; evidence: string }[]; rule: string; sample: number }> {
  const { networkBenchmarks } = await import("./metrics.js");
  const { posts } = await networkBenchmarks(workspaceId);
  const top = posts.filter((p) => p.mult >= 1.2).slice(0, 8);
  if (top.length < 3) throw new Error("Замало даних: потрібно щонайменше 3 пости з переглядами вище норми. Статистика збирається автоматично - зазирни за кілька днів.");
  const s = await loadSettings(workspaceId);
  const system = "Ти аналітик контенту. Нижче - ТОП-пости бренду за переглядами відносно ВЛАСНОЇ норми (×N до медіани мережі). " +
    "Знайди 1-2 патерни, що повторюються у ВСІХ або майже всіх цих постах: тип гачка, структура, тема, тон, довжина, формат подачі. " +
    "Те, що трапляється лише в одному пості - шум, ігноруй. Не хвали і не переказуй - тільки повторювані причини успіху." +
    (s.marketing_context ? `\nНіша бренду: ${s.marketing_context.slice(0, 300)}` : "") +
    '\n\nПоверни ЛИШЕ валідний JSON: {"patterns":[{"pattern":"патерн одним реченням","evidence":"як саме він проявляється в цих постах"}],"rule":"готова інструкція копірайтеру одним рядком (до 25 слів), щоб відтворювати цей патерн у майбутніх постах"}. Мова: Українська.';
  const user = top.map((p, i) => `${i + 1}. ×${p.mult} (${p.network}, ${p.views} переглядів):\n${p.content}`).join("\n\n---\n\n");
  const raw = await chat("openai/gpt-4o", system, user.slice(0, 14000), { workspaceId, step: "top_patterns" });
  const o = extractJsonObject<any>(raw) || {};
  const patterns = (Array.isArray(o.patterns) ? o.patterns : []).slice(0, 3).map((x: any) => ({
    pattern: String(x?.pattern || "").slice(0, 300), evidence: String(x?.evidence || "").slice(0, 400),
  })).filter((x: any) => x.pattern);
  if (!patterns.length) throw new Error("не вдалося виділити патерни - спробуй пізніше");
  return { patterns, rule: String(o.rule || "").slice(0, 200), sample: top.length };
}

// ---- «Мультиплікатор», режим «Продовження»: пост зайшов → 5 кутів розвитку теми ----
export async function suggestDevelopment(workspaceId: string, content: string): Promise<{ idea: string; angle: string }[]> {
  const s = await loadSettings(workspaceId);
  const system = "Цей пост «вистрілив» - аудиторії зайшло. Запропонуй 5 кутів РОЗВИТКУ теми (серія-продовження, кожен пост стоїть сам по собі): глибше в одну деталь; суміжне питання аудиторії; контр-теза до самого себе; живий кейс/приклад; практичний інструмент/чекліст." +
    (s.marketing_context ? `\nНіша й аудиторія: ${s.marketing_context.slice(0, 400)}` : "") +
    goalRule(s) +
    '\n\nПоверни ЛИШЕ валідний JSON-масив із 5: [{"idea":"тема одним реченням","angle":"кут 2-3 словами"}]. Мова: Українська.';
  const raw = await chat(env.cheapModel, system, `Пост:\n---\n${(content || "").slice(0, 4000)}`, { workspaceId, step: "develop" });
  try {
    return extractJsonArray<any>(raw)
      .map((x) => ({ idea: String(x?.idea || x || "").trim(), angle: String(x?.angle || "").trim() }))
      .filter((x) => x.idea).slice(0, 5);
  } catch { return []; }
}

// ---- «Магніт» 2.0: конкретні лід-магніти з ПРИВ'ЯЗКОЮ до реальних постів + промо-хук + швидкий виграш ----
export type Magnet = { title: string; what: string; attach: string; promo: string; leadgen: string; effort: string; keyword: string; quick?: boolean };
export async function suggestLeadMagnets(workspaceId: string, topic?: string): Promise<Magnet[]> {
  const s = await loadSettings(workspaceId);
  const brief = (s.strategy_brief || "").trim();
  // контент-бібліотека юзера: магніт має рости з ГОТОВОГО досвіду (перепакування - найдешевший хід)
  const posts = await q<{ content: string }>(
    `select p.content from post p join pipeline_run r on r.id=p.run_id join source src on src.id=r.source_id
     where src.workspace_id=$1 and p.stage='final' order by p.created_at desc limit 8`, [workspaceId]);
  const library = posts.map((p, i) => `${i + 1}. ${(p.content || "").split("\n")[0].slice(0, 110)}`).join("\n");
  const system = "Ти продюсер лід-магнітів. Запропонуй 3 КОНКРЕТНІ лід-магніти - не «зроби PDF», а що саме всередині і чому аудиторія захоче це забрати. Еталон: не «чекліст», а «12-пунктовий чекліст, який я проганяю перед кожним постом». Для кожного:" +
    "\n- title: назва як її побачить аудиторія;\n- what: що всередині (1-2 речення) + формат (чекліст/шаблон/свайп-файл/міні-гайд/таблиця);" +
    "\n- attach: з якого ГОТОВОГО поста/досвіду автора це росте (перепакування готового - найцінніший хід; якщо ні з чого - порожньо);" +
    "\n- promo: промо-хук - як тизерити магніт у контенті (1 речення);" +
    "\n- leadgen: сила збору лідів (низька|середня|висока);\n- effort: витрати на збірку (низькі|середні|високі; «зібрати за вечір» = низькі);" +
    "\n- keyword: коротке КОДОВЕ СЛОВО ВЕЛИКИМИ літерами для коментаря/дірект;" +
    "\n- quick: true РІВНО В ОДНОГО - швидкий виграш, найкраще співвідношення лідоген/зусилля (що зібрати першим, за один вечір)." +
    (topic ? `\n\nМагніти мають бути САМЕ під цю тему/пост: ${topic.slice(0, 800)}` : "") +
    (library ? `\n\nОстанні пости автора (прив'язуй attach до них, де можливо):\n${library}` : "") +
    (brief ? `\n\nСТРАТЕГІЧНИЙ БРИФ: ${brief.slice(0, 1200)}` : (s.marketing_context ? `\n\nНіша й аудиторія: ${s.marketing_context}` : "")) +
    goalRule(s) +
    '\n\nПоверни ЛИШЕ валідний JSON-масив: [{"title":"…","what":"…","attach":"…","promo":"…","leadgen":"…","effort":"…","keyword":"…","quick":false}]. Мова: Українська.';
  const raw = await chat("openai/gpt-4o", system, topic ? "Магніти під тему вище." : "Запропонуй 3 лід-магніти.", { workspaceId, step: "lead_magnets" });
  let out: Magnet[] = [];
  try {
    out = extractJsonArray<any>(raw).map((x) => ({
      title: String(x?.title || "").slice(0, 120), what: String(x?.what || "").slice(0, 400),
      attach: String(x?.attach || "").slice(0, 200), promo: String(x?.promo || "").slice(0, 200),
      leadgen: String(x?.leadgen || "").slice(0, 20), effort: String(x?.effort || "").slice(0, 20),
      keyword: String(x?.keyword || "").toUpperCase().replace(/[^A-ZА-ЯІЇЄҐ0-9]/g, "").slice(0, 20),
      quick: x?.quick === true,
    })).filter((x) => x.title).slice(0, 3);
  } catch { out = []; }
  if (out.length && !out.some((m) => m.quick)) out[0].quick = true; // швидкий виграш завжди позначений
  if (out.length && !topic) await q(`insert into settings_block(workspace_id, key, content) values($1,'lead_magnets',$2)
    on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`, [workspaceId, JSON.stringify(out)]);
  return out;
}

// «Магніт», крок 2: ЗІБРАТИ сам магніт - готовий текст чекліста/гайда як чернетка (від поради до продукту один клік)
export async function buildLeadMagnet(workspaceId: string, magnet: { title: string; what: string; keyword?: string }): Promise<string> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const brief = (s.strategy_brief || "").trim();
  const system = "Ти автор практичних матеріалів. Напиши ПОВНИЙ ГОТОВИЙ лід-магніт (не план і не опис - сам продукт): конкретні пункти, кроки чи шаблони, кожен пункт - дія або перевірка, без води і загальних порад. Обсяг 1500-3500 символів. Структура: назва → 1-2 речення для кого і що дасть → сам матеріал (нумеровані пункти/розділи) → короткий фінальний крок." +
    (brief ? `\n\nСТРАТЕГІЧНИЙ БРИФ: ${brief.slice(0, 1000)}` : (s.marketing_context ? `\n\nНіша й аудиторія: ${s.marketing_context}` : "")) +
    (s.tone_of_voice ? `\nГолос бренду: ${s.tone_of_voice.slice(0, 500)}` : "") + voicePassport(s) +
    NO_DASH_RULE + ANTI_AI_RULE +
    `\n\nПоверни лише текст магніта, першим рядком: 🧲 <назва>. Мова: ${lang}.`;
  return chat("openai/gpt-4o", system, `Лід-магніт: «${magnet.title}»\nЩо всередині: ${magnet.what}`, { workspaceId, step: "lead_magnet_build" });
}

// ---- «Мультиплікатор», режим «Нарізка»: довгий транскрипт → 5-7 самостійних сценаріїв Reels + порядок на тиждень ----
export async function sliceToReels(workspaceId: string, text: string, targetSec?: number): Promise<string[]> {
  const s = await loadSettings(workspaceId);
  const lang = (s.output_language || "Українська").trim();
  const len = reelLenRule(targetSec);
  const system = `Ти мультиплікатор контенту. З довгого матеріалу зроби 5-7 КОРОТКИХ сценаріїв Reels (кожен ${len.label}). Правила:` +
    "\n- кожен ролик СТОЇТЬ САМ ПО СОБІ - працює без перегляду довгого; слабкі моменти ріж, якість важливіша за кількість;" +
    "\n- відкриття КОЖНОГО - з кульмінації саме цього моменту;" +
    `\n- один біт = одна думка = один рядок озвучки + [візуал: …]; ${len.bits} максимум; CTA наприкінці;` +
    "\n- впорядкуй як ПОСЛІДОВНІСТЬ НА ТИЖДЕНЬ: перший - найсильніший самостійний, далі так, щоб ролики підсилювали одне одного." +
    "\nФормат КОЖНОГО сценарію рівно такий (розділяй сценарії рядком ===):" +
    "\n🎬 СЦЕНАРІЙ REELS: <назва 3-5 слів> (день N)\nЧому сам по собі: <1 речення>\n\nХУК (0-2с): <рядок>\n[візуал: <…>]\n\nБІТ 1: <рядок>\n[візуал: <…>]\n(…)\n\nCTA: <рядок>\n[візуал: <…>]\n\nТЕКСТ НА ЕКРАН: <слова через ·>" +
    (s.marketing_context ? `\n\nБренд і аудиторія: ${s.marketing_context}` : "") +
    (s.tone_of_voice ? `\nГолос бренду: ${s.tone_of_voice.slice(0, 500)}` : "") + voicePassport(s) + brandDna(s) +
    goalRule(s) + HOOK_RULE + ANTI_AI_RULE + NO_DASH_RULE +
    `\n\nПоверни лише сценарії, розділені рядком ===. Мова: ${lang}.`;
  const raw = await chat("openai/gpt-4o", system, `Матеріал:\n---\n${(text || "").slice(0, 24000)}`, { workspaceId, step: "reel_slices" });
  return raw.split(/\n=+\n/).map((x) => x.trim()).filter((x) => x.includes("🎬")).slice(0, 7);
}

// ---- «Розвідник», режим «Питання»: після публікації - що аудиторія мовчки питає далі → Банк ідей ----
export async function publishQuestions(workspaceId: string, postContent: string): Promise<number> {
  const cnt = await one<{ n: number }>(`select count(*)::int n from idea_bank where workspace_id=$1 and status='new'`, [workspaceId]);
  if ((cnt?.n || 0) >= 40) return 0; // банк і так повний - не роздуваємо
  const s = await loadSettings(workspaceId);
  const system = "Пост уже опубліковано. Сформулюй 3 питання, які лишились у голові читача ПІСЛЯ цього поста (те, що аудиторія мовчки хоче спитати далі). Кожне питання - готова тема наступного поста." +
    (s.marketing_context ? `\nНіша: ${s.marketing_context.slice(0, 400)}` : "") +
    '\n\nПоверни ЛИШЕ валідний JSON-масив: ["питання 1","питання 2","питання 3"]. Мова: Українська.';
  const raw = await chat(env.cheapModel, system, `Опублікований пост:\n---\n${(postContent || "").slice(0, 3000)}`, { workspaceId, step: "post_questions" });
  let qs: string[] = [];
  try { qs = extractJsonArray<any>(raw).map((x) => String(x?.question || x || "").trim()).filter(Boolean).slice(0, 3); } catch { return 0; }
  for (const t of qs) await q(`insert into idea_bank(workspace_id, text, angle, origin) values($1,$2,'продовження',$3)`, [workspaceId, t.slice(0, 500), "ai"]);
  return qs.length;
}

// ---- Щоденний інсайт: пул на ~30 (1 виклик), тягнемо по одному (settings_block 'insight_pool') ----
async function generateInsightPool(workspaceId: string): Promise<string[]> {
  const s = await loadSettings(workspaceId);
  // Інсайт - особисте повідомлення ВЛАСНИКУ (не контент для аудиторії), тож завжди українською (мова застосунку),
  // а не output_language бренду - інакше в DM чеський/англ. інсайт поряд з укр. каркасом виглядає зламано.
  const lang = "Українська";
  const niche = s.marketing_context ? `\nНіша бренду (для релевантності): ${s.marketing_context.slice(0, 500)}` : "";
  const system = "Ти контент-ментор. Згенеруй 30 коротких (до 12 слів) щоденних інсайтів про контент, SMM, дисципліну ведення соцмереж і залучення аудиторії - таких, що дають поштовх діяти. " +
    "Різні, конкретні, без води й без кліше." + niche +
    `\n\nПоверни ЛИШЕ валідний JSON-масив рядків (30 шт). Мова: ${lang}.`;
  try {
    const raw = await chat(env.cheapModel, system, "Згенеруй масив із 30 інсайтів.", { workspaceId, step: "insights" });
    const arr = extractJsonArray<any>(raw).map((x: any) => (typeof x === "string" ? x : String(x?.insight || x?.text || ""))).map((x: string) => x.trim()).filter(Boolean);
    return arr.length ? arr : ["Контент, який ти не опублікував, не працює."];
  } catch { return ["Контент дає результат лише коли виходить регулярно."]; }
}
// Наступний інсайт із пулу; коли пул вичерпано - генерує нову пачку (=> ~1-2 виклики/місяць).
export async function nextInsight(workspaceId: string): Promise<string> {
  // ключ _v2: скидає старий кеш (де інсайти могли бути мовою бренду) - перша генерація буде вже українською
  const block = await one<{ content: string }>(`select content from settings_block where workspace_id=$1 and key='insight_pool_v2'`, [workspaceId]);
  let pool: { items: string[]; cursor: number } = { items: [], cursor: 0 };
  try { if (block?.content) pool = JSON.parse(block.content); } catch { /* перегенеруємо */ }
  if (!Array.isArray(pool.items) || pool.cursor >= pool.items.length) pool = { items: await generateInsightPool(workspaceId), cursor: 0 };
  const insight = pool.items[pool.cursor] || "Контент, який ти не опублікував, не працює.";
  pool.cursor++;
  await q(`insert into settings_block(workspace_id, key, content) values($1,'insight_pool_v2',$2)
           on conflict (workspace_id,key) do update set content=excluded.content, updated_at=now()`, [workspaceId, JSON.stringify(pool)]);
  return insight;
}
