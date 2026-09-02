# Відновлення з бекапу (на тому ж боксі)

Бекапи: `/opt/socialio-backups/` — щоночі 03:20 UTC, 14 днів ротації, лог `/opt/socialio-backup.log`.
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
curl -s https://socialio.rozum.one/health
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

## Межа

Копія лежить на тому самому диску. Втрата диска = втрата бекапів. Копія поза сервером
(S3/Backblaze/інший бокс) — окрема задача, див. CLAUDE.md §7.
