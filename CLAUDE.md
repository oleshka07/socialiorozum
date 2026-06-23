# socialio / КонтентГров — project memory (single source of truth)

> **PROCESS (read first):** This file is the canonical, current state of the project.
> 1. **READ this file before any change** (Claude Code auto-loads it each session).
> 2. **UPDATE it after every change/deploy** — edit the relevant section AND add a line to the Changelog (bottom). Keep it as *current state*, not a diary.
> 3. Detailed historical log also lives in Claude-memory `socialio-deploy.md`, but **this file wins** if they differ.

---

## 1. What it is
**socialio.rozum.one** ("КонтентГров") — multi-tenant SMM content engine (Ukrainian UI). A user gives a source (their Instagram, a transcript, an idea, RSS) → AI generates ready-to-publish posts (text + image) in the brand voice → review → schedule → publish to Telegram / Instagram / Facebook / Threads. Goal: "щоб міг кожен" (anyone, non-technical).

Owner/operator: **Oleg** (o.stepeniev@swipescape.eu). Wants autonomous work: push, find bugs, fix, deploy without manual coding.

## 2. Stack & repo
- **Node 20 + TypeScript + Fastify 5 + PostgreSQL 16 + Docker Compose.** Code in `server/` (`server/src/*.ts`, SPA in `server/public/app.html`, auth pages `auth.html`, landing `index.html`).
- Repo: **github.com/oleshka07/socialiorozum** (PRIVATE). Push over **HTTPS via gh credential helper** (the local `~/.ssh/github_oleshka07` key is scoped to another repo).
- Local dir: `D:\Claude\Claude\Projects\КонтентГров`.

## 3. Deploy & verify
- **`git push origin main` → GitHub Actions (`.github/workflows/deploy.yml`, appleboy/ssh-action) → SSH to Hetzner `178.105.185.67` → `/opt/socialio` `git pull` + `docker compose up -d --build`.** Compose project pinned `socialio`; app on 127.0.0.1:8080; nginx + certbot at https://socialio.rozum.one.
- SSH key: `~/.ssh/rozum_hetzner`. Server pulls private repo via its own deploy key.
- **Verify a deploy:** wait box `git -C /opt/socialio rev-parse --short HEAD` == pushed commit → then `curl https://socialio.rozum.one/health`==200 + container `Up Ns` (fresh) + `curl /app | grep <marker>`. Build TS first: `cd server && npm run build` (tsc 0). For static app.html JS: extract `<script>` and `node --check`.
- **`.env` on server** (`/opt/socialio/server/.env`, chmod 600, `env_file:` in compose → needs `docker compose up -d --force-recreate --no-deps app` to re-read): editing it is **classifier-gated** — needs the user's EXPLICIT in-chat OK; I never write secret VALUES (operator pastes them).
- ⚠️ **Do NOT `git add -A`.** The working tree has the user's OWN uncommitted files: `landing/index.html`, `architecture-content-engine.md`, `research/`, `brand/`, `*.md` audits, `app-flow-architecture.md`, `google-verification-instruction.md`, `threads-holos-handoff.md`. **Stage only the specific `server/**` files (and this CLAUDE.md) you changed.**

## 4. Env / secrets (names only — never values in code/chat/git)
`DATABASE_URL`, `SESSION_SECRET`, `APP_BASE_URL`, `OPENROUTER_API_KEY`, **`OPENAI_API_KEY`** (Lite direct + gpt-image-1), **`FAL_KEY`** (FLUX images), **`GEMINI_API_KEY`** (Nano Banana images), `RESEND_API_KEY` + `RESEND_FROM=socialio <noreply@rozum.one>` (rozum.one VERIFIED → delivers to all), `GOOGLE_CLIENT_ID/SECRET` + `GOOGLE_API_KEY` (login + Drive Picker), `META_APP_ID/SECRET`, `THREADS_APP_ID/SECRET`, **`TELEGRAM_BOT_TOKEN` + `TELEGRAM_BOT_USERNAME`** (shared bot `@R_Socialio_bot`), `ADMIN_EMAILS`. All keys present/active per user (OpenAI/FAL/Gemini/Telegram added).

