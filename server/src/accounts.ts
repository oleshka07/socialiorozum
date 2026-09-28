// 👥 Кілька акаунтів однієї мережі в бренді: особистий і компанії (питання Олега 26.09). Сторінки
// Facebook (кожна зі своїм Instagram), профілі Threads і канали та групи Telegram (28.09).
//
// Головні рішення:
//  • ОСНОВНИЙ акаунт живе там, де й жив: meta_config / threads_config. Увесь код, що знає лише «акаунт
//    бренду» (онбординг, імпорт голосу з Instagram, RSS із чужих Instagram, стрік Threads), працює з
//    ним як раніше, а бренди з одним акаунтом не помічають нічого. ДОДАТКОВІ - у meta_page /
//    threads_account; «зробити основним» міняє їх місцями однією транзакцією.
//  • Пост обирає акаунти галочками в channels.<мережа>.accounts (id Сторінки / Instagram / Threads /
//    чату Telegram; давнє одиночне .account читається як список з одного). Нема = за замовчуванням
//    (основний; у Telegram - основні канал і група). Кілька - той самий пост окремо в кожен.
//  • Рядок публікації памʼятає, ЯКИМ акаунтом пост вийшов (account_id, account_name). Коментар,
//    статистика, посилання й CTA-відповідь ідуть тим самим акаунтом: інакше після зміни основного
//    акаунта все, що робиться під старими постами, падає «The requested resource does not exist».
//  • Акаунт не зникає мовчки: перепідключення іншим профілем лишає попередній додатковим, якщо з нього
//    вже публікували (його постам потрібен його токен) або бренд і так веде кілька акаунтів.
import { q, one, tx } from "./db.js";
import * as threads from "./threads.js";
import { logEvent } from "./log.js";
import type { FbPage } from "./meta.js";

export const MULTI_NETS = ["facebook", "instagram", "threads"] as const;
export type MultiNet = (typeof MULTI_NETS)[number];
export const isMultiNet = (n: string): n is MultiNet => (MULTI_NETS as readonly string[]).includes(n);
// мережі, де пост обирає, КУДИ саме піти (галочки): акаунти Meta й Threads + канали й групи Telegram
export const ACC_NETS = ["facebook", "instagram", "threads", "telegram"] as const;
export type AccNet = (typeof ACC_NETS)[number];
export const isAccNet = (n: string): n is AccNet => (ACC_NETS as readonly string[]).includes(n);

export type MetaPage = { pageId: string; pageName: string; pageToken: string; igUserId: string | null; igUsername: string | null; main: boolean };
export type ThreadsLogin = { token: string; userId: string; username: string };
export type ThreadsAcc = { userId: string; username: string; main: boolean; expiresAt: string | null };
export type AccountChoice = { id: string; name: string; main: boolean };
export type Picked<T> = { ok: true; acc: T } | { ok: false; error: string };

const at = (u: string | null | undefined): string => (u ? "@" + String(u).replace(/^@/, "") : "");
const LABEL: Record<MultiNet, string> = { facebook: "Facebook", instagram: "Instagram", threads: "Threads" };
const WHERE_ADD: Record<MultiNet, string> = {
  facebook: "Налаштування → Канали → Facebook + Instagram",
  instagram: "Налаштування → Канали → Facebook + Instagram",
  threads: "Налаштування → Канали → Threads → «＋ Додати акаунт»",
};

// ---------------------------------------------------------------- Meta (Сторінки + їхній Instagram)
type PageRow = { page_id: string; page_name: string | null; page_token: string; ig_user_id: string | null; ig_username: string | null };
const toPage = (r: PageRow, main: boolean): MetaPage =>
  ({ pageId: r.page_id, pageName: r.page_name || r.page_id, pageToken: r.page_token, igUserId: r.ig_user_id || null, igUsername: r.ig_username || null, main });

/** Усі Сторінки бренду: основна першою, далі додаткові в порядку додавання. */
export async function metaPages(ws: string): Promise<MetaPage[]> {
  const [main, extra] = await Promise.all([
    one<PageRow>(`select page_id, page_name, page_token, ig_user_id, ig_username from meta_config
                   where workspace_id=$1 and page_id is not null and page_token is not null`, [ws]),
    q<PageRow>(`select page_id, page_name, page_token, ig_user_id, ig_username from meta_page where workspace_id=$1 order by added_at, page_id`, [ws]),
  ]);
  const out: MetaPage[] = main ? [toPage(main, true)] : [];
  for (const r of extra) if (!main || r.page_id !== main.page_id) out.push(toPage(r, false));
  return out;
}

/** Instagram «за замовчуванням»: Instagram основної Сторінки, а якщо в неї нема - перший із додаткових. */
function defaultIg(pages: MetaPage[]): MetaPage | undefined {
  return pages.find((p) => p.main && p.igUserId) || pages.find((p) => p.igUserId);
}

