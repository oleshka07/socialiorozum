# Meta App Review — покрокова інструкція (socialio)

**Застосунок:** ROZUM Marketing Pulse · **App ID:** 1255606142995192 · developers.facebook.com → My Apps → цей застосунок.
**Мета:** отримати **Advanced Access** на дозволи → зовнішні користувачі зможуть підключати свої FB/IG (зараз помилка «Функция недоступна», бо App Review = Not submitted).

Бізнес-верифікація вже ✅. Сабміт (кнопку **Submit**) натискаєш ти — я лишаю це за тобою.

---

## КРОК 0. Підготовка (5 хв) — впиши в App settings → Basic
- **App icon:** завантаж `meta-review/app-icon-1024.png` (1024×1024).
- **Privacy Policy URL:** `https://socialio.rozum.one/privacy`
- **Terms of Service URL:** `https://socialio.rozum.one/terms`
- **User Data Deletion → Data Deletion Instructions URL:** `https://socialio.rozum.one/data-deletion`
- **Category:** Business and pages.
- Натисни **Save changes**.

## КРОК 1. Redirect URI (1 хв) — Facebook Login for Business → Settings
У полі **Valid OAuth Redirect URIs** має бути рівно:
```
https://socialio.rozum.one/api/integrations/meta/callback
```
(Save changes.) Без цього навіть тестери не підключаться.

## КРОК 2. Запросити Advanced Access на дозволи — App Review → Permissions and Features
Навпроти КОЖНОГО дозволу нижче → **Request Advanced Access**. Подаємо РІВНО ці 6 (інші ~30 не чіпай):

| Дозвіл | Навіщо (встав у «How will you use this permission») |
|---|---|
| **public_profile** | (Зазвичай Advanced за замовчуванням — нічого не робити.) |
| **pages_show_list** | After the user authorizes, the app lists their Facebook Pages so they can choose which Page (and its linked Instagram Business account) to connect for publishing. |
| **pages_read_engagement** | The app reads the connected Page's basic stats (followers) and post insights to show the user their publishing analytics inside the app's Analytics screen. |
| **pages_manage_posts** | The app publishes the user's own approved posts (text and image) to their selected Facebook Page — immediately or on a schedule they set. |
| **instagram_basic** | The app reads the connected Instagram Business account profile and recent post captions to (a) confirm the account and (b) derive the brand's tone of voice from the user's existing posts during onboarding. |
| **instagram_content_publish** | The app publishes the user's own approved posts (image + caption) to their connected Instagram Business account — immediately or on a schedule. |
| **instagram_manage_insights** | The app shows the user their Instagram performance (reach for the last 28 days and follower count) in the Analytics screen so they can track how their published content performs. |

## КРОК 3. App Review → Requests → заповнити кожен дозвіл
Для кожного: коротко опиши use case (тексти вище) + познач, що дані використовуються лише для функцій застосунку (створення й публікація контенту в акаунти самого користувача), не передаються третім. Додай скрінкаст (КРОК 4).

## КРОК 4. Скрінкаст (1 відео, ~2-3 хв) — записати на ТЕСТОВОМУ користувачі
Рецензент повторює дії, тож усе має реально працювати. Покадрово:
1. **Вхід:** відкрий `https://socialio.rozum.one`, увійди (Google) → кабінет.
2. **Підключення (pages_show_list, instagram_basic):** Налаштування → Meta → «Підключити» → у попапі Facebook обери акаунт → повертає в кабінет → покажи список/вибір сторінки та підключений IG (@username).
3. **Голос з IG (instagram_basic):** онбординг/кнопка «✨ Голос з Instagram» → показати «голос виведено з N постів».
4. **Генерація:** «Згенерувати пости» → у Студії з'явились пости (з зображеннями).
5. **Публікація у Facebook (pages_manage_posts):** відкрий пост → композер → обери Facebook → «Опублікувати зараз» → відкрий FB-сторінку, покажи опублікований пост.
6. **Публікація в Instagram (instagram_content_publish):** той самий композер → обери Instagram → «Опублікувати» → відкрий IG-акаунт, покажи пост.
7. **Аналітика (pages_read_engagement, instagram_manage_insights):** вкладка Аналітика → покажи картку Instagram (підписники + «охоплення 28д») і Facebook (підписники).

Завантаж відео у формі сабміту (або дай unlisted‑посилання на YouTube/Drive).

## КРОК 5. App Mode = Live
Угорі біля назви застосунку перемкни **Development → Live** (після проходження ревʼю дозволи стануть «Ready for live»).

## КРОК 6. Submit
App Review → перевір, що всі 6 дозволів у запиті + матеріали + відео → **Submit for review**. Очікування: зазвичай дні-тижні.

---

## ⚡ Поки ревʼю не схвалене — розблокувати конкретних людей
App roles → **Roles → Add People → Testers** → їхній Facebook → **вони мають ПРИЙНЯТИ** запрошення (Facebook → Settings → Business Integrations). Тоді підключаються без помилки.

## Threads — ОКРЕМО
Threads = окремий застосунок/ревʼю. Дозволи `threads_basic`, `threads_content_publish`, `threads_manage_insights`. Та сама логіка (use case + скрінкаст: підключення Threads → публікація поста). Redirect: `https://socialio.rozum.one/api/integrations/threads/callback`.

## Що вже зроблено в коді (мною)
- `instagram_content_publish` додано до scope (IG-публікація для не-адмінів).
- `instagram_manage_insights` тепер РЕАЛЬНО використовується: Аналітика показує IG-охоплення (28д) + підписників (ендпоінт `/api/integrations/meta/stats` → `igInsights`). Це робить дозвіл демонстрованим у ревʼю.
- Сторінка **`/data-deletion`** (вимога Meta) + іконка 1024×1024.
- Privacy/Terms вже були.
