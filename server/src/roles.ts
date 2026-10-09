// 👥 Ролі в бренді: хто що може. ЧИСТИЙ модуль (без бази) - його ганяють юніти.
//
// Олег дає бренд «в управління» іншому акаунту - як у Meta Business чи Buffer: обрав бренд, «Додати людину»,
// пошта, рівень доступу. Рівні йдуть сходами - кожен вищий уміє все, що нижчий:
//   👁 viewer  «Перегляд»     - бачить пости, план, календар і аналітику; нічого не змінює й не витрачає
//   📝 author  «Автор»        - пише чернетки й генерує; публікує редактор чи власник («📨 На затвердження»)
//   ✍️ editor  «Редактор»     - пости, затвердження, публікація, календар, план, коментарі людей
//   🔑 admin   «Повний доступ» - ще й канали, налаштування бренду, джерела й команда
//   👑 owner   «Власник»       - ще й видалити бренд чи стерти його «з чистого листа»
// Колишня роль 'member' (доступ до 07.10) означала «все, крім видалення бренду» - це і є «Повний доступ».
//
// Перевірка стоїть на СЕРВЕРІ в одному місці (preHandler за шаблоном маршруту): роутів понад 300, і
// кожен новий забули б обгородити. Тому за замовчуванням усе, що ЗМІНЮЄ, вимагає «Повного доступу»,
// а нижчим ролям відкрито явно перелічене нижче - забута в переліку дія лишається закритою, а не
// відкритою для всіх.

export type Role = "owner" | "admin" | "editor" | "author" | "viewer";
/** self - особисте (свій акаунт, свій конектор, перемикач брендів), роль не важить. */
export type Cap = "self" | "read" | "draft" | "publish" | "manage" | "team" | "owner";

export const ROLES: Role[] = ["owner", "admin", "editor", "author", "viewer"];
/** Ролі, які можна видати (власник один, передача бренду - окрема дія). */
export const ASSIGNABLE: Role[] = ["admin", "editor", "author", "viewer"];

const RANK: Record<Role, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };
const NEED: Record<Cap, number> = { self: -1, read: 0, draft: 1, publish: 2, manage: 3, team: 3, owner: 4 };

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Власник", admin: "Повний доступ", editor: "Редактор", author: "Автор", viewer: "Перегляд",
};
export const ROLE_ICON: Record<Role, string> = { owner: "👑", admin: "🔑", editor: "✍️", author: "📝", viewer: "👁" };
/** Що вміє роль - одним рядком (вибір ролі, лист-запрошення, вкладка «Команда»). */
export const ROLE_HINT: Record<Role, string> = {
  owner: "усе, зокрема видалити бренд",
  admin: "усе, крім видалення бренду: пости й публікація, канали, налаштування бренду, джерела, команда",
  editor: "пише, затверджує й публікує пости, веде календар і план, відповідає на коментарі; канали, налаштування бренду й команду не змінює",
  author: "пише чернетки й генерує пости; публікує редактор чи власник - автор надсилає пост на затвердження",
  viewer: "бачить пости, план, календар і аналітику; нічого не змінює",
};

/** Роль із бази → відома. Давнє 'member' = «Повний доступ»; невідоме - найменше (перегляд), а не більше. */
export function normRole(r: unknown): Role {
  const s = String(r ?? "").trim().toLowerCase();
  if (s === "member") return "admin";
  return (ROLES as string[]).includes(s) ? (s as Role) : "viewer";
}
export const isAssignable = (r: unknown): r is Role => (ASSIGNABLE as string[]).includes(String(r ?? ""));

/** Чи вистачає ролі на дію. null/порожня роль (людина не учасник) - лише особисте. */
export function can(role: unknown, cap: Cap): boolean {
  if (cap === "self") return true;
  if (role == null || role === "") return false;
  return RANK[normRole(role)] >= NEED[cap];
}
export const rankOf = (r: unknown): number => RANK[normRole(r)];

