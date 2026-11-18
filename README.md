# Klan Backend

API закрытого сообщества: Node.js 22.12+ / TypeScript / Express / PostgreSQL 16+ / WebSocket. Репозиторий собирается и запускается самостоятельно.

## Локальный запуск без Docker

Из корня репозитория:

```sh
cd Project
npm ci
npm run setup:local
```

Заполните `Project/.env`: адрес уже установленного PostgreSQL, origin сайта и параметры Telegram. Затем из `Project`:

```sh
npm run dev
```

API доступен на `http://localhost:3001`; `GET /api/health` проверяет его готовность и соединение с базой. PostgreSQL остаётся отдельным сервисом; Docker для запуска Node.js не нужен.

Для запуска собранного приложения из `Project`: `npm run build`, затем `npm start`. Проверки: `npm run typecheck`, `npm test`, `npm run typecheck:tools`, `npm run test:tools`.

В Windows можно открыть `Scripts/start-local.cmd`: он готовит локальные настройки, устанавливает отсутствующие зависимости и запускает API с необязательным локальным PostgreSQL. Команды `npm run local:start`, `npm run local:status`, `npm run local:stop` выполняются из `Project`.

## Структура

| Каталог | Содержимое |
| --- | --- |
| `Project/` | Исходники, npm, TypeScript, тесты, инструменты импорта, публичный справочник; приватный `.env` |
| `Docker/` | Dockerfile, Compose и примеры контейнерного окружения |
| `Deploy/` | Шаблон systemd и конфигурация локального PostgreSQL |
| `Scripts/` | Подготовка локального окружения и запуск без Docker |
| `Docs/` | Архитектура, HTTP-контракт, требования и развёртывание |
| `Agreements/` | Соглашения разработки, включая сообщения коммитов на русском языке |

Сборка создаёт `Project/dist/`. Публичный каталог `Project/data/location-catalog/` нужен при запуске и поставляется вместе с приложением. Реальные `.env`, данные участников, снимки базы и локальное состояние в Git не входят.

## Документация

- [Локальный запуск, Docker и сервер](Docs/deployment.md)
- [Контракт API](Docs/API-CONTRACT.md), [архитектура](Docs/architecture.md), [требования](Docs/requirements.md)
- [Инструменты импорта и проверок](Project/tools/README.md)
- [Соглашения разработки](Agreements/CONVENTIONS.md)
