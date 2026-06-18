# КонтентГров — backend skeleton

Node 20 + TypeScript + Fastify + PostgreSQL, у Docker. БД внутрішня (не публікується назовні), деплой через GitHub → Hetzner.

## Структура
```
КонтентГров/
├─ .github/workflows/deploy.yml   ← CI (має бути в КОРЕНІ репо)
├─ kontentgrov-v2.html            ← фронт-прототип «кишки»
├─ architecture-content-engine.md ← повна архітектура
└─ server/
   ├─ Dockerfile, docker-compose.yml, .env.example
   ├─ db/schema.sql               ← схема (v1+v2, готова до v3)
   ├─ public/index.html           ← сюди кладеться зібраний фронт
   └─ src/
      ├─ server.ts                ← Fastify + маршрути
      ├─ pipeline.ts              ← executeStep() + конфіги кроків (OpenRouter)
      ├─ openrouter.ts, db.ts, env.ts, migrate.ts
```

## Кроки кишки (API)
`extract_ideas → drafts → tone → format → deai → strategy`
Кожен крок: `POST /api/runs/:id/steps/:step/run`. Каскад: `POST /api/runs/:id/run-from/:step`.
Запуск кроку автоматично позначає всі наступні `step_run.status='stale'`.

## Локальний запуск (Docker)
```bash
cd server
cp .env.example .env          # заповни паролі та OPENROUTER_API_KEY
docker compose up -d --build  # підніме postgres + app, прогон міграцій автоматичний
curl localhost:8080/health    # {"ok":true}
```
Без Docker (потрібен локальний Postgres):
```bash
npm install
export DATABASE_URL=postgres://... OPENROUTER_API_KEY=sk-or-...
npm run build && npm run start   # migrate + server
# або dev: npm run dev
```

## Деплой на Hetzner (один раз)
1. Створи сервер (Ubuntu 22.04+), додай SSH-ключ.
2. На сервері:
   ```bash
   apt update && apt install -y docker.io docker-compose-plugin git
   git clone <твій-github-repo> /opt/kontentgrov
   cd /opt/kontentgrov/server
   cp .env.example .env && nano .env     # реальні паролі + OPENROUTER_API_KEY
   docker compose up -d --build
   ```
3. Reverse proxy (рекомендовано Caddy — авто-HTTPS):
   ```
   your-domain.example {
       reverse_proxy 127.0.0.1:8080
   }
   ```
4. Firewall: відкрий лише 80/443 і SSH. Порт 8080 слухає на 127.0.0.1, БД (5432) — лише у внутрішній мережі compose.

## CI/CD (GitHub → Hetzner)
У репо: **Settings → Secrets and variables → Actions** додай:
- `HETZNER_HOST` — IP сервера
- `HETZNER_USER` — напр. `root`
- `HETZNER_SSH_KEY` — приватний SSH-ключ (deploy key)
- `APP_DIR` — напр. `/opt/kontentgrov`

Кожен `git push` у `main` → workflow заходить по SSH і робить `git pull` + `docker compose up -d --build`.

## Безпека (до продакшну)
- Транскрипти = чутливі дані клієнтів. Постав доступ за авторизацією (зараз API відкритий — лише скелет).
- `OPENROUTER_API_KEY` тільки в `.env` на сервері, ніколи в git.
- Перед публічним запуском пройди security-review (skill `cso`).

## Версії
- **v1** — кроки extract_ideas…deai, ручний транскрипт, копіювання постів.
- **v2** — `strategy` + календар/розклад (`content_plan`, `plan_item`, `schedule_slot`).
- **v3** — `source.origin='api'` авто-інжест транскрипцій + автопостинг (`schedule_slot.status`), auth, мульти-юзер.
