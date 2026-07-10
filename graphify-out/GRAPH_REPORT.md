# Graph Report - socialiorozum  (2026-07-10)

## Corpus Check
- 45 files · ~83,692 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 657 nodes · 1118 edges · 92 communities (33 shown, 59 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3ee5f52c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Auth, Session & Workers|Auth, Session & Workers]]
- [[_COMMUNITY_Content Pipeline Architecture|Content Pipeline Architecture]]
- [[_COMMUNITY_Studio & API Layer|Studio & API Layer]]
- [[_COMMUNITY_Database Schema|Database Schema]]
- [[_COMMUNITY_Google Drive Integration|Google Drive Integration]]
- [[_COMMUNITY_LLM Routing & AI|LLM Routing & AI]]
- [[_COMMUNITY_Authentication & Users|Authentication & Users]]
- [[_COMMUNITY_Node Dependencies|Node Dependencies]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Meta (FacebookInstagram)|Meta (Facebook/Instagram)]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Docker & PRO Pipeline|Docker & PRO Pipeline]]
- [[_COMMUNITY_Telegram Integration|Telegram Integration]]
- [[_COMMUNITY_CICD & Deployment|CI/CD & Deployment]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Public Pages & Landing|Public Pages & Landing]]
- [[_COMMUNITY_Meta App Review|Meta App Review]]
- [[_COMMUNITY_Pricing Strategy|Pricing Strategy]]
- [[_COMMUNITY_App Icon Assets|App Icon Assets]]
- [[_COMMUNITY_Theme Toggle|Theme Toggle]]
- [[_COMMUNITY_Landing Hero Demo|Landing Hero Demo]]
- [[_COMMUNITY_Integrations Grid|Integrations Grid]]
- [[_COMMUNITY_Interactive Playground|Interactive Playground]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 93|Community 93]]
- [[_COMMUNITY_Community 94|Community 94]]
- [[_COMMUNITY_Community 95|Community 95]]
- [[_COMMUNITY_Community 96|Community 96]]

## God Nodes (most connected - your core abstractions)
1. `q()` - 71 edges
2. `chat()` - 31 edges
3. `one()` - 26 edges
4. `logEvent()` - 22 edges
5. `workspace` - 21 edges
6. `loadSettings()` - 21 edges
7. `extractJsonArray()` - 17 edges
8. `Деплой: GitHub → Hetzner → домен (повний ранбук)` - 15 edges
9. `Eng review — КонтентГров backend (v1+v2 skeleton)` - 15 edges
10. `Design doc — Content Engine для soft-ніші (коучі / психологи)` - 14 edges

## Surprising Connections (you probably didn't know these)
- `КонтентГров v2 HTML Prototype — pipeline UI with calendar drag-and-drop` --visualizes--> `Content Pipeline — «Кишка» (Transcript → Ideas → Drafts → ToV → De-AI → Posts)`  [INFERRED]
  kontentgrov-v2.html → architecture-content-engine.md
- `saveRubrics()` --calls--> `q()`  [EXTRACTED]
  server/src/server.ts → server/src/db.ts
- `PRO Mode Toggle (Lite vs PRO pipeline gate)` --semantically_similar_to--> `Pricing Section (Test/Pro/Business tiers)`  [INFERRED] [semantically similar]
  server/public/app.html → server/public/b.html
- `b.html — Marketing Landing Page (dark-theme)` --semantically_similar_to--> `index.html — Primary Landing Page (dark-theme, Ukrainian)`  [INFERRED] [semantically similar]
  server/public/b.html → server/public/index.html
- `userByEmail()` --calls--> `one()`  [EXTRACTED]
  server/src/auth.ts → server/src/db.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Content Generation Pipeline: pipeline.ts + settings blocks + OpenRouter LLM** — claude_md_pipeline_ts, architecture_content_engine_settings_blocks, architecture_content_engine_openrouter [EXTRACTED 1.00]
