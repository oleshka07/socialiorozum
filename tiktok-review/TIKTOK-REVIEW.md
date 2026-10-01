# TikTok App Review: що налаштувати, що записати і що вписати · 01.10.2026

> **Holos by Rozum.** Застосунок TikTok for Developers належить Swipe Scape s.r.o. Website URL -
> `https://holos.rozum.one`, тож і відео для перевірки записуємо на `holos.rozum.one`: TikTok відхиляє
> заявку, коли домен на відео не збігається з Website URL. Кнопки **Submit** тисне Олег. Ключів і
> паролів у цьому файлі нема й не буде.

## Порядок (саме такий)

1. **Застосунок (Production) - зберегти, але не подавати.** Basic information, продукти й дозволи (нижче).
   Поле «demo video» заповнюється в самому кінці: відео можна записати лише після кроків 2-4.
2. **Sandbox.** У ньому свої Client key і Client secret (починаються з `sb`). До перевірки TikTok
   інтеграцію показують саме в sandbox - так написано у формі TikTok.
3. **Ключі sandbox → Holos:** Налаштування → Профіль → 🔑 Ключі провайдерів → 🌐 Застосунки мереж →
   «TikTok: Client key» і «TikTok: Client secret». Картка TikTok у Каналах після цього каже «🧪 Тестовий
   режим TikTok (Sandbox)».
4. **Підключити TikTok і перевірити:** Налаштування → Канали → TikTok → «🔗 Підключити TikTok».
5. **Записати відео** (сценарій нижче) і **подати** застосунок.

## Застосунок (Production)

- **Basic information:** назва Holos (слово TikTok у назві заборонене); іконка 1024 - `meta-review/holos-icon-1024.png`;
  категорія Business або Productivity; опис (нижче); Terms of Service `https://holos.rozum.one/terms`;
  Privacy Policy `https://holos.rozum.one/privacy`; Platforms → Web → `https://holos.rozum.one`.
  Посилання на умови й політику TikTok вимагає видимими на сайті без меню - вони в підвалі головної.
- **Products:** Login Kit (Web, Redirect URI `https://holos.rozum.one/api/integrations/tiktok/callback`
  і `https://beta.holos.rozum.one/api/integrations/tiktok/callback`) і Content Posting API з увімкненим
  **Direct Post**.
- **Scopes:** рівно `user.info.basic`, `video.upload`, `video.publish`. Інших продуктів і дозволів не
  додавати: усе обране має бути на відео, інакше перевірка затягнеться.
- **URL properties / Verify** - **не потрібно.** Перевірка домену TikTok потрібна лише для `PULL_FROM_URL`,
  а Holos заливає файл сам (`FILE_UPLOAD`).

Опис застосунку (англійською):

> Holos is a content assistant for small businesses, experts and creators. People connect their own
> TikTok account and publish short vertical videos they created and approved in Holos - right away or
> at a scheduled time, or as a draft they finish in the TikTok app. Before anything is posted, Holos
> shows the creator's TikTok nickname and lets them choose who can view the video, whether comments,
> Duet and Stitch are allowed, and whether it is promotional or branded content; the video is posted
> only after the creator confirms. Holos only uploads the creator's own videos and does not read their
> other videos, followers or messages.

## Sandbox

1. Сторінка застосунку → перемикач угорі **Production / Sandbox** → **Create sandbox** (назва будь-яка, напр. Holos test).
2. У sandbox - ті самі продукти й дозволи, що вище (Login Kit з обома Redirect URI, Content Posting API з Direct Post).
3. **Sandbox settings → Target users → Add account** → увійти тим TikTok, у який публікуватиме Holos.
   Підключитись до sandbox-застосунку можуть лише ці акаунти (до 10).
4. Скопіювати **Client key** і **Client secret** саме sandbox (вони окремі від Production).

**Обмеження до перевірки (так у TikTok):** пряма публікація лише з «Хто бачить: Лише я» (`SELF_ONLY`), сам
акаунт TikTok у мить публікації має бути **приватним**, не більше 5 людей на добу. Чернетки (`video.upload`)
працюють і так. Зробити акаунт приватним: TikTok → Профіль → ☰ → Налаштування й конфіденційність →
Конфіденційність → Приватний акаунт (після перевірки можна повернути).

## Відео для перевірки

Вимоги TikTok: щонайменше одне відео з повним шляхом інтеграції; до 5 файлів, MP4 чи MOV, до 50 МБ
кожен; має бути видно інтерфейс сайту і дії людини; домен на відео = Website URL; кожен обраний продукт
і дозвіл показаний.

