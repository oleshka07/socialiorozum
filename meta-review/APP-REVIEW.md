# Meta App Review: що саме знімати і що вписувати · оновлено 26.09.2026

Два застосунки, дві окремі заявки:

| Застосунок | App ID | Навіщо | Дозволи на ревʼю |
|---|---|---|---|
| **ROZUM Marketing Pulse** | `1255606142995192` | Facebook-Сторінка + Instagram | 9 (3 нові: коментарі й статистика) |
| **Threads** | `1347525417441376` | Threads | 4 |

Кнопки **Submit** тиснеш ти. Паролів і токенів у цьому файлі нема й не буде.

---

## Що змінилось проти версії від 11.07

- **Англійські підписи вбудовані.** Meta вимагає англійський інтерфейс або англійські субтитри, а
  socialio український. Відкрий кабінет посиланням **`https://socialio.rozum.one/login?review=en`**:
  угорі зʼявиться темна смуга англійською - що на екрані і який дозвіл тут працює (у композері,
  Каналах, Аналітиці - свій текст). Монтувати субтитри не треба. Сова-помічник у цьому режимі
  схована. Вимкнути - ✕ на смузі.
- **Нові дозволи:** `instagram_manage_comments` і `pages_manage_engagement` (перший коментар під
  постом), `read_insights` (перегляди дописів Facebook в Аналітиці).
- **Threads:** додався `threads_manage_replies` (реплай-коуч: відповіді на коментарі під твоїми
  постами).
- **Правила Meta (з їхньої документації):** окреме відео на кожен дозвіл (одне відео можна
  завантажити до кількох дозволів, якщо воно показує кожен із них); видно вхід через Facebook Login
  і що дозвіл дає користувачу; англійською або з англійськими підписами; висока роздільність, видно
  курсор; **за останні 30 днів перед поданням - хоча б один успішний виклик API з кожним дозволом**
  (запис нижче якраз їх і робить).

---

## Крок 0. Один раз перед записом

1. **Прод має містити нові функції.** Перший коментар, Аналітика 2.0 і англійські підписи зараз лише
   на беті (`beta.socialio.rozum.one`, за PIN). Рецензент ходить на прод, тож спершу промоушн беті
   на прод (merge `beta` → `main`, робить Claude після твого «так»).
2. **Додати 3 нові дозволи в застосунок Meta.** developers.facebook.com → My Apps → ROZUM Marketing
   Pulse → **Use cases** → сценарій із Facebook-Сторінкою → **Customize** → додати
   `pages_manage_engagement` і `read_insights`; сценарій з Instagram → додати
   `instagram_manage_comments`. **Save.** Без цього кнопки «💬 Дозволити коментарі» і «📈 Дозволити
   статистику» в socialio відкриють вікно Meta з помилкою «Invalid Scopes».
3. **Мова Facebook - англійська** (Facebook → Settings & privacy → Language) - тоді й вікно входу
   Facebook у записі буде англійською.
4. **Тестовий акаунт socialio для рецензента** (Facebook-пароль рецензенту давати заборонено, лише
   вхід у socialio):
   - зареєструйся на `https://socialio.rozum.one/register` з адресою-псевдонімом
     `o.stepeniev+metareview@swipescape.eu` (socialio такі адреси приймає, а лист підтвердження
     прийде в твою ж скриньку);
   - у цьому акаунті: Налаштування → Канали → Facebook + Instagram → «🔗 Підключити» → твій Facebook
     → обрати **демо-Сторінку** з привʼязаним Instagram (бізнес або автор, 3-5 постів);
   - там же «💬 Дозволити коментарі» і «📈 Дозволити статистику»;
   - пройди онбординг і зроби 2-3 чернетки, щоб рецензент прийшов у живий кабінет.
5. **Чим знімати:** Windows - Win+Alt+R (Xbox Game Bar) або OBS; 1920×1080, курсор видно. Окреме
   вікно браузера, без зайвих вкладок і сповіщень.

---

## Крок 1. Чотири відео (кожне 2-4 хв, усе - у тестовому акаунті на проді)

Перед кожним записом відкрий `https://socialio.rozum.one/login?review=en` - смуга англійською
зʼявиться сама. Назви кнопок нижче - як у кабінеті.

### Відео 1 - Підключення і публікація
Дозволи: `pages_show_list`, `instagram_basic`, `pages_manage_posts`, `instagram_content_publish`
1. Сторінка входу socialio → email і пароль тестового акаунта → «Увійти».
2. Налаштування (меню аватара) → вкладка **«Канали»** → картка **«Facebook + Instagram»** →
   «Відключити» (щоб показати вхід заново) → **«🔗 Підключити»**.
