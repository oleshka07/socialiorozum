# Meta App Review: що саме знімати і що вписувати · оновлено 28.09.2026 (вечір: скринька коментарів)

> **Holos by Rozum (колишній socialio).** Записуємо й подаємо вже після переїзду на `holos.rozum.one`: рецензент бачить ту саму назву й адресу, що й користувачі. У застосунку Meta (App settings → Basic) Privacy Policy, Terms і Data Deletion - теж на holos.rozum.one; адреси повернення додає картка «Holos: додати адресу holos.rozum.one…».

Один застосунок, у ньому два набори дозволів. Threads - не окремий застосунок, а use case «Access
the Threads API» усередині ROZUM Marketing Pulse; `1347525417441376` - його **Threads App ID** (так він
і стоїть у `THREADS_APP_ID`). Це знайшов Олег 27.09 у консолі Meta; до того ми вважали Threads
окремим застосунком.

| Що | ID | Навіщо | Дозволи на ревʼю |
|---|---|---|---|
| **ROZUM Marketing Pulse** | App ID `1255606142995192` | Facebook-Сторінка + Instagram | 10 (4 нові: коментарі, скринька коментарів, статистика) |
| **Threads у тому ж застосунку** | Threads App ID `1347525417441376` | Threads | 4 |

Подаються з App Review того самого застосунку; якщо Meta дозволить - однією заявкою.

Кнопки **Submit** тиснеш ти. Паролів і токенів у цьому файлі нема й не буде.

---

## Що змінилось проти версії від 11.07

- **Англійські підписи вбудовані.** Meta вимагає англійський інтерфейс або англійські субтитри, а
  Holos український. Відкрий кабінет посиланням **`https://holos.rozum.one/login?review=en`**:
  угорі зʼявиться темна смуга англійською - що на екрані і який дозвіл тут працює (у композері,
  Каналах, Аналітиці - свій текст). Монтувати субтитри не треба. Сова-помічник у цьому режимі
  схована. Вимкнути - ✕ на смузі.
- **Нові дозволи:** `instagram_manage_comments` і `pages_manage_engagement` (перший коментар під
  постом і відповіді людям), `read_insights` (перегляди дописів Facebook в Аналітиці),
  `pages_read_user_content` (читати коментарі людей під дописами Сторінки).
- **💬 Коментарі в одному місці (з 28.09):** плитка «💬 Коменти» на «Сьогодні» відкриває свіжі
  коментарі людей під постами в Instagram, на Сторінці й у Threads, з чернеткою відповіді. Тому текст
  для `instagram_manage_comments` переписано: застосунок тепер **читає** коментарі інших людей (раніше
  ми писали, що не читає, - це вже неправда), а для Facebook додано `pages_read_user_content`.
- **Threads:** додався `threads_manage_replies` (реплай-коуч: відповіді на коментарі під твоїми
  постами).
- **Правила Meta (з їхньої документації):** окреме відео на кожен дозвіл (одне відео можна
  завантажити до кількох дозволів, якщо воно показує кожен із них); видно вхід через Facebook Login
  і що дозвіл дає користувачу; англійською або з англійськими підписами; висока роздільність, видно
  курсор; **за останні 30 днів перед поданням - хоча б один успішний виклик API з кожним дозволом**
  (запис нижче якраз їх і робить).

---

## Крок 0. Один раз перед записом

1. **Прод уже містить усе потрібне** (перший коментар, Аналітика 2.0, англійські підписи - з 27.09).
   **Перевіряй і записуй лише на `holos.rozum.one`.** Адрес беті (`beta.holos.rozum.one`) у
   налаштуваннях Meta немає, тож там вікно Meta пише «URL Blocked» - 28.09 саме так і сталося.
   Кабінет тепер так і пояснює цю помилку (адреса й точне поле для адміна), а не «скасовано».
2. **Додати 4 нові дозволи в застосунок Meta.** developers.facebook.com → My Apps → ROZUM Marketing
   Pulse → **Use cases** → сценарій із Facebook-Сторінкою → **Customize** → додати
   `pages_manage_engagement`, `read_insights` і `pages_read_user_content`; сценарій з Instagram →
   додати `instagram_manage_comments`. **Save.** Без цього кнопки «💬 Дозволити коментарі»,
   «📈 Дозволити статистику» і «📥 Дозволити читати коментарі» в Holos відкриють вікно Meta з
   помилкою «Invalid Scopes».
3. **Мова Facebook - англійська** (Facebook → Settings & privacy → Language) - тоді й вікно входу
   Facebook у записі буде англійською.
