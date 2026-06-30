# Graph Report - .  (2026-06-30)

## Corpus Check
- 54 files · ~56,933 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 400 nodes · 731 edges · 26 communities (20 shown, 6 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.9)
- Token cost: 18,500 input · 4,200 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Auth, Session & Workers|Auth, Session & Workers]]
- [[_COMMUNITY_Content Pipeline Architecture|Content Pipeline Architecture]]
- [[_COMMUNITY_Studio & API Layer|Studio & API Layer]]
- [[_COMMUNITY_Database Schema|Database Schema]]
- [[_COMMUNITY_Google Drive Integration|Google Drive Integration]]
- [[_COMMUNITY_LLM Routing & AI|LLM Routing & AI]]
- [[_COMMUNITY_Authentication & Users|Authentication & Users]]
- [[_COMMUNITY_Node Dependencies|Node Dependencies]]
- [[_COMMUNITY_Email & Notifications|Email & Notifications]]
- [[_COMMUNITY_Meta (FacebookInstagram)|Meta (Facebook/Instagram)]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Docker & PRO Pipeline|Docker & PRO Pipeline]]
- [[_COMMUNITY_Threads Integration|Threads Integration]]
- [[_COMMUNITY_Telegram Integration|Telegram Integration]]
- [[_COMMUNITY_CICD & Deployment|CI/CD & Deployment]]
- [[_COMMUNITY_RSS Feed Ingestion|RSS Feed Ingestion]]
- [[_COMMUNITY_Public Pages & Landing|Public Pages & Landing]]
- [[_COMMUNITY_Meta App Review|Meta App Review]]
- [[_COMMUNITY_Pricing Strategy|Pricing Strategy]]
- [[_COMMUNITY_App Icon Assets|App Icon Assets]]
- [[_COMMUNITY_Theme Toggle|Theme Toggle]]
- [[_COMMUNITY_Landing Hero Demo|Landing Hero Demo]]
- [[_COMMUNITY_Integrations Grid|Integrations Grid]]
- [[_COMMUNITY_Interactive Playground|Interactive Playground]]

## God Nodes (most connected - your core abstractions)
1. `q()` - 53 edges
2. `one()` - 23 edges
3. `workspace` - 17 edges
4. `logEvent()` - 17 edges
5. `executeStep()` - 14 edges
6. `app.html — Main SPA (КонтентГров Cabinet)` - 13 edges
7. `chat()` - 11 edges
8. `compilerOptions` - 11 edges
9. `env` - 10 edges
10. `Content Pipeline — «Кишка» (Transcript → Ideas → Drafts → ToV → De-AI → Posts)` - 10 edges

## Surprising Connections (you probably didn't know these)
- `StepRun State Machine: idle → running → fresh | error; stale on upstream change` --semantically_similar_to--> `Cascade Stale Regeneration (edit prompt → step reruns → downstream marked stale)`  [INFERRED] [semantically similar]
  eng-review-content-engine.md → architecture-content-engine.md
- `Engineering Review — 3 blockers: B1 workspace UNIQUE, B2 auth, B3 async pipeline` --semantically_similar_to--> `Code Review Blockers (auth/PII, transaction safety, async pipeline)`  [INFERRED] [semantically similar]
  eng-review-content-engine.md → code-review-content-engine.md
- `Beachhead Strategy — choose one segment (coaches/psychologists/consultants) first` --semantically_similar_to--> `Target User — solo coach/psychologist self-promoting with existing transcripts`  [INFERRED] [semantically similar]
  marketing-research-plan.md → design-doc-content-engine.md
- `Recommended Wedge Approach — transcript→posts on one page (4–7 days effort)` --implemented_as--> `Content Pipeline — «Кишка» (Transcript → Ideas → Drafts → ToV → De-AI → Posts)`  [INFERRED]
  design-doc-content-engine.md → architecture-content-engine.md
- `Data Flow: POST /api/sources → executeStep(runId,step) → idea/post/plan_item → frontend` --describes--> `Content Pipeline — «Кишка» (Transcript → Ideas → Drafts → ToV → De-AI → Posts)`  [INFERRED]
  eng-review-content-engine.md → architecture-content-engine.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Content Generation Pipeline: pipeline.ts + settings blocks + OpenRouter LLM** — claude_md_pipeline_ts, architecture_content_engine_settings_blocks, architecture_content_engine_openrouter [EXTRACTED 1.00]
