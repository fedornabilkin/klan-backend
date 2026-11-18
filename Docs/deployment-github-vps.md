# Выкладка Клана на сервер Облакина

У каждого компонента свой репозиторий и свой workflow **Production**. После успешных проверок push в `main` (включая merge pull request) обновляет только этот компонент. В pull request выполняются проверки. Первый выпуск выполняйте по порядку: бэкенд → фронтенд → бот.

| Компонент | Что происходит при выкладке |
| --- | --- |
| Бэкенд | Сервер получает проверенный коммит `klan-backend` из GitHub, собирает API на месте и запускает его через Compose. Сохраняются база, закрытая сеть и адрес API для бота. |
| Фронтенд | GitHub собирает `Project/dist`. На сервер по SSH поступают архив статики и контрольная сумма. nginx отдаёт опубликованные файлы из `/var/www/klan`. |
| Бот | GitHub публикует образ в GHCR. Сервер скачивает его по digest и запускает один worker с прежним постоянным хранилищем offset. |

## 1. Проверить существующий VPS

Команды рассчитаны на сервер Debian/Ubuntu с системным nginx, работающим SSH-пользователем `deploy`, Docker Engine и Compose **2.30.0+**. Общий сервер должен поддерживать `linux/amd64` для текущего образа бота. Для сборки API на сервере нужны Git, место под исходники, образы и кеш сборки, а также доступ к GitHub, Docker Hub и npm registry. GHCR нужен для бота. Фронтенд собирается на GitHub и использует на VPS nginx и обычные файловые утилиты.

```sh
command -v git rsync tar gzip sha256sum bash curl flock realpath
docker compose version
sudo -u deploy docker info >/dev/null
sudo nginx -t
sudo ss -lntp | grep -E ':3101\b' || true
```

Порт `127.0.0.1:3101` должен быть доступен для API Клана. Публичные 80 и 443 обслуживает существующий nginx. Для доставки GitHub Actions должен иметь доступ к SSH-порту сервера.

## 2. Подготовить каталоги и данные

Скопируйте из этого репозитория [Deploy/setup-server.sh](../Deploy/setup-server.sh) в `/tmp/klan-setup-server.sh` на VPS и выполните:

```sh
sudo bash /tmp/klan-setup-server.sh deploy
```

Скрипт можно повторить при обновлении с прежней схемы. Он создаёт следующие ресурсы:

| Ресурс | Назначение |
| --- | --- |
| `/var/www/klan` | Только публичные файлы сайта. Пользователь деплоя записывает их, nginx читает. Используйте отдельный каталог для этого сайта: публикация удаляет устаревшие файлы. |
| `/opt/klan/frontend` | Доставка и предыдущие версии статики. |
| `/opt/klan/backend` | Локальный Git-репозиторий, каталоги релизов с приватным окружением, резервные копии базы. |
| `/opt/klan/bot` | Релизы и приватное окружение бота. |
| Сеть `klan-production` | Бот обращается к API по `http://api:3001`. |
| Volumes `klan-production-postgres` и `klan-production-bot-state` | Данные PostgreSQL и подтверждённая позиция чтения Telegram. |

