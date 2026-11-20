#!/usr/bin/env bash
# Sourced by server-release.sh. All failures propagate even inside rollback conditions.
# release_dir and deploy_root are provided by the release orchestrator.
# shellcheck disable=SC2154
service_preflight() {
  # Only database settings reach the PostgreSQL container. Never source runtime.env.
  awk '/^POSTGRES_(DB|USER|PASSWORD)=/' "$release_dir/runtime.env" > "$release_dir/database.env" || return
  chmod 600 "$release_dir/database.env" || return
  for setting in POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD; do
    [[ "$(grep -c "^${setting}=" "$release_dir/database.env")" == 1 ]] || { printf 'Missing/duplicate database setting: %s\n' "$setting" >&2; return 1; }
    grep -Eq "^${setting}=.+" "$release_dir/database.env" || return 1
  done
  compose config --quiet || return
  if [[ "${operation:-deploy}" == deploy ]]; then
    docker image inspect postgres:16-bookworm >/dev/null 2>&1 || docker pull postgres:16-bookworm || return
  else
    docker image inspect postgres:16-bookworm >/dev/null || return
  fi
  compose run --rm --no-deps api node --input-type=module -e '
    import { readConfig } from "./dist/config.js";
    try {
      const c = readConfig();
      const db = new URL(c.databaseUrl);
      if (db.hostname !== "db" || decodeURIComponent(db.username) !== process.env.POSTGRES_USER ||
          decodeURIComponent(db.password) !== process.env.POSTGRES_PASSWORD ||
          decodeURIComponent(db.pathname.slice(1)) !== process.env.POSTGRES_DB ||
          (db.port && db.port !== "5432")) throw new Error();
    } catch { console.error("Invalid production configuration or mismatched database credentials"); process.exit(1); }
  ' || return
}
service_prepare_data() (
  compose up -d --no-build --wait --wait-timeout 180 db || return
  # A snapshot precedes migrations on every deployment, including manual rollback.
  local directory="$deploy_root/backups" partial backup
  [[ ! -L "$directory" ]] || return 1
  mkdir -p "$directory" || return
  partial="$(mktemp "$directory/.$(basename -- "$release_dir")-XXXXXX.partial")" || return
  trap 'rm -f -- "$partial"' EXIT
  backup=${partial##*/.}
  backup=${backup%.partial}.dump
  # Variables must expand inside the database container, never on the host.
  # shellcheck disable=SC2016
  if ! compose exec -T db sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' > "$partial" ||
     [[ ! -s "$partial" ]] || ! compose exec -T db pg_restore --list < "$partial" > /dev/null; then
    printf 'Database backup failed; API was not updated.\n' >&2
    return 1
  fi
  mv -T -- "$partial" "$directory/$backup" || return
  bash "$(dirname -- "${BASH_SOURCE[0]}")/rotate-backups.sh" "$directory" "$backup"
)
service_start() {
  compose up -d --no-build --wait --wait-timeout 180 api || return
}
service_verify() {
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3101/api/health >/dev/null || return
}
service_stop() {
  compose stop --timeout 20 api || return
}