- **Deployment Pipeline: GitHub Actions + Hetzner + Docker Compose** — _github_workflows_deploy_yml_deploy_workflow, _github_workflows_deploy_yml_hetzner_server, deploy_md_docker_compose [EXTRACTED 1.00]
- **Market Validation Triangle: design problem + market research + competitor gap** — design_doc_content_engine_problem, research_02_market_demand_tam_sam, research_03_competitors_main_finding [INFERRED 0.85]
- **Studio Post Lifecycle: Studio → Image Editor → Composer → Schedule** — server_public_app_html_studio_section, server_public_app_html_image_editor, server_public_app_html_composer, server_public_app_html_api_schedule [EXTRACTED 1.00]
- **Legal Compliance Cluster: Privacy + Data Deletion + Terms** — server_public_privacy_html_privacy_policy, server_public_data_deletion_html_gdpr_page, server_public_terms_html_terms_of_service [EXTRACTED 1.00]
- **Onboarding → Brand Derive → Post Generation Flow** — server_public_app_html_onboarding_flow, server_public_app_html_brand_derive_voice, server_public_app_html_api_generate_from_brand, server_public_app_html_studio_section [EXTRACTED 1.00]

## Communities (26 total, 6 thin omitted)

### Community 0 - "Auth, Session & Workers"
Cohesion: 0.06
Nodes (43): userByEmail(), userBySession(), startAutopost(), tick(), one(), env, logEvent(), LogLevel (+35 more)

### Community 1 - "Content Pipeline Architecture"
Cohesion: 0.05
Nodes (48): Cascade Stale Regeneration (edit prompt → step reruns → downstream marked stale), Domain Model: Workspace, Source, PipelineRun, StepRun, Idea, Draft, FinalPost, ContentPlan, OpenRouter LLM Integration (per-step model + temperature), Content Pipeline — «Кишка» (Transcript → Ideas → Drafts → ToV → De-AI → Posts), Global Settings Blocks (Marketing Context, Tone of Voice, De-AI Rules, Content Strategy), Product Versions: v1 (MVP pipeline) → v2 (strategy + calendar) → v3 (autopublish + multi-user), auth.ts — scrypt sessions, workspace lifecycle, PostgreSQL DB Schema (workspace, post, pipeline_run, schedule_slot, etc.) (+40 more)