4. **Тестовий акаунт Holos для рецензента** (Facebook-пароль рецензенту давати заборонено, лише
   вхід у Holos):
   - зареєструйся на `https://holos.rozum.one/register` з адресою-псевдонімом
     `o.stepeniev+metareview@swipescape.eu` (Holos такі адреси приймає, а лист підтвердження
     прийде в твою ж скриньку);
   - у цьому акаунті: Налаштування → Канали → Facebook + Instagram → «🔗 Підключити» → твій Facebook
     → обрати **демо-Сторінку** з привʼязаним Instagram (бізнес або автор, 3-5 постів);
   - там же «💬 Дозволити коментарі», «📈 Дозволити статистику» і «📥 Дозволити читати коментарі»;
   - **коментарі людей для відео 2:** опублікуй з Holos демо-пост у Facebook і Instagram, потім зі
     свого особистого Instagram (не демо-акаунта) залиш під ним коментар-питання, а у Facebook -
     коментар від свого профілю (у полі коментаря обери себе, а не Сторінку). Свої коментарі
     акаунта й Сторінки Holos у скриньці не показує - вони там і не потрібні;
   - пройди онбординг і зроби 2-3 чернетки, щоб рецензент прийшов у живий кабінет.
5. **Чим знімати:** Windows - Win+Alt+R (Xbox Game Bar) або OBS; 1920×1080, курсор видно. Окреме
   вікно браузера, без зайвих вкладок і сповіщень.

---

## Крок 1. Чотири відео (кожне 2-4 хв, усе - у тестовому акаунті на проді)

Перед кожним записом відкрий `https://holos.rozum.one/login?review=en` - смуга англійською
зʼявиться сама. Назви кнопок нижче - як у кабінеті.

### Відео 1 - Підключення і публікація
Дозволи: `pages_show_list`, `instagram_basic`, `pages_manage_posts`, `instagram_content_publish`
1. Сторінка входу Holos → email і пароль тестового акаунта → «Увійти».
2. Налаштування (меню аватара) → вкладка **«Канали»** → картка **«Facebook + Instagram»** →
   «Відключити» (щоб показати вхід заново) → **«🔗 Підключити»**.
3. Вікно Facebook: увійти, **повільно прогорнути список дозволів**, обрати демо-Сторінку →
   підтвердити. Назад у Holos: «✅ Підключено · FB: Сторінка · IG: @акаунт», **розкрити список
   Сторінок** (`pages_show_list`).
4. **«✨ Голос з Instagram»** → повідомлення, що голос виведено з N постів (`instagram_basic`).
5. «Створення» → будь-яка чернетка → **«✍ Редагувати»** → у композері лишити **Facebook** і
   **Instagram** (у поста має бути фото) → **«📣 Опублікувати зараз»** → дочекатись «Опубліковано».
6. Під прев'ю кожної мережі **«↗ Відкрити пост»** → показати пост на Сторінці і в Instagram.

### Відео 2 - Коментарі: перший коментар і відповіді людям
Дозволи: `instagram_manage_comments`, `pages_manage_engagement`, `pages_read_user_content`
1. Налаштування → «Канали» → «Facebook + Instagram» → **«💬 Дозволити коментарі»** → вікно
   Facebook, видно два нові дозволи → підтвердити → у картці «💬 Перший коментар ✓ дозволено».
2. Нова чернетка → «✍ Редагувати» → Facebook і Instagram → у полі **«💬 Перший коментар»** написати,
   наприклад, `More photos and prices: https://holos.rozum.one` → праворуч у прев'ю видно коментар
   під постом у кожній мережі.
3. **«📣 Опублікувати зараз»** → під прев'ю «💬 ✓ опубліковано».
4. «↗ Відкрити пост» → показати під постом в Instagram і на Сторінці коментар від імені акаунта.
5. Налаштування → «Канали» → «Facebook + Instagram» → **«📥 Дозволити читати коментарі»** → вікно
   Facebook (`pages_read_user_content`) → підтвердити → «✓ дозволено».
6. **«Сьогодні»** → плитка **«💬 Коменти»** → вікно «Коментарі під твоїми постами»: коментарі людей з
   Instagram (`instagram_manage_comments`) і зі Сторінки (`pages_read_user_content`), під кожним -
   чернетка відповіді.
