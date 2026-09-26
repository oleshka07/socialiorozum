-- KontentGrov — схема БД (v1 + v2, готова до v3)
create extension if not exists "pgcrypto";

create table if not exists workspace (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique default 'default',
  created_at  timestamptz not null default now()
);

-- акаунти коучів (multi-tenant): кожен юзер має власний workspace
create table if not exists app_user (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  password_hash  text not null,
  email_verified boolean not null default false,
  workspace_id   uuid not null references workspace(id) on delete cascade,
  created_at     timestamptz not null default now()
);

-- сесії (cookie -> token у БД, відкликається)
create table if not exists user_session (
  token       text primary key,
  user_id     uuid not null references app_user(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- токени для верифікації пошти / скидання пароля
create table if not exists email_token (
  token       text primary key,
  user_id     uuid not null references app_user(id) on delete cascade,
  kind        text not null,                 -- verify|reset
  expires_at  timestamptz not null,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- редаговані глобальні блоки: marketing_context | tone_of_voice | deai_rules | content_strategy
create table if not exists settings_block (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  key          text not null,
  content      text not null default '',
  updated_at   timestamptz not null default now(),
  unique (workspace_id, key)
);

-- версіоновані промпти кроків
create table if not exists prompt_template (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  step_key     text not null,                 -- extract_ideas|drafts|tone|format|deai|strategy
  scope        text not null default 'step',  -- step|global
  model        text not null default 'openai/gpt-4o-mini',
  content      text not null,
  version      int  not null default 1,
  is_active    boolean not null default true,
  updated_at   timestamptz not null default now()
);

-- джерело: транскрипт (origin готовий до v3 API-інжесту)
create table if not exists source (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  origin       text not null default 'manual', -- manual|upload|api
  title        text,
  transcript   text not null,
  created_at   timestamptz not null default now()
);

create table if not exists pipeline_run (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid not null references source(id) on delete cascade,
  status      text not null default 'created',
  created_at  timestamptz not null default now()
);

-- результат кроку + основа каскадної перегенерації
create table if not exists step_run (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references pipeline_run(id) on delete cascade,
  step_key       text not null,
  model          text,
  prompt_version int,
  input_hash     text,
  status         text not null default 'idle', -- idle|fresh|stale|running|error
  output         jsonb,
  error          text,
  updated_at     timestamptz not null default now(),
  unique (run_id, step_key)
);

create table if not exists idea (
  id        uuid primary key default gen_random_uuid(),
  run_id    uuid not null references pipeline_run(id) on delete cascade,
  idx       int,
  idea      text,
  angle     text,
  selected  boolean not null default true
);

-- пост на будь-якій стадії; channel_type готовий до мульти-каналу (v2+)
create table if not exists post (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references pipeline_run(id) on delete cascade,
  idea_id      uuid references idea(id) on delete set null,
  stage        text not null,                 -- draft|toned|formatted|final
  channel_type text not null default 'telegram',
  content      text not null,
  created_at   timestamptz not null default now()
);

create table if not exists content_plan (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references pipeline_run(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists plan_item (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references content_plan(id) on delete cascade,
  post_id     uuid references post(id) on delete set null,
  title       text,
  type        text,
  day_offset  int
);

-- розклад публікацій; status готовий до автопостингу (v3)
create table if not exists schedule_slot (
  id            uuid primary key default gen_random_uuid(),
  plan_item_id  uuid not null references plan_item(id) on delete cascade,
  channel_type  text not null default 'telegram',
  scheduled_at  timestamptz,
  status        text not null default 'planned' -- planned|posting|posted|failed
);

-- інтеграція Telegram (per-workspace; bot token лише на сервері, не в git)
create table if not exists telegram_config (
  workspace_id    uuid primary key references workspace(id) on delete cascade,
  bot_token       text,
  channel_chat_id text,
  channel_title   text,
  group_chat_id   text,
  group_title     text,
  updated_at      timestamptz not null default now()
);

-- лог публікацій у Telegram (основа для автопостингу)
create table if not exists telegram_publish (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid references post(id) on delete cascade,
  target      text not null,             -- channel|group
  chat_id     text,
  message_id  bigint,
  status      text not null,             -- sent|error
  error       text,
  created_at  timestamptz not null default now()
);

-- журнал подій/помилок (діагностика проблем розробки і юзерів)
create table if not exists app_log (
  id          uuid primary key default gen_random_uuid(),
  level       text not null,             -- info|warn|error
  scope       text,                      -- register|email|auth|pipeline|telegram|...
  message     text not null,
  meta        jsonb,
  user_id     uuid,
  created_at  timestamptz not null default now()
);

-- ідемпотентні міграції для Google-логіну (password_hash нульовий для google-юзерів)
alter table app_user alter column password_hash drop not null;
alter table app_user add column if not exists google_id text;

create index if not exists idx_run_source on pipeline_run(source_id);
create index if not exists idx_tgpub_post on telegram_publish(post_id);
create index if not exists idx_applog_created on app_log(created_at desc);

-- статус рев'ю поста (банк публікацій): null | approved | needs_work | archived
alter table post add column if not exists review text;

-- облік токенів/вартості LLM (для лічильника в Аналітиці)
create table if not exists llm_usage (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid references workspace(id) on delete cascade,
  step              text,
  model             text,
  prompt_tokens     int default 0,
  completion_tokens int default 0,
  cost              numeric default 0,
  created_at        timestamptz not null default now()
);
create index if not exists idx_llmusage_ws on llm_usage(workspace_id, created_at desc);

-- планування по постах напряму (банк публікацій -> календар)
alter table schedule_slot add column if not exists post_id uuid references post(id) on delete cascade;
alter table schedule_slot alter column plan_item_id drop not null;
create index if not exists idx_slot_post on schedule_slot(post_id);

-- рубрики (контент-мікс) на workspace
create table if not exists rubric (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  name         text not null,
  emoji        text,
  description  text,
  share        int not null default 0,
  idx          int not null default 0
);
create index if not exists idx_rubric_ws on rubric(workspace_id);

-- засіяти дефолтні рубрики для workspace, де їх ще немає
insert into rubric(workspace_id,name,emoji,description,share,idx)
select w.id, d.name, d.emoji, d.descr, d.share, d.idx
from workspace w
cross join (values
  ('Освітнє','📚','Гайди, поради, туторіали, галузеві знання',35,0),
  ('Промо','🛍️','Запуски продуктів, пропозиції, послуги, заклики до дії',20,1),
  ('Розважальне','🎭','Меми, життєвий контент, тренди, гумор',15,2),
  ('Спільнота','🤝','Історії користувачів, Q&A, опитування, пости для залучення',20,3),
  ('За лаштунками','🏢','Команда, процеси, культура, будні компанії',10,4)
) as d(name,emoji,descr,share,idx)
where not exists (select 1 from rubric r where r.workspace_id = w.id);

-- інтеграція транскрибації (Fireflies) на workspace; ключ лише на сервері
create table if not exists transcription_config (
  workspace_id uuid primary key references workspace(id) on delete cascade,
  provider     text not null default 'fireflies',
  api_key      text,
  updated_at   timestamptz not null default now()
);
-- авто-імпорт через вебхук Fireflies (per-workspace токен у URL + секрет для HMAC + авто-прогін)
alter table transcription_config add column if not exists webhook_token  text;
alter table transcription_config add column if not exists webhook_secret text;
alter table transcription_config add column if not exists auto_run       boolean not null default false;
create unique index if not exists idx_transcfg_webhook on transcription_config(webhook_token);
-- дедуплікація автоімпорту зустрічей (Fireflies meetingId)
alter table source add column if not exists external_id text;
create index if not exists idx_source_extid on source(workspace_id, external_id);

-- інтеграція Threads (Meta): окремий OAuth-токен на workspace (лише на сервері)
create table if not exists threads_config (
  workspace_id     uuid primary key references workspace(id) on delete cascade,
  threads_user_id  text,
  username         text,
  access_token     text,
  token_expires_at timestamptz,
  updated_at       timestamptz not null default now()
);

-- лог публікацій у Threads (+ media_id для інсайтів)
create table if not exists threads_publish (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid references post(id) on delete cascade,
  media_id    text,
  status      text not null,             -- sent|error
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_thpub_post on threads_publish(post_id);

-- 🧵 відкладені відповіді у ВЛАСНУ гілку Threads (CTA-гілка: лінк/кодове слово доклеюється,
-- коли пост уже розганяється - практика «спершу охоплення, потім перелив»)
create table if not exists threads_reply_job (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace(id) on delete cascade,
  post_id       uuid references post(id) on delete cascade,
  root_media_id text not null,
  reply_text    text not null,
  due_at        timestamptz not null,
  status        text not null default 'pending',   -- pending|sent|error
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_threply_due on threads_reply_job(status, due_at);

-- інтеграція Meta (Facebook + Instagram): FB-постинг + аналітика (токени лише на сервері)
create table if not exists meta_config (
  workspace_id     uuid primary key references workspace(id) on delete cascade,
  user_token       text,
  page_id          text,
  page_name        text,
  page_token       text,
  ig_user_id       text,
  ig_username      text,
  token_expires_at timestamptz,
  updated_at       timestamptz not null default now()
);

create table if not exists meta_publish (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid references post(id) on delete cascade,
  channel     text not null,             -- facebook
  external_id text,                      -- id поста у FB
  status      text not null,             -- sent|error
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_metapub_post on meta_publish(post_id);

-- збережені контент-джерела (RSS) на workspace; фоновий поллер тягне нові статті
create table if not exists content_source (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspace(id) on delete cascade,
  kind           text not null default 'rss',
  url            text not null,
  title          text,
  active         boolean not null default true,
  auto_run       boolean not null default false,
  last_pulled_at timestamptz,
  last_error     text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_contentsource_ws on content_source(workspace_id);

-- медіа-бібліотека (фото/відео) на workspace; файли на диску (volume), тут — метадані
create table if not exists media_asset (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace(id) on delete cascade,
  kind          text not null default 'image',   -- image|video
  mime          text,
  original_name text,
  filename      text not null,                    -- uuid.ext на диску
  size          int,
  source        text not null default 'upload',   -- upload|gdrive
  external_id   text,                             -- gdrive file id (дедуп)
  created_at    timestamptz not null default now()
);
create index if not exists idx_media_ws on media_asset(workspace_id, created_at desc);
alter table post add column if not exists media_id uuid references media_asset(id) on delete set null;
alter table post add column if not exists channels jsonb;   -- {telegram:{on,text}, instagram:{...}, ...} для композера
alter table post add column if not exists rubric text;      -- тег-рубрика (штампується при генерації; фільтри Студії/календаря)
alter table source add column if not exists archived boolean not null default false;  -- «Прибрати» зі стрічки матеріалів

-- Скелет контент-плану (workspace-scoped, НЕ на прогін): слоти-очікування, що відстежують заповнення.
-- Статуси: empty → matched (є матеріал) → drafted (пост створено) → approved → scheduled → published
create table if not exists plan_slot (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspace(id) on delete cascade,
  slot_date        date not null,
  channel          text not null default 'telegram',
  rubric           text,
  theme            text not null,
  hook             text,
  cta              text,
  status           text not null default 'empty',
  match_source_id  uuid references source(id) on delete set null,
  match_note       text,
  post_id          uuid references post(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_plan_slot_ws on plan_slot(workspace_id, slot_date);

-- Google Drive: OAuth-підключення (drive.readonly) на workspace
create table if not exists gdrive_config (
  workspace_id     uuid primary key references workspace(id) on delete cascade,
  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  email            text,
  updated_at       timestamptz not null default now()
);
-- папки Google Drive для синхронізації фото
create table if not exists gdrive_folder (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspace(id) on delete cascade,
  folder_id      text not null,
  name           text,
  active         boolean not null default true,
  last_pulled_at timestamptz,
  last_error     text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_gdrivefolder_ws on gdrive_folder(workspace_id);

-- згенерована стратегія (L2): JSON-артефакт на workspace
create table if not exists strategy (
  workspace_id uuid primary key references workspace(id) on delete cascade,
  data         jsonb not null default '{}',
  status       text not null default 'draft',   -- draft|applied
  updated_at   timestamptz not null default now()
);
create index if not exists idx_steprun_run on step_run(run_id);
create index if not exists idx_post_run on post(run_id);
create index if not exists idx_idea_run on idea(run_id);

-- lifecycle акаунтів: активність, soft-delete (grace 14 днів), попередження/чистка за неактивність
alter table app_user add column if not exists last_active_at       timestamptz;
alter table app_user add column if not exists deleted_at           timestamptz;   -- soft-delete; воркер стирає остаточно після grace
alter table app_user add column if not exists inactivity_warned_at timestamptz;   -- лист про неактивність надіслано
alter table app_user add column if not exists data_purged_at       timestamptz;   -- медіа/прогони почищено за неактивність
create index if not exists idx_user_lastactive on app_user(last_active_at);
create index if not exists idx_user_deleted on app_user(deleted_at) where deleted_at is not null;

-- підсумок останньої спроби автопостингу слота (для статусу в календарі: ✓ мережі / ⚠ помилки)
alter table schedule_slot add column if not exists result text;

-- промт для генерації зображення поста (його повертає Lite-генерація разом із текстом)
alter table post add column if not exists image_prompt text;
-- редактор зображення: базова картинка без тексту (для дешевого перенакладання) + поточний заголовок
alter table post add column if not exists image_base text;
alter table post add column if not exists headline text;
-- зібраний відео-рілс (mp4 у MEDIA_DIR) - щоб результат не губився після збірки
alter table post add column if not exists reel_video text;
-- лічильник підряд невдалих спроб фіда - для експоненційного бекофу поллера (0 = здоровий)
alter table content_source add column if not exists error_count int not null default 0;
-- з якої стрічки прийшов матеріал (фільтр «ця інста / ця тема новин / той телеграм» у Матеріалах)
alter table source add column if not exists feed_id uuid references content_source(id) on delete set null;
-- AI-оцінка цікавості матеріалу для аудиторії бренду (1-10, безкоштовний Gemini) + пояснення
alter table source add column if not exists ai_score int;
alter table source add column if not exists ai_score_why text;
-- формат контент-одиниці: 'post' (текстовий) чи 'reel' (сценарій/відео) - фундамент рілс-треку (IG/FB/TikTok/YT)
alter table post add column if not exists format text not null default 'post';
alter table post add column if not exists intent text; -- намір поста: awareness (знайомство) / nurture (прогрів) / sale (продаж) - керує CTA-політикою

-- LinkedIn-автопостинг (5-та мережа, шаблон Threads): підключення профілю + журнал публікацій
create table if not exists linkedin_config (
  workspace_id     uuid primary key references workspace(id) on delete cascade,
  member_urn       text not null,            -- urn:li:person:… (пізніше: urn:li:organization:… для сторінок)
  display_name     text,
  access_token     text not null,            -- живе 60 днів; програмного рефрешу на базовому доступі нема → індикатор перепідключення
  token_expires_at timestamptz,
  updated_at       timestamptz not null default now()
);
create table if not exists linkedin_publish (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references post(id) on delete cascade,
  external_id text,                           -- URN опублікованого поста (x-restli-id)
  status      text not null default 'sent',
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_lipub_post on linkedin_publish(post_id);

-- YouTube Shorts (рілси): Google OAuth (scope youtube.upload) + журнал завантажень
create table if not exists youtube_config (
  workspace_id     uuid primary key references workspace(id) on delete cascade,
  channel_title    text,
  access_token     text not null,
  refresh_token    text,                       -- offline-доступ: оновлюємо access_token самі
  token_expires_at timestamptz,
  updated_at       timestamptz not null default now()
);
create table if not exists youtube_publish (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references post(id) on delete cascade,
  external_id text,                            -- videoId на YouTube
  status      text not null default 'sent',
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ytpub_post on youtube_publish(post_id);

-- TikTok (рілси): Content Posting API; до аудиту застосунку відео їде в «чернетки» юзера (inbox upload)
create table if not exists tiktok_config (
  workspace_id     uuid primary key references workspace(id) on delete cascade,
  open_id          text not null,
  display_name     text,
  access_token     text not null,
  refresh_token    text,
  token_expires_at timestamptz,
  updated_at       timestamptz not null default now()
);
create table if not exists tiktok_publish (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references post(id) on delete cascade,
  external_id text,                            -- publish_id джоби TikTok
  status      text not null default 'sent',
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ttpub_post on tiktok_publish(post_id);

-- Ритм каналів: слот розкладу може цілити ПІДМНОЖИНУ мереж поста (null = усі ввімкнені, як раніше).
-- Один пост їде в різні мережі в різний час за їхніми ритмами; дедуп «раз на мережу» вже захищає від дублів.
alter table schedule_slot add column if not exists channels jsonb;

-- Метрики опублікованих постів (останній знімок по мережі) - фундамент бенчмарків «×N до власної норми»:
-- медіана переглядів за 75-90 днів = норма мережі, кожен пост звітується множником до неї.
create table if not exists post_metric (
  post_id    uuid not null references post(id) on delete cascade,
  network    text not null,                  -- threads / facebook / instagram
  views      int  not null default 0,        -- перегляди/охоплення (по мережі: views | post_impressions | reach)
  likes      int  not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (post_id, network)
);

-- 🧵 повні метрики Threads-постів для розширеної аналітики (для FB/IG лишаються 0)
-- ⚠️ ЦІ ALTER МУСЯТЬ СТОЯТИ ПІСЛЯ create table вище. Вони лежали ВИЩЕ за нього, і на будь-якій БД,
-- де post_metric уже існував (бета, дев), усе проходило - а на БД без цієї таблиці міграція падала
-- `relation "post_metric" does not exist`, застосунок не стартував і прод ліг. Саме так це й сталось
-- 30.07: прод не деплоївся з 09.07, тому таблиці там ще не було, і помилку не було де побачити раніше.
alter table post_metric add column if not exists replies int not null default 0;
alter table post_metric add column if not exists reposts int not null default 0;
alter table post_metric add column if not exists quotes  int not null default 0;

-- підключення каналу до СПІЛЬНОГО Telegram-бота: код deep-link -> воркспейс, + хто почав діалог
create table if not exists tg_connect (
  code         text primary key,
  workspace_id uuid not null references workspace(id) on delete cascade,
  tg_user_id   bigint,
  created_at   timestamptz not null default now()
);
create index if not exists idx_tgconnect_user on tg_connect(tg_user_id);

-- Банк ідей: постійні (workspace-scoped) концепти постів, окремо від run-bound `idea`.
-- Наповнюється вручну / ботом (origin='bot') / AI; «→ пост» ставить status='used'.
create table if not exists idea_bank (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  text         text not null,
  angle        text,
  rubric       text,
  origin       text not null default 'manual', -- manual|ai|bot|plan|material
  status       text not null default 'new',    -- new|used|archived
  used_post_id uuid references post(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_idea_bank_ws_status on idea_bank(workspace_id, status);

-- Telegram DM-асистент: хто власник якого воркспейсу (для проактивних DM + атрибуції захоплених ідей)
create table if not exists tg_owner (
  tg_user_id   bigint primary key,
  workspace_id uuid not null references workspace(id) on delete cascade,
  chat_id      text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_tg_owner_ws on tg_owner(workspace_id);

-- «один живий меседж на категорію»: тримаємо message_id останнього повідомлення категорії, щоб гасити старе
create table if not exists tg_message (
  workspace_id uuid not null references workspace(id) on delete cascade,
  category     text not null,
  chat_id      text not null,
  message_id   bigint not null,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, category)
);

-- 🦉 Помічник-провідник (сова Rozum): лог показаних порад/дій - для навчання й персоналізації
create table if not exists guide_log (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspace(id) on delete cascade,
  tip          text not null,
  event        text not null,          -- shown|clicked|dismissed|snoozed|off
  created_at   timestamptz not null default now()
);
create index if not exists idx_guidelog_ws on guide_log(workspace_id, created_at desc);

-- «Ворота якості» (settings_block.qa_gates {director,aiaudit,storytelling}): опційний авто-прогін
-- Директора/AI-слідів/Сторителлінга одразу після генерації. Компактний підсумок, лише для бейджа
-- в Студії - повну деталь юзер бачить, клікнувши на бейдж (той самий live-виклик, що й раніше).
alter table post add column if not exists qa jsonb;

-- 🔒 Технічний аудит, Рівень 1 (надійність публікації).
-- ① unique-індекси на *_publish: захист від подвійної публікації НА РІВНІ БД (раніше дедуп був лише
-- SELECT-потім-INSERT у коді - гонка при подвійному кліку чи збігу ручної публікації з автопостом
-- могла все одно проскочити). publisher.ts тепер РЕЗЕРВУЄ рядок (INSERT...ON CONFLICT DO NOTHING)
-- ПЕРЕД зовнішнім викликом мережі, а не пише його вже ПІСЛЯ успіху. Дедуп-DELETE перед створенням
-- індексу самолікує старі дублі, якщо такі лишились із задокументованих багів double-post (безпечно
-- повторювати на кожному деплої - після першого разу дублів уже нема, запит просто нічого не знайде).
delete from telegram_publish where id in (
  select id from (select id, row_number() over (partition by post_id, target order by created_at, id) rn from telegram_publish) t where rn > 1
);
create unique index if not exists uq_tgpub_post_target on telegram_publish(post_id, target);
delete from threads_publish where id in (
  select id from (select id, row_number() over (partition by post_id order by created_at, id) rn from threads_publish) t where rn > 1
);
create unique index if not exists uq_thpub_post on threads_publish(post_id);
delete from meta_publish where id in (
  select id from (select id, row_number() over (partition by post_id, channel order by created_at, id) rn from meta_publish) t where rn > 1
);
create unique index if not exists uq_metapub_post_channel on meta_publish(post_id, channel);
delete from linkedin_publish where id in (
  select id from (select id, row_number() over (partition by post_id order by created_at, id) rn from linkedin_publish) t where rn > 1
);
create unique index if not exists uq_lipub_post on linkedin_publish(post_id);
-- ② `updated_at` на schedule_slot - без нього неможливо відрізнити слот, що ЗАВИС у 'posting'
-- (процес упав посеред публікації - деплой, OOM) від того, що просто зараз публікується; такий
-- слот раніше випадав із автопосту І з /api/schedule/auto НАЗАВЖДИ без жодної помилки в UI.
alter table schedule_slot add column if not exists updated_at timestamptz not null default now();

-- 🎨 ФОРМАТ як повноцінний вимір плану (post|carousel|reel|story).
-- Формат ортогональний рубриці: рубрика = ПРО ЩО, формат = ЯК УПАКОВАНО, канал = КУДИ. Так це
-- влаштовано в усіх професійних контент-календарях (в Airtable це поле `Content Type`, у шаблоні
-- Later - окремі колонки `content type` і `content pillars`). До цього формат жив лише на пості
-- ('post'|'reel'), а план узагалі не міг сказати «цей слот - карусель».
alter table plan_slot add column if not exists format text not null default 'post';

-- 🔗 ПОСИЛАННЯ НА ОПУБЛІКОВАНИЙ ПОСТ. Ідентифікатори ми зберігали й раніше (message_id, media_id,
-- external_id), але людині вони ні про що не кажуть - щоб глянути «як воно там виглядає», доводилось
-- шукати пост у мережі руками. Тепер при відправці одразу зберігаємо готовий URL:
-- Telegram/Facebook/LinkedIn збираються з id детерміновано (без жодного запиту), Threads і Instagram
-- віддають `permalink` полем Graph API - там один дешевий додатковий виклик.
alter table telegram_publish add column if not exists permalink text;
alter table threads_publish  add column if not exists permalink text;
alter table meta_publish     add column if not exists permalink text;
alter table linkedin_publish add column if not exists permalink text;
-- @username каналу для гарного публічного лінка t.me/<name>/<id>; для приватних лишається
-- t.me/c/<internal>/<id> (працює для власника-адміна). Тягнеться раз через getChat і кешується.
alter table telegram_config add column if not exists channel_username text;

-- 🧠 ДИСТИЛЬОВАНИЙ АРТЕФАКТ ОПУБЛІКОВАНОГО ПОСТА (памʼять контенту).
-- Було: `recentContentDigest` на КОЖНІЙ генерації брав 15 останніх опублікованих постів і стискав
-- їх окремим LLM-викликом. Тобто (а) платили щоразу за одну й ту саму роботу, (б) памʼять обривалась
-- на 15 постах - усе, що старше, для моделі не існувало, і теми поверталися по колу.
-- Стало: пост дистилюється ОДИН раз при публікації в структурований артефакт, а генерація просто
-- читає збережене. Дешевше й ширше водночас.
-- workspace_id тут ЯВНО (хоч і виводиться через post→run→source): це сховище читається на кожній
-- генерації, і мультитенантна ізоляція має бути в ключі й в індексі, а не в пам'яті автора запиту.
create table if not exists post_digest (
  post_id uuid primary key references post(id) on delete cascade,
  workspace_id uuid not null references workspace(id) on delete cascade,
  hook text,      -- дослівне відкриття поста
  thesis text,    -- головна теза одним реченням
  facts text,     -- конкретні цифри/назви/приклади, вжиті в пості
  cta text,       -- заклик до дії
  topics text,    -- теми через кому (під майбутній пошук за змістом)
  created_at timestamptz not null default now()
);
create index if not exists idx_postdigest_ws on post_digest(workspace_id, created_at desc);

-- 🔑 КЛЮЧІ ПРОВАЙДЕРІВ, ЯКІ СТАВЛЯТЬСЯ З АДМІНКИ, А НЕ З .env.
-- Було: будь-який новий ключ = правка `.env` на сервері + `docker compose up --force-recreate`,
-- тобто SSH і деплой заради одного рядка. Через це «спробувати нового провайдера» коштувало
-- окремої сесії й фактично не робилось.
-- Стало: значення лежить тут, читається при старті й після кожного збереження, і НАКЛАДАЄТЬСЯ
-- ПОВЕРХ `.env` (порожньо в таблиці = працює те, що в `.env`, тобто нічого не ламається).
-- Таблиця НЕ привʼязана до воркспейсу свідомо: це інфраструктурні ключі оператора сервісу
-- (той самий рівень, що й `.env`), а не налаштування орендаря.
-- ⚠️ Значення НІКОЛИ не віддається клієнту й не пише́ться в лог - назовні йдуть лише останні
-- 4 символи для впізнавання.
create table if not exists app_secret (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- 📥 ВЛАСНИЙ ТРАНСКРИБАТОР (Vymova й будь-який самописний сервіс): окрема адреса вебхука,
-- незалежна від Fireflies. Свідомо ОКРЕМІ колонки, а не переклад `provider` на нове значення:
-- інакше воркспейс мусив би вибирати «або Fireflies, або свій», хоч вони не конфліктують.
-- `meeting_secret` необовʼязковий: специфікація Vymova не додає заголовків авторизації, тож
-- базовий захист - довгий токен в URL; секрет вмикає ще й підпис тіла (HMAC), коли відправник
-- уміє його надсилати.
alter table transcription_config add column if not exists meeting_token  text;
alter table transcription_config add column if not exists meeting_secret text;
alter table transcription_config add column if not exists meeting_auto   boolean not null default true;
create unique index if not exists idx_transcfg_meeting on transcription_config(meeting_token);

-- 🔄 ЗВІРКА З ХМАРОЮ ВЛАСНОГО ТРАНСКРИБАТОРА (pull поверх push).
-- Push дає швидкість, але залежить від того, чи ми були живі в ту мить; погодинна звірка забирає
-- все, що зʼявилось після останнього побаченого `id`. Дедуплікація по `meeting_id` робить
-- подвійне отримання безпечним, тож push і pull не конфліктують.
-- ⚠️ `meeting_pull_token` - секрет: назовні НІКОЛИ не віддається (лише «задано / не задано»).
alter table transcription_config add column if not exists meeting_pull_url   text;
alter table transcription_config add column if not exists meeting_pull_token text;
alter table transcription_config add column if not exists meeting_pull_after text not null default '0';
alter table transcription_config add column if not exists meeting_pull_at    timestamptz;

-- 💸 СТЕЛЯ ВИТРАТ НА AI: окремому кабінету адмін може задати свою (null = дефолт із .env,
-- SPEND_CAP_USD_DAY / SPEND_CAP_USD_MONTH; 0 = без обмеження). Свідомо НЕ в settings_block:
-- той пишеться самим користувачем через PUT /api/settings/:key, і кожен підняв би собі стелю сам.
alter table workspace add column if not exists spend_cap_day   numeric;
alter table workspace add column if not exists spend_cap_month numeric;

-- ⏳ ФОНОВІ ДЖОБИ - стан у БД, а не в памʼяті процесу (публікація, AI-дії, рілси).
-- Деплой посеред публікації раніше лишав клієнта з вічним «idle» без пояснення; тепер після старту
-- всі running стають idle з людською причиною, а завершені прибираються через добу (lifecycle).
-- (kind,key) - ключ дедупу: подвійний клік «Опублікувати» не запускає другу публікацію.
create table if not exists job (
  id           uuid primary key,
  workspace_id uuid references workspace(id) on delete cascade,
  kind         text not null,
  key          text,
  status       text not null default 'running',
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_job_kind_key on job(kind, key, created_at desc);
create index if not exists idx_job_updated on job(updated_at);

-- ============================================================================
-- 🏢 МУЛЬТИ-ВОРКСПЕЙС: одна людина - кілька кабінетів (брендів).
-- До цього звʼязок був жорстко 1:1 (`app_user.workspace_id`), тож щоб вести другий бренд, треба
-- було заводити окремий акаунт і виходити-заходити. Тепер доступ описує ОКРЕМА таблиця, а
-- `app_user.workspace_id` лишається «домашнім» кабінетом (фолбек і місце, куди сідає новий юзер).
-- Ключове рішення: активний кабінет живе в СЕСІЇ, а не в юзері - тож resolve лишається одним
-- запитом у `userBySession`, і жоден із 174 роутів, що читають `req.user.workspace_id`, не змінюється.
-- ============================================================================
create table if not exists workspace_member (
  workspace_id uuid not null references workspace(id) on delete cascade,
  user_id      uuid not null references app_user(id) on delete cascade,
  role         text not null default 'member',      -- owner|member
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists idx_wsmember_user on workspace_member(user_id);
-- бекфіл: кожен наявний юзер - власник свого домашнього кабінету (ідемпотентно)
insert into workspace_member(workspace_id, user_id, role)
  select workspace_id, id, 'owner' from app_user on conflict do nothing;

-- людська назва кабінету: `workspace.name` технічний і унікальний («user:пошта»), показувати його
-- в перемикачі не можна
alter table workspace add column if not exists title text;

-- активний кабінет сесії; null = домашній. Членство перевіряється при КОЖНОМУ resolve (join нижче
-- в auth.ts), тож відкликаний доступ діє негайно, без чистки сесій.
alter table user_session add column if not exists active_workspace_id uuid references workspace(id) on delete set null;

-- 🔌 MCP-токен тепер належить ЛЮДИНІ, а не кабінету: один конектор у Claude бачить усі бренди,
-- між якими людина має доступ. Жив у `settings_block` - переїжджає сюди разом із наявними адресами,
-- щоб уже видані посилання не померли.
create table if not exists mcp_token (
  token               text primary key,
  user_id             uuid not null references app_user(id) on delete cascade,
  active_workspace_id uuid references workspace(id) on delete set null,
  last_used_at        timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists idx_mcptoken_user on mcp_token(user_id);
insert into mcp_token(token, user_id, active_workspace_id)
  select sb.content, u.id, sb.workspace_id
    from settings_block sb join app_user u on u.workspace_id = sb.workspace_id
   where sb.key = 'mcp_token' and sb.content ~ '^[0-9a-f]{64}$'
  on conflict (token) do nothing;
-- прибираємо старе джерело правди ЛИШЕ для тих токенів, що реально переїхали
delete from settings_block sb
 where sb.key in ('mcp_token','mcp_last_used')
   and (sb.key = 'mcp_last_used' or exists (select 1 from mcp_token t where t.token = sb.content));

-- 🤖 Claude Code CLI (підписка замість оплати токенів API) - ДОЗВІЛ на КАБІНЕТ, не глобальний.
-- Токен підписки належить людині: обслуговувати ним чужі кабінети не можна ані за умовами
-- підписки, ані практично (квота спільна). Колонка на `workspace`, а не в `settings_block`, з тієї
-- самої причини, що й стеля витрат: settings_block пише сам користувач через PUT /api/settings,
-- тобто кожен увімкнув би собі сам.
alter table workspace add column if not exists cli_enabled boolean not null default false;

-- скільки ТОЙ САМИЙ виклик коштував би через API. `cost` для CLI чесний нуль (підписка вже
-- сплачена) і саме він годує стелю витрат; без окремої колонки питання «скільки ми заощадили»
-- не має відповіді взагалі.
alter table llm_usage add column if not exists alt_cost numeric not null default 0;

-- 📤 Разові посилання на завантаження фото в медіатеку (інструмент конектора media_upload_link):
-- Claude у Cowork / Claude Code заливає папку з комп'ютера СКРИПТОМ, не проганяючи фото через модель.
-- Посилання вміє лише ДОДАВАТИ фото в медіатеку одного кабінету: нічого не читає, живе хвилини й
-- має ліміт файлів - тож навіть потрапивши в чужі руки, кабінет воно не відкриває.
create table if not exists upload_link (
  token        text primary key,
  workspace_id uuid not null references workspace(id) on delete cascade,
  user_id      uuid references app_user(id) on delete cascade,
  expires_at   timestamptz not null,
  files_left   int not null default 200,
  uploaded     int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_upload_link_exp on upload_link(expires_at);