// ---------------------------------------------------------------- маршрути кабінету
// Ключ - «МЕТОД шаблон», як його бачить Fastify (req.routeOptions.url). Чого нема в переліку:
// GET → read (подивитись може кожен учасник), решта → manage (змінити - лише «Повний доступ»).
const SELF = [
  "GET /api/account", "POST /api/account/password", "POST /api/account/email", "POST /api/account/delete",
  "GET /api/workspaces", "POST /api/workspaces", "POST /api/workspaces/switch", "POST /api/workspaces/delete",
  "POST /api/workspaces/leave", "GET /api/workspaces/team",
  "GET /api/integrations/mcp", "POST /api/integrations/mcp/rotate", "POST /api/integrations/mcp/revoke",
  "POST /api/guide/log", "POST /api/tasks/ack",
  // «Підключити наш бот» привʼязує ЛЮДИНУ до бота (сповіщення, Mini App); канал через бота перевіряє роль окремо
  "POST /api/integrations/telegram/connect-link",
];
const READ_PLUS: Record<string, Cap> = {
  // секрети й підключення ховаються навіть від перегляду
  "GET /api/account/export": "manage",
  "GET /api/integrations/transcription": "manage",          // адреса вебхука = пароль
  "GET /api/integrations/meeting": "manage",
  "GET /api/integrations/gdrive/picker-token": "manage",
  "GET /api/integrations/meta/pages": "manage",
  "GET /api/workspaces/members": "team",
  // те, що коштує грошей або ходить у мережі від імені бренду
  "GET /api/generate/prompt-preview": "draft",
  "GET /api/integrations/tiktok/creator": "draft",
  "GET /api/transcription/list": "draft",
};
const DRAFT = [
  "POST /api/sources", "POST /api/generate/from-brand", "POST /api/generate/topic", "POST /api/montage",
  "POST /api/brand/context-check",
  "POST /api/media", "PUT /api/media/chunk", "PUT /api/media/:id/alt",
  "POST /api/posts/blank", "PUT /api/posts/:postId", "DELETE /api/posts/:postId", "POST /api/posts/:postId/submit",
  "POST /api/posts/:postId/cover", "POST /api/posts/:postId/subtitles", "POST /api/posts/:postId/media", "POST /api/posts/:postId/slides",
  "PUT /api/posts/:postId/slides", "DELETE /api/posts/:postId/slides/:mediaId", "PUT /api/posts/:postId/video",
  "POST /api/posts/:postId/carousel", "POST /api/posts/:postId/channels", "POST /api/posts/:postId/adapt",
  "POST /api/posts/:postId/hashtags", "POST /api/posts/:postId/reel-video", "POST /api/posts/:postId/stock-photos",
  "POST /api/posts/:postId/stock-photo", "POST /api/posts/:postId/develop", "POST /api/posts/:postId/lead-magnet",
  "POST /api/posts/:postId/hooks", "POST /api/posts/:postId/headline", "POST /api/posts/:postId/director",
  "POST /api/posts/:postId/ai-audit", "POST /api/posts/:postId/storytelling", "POST /api/posts/:postId/image",
  "POST /api/posts/:postId/deai-fix", "POST /api/posts/:postId/image-text", "POST /api/posts/:postId/regenerate",
  "POST /api/posts/:postId/atomize", "POST /api/posts/:postId/expand-thread",
  "POST /api/posts/threads-takes", "POST /api/threads/starter-pack", "POST /api/threads/niche-review",
  "POST /api/materials/:id/series", "POST /api/materials/:id/ideas", "POST /api/materials/:id/reels",
  "POST /api/materials/:id/reel-slices", "POST /api/materials/:id/posts",
  "POST /api/lead-magnets/build", "POST /api/links/shorten", "POST /api/analytics/top-patterns", "POST /api/ab/generate",
  "POST /api/runs/:id/generate-lite", "POST /api/runs/:id/ideas", "POST /api/runs/:id/cancel", "POST /api/runs/:id/ideas/select",
  "POST /api/plan/slots/:id/generate",
  "POST /api/ideas", "POST /api/ideas/:id/archive", "POST /api/ideas/:id/post",
  "POST /api/transcription/import",
];
const PUBLISH = [
  "POST /api/posts/:postId/publish-all", "POST /api/posts/:postId/first-comment/send", "POST /api/posts/:postId/repeat",
  "POST /api/posts/:postId/reel-publish", "POST /api/posts/:postId/review",
  "POST /api/comments/reply", "POST /api/comments/skip", "POST /api/threads/reply", "PUT /api/comments/notify",
  "POST /api/evergreen/:postId", "DELETE /api/evergreen/:postId", "POST /api/evergreen/:postId/force", "POST /api/evergreen/:postId/repeat",
  "POST /api/runs/:id/schedule", "POST /api/plan/generate", "POST /api/plan/match", "POST /api/materials/:id/archive",
  // PRO-конвеєр перезбирає пости прогону: крок «де-AI» замінює його готові пости новими - для автора це
  // було б видалення чужої роботи, тож лише з редактора
  "POST /api/runs/:id/steps/:step/run", "POST /api/runs/:id/run-from/:step", "POST /api/runs/:id/autopilot",
  "DELETE /api/media/:id", "POST /api/media/bulk-delete",
  "POST /api/schedule", "PUT /api/schedule/:id", "DELETE /api/schedule/:id", "POST /api/schedule/auto",
];
const TEAM = [
  "POST /api/workspaces/invite", "PUT /api/workspaces/members/:userId", "DELETE /api/workspaces/members/:userId",
  "POST /api/workspaces/invites/:id/resend", "DELETE /api/workspaces/invites/:id",
  "POST /api/workspaces/grant", "POST /api/workspaces/revoke",
];
const OWNER = ["POST /api/account/reset"];
// статистику з мереж може оновити й перегляд: безкоштовно, раз на 10 хв на кабінет
const READ_EXTRA = ["POST /api/analytics/refresh"];