/** Яким акаунтом Meta публікувати пост: обраним у пості (wanted) або за замовчуванням. */
export async function metaAccountFor(ws: string, net: "facebook" | "instagram", wanted?: string | null): Promise<Picked<MetaPage>> {
  const pages = await metaPages(ws);
  if (!pages.length) return { ok: false, error: `${LABEL[net]} не підключено` };
  if (wanted) {
    const p = net === "facebook" ? pages.find((x) => x.pageId === wanted) : pages.find((x) => x.igUserId === wanted);
    return p ? { ok: true, acc: p }
      : { ok: false, error: `обраний для поста акаунт ${LABEL[net]} більше не підключено до бренду - відкрий пост і обери інший (або додай його знову: ${WHERE_ADD[net]})` };
  }
  const p = net === "facebook" ? pages[0] : defaultIg(pages);
  return p ? { ok: true, acc: p } : { ok: false, error: `${LABEL[net]} не підключено` };
}

type PubAccount = { account_id?: string | null; account_name?: string | null };
const goneText = (net: MultiNet, row: PubAccount) =>
  `${LABEL[net]}: пост опубліковано з ${row.account_name || "іншого акаунта"}, а його зараз не підключено до бренду - додай його (${WHERE_ADD[net]}), потім повтори.`;

/** Акаунт Meta, яким пост УЖЕ опубліковано (для коментаря, статистики, посилання). Старий рядок без
 *  акаунта - основний, як було до цього. */
export async function metaAccountForRow(ws: string, net: "facebook" | "instagram", row: PubAccount): Promise<Picked<MetaPage>> {
  if (!row.account_id) return metaAccountFor(ws, net, null);
  const pages = await metaPages(ws);
  if (!pages.length) return { ok: false, error: `${LABEL[net]} не підключено` };
  const p = net === "facebook" ? pages.find((x) => x.pageId === row.account_id) : pages.find((x) => x.igUserId === row.account_id);
  return p ? { ok: true, acc: p } : { ok: false, error: goneText(net, row) };
}

async function metaHistory(c: { one: typeof one }, ws: string, pageId: string, igUserId: string | null): Promise<boolean> {
  const r = await c.one<{ x: boolean }>(
    `select exists(select 1 from meta_publish mp join post p on p.id=mp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
                    where s.workspace_id=$1 and mp.status='sent' and (mp.account_id is null or mp.account_id=$2 or mp.account_id=$3)) as x`,
    [ws, pageId, igUserId || pageId]);
  return !!r?.x;
}

/** Після входу через Meta: основна Сторінка (з токеном користувача, строком і наданими дозволами) +
 *  свіжі токени додаткових Сторінок зі списку. Колишня основна, якщо основна змінилась, лишається
 *  додатковою, коли з неї публікували або бренд і так веде кілька Сторінок. */
export async function saveMetaLogin(ws: string, login: { userToken: string; expiresAt: string | null; granted: string | null },
                                    page: FbPage, all: FbPage[]): Promise<void> {
  await tx(async (c) => {
    const old = await c.one<PageRow & { page_token: string | null }>(
      `select page_id, page_name, page_token, ig_user_id, ig_username from meta_config where workspace_id=$1 for update`, [ws]);
    if (old?.page_id && old.page_token && old.page_id !== page.id) {
      const extras = await c.one<{ n: number }>(`select count(*)::int n from meta_page where workspace_id=$1 and page_id<>$2`, [ws, page.id]);
      if ((extras?.n || 0) > 0 || (await metaHistory(c, ws, old.page_id, old.ig_user_id)))
        await c.q(`insert into meta_page(workspace_id, page_id, page_name, page_token, ig_user_id, ig_username) values($1,$2,$3,$4,$5,$6)
                   on conflict (workspace_id, page_id) do update set page_name=excluded.page_name, page_token=excluded.page_token,
                     ig_user_id=excluded.ig_user_id, ig_username=excluded.ig_username, updated_at=now()`,
          [ws, old.page_id, old.page_name, old.page_token, old.ig_user_id, old.ig_username]);
    }
    await c.q(`insert into meta_config(workspace_id, user_token, page_id, page_name, page_token, ig_user_id, ig_username, token_expires_at, granted, updated_at)
               values($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
               on conflict (workspace_id) do update set user_token=excluded.user_token, page_id=excluded.page_id, page_name=excluded.page_name,
                 page_token=excluded.page_token, ig_user_id=excluded.ig_user_id, ig_username=excluded.ig_username,
                 token_expires_at=excluded.token_expires_at, granted=excluded.granted, updated_at=now()`,
      [ws, login.userToken, page.id, page.name, page.access_token, page.instagram_business_account?.id ?? null,
        page.instagram_business_account?.username ?? null, login.expiresAt, login.granted]);
    await c.q(`delete from meta_page where workspace_id=$1 and page_id=$2`, [ws, page.id]);
    // нові токени додаткових Сторінок (Meta видала їх разом зі свіжим входом)
    for (const p of all) {
      if (p.id === page.id) continue;
      await c.q(`update meta_page set page_name=$3, page_token=$4, ig_user_id=$5, ig_username=$6, updated_at=now()
                  where workspace_id=$1 and page_id=$2`,
        [ws, p.id, p.name, p.access_token, p.instagram_business_account?.id ?? null, p.instagram_business_account?.username ?? null]);
    }
  });
}

