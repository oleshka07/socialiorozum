// 🩺 ПЕРЕВІРКА КОНТЕКСТУ: що саме людина поклала в промт і чи не суперечить воно саме собі.
//
// Навіщо. Сервіс збирає промт із десятка полів, які юзер заповнює в різний час і з різним настроєм.
// Нічого не заважає накидати «приклади голосу» зі старих прес-релізів, згенерувати бриф із кліше й
// лишити незаповнені плейсхолдери - а потім не розуміти, чому пости слабкі. Запобіжника від цього не
// було ЗОВСІМ: порожнє чи суперечливе поле мовчки їхало в модель.
//
// Головний принцип, з якого ростуть перевірки: **приклади сильніші за правила**. Модель імітує те, що
// їй показали, охочіше, ніж виконує те, що їй наказали. Тому найтяжчі знахідки тут - не «поле порожнє»,
// а «твої приклади суперечать твоїм же правилам».
//
// Два шари свідомо:
//  1) ДЕТЕРМІНОВАНИЙ - без моделі, миттєвий і завжди правдивий (плейсхолдери, порушення власного
//     стоп-листа, AI-сліди у зразках). Його можна ганяти хоч на кожному відкритті кабінету.
//  2) LLM - шукає СЕМАНТИЧНІ конфлікти між блоками, яких regex не побачить («бриф обіцяє вебінар,
//     а ДНК бренду забороняє інфобіз»). Дорожчий, тому лише на вимогу.
import { q, one } from "./db.js";
import { chat, extractJsonObject } from "./openrouter.js";
import { env } from "./env.js";
import { buildLitePrompt, scanAiTraces, stripPlaceholders } from "./pipeline.js";

export type Finding = {
  severity: "critical" | "warn" | "info";
  field: string;      // людська назва місця в кабінеті
  title: string;      // що не так
  why: string;        // чому це псує пости
  fix: string;        // що зробити
  key?: string;       // ключ settings_block - щоб UI відкрив ПОТРІБНЕ поле, а не «десь у Бренді»
  // 'ai'     - переписати за людину можна й доречно (це наш же автогенерований текст);
  // 'manual' - редагує ЛИШЕ людина. Тут авто-правка зашкодила б: приклади голосу, переписані AI,
  //            перестають бути прикладами ГОЛОСУ, а вигаданий «доказ» - це рівно те, від чого
  //            ми щойно ставили запобіжник.
  mode?: "ai" | "manual";
  quotes?: string[];  // проблемні фрагменти, щоб підсвітити їх у полі
};

const SEV_ORDER = { critical: 0, warn: 1, info: 2 } as const;
const has = (v?: string) => !!String(v || "").trim();
const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ");

// слова стоп-листа / анти-асоціацій, які реально зустрічаються в тексті (а не просто підрядком:
// «ти» не має ловитись у «типово»)
function hits(list: string, text: string): string[] {
  const t = " " + norm(text) + " ";
  return String(list || "")
    .split(/[,;\n]+/).map((x) => norm(x).trim()).filter((x) => x.length > 2)
    .filter((w) => t.includes(" " + w + " ") || t.includes(" " + w))
    .slice(0, 6);
}