const ROUTE_CAP = new Map<string, Cap>();
for (const k of SELF) ROUTE_CAP.set(k, "self");
for (const [k, v] of Object.entries(READ_PLUS)) ROUTE_CAP.set(k, v);
for (const k of DRAFT) ROUTE_CAP.set(k, "draft");
for (const k of PUBLISH) ROUTE_CAP.set(k, "publish");
for (const k of TEAM) ROUTE_CAP.set(k, "team");
for (const k of OWNER) ROUTE_CAP.set(k, "owner");
for (const k of READ_EXTRA) ROUTE_CAP.set(k, "read");

// Налаштування бренду (settings_block) змінює «Повний доступ»; ритм публікацій мереж і «ставити пости
// в найкращий час» - частина календаря, тож їх веде й редактор.
const PLAN_SETTINGS = new Set(["channel_rhythm", "best_time_auto"]);
export function settingCap(key: unknown): Cap { return PLAN_SETTINGS.has(String(key ?? "")) ? "publish" : "manage"; }

/** Усі явно перелічені маршрути (для юнітів: кожен має існувати в server.ts - друкарська помилка тихо закрила б дію). */
export const ROUTE_KEYS = (): string[] => [...ROUTE_CAP.keys()];

/** Що потрібно для маршруту кабінету. url - шаблон Fastify («/api/posts/:postId»), не сира адреса. */
export function routeCap(method: string, url: string | undefined, params?: Record<string, unknown>): Cap {
  const m = String(method || "GET").toUpperCase();
  const u = String(url || "");
  if (u.startsWith("/api/admin/")) return "self";          // адмін сервісу перевіряється в самому роуті (ADMIN_EMAILS)
  if (m === "PUT" && u === "/api/settings/:key") return settingCap(params?.key);
  const hit = ROUTE_CAP.get(`${m === "HEAD" ? "GET" : m} ${u}`);
  if (hit) return hit;
  // вхід у мережу й повернення з неї - це підключення каналу
  if (/^\/api\/integrations\/[a-z]+\/(connect|callback)$/.test(u)) return "manage";
  return m === "GET" || m === "HEAD" ? "read" : "manage";
}

// ---------------------------------------------------------------- Mini App у Telegram
const TG_CAP: Record<string, Cap> = {
  "POST /api/tg/brand": "self",
  "POST /api/tg/post": "draft", "PUT /api/tg/post/:postId": "draft", "PUT /api/tg/chunk": "draft",
  "POST /api/tg/post/:postId/media": "draft", "POST /api/tg/post/:postId/video": "draft",
  "POST /api/tg/post/:postId/image": "draft", "DELETE /api/tg/post/:postId/media": "draft",
  "POST /api/tg/post/:postId/rewrite": "draft",
  // дослати перший коментар під уже опублікований пост - це дія в мережі від імені бренду
  "POST /api/tg/post/:postId/first-comment": "publish",
  "POST /api/tg/material/:sourceId/post": "draft", "DELETE /api/tg/post/:postId": "draft",
  "POST /api/tg/post/:postId/submit": "draft",
  "POST /api/tg/post/:postId/approve": "publish", "POST /api/tg/post/:postId/schedule": "publish",
  "DELETE /api/tg/post/:postId/schedule": "publish", "POST /api/tg/post/:postId/publish": "publish",
};
export const TG_ROUTE_KEYS = (): string[] => Object.keys(TG_CAP);
export function tgRouteCap(method: string, url: string | undefined): Cap {
  const m = String(method || "GET").toUpperCase();
  const hit = TG_CAP[`${m === "HEAD" ? "GET" : m} ${url || ""}`];
  if (hit) return hit;
  return m === "GET" || m === "HEAD" ? "read" : "manage";
}

