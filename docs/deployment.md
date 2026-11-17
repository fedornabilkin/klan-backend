# Развёртывание backend

Все команды выполняются из корня этого репозитория. Нужны Node.js 22.12+ (образ использует Node.js 24), npm и PostgreSQL 16+ либо Docker с Compose v2. Frontend и bot устанавливаются отдельно; их исходники для сборки или запуска API не требуются. `data/location-catalog/` поставляется вместе с приложением. Миграции выполняются до открытия HTTP-порта.

## Окружения и адреса

| Режим | Конфигурация | База | Запуск |
| --- | --- | --- | --- |
| Разработка | `.env`, `NODE_ENV=development` | `DATABASE_URL` доступна с хоста | `npm run dev` |
| Изолированное демо | `.env`, `DEMO_MODE=true` | `DEMO_DATABASE_URL` строго с именем `klan_demo`, иначе `.local/demo.json` | `npm run dev:demo` |
| Production Docker | `.env.compose` из `.env.compose.example` | `CONTAINER_DATABASE_URL`, адрес доступен из контейнера | `docker compose --env-file .env.compose up -d --build` |
| Production Node.js | Переменные процесса или защищённый env-файл | `DATABASE_URL` доступна с хоста | `npm start` |

Для локального API на хосте PostgreSQL может иметь адрес `127.0.0.1:5433`. В стандартном Compose адрес базы — `db:5432`; `127.0.0.1` внутри API-контейнера указывает на сам API. Поэтому Compose намеренно читает отдельную `CONTAINER_DATABASE_URL`, а не локальную `DATABASE_URL`.

Production запрещает демо и требует `APP_ORIGIN=https://ваш-домен` без пути и завершающего `/`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` без `@`, разрешённые `TELEGRAM_GROUP_IDS` и `BOT_INTERNAL_SECRET`. Секрет для bot должен совпадать с его `BOT_BACKEND_SECRET`. Числовые ID администраторов задаются в `TELEGRAM_ADMIN_IDS`; username не даёт прав администратора. Получение обновлений Telegram выполняет отдельный bot.

Реальные `.env`, `.env.compose`, `.local/`, импорты и снимки базы игнорируются Git. `.dockerignore` разрешает только исходники, lockfile, конфигурацию TypeScript и публичный справочник. Секреты передаются при запуске и не попадают в образ.

## Docker с собственной базой

1. Скопируйте `.env.compose.example` в `.env.compose`.
2. Задайте реальный origin, Telegram-параметры и секреты. Укажите одинаковый пароль в `POSTGRES_PASSWORD` и `CONTAINER_DATABASE_URL`. Пароль в URL должен быть percent-encoded, если содержит специальные символы; случайная hex-строка не требует кодирования. Изменённые `POSTGRES_USER` и `POSTGRES_DB` также должны совпадать с URL.
3. Выполните:

```sh
docker compose --env-file .env.compose config --quiet
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose ps
curl --fail http://127.0.0.1:3001/api/health
```

PostgreSQL хранит данные в именованном volume `postgres_data`; его порт доступен только в приватной сети Compose. Параметры `POSTGRES_*` применяются при инициализации пустого volume. Смена пароля в env-файле не меняет пароль существующей базы. API ждёт готовности БД, выполняет миграции и запускается непривилегированным пользователем. `/api/health` проверяет и API, и подключение к БД.

`API_BIND_ADDRESS=127.0.0.1` и `API_HOST_PORT=3001` публикуют API только на хосте. При внешнем reverse proxy на другой машине задайте подходящий приватный интерфейс и ограничьте доступ к нему. До настройки proxy браузерный production-вход через HTTP localhost не используется: сессионные cookie требуют HTTPS origin.

Обычная остановка сохраняет volume:

```sh
docker compose --env-file .env.compose down
```

`down --volumes` удаляет данные; это не команда обновления. Перед обновлением и миграциями сделайте резервную копию PostgreSQL штатным `pg_dump` или средствами провайдера. Обновление образа — повторный `up -d --build`; откат приложения не отменяет миграции базы.

## Docker с внешним PostgreSQL

Укажите в `CONTAINER_DATABASE_URL` адрес внешней базы, доступный из контейнера, и её параметры TLS согласно требованиям провайдера. Используйте самостоятельный файл вместо `compose.yaml`:

```sh
docker compose --env-file .env.compose -f compose.external-db.yaml config --quiet
docker compose --env-file .env.compose -f compose.external-db.yaml up -d --build
```

Этот вариант не создаёт PostgreSQL и не требует `POSTGRES_PASSWORD`; база и пользователь должны быть подготовлены отдельно. API выполняет собственные миграции. Учётная запись должна иметь права на создание и изменение таблиц приложения.

## Frontend, bot и reverse proxy

Frontend должен проксировать `/api/*` и `/ws` на backend с поддержкой WebSocket; браузер использует тот же HTTPS origin, что и `APP_ORIGIN`. Не публикуйте `/internal/telegram/updates` в публичном proxy: этот маршрут предназначен для bot и дополнительно защищён секретом. На одном хосте proxy может обращаться к `127.0.0.1:3001`.

Для отдельных Compose-проектов создайте общую сеть и подключите необязательный override:

```sh
docker network create klan
docker compose --env-file .env.compose -f compose.yaml -f deploy/compose.network.yaml up -d --build
```

Используйте существующую сеть, если она уже создана. Её имя задаёт `KLAN_NETWORK` (по умолчанию `klan`). Frontend и bot подключаются к той же external-сети собственными конфигурациями; URL backend в ней — `http://api:3001`. Для внешней БД замените в команде `compose.yaml` на `compose.external-db.yaml`. Основные Compose-файлы работают и без общей сети. В Docker не используйте host loopback как адрес API из другого контейнера.

API не требует статических файлов frontend. При необходимости уже собранный сайт можно раздавать самим API, явно задав `STATIC_DIR` абсолютным путём; каталог и его доставку задаёт оператор. По умолчанию никаких соседних каталогов приложение не ищет.

## Node.js и Linux/systemd

```sh
npm ci
npm run typecheck
npm test
npm run build
npm prune --omit=dev
```

На сервер поставляются `dist/`, `data/location-catalog/`, `package.json`, `package-lock.json` и production-зависимости. Если установка выполняется на сервере из подготовленного артефакта, используйте `npm ci --omit=dev`. Запускайте из корня артефакта. Секреты передайте окружением; для ручного запуска подходит защищённый `.env`. Задайте `NODE_ENV=production`, `DEMO_MODE=false` и обязательные параметры выше, затем `npm start`.

Шаблон `deploy/klan-backend.service` рассчитан на `/srv/klan-backend`, пользователя/группу `klan`, Node `/usr/bin/node` и env-файл `/etc/klan/backend.env`. Создайте системного пользователя, установите приложение, скопируйте и при необходимости адаптируйте unit; env-файл сделайте доступным только root. Убедитесь, что в нём `NODE_ENV=production`: значения env-файла имеют приоритет над `Environment=` unit.

```sh
sudo install -m 0644 deploy/klan-backend.service /etc/systemd/system/klan-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now klan-backend
sudo systemctl status klan-backend
curl --fail http://127.0.0.1:3001/api/health
```

Production Node слушает `0.0.0.0:3001`. Ограничьте доступ firewall или приватной сетью, а HTTPS обслуживайте reverse proxy. Сервис работает без права записи в дерево приложения; production-состояние хранится в PostgreSQL. На других ОС используйте менеджер процессов платформы с теми же переменными, рабочим каталогом и командой `node dist/server.js`.

## Локальный Windows launcher

После `npm ci` скопируйте `.env.example` в `.env`, укажите БД и origin frontend (например, `http://localhost:5173`), затем:

```sh
npm run local:start
npm run local:status
npm run local:stop
```

`start-local.cmd` вызывает ту же команду запуска. Скрипт запускает только API и, если явно настроен, PostgreSQL; фронтенд и bot запускаются из своих репозиториев. Читает `.env` текущего backend, учитывает переменные процесса с более высоким приоритетом, не включает демо автоматически. Для файлового демо задайте `DEMO_MODE=true` и оставьте `DEMO_DATABASE_URL` пустым. Production этим launcher не запускается.

Для управления уже установленным локальным PostgreSQL скопируйте `deploy/postgres.example.json` в `.local/postgres.json`. В нём задайте абсолютные пути `binDir`, `dataDir`, `logFile`, `host=127.0.0.1` и порт, совпадающий с URL базы. Каталог данных должен быть заранее инициализирован `initdb`, база/роль созданы, порт и loopback настроены в PostgreSQL. Скрипт ничего не скачивает, не инициализирует и не очищает; для автоматического создания новой БД используйте Compose.

Без `.local/postgres.json` используется доступный PostgreSQL из URL. С конфигурацией launcher проверяет каталог, исполняемый файл, PID и время запуска PostgreSQL. Процесс, который уже работал до launcher, используется, но не останавливается им. Занятый посторонним процессом порт приводит к явной ошибке. Журналы и сведения о собственных процессах хранятся в игнорируемой `.local/`. При перемещении репозитория остановите управляемые процессы и перенесите конфигурацию путей; старое состояние с другим корнем не принимается.