При переносе существующих данных сначала спланируйте резервное копирование и восстановление. Новая пустая база получает схему при первом старте API. Если бот уже работал, остановите прежний экземпляр и перенесите offset до запуска нового. [Инструкция бота](https://github.com/fedornabilkin/klan-bot/blob/main/Docs/deployment-github-vps.md)

## 3. Настроить домен в nginx

Направьте DNS сайта на VPS. Для нового домена добавьте виртуальный хост и выпустите сертификат. Для существующего домена Клана, который проксирует UI на порт 8088, замените маршрут UI на раздачу статики из `/var/www/klan`. Сначала проверьте файлы сайта и спланируйте переключение виртуального хоста на первую статическую версию. Виртуальные хосты Облакина обслуживаются отдельно.

Шаблон сохраняет URL браузера: маршруты приложения открывают `index.html`, `/api` и `/ws` идут на `127.0.0.1:3101`, а публичный `/internal` отвечает 404. Укажите домен и пути к сертификату, выполните `sudo nginx -t` и затем `sudo systemctl reload nginx`. В последующих релизах фронтенда меняются только файлы сайта. [Настройка HTTPS и инструкция первого выпуска](https://github.com/fedornabilkin/klan-frontend/blob/main/Docs/deployment-github-vps.md) · [Шаблон nginx](https://github.com/fedornabilkin/klan-frontend/blob/main/Deploy/nginx.production.conf)

## 4. Настроить GitHub

В Settings → Environments каждого репозитория создайте окружение `production`. Разрешите ветку `main`. Для автоматического выпуска отключите Required reviewers и Wait timer. Настройки доступны в репозиториях [backend](https://github.com/fedornabilkin/klan-backend/settings/environments), [frontend](https://github.com/fedornabilkin/klan-frontend/settings/environments) и [bot](https://github.com/fedornabilkin/klan-bot/settings/environments).

Добавьте пять **Environment secrets** в каждом из трёх репозиториев:

| Имя | Значение |
| --- | --- |
| `DEPLOY_HOST` | DNS-имя или IPv4 сервера |
| `DEPLOY_PORT` | SSH-порт, обычно `22` |
| `DEPLOY_USER` | Пользователь сервера, по умолчанию `deploy` в инструкции |
| `DEPLOY_SSH_KEY` | Приватный SSH-ключ с переносами строк. Публичная часть должна быть в `authorized_keys` пользователя. |
| `DEPLOY_KNOWN_HOSTS` | Проверенная запись SSH-ключа сервера для точных адреса и порта |

Для того же хоста и пользователя подойдут значения из настройки Облакина. Если запись ключа новая, получите её через `ssh-keyscan -p ПОРТ -t ed25519 ИМЯ-СЕРВЕРА` и сверьте fingerprint с `sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` через доверенную консоль VPS.

Дальше настройки различаются:

- **Frontend.** В *Environment variables* задайте `PRODUCTION_URL`, например `https://community.example.com`. По этому адресу скрипт проверит опубликованную версию. Для сборки сайта используются относительные `/api` и `/ws`.
- **Backend.** В *Environment secrets* добавьте `PRODUCTION_ENV` по [примеру API](../Docker/.env.production.example). Сервер читает исходники по HTTPS краткоживущим токеном GitHub Actions с правом `contents: read`. Дополнительный ключ доступа к приватному Git-репозиторию на VPS не требуется.
- **Bot.** В *Environment secrets* добавьте `PRODUCTION_ENV` по [примеру бота](https://github.com/fedornabilkin/klan-bot/blob/main/Docker/.env.production.example). Разрешите workflow публикацию и чтение своего пакета GHCR. Доступ к реестру обеспечивается встроенным токеном workflow.

## 5. Заполнить окружение API и бота

В `PRODUCTION_ENV` значения задаются построчно, в формате `KEY=value`, без `export`, внешних кавычек и подстановки ссылок на другие переменные.

- Для API установите `APP_ORIGIN` равным публичному HTTPS-адресу сайта без завершающего слеша. Укажите `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` и согласованную `DATABASE_URL` с хостом `db:5432`. Случайный hex-пароль удобно сгенерировать командой `openssl rand -hex 32`.
- В API и bot установите один и тот же `TELEGRAM_BOT_TOKEN` бота Клана. Для API укажите `TELEGRAM_BOT_USERNAME` без `@`, отрицательные числовые ID разрешённых групп в `TELEGRAM_GROUP_IDS`, при необходимости роли и числовые ID администраторов.
- Для внутренней связи сгенерируйте отдельный секрет, например `openssl rand -hex 32`. Запишите его как `BOT_INTERNAL_SECRET` у API и `BOT_BACKEND_SECRET` у бота. До запуска polling проверьте, что у этого токена отключён webhook и остановлены предыдущие worker.

Обновлённый secret применяется при следующей выкладке компонента. При ротации пароля существующей БД смените пароль роли в PostgreSQL и согласованно обновите GitHub secrets.

## 6. Первый и последующие выпуски

Подготовив сервер и секреты, опубликуйте изменения в `main`. Для повторного запуска выберите Actions → Production → Run workflow → `main`. При первой выкладке дождитесь успешного результата каждого этапа:

1. **Бэкенд.** После CI сервер обновляет локальную копию Git и выделяет каталог под проверенный коммит. API собирается на VPS из его Dockerfile, поэтому Docker может использовать сохранённые слои и зависимости. Сервер делает дамп PostgreSQL перед запуском API и проверяет `/api/health`.
2. **Фронтенд.** CI собирает приложение. Сервер получает архив, проверяет контрольную сумму и публикует статику. По публичному HTTPS-адресу проверяется версия. При общей первой выкладке nginx должен уже обслуживать домен.
3. **Бот.** До запуска проверяются конфигурация, доступ к offset и API. Затем запускается один worker.

```sh
curl --fail https://community.example.com/api/health
curl --fail https://community.example.com/deploy-version.txt
curl --fail https://community.example.com/users/1
curl --silent --output /dev/null --write-out '%{http_code}\n' https://community.example.com/internal
```

Ожидайте `data.status=ok` и `data.demo=false` у API, SHA коммита фронтенда в файле версии, страницу приложения по прямой ссылке и `404` для внутреннего маршрута. В дальнейшем обновляется компонент, в котором изменился `main`.

## 7. Диагностика и возврат версии

Сопоставьте SHA в журнале workflow с `/deploy-version.txt` фронтенда или с `readlink -f /opt/klan/backend/current` у API. Чтобы посмотреть логи API:

```sh
cd /opt/klan/backend/current
export IMAGE_REF="$(cat image-ref)"
docker compose -p klan-backend-production -f Docker/compose.production.yaml logs --tail=100 api
```

При ошибке получения исходников или сборки новый API не заменяет работающий. При неудачном запуске сценарий пытается восстановить предыдущий API с сохранёнными образом и окружением. Для ручного возврата запустите от `deploy`:

```sh
bash /opt/klan/backend/current/Deploy/server-release.sh rollback
```

Сохраните предыдущий релиз и его локальный образ. Откат API оставляет схему базы на текущей версии. Дампы перед обновлениями находятся в `/opt/klan/backend/backups`. Восстановление базы выполняется отдельно. Следите за местом на диске, включая кеш сборки, приватные каталоги релизов и дампы. Настройте регулярную резервную копию базы вне VPS. Обновление базовых образов Node и PostgreSQL можно планировать отдельно от выкладки прикладного кода.

Для фронтенда скрипт проверяет версию сайта и при неудаче восстанавливает предыдущую статику. Подробности ручного возврата и особенности первой выкладки приводятся в [инструкции фронтенда](https://github.com/fedornabilkin/klan-frontend/blob/main/Docs/deployment-github-vps.md). Для бота доступны журнал Actions и команда `bash /opt/klan/bot/current/Deploy/server-release.sh rollback`. Сохранённый offset используется и после возврата версии.