// ---------------------------------------------------------------- кнопки Telegram-бота
/** Що потрібно, щоб натиснути кнопку бота (callback_data). Невідома кнопка - лише «Повний доступ». */
export function botCap(data: string): Cap {
  const d = String(data || "");
  const head = d.split(":")[0];
  if (d.startsWith("al:") || d.startsWith("br:")) return "self";             // сповіщення адміну, вибір бренду
  if (d.startsWith("cm:")) return "read";                                     // коментарі: дії перевіряє tgcomments
  if (d === "idea_list") return "read";
  // перенести чернетку в інший бренд (cb/cbm) - прибрати її з цього: як видалення, тож не для автора
  if (["pub", "rep", "ca", "cgo", "cs", "cw", "cwx", "cb", "cbm", "apv", "ret"].includes(head) || d === "plan_gen") return "publish";
  if (head === "cad") return "manage";                                        // ще один канал Telegram у бренд
  if (/^c[a-z]*$/.test(head)) return "draft";                                 // картка поста в боті
  if (/^m[a-z0-9]*$/.test(head)) return "draft";                              // монтаж (публікацію перевіряє сам монтаж)
  if (["idea_raw", "slot_post", "idea_post", "mat_post", "dpost", "dideas", "dreel", "dbroll", "dev", "reel", "rw"].includes(head)
    || ["takes_gen", "dnone", "dweek_ideas", "dweek_reels"].includes(d)) return "draft";
  return "manage";
}

// ---------------------------------------------------------------- інструменти конектора Claude
const TOOL_CAP: Record<string, Cap> = {
  list_workspaces: "self", switch_workspace: "self",
  workspace_info: "read", brand_voice: "read", list_materials: "read", get_material: "read", list_ideas: "read",
  list_drafts: "read", get_post: "read", list_media: "read", montage_status: "read", list_schedule: "read",
  list_comments: "read", analytics: "read",
  add_material: "draft", add_idea: "draft", create_draft: "draft", update_post: "draft", attach_media: "draft",
  video_frames: "draft", montage_video: "draft", edit_post_media: "draft", render_carousel: "draft",
  media_upload_link: "draft", find_stock_photos: "draft", attach_stock_photo: "draft", generate_image: "draft",
  generate_posts: "draft", upload_media: "draft", delete_post: "draft", submit_for_review: "draft",
  publish_post: "publish", schedule_post: "publish", unschedule_post: "publish", send_first_comment: "publish",
  reply_to_comment: "publish",
};
export const TOOL_KEYS = (): string[] => Object.keys(TOOL_CAP);
/** Що потрібно інструменту з ЦИМИ аргументами (затвердити, вічнозелене, налаштування - вищий рівень). */
export function toolCap(name: string, args: Record<string, any> = {}): Cap {
  const a = args || {};
  if (name === "update_post" && (a.approve !== undefined || a.evergreen !== undefined)) return "publish";
  if (name === "create_draft" && a.approve === true) return "publish";
  if (name === "evergreen") {
    const act = String(a.action || "status");
    return act === "on" || act === "off" || act === "settings" ? "manage" : ["add", "remove", "repeat_now"].includes(act) ? "publish" : "read";
  }
  if (name === "links") {
    const act = String(a.action || "status");
    return act === "settings" || act === "bio" ? "manage" : act === "shorten" ? "draft" : "read";
  }
  return TOOL_CAP[name] || "manage";
}

// ---------------------------------------------------------------- людські відмови
const NEED_TEXT: Record<Cap, string> = {
  self: "", read: "",
  draft: "Писати пости й генерувати може автор, редактор, людина з повним доступом чи власник.",
  publish: "Затверджувати, публікувати й планувати може редактор, людина з повним доступом чи власник.",
  manage: "Канали, налаштування бренду й джерела змінює власник або людина з повним доступом.",
  team: "Командою бренду керує власник або людина з повним доступом.",
  owner: "Це може лише власник бренду.",
};
/** Чому не можна - з тим, яка в людини роль і що робити далі. */
export function deniedText(role: unknown, cap: Cap, brand = ""): string {
  if (role == null || role === "") return "Немає доступу до цього бренду.";
  const r = normRole(role);
  const where = brand ? ` у бренді «${brand}»` : "";
  const tail = r === "author" && cap === "publish" ? " Надішли пост на затвердження - кнопка «📨 На затвердження»." : "";
  return `Твоя роль${where} - ${ROLE_ICON[r]} ${ROLE_LABEL[r]}. ${NEED_TEXT[cap]}${tail}`.trim();
}

/** Пошта для показу людям з меншими правами: o***@swipescape.eu. */
export function maskEmail(e: string): string {
  const s = String(e || "");
  const at = s.indexOf("@");
  if (at < 1) return s ? s[0] + "***" : "";
  return s[0] + "***" + s.slice(at);
}
