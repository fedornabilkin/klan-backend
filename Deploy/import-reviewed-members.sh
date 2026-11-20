#!/usr/bin/env bash
# The caller streams the import program to the deployed API container on stdin.
set -euo pipefail
umask 077
root=/opt/klan/backend
db=klan-backend-production-db-1
api=klan-backend-production-api-1
case ${1:-} in apply|preview) ;; *) exit 2 ;; esac
exec 9>>"$root/.deploy.lock"
flock -w 90 9
for service in "$api" "$db"; do
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}} {{.State.Health.Status}}' "$service")" == 'klan-backend-production healthy' ]]
done
if [[ "$1" == apply ]]; then
  directory="$root/backups"
  [[ ! -L "$directory" ]]
  mkdir -p "$directory"
  partial=$(mktemp "$directory/.before-reviewed-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
  trap 'rm -f -- "$partial"' EXIT
  backup="${partial##*/.}.dump"
  docker exec "$db" sh -ec 'test "$POSTGRES_DB" = klan && exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$partial"
  docker exec -i "$db" pg_restore --file=/dev/null < "$partial"
  mv -- "$partial" "$directory/$backup"
  printf 'Backup: %s\n' "$directory/$backup"
  bash "$root/current/Deploy/rotate-backups.sh" "$directory" "$backup"
fi
docker exec -i -w /app "$api" node --input-type=module -
