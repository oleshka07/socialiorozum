// 📥 Приймач зустрічей із зовнішнього транскрибатора (Vymova і будь-який інший самописний).
//
// Чим це відрізняється від інтеграції Fireflies. Fireflies шле лише `meetingId`, і ми мусимо
// піти назад по його API зі своїм ключем - тобто дві мережеві залежності й ключ, який може
// протухнути. Тут увесь вміст приходить у ТІЛІ запиту, тож приймач самодостатній: жодного
// зворотного виклику, жодного ключа провайдера. Це головна причина зробити окремий, простіший
// шлях, а не втискати Vymova у форму Fireflies.
//
// Формат тіла - за специфікацією Vymova, але навмисно ТЕРПИМИЙ: приймаємо й мінімальну
// «загальну» форму {title, text}, щоб наступний самописний інструмент можна було під'єднати
// без правок на нашому боці.

// Обидва формати реплік зі специфікації. Новий - основний, старий лишився в зустрічах,
// записаних до серпня 2026; приймач мусить розуміти обидва, інакше старий архів мовчки
// перетвориться на порожній матеріал.
const RE_NEW = /^\*\*(.+?)\*\* \*\[([\d:]+)\]\*:\s*(.*)$/;
const RE_OLD = /^\*\*\[([\d:]+)\]\s+(.+?):\*\*\s*(.*)$/;

export type Turn = { speaker: string; time: string; text: string };
export type ParsedMeeting = { turns: Turn[]; notes: string; summary: string };

/**
 * Розбір `transcript_markdown` на репліки + секції.
 *
 * Секції відокремлюємо за ЗАГОЛОВКАМИ (`## …`), а не за `---`: горизонтальна риска в Markdown
 * може стояти й усередині тексту, а заголовок - однозначний якір.
 */
export function parseTranscriptMarkdown(md: string): ParsedMeeting {
  const turns: Turn[] = [];
  const notes: string[] = [];
  const summary: string[] = [];
  let section: "body" | "notes" | "summary" | "other" = "body";
  for (const raw of String(md || "").split("\n")) {
    const line = raw.trim();
    const head = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (head) {
      const t = head[1].toLowerCase();
      section = /особист|нотатк|notes/.test(t) ? "notes" : /summary|підсумок|резюме/.test(t) ? "summary" : "other";
      continue;
    }
    if (section === "notes") { if (line && line !== "---") notes.push(line); continue; }
    if (section === "summary") { if (line && line !== "---") summary.push(line); continue; }
    if (section === "other") continue;
    const n = line.match(RE_NEW);
    if (n) { turns.push({ speaker: n[1].trim(), time: n[2], text: n[3].trim() }); continue; }
    const o = line.match(RE_OLD);
    if (o) { turns.push({ speaker: o[2].trim(), time: o[1], text: o[3].trim() }); continue; }
    // заголовок зустрічі, `---`, порожні рядки - свідомо пропускаємо
    if (turns.length && line && !line.startsWith("#") && line !== "---") {
      turns[turns.length - 1].text += " " + line;   // перенос рядка всередині репліки
    }
  }
  return { turns: turns.filter((t) => t.text), notes: notes.join("\n").trim(), summary: summary.join("\n").trim() };
}

export type MeetingIn = {
  externalId: string;    // ключ, під яким запишемо
  altIds: string[];      // інші ключі, під якими зустріч могла лягти РАНІШЕ (перевіряємо на дубль)
  title: string;
  text: string;          // те, що піде в генерацію
  summary: string;
  finishedAt: Date | null;
  speakers: number;
  senderSha: string;     // заявлений відправником хеш транскрипта (для перевірки цілості)
  rawTranscript: string; // сире `transcript_markdown` - те, від чого цей хеш і рахувався
};

const SERVICE_SPEAKERS = new Set(["ai", "assistant", "асистент"]);

/**
 * Репліки → плоский текст для конвеєра.
 *
 * ІМЕНА СПІКЕРІВ ЗАЛИШАЮТЬСЯ. Це не косметика: у зустрічі говорять кілька людей, і без підпису
 * модель припише слова співрозмовника авторові - тобто пост розкаже «наш досвід» про чужу
 * репліку. Підпис - єдиний спосіб не вигадати за автора.
 *
 * Службові репліки асистента відфільтровані: це не розмова людей, а машинний текст, і вчити
 * на ньому голос бренду шкідливо (той самий принцип, що з прикладами голосу).
 */
export function meetingText(title: string, p: ParsedMeeting): string {
  const body = p.turns
    .filter((t) => !SERVICE_SPEAKERS.has(t.speaker.toLowerCase()))
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n");
  const parts = [title ? `# ${title}` : "", body].filter(Boolean);
  // Особисті нотатки - ВЛАСНІ слова автора, найцінніша частина зустрічі для контенту.
  // Позначаємо їх окремо, щоб модель бачила, де закінчується чужа мова.
  if (p.notes) parts.push(`## Мої нотатки з зустрічі\n${p.notes}`);
  return parts.join("\n\n").trim();
}

