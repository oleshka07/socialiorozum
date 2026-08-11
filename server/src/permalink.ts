// 🔗 Посилання на опублікований пост.
//
// Ідентифікатори публікацій ми зберігали й раніше, але людині вони ні про що не кажуть: щоб глянути
// «як воно там виглядає», доводилось шукати пост у мережі руками. Три з чотирьох мереж дозволяють
// зібрати URL із того, що вже лежить у БД - без жодного запиту в API:
//   Telegram  message_id + chat_id   → t.me/<username>/<id> (публічний) чи t.me/c/<internal>/<id>
//   Facebook  <pageId>_<postId>      → facebook.com/<id>
//   LinkedIn  urn:li:share:<id>      → linkedin.com/feed/update/<urn>/
// І лише Threads та Instagram справді вимагають виклику (їхній permalink містить окремий короткий
// код, з id його не вивести) - тому там permalink тягнеться при публікації й кешується в БД.
//
// Функції чисті й покриті юнітами: саме тут найлегше зробити тиху помилку (наприклад забути зрізати
// префікс -100 у chat_id), а перевірити її на живому пості дорого.

// Telegram: chat_id буває трьох видів - «@name», «-100<internal>» (канал/супергрупа) і просто число.
// Для приватного каналу t.me/c/<internal>/<id> відкривається лише в учасника, але власник ним і є.
export function tgLink(chatId: string, messageId: number | string | null, username?: string | null): string {
  const mid = String(messageId ?? "").trim();
  if (!mid || !/^\d+$/.test(mid)) return "";
  const uname = String(username || "").replace(/^@/, "").trim();
  if (uname) return `https://t.me/${uname}/${mid}`;
  const chat = String(chatId || "").trim();
  if (chat.startsWith("@")) return `https://t.me/${chat.slice(1)}/${mid}`;
  const m = chat.match(/^-100(\d+)$/);
  if (m) return `https://t.me/c/${m[1]}/${mid}`;
  return ""; // звичайна група/особистий чат публічного посилання не має
}

// Facebook: id поста вже містить id сторінки («<pageId>_<postId>»), тож окремий запит не потрібен.
export function fbLink(externalId: string | null): string {
  const id = String(externalId || "").trim();
  if (!id) return "";
  return `https://www.facebook.com/${id}`;
}

// LinkedIn: x-restli-id повертає URN (urn:li:share:… або urn:li:ugcPost:…).
export function liLink(urn: string | null): string {
  const u = String(urn || "").trim();
  if (!u.startsWith("urn:li:")) return "";
  return `https://www.linkedin.com/feed/update/${u}/`;
}

// Посилання в НАШ кабінет на конкретний пост (deep-link `#/post/<id>`). Потрібне ботові: лінк
// «сценарій готовий» має відкривати саме той пост у композері, а не просто «застосунок».
export function cabinetPostLink(baseUrl: string, postId: string): string {
  const b = String(baseUrl || "").replace(/\/+$/, "");
  const id = String(postId || "").trim();
  if (!b || !id) return "";
  return `${b}/app#/post/${id}`;
}

// Deep-link на КОНКРЕТНИЙ матеріал у стрічці Джерел. Потрібен ботові: під захопленим записом
// щоденника кнопка має вести не «в застосунок узагалі», а рівно в той запис, щоб людина одразу
// бачила, що саме збереглось. Кабінет за цією адресою сам скидає фільтри стрічки й розгортає запис -
// інакше матеріал міг би бути відфільтрований і лінк вів би у порожній екран.
export function cabinetMaterialLink(baseUrl: string, sourceId: string): string {
  const b = String(baseUrl || "").replace(/\/+$/, "");
  const id = String(sourceId || "").trim();
  if (!b || !id) return "";
  return `${b}/app#/material/${id}`;
}
