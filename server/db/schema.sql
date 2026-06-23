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
  status        text not null default 'planned' -- planned|posted|failed
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
