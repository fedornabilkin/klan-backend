#!/usr/bin/env bash
# Run once as root on the existing Linux VPS; safe to repeat for these Klan resources.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
deploy_user="${1:-deploy}"
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]*$ && "$deploy_user" != root ]] || exit 1
id "$deploy_user" >/dev/null
deploy_group="$(id -gn "$deploy_user")"
for command in docker git bash curl flock realpath runuser rsync tar gzip sha256sum; do
  command -v "$command" >/dev/null || { echo "Missing tool: $command" >&2; exit 1; }
done
version="$(docker compose version --short)"
version="${version#v}"
[[ "$(printf '%s\n' 2.30.0 "$version" | sort -V | head -n 1)" == 2.30.0 ]] || { echo 'Docker Compose >=2.30.0 is required.' >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo 'The production bot image targets linux/amd64.' >&2; exit 1; }
runuser -u "$deploy_user" -- docker info >/dev/null

for path in /opt/klan /opt/klan/frontend /opt/klan/backend /opt/klan/bot /var/www/klan; do
  [[ ! -L "$path" ]] || { echo "Refusing symlink: $path" >&2; exit 1; }
  [[ "$(realpath -m -- "$path")" == "$path" ]] || { echo "Unexpected resolved path: $path" >&2; exit 1; }
done
install -d -o root -g root -m 0755 /opt/klan
for path in /opt/klan/{frontend,backend,bot}{,/releases} /opt/klan/{frontend,backend}/incoming /opt/klan/backend/backups; do
  [[ ! -L "$path" ]] || { echo "Refusing symlink: $path" >&2; exit 1; }
  install -d -o "$deploy_user" -g "$deploy_group" -m 0700 "$path"
done
# Only the published static files are visible to nginx.
install -d -o "$deploy_user" -g "$deploy_group" -m 0755 /var/www/klan
docker network inspect klan-production >/dev/null 2>&1 || docker network create klan-production >/dev/null
for volume in klan-production-postgres klan-production-bot-state; do
  docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create "$volume" >/dev/null
done
printf 'Klan directories, network and persistent volumes are ready for %s.\n' "$deploy_user"
