# Инструменты backend

Все команды выполняются из корня репозитория backend после `npm ci`. Инструменты используют только его исходники и зависимости; в runtime-образ приложения они не включаются. Для запуска на сервере нужна отдельная рабочая копия backend с dev-зависимостями. Сборка и запуск API не требуют запуска импортов или генераторов.

```sh
npm run typecheck:tools
npm run test:tools
```

`test:tools` использует синтетические профили и подставной Telegram API, не изменяет реальную базу и не обращается в Telegram. `check:telegram` выполняет только чтение Telegram API; подготовка и ручная приёмка описаны в [telegram-acceptance.md](../docs/telegram-acceptance.md).

## Подключение и личные файлы

Импортёры читают `backend/.env`, либо файл, указанный в `DOTENV_CONFIG_PATH`. Переменные процесса имеют приоритет. Обязательно выберите `--database-env DATABASE_URL` или `--database-env DEMO_DATABASE_URL`. CLI не создаёт схему базы; миграции выполняет API.

Относительные пути в аргументах разрешаются относительно корня backend. `--file` всегда обязателен. Отчёты по умолчанию сохраняются в игнорируемой Git папке `.local/imports/`. Для отчётов и резервных копий допустимы `.local/...` или абсолютный путь к отдельному приватному каталогу вне репозитория. Исходники, снимки, подтверждения сопоставлений и отчёты содержат персональные данные: не помещайте их в `src`, `data`, `tools`, Docker-образ или Git.

## Импорт Telegram

```sh
npm run import:telegram -- --database-env DEMO_DATABASE_URL --file .local/imports/community.json --report .local/imports/telegram-preview.json
```

Без `--apply` выполняется планирование и запись отчёта. `--mapping` позволяет заменить публичный словарь `tools/importers/data/community-tag-groups.json`. Подтверждённые сопоставления передаются через `--matches`, новые ID через `--new-ids`, отложенные ID через `--defer-ids`. Конфликты блокируют применение; `--skip-conflicts` обрабатывает только бесконфликтные записи. Числовые Telegram ID не выдумываются.

После проверки отчёта применение требует `--apply --backup-file .local/backups/unique-name.json`. Снимок создаётся в той же транзакции до изменения данных. Существующий backup не перезаписывается. `network-import.ts` содержит адаптер первоначальной ручной выгрузки и его синтетические тесты. Если в источнике есть нода «Я», передайте четвёртым аргументом `prepareNetworkImport` явно проверенный объект `selfIdentity: { name, username }`; персональное сопоставление не зашито в код и не угадывается.

## Исторический челлендж

```sh
npm run import:challenge -- --database-env DEMO_DATABASE_URL --file .local/imports/challenge/manifest.json --source-file .local/imports/challenge/source.xlsx --report .local/imports/challenge-preview.json
```

Передавайте проверенный manifest сопоставлений и `--source-file`: CLI сравнивает SHA-256 с manifest до чтения базы. Применение требует `--apply --backup-file .local/backups/unique-name.json`. Неоднозначные личности остаются на ручной проверке; даты отсутствующих записей не придумываются. Повторное применение того же manifest не дублирует данные.

`verify:october` — независимая проверка конкретного исторического импорта октября 2026 года с зафиксированными контрольными суммами и итогами. Она открывает транзакцию PostgreSQL `READ ONLY` и сохраняет локальный отчёт; не подходит как универсальная проверка других челленджей.

```sh
npm run verify:october -- --backup .local/backups/before-import.json --report .local/imports/challenge/applied.json --data-dir .local/imports/challenge --source-file .local/imports/challenge/source.xlsx --output .local/imports/post-import-verification.json
```

`--data-dir` содержит `october-source.json`, `participant-matches.json` и `october-import-manifest.json`. Явный `--source-file` заменяет исторический путь из JSON; хэш исходных байтов по-прежнему проверяется. База этой проверки — только `DEMO_DATABASE_URL` с именем `klan_demo`. Не запускайте импорт ради проверки доступности API: достаточно `/api/health` и чтения существующих данных.

## Справочник городов

Готовый публичный справочник поставляется в `data/location-catalog/`, скачивание источников при сборке не требуется. Для осознанного обновления подготовьте GeoNames `countryInfo.txt`, распакованный `cities15000.txt` и, при необходимости, `ru-city-names.json` в отдельном каталоге:

```sh
npm run catalog:build -- /absolute/path/to/geonames-sources
```

Генератор обновляет только `data/location-catalog/`, сохраняет информацию о лицензии и SHA-256 источников. Просмотрите diff перед фиксацией обновления.
