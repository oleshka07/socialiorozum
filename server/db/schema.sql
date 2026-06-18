-- KontentGrov — схема БД (v1 + v2, готова до v3)
create extension if not exists "pgcrypto";

create table if not exists workspace (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique default 'default',
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

create index if not exists idx_run_source on pipeline_run(source_id);
create index if not exists idx_tgpub_post on telegram_publish(post_id);
create index if not exists idx_steprun_run on step_run(run_id);
create index if not exists idx_post_run on post(run_id);
create index if not exists idx_idea_run on idea(run_id);