/** Додати Сторінку (зі списку, який Meta віддала за входом людини) до бренду. */
export async function addMetaPage(ws: string, page: FbPage): Promise<"added" | "main" | "exists"> {
  return tx(async (c) => {
    const main = await c.one<{ page_id: string | null }>(`select page_id from meta_config where workspace_id=$1 for update`, [ws]);
    if (!main) throw new Error("Meta не підключено");
    if (main.page_id === page.id) return "main";
    const r = await c.one<{ fresh: boolean }>(
      `insert into meta_page(workspace_id, page_id, page_name, page_token, ig_user_id, ig_username) values($1,$2,$3,$4,$5,$6)
       on conflict (workspace_id, page_id) do update set page_name=excluded.page_name, page_token=excluded.page_token,
         ig_user_id=excluded.ig_user_id, ig_username=excluded.ig_username, updated_at=now()
       returning (xmax = 0) as fresh`,
      [ws, page.id, page.name, page.access_token, page.instagram_business_account?.id ?? null, page.instagram_business_account?.username ?? null]);
    if (!main.page_id) {
      // основної Сторінки не було (лише вхід) - ця і стає основною
      await c.q(`update meta_config set page_id=$2, page_name=$3, page_token=$4, ig_user_id=$5, ig_username=$6, updated_at=now() where workspace_id=$1`,
        [ws, page.id, page.name, page.access_token, page.instagram_business_account?.id ?? null, page.instagram_business_account?.username ?? null]);
      await c.q(`delete from meta_page where workspace_id=$1 and page_id=$2`, [ws, page.id]);
      return "main";
    }
    return r?.fresh ? "added" : "exists";
  });
}

/** Зробити Сторінку основною. page - зі свіжого списку Meta (якщо її ще нема в бренді) або null для
 *  вже доданої. Колишня основна лишається додатковою за тим самим правилом, що й при вході. */
export async function setMainPage(ws: string, pageId: string, fresh?: FbPage | null): Promise<boolean> {
  return tx(async (c) => {
    const old = await c.one<PageRow & { page_token: string | null }>(
      `select page_id, page_name, page_token, ig_user_id, ig_username from meta_config where workspace_id=$1 for update`, [ws]);
    if (!old) return false;
    if (old.page_id === pageId) return true;
    const ex = await c.one<PageRow>(`select page_id, page_name, page_token, ig_user_id, ig_username from meta_page where workspace_id=$1 and page_id=$2 for update`, [ws, pageId]);
    const next: PageRow | null = fresh
      ? { page_id: fresh.id, page_name: fresh.name, page_token: fresh.access_token, ig_user_id: fresh.instagram_business_account?.id ?? null, ig_username: fresh.instagram_business_account?.username ?? null }
      : ex;
    if (!next) return false;
    if (old.page_id && old.page_token) {
      const extras = await c.one<{ n: number }>(`select count(*)::int n from meta_page where workspace_id=$1 and page_id<>$2`, [ws, pageId]);
      if (ex || (extras?.n || 0) > 0 || (await metaHistory(c, ws, old.page_id, old.ig_user_id)))
        await c.q(`insert into meta_page(workspace_id, page_id, page_name, page_token, ig_user_id, ig_username) values($1,$2,$3,$4,$5,$6)
                   on conflict (workspace_id, page_id) do update set page_name=excluded.page_name, page_token=excluded.page_token,
                     ig_user_id=excluded.ig_user_id, ig_username=excluded.ig_username, updated_at=now()`,
          [ws, old.page_id, old.page_name, old.page_token, old.ig_user_id, old.ig_username]);
    }
    await c.q(`update meta_config set page_id=$2, page_name=$3, page_token=$4, ig_user_id=$5, ig_username=$6, updated_at=now() where workspace_id=$1`,
      [ws, next.page_id, next.page_name, next.page_token, next.ig_user_id, next.ig_username]);
    await c.q(`delete from meta_page where workspace_id=$1 and page_id=$2`, [ws, next.page_id]);
    return true;
  });
}

