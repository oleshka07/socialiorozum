# Meta App Review — покрокова інструкція (socialio) · оновлено 2026-07-11

**Застосунок:** ROZUM Marketing Pulse · **App ID:** 1255606142995192 · developers.facebook.com → My Apps → цей застосунок.
**Мета:** отримати **Advanced Access** на дозволи → зовнішні користувачі зможуть підключати свої FB/IG (зараз у них помилка «Функция недоступна», бо App Review = Not submitted).

Бізнес-верифікація вже ✅. Кнопку **Submit** натискаєш ти — я лишаю це за тобою.

> ✅ **Перевірено в коді 2026-07-11:** усі 7 scope у запиті авторизації; сторінки `/privacy`, `/terms`, `/data-deletion` живі; Аналітика реально показує IG-охоплення 28д + підписників (`igInsights`); «Голос з Instagram» працює; публікація FB/IG через композер працює (IG потребує фото — наш композер завжди дає фото). Все, що в скрінкасті, — робочий прод-функціонал.

---

## КРОК 0. Підготовка (5 хв) — App settings → Basic
- **App icon:** завантаж `meta-review/app-icon-1024.png` (1024×1024).
- **Privacy Policy URL:** `https://socialio.rozum.one/privacy`
- **Terms of Service URL:** `https://socialio.rozum.one/terms`
- **User Data Deletion → Data Deletion Instructions URL:** `https://socialio.rozum.one/data-deletion`
- **Category:** Business and pages. → **Save changes**.

## КРОК 1. Redirect URI (1 хв) — Facebook Login for Business → Settings
У **Valid OAuth Redirect URIs** мають бути (обидва, бета — щоб тестери могли перевіряти там):
```
https://socialio.rozum.one/api/integrations/meta/callback
https://beta.socialio.rozum.one/api/integrations/meta/callback
```
(Save changes.) ⚠️ Але СКРІНКАСТ і тест-кроки для рецензента — тільки на ПРОДІ `socialio.rozum.one`.

## КРОК 2. Тестовий акаунт для рецензента (ВАЖЛИВО — без нього ревʼю завалять)
Рецензент має сам зайти в socialio і повторити всі дії. Google-логін для нього незручний → даємо **email+пароль** (наша реєстрація це вміє):

1. Створи поштову скриньку для ревʼю — будь-яку, яку контролюєш: найпростіше **новий Gmail** (напр. `socialio.metareview@gmail.com`), або скринька на своєму домені. Вона потрібна один раз — прийняти лист верифікації.
2. Відкрий `https://socialio.rozum.one` → **Реєстрація** → цей email + надійний пароль → підтверди лист (прийде від `socialio <noreply@rozum.one>`).
3. Залогінься цим акаунтом і **заздалегідь підключи** тестову FB-сторінку + IG (див. КРОК 3), пройди онбординг — щоб рецензент зайшов у ЖИВИЙ кабінет, а не порожній.
4. Ці email+пароль впишеш у форму сабміту в поле **Testing instructions / test credentials** разом із кроками (шаблон нижче).

**Шаблон для поля Testing instructions (англійською):**
```
Test credentials for our app (socialio):
URL: https://socialio.rozum.one
Email: <тут email>  Password: <тут пароль>

Steps: 1) Log in. 2) Settings → Канали → "Facebook + Instagram" → Connect (Facebook popup).
3) Onboarding derives brand voice from IG captions (instagram_basic).
4) Click "Згенерувати" to create posts. 5) Open a post → composer → select Facebook and/or
Instagram → "Опублікувати зараз" (pages_manage_posts, instagram_content_publish).
6) Analytics tab shows IG followers + 28-day reach and FB followers
(instagram_manage_insights, pages_read_engagement).
```

## КРОК 3. Тестові Meta-активи
Для скрінкаста і перевірки потрібні **реальні** сторінка+IG (Meta-«Test Users» не можуть мати справжній IG Business):
- FB-сторінка (можна створити нову «demo»-сторінку) + прив'язаний **Instagram Business/Creator** акаунт з кількома постами (щоб «Голос з Instagram» мав що читати).
- Акаунт Facebook, яким записуєш відео, додай у **App roles → Testers** (він приймає запрошення: Facebook → Settings → Business Integrations).

## КРОК 4. Advanced Access на дозволи — App Review → Permissions and Features
Навпроти КОЖНОГО → **Request Advanced Access**. Подаємо РІВНО ці 6 (інші не чіпай):

| Дозвіл | Навіщо (встав у «How will you use this permission») |
|---|---|
| **public_profile** | (Зазвичай Advanced за замовчуванням — нічого не робити.) |
| **pages_show_list** | After the user authorizes, the app lists their Facebook Pages so they can choose which Page (and its linked Instagram Business account) to connect for publishing. |
| **pages_read_engagement** | The app reads the connected Page's basic stats (followers) to show the user their publishing analytics inside the app's Analytics screen. |
| **pages_manage_posts** | The app publishes the user's own approved posts (text and image) to their selected Facebook Page — immediately or on a schedule they set. |
| **instagram_basic** | The app reads the connected Instagram Business account profile and recent post captions to (a) confirm the account, (b) derive the brand's tone of voice from the user's existing posts during onboarding, and (c) let the user add public business/creator accounts they choose as content-inspiration sources via the business_discovery field. |
| **instagram_content_publish** | The app publishes the user's own approved posts (image + caption) to their connected Instagram Business account — immediately or on a schedule. |
| **instagram_manage_insights** | The app shows the user their Instagram performance (reach for the last 28 days and follower count) in the Analytics screen so they can track how their published content performs. |