/**
 * Тіло вебхука → нормалізована зустріч. Повертає рядок-причину, якщо подію треба ІГНОРУВАТИ
 * (не помилка: віддамо 200, інакше відправник ретраїтиме те, що ми свідомо не беремо).
 */
export function normalizeMeeting(body: any, hashFallback: (s: string) => string): MeetingIn | { ignore: string } {
  const b = body || {};
  const event = String(b.event || b.eventType || "meeting.completed");
  // нові типи подій можливі в майбутньому - незнайомі ігноруємо, а не валимо помилкою
  if (event !== "meeting.completed") return { ignore: `подія «${event}» не обробляється` };

  const md = String(b.transcript_markdown ?? b.transcript_md ?? "");
  const plain = String(b.text ?? b.transcript ?? "");        // мінімальна «загальна» форма
  const parsed = md ? parseTranscriptMarkdown(md) : { turns: [], notes: "", summary: "" };
  const title = String(b.title || "").trim() || "Зустріч";
  const summary = String(b.summary_markdown ?? b.summary_md ?? b.summary ?? "").trim() || parsed.summary;

  let text = md ? meetingText(title, parsed) : plain.trim();
  // Транскрипт не розібрався (чужий формат), але підсумок є - беремо його, ніж лишити порожньо.
  // Інакше зустріч мовчки перетворилась би на матеріал без тіла, і людина не зрозуміла б чому.
  if (!parsed.turns.length && !plain.trim() && summary) text = `# ${title}\n\n${summary}`;
  if (text.trim().length < 40) return { ignore: "порожня зустріч (нема тексту)" };

  // Ключ дедуплікації. Порядок тут НЕ довільний і був колись зворотним - це помилка.
  // `meeting_id` (UUID) присвоюється зустрічі на старті й переживає перейменування файлу та
  // перезапуск застосунку. `file_name` виведений із ЧАСУ ПОЧАТКУ, тож дві зустрічі, розпочаті
  // в одну хвилину на різних пристроях, злиплися б в одну - тобто друга зникла б без сліду.
  // Тому file_name лише запасний (записи до серпня 2026), а без обох рахуємо хеш вмісту:
  // порожній ключ означав би, що ретрай відправника створює дублікат матеріалу.
  const uuid = String(b.meeting_id || b.meetingId || b.id || "").trim();
  const fileName = String(b.file_name || b.fileName || "").trim();
  // Хеш вмісту від ВІДПРАВНИКА кращий за наш власний: він рахується з сирого
  // `transcript_markdown`, тож не залежить від того, як саме наш парсер сьогодні складає текст.
  // Якби ключем був хеш НАШОГО результату, будь-яка правка `meetingText` (навіть зміна
  // заголовка секції нотаток) тихо зробила б усі раніше прийняті зустрічі «новими».
  const senderSha = String(b.content_sha256 || b.contentSha256 || "").trim();
  const senderKey = senderSha ? `sha:${senderSha}` : "";
  const ownKey = `sha:${hashFallback(text)}`;   // фолбек для відправників без цього поля
  const externalId = uuid || fileName || senderKey || ownKey;
  // Запасні ключі для перевірки на дубль. `file_name` потрапляє сюди ЛИШЕ коли UUID немає
  // (старі версії застосунку). Прогін наскрізь показав, чому: якщо тримати file_name у списку
  // завжди, то нова зустріч, чий file_name збігся з уже імпортованою, мовчки вважалась би
  // дублем і ЗНИКАЛА б - тобто запобіжник від колізії сам її й відтворював. Втратити зустріч
  // непомітно гірше, ніж один раз побачити зайвий матеріал і видалити його.
  // Хеші так не колізять (однаковий вміст = та сама зустріч), тож обидва лишаються завжди -
  // зокрема й наш власний, щоб зустріч, прийнята до появи `content_sha256`, не задвоїлась.
  const altIds = (uuid ? [senderKey, ownKey] : [fileName, senderKey, ownKey])
    .filter((x) => x && x !== externalId);

  const fin = new Date(String(b.finished_at || b.finishedAt || ""));
  return {
    externalId: externalId.slice(0, 200),
    altIds: altIds.map((x) => x.slice(0, 200)),
    title: title.slice(0, 200),
    text: text.slice(0, 200000),
    summary: summary.slice(0, 8000),
    finishedAt: isNaN(fin.getTime()) ? null : fin,
    speakers: new Set(parsed.turns.map((t) => t.speaker)).size,
    senderSha,
    rawTranscript: md,
  };
}
