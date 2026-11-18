#!/usr/bin/env bash
# Run once as root on the existing Linux VPS; safe to repeat for these Klan resources.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
deploy_user="${1:-deploy}"
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]*$ && "$deploy_user" != root ]] || exit 1
id "$deploy_user" >/dev/null
deploy_group="$(id -gn "$deploy_user")"
for command in docker curl flock realpath runuser; do command -v "$command" >/dev/null; done
version="$(docker compose version --short)"
version="${version#v}"
[[ "$(printf '%s\n' 2.30.0 "$version" | sort -V | head -n 1)" == 2.30.0 ]] || { echo 'Docker Compose >=2.30.0 is required.' >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo 'Workflow images currently target linux/amd64.' >&2; exit 1; }
runuser -u "$deploy_user" -- docker info >/dev/null

for path in /opt/klan /opt/klan/frontend /opt/klan/backend /opt/klan/bot; do
  [[ ! -L "$path" ]] || { echo "Refusing symlink: $path" >&2; exit 1; }
  [[ ! -e "$path" || "$(realpath -- "$path")" == "$path" ]] || exit 1
done
install -d -o root -g root -m 0755 /opt/klan
for component in frontend backend bot; do
  for path in "/opt/klan/$component" "/opt/klan/$component/releases" "/opt/klan/$component/backups"; do
    [[ ! -L "$path" ]] || { echo "Refusing symlink: $path" >&2; exit 1; }
    install -d -o "$deploy_user" -g "$deploy_group" -m 0700 "$path"
  done
done
docker network inspect klan-production >/dev/null 2>&1 || docker network create klan-production >/dev/null
for volume in klan-production-postgres klan-production-bot-state; do
  docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create "$volume" >/dev/null
done
printf 'Klan directories, network and persistent volumes are ready for %s.\n' "$deploy_user"