3. Вікно Facebook: увійти, **повільно прогорнути список дозволів**, обрати демо-Сторінку →
   підтвердити. Назад у socialio: «✅ Підключено · FB: Сторінка · IG: @акаунт», **розкрити список
   Сторінок** (`pages_show_list`).
4. **«✨ Голос з Instagram»** → повідомлення, що голос виведено з N постів (`instagram_basic`).
5. «Створення» → будь-яка чернетка → **«✍ Редагувати»** → у композері лишити **Facebook** і
   **Instagram** (у поста має бути фото) → **«📣 Опублікувати зараз»** → дочекатись «Опубліковано».
6. Під прев'ю кожної мережі **«↗ Відкрити пост»** → показати пост на Сторінці і в Instagram.

### Відео 2 - Перший коментар
Дозволи: `instagram_manage_comments`, `pages_manage_engagement`
1. Налаштування → «Канали» → «Facebook + Instagram» → **«💬 Дозволити коментарі»** → вікно
   Facebook, видно два нові дозволи → підтвердити → у картці «💬 Перший коментар ✓ дозволено».
2. Нова чернетка → «✍ Редагувати» → Facebook і Instagram → у полі **«💬 Перший коментар»** написати,
   наприклад, `More photos and prices: https://socialio.rozum.one` → праворуч у прев'ю видно коментар
   під постом у кожній мережі.
3. **«📣 Опублікувати зараз»** → під прев'ю «💬 ✓ опубліковано».
4. «↗ Відкрити пост» → показати під постом в Instagram і на Сторінці коментар від імені акаунта.

### Відео 3 - Статистика
Дозволи: `pages_read_engagement`, `instagram_manage_insights`, `read_insights`
1. Налаштування → «Канали» → «Facebook + Instagram» → **«📈 Дозволити статистику»** → вікно
   Facebook (`read_insights`) → підтвердити → «✓ дозволено».
2. **«📊 Статистика»** у тій самій картці - підписники Сторінки й Instagram.
3. **«Аналітика»** → **«↻ Оновити статистику»** → дочекатись → фільтр мережі **Instagram**: у таблиці
   перегляди, охоплення, лайки, коментарі, збереження, нові підписники по кожному посту
   (`instagram_manage_insights`); фільтр **Facebook**: перегляди (`read_insights`), реакції, коментарі,
   поширення (`pages_read_engagement`); графік підписників.
   Свіжий пост (молодший за 2 доби) позначено «🕐 набирає» - це нормально.

### Відео 4 - Threads (інший застосунок)
Дозволи: `threads_basic`, `threads_content_publish`, `threads_manage_insights`, `threads_manage_replies`
1. Налаштування → «Канали» → **Threads** → «Відключити» → **«Підключити»** → «✓ Підключити цей» →
   вікно Threads, видно дозволи → підтвердити → «Підключено @акаунт» (`threads_basic`).
2. Чернетка → «✍ Редагувати» → лише **Threads** → перший коментар (у Threads це відповідь автора під
   постом) → «📣 Опублікувати зараз» → «↗ Відкрити пост» → пост і відповідь у Threads
   (`threads_content_publish`).
3. «Аналітика» → фільтр **Threads** → перегляди, лайки, відповіді, репости по постах
   (`threads_manage_insights`).
4. «Аналітика» → панель Threads → **«💬 Коменти»** → коментарі інших людей під твоїми постами з
   чернеткою відповіді → поправити → **«↩ Відповісти»** → показати відповідь у Threads
   (`threads_manage_replies`).

Якщо Threads-акаунт тестера ще не в Threads Testers - спершу додай його (App roles → Roles → Threads
Testers) і прийми запрошення в Threads: Налаштування → Акаунт → Дозволи вебсайтів → Запрошення.

---

## Крок 2. Подання - ROZUM Marketing Pulse (1255606142995192)

App Review → **Permissions and Features** → навпроти кожного дозволу **Request advanced access** →
вписати текст нижче, завантажити відео, у полі нотаток - що саме на відео. `public_profile` уже
Advanced - не чіпай.

