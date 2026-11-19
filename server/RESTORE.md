# Відновлення з бекапу (на тому ж боксі)

Бекапи: `/opt/socialio-backups/` - щоночі о 03:20 за часом сервера (UTC+2, тобто 01:20 UTC; у назві файлу - час UTC), лог `/opt/socialio-backup.log`. Ротація (з 19.11):
бази обох стеків і медіа проду - 15 днів, **медіа беті - лише 3 найновіші архіви** (кожен ~1,4 ГБ; за 15 днів
тека виросла до 21 ГБ). Тобто медіа беті відновлюється хіба що на 3 ночі назад.
Файли: `<проєкт>-db-<дата>.dump` (pg_dump custom) і `<проєкт>-media-<дата>.tgz` (том медіа).
Проєкт = `socialio` (прод) або `socialio-beta`.

## База (повне відновлення)

```sh
cd /opt/socialio/server            # або /opt/socialio-beta/server
docker compose stop app
# --clean --if-exists: перезаписує обʼєкти; без --create, бо база вже існує
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < /opt/socialio-backups/socialio-db-20260901-0320.dump
docker compose start app
curl -s https://holos.rozum.one/health   # бета: https://beta.holos.rozum.one/health
```

## Медіа

```sh
docker run --rm -v socialio_media:/m -v /opt/socialio-backups:/b alpine \
  sh -c 'cd /m && tar xzf /b/socialio-media-20260901-0320.tgz'
```

## Перевірка, що бекап живий (раз на місяць)

```sh
docker compose exec -T db sh -c 'pg_restore --list' < /opt/socialio-backups/socialio-db-<дата>.dump | head
```
Якщо список таблиць вивівся — файл цілий.

## Місце

Скрипт ставить деплой (обидва воркфлоу пишуть той самий `/opt/socialio-backup.sh`). Сповіщення адміну
приходить, коли тека бекапів понад 8 ГБ або на диску вільно менше 15 ГБ (стереже прод); ті самі цифри -
Налаштування → Профіль → «🩺 Здоровʼя сервісу» → «💾 Місце».

```sh
du -sh /opt/socialio-backups/* | sort -h | tail     # що найбільше
/opt/socialio-backup.sh prune                       # лише ротація за правилами вище, без нового бекапу
df -h /                                             # скільки вільно
```
Щоб змінити строки - `KEEP_DAYS` і `BETA_MEDIA_KEEP` у `.github/workflows/deploy.yml` **і** `deploy-beta.yml`
(на хості скрипт перезапише наступний деплой).

## Межа

Копія лежить на тому самому диску. Втрата диска = втрата бекапів. Копія поза сервером
(S3/Backblaze/інший бокс) — окрема задача, див. CLAUDE.md §7.
