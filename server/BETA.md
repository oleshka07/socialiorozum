# БЕТА-середовище: beta.socialio.rozum.one (разове розгортання)

Прод і бета живуть на одному сервері, повністю ізольовані:

| | ПРОД | БЕТА |
|---|---|---|
| URL | socialio.rozum.one | beta.socialio.rozum.one (+ PIN 2345) |
| Гілка | `main` | `beta` |
| Тека | /opt/socialio | /opt/socialio-beta |
| Порт | 127.0.0.1:8080 | 127.0.0.1:8081 |
| Docker-проєкт | socialio | socialio-beta (своя БД, свої медіа) |

## Щоденний цикл (після розгортання)
1. Розробка йде в гілку `beta` → GitHub Actions сам деплоїть бету (~2 хв).
2. Тестуєш на beta.socialio.rozum.one скільки треба (це повноцінний продукт зі своєю БД).
3. Все ок → merge `beta` → `main` → прод автоматично оновлюється для всіх.
4. Критичний хотфікс: одразу в `main`, потім merge `main` → `beta`.

## Разове розгортання (~10 хв, виконуєш ти)

### 1. DNS
A-запис: `beta.socialio.rozum.one` → `178.105.185.67` (та сама панель, де socialio.rozum.one).

### 2. На сервері: клон + .env
```bash
ssh <user>@178.105.185.67
git clone <URL-репо-як-у-/opt/socialio> /opt/socialio-beta
cd /opt/socialio-beta && git checkout beta
cp /opt/socialio/server/.env /opt/socialio-beta/server/.env
chmod 600 /opt/socialio-beta/server/.env
nano /opt/socialio-beta/server/.env
```
У `.env` бети ДОДАЙ/ЗМІНИ рівно ці рядки (решту лишай як на проді):
```
COMPOSE_PROJECT_NAME=socialio-beta
APP_PORT=8081
APP_BASE_URL=https://beta.socialio.rozum.one
BETA_PIN=2345
TELEGRAM_WEBHOOK_OFF=1
POSTGRES_PASSWORD=<НОВИЙ сильний пароль: openssl rand -base64 24>
DATABASE_URL=postgres://kontentgrov:<той-самий-НОВИЙ-пароль>@db:5432/kontentgrov
```
⚠️ `TELEGRAM_WEBHOOK_OFF=1` обов'язково — інакше бета вкраде webhook бота в прода.

### 3. Підняти стек
```bash
cd /opt/socialio-beta/server && docker compose up -d --build
curl -s 127.0.0.1:8081/health   # має бути 200
```

### 4. nginx + сертифікат
```bash
sudo tee /etc/nginx/sites-available/beta.socialio.rozum.one >/dev/null <<'EOF'
server {
    server_name beta.socialio.rozum.one;
    listen 80;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/beta.socialio.rozum.one /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d beta.socialio.rozum.one
```

### 5. Перевірка
- https://beta.socialio.rozum.one → сторінка PIN → 2345 → кабінет з помаранчевим бейджем **BETA**.
- Зареєструй на беті тестовий акаунт (БД окрема, продові акаунти сюди не переносяться).

### 6. (Опційно) OAuth на беті
Щоб на беті підключались Instagram/FB/Threads/Google-логін — додай у відповідні консолі redirect URI з `beta.socialio.rozum.one`. Без цього на беті працює все інше (email-вхід, генерація, Telegram-публікації).

## Нюанси
- **Публікація в Telegram-канали з бети працює** (той самий бот, прямі API-виклики).
- **DM-фічі бота** (ловець ідей, /idea, зведення) обробляє ПРОД (webhook один на бота). Бот-фічі тестуються після промоушна в main.
- Медіа `/media/*` на беті відкриті без PIN (Telegram/Meta тягнуть картинку по URL при публікації) — імена файлів невгадувані.