| Дозвіл | Відео | How will you use this permission (вставити як є) |
|---|---|---|
| `pages_show_list` | 1 | After the user logs in with Facebook, the app lists the Pages they manage so they can choose which Page (and its linked Instagram professional account) socialio publishes to. The list is shown in Settings → Channels. |
| `instagram_basic` | 1 | The app reads the connected Instagram professional account's username and the captions of the user's own recent posts: to confirm which account is connected and, when the user clicks “Voice from Instagram”, to learn the tone of voice for new posts. |
| `pages_manage_posts` | 1 | The app publishes the user's own approved posts (text and photos or video) to the Facebook Page the user selected, immediately or at a time the user schedules. |
| `instagram_content_publish` | 1 | The app publishes the user's own approved posts (photo, carousel or video with caption) to the user's Instagram professional account, immediately or at a scheduled time. |
| `instagram_manage_comments` | 2 | Right after publishing the user's post to their Instagram professional account, the app adds the user's own first comment under that post (for example hashtags or a link), which the user writes in the post editor. The app comments only on media it published for this user and does not read, hide or delete other people's comments. |
| `pages_manage_engagement` | 2 | Right after publishing the user's post to their Facebook Page, the app adds the Page's own first comment under that post (for example a link the user wrote, because links inside the post text reduce reach). The comment text is written by the user in the post editor. The app does not edit or delete other people's comments. |
| `pages_read_engagement` | 3 | The app reads engagement of the user's own Page posts (reactions, comments and shares) and the Page follower count to show the user how their published posts perform in the Analytics screen. |
| `instagram_manage_insights` | 3 | The app reads insights of the user's own Instagram media (views, reach, likes, comments, shares, saves, follows) and the account's follower count to show per-post performance and follower growth in the Analytics screen. |
| `read_insights` | 3 | The app reads insights of the user's own Page posts (media views and unique views) to show in the Analytics screen how many people saw each post the user published, compared with the user's typical post. |

## Крок 3. Подання - Threads (1347525417441376)

| Дозвіл | How will you use this permission |
|---|---|
| `threads_basic` | The app authorizes the user's Threads account and reads their basic profile (username) to confirm which account is connected. |
| `threads_content_publish` | The app publishes the user's own approved posts (text, photos or video) to their Threads account, now or at a scheduled time, and the user's own first reply under that post when the user wrote one. |
| `threads_manage_insights` | The app reads insights of the user's own Threads posts (views, likes, replies, reposts, quotes) and follower counts to show post performance in the Analytics screen. |
| `threads_manage_replies` | The app shows the replies other people left under the user's own recent Threads posts and lets the user answer them from the app: it suggests a draft, the user edits it and sends it as a reply from their account. |

## Інструкція для рецензента (поле Testing instructions, обидві заявки)

```
socialio is a content studio for small businesses: the owner writes posts in their own brand
voice and publishes them to their own Facebook Page, Instagram and Threads accounts.

Login (email + password, no Facebook account needed to log in):
https://socialio.rozum.one/login?review=en
The "?review=en" part shows English captions on every screen (the interface is in Ukrainian).
Email: ⟨email тестового акаунта⟩
Password: ⟨пароль тестового акаунта⟩

The test workspace is already connected to our demo Facebook Page and its Instagram account.
1. Settings (avatar menu) → "Канали" (Channels) → "Facebook + Instagram": the connected Page and
   Instagram account; the Page list shows the Pages the user manages.
2. "Створення" (Create) → any draft → "✍ Редагувати" (Edit): the post editor. Select Facebook
   and/or Instagram, optionally type a first comment in "💬 Перший коментар" (First comment),
   click "📣 Опублікувати зараз" (Publish now). "↗ Відкрити пост" (Open post) opens the live post.
3. "Аналітика" (Analytics) → "↻ Оновити статистику" (Refresh): per-post views, reach, likes,
   comments, shares, saves and follower counts.
```

---

## Після схвалення

- Застосунки перемкнути **Development → Live** (перемикач угорі біля назви).
- На сервері в `.env` прода `META_PUBLIC=1` і перестворити контейнер - тоді онбординг знову ставить
  Instagram першим кроком (зараз він другий із поміткою «поки для запрошених тестерів»).

## Поки ревʼю не схвалене

Людину без ролі в застосунку можна пустити тестером: App roles → Roles → Add People → Testers →
її Facebook; вона приймає запрошення (Facebook → Settings → Business Integrations). Для Threads -
Threads Testers і прийняти в Threads (Налаштування → Акаунт → Дозволи вебсайтів → Запрошення).

## Що вже є (не чіпати)

- Бізнес-верифікація ✅; іконка `app-icon-1024.png` у цій папці; Privacy Policy
  `https://socialio.rozum.one/privacy`, Terms `https://socialio.rozum.one/terms`, Data Deletion
  `https://socialio.rozum.one/data-deletion`.
- Redirect URI (Facebook Login → Settings → Valid OAuth Redirect URIs):
  `https://socialio.rozum.one/api/integrations/meta/callback` і
  `https://beta.socialio.rozum.one/api/integrations/meta/callback`; Threads:
  `https://socialio.rozum.one/api/integrations/threads/callback` (+ бета).
- Базове підключення socialio просить рівно 7 дозволів (`public_profile`, `pages_show_list`,
  `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`,
  `instagram_manage_insights`); коментарі й статистику - окремими кнопками, щоб базове підключення
  не ламалось, поки нових дозволів нема в застосунку.