/** Прибрати Сторінку з бренду. Основну заміняє перша додаткова; остання - це повне відключення Meta. */
export async function removeMetaPage(ws: string, pageId: string): Promise<"extra" | "main" | "last" | "none"> {
  return tx(async (c) => {
    const main = await c.one<{ page_id: string | null }>(`select page_id from meta_config where workspace_id=$1 for update`, [ws]);
    if (main?.page_id === pageId) {
      const next = await c.one<PageRow>(
        `select page_id, page_name, page_token, ig_user_id, ig_username from meta_page where workspace_id=$1 and page_id<>$2 order by added_at, page_id limit 1 for update`, [ws, pageId]);
      if (!next) { await c.q(`delete from meta_config where workspace_id=$1`, [ws]); await c.q(`delete from meta_page where workspace_id=$1`, [ws]); return "last"; }
      await c.q(`update meta_config set page_id=$2, page_name=$3, page_token=$4, ig_user_id=$5, ig_username=$6, updated_at=now() where workspace_id=$1`,
        [ws, next.page_id, next.page_name, next.page_token, next.ig_user_id, next.ig_username]);
      await c.q(`delete from meta_page where workspace_id=$1 and page_id=$2`, [ws, next.page_id]);
      return "main";
    }
    const r = await c.q(`delete from meta_page where workspace_id=$1 and page_id=$2 returning page_id`, [ws, pageId]);
    return r.length ? "extra" : "none";
  });
}

// ---------------------------------------------------------------- Threads (кожен профіль - окремий вхід)
type ThRow = { threads_user_id: string | null; username: string | null; access_token: string | null; token_expires_at: string | null };

/** Акаунти Threads бренду (без токенів): основний першим. */
export async function threadsAccounts(ws: string): Promise<ThreadsAcc[]> {
  const [main, extra] = await Promise.all([
    one<ThRow>(`select threads_user_id, username, access_token, token_expires_at from threads_config where workspace_id=$1`, [ws]),
    q<ThRow>(`select threads_user_id, username, access_token, token_expires_at from threads_account where workspace_id=$1 order by added_at, threads_user_id`, [ws]),
  ]);
  const out: ThreadsAcc[] = [];
  if (main?.access_token && main.threads_user_id) out.push({ userId: main.threads_user_id, username: main.username || "", main: true, expiresAt: main.token_expires_at });
  for (const r of extra) if (r.threads_user_id && r.threads_user_id !== main?.threads_user_id)
    out.push({ userId: r.threads_user_id, username: r.username || "", main: false, expiresAt: r.token_expires_at });
  return out;
}

/** Дійсний токен акаунта Threads (userId не задано - основний). Живе 60 днів: коли лишилось менше 7,
 *  освіжаємо й записуємо туди, де акаунт лежить. */
export async function threadsToken(ws: string, userId?: string | null): Promise<ThreadsLogin | null> {
  const main = await one<ThRow>(`select threads_user_id, username, access_token, token_expires_at from threads_config where workspace_id=$1`, [ws]);
  const isMain = !userId || (!!main && main.threads_user_id === userId);
  const row = isMain ? main
    : await one<ThRow>(`select threads_user_id, username, access_token, token_expires_at from threads_account where workspace_id=$1 and threads_user_id=$2`, [ws, userId]);
  if (!row?.access_token || !row.threads_user_id) return null;
  const exp = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  if (exp && exp - Date.now() < 7 * 864e5) {
    try {
      const r = await threads.refreshToken(row.access_token);
      const newExp = new Date(Date.now() + r.expires_in * 1000).toISOString();
      if (isMain) await q(`update threads_config set access_token=$2, token_expires_at=$3, updated_at=now() where workspace_id=$1`, [ws, r.access_token, newExp]);
      else await q(`update threads_account set access_token=$3, token_expires_at=$4, updated_at=now() where workspace_id=$1 and threads_user_id=$2`, [ws, row.threads_user_id, r.access_token, newExp]);
      return { token: r.access_token, userId: row.threads_user_id, username: row.username || "" };
    } catch { /* рефреш не вдався - пробуємо наявним токеном */ }
  }
  return { token: row.access_token, userId: row.threads_user_id, username: row.username || "" };
}

/** Яким акаунтом Threads публікувати пост: обраним (wanted) або основним. */
export async function threadsAccountFor(ws: string, wanted?: string | null): Promise<Picked<ThreadsLogin>> {
  const t = await threadsToken(ws, wanted || null);
  if (t) return { ok: true, acc: t };
  if (wanted && (await threadsToken(ws))) return { ok: false, error: `обраний для поста акаунт Threads більше не підключено до бренду - відкрий пост і обери інший (або додай його знову: ${WHERE_ADD.threads})` };
  return { ok: false, error: "Threads не підключено" };
}

