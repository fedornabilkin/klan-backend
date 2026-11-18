# Production Klan на существующем VPS Ablakin

Это общая пошаговая инструкция для **klan-backend, klan-frontend и klan-bot**. Каждый репозиторий развёртывается независимо из `main`: ветки `master` в текущих репозиториях нет. Тестового стенда нет. Тесты выполняются в GitHub Actions и локально, без развёртывания отдельного окружения.

Workflow [Production](../.github/workflows/deploy.yml) запускается после изменения `main`, в том числе после merge pull request. Pull request запускает только проверки; публикация образа и выкладка ему недоступны. Прямой push в `main` тоже вызывает выкладку. Чтобы выпускать только через merge, включите защиту ветки с обязательным pull request и успешной проверкой «Проверки». Если позднее появится `master`, измените фильтры `push`/`pull_request`, условие image-job, проверку актуального коммита и разрешённую ветку environment во всех нужных репозиториях.

## 1. Что сохраняется от Ablakin

Используются существующие Linux VPS, SSH-пользователь `deploy`, Docker и системный nginx. Новая Caddy-служба на 80/443 не устанавливается: Caddy работает только внутри frontend-контейнера за nginx. Node.js, npm, Git и checkout приложения серверу для выкладки не нужны.

| Ресурс | Назначение |
| --- | --- |
| `/opt/klan/backend`, `/opt/klan/frontend`, `/opt/klan/bot` | Независимые релизы, ссылки `current` и `previous`, блокировка деплоя |
| `/opt/klan/backend/backups` | Дампы PostgreSQL перед обновлением API |
| `klan-backend-production`, `klan-frontend-production`, `klan-bot-production` | Отдельные Compose projects |
| Docker network `klan-production` | Связь приложений; API имеет DNS alias `api` |
| Docker volume `klan-production-postgres` | Отдельная PostgreSQL 16 для Klan |
| Docker volume `klan-production-bot-state` | Подтверждённый offset Telegram |
| `127.0.0.1:3101` | API для nginx на хосте |
| `127.0.0.1:8088` | HTTP frontend для nginx на хосте |

Ресурсы и подсети Ablakin не используются для данных Klan. Здесь выбрана собственная PostgreSQL в контейнере: установленная для другого проекта база не считается подходящей автоматически. Порты базы и бота наружу не публикуются. Не запускайте параллельно старые Compose/systemd экземпляры Klan с теми же данными или Telegram-токеном.

## 2. Проверить готовность сервера

Выполните через существующее доверенное SSH-подключение:

```sh
uname -m
docker version
docker compose version
sudo -u deploy docker info >/dev/null
command -v bash curl flock tar realpath
sudo nginx -t
sudo ss -lntp | grep -E ':(8088|3101)\b' || true
```

