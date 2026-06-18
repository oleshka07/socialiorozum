# Деплой: GitHub → Hetzner → домен (повний ранбук)

Приклад слага продукту: `echo-by-rozum`. Заміни, якщо обереш іншу назву.
Усе, що в `< >` — підстав своє.

---

## 0. Що треба мати перед стартом
- Акаунт GitHub.
- Акаунт Hetzner Cloud (console.hetzner.cloud).
- Домен (Namecheap / GoDaddy / Cloudflare / будь-який реєстратор).
- Локально: `git` і SSH-ключ (`ssh-keygen -t ed25519` якщо ще нема).

---

## 1. Підготувати репозиторій локально

Репо-корінь = тека `КонтентГров` (усередині `server/` і `.github/`).

```bash
cd "D:\Claude\Claude\Projects\КонтентГров"

# переконатися, що секрети й сміття не потраплять у git
del server\.env 2>nul          # якщо лежить реальний .env — НЕ комітимо
# node_modules уже в server/.gitignore

# ДОДАТИ кореневий .gitignore (на випадок)
echo node_modules/> .gitignore
echo .env>> .gitignore
echo dist/>> .gitignore
```

Перевір, що в git НЕ потрапляють: `server/node_modules`, `server/.env`, `server/dist`.

```bash
git init
git add .
git status        # очима переконайся: НЕМАЄ .env і node_modules
git commit -m "init: КонтентГров (echo-by-rozum) v1+v2 skeleton"
git branch -M main
```

---

## 2. Створити репозиторій на GitHub і запушити

1. GitHub → **New repository** → назва `echo-by-rozum` → **Private** → Create (без README/gitignore, бо вони вже є).
2. Підключити й запушити:

```bash
git remote add origin https://github.com/<твій-юзер>/echo-by-rozum.git
git push -u origin main
```

Репозиторій на GitHub готовий. CI-файл `.github/workflows/deploy.yml` поїде разом — поки що він просто не матиме секретів (додамо в кроці 8).

---

## 3. Створити сервер на Hetzner

1. Hetzner Cloud Console → **New Project** (напр. `rozum`) → **Add Server**.
2. Параметри:
   - Location: Nuremberg/Falkenstein (ЄС).
   - Image: **Ubuntu 24.04**.
   - Type: **CX22** (2 vCPU / 4 GB) — з запасом для Postgres + app.
   - SSH key: додай свій публічний ключ (`~/.ssh/id_ed25519.pub`).
   - Name: `echo-prod`.
3. Create & Buy. Запиши **публічний IP** сервера.
4. **Firewall** (Hetzner → Firewalls → Create): дозволь вхідні лише
   - TCP **22** (SSH), TCP **80** (HTTP), TCP **443** (HTTPS).
   - Applied to: `echo-prod`. Порти 8080 і 5432 назовні НЕ відкривати.

---

## 4. Початкове налаштування сервера

```bash
ssh root@<IP-сервера>

# оновлення + базові пакети
apt update && apt -y upgrade
apt install -y git ca-certificates curl ufw

# Docker + compose-плагін (офіційний скрипт)
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version

# локальний фаєрвол (дублює Hetzner firewall)
ufw allow 22 && ufw allow 80 && ufw allow 443
ufw --force enable
```

---

## 5. Дати серверу доступ до приватного GitHub-репо (deploy key)

```bash
# на СЕРВЕРІ
ssh-keygen -t ed25519 -C "echo-prod-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Скопіюй виведений ключ → GitHub → репо **Settings → Deploy keys → Add deploy key** → встав → (Allow write access НЕ треба) → Add.

Клонувати репо:

```bash
# на СЕРВЕРІ
mkdir -p /opt && cd /opt
git clone git@github.com:<твій-юзер>/echo-by-rozum.git
# при першому підключенні підтвердь fingerprint: yes
```

---

## 6. Налаштувати .env на сервері

```bash
cd /opt/echo-by-rozum/server
cp .env.example .env
nano .env
```

Заповни:
- `POSTGRES_PASSWORD` — згенеруй сильний (`openssl rand -base64 24`).
- `DATABASE_URL` — той самий пароль і user/db, host лишається `db`.
- `OPENROUTER_API_KEY` — твій ключ OpenRouter.
- `OPENROUTER_REFERER=https://<твій-домен>`.

Збережи (Ctrl+O, Enter, Ctrl+X).

---

## 7. Підняти застосунок