/** Акаунт Threads, яким пост УЖЕ опубліковано: за id, а для старих рядків - за ніком із посилання. */
export async function threadsAccountForRow(ws: string, row: PubAccount): Promise<Picked<ThreadsLogin>> {
  if (!row.account_id && !row.account_name) return threadsAccountFor(ws, null);
  if (row.account_id) { const t = await threadsToken(ws, row.account_id); if (t) return { ok: true, acc: t }; }
  if (row.account_name) {
    const name = row.account_name.replace(/^@/, "").toLowerCase();
    const acc = (await threadsAccounts(ws)).find((a) => a.username.toLowerCase() === name);
    if (acc) { const t = await threadsToken(ws, acc.userId); if (t) return { ok: true, acc: t }; }
  }
  if (!(await threadsToken(ws))) return { ok: false, error: "Threads не підключено" };
  return { ok: false, error: goneText("threads", row) };
}

async function threadsHistory(c: { one: typeof one }, ws: string, userId: string): Promise<boolean> {
  const r = await c.one<{ x: boolean }>(
    `select exists(select 1 from threads_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
                    where s.workspace_id=$1 and tp.status='sent' and (tp.account_id is null or tp.account_id=$2)) as x`, [ws, userId]);
  return !!r?.x;
}

/** Після входу в Threads. mode 'add' - додати акаунт (основний не міняється); 'main' - цей акаунт стає
 *  основним (так поводилась кнопка «Підключити» завжди). Акаунт, що вже є в бренді, лише отримує
 *  свіжий токен. Колишній основний лишається додатковим, якщо з нього публікували або бренд і так веде
 *  кілька акаунтів - інакше коментарі й статистика його постів лишились би без токена. */
export async function saveThreadsLogin(ws: string, a: { userId: string; username: string; token: string; expiresAt: string | null },
                                       mode: "add" | "main"): Promise<"new" | "refreshed" | "added" | "main"> {
  const res = await tx(async (c) => {
    const main = await c.one<ThRow>(`select threads_user_id, username, access_token, token_expires_at from threads_config where workspace_id=$1 for update`, [ws]);
    const putMain = () => c.q(
      `insert into threads_config(workspace_id, threads_user_id, username, access_token, token_expires_at, updated_at) values($1,$2,$3,$4,$5,now())
       on conflict (workspace_id) do update set threads_user_id=excluded.threads_user_id, username=excluded.username,
         access_token=excluded.access_token, token_expires_at=excluded.token_expires_at, updated_at=now()`,
      [ws, a.userId, a.username, a.token, a.expiresAt]);
    if (!main?.access_token || !main.threads_user_id) {
      await putMain();
      await c.q(`delete from threads_account where workspace_id=$1 and threads_user_id=$2`, [ws, a.userId]);
      return "new" as const;
    }
    if (main.threads_user_id === a.userId) { await putMain(); return "refreshed" as const; }
    const known = await c.one(`select 1 from threads_account where workspace_id=$1 and threads_user_id=$2 for update`, [ws, a.userId]);
    if (mode === "add") {
      await c.q(`insert into threads_account(workspace_id, threads_user_id, username, access_token, token_expires_at) values($1,$2,$3,$4,$5)
                 on conflict (workspace_id, threads_user_id) do update set username=excluded.username, access_token=excluded.access_token,
                   token_expires_at=excluded.token_expires_at, updated_at=now()`, [ws, a.userId, a.username, a.token, a.expiresAt]);
      return known ? ("refreshed" as const) : ("added" as const);
    }
    // цей акаунт стає основним; колишній основний - додатковим, якщо він ще потрібен
    const extras = await c.one<{ n: number }>(`select count(*)::int n from threads_account where workspace_id=$1 and threads_user_id<>$2`, [ws, a.userId]);
    if (known || (extras?.n || 0) > 0 || (await threadsHistory(c, ws, main.threads_user_id)))
      await c.q(`insert into threads_account(workspace_id, threads_user_id, username, access_token, token_expires_at) values($1,$2,$3,$4,$5)
                 on conflict (workspace_id, threads_user_id) do update set username=excluded.username, access_token=excluded.access_token,
                   token_expires_at=excluded.token_expires_at, updated_at=now()`,
        [ws, main.threads_user_id, main.username, main.access_token, main.token_expires_at]);
    await putMain();
    await c.q(`delete from threads_account where workspace_id=$1 and threads_user_id=$2`, [ws, a.userId]);
    return "main" as const;
  });
  await linkThreadsRows(ws, a.userId, a.username);
  // кеш панелі Threads в Аналітиці - про основний акаунт; основний міг змінитись
  if (res === "new" || res === "main") await q(`delete from settings_block where workspace_id=$1 and key='threads_an_cache'`, [ws]);
  // склад акаунтів змінився - старі пости без акаунта визначаємо у фоні (вікно OAuth не чекає)
  if (res !== "refreshed") void probeThreadsRows(ws).catch(() => {});
  return res;
}

