// Чому не вдалося підключити мережу - одним кодом, який кабінет перекладає людською.
//
// До цього колбек OAuth редіректив лише «?threads=error», і людина бачила «Не вдалося підключити
// Threads» без жодної причини - хоча Threads пояснював її дослівно. Спіймано на тестері: його
// акаунт не був у списку Threads Testers, а причина жила тільки в app_log, куди має доступ лише
// адмін. Тож людина тиснула «Підключити» знову і знову, і нічого не могла з цим зробити.
//
// Код, а не сирий текст: людський текст під кожну причину живе в кабінеті поруч з іншими
// текстами інтерфейсу, а в адресу не потрапляє нічого, крім короткої мітки.
export type OauthWhy = "tester" | "denied" | "session" | "retry" | "other";

// Застосунок ще не пройшов App Review: пускає лише тих, хто має роль у ньому (адмін, розробник,
// тестувальник). Формулювання в Meta й Threads різні, і вони їх міняють, тож ловимо за змістом.
const TESTER_RX = /testers?\b|app review|requires the [\w.]+ permission|insufficient developer role|developer role|app (?:is )?not active|not currently accessible|isn'?t available to you/i;
// Код авторизації одноразовий і живе хвилини: вікно висіло відкритим або подвійний клік.
const RETRY_RX = /code has expired|code has been used|authorization code.*(?:expired|used|invalid)|expired.*code/i;
// Людина сама натиснула «Скасувати» у вікні мережі.
const DENIED_RX = /access_denied|user denied|denied|cancel|permissions? error/i;

// stage: "provider" - мережа сама повернула помилку в адресі колбека;
//        "exchange" - повернула code, але обмін на токен (чи наступний запит) не вдався.
export function oauthWhy(raw: unknown, stage: "provider" | "exchange" = "exchange"): OauthWhy {
  const s = String(raw ?? "");
  if (TESTER_RX.test(s)) return "tester";      // навіть якщо мережа прислала це як «відмову»
  if (RETRY_RX.test(s)) return "retry";
  if (stage === "provider" && (!s || DENIED_RX.test(s))) return "denied";
  return "other";
}

// Хвіст редіректу - ЛИШЕ код із закритого переліку. Сирий текст мережі в адресу свідомо не
// кладемо: кабінет показує вміст адреси у вікні, і тоді будь-хто міг би надіслати посилання на
// socialio, яке показує в НАШОМУ вікні довільний текст («ваш акаунт заблоковано, напишіть…»).
// Деталі «other» лишаються в app_log - їх видно адміну в «Здоровʼї сервісу».
export function oauthFailQuery(why: OauthWhy): string {
  return `&why=${why}`;
}
