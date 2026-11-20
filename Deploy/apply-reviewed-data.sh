#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/opt/klan/backend
job=$(realpath -- "$(dirname -- "$0")")
[[ "$job" =~ ^/opt/klan/backend/\.reviewed\.[[:alnum:]]{8}$ ]] || exit 2
digest=${1:?Missing SHA-256}
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || exit 2
cd "$job"
printf '%s  reviewed.copy\n' "$digest" | sha256sum --check --status
exec 9>"$root/.deploy.lock"
flock -w 90 9 || { echo 'Backend deployment in progress. Retry later.' >&2; exit 1; }
db=klan-backend-production-db-1
api=klan-backend-production-api-1
for service in "$api" "$db"; do
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}} {{.State.Health.Status}}' "$service")" == 'klan-backend-production healthy' ]]
done
docker exec "$db" sh -ec 'test "$POSTGRES_DB" = klan'
[[ ! -L "$root/backups" ]]
mkdir -p "$root/backups"
receipt="$root/backups/reviewed-$digest.applied"
if [[ -f "$receipt" ]]; then
  echo 'This snapshot was already applied.'
  previous=$(cat -- "$receipt")
  if [[ -f "$previous" ]]; then printf 'Previous production backup: %s\n' "$previous"; fi
  exit 0
fi

stage=$(docker exec "$db" mktemp -d /tmp/klan-reviewed.XXXXXXXX)
restart_api=0
partial=''
# The EXIT trap invokes cleanup even when the import fails.
# shellcheck disable=SC2329
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if (( restart_api )); then
    docker start "$api" >/dev/null || { echo 'API restart failed' >&2; status=1; }
  fi
  if [[ -n "$partial" ]]; then rm -f -- "$partial"; fi
  docker exec "$db" rm -f -- "$stage/reviewed.copy" "$stage/reviewed-data.sql" || true
  docker exec "$db" rmdir -- "$stage" || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
docker cp reviewed.copy "$db:$stage/reviewed.copy"
docker cp reviewed-data.sql "$db:$stage/reviewed-data.sql"
docker exec -w "$stage" "$db" sh -ec 'printf "%s  reviewed.copy\n" "$1" | sha256sum -c -' sh "$digest" >/dev/null

restart_api=1
docker stop --time 35 "$api" >/dev/null
partial=$(mktemp "$root/backups/.before-reviewed-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
backup="$root/backups/${partial##*/.}.dump"
docker exec "$db" sh -ec 'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$partial"
docker exec -i "$db" pg_restore --file=/dev/null < "$partial"
mv -- "$partial" "$backup"
partial=''
printf 'Previous production backup: %s\n' "$backup"
bash "$job/rotate-backups.sh" "$root/backups" "${backup##*/}"
docker exec -w "$stage" "$db" sh -ec 'exec psql -Xq -v export_mode=off -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f reviewed-data.sql'
printf '%s\n' "$backup" > "$receipt"
docker start "$api" >/dev/null
restart_api=0
for ((i=0; i<40; i++)); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3101/api/health >/dev/null; then
    echo 'Import verified. Production API is available.'
    exit 0
  fi
  sleep 2
done
echo "Import committed. API did not become healthy. Backup: $backup" >&2
exit 1