/** Старі рядки публікацій, де відомий лише нік (з посилання), привʼязуємо до щойно підключеного акаунта. */
async function linkThreadsRows(ws: string, userId: string, username: string): Promise<void> {
  if (!username) return;
  const rows = await q<{ post_id: string }>(`update threads_publish tp set account_id=$2
             from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
            where tp.post_id=p.id and s.workspace_id=$1 and tp.account_id is null and lower(tp.account_name)=lower($3)
            returning tp.post_id`,
    [ws, userId, "@" + username.replace(/^@/, "")]);
  for (const r of rows) await rekeyLegacy("threads", r.post_id, userId);
}

/** Чужий пост (не цього акаунта) чи пост видалено - Threads каже саме так; решта збоїв (мережа, ліміт) - ні. */
const notOwnPost = (msg: string) => /does not exist|cannot be loaded|missing permission|unsupported get request/i.test(String(msg || ""));
const probing = new Set<string>();

/**
 * Старі пости Threads без акаунта: опубліковані до того, як ми його записували, і без посилання, з
 * якого він видний. Правило «такий пост - основного акаунта» хибне, щойно основний змінився (28.09:
 * 7 постів @rozum.one після перепідключення рахувались постами @olegalisio - їхня статистика падала,
 * а в Аналітиці вони тягнули норму не того профілю). Питаємо Threads токеном кожного акаунта бренду:
 * свій пост токен бачить, чужий - ні. Разово, коли акаунтів стало кілька чи змінився основний; до 100
 * найновіших. Мережевий збій зупиняє прохід - решту визначить наступна зміна акаунтів.
 */
export async function probeThreadsRows(ws: string): Promise<number> {
  if (probing.has(ws)) return 0;
  probing.add(ws);
  try {
    const accs = await threadsAccounts(ws);
    if (accs.length < 2) return 0;
    const rows = await q<{ id: string; media_id: string; post_id: string }>(
      `select tp.id, tp.media_id, tp.post_id from threads_publish tp join post p on p.id=tp.post_id join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
        where s.workspace_id=$1 and tp.status='sent' and tp.account_id is null and tp.account_name is null and coalesce(tp.media_id,'')<>''
        order by tp.created_at desc limit 100`, [ws]);
    if (!rows.length) return 0;
    const logins: ThreadsLogin[] = [];
    for (const a of accs) { const t = await threadsToken(ws, a.userId); if (t) logins.push(t); }
    const byName = new Map(accs.map((a) => [a.username.toLowerCase(), a] as const));
    const until = Date.now() + 90_000;
    let found = 0;
    for (const r of rows) {
      if (Date.now() > until) break;
      for (const t of logins) {
        let hit: { username: string; permalink: string };
        try { hit = await threads.mediaOwner(t.token, r.media_id); }
        catch (e: any) { if (notOwnPost(e?.message)) continue; return found; }
        // ник у відповіді - хто автор; нема ника - автор той, чий токен пост побачив. Автор не з цього
        // бренду (пост видно, а ник чужий) - нікому не приписуємо
        const name = hit.username.replace(/^@/, "").toLowerCase();
        const who = name ? byName.get(name) : accs.find((a) => a.userId === t.userId);
        if (!who) break;
        await q(`update threads_publish set account_id=$2, account_name=$3, permalink=coalesce(permalink, nullif($4,'')) where id=$1 and account_id is null`,
          [r.id, who.userId, at(who.username), hit.permalink]);
        await rekeyLegacy("threads", r.post_id, who.userId);
        found++;
        break;
      }
    }
    if (found)
      await logEvent("info", "threads", `визначено акаунт у ${found} старих публікаціях (з ${rows.length} без акаунта)`, { ws });
    return found;
  } finally { probing.delete(ws); }
}

/** Зробити додатковий акаунт Threads основним (колишній основний лишається додатковим). */
export async function setMainThreads(ws: string, userId: string): Promise<boolean> {
  const ok = await tx(async (c) => {
    const main = await c.one<ThRow>(`select threads_user_id, username, access_token, token_expires_at from threads_config where workspace_id=$1 for update`, [ws]);
    if (!main?.threads_user_id) return false;
    if (main.threads_user_id === userId) return true;
    const ex = await c.one<ThRow>(`select threads_user_id, username, access_token, token_expires_at from threads_account where workspace_id=$1 and threads_user_id=$2 for update`, [ws, userId]);
    if (!ex?.access_token) return false;
    if (main.access_token)
      await c.q(`insert into threads_account(workspace_id, threads_user_id, username, access_token, token_expires_at) values($1,$2,$3,$4,$5)
                 on conflict (workspace_id, threads_user_id) do update set username=excluded.username, access_token=excluded.access_token,
                   token_expires_at=excluded.token_expires_at, updated_at=now()`,
        [ws, main.threads_user_id, main.username, main.access_token, main.token_expires_at]);
    await c.q(`update threads_config set threads_user_id=$2, username=$3, access_token=$4, token_expires_at=$5, updated_at=now() where workspace_id=$1`,
      [ws, ex.threads_user_id, ex.username, ex.access_token, ex.token_expires_at]);
    await c.q(`delete from threads_account where workspace_id=$1 and threads_user_id=$2`, [ws, userId]);
    return true;
  });
  if (ok) {
    await q(`delete from settings_block where workspace_id=$1 and key='threads_an_cache'`, [ws]);
    // пост без акаунта рахується постом основного - основний змінився, тож визначаємо такі пости
    void probeThreadsRows(ws).catch(() => {});
  }
  return ok;
}