// ---------------------------------------------------------------- шар 1: без моделі
// Чиста функція - під юнітами. Саме тут ловиться те, що коштує найдорожче й найлегше проґавити.
export function deterministicFindings(s: Record<string, string>, rubricShareSum = 100): Finding[] {
  const out: Finding[] = [];
  const examples = String(s.voice_examples || "").trim();
  const brief = String(s.strategy_brief || "").trim();
  const pains = String(s.pain_points || "").trim();

  // 1. Приклади голосу - найсильніший важіль у промті. Порожні = модель бере гачки з ЗАГАЛЬНОГО меню,
  //    однакового для всіх брендів; звідси й скарга «пости в усіх однакові».
  if (!examples) {
    out.push({ severity: "critical", field: "Бренд → Голос → Приклади постів",
      title: "Немає прикладів твого голосу",
      why: "Це найсильніший блок промту. Без нього модель складає гачки із загального меню типів - того самого для будь-якого бренду, тож тексти виходять «правильні, але нічиї».",
      fix: "Встав 3-5 своїх постів, які тобі САМОМУ подобаються. Якщо таких ще нема - напиши два вручну, це дасть більше, ніж усі інші правки разом.",
      key: "voice_examples", mode: "manual" });
  } else {
    // 2. Приклади з AI-слідами - пряма самосуперечність: правила забороняють, а зразок демонструє.
    const traces = scanAiTraces(examples);
    if (traces.length) {
      out.push({ severity: "critical", field: "Бренд → Голос → Приклади постів",
        title: `У прикладах голосу ${traces.length} ознак(и) машинного тексту`,
        why: "Промт наказує «відтворюй ритм і лексику САМЕ як тут», а моделі імітують приклади охочіше, ніж виконують правила. Тобто ти забороняєш кліше словами й показуєш його ж зразком - у конфлікті перемагає зразок.",
        fix: `Прибери з прикладів: ${traces.map((t) => t.pattern).slice(0, 4).join(", ")}. Або заміни ці пости на інші - живіші.`,
        key: "voice_examples", mode: "manual", quotes: traces.map((t) => t.quote).slice(0, 8) });
    }
    // 3. Приклади порушують ВЛАСНИЙ стоп-лист - те саме, але ще очевидніше.
    const stop = hits(s.voice_stoplist || "", examples);
    if (stop.length) {
      out.push({ severity: "critical", field: "Бренд → Голос → Стоп-лист",
        title: "Приклади голосу містять слова з твого ж стоп-листа",
        why: "Стоп-лист каже «ніколи не вживай», приклад показує «ось так пиши». Модель бачить обидва й обирає приклад.",
        fix: `Знайди в прикладах і прибери: ${stop.join(", ")}. Або прибери ці слова зі стоп-листа, якщо вони насправді твої.`,
        key: "voice_examples", mode: "manual", quotes: stop });
    }
    if (examples.length < 400) {
      out.push({ severity: "warn", field: "Бренд → Голос → Приклади постів",
        title: "Прикладів замало, щоб вивести ритм",
        why: "З одного короткого уривка модель не бачить ані довжини абзаців, ані манери відкривати пост.",
        fix: "Додай ще 2-3 повні пости (усього хоча б 1500 символів).", key: "voice_examples", mode: "manual" });
    }
  }

  // 4. Бриф позначений у промті як «джерело правди», тож кліше звідти має найбільшу вагу.
  if (brief) {
    const bt = scanAiTraces(brief);
    if (bt.length) {
      out.push({ severity: "warn", field: "Бренд → Бриф і цілі → Стратегічний бриф",
        title: "Стратегічний бриф написаний штампами",
        why: "У промті він помічений як «джерело правди - не суперечити», тобто його формулювання мають найбільшу вагу. Штамп звідти протікає в кожен пост.",
        fix: `Перепиши бриф своєю мовою (або прибери його зовсім - болі й офер важать більше). Знайдено: ${bt.map((t) => t.pattern).slice(0, 3).join(", ")}.`,
        key: "strategy_brief", mode: "ai", quotes: bt.map((t) => t.quote).slice(0, 8) });
    }
    const anti = hits(s.brand_antiassoc || "", brief);
    if (anti.length) {
      out.push({ severity: "critical", field: "Бренд → Бриф ↔ ДНК бренду",
        title: "Бриф обіцяє те, що ДНК бренду забороняє",
        why: "Два блоки промту наказують протилежне, і модель щоразу обирає навмання - звідси нестабільна якість від поста до поста.",
        fix: `Прибери з брифу або з анти-асоціацій: ${anti.join(", ")}.`, key: "strategy_brief", mode: "ai", quotes: anti });
    }
  } else {
    out.push({ severity: "info", field: "Бренд → Бриф і цілі",
      title: "Стратегічного брифу немає",
      why: "Не критично: болі клієнта й позиціонування важать більше. Але без брифу модель не знає пілерів і стадій воронки.",
      fix: "Натисни «Згенерувати» у Брифі - і обовʼязково перечитай результат своєю мовою.", key: "strategy_brief", mode: "ai" });
  }

  // 5. Незаповнені плейсхолдери. З промту вони тепер вирізаються, але сам факт означає, що доказу
  //    в бренду нема - і пости про нього мовчатимуть.
  if (pains && stripPlaceholders(pains) !== pains) {
    out.push({ severity: "warn", field: "Бренд → Бриф і цілі → Болі клієнта",
      title: "У болях лишились незаповнені «[доказ?]»",
      why: "Ми вирізаємо їх перед відправкою в модель, щоб вона не вигадала цифру. Але поки доказу нема, пости не зможуть спертись на факт - а саме факт закриває скепсис читача.",
      fix: "Заміни кожен [доказ?] на реальну цифру, кейс чи приклад. Немає доказу - краще прибери цей біль зі списку.",
      key: "pain_points", mode: "manual", quotes: ["[доказ?]"] });
  }
  if (!pains) {
    out.push({ severity: "warn", field: "Бренд → Бриф і цілі → Болі клієнта",
      title: "Болі клієнта не заповнені",
      why: "Без них пост не має за що зачепитись і відкривається темою «про нішу» замість проблеми читача.",
      fix: "Натисни «✨ Підказати» і відредагуй під себе - це чорновик, не готовий список.", key: "pain_points", mode: "ai" });
  }

  // 6. Історія бренду - ЄДИНЕ дозволене джерело особистих фактів. Порожня = або сухо, або вигадка.
  if (!has(s.brand_story)) {
    out.push({ severity: "warn", field: "Бренд → Голос → 🧬 ДНК бренду → Історія",
      title: "Історії бренду немає",
      why: "Промт дозволяє брати особисті факти ТІЛЬКИ звідси. Порожньо - і пости лишаються без живих деталей, заради яких їх і читають.",
      fix: "Опиши 5-10 рядками: з чого почалось, у що віриш, які були переломні моменти й провали.", key: "brand_story", mode: "manual" });
  }

  // 7. Голос описаний, але нічим не підкріплений (чи навпаки).
  if (has(s.tone_of_voice) && !examples) {
    out.push({ severity: "info", field: "Бренд → Голос",
      title: "Голос описаний словами, але не показаний прикладом",
      why: "Опис задає напрям, приклад задає звучання. Друге працює сильніше.",
      fix: "Додай кілька своїх постів у «Приклади».", key: "voice_examples", mode: "manual" });
  }

  // 8. Рубрики: частки мають сенс лише в наборі. Це не помилка, а очікування, яке не справдиться.
  if (rubricShareSum && Math.abs(rubricShareSum - 100) > 5) {
    out.push({ severity: "info", field: "Бренд → Бриф і цілі → Рубрики",
      title: `Частки рубрик у сумі дають ${rubricShareSum}%`,
      why: "Пропорція застосовується лише коли генеруєш кілька постів чи будуєш план. На одному пості вона ні на що не впливає.",
      fix: "Приведи суму до 100%, щоб план розкладався передбачувано." });
  }

  return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

// ---------------------------------------------------------------- шар 2: семантика (модель)
// Шукає те, чого regex не побачить: конфлікти МІЖ блоками. Просимо називати конфлікт, казати, хто в
// ньому переможе, і давати конкретну правку - інакше вийде безадресне «зробіть краще».
// LLM називає місце словами - зводимо його до ключа поля, щоб кнопка «Виправити» вела в конкретне
// поле, а не «кудись у Бренд». Не вгадали - знахідка лишається без кнопки, це чесніше за навмання.
function guessKey(t: string): { key?: string; mode?: "ai" | "manual" } {
  const x = t.toLowerCase();
  if (/voice_example|приклад/.test(x)) return { key: "voice_examples", mode: "manual" };
  if (/strategy_brief|бриф/.test(x)) return { key: "strategy_brief", mode: "ai" };
  if (/pain|бол/.test(x)) return { key: "pain_points", mode: "ai" };
  if (/stoplist|стоп-лист/.test(x)) return { key: "voice_stoplist", mode: "manual" };
  if (/brand_story|історі/.test(x)) return { key: "brand_story", mode: "manual" };
  if (/tone_of_voice|голос бренду|тон/.test(x)) return { key: "tone_of_voice", mode: "ai" };
  if (/antiassoc|анти-асоц|днк/.test(x)) return { key: "brand_antiassoc", mode: "manual" };
  return {};
}

async function llmFindings(ws: string, system: string): Promise<Finding[]> {
  const prompt =
    "Ти прискіпливий редактор промтів. Нижче - системний промт для генерації постів, зібраний із полів, які заповнював власник бренду. " +
    "Знайди ВНУТРІШНІ СУПЕРЕЧНОСТІ між його блоками: місця, де одна частина наказує одне, а інша - протилежне. " +
    "Пріоритет: приклади голосу, що суперечать описаним правилам (модель імітує приклади сильніше, ніж виконує правила); " +
    "блоки, помічені як джерело правди, але написані штампами; правила, які неможливо виконати одночасно; обіцянки того, чого в бренду нема. " +
    "НЕ вигадуй проблем: якщо блок просто порожній - це не суперечність. Не переказуй промт. Максимум 5 знахідок, найважливіші перші.\n" +
    'Поверни ЛИШЕ JSON: {"findings":[{"severity":"critical|warn|info","field":"де це в промті","title":"суть у 6-10 слів","why":"чому це псує пости, 1-2 речення","fix":"конкретна дія"}]}';
  try {
    const raw = await chat(env.cheapModel, prompt, system.slice(0, 14000), { workspaceId: ws, step: "context_check", json: true, maxTokens: 1800 });
    const j = extractJsonObject<any>(raw);
    return (j?.findings || []).slice(0, 5).map((f: any) => ({
      severity: ["critical", "warn", "info"].includes(String(f?.severity)) ? f.severity : "warn",
      field: String(f?.field || "промт").slice(0, 120),
      title: String(f?.title || "").slice(0, 160),
      why: String(f?.why || "").slice(0, 400),
      fix: String(f?.fix || "").slice(0, 300),
    })).map((f: Finding) => ({ ...f, ...guessKey(f.field + " " + f.title) })).filter((f: Finding) => f.title);
  } catch { return []; }   // семантичний шар не критичний: детермінований уже дав користь
}

export async function contextReview(ws: string, deep = true): Promise<{ score: number; promptChars: number; findings: Finding[] }> {
  const rows = await q<{ key: string; content: string }>(`select key, content from settings_block where workspace_id=$1`, [ws]);
  const s: Record<string, string> = {}; for (const r of rows) s[r.key] = r.content || "";
  const rub = await one<{ sum: string }>(`select coalesce(sum(share),0)::text as sum from rubric where workspace_id=$1`, [ws]);

  const findings = deterministicFindings(s, Number(rub?.sum || 0));
  let promptChars = 0;
  if (deep) {
    try {
      const { system } = await buildLitePrompt(ws, 3);
      promptChars = system.length;
      findings.push(...await llmFindings(ws, system));
      // чим більше конкуруючих правил, тим більше модель тихо кидає частину - це не гіпотеза, а
      // причина, з якої ми взагалі прибирали дублі правил із промту
      if (system.length > 14000) {
        findings.push({ severity: "warn", field: "Промт цілком",
          title: `Промт роздувся до ${Math.round(system.length / 1000)} тис. символів`,
          why: "Що більше одночасних вимог, то більше з них модель мовчки ігнорує - і першими летять найдовші, тобто твої власні правила голосу.",
          fix: "Скороти найдовші поля: стоп-лист, бриф, болі. Лишай те, що справді змінює текст." });
      }
    } catch { /* без семантичного шару */ }
  }

  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  // оцінка: критичне коштує дорого, бо саме воно ламає тексти системно
  const pen = findings.reduce((a, f) => a + (f.severity === "critical" ? 22 : f.severity === "warn" ? 8 : 3), 0);
  return { score: Math.max(1, 10 - Math.round(pen / 10)), promptChars, findings };
}

// Лічильник для бейджа (без моделі, тож можна смикати часто).
export async function contextIssueCount(ws: string): Promise<{ critical: number; total: number }> {
  const rows = await q<{ key: string; content: string }>(`select key, content from settings_block where workspace_id=$1`, [ws]);
  const s: Record<string, string> = {}; for (const r of rows) s[r.key] = r.content || "";
  const rub = await one<{ sum: string }>(`select coalesce(sum(share),0)::text as sum from rubric where workspace_id=$1`, [ws]);
  const f = deterministicFindings(s, Number(rub?.sum || 0));
  return { critical: f.filter((x) => x.severity === "critical").length, total: f.length };
}

// ---------------------------------------------------------------- «Виправити» для одного поля
// Переписуємо ЛИШЕ там, де це доречно. Приклади голосу й «докази» свідомо НЕ переписуємо: приклад
// голосу, написаний моделлю, перестає бути прикладом ГОЛОСУ (і наступна генерація вчитиметься на
// машинному тексті), а вигаданий доказ - це рівно те, від чого ми ставили запобіжник.
const AI_FIXABLE: Record<string, string> = {
  strategy_brief: "стратегічний бриф бренду",
  pain_points: "список болів клієнта у форматі «біль → рішення → доказ»",
  tone_of_voice: "опис голосу бренду",
};

export async function suggestFieldFix(ws: string, key: string, problem: string): Promise<string> {
  const what = AI_FIXABLE[key];
  if (!what) throw new Error("Це поле переписує лише людина - інакше воно перестає бути твоїм");
  const rows = await q<{ key: string; content: string }>(
    `select key, content from settings_block where workspace_id=$1 and key in ('marketing_context','brand_thesis','brand_antiassoc','voice_stoplist','strategy_brief','pain_points','tone_of_voice')`, [ws]);
  const s: Record<string, string> = {}; for (const r of rows) s[r.key] = r.content || "";
  const cur = (s[key] || "").trim();
  if (!cur) throw new Error("Поле порожнє - тут нема що переписувати, заповни його сам");

  const system =
    `Перепиши ${what} так, щоб усунути названу проблему. Головне правило: ЗБЕРЕЖИ ЗМІСТ І ФАКТИ - ` +
    "ти редактор, а не автор. Нічого не додавай від себе: жодних нових обіцянок, цифр, послуг чи прикладів, яких у тексті немає. " +
    "Пиши просто й конкретно, як пише людина: без штампів («інноваційне рішення», «змінює правила гри», «ключовий»), без канцеляриту, без широких тире. " +
    (s.voice_stoplist ? `Ніколи не вживай: ${s.voice_stoplist.slice(0, 300)}. ` : "") +
    (s.brand_antiassoc ? `Бренд НІКОЛИ не асоціюємо з: ${s.brand_antiassoc.slice(0, 300)}. ` : "") +
    "Довжина - як в оригіналі або коротша. Поверни ЛИШЕ готовий текст, без пояснень і лапок.";
  const out = await chat(env.cheapModel, system,
    `ПРОБЛЕМА: ${problem.slice(0, 400)}

ПОТОЧНИЙ ТЕКСТ:
${cur.slice(0, 4000)}`,
    { workspaceId: ws, step: "context_fix", maxTokens: 1500 });
  const t = out.trim().replace(/^«|»$/g, "").trim();
  if (!t) throw new Error("Модель не дала варіанту - спробуй ще раз");
  return t.slice(0, 6000);
}