## КРОК 5. App Review → Requests → заповнити кожен дозвіл
Для кожного: use case (тексти вище) + познач, що дані використовуються лише для функцій застосунку (створення й публікація контенту в акаунти самого користувача), не передаються третім сторонам. Додай скрінкаст (КРОК 6) і тест-креденшели (КРОК 2).

## КРОК 6. Скрінкаст (1 відео, ~3 хв) — записати на ПРОДІ, тестовим акаунтом
Рецензент повторюватиме дії, тож усе має реально працювати. Покадрово (актуальні назви UI):
1. **Вхід:** `https://socialio.rozum.one` → увійти тестовим email → кабінет.
2. **Підключення (pages_show_list, instagram_basic):** **Налаштування → вкладка «Канали» → картка «Facebook + Instagram» → «🔗 Підключити»** → попап Facebook → дозволи → повернення в кабінет: покажи селектор сторінки (якщо їх кілька) і статус «Підключено» з @username IG.
3. **Голос з IG (instagram_basic):** кнопка **«✨ Голос з Instagram»** на тій самій картці (або крок онбордингу) → покажи повідомлення «голос виведено з N постів».
4. **(Опційно, підсилює instagram_basic):** Налаштування → Джерела → «📸 Instagram-сторінка» → додай публічну бізнес-сторінку → прев'ю останніх постів → «Підключити».
5. **Генерація:** «Згенерувати» → у Студії з'явились пости з зображеннями.
6. **Публікація у Facebook (pages_manage_posts):** відкрий пост → композер → чіп **Facebook** → «📣 Опублікувати зараз» → відкрий FB-сторінку в новій вкладці, покажи опублікований пост.
7. **Публікація в Instagram (instagram_content_publish):** той самий композер → чіп **Instagram** (пост має мати фото) → «Опублікувати» → відкрий IG-акаунт, покажи пост.
8. **Аналітика (pages_read_engagement, instagram_manage_insights):** розділ **Аналітика** → картка «📸 Instagram @…»: підписники + **«охоплення 28д»**, і рядок Facebook з підписниками.

Завантаж відео у форму сабміту (або unlisted-лінк YouTube/Drive).

## КРОК 7. Submit
App Review → перевір: 6 дозволів + use cases + відео + тест-креденшели → **Submit for review**. Очікування: дні-тижні. Після схвалення перемкни **App Mode: Development → Live** (угорі біля назви).

---

## ⚡ Поки ревʼю не схвалене — розблокувати конкретних людей
App roles → **Roles → Add People → Testers** → їхній Facebook → **вони мають ПРИЙНЯТИ** запрошення (Facebook → Settings → Business Integrations). Тоді підключаються без помилки.

## Threads — ОКРЕМА заявка на ОКРЕМОМУ застосунку
socialio Threads працює через **інший застосунок** (Threads API, `graph.threads.net`): **App ID `1347525417441376`** (НЕ Marketing Pulse 1255…). threads_* у черзі Marketing Pulse — **чужі** (Holos).

developers.facebook.com → застосунок **1347525417441376** → App Review. Потрібні рівно **3**:
| Дозвіл | Use case |
|---|---|
| **threads_basic** | Authorize the user's Threads account and read their basic profile to confirm the connection. |
| **threads_content_publish** | Publish the user's approved posts (text + optional image) to their own Threads account, now or on a schedule. |
| **threads_manage_insights** | Show the user the performance (views/likes) of their published Threads posts inside the app, including the daily digest that flags a top-performing post. |

Скрінкаст (цей застосунок, тестовий юзер): Налаштування → Канали → Threads → «Підключити» → авторизація → опублікувати пост → показати його в Threads (+ інсайти, за наявності).
Redirect URIs Threads-застосунку: `https://socialio.rozum.one/api/integrations/threads/callback` (+ `https://beta.socialio.rozum.one/...` для тестерів).
Застосунок 1347… після схвалення теж перемкнути в **Live**. Поки ні — додай тестера (і він приймає).
**Решта threads_*** (replies/mentions/delete/keyword_search/…) — socialio НЕ використовує, не запитуй.

## Що вже зроблено в коді (перевірено 2026-07-11)
- `META_SCOPES` = рівно 7 дозволів зі списку вище — нічого зайвого не запитуємо.
- `instagram_manage_insights` РЕАЛЬНО використовується: Аналітика → IG-охоплення 28д + підписники (`/api/integrations/meta/stats` → `igInsights`).
- `instagram_basic` має ТРИ живі демонстрації: підтвердження акаунта, «Голос з Instagram», IG-сторінки як джерела (business_discovery).
- Публікація: FB (текст/фото) і IG (фото+підпис) через композер і планувальник; «опубліковано один раз на мережу» захищає від дублів.
- Сторінки `/privacy`, `/terms`, `/data-deletion` живі; іконка 1024×1024 у цій папці.
- Реєстрація email+пароль з верифікацією — для тест-креденшелів рецензента.