### Community 2 - "Studio & API Layer"
Cohesion: 0.08
Nodes (32): AI-розподіл (AI auto-distribute posts to calendar), Аналітика (Analytics) Section, API Calls: /api/account (get/password/email/export/delete/reset), API Call: POST /api/generate/from-brand, API Call: POST /api/runs/:id/generate-lite, API Calls: POST /posts/:id/image, /posts/:id/image-text, API Calls: /api/integrations/* (Telegram/Meta/Threads/GDrive/Images), API Call: GET /api/posts/studio (global finals) (+24 more)

### Community 3 - "Database Schema"
Cohesion: 0.13
Nodes (30): app_log, app_user, content_plan, content_source, email_token, gdrive_config, gdrive_folder, idea (+22 more)

### Community 4 - "Google Drive Integration"
Cohesion: 0.10
Nodes (21): DriveFile, Folder, pullFolder(), pullGdriveFolder(), startGdrivePoller(), tick(), validToken(), COSTS (+13 more)

### Community 5 - "LLM Routing & AI"
Cohesion: 0.14
Nodes (27): chat(), ChatCtx, extractJsonArray(), extractJsonObject(), OPENAI_PRICES, adaptForChannels(), buildLitePrompt(), DEFAULT_PROMPTS (+19 more)

### Community 6 - "Authentication & Users"
Cohesion: 0.13
Nodes (21): createEmailToken(), createSession(), createUser(), createWorkspaceWithDefaults(), deleteSession(), findOrCreateGoogleUser(), hashPassword(), markVerified() (+13 more)

### Community 7 - "Node Dependencies"
Cohesion: 0.08
Nodes (25): dependencies, fastify, @fastify/cookie, @fastify/cors, @fastify/multipart, @fastify/static, heic-convert, pg (+17 more)

### Community 8 - "Email & Notifications"
Cohesion: 0.19
Nodes (19): button(), send(), sendDeletionScheduledEmail(), sendEmailChangedNotice(), sendInactivityWarningEmail(), sendResetEmail(), sendVerifyEmail(), wrap() (+11 more)

### Community 9 - "Meta (Facebook/Instagram)"
Cohesion: 0.19
Nodes (8): exchangeCode(), exchangeLongLived(), fbFetch(), FbPage, igStats(), pageStats(), publishPhotoToPage(), publishToPage()

### Community 10 - "TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, module, moduleResolution, outDir, resolveJsonModule, rootDir, skipLibCheck (+4 more)

### Community 11 - "Docker & PRO Pipeline"
Cohesion: 0.20
Nodes (11): Docker Compose App Service, Docker Compose PostgreSQL 16 DB Service, Docker Media Volume (persistent uploads), API Calls: GET/PUT/DELETE /api/prompts/:step (PRO per-step model+prompt), Available LLM Models (Claude Sonnet/Haiku/Opus, GPT-4o-mini), Конвеєр (Pipeline) Section — PRO 6-step UI, PRO Mode Toggle (Lite vs PRO pipeline gate), Pricing Section (Test/Pro/Business tiers) (+3 more)

### Community 12 - "Threads Integration"
Cohesion: 0.33
Nodes (5): exchangeCode(), exchangeLongLived(), getMe(), refreshToken(), thFetch()

### Community 13 - "Telegram Integration"
Cohesion: 0.46
Nodes (7): getChat(), getChatMember(), getMe(), sendMessage(), sendPhoto(), setWebhook(), tg()

### Community 14 - "CI/CD & Deployment"
Cohesion: 0.38
Nodes (7): appleboy/ssh-action (CI/CD SSH step), GitHub Actions Deploy Workflow, Hetzner Production Server (178.105.185.67), Deploy Process: git push → GitHub Actions → SSH → Hetzner → docker compose, Caddy Reverse Proxy + Let's Encrypt TLS, Docker Compose setup on Hetzner (app + db containers), DEPLOY.md — Full Deployment Runbook (GitHub → Hetzner → Domain)

### Community 15 - "RSS Feed Ingestion"
Cohesion: 0.48
Nodes (6): atomLink(), decode(), fetchFeed(), parseFeed(), RssItem, tag()

### Community 16 - "Public Pages & Landing"
Cohesion: 0.50
Nodes (5): API Calls: /api/auth/login, /register, /request-reset, /reset, auth.html — Auth Page (login/register/forgot/reset), Google OAuth Button (/api/auth/google), b.html — Marketing Landing Page (dark-theme), index.html — Primary Landing Page (dark-theme, Ukrainian)

### Community 17 - "Meta App Review"
Cohesion: 0.50
Nodes (4): Meta App Review Submission, App Icon 1024px, Meta App Review Assets Folder, socialio / КонтентГров Brand

## Knowledge Gaps
- **97 isolated node(s):** `app_log`, `name`, `version`, `private`, `type` (+92 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `q()` connect `Authentication & Users` to `Auth, Session & Workers`, `Email & Notifications`, `Google Drive Integration`, `LLM Routing & AI`?**
  _High betweenness centrality (0.051) - this node is a cross-community bridge._
- **Why does `one()` connect `Auth, Session & Workers` to `Google Drive Integration`, `LLM Routing & AI`, `Authentication & Users`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `app.html — Main SPA (КонтентГров Cabinet)` connect `Studio & API Layer` to `Docker & PRO Pipeline`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **What connects `app_log`, `name`, `version` to the rest of the system?**
  _108 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Auth, Session & Workers` be split into smaller, more focused modules?**
  _Cohesion score 0.06398730830248546 - nodes in this community are weakly interconnected._
- **Should `Content Pipeline Architecture` be split into smaller, more focused modules?**
  _Cohesion score 0.05230496453900709 - nodes in this community are weakly interconnected._
- **Should `Studio & API Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.08064516129032258 - nodes in this community are weakly interconnected._