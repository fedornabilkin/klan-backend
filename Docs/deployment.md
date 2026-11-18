# Запуск и развёртывание backend

Нужны Node.js 22.12+ (контейнерный образ использует Node.js 24), npm и PostgreSQL 16+. Локальная разработка работает без Docker. Команды npm выполняются из `Project/`, команды Docker и установка systemd ниже — из корня репозитория. Исходники frontend и bot для сборки API не нужны.

## Локальный запуск через Node.js

Из корня репозитория:

```sh
cd Project
npm ci
npm run setup:local
```

Перед обновлением структуры остановите старые процессы приложения. Подготовка не останавливает процессы и ничего не удаляет; прежние файлы остаются резервными копиями. PID и блокировки старых процессов в `Project/.local/` не переносятся.

`setup:local` готовит приватный `Project/.env` по `Project/.env.example`. При обновлении прежней структуры он подхватывает старые локальные настройки без перезаписи уже существующих настроек в `Project/`. Перед первым запуском проверьте адрес PostgreSQL и `APP_ORIGIN` в `Project/.env`. Файлы настоящей базы и резервные копии остаются в своих приватных каталогах; подготовка их не создаёт и не очищает.

Запустите PostgreSQL своим обычным способом, затем из `Project/`:

```sh
npm run dev
```

Для запуска собранного приложения:

```sh
npm run build
npm start
```

Оба варианта работают на Windows, Linux и macOS. API по умолчанию доступен на `http://localhost:3001`; `GET /api/health` проверяет и HTTP-сервер, и подключение к базе. Миграции выполняются транзакционно до открытия HTTP-порта; ошибка миграции прерывает запуск. Публичный справочник `Project/data/location-catalog/` должен находиться рядом с приложением.

## Окружения и адреса

| Режим | Конфигурация | База | Запуск |
| --- | --- | --- | --- |
| Разработка | `Project/.env`, `NODE_ENV=development` | `DATABASE_URL` доступна с хоста | `npm run dev` из `Project/` |
| Изолированное демо | `Project/.env`, `DEMO_MODE=true` | `DEMO_DATABASE_URL` строго с именем `klan_demo`, иначе `Project/.local/demo.json` | `npm run dev:demo` из `Project/` |
| Production Docker | `Docker/.env` из `Docker/.env.example` | `CONTAINER_DATABASE_URL`, адрес доступен из контейнера | Compose из корня репозитория |
| Production Node.js | Переменные процесса или защищённый env-файл | `DATABASE_URL` доступна с хоста | `npm start` из `Project/` |

Для локального API PostgreSQL может иметь адрес `127.0.0.1:5433`. В стандартном Compose адрес базы — `db:5432`; `127.0.0.1` внутри API-контейнера указывает на сам API. Поэтому Compose читает отдельную `CONTAINER_DATABASE_URL`, а не локальную `DATABASE_URL`.

Для демо `DEMO_USER_ID` задаёт существующий внутренний ID профиля; произвольный первый пользователь не выбирается. `DEMO_ACCESS_LEVEL=admin` действует только для демонстрационной сессии. Путь `DEMO_DATA_FILE=.local/demo.json` разрешается от `Project/`; можно указать абсолютный путь к приватному файлу. Не используйте production-базу для демовхода.