/** Прибрати акаунт Threads. Основний заміняє перший додатковий; останній - повне відключення. */
export async function removeThreadsAccount(ws: string, userId: string): Promise<"extra" | "main" | "last" | "none"> {
  const r = await tx(async (c) => {
    const main = await c.one<{ threads_user_id: string | null }>(`select threads_user_id from threads_config where workspace_id=$1 for update`, [ws]);
    if (main?.threads_user_id === userId) {
      const next = await c.one<ThRow>(
        `select threads_user_id, username, access_token, token_expires_at from threads_account where workspace_id=$1 and threads_user_id<>$2
          order by added_at, threads_user_id limit 1 for update`, [ws, userId]);
      if (!next) { await c.q(`delete from threads_config where workspace_id=$1`, [ws]); await c.q(`delete from threads_account where workspace_id=$1`, [ws]); return "last" as const; }
      await c.q(`update threads_config set threads_user_id=$2, username=$3, access_token=$4, token_expires_at=$5, updated_at=now() where workspace_id=$1`,
        [ws, next.threads_user_id, next.username, next.access_token, next.token_expires_at]);
      await c.q(`delete from threads_account where workspace_id=$1 and threads_user_id=$2`, [ws, next.threads_user_id]);
      return "main" as const;
    }
    const d = await c.q(`delete from threads_account where workspace_id=$1 and threads_user_id=$2 returning threads_user_id`, [ws, userId]);
    return d.length ? ("extra" as const) : ("none" as const);
  });
  if (r === "main" || r === "last") await q(`delete from settings_block where workspace_id=$1 and key='threads_an_cache'`, [ws]);
  return r;
}

// ---------------------------------------------------------------- вибір у кабінеті й конекторі
// ---------------------------------------------------------------- Telegram (канали й групи)
export type TgTarget = { id: string; name: string; main: boolean; kind: "channel" | "group" | "extra"; username: string | null };
type TgCfg = { bot_token: string | null; channel_chat_id: string | null; channel_title: string | null; channel_username: string | null; group_chat_id: string | null; group_title: string | null };
/** Куди бренд публікує в Telegram: основні канал і група (telegram_config) - вони й отримують пост без
 *  вибору, як завжди, - плюс додаткові канали (telegram_chat). Той самий бот, токен - один. */
export async function telegramTargets(ws: string): Promise<{ token: string | null; targets: TgTarget[] }> {
  const [c, extra] = await Promise.all([
    one<TgCfg>(`select bot_token, channel_chat_id, channel_title, channel_username, group_chat_id, group_title from telegram_config where workspace_id=$1`, [ws]),
    q<{ chat_id: string; title: string | null; username: string | null }>(`select chat_id, title, username from telegram_chat where workspace_id=$1 order by added_at, chat_id`, [ws]),
  ]);
  const out: TgTarget[] = [];
  if (c?.channel_chat_id) out.push({ id: c.channel_chat_id, name: c.channel_title || at(c.channel_username) || c.channel_chat_id, main: true, kind: "channel", username: c.channel_username || null });
  if (c?.group_chat_id && c.group_chat_id !== c.channel_chat_id) out.push({ id: c.group_chat_id, name: c.group_title || c.group_chat_id, main: true, kind: "group", username: null });
  for (const e of extra) if (!out.some((o) => o.id === e.chat_id))
    out.push({ id: e.chat_id, name: e.title || at(e.username) || e.chat_id, main: false, kind: "extra", username: e.username || null });
  return { token: c?.bot_token || null, targets: out };
}

/** Акаунти, які можна обрати для поста, по мережах (без токенів). main - той, куди пост піде без вибору
 *  (у Telegram таких двоє: основні канал і група). */
export async function accountChoices(ws: string): Promise<Record<AccNet, AccountChoice[]>> {
  const [pages, th, tgt] = await Promise.all([metaPages(ws), threadsAccounts(ws), telegramTargets(ws)]);
  const ig = defaultIg(pages);
  return {
    facebook: pages.map((p) => ({ id: p.pageId, name: p.pageName, main: p.main })),
    instagram: pages.filter((p) => p.igUserId).map((p) => ({ id: p.igUserId!, name: at(p.igUsername) || p.igUserId!, main: p === ig })),
    threads: th.map((a) => ({ id: a.userId, name: at(a.username) || a.userId, main: a.main })),
    telegram: tgt.token ? tgt.targets.map((t) => ({ id: t.id, name: t.name, main: t.main })) : [],
  };
}