- **Deployment Pipeline: GitHub Actions + Hetzner + Docker Compose** — _github_workflows_deploy_yml_deploy_workflow, _github_workflows_deploy_yml_hetzner_server, deploy_md_docker_compose [EXTRACTED 1.00]
- **Market Validation Triangle: design problem + market research + competitor gap** — design_doc_content_engine_problem, research_02_market_demand_tam_sam, research_03_competitors_main_finding [INFERRED 0.85]
- **Studio Post Lifecycle: Studio → Image Editor → Composer → Schedule** — server_public_app_html_studio_section, server_public_app_html_image_editor, server_public_app_html_composer, server_public_app_html_api_schedule [EXTRACTED 1.00]
- **Legal Compliance Cluster: Privacy + Data Deletion + Terms** — server_public_privacy_html_privacy_policy, server_public_data_deletion_html_gdpr_page, server_public_terms_html_terms_of_service [EXTRACTED 1.00]
- **Onboarding → Brand Derive → Post Generation Flow** — server_public_app_html_onboarding_flow, server_public_app_html_brand_derive_voice, server_public_app_html_api_generate_from_brand, server_public_app_html_studio_section [EXTRACTED 1.00]

## Communities (92 total, 59 thin omitted)

### Community 0 - "Auth, Session & Workers"
Cohesion: 0.06
Nodes (67): createEmailToken(), createSession(), createUser(), createWorkspaceWithDefaults(), deleteSession(), findOrCreateGoogleUser(), hashPassword(), markVerified() (+59 more)