```bash
cd /opt/echo-by-rozum/server
docker compose up -d --build
docker compose ps                 # db (healthy) + app (up)
docker compose logs -f app        # маєш побачити "[migrate] схема застосована" і "KontentGrov на ..."
curl localhost:8080/health        # {"ok":true}
```

Якщо `curl` віддав `{"ok":true}` — бекенд живий (поки лише локально на 127.0.0.1:8080).

---

## 8. CI/CD: автодеплой при push у main

GitHub → репо **Settings → Secrets and variables → Actions → New repository secret**, додай 4:

| Secret | Значення |
|---|---|
| `HETZNER_HOST` | IP сервера |
| `HETZNER_USER` | `root` |
| `HETZNER_SSH_KEY` | **приватний** ключ із сервера: `cat ~/.ssh/id_ed25519` (увесь, разом з `BEGIN/END`) |
| `APP_DIR` | `/opt/echo-by-rozum` |

Тепер кожен `git push origin main` локально → GitHub Action зайде по SSH на сервер, зробить `git pull` + `docker compose up -d --build`. Перевір: зроби дрібну зміну, запуш, глянь вкладку **Actions** на GitHub.

> Примітка: `HETZNER_SSH_KEY` — це ключ, що вже доданий як deploy key (крок 5), його ж приватну частину кладемо в секрет, щоб Action міг логінитись на сервер. Якщо хочеш суворіше — згенеруй окремий ключ саме для Actions і додай його публічну частину в `~/.ssh/authorized_keys` сервера.

---

## 9. Домен + HTTPS через Caddy (авто-сертифікат)

### 9.1 DNS
У реєстратора додай **A-запис**:
- Host: `@` (або `app`) → Value: `<IP-сервера>` → TTL: default.
- (опц.) `www` → теж A-запис на той самий IP.

Дай 5–30 хв на поширення. Перевір: `ping <твій-домен>` має віддавати IP сервера.

### 9.2 Caddy як reverse proxy
```bash
# на СЕРВЕРІ
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

nano /etc/caddy/Caddyfile
```

Вміст `Caddyfile`:
```
<твій-домен> {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
systemctl reload caddy
```

Caddy сам випустить Let's Encrypt сертифікат. Відкрий `https://<твій-домен>/health` → `{"ok":true}` по HTTPS.

---

## 10. Smoke-тест (перевіряє людина)
- `https://<домен>/health` → `{"ok":true}`.
- `https://<домен>/api/settings` → JSON із 4 блоками (marketing_context, tone_of_voice, deai_rules, content_strategy).
- Тестовий прогін через `curl`:
```bash
curl -s -X POST https://<домен>/api/sources -H "Content-Type: application/json" \
  -d '{"transcript":"Клієнт: я прокрастиную. Коуч: це перфекціонізм, не лінь."}'
# візьми runId з відповіді →
curl -s -X POST https://<домен>/api/runs/<runId>/steps/extract_ideas/run
curl -s https://<домен>/api/runs/<runId> | head
```

---

## 11. Поточні операції
- Логи: `docker compose logs -f app` (у `/opt/echo-by-rozum/server`).
- Рестарт: `docker compose restart app`.
- Бекап БД (важливо — там транскрипти):
  ```bash
  docker compose exec db pg_dump -U kontentgrov kontentgrov > /opt/backup-$(date +%F).sql
  ```
  Постав це в cron щоночі + копіюй у Hetzner Storage Box / S3.
- Оновлення: просто `git push` (CI задеплоїть) або вручну `git pull && docker compose up -d --build`.

---

## ⚠️ Що зробити ДО реальних клієнтів (з code-review / eng-review)
Зараз можна підняти й показувати — але це публічний API над транскриптами (PII). Перед тим, як пускати реальних коучів із даними клієнтів:
1. **Auth** — закрити API (мінімум басік-аут на Caddy або токен), привʼязати дані до власника.
2. **Політика даних** — згода клієнтів + retention (видаляти транскрипт після прогону).
3. **Async-прогін + транзакції** — щоб «Прогнати кишку» не обірвалось на таймауті й не лишало неузгоджений стан.

Швидкий тимчасовий захист на рівні Caddy (базова авторизація), поки нема повноцінного auth:
```
<твій-домен> {
    basic_auth {
        oleg <bcrypt-хеш>      # згенерувати: caddy hash-password
    }
    reverse_proxy 127.0.0.1:8080
}
```

---

## Перейменування під обрану назву (1 місце)
- `server/package.json` → поле `"name"`.
- Назва GitHub-репо й `APP_DIR` (`/opt/<slug>`).
- `OPENROUTER_TITLE` у `.env`.
Решта коду назви не містить.