Production запрещает демо и требует `APP_ORIGIN=https://ваш-домен` без пути и завершающего `/`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` без `@`, разрешённые `TELEGRAM_GROUP_IDS` и `BOT_INTERNAL_SECRET`. Этот секрет должен совпадать с `BOT_BACKEND_SECRET` отдельного bot. Числовые ID администраторов задаются в `TELEGRAM_ADMIN_IDS`; username не даёт прав администратора. Получение обновлений Telegram выполняет отдельный bot.

Реальные `.env`, `Project/.local/`, импорты и снимки базы исключены из Git. `Docker/Dockerfile.dockerignore` ограничивает build context исходниками, npm/TypeScript-конфигурацией и публичным справочником. Секреты передаются при запуске и не попадают в образ.

## Windows: запуск API и подготовленного PostgreSQL

Откройте `Scripts/start-local.cmd`. Он выполняет подготовку локального окружения, устанавливает отсутствующие зависимости в `Project/` и запускает API в фоне. Те же команды доступны из `Project/`:

```sh
npm run local:start
npm run local:status
npm run local:stop
```

Этот менеджер процессов предназначен для Windows. На Linux/macOS используйте обычные `npm run dev` или `npm start` и установленный PostgreSQL; Docker не требуется.

Менеджер читает `Project/.env`, учитывает переменные процесса с более высоким приоритетом и не включает демо автоматически. Скрипт запускает только API и, если явно настроен, PostgreSQL; frontend и bot запускаются из своих репозиториев. Production этим менеджером не запускается.

Для управления установленным PostgreSQL скопируйте `Deploy/postgres.example.json` в `Project/.local/postgres.json`. Задайте абсолютные пути `binDir`, `dataDir`, `logFile`, `host=127.0.0.1` и порт, совпадающий с URL базы. Каталог данных должен быть заранее инициализирован `initdb`, база/роль созданы, порт и loopback настроены в PostgreSQL. Скрипт ничего не скачивает, не инициализирует и не очищает.

Без `Project/.local/postgres.json` API использует уже работающий PostgreSQL из URL. При наличии конфигурации менеджер проверяет каталог, исполняемый файл, PID и время запуска PostgreSQL. Процесс, работавший до менеджера, используется, но не останавливается им. Занятый посторонним процессом порт приводит к явной ошибке. Журналы и состояние собственных процессов находятся в `Project/.local/`. Перед переносом структуры остановите старые управляемые процессы; состояние с другим корнем не принимается.

## Docker с собственной базой

Следующие команды выполняются из корня репозитория. Нужны Docker и Compose v2.

1. Скопируйте `Docker/.env.example` в `Docker/.env`.
2. Задайте origin, Telegram-параметры и секреты. Укажите одинаковый пароль в `POSTGRES_PASSWORD` и `CONTAINER_DATABASE_URL`. Пароль в URL должен быть percent-encoded, если содержит специальные символы; случайная hex-строка не требует кодирования. Изменённые `POSTGRES_USER` и `POSTGRES_DB` также должны совпадать с URL.
3. Выполните:

```sh
docker compose --env-file Docker/.env -f Docker/compose.yaml config --quiet
docker compose --env-file Docker/.env -f Docker/compose.yaml up -d --build
docker compose --env-file Docker/.env -f Docker/compose.yaml ps
curl --fail http://127.0.0.1:3001/api/health
```

Отдельная сборка образа: `docker build -f Docker/Dockerfile -t klan-backend .`. Build context — корень этого репозитория; Dockerfile копирует приложение из `Project/`. В контейнере рабочий каталог — `/app`.

PostgreSQL хранит данные в volume `postgres_data`; его порт доступен только в приватной сети Compose. Параметры `POSTGRES_*` применяются при инициализации пустого volume. Смена пароля в env-файле не меняет пароль существующей базы. API ждёт готовности БД, выполняет миграции и запускается непривилегированным пользователем.

`API_BIND_ADDRESS=127.0.0.1` и `API_HOST_PORT=3001` публикуют API только на хосте. При reverse proxy на другой машине задайте подходящий приватный интерфейс и ограничьте доступ к нему. Production-вход использует HTTPS origin и защищённые сессионные cookie.

Обычная остановка сохраняет volume:

```sh
docker compose --env-file Docker/.env -f Docker/compose.yaml down
```

`down --volumes` удаляет данные; это не команда обновления. Перед обновлением и миграциями сделайте резервную копию PostgreSQL штатным `pg_dump` или средствами провайдера. Обновление образа — повторный `up -d --build`; откат приложения не отменяет миграции базы.

## Docker с внешним PostgreSQL

Задайте в `Docker/.env` переменную `CONTAINER_DATABASE_URL` с адресом внешней базы, доступным из контейнера, и параметрами TLS согласно требованиям провайдера. Используйте самостоятельный файл вместо `Docker/compose.yaml`:

```sh
docker compose --env-file Docker/.env -f Docker/compose.external-db.yaml config --quiet
docker compose --env-file Docker/.env -f Docker/compose.external-db.yaml up -d --build
```

Этот вариант не создаёт PostgreSQL и не требует `POSTGRES_PASSWORD`; база и пользователь должны быть подготовлены отдельно. API выполняет собственные миграции. Учётная запись должна иметь права на создание и изменение таблиц приложения.

## Frontend, bot и reverse proxy

Frontend проксирует `/api/*` и `/ws` на backend с поддержкой WebSocket; браузер использует тот же HTTPS origin, что и `APP_ORIGIN`. Не публикуйте `/internal/telegram/updates` в публичном proxy: этот маршрут предназначен для bot и дополнительно защищён секретом. На одном хосте proxy может обращаться к `127.0.0.1:3001`.

Для отдельных Compose-проектов создайте общую сеть и подключите необязательный override:

```sh
docker network create klan
docker compose --env-file Docker/.env -f Docker/compose.yaml -f Docker/compose.network.yaml up -d --build
```

Если сеть уже есть, создавать её повторно не нужно. Её имя задаёт `KLAN_NETWORK` (по умолчанию `klan`). Frontend и bot подключаются к ней собственными конфигурациями; URL backend — `http://api:3001`. Для внешней БД замените `Docker/compose.yaml` на `Docker/compose.external-db.yaml`. Основные Compose-файлы работают и без общей сети. Для последующих `up`, `down`, `logs` используйте те же `--env-file` и `-f`.

API не требует статических файлов frontend. При необходимости уже собранный сайт можно раздавать самим API, явно задав `STATIC_DIR` абсолютным путём. Каталог и его доставку задаёт оператор; по умолчанию соседние каталоги не просматриваются.

## Production Node.js и Linux/systemd

Из корня репозитория:

```sh
cd Project
npm ci
npm run typecheck
npm test
npm run build
npm prune --omit=dev
```

На сервер поставляются `Project/dist/`, `Project/data/location-catalog/`, `Project/package.json`, `Project/package-lock.json` и production-зависимости в `Project/node_modules/`. Если установка выполняется на сервере из подготовленного артефакта, используйте `npm ci --omit=dev` из `Project/`. Секреты передайте окружением; для ручного запуска подходит защищённый `Project/.env`. Задайте `NODE_ENV=production`, `DEMO_MODE=false` и обязательные параметры выше, затем из `Project/` выполните `npm start`.

Шаблон `Deploy/klan-backend.service` рассчитан на приложение в `/srv/klan-backend/Project`, пользователя/группу `klan`, Node `/usr/bin/node` и env-файл `/etc/klan/backend.env`. Создайте системного пользователя, установите приложение, скопируйте и адаптируйте unit; env-файл сделайте доступным только root. В нём должно быть `NODE_ENV=production`: значения env-файла имеют приоритет над `Environment=` unit.

Из корня репозитория:

```sh
sudo install -m 0644 Deploy/klan-backend.service /etc/systemd/system/klan-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now klan-backend
sudo systemctl status klan-backend
curl --fail http://127.0.0.1:3001/api/health
```

Production Node слушает `0.0.0.0:3001`. Ограничьте доступ firewall или приватной сетью, а HTTPS обслуживайте reverse proxy. Сервис работает без права записи в дерево приложения; production-состояние хранится в PostgreSQL. На других ОС используйте менеджер процессов платформы с теми же переменными, рабочим каталогом `Project/` и командой `node dist/server.js`.