## 5. Architecture (server/src)
- `server.ts` — all routes + preHandler auth (cookie session, scoped to `req.user.workspace_id`; `/api/auth/*` + `/api/webhooks/*` exempt) + workers started after `listen`.
- `auth.ts` (scrypt sessions, `createWorkspaceWithDefaults`/`seedWorkspaceDefaults`, account lifecycle helpers) · `email.ts` (Resend) · `defaults.ts` (DEFAULT_SETTINGS now mostly EMPTY — brand derived from IG) · `db.ts` · `env.ts` · `log.ts`.
- `pipeline.ts` — **Lite** (`buildLitePrompt`/`generatePostsOnePass` = ONE gpt-4o call → posts, default path) + **PRO** 6-step (`STEP_ORDER=[extract_ideas,drafts,tone,format,deai,strategy]`, `executeStep`, sequential+chained), `deriveVoice`/`deriveBrandFromText`, `generateStrategy`, `adaptForChannels`, `rewritePost`. `openrouter.ts` `chat()` routes `openai/*`→api.openai.com when OPENAI_API_KEY set else OpenRouter.
- Channels: `telegram.ts`+`tgbot.ts` (shared bot webhook), `threads.ts`, `meta.ts` (FB/IG + `getRecentMedia` for voice), `publisher.ts` `publishPostToChannels` (composer + autopost; all 4 nets post WITH image).
- `media.ts` (saveMedia/MEDIA_DIR/deleteMediaFile/getThumb sharp thumbnails/convertAllHeif) · **`images.ts`** (AI image gen: openai gpt-image-1 / fal FLUX / gemini Nano Banana + `overlayHeadline` sharp+SVG text overlay).
- Sources: `rss.ts`+`rss-poller.ts`, `gdrive.ts`+`gdrive-poller.ts` (drive.file+Picker), transcribers `fireflies.ts`/`grain.ts`/`meetgeek.ts`.
- Workers (setInterval, started in `listen`): `autopost.ts` (60s), `rss-poller` (15m), `gdrive-poller` (15m), `lifecycle.ts` (6h: account purge/retention/orphan-media), boot `convertAllHeif`, `initTelegramBot`.
- **DB tables:** workspace, app_user (+last_active_at/deleted_at/inactivity_warned_at/data_purged_at), user_session, email_token, settings_block, prompt_template, rubric, strategy, source, pipeline_run, step_run, idea, post (+review/channels jsonb/media_id/image_prompt/**image_base/headline**), content_plan, plan_item, schedule_slot (+post_id/result), media_asset, telegram_config, tg_connect, telegram_publish, threads_config/_publish, meta_config, meta_publish, content_source (RSS), gdrive_config/_folder, transcription_config, llm_usage, app_log. Most reference `workspace ON DELETE CASCADE`; `app_user.workspace_id` is 1:1 (→ multi-workspace is the multi-account plan).

## 6. Feature inventory (current, all DEPLOYED & live)
- **Auth/account:** email+scrypt + Google OAuth; multi-tenant per-workspace; account lifecycle (self-delete soft+14d grace, inactivity retention, media cleanup, password/email/GDPR-export); **«🔄 Почати з чистого листа»** reset (wipes content+brand, keeps channels, re-onboards) — temporary testing aid.
- **Onboarding (IG-first, instant posts):** step 0 connect Instagram (popup OAuth, account picker if multiple) → pull ~20 IG captions → `deriveBrandFromText` (niche/voice/strategy/language, OVERWRITES on switch) → steps brand/voice/source (skippable; «Пропустити» finishes with what's there) → **progress popup (3 key-points)** → auto-generate posts **+ images** → land on Студія. No transcript needed (generate-from-brand).
- **Generation Lite/PRO:** **Lite = single gpt-4o call** (cheap, default). **PRO** = the 6-step Конвеєр (per-step prompt+model), gated by `pro` flag (no real billing; topbar ⚡PRO pill + tariffs page toggle it). Studio «💡 Ідеї→пости» block (generate ideas → pick → posts). «👁 Промт» preview. regenerate/adapt keep ToV+deAI.
- **Images:** AI gen 3 providers (OpenAI/FLUX/Nano Banana, switch in Settings «🎨»), prompt comes free from Lite output; **text overlay** (sharp+SVG headline from post's first line, toggle «Накладати заголовок»); onboarding auto-images; per-post «🎨» (currently a small icon — **being upgraded, see §7**). Media library + Google Drive (Picker) + upload-from-computer in composer; HEIC→JPEG; sharp thumbnails `/thumb/:name`.
- **Channels:** Telegram (shared bot `@R_Socialio_bot` — connect via deep-link/forward; or own bot), Instagram+Facebook (Meta OAuth), Threads. All post WITH image. `publishPostToChannels` shared by composer + autopost. No silent fallback.
- **Composer/publish:** `openComposer` modal (channel chips + AI per-net adapt + photo + date/time + publish-now/schedule). Calendar (Публікація): bank + drag-drop + AI-distribute + per-slot status (✅/⏳/⚠ + result tooltip), timezone-aware (workspace `timezone` setting).
- **Analytics:** real, from `/api/published` (union of *_publish sent) — count + weekly chart + per-channel + «Останні публікації»; AI cost from llm_usage. (Engagement/reach still deferred.)
- **Gamification:** completeness score pill, tasks modal, nav badges, in-section task strip. **Tariffs** page (Lite vs PRO, fake billing).
- **Transcribers:** Fireflies (verified) / Grain / MeetGeek (best-effort, need real keys). Webhook auto-import for Fireflies.

## 7. IN PROGRESS / pending
- **🔧 IMAGE EDITOR (interrupted mid-build — UNCOMMITTED & BROKEN).** Goal (per competitor study Predis.ai/Ocoya/PostNitro): replace the tiny «🎨» icon with a **prominent «🎨 Зображення» button** → opens a **mini image editor** (preview, editable «Текст на зображенні» field, «Згенерувати» + «Оновити лише текст» [cheap re-overlay on saved base, no regen], overlay toggle); same button in composer.
  - Done so far (uncommitted): `schema.sql` +`post.image_base`+`post.headline`; `images.ts` saves base image separately + new `overlayForPost(ws,postId,headline,overlayOn)` (re-overlay on base, cheap).
  - **BROKEN:** `generateImageForPost` now reads `opts?.headline` but the signature still lacks an `opts` param → won't compile. **Must fix the signature** (add `opts?:{headline?:string}`) before anything builds.
  - **NOT done:** server endpoint for `overlayForPost` (e.g. `POST /api/posts/:id/image-text`), the prominent button + editor modal in app.html (studio card + composer), wiring.
- **Deferred (decided):** real billing/payment (PRO is flag-only); multi-account = **multi-workspace/brand switcher** (workspace_member table + active-ws in session); website-scan brand onboarding; engagement analytics; v1-step-3 pipeline cleanup (**SKIPPED — ~zero user value, gated PRO only; do not re-raise**).

## 8. Key decisions & gotchas
- **Secrets NEVER in chat/code/git.** Operator sets all keys in server `.env`. If user pastes a key in chat → tell them to REVOKE + add via `.env` themselves.
- **Classifier blocks** prod-DB writes via remote shell, secret-env dumps, and unauthorized `.env` edits → I verify via tsc / served markers / HEAD-match / health, NOT authed live tests (user clicks through the UI).
- Keep the product name **socialio/КонтентГров** (NOT "plyn" — that was just the design source). The current app.html IS the "Plyn" warm-paper light/dark design (commit 4132c5e).
- `defaults.ts` is intentionally EMPTY for brand fields (IG fills them) — old stale workspaces need «Почати з чистого листа» to refresh.
- Lite is the default path; the 6-step PRO pipeline is secondary/gated — don't over-invest in it.

## 9. Changelog (newest first — append every change)
- (uncommitted, BROKEN) image editor groundwork: post.image_base/headline + images.ts base-image + overlayForPost — **needs generateImageForPost `opts` param fix + endpoint + UI.**
- `d71554e` media thumbnails (`/thumb/:name`, sharp, disk cache) · `a7c5093` ideas selectable cards · `a21a418` re-derive brand overwrites on IG switch (+any language) · `ee37d55` multi-provider transcribers (Fireflies/Grain/MeetGeek) · `b866753` gamification phase 2 (task strip) · `5eb6ec0` tariffs page (fake billing) · `67ec64c` gamification phase 1 · `2533955` Threads posts images · `8e3a6a5` Studio ideas→posts block · `5ce64e4` Telegram photo posts + shared bot · `a63b9bc` brand-from-Instagram + drop hardcoded defaults · `496a7eb` onboarding popup lines.
- `21f9a23` text overlay (sharp+SVG) · `ee1e8e1` AI image gen 3-provider · `f2d4dfb` Lite/PRO UI · `331111f` OAuth popup + account picker · `9982392` OpenAI-direct · `705db54` reset button · `ef450f0` Lite single-pass · `fca38db` IG-first onboarding · `9653ec5` instant first posts · `828258b` timezone · `de70c3b` dead-code cleanup · `ceb4868` publishing visibility · `cd7bbb4` account lifecycle · `4132c5e` Plyn redesign.