**Інтерфейс англійською:** відкрий кабінет посиланням
**`https://holos.rozum.one/app?review=tiktok#/settings/channels`** - меню, Канали, Чорновики, редактор
поста й блок TikTok стануть англійською (словами самого TikTok: «Who can view this video», «Allow users
to», «Disclose video content», «Music Usage Confirmation»), а вгорі темна смуга пояснює, що на екрані і
який дозвіл тут працює. Картка TikTok у Каналах підсвічена. Вимкнути - `?review=off` або ✕ на смузі.

**Перед записом:** акаунт TikTok - приватний; коротке вертикальне відео (5-30 с, своє) на комп'ютері;
підпис до відео англійською; вікно браузера ~1280×800 з видимим рядком адреси (`holos.rozum.one`).

**Кліп 1 - Login Kit і `user.info.basic` (~40 с).**
Канали → картка TikTok → «🔗 Connect TikTok» → сторінка TikTok з назвою застосунку й переліком дозволів →
увійти акаунтом із Target users → Authorize → назад у Holos: «✅ Connected as <імʼя> @<нік>» з аватаром.

**Кліп 2 - Direct Post і `video.publish` (~2 хв).**
Create → Drafts → «✍️ New post» → «🎬 Video» → «⬆ Upload from computer» → відео → підпис англійською → у «Networks»
лише TikTok → блок TikTok: «Posting to TikTok as <імʼя> @<нік>» → «Post now» → розкрити «Who can view this
video» (типового нема) → «Only me» → позначити «Comment» (сіре - вимкнене в налаштуваннях TikTok) →
увімкнути «Disclose video content»: показати «Your brand» і «Branded content» (при «Only me» - сірий, з
поясненням), позначити «Your brand» → рядок «Your video will be labeled as “Promotional content”» →
(зняти «Disclose video content», якщо не треба) → рядок «By posting, you agree to TikTok’s Music Usage
Confirmation» → показати прев'ю праворуч → «📣 Publish now» → «⏳ TikTok is processing the video…» →
за хвилину-дві зʼявиться «↗ Open post» (редактор сам перечитує стан) → відкрити → відео на tiktok.com.

**Кліп 3 - чернетка і `video.upload` (~1 хв).**
Drafts → «✍️ New post» → «🎬 Video» → відео → TikTok → «Send to TikTok drafts» → «⧉ Copy caption» → «📣 Publish now» → «The
video is in your TikTok inbox». Далі запис екрана телефона: TikTok → сповіщення про чернетку (або Профіль →
Чернетки) → відкрити ту саму чернетку.

Файл більший за 50 МБ - стиснути (або поділити) перед завантаженням.

## Тексти у формі «Explain how each product and scope works»

**Login Kit / `user.info.basic`:**

> In Holos (holos.rozum.one) the user opens Settings → Channels → TikTok and clicks “Connect TikTok”. Login
> Kit asks them to authorize Holos. We use user.info.basic only to show the connected account’s display name
> and avatar in Channels and in the post editor, so the user always knows which TikTok account their videos
> go to. We store the open_id and the tokens needed to post on the user’s behalf; the user can disconnect at
> any time (Channels → TikTok → Disconnect).

**Content Posting API / `video.publish` (Direct Post):**

> The user creates a post with their own video in Holos and turns on TikTok. Before posting, Holos calls
> creator_info and shows the creator’s nickname and avatar, the privacy options returned by TikTok with no
> default (the user must choose), Comment / Duet / Stitch unchecked by default (greyed out when the creator
> turned them off), the “Disclose video content” toggle with “Your brand” / “Branded content” and the
> “Promotional content” / “Paid partnership” label (branded content cannot be private), and the Music Usage
> Confirmation (plus the Branded Content Policy when branded content is selected). The caption is shown in
> the preview and posted exactly as the user sees it. Nothing is uploaded until the user clicks “Publish
> now” (or the time they scheduled). Holos then uploads the file (FILE_UPLOAD), polls the post status, tells
> the user that processing may take a few minutes and shows the link to the post when it is ready.

**Content Posting API / `video.upload` (Upload as draft):**

> If the user chooses “Send to TikTok drafts”, Holos uploads the video to the user’s TikTok inbox
> (FILE_UPLOAD). The user gets a TikTok notification, opens the draft in the TikTok app, edits it and posts
> it there. Holos shows the caption so the user can copy it into TikTok.

## Після схвалення

- Ключі Production → туди ж, у «🔑 Ключі провайдерів» (замість sandbox); людям підключити TikTok ще раз.
- Публічні пости (не лише «Лише я») - окрема перевірка Direct Post (audit) у TikTok for Developers. До
  неї Holos сам кладе відео в чернетки, коли TikTok не пускає пряму публікацію, і каже чому.