Нужен `x86_64` / `linux/amd64`, Docker Engine и **Compose 2.30.0+**. Старый `docker-compose` v1 из Ablakin эту схему не заменяет. Если Compose v2 отсутствует, установите/обновите plugin по [официальной инструкции Docker](https://docs.docker.com/compose/install/linux/) для уже установленного Docker; работающие контейнеры Ablakin пересоздавать не нужно. Нужны исходящие HTTPS-соединения к GHCR, Docker Hub и Telegram, SSH из GitHub-hosted runners, входящие 80/443 для сайта. Если SSH ограничен firewall, существующие правила Ablakin должны допускать Actions.

Если порты 8088 или 3101 заняты другим приложением, сначала выберите свободные. Менять их нужно согласованно в production Compose, `Deploy/service.sh` и nginx-шаблоне frontend. В текущей конфигурации они фиксированы. Для ARM-сервера сначала измените `platforms` в трёх workflows и проверьте образы.

Далее команды предполагают уже существующего пользователя `deploy` с рабочим SSH-ключом и доступом к Docker. При другом имени подставьте его в команды и `DEPLOY_USER`. Повторно создавать пользователя, устанавливать Docker или менять nginx Ablakin не требуется.

## 3. Создать каталоги, сеть и volumes

Передайте на сервер файл [Deploy/setup-server.sh](../Deploy/setup-server.sh) из этого репозитория, например в `/tmp/klan-setup-server.sh`. Администратор выполняет:

```sh
sudo bash /tmp/klan-setup-server.sh deploy
```

Сценарий проверяет существующие инструменты и доступ `deploy` к Docker, создаёт только перечисленные ресурсы Klan. Повторный запуск сохраняет содержимое volumes. Подкаталоги компонентов доступны только пользователю деплоя, поскольку релизы содержат env-файлы. Создание сети не требует фиксированной подсети.

Если Klan уже работал с данными, остановите его прежние экземпляры и спланируйте перенос базы/offset в новые volumes до первого выпуска. Пустая новая PostgreSQL автоматически получает схему, но не участников из локальной базы. Деплой не импортирует персональные данные. Перенос offset описан в [инструкции bot](https://github.com/fedornabilkin/klan-bot/blob/main/Docs/deployment-github-vps.md).

## 4. Подготовить домен и HTTPS

Выберите домен, например `community.example.com`, направьте DNS A/AAAA на этот VPS. Добавьте **отдельный** nginx virtual host; конфигурация домена Ablakin новый домен не обслужит.

В [инструкции frontend](https://github.com/fedornabilkin/klan-frontend/blob/main/Docs/deployment-github-vps.md#первичная-настройка-nginx-и-https) приведены готовые команды HTTP bootstrap → Certbot → HTTPS, а [Deploy/nginx.production.conf](https://github.com/fedornabilkin/klan-frontend/blob/main/Deploy/nginx.production.conf) содержит конечный шаблон. Замените домен и пути сертификата, проверьте `nginx -t`, затем reload. Не отключайте виртуальные хосты Ablakin. Если сертификат и подходящий vhost уже существуют, достаточно адаптировать их.

nginx направляет `/api` и `/ws` непосредственно на `127.0.0.1:3101`, UI — на `127.0.0.1:8088`, а `/internal` закрывает 404. Это сохраняет один доверенный proxy перед API. Backend `APP_ORIGIN` должен точно совпадать с публичным HTTPS origin без завершающего `/`.

## 5. Создать GitHub environment в каждом репозитории

Откройте каждый репозиторий → **Settings → Environments → New environment → `production`**:

- [klan-backend](https://github.com/fedornabilkin/klan-backend/settings/environments)
- [klan-frontend](https://github.com/fedornabilkin/klan-frontend/settings/environments)
- [klan-bot](https://github.com/fedornabilkin/klan-bot/settings/environments)

В Deployment branches разрешите только `main`. **Required reviewers и Wait timer оставьте выключенными**, чтобы после merge выкладка не ждала ручного подтверждения. Разрешите GitHub Actions и используемые actions в настройках репозитория/организации.

В каждом environment создайте одинаково названные **Environment secrets**:

| Secret | Что записать |
| --- | --- |
| `DEPLOY_HOST` | DNS-имя или IPv4 VPS, без схемы и порта |
| `DEPLOY_PORT` | Порт SSH, например `22` |
| `DEPLOY_USER` | `deploy` либо подготовленный пользователь |
| `DEPLOY_SSH_KEY` | Полный приватный SSH-ключ с переносами строк |
| `DEPLOY_KNOWN_HOSTS` | Проверенная запись SSH host key для точных host/port |
| `PRODUCTION_ENV` | Многострочные настройки конкретного компонента из шага 6 |

Первые пять значений можно использовать из существующей настройки Ablakin, если это тот же сервер, пользователь и ключ. Имена secrets здесь новые. Публичная часть ключа должна уже присутствовать у пользователя сервера в `~/.ssh/authorized_keys`; сам закрытый ключ не размещайте в репозитории.

Для нового `DEPLOY_KNOWN_HOSTS` получите запись `ssh-keyscan -p 22 -t ed25519 ИМЯ-СЕРВЕРА` на доверенной машине. Сравните её fingerprint через `ssh-keygen -lf` с `sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` в доверенной консоли VPS. Только после совпадения сохраните запись. При нестандартном порте ключ относится к `[host]:port`. Во время выкладки проверка host key обязательна, динамического доверия `ssh-keyscan` нет.

GHCR публикуется через встроенный `GITHUB_TOKEN` с `packages: write`, а deploy-job читает пакет с `packages: read`. Постоянный PAT и предварительный `docker login` на VPS **не нужны**: token передаётся по SSH stdin, временный `DOCKER_CONFIG` удаляется при завершении. В настройках пакета GHCR оставьте наследование прав от репозитория либо разрешите этому репозиторию Actions access. Для существующего одноимённого пакета без такого доступа исправьте разрешения пакета. Секретов `GHCR_TOKEN` или `IMAGE_REF` вручную создавать не нужно.

## 6. Заполнить `PRODUCTION_ENV`

Для каждого компонента используйте **его собственный** `Docker/.env.production.example`. Это другой формат, чем старые `Docker/.env` локального Compose: production передаёт значения через `env_file.format: raw`.

Одна строка — `KEY=value`; без `export`, внешних кавычек, подстановок `${...}` и комментария после значения. `$` и кавычки внутри значения остаются буквальными. JSON пишите одной строкой, например `TELEGRAM_GROUP_LEVELS={}`. Примеры не содержат настоящих секретов.

Backend — [пример](../Docker/.env.production.example):

```dotenv
APP_ORIGIN=https://community.example.com
POSTGRES_DB=klan
POSTGRES_USER=klan
POSTGRES_PASSWORD=ЗАМЕНИТЬ_СЛУЧАЙНОЙ_HEX_СТРОКОЙ
DATABASE_URL=postgresql://klan:ТОТ_ЖЕ_ПАРОЛЬ@db:5432/klan
TELEGRAM_BOT_TOKEN=ТОКЕН_БОТА_KLAN
TELEGRAM_BOT_USERNAME=ИМЯ_БОТА_БЕЗ_СОБАКИ
TELEGRAM_GROUP_IDS=ЧИСЛОВЫЕ_ID_ГРУПП_ЧЕРЕЗ_ЗАПЯТУЮ
TELEGRAM_GROUP_LEVELS={}
TELEGRAM_MEMBERSHIP_TTL_SECONDS=60
TELEGRAM_ADMIN_IDS=ЧИСЛОВЫЕ_ID_АДМИНИСТРАТОРОВ
BOT_INTERNAL_SECRET=СЛУЧАЙНЫЙ_ОБЩИЙ_СЕКРЕТ
```

Плейсхолдеры выше нужно заменить. Сгенерируйте пароль БД и общий секрет **отдельными** вызовами `openssl rand -hex 32`. Секрет должен содержать 32–256 ASCII-символов без пробелов; hex не требует URL-encoding. `DATABASE_URL` использует host **db**, базу/пользователя/пароль, точно соответствующие `POSTGRES_*`. Проверка перед запуском отклонит несовпадение. Production API не использует `CONTAINER_DATABASE_URL`.

`TELEGRAM_GROUP_IDS` содержит отрицательные числовые ID разрешённых групп. `TELEGRAM_ADMIN_IDS` — положительные числовые ID администраторов, можно оставить пустым. Настройте членство и права бота в нужных группах. Токен должен принадлежать отдельному боту Klan; запуск двух polling worker с токеном Ablakin нарушит работу обоих.

Для frontend `PRODUCTION_ENV` достаточно комментария `# Frontend production`: runtime-секреты ему не нужны. Не копируйте сюда настройки API.

Для bot:

```dotenv
TELEGRAM_BOT_TOKEN=ТОТ_ЖЕ_ТОКЕН_ЧТО_У_API
BOT_BACKEND_SECRET=ТОТ_ЖЕ_СЕКРЕТ_ЧТО_BOT_INTERNAL_SECRET
```

NODE_ENV, порты, адрес `http://api:3001` для бота и путь offset фиксированы в production Compose. До первого запуска остановите прежний polling worker с этим токеном и проверьте, что у токена не включён webhook. Сценарий не меняет webhook автоматически. Подробности переноса состояния и ограничений проверки — в инструкции bot.

При обновлении secrets они попадут в **следующий** релиз: запустите workflow снова или выполните merge. Старый релиз сохраняет прежний env для отката; при ротации токенов/паролей учитывайте это. Изменение `POSTGRES_PASSWORD` в GitHub не меняет пароль уже инициализированной базы — сначала выполните согласованную ротацию PostgreSQL и обновите `DATABASE_URL`.

## 7. Первый выпуск

Сначала подготовьте сервер, environment и secrets. Затем опубликуйте изменения deployment в `main` каждого репозитория. Если workflow уже появился в GitHub до настройки, его неудачный запуск не означает готовый production: после настройки повторите **Actions → Production → Run workflow → Branch: main**.

Первый раз запускайте и дожидайтесь зелёного результата в порядке:

1. **Backend**: создаётся схема PostgreSQL, выполняются readiness и `/api/health`.
2. **Frontend**: проверяются Caddy, HTML приложения, прямой SPA URL и блокировка `/internal`.
3. **Bot**: до polling проверяются конфигурация, состояние и API; затем запускается ровно один worker.

Последующие merge автоматически обновляют только соответствующий компонент. Workflows сериализованы внутри репозитория; серверный `flock` защищает от одновременных ручных и автоматических обновлений одного компонента. Старый запуск, чей commit уже не вершина `main`, не выкатывается. Это не общий атомарный релиз трёх компонентов: изменения API выпускайте с обратной совместимостью, начиная с backend. Короткий перерыв при пересоздании контейнера возможен.

После первого выпуска проверьте снаружи:

```sh
curl --fail --show-error https://community.example.com/api/health
curl --fail --show-error https://community.example.com/
curl --silent --output /dev/null --write-out '%{http_code}\n' https://community.example.com/internal
```

Health должен вернуть `data.status=ok`, `data.demo=false`; последний запрос — `404`. Проверьте вход и WebSocket в обычном пользовательском сценарии. Проверка процесса бота 30 секунд не подтверждает доставку Telegram: ошибки токена/сети или общего секрета могут приводить к повторным попыткам без падения процесса.

## 8. Диагностика и откат

Текущий release и логи API от пользователя `deploy`:

```sh
readlink -f /opt/klan/backend/current
cd /opt/klan/backend/current
export IMAGE_REF="$(cat image-ref)"
docker compose --project-name klan-backend-production --project-directory "$PWD/Docker" \
  --env-file /dev/null -f Docker/compose.production.yaml ps
docker compose --project-name klan-backend-production --project-directory "$PWD/Docker" \
  --env-file /dev/null -f Docker/compose.production.yaml logs --tail 100 api
```

Для frontend/bot замените путь, project name и service (`frontend`/`bot`). Не выводите `runtime.env`, `database.env` или `compose config` без `--quiet`: там находятся секреты.

Если подготовка нового релиза провалилась, текущий контейнер не заменяется. После начала обновления ошибка запуска/readiness вызывает остановку неудачного сервиса и попытку вернуть прежний образ с его env. Workflow остаётся красным даже после успешного восстановления. При самом первом неуспешном выпуске предыдущего релиза нет: сервис останавливается, постоянные данные сохраняются. Если сам откат не удался, журнал явно сообщает `ROLLBACK FAILED`; проверьте сервис вручную.

Ручной возврат последнего успешного релиза, без пересборки и постоянного registry token:

```sh
bash /opt/klan/backend/current/Deploy/server-release.sh rollback
bash /opt/klan/frontend/current/Deploy/server-release.sh rollback
bash /opt/klan/bot/current/Deploy/server-release.sh rollback
```

Выполняйте только команды нужных компонентов. Требуются предыдущий релиз и сохранённый локально Docker image. Откат проходит ту же блокировку и проверки. Ссылки `current`/`previous` меняются местами после успеха. Следующий merge снова запускает обычный выпуск, поэтому устраните причину ошибки или сделайте revert в Git.

Перед запуском новой API-версии делается `pg_dump --format=custom` в `/opt/klan/backend/backups`; ошибка копирования останавливает обновление. **Откат приложения не отменяет миграции БД.** Миграции должны сохранять совместимость; восстановление дампа — отдельная операция с остановкой записи и согласованной потерей данных после снимка. Автоматически база не восстанавливается и не удаляется. Это не замена регулярным зашифрованным резервным копиям вне VPS: настройте их отдельно до наполнения production.

Скрипты не чистят releases, backups, images или volumes автоматически. Контролируйте диск; сохраняйте как минимум current, previous, соответствующие образы и нужные дампы. Не применяйте `docker compose down --volumes` и общий `docker system prune --volumes`: это затрагивает постоянные данные и другие проекты. При очистке старых релизов помните о содержащихся в них прежних секретах.

## Справочники

- [GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)
- [Docker Actions и GHCR](https://docs.docker.com/build/ci/github-actions/push-multi-registries/)
- [Compose raw env files](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/)
- [Compose up: ожидание готовности](https://docs.docker.com/reference/cli/docker/compose/up/)