7. Поправити чернетку під коментарем з Instagram → **«↩ Відповісти»** → «✓ відповідь від @акаунт»;
   те саме для Facebook (`pages_manage_engagement`). **«↗»** у картці → показати відповідь під
   коментарем у самій мережі.

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
| `pages_show_list` | 1 | After the user logs in with Facebook, the app lists the Pages they manage so they can choose which Page (and its linked Instagram professional account) Holos publishes to. The list is shown in Settings → Channels. |
| `instagram_basic` | 1 | The app reads the connected Instagram professional account's username and the captions of the user's own recent posts: to confirm which account is connected and, when the user clicks “Voice from Instagram”, to learn the tone of voice for new posts. |
| `pages_manage_posts` | 1 | The app publishes the user's own approved posts (text and photos or video) to the Facebook Page the user selected, immediately or at a time the user schedules. |
| `instagram_content_publish` | 1 | The app publishes the user's own approved posts (photo, carousel or video with caption) to the user's Instagram professional account, immediately or at a scheduled time. |
| `instagram_manage_comments` | 2 | Two uses, both on the user's own Instagram professional account. 1) Right after publishing the user's post, the app adds the user's own first comment under it (for example hashtags or a link) that the user wrote in the post editor. 2) The Comments inbox shows the comments other people left under the user's own recent posts, with a suggested reply; the user edits it and clicks Reply, and the app posts the reply from the user's account. The app does not hide or delete comments, and it keeps only the IDs of comments the user answered or skipped, so they are not shown again. |
| `pages_manage_engagement` | 2 | Right after publishing the user's post to their Facebook Page, the app adds the Page's own first comment under that post (for example a link the user wrote, because links inside the post text reduce reach). In the Comments inbox the user can also reply as the Page to comments people left under the Page's posts: the user edits the suggested reply and clicks Reply. The app does not edit or delete other people's comments. |
| `pages_read_user_content` | 2 | The Comments inbox reads the comments people left under the user's own Facebook Page posts from the last two weeks (comment text, commenter name, time) so the Page owner can see and answer them in one place together with Instagram. The comments are shown only to the Page's own team in Holos; the app stores only the IDs of comments the user answered or skipped. |
| `pages_read_engagement` | 3 | The app reads engagement of the user's own Page posts (reactions, comments and shares) and the Page follower count to show the user how their published posts perform in the Analytics screen. |
| `instagram_manage_insights` | 3 | The app reads insights of the user's own Instagram media (views, reach, likes, comments, shares, saves, follows) and the account's follower count to show per-post performance and follower growth in the Analytics screen. |
| `read_insights` | 3 | The app reads insights of the user's own Page posts (media views and unique views) to show in the Analytics screen how many people saw each post the user published, compared with the user's typical post. |

## Крок 3. Подання - Threads (той самий ROZUM Marketing Pulse, Threads App ID 1347525417441376)

| Дозвіл | How will you use this permission |
|---|---|
| `threads_basic` | The app authorizes the user's Threads account and reads their basic profile (username) to confirm which account is connected. |
| `threads_content_publish` | The app publishes the user's own approved posts (text, photos or video) to their Threads account, now or at a scheduled time, and the user's own first reply under that post when the user wrote one. |
| `threads_manage_insights` | The app reads insights of the user's own Threads posts (views, likes, replies, reposts, quotes) and follower counts to show post performance in the Analytics screen. |
| `threads_manage_replies` | The app shows the replies other people left under the user's own recent Threads posts and lets the user answer them from the app: it suggests a draft, the user edits it and sends it as a reply from their account. |

## Інструкція для рецензента (поле Testing instructions, обидві заявки)

```
Holos by Rozum is a content studio for small businesses: the owner writes posts in their own brand
voice and publishes them to their own Facebook Page, Instagram and Threads accounts.

Login (email + password, no Facebook account needed to log in):
https://holos.rozum.one/login?review=en
The "?review=en" part shows English captions on every screen (the interface is in Ukrainian).
Email: ⟨email тестового акаунта⟩
Password: ⟨пароль тестового акаунта⟩

The test workspace is already connected to our demo Facebook Page and its Instagram account.
The demo posts have a few comments from another account, so the Comments inbox is not empty.
1. Settings (avatar menu) → "Канали" (Channels) → "Facebook + Instagram": the connected Page and
   Instagram account; the Page list shows the Pages the user manages.
2. "Створення" (Create) → any draft → "✍ Редагувати" (Edit): the post editor. Select Facebook
   and/or Instagram, optionally type a first comment in "💬 Перший коментар" (First comment),
   click "📣 Опублікувати зараз" (Publish now). "↗ Відкрити пост" (Open post) opens the live post.
3. "Аналітика" (Analytics) → "↻ Оновити статистику" (Refresh): per-post views, reach, likes,
   comments, shares, saves and follower counts.
4. "Сьогодні" (Home) → "💬 Коменти" (Comments): comments people left under the connected Page's
   and Instagram account's posts, each with a suggested reply. Edit it and click "↩ Відповісти"
   (Reply) to answer from the Page or Instagram account; "Пропустити" (Skip) hides a comment.
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
  `https://holos.rozum.one/privacy`, Terms `https://holos.rozum.one/terms`, Data Deletion
  `https://holos.rozum.one/data-deletion`.
- Redirect URI (Facebook Login for Business → Settings → Valid OAuth Redirect URIs):
  `https://holos.rozum.one/api/integrations/meta/callback` (додано 27.09) і старі socialio; Threads
  (Use cases → Access the Threads API → Settings → Redirect Callback URLs):
  `https://holos.rozum.one/api/integrations/threads/callback` (додано 27.09). Адрес беті
  `https://beta.holos.rozum.one/...` ще нема (картка «адреси beta.holos.rozum.one»).
- Базове підключення Holos просить рівно 7 дозволів (`public_profile`, `pages_show_list`,
  `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`,
  `instagram_manage_insights`); коментарі, статистику й читання коментарів Сторінки - окремими
  кнопками («💬 Дозволити коментарі», «📈 Дозволити статистику», «📥 Дозволити читати коментарі»),
  щоб базове підключення не ламалось, поки нових дозволів нема в застосунку.