/** Обрані в пості акаунти мережі (id, по порядку, без повторів); порожньо - за замовчуванням. Пост,
 *  збережений до галочок, мав одне `account` - це список з одного. */
export function postAccounts(channels: any, net: string): string[] {
  const c = channels && typeof channels === "object" ? channels[net] : null;
  if (!c || typeof c !== "object") return [];
  const raw: unknown[] = Array.isArray(c.accounts) ? c.accounts : typeof c.account === "string" ? [c.account] : [];
  const out: string[] = [];
  for (const x of raw) { const v = String(x ?? "").trim(); if (v && !out.includes(v) && out.length < 20) out.push(v); }
  return out;
}
/** Перший обраний акаунт мережі (id) або null - за замовчуванням (там, де акаунт може бути один:
 *  нік на кадрах каруселі, свій нік для співавторів Instagram). */
export function postAccount(channels: any, net: string): string | null {
  return postAccounts(channels, net)[0] || null;
}

/** Знайти акаунт мережі за тим, як його назвала людина чи модель: id, @нік, назва Сторінки. */
export function matchAccount(list: AccountChoice[], wanted: string): AccountChoice | null {
  const w = String(wanted || "").trim().replace(/^@/, "").toLowerCase();
  if (!w) return null;
  return list.find((a) => a.id === w) || list.find((a) => a.name.replace(/^@/, "").toLowerCase() === w)
    || list.find((a) => a.name.replace(/^@/, "").toLowerCase().includes(w)) || null;
}

/** Скільки ще НЕопублікованих цим акаунтом постів бренду обрали його (попередити перед «прибрати»). */
export async function postsUsingAccount(ws: string, pairs: { net: AccNet; id: string }[]): Promise<number> {
  if (!pairs.length) return 0;
  const conds = pairs.map((_, i) => `((p.channels->$${2 + i * 2}::text->>'account' = $${3 + i * 2} or coalesce(p.channels->$${2 + i * 2}::text->'accounts', '[]'::jsonb) ? $${3 + i * 2})
      and p.channels->$${2 + i * 2}::text->>'on' = 'true'
      and not exists (select 1 from (select post_id, 'threads'::text as net, account_id as acc from threads_publish where status='sent'
                                     union all select post_id, channel, account_id from meta_publish where status='sent'
                                     union all select post_id, 'telegram', chat_id from telegram_publish where status='sent') x
                       where x.post_id=p.id and x.net=$${2 + i * 2} and x.acc=$${3 + i * 2}))`).join(" or ");
  const r = await one<{ n: number }>(
    `select count(*)::int n from post p join pipeline_run r on r.id=p.run_id join source s on s.id=r.source_id
      where s.workspace_id=$1 and p.stage='final' and coalesce(p.review,'')<>'archived' and (${conds})`,
    [ws, ...pairs.flatMap((x) => [x.net, x.id])]);
  return r?.n || 0;
}

/** Акаунти «за замовчуванням» по мережах (id) - куди піде пост без явного вибору (Telegram - основний
 *  канал, а без нього група). */
export async function mainAccountIds(ws: string): Promise<Record<AccNet, string>> {
  const ch = await accountChoices(ws);
  const pick = (l: AccountChoice[]) => (l.find((a) => a.main) || l[0])?.id || "";
  return { facebook: pick(ch.facebook), instagram: pick(ch.instagram), threads: pick(ch.threads), telegram: pick(ch.telegram) };
}

/** Ключ «мережа + акаунт» для порівнянь (дублі в розкладі): мережі без вибору акаунта - просто мережа. */
export function netKey(net: string, account: string | null | undefined, mains: Record<string, string>): string {
  return isAccNet(net) ? `${net}|${account || mains[net] || ""}` : net;
}

/** Старому рядку публікації щойно визначили акаунт (нік із посилання, питання до Threads): перший
 *  коментар і метрики цієї публікації жили під ключем '' - переносимо їх під ключ акаунта, інакше
 *  аналітика й «надіслати коментар» їх не знайдуть. Лише коли в мережу в поста інших публікацій без
 *  акаунта нема (тоді '' належить саме цій). */
export async function rekeyLegacy(net: string, postId: string, account: string): Promise<void> {
  const table = net === "threads" ? "threads_publish" : "meta_publish";
  const chan = net === "threads" ? "" : " and channel=$2";
  const orphan = await one<{ n: number }>(`select count(*)::int n from ${table} where post_id=$1${chan} and account_id is null`, net === "threads" ? [postId] : [postId, net]);
  if ((orphan?.n || 0) > 0) return;
  for (const t of ["post_comment", "post_metric"])
    await q(`update ${t} set account=$3 where post_id=$1 and network=$2 and account=''
               and not exists (select 1 from ${t} x where x.post_id=$1 and x.network=$2 and x.account=$3)`, [postId, net, account]);
}