### Community 2 - "Studio & API Layer"
Cohesion: 0.07
Nodes (38): AI-розподіл (AI auto-distribute posts to calendar), Аналітика (Analytics) Section, API Calls: /api/account (get/password/email/export/delete/reset), API Call: POST /api/generate/from-brand, API Call: POST /api/runs/:id/generate-lite, API Calls: POST /posts/:id/image, /posts/:id/image-text, API Calls: /api/integrations/* (Telegram/Meta/Threads/GDrive/Images), API Call: GET /api/posts/studio (global finals) (+30 more)

### Community 3 - "Database Schema"
Cohesion: 0.12
Nodes (34): app_log, app_user, content_plan, content_source, email_token, gdrive_config, gdrive_folder, idea (+26 more)

### Community 4 - "Google Drive Integration"
Cohesion: 0.07
Nodes (33): DriveFile, Folder, pullFolder(), pullGdriveFolder(), startGdrivePoller(), tick(), validToken(), Aspect (+25 more)

### Community 5 - "LLM Routing & AI"
Cohesion: 0.07
Nodes (66): chat(), ChatCtx, extractJsonArray(), extractJsonObject(), GEMINI_PRICES, geminiChat(), OPENAI_PRICES, stripDashes() (+58 more)

### Community 6 - "Authentication & Users"
Cohesion: 0.25
Nodes (15): atomLink(), decode(), fetchFeed(), fetchFeedRaw(), parseFeed(), parseFeedTitle(), googleNewsUrl(), humanError() (+7 more)

### Community 7 - "Node Dependencies"
Cohesion: 0.08
Nodes (25): dependencies, fastify, @fastify/cookie, @fastify/cors, @fastify/multipart, @fastify/static, heic-convert, pg (+17 more)

### Community 8 - "Community 8"
Cohesion: 0.33
Nodes (5): exchangeCode(), exchangeLongLived(), getMe(), refreshToken(), thFetch()

### Community 9 - "Meta (Facebook/Instagram)"
Cohesion: 0.19
Nodes (8): exchangeCode(), exchangeLongLived(), fbFetch(), FbPage, igStats(), pageStats(), publishPhotoToPage(), publishToPage()

### Community 10 - "TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, module, moduleResolution, outDir, resolveJsonModule, rootDir, skipLibCheck (+4 more)

### Community 11 - "Docker & PRO Pipeline"
Cohesion: 0.67
Nodes (3): Docker Compose App Service, Docker Compose PostgreSQL 16 DB Service, Docker Media Volume (persistent uploads)

### Community 13 - "Telegram Integration"
Cohesion: 0.30
Nodes (13): answerCallbackQuery(), deleteMessage(), editMessageText(), getChat(), getChatMember(), getMe(), kb(), sendMessage() (+5 more)

### Community 14 - "CI/CD & Deployment"
Cohesion: 0.67
Nodes (3): appleboy/ssh-action (CI/CD SSH step), GitHub Actions Deploy Workflow, Hetzner Production Server (178.105.185.67)

### Community 15 - "Community 15"
Cohesion: 0.23
Nodes (13): azureTts(), buildAss(), buildReelVideo(), download(), Job, parseReelScript(), pexelsClip(), probeDuration() (+5 more)

### Community 16 - "Public Pages & Landing"
Cohesion: 0.50
Nodes (5): API Calls: /api/auth/login, /register, /request-reset, /reset, auth.html — Auth Page (login/register/forgot/reset), Google OAuth Button (/api/auth/google), b.html — Marketing Landing Page (dark-theme), index.html — Primary Landing Page (dark-theme, Ukrainian)

### Community 17 - "Meta App Review"
Cohesion: 0.50
Nodes (4): Meta App Review Submission, App Icon 1024px, Meta App Review Assets Folder, socialio / КонтентГров Brand

### Community 26 - "Community 26"
Cohesion: 0.08
Nodes (25): 0. Головний принцип UI — «кишка», 1. Доменна модель (закладаємо повністю з v1), 2. Повна логіка пайплайну (всі кроки кишки), 3. Логіка стану й перегенерації (серце «прозорості»), 4. Глобальні редаговані блоки (Settings), 5. Технологічний стек, 6. Розбивка по версіях, 7. Що свідомо закладаємо наперед, щоб не переробляти (+17 more)

### Community 27 - "Community 27"
Cohesion: 0.11
Nodes (17): 0. Що треба мати перед стартом, 10. Smoke-тест (перевіряє людина), 11. Поточні операції, 1. Підготувати репозиторій локально, 2. Створити репозиторій на GitHub і запушити, 3. Створити сервер на Hetzner, 4. Початкове налаштування сервера, 5. Дати серверу доступ до приватного GitHub-репо (deploy key) (+9 more)

### Community 28 - "Community 28"
Cohesion: 0.12
Nodes (15): Data Flow, Data Model, Edge Cases (≥10), Eng review — КонтентГров backend (v1+v2 skeleton), Errors & Observability, Estimate, External Dependencies, Hidden Assumptions Surfaced (+7 more)

### Community 29 - "Community 29"
Cohesion: 0.13
Nodes (14): 🟡 Ask-first (3), 🟢 Auto-fixed (4), Code review — КонтентГров backend skeleton (`server/`), 🔴 Flag — no fix without context (3), Hidden assumptions in this PR, OpenRouter retry-політика, Recovery «застряглого» `running` — `step_run`, `src/pipeline.ts` — delete+insert без транзакції (+6 more)

### Community 30 - "Community 30"
Cohesion: 0.13
Nodes (14): Approaches Considered, Constraints, Demand Evidence, Dependencies, Design doc — Content Engine для soft-ніші (коучі / психологи), Distribution Plan, Open Questions, Problem Statement (+6 more)

### Community 31 - "Community 31"
Cohesion: 0.13
Nodes (14): 0. Принципи (як працюють топ-агенції, а не «погуглив конкурентів»), Операційна модель (хто що робить), Орієнтовний таймлайн, План глибокого маркетингового дослідження — Echo by ROZUM, Послідовність (6 фаз + гейти), Пропозиція, як стартуємо зараз, ФАЗА 0 — Вхідні дані й налаштування *(0.5 дня)*, ФАЗА 1 — Первинне дослідження (Customer Discovery) *(3-5 днів, залежить від календаря)* (+6 more)

### Community 32 - "Community 32"
Cohesion: 0.14
Nodes (13): 02 — Ринок і попит: Echo by ROZUM, 1. Розмір ринку (TAM / SAM / SOM), 2. Аудиторія та канали, 3. Сигнали попиту, 4. Макротренди, TAM → SAM → SOM (порядок величини), Біль контенту та готовність платити, Висновки для go-to-market (+5 more)

### Community 33 - "Community 33"
Cohesion: 0.17
Nodes (11): 1. What it is, 2. Stack & repo, 3. Deploy & verify, 4. Env / secrets (names only — never values in code/chat/git), 5. Architecture (server/src), 6. Feature inventory (current, all DEPLOYED & live), 7. IN PROGRESS / pending, 8. Key decisions & gotchas (+3 more)

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (11): Meta App Review — покрокова інструкція (socialio), Threads — ОКРЕМА заявка на ОКРЕМОМУ застосунку, КРОК 0. Підготовка (5 хв) — впиши в App settings → Basic, КРОК 1. Redirect URI (1 хв) — Facebook Login for Business → Settings, КРОК 2. Запросити Advanced Access на дозволи — App Review → Permissions and Features, КРОК 3. App Review → Requests → заповнити кожен дозвіл, КРОК 4. Скрінкаст (1 відео, ~2-3 хв) — записати на ТЕСТОВОМУ користувачі, КРОК 5. App Mode = Live (+3 more)

### Community 35 - "Community 35"
Cohesion: 0.18
Nodes (10): 1. DNS, 2. На сервері: клон + .env, 3. Підняти стек, 4. nginx + сертифікат, 5. Перевірка, 6. (Опційно) OAuth на беті, БЕТА-середовище: beta.socialio.rozum.one (разове розгортання), Нюанси (+2 more)

### Community 37 - "Community 37"
Cohesion: 0.22
Nodes (8): CI/CD (GitHub → Hetzner), Безпека (до продакшну), Версії, Деплой на Hetzner (один раз), КонтентГров — backend skeleton, Кроки кишки (API), Локальний запуск (Docker), Структура

### Community 38 - "Community 38"
Cohesion: 0.25
Nodes (7): 03 — Конкурентний аналіз: Echo by ROZUM, Головний висновок, Застереження щодо точності, Категорія 1 — All-in-one AI-контент + планувальники, Категорія 2 — Репурпос / на основі запису (наш вузький сусід), Категорія 3 — Локальні / україномовні + статус-кво, Прогалини й можливості для Echo by ROZUM

### Community 96 - "Community 96"
Cohesion: 0.27
Nodes (15): button(), send(), sendDeletionScheduledEmail(), sendEmailChangedNotice(), sendInactivityWarningEmail(), sendResetEmail(), sendVerifyEmail(), wrap() (+7 more)

## Knowledge Gaps
- **277 isolated node(s):** `app_log`, `name`, `version`, `private`, `type` (+272 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **59 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `q()` connect `Auth, Session & Workers` to `Community 96`, `Google Drive Integration`, `LLM Routing & AI`, `Community 15`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `one()` connect `Auth, Session & Workers` to `Google Drive Integration`, `LLM Routing & AI`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Why does `logEvent()` connect `Auth, Session & Workers` to `Community 96`, `Google Drive Integration`, `LLM Routing & AI`, `Community 15`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **What connects `app_log`, `name`, `version` to the rest of the system?**
  _294 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Auth, Session & Workers` be split into smaller, more focused modules?**
  _Cohesion score 0.060759493670886074 - nodes in this community are weakly interconnected._
- **Should `Studio & API Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.06543385490753911 - nodes in this community are weakly interconnected._
- **Should `Database Schema` be split into smaller, more focused modules?**
  _Cohesion score 0.11932773109243698 - nodes in this community are weakly interconnected._