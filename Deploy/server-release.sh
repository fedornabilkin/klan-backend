#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
script_path="$(realpath -- "$0")"
request_dir="$(dirname -- "$(dirname -- "$script_path")")"
deploy_root="$(dirname -- "$(dirname -- "$request_dir")")"
[[ "$deploy_root" == '/opt/klan/backend' ]] || fail 'Expected /opt/klan/backend'
release_pattern='^[a-f0-9]{40}-[0-9]+-[0-9]+$'
valid_release() {
  [[ "$(dirname -- "$1")" == "$deploy_root/releases" && "$(basename -- "$1")" =~ $release_pattern ]] &&
    [[ "$(realpath -- "$1")" == "$1" ]]
}
operation=''
if (( $# > 0 )); then operation=$1; fi
[[ "$operation" == deploy || "$operation" == rollback ]] || fail 'Usage: server-release.sh deploy | rollback'
for command in docker flock curl git tar cmp; do command -v "$command" >/dev/null || fail "Missing command: $command"; done
version="$(docker compose version --short | sed 's/^v//')"
[[ "$(printf '%s\n' 2.30.0 "$version" | sort -V | head -n 1)" == 2.30.0 ]] || fail 'Docker Compose >=2.30.0 is required'
exec 9>"$deploy_root/.deploy.lock"
flock -w 600 9 || fail 'Another deployment is running'

previous_release=''
if [[ -L "$deploy_root/current" ]]; then
  previous_release="$(realpath -- "$deploy_root/current")"
  valid_release "$previous_release" || fail 'Invalid current release'
elif [[ -e "$deploy_root/current" ]]; then
  fail 'current must be a managed symlink'
fi
release_dir=''
scratch=''
changed=0
finished=0
api_compose_args=()
configure_api_binding() {
  local shared="$deploy_root/shared" address=127.0.0.1 octet a b c d
  [[ ! -L "$shared" ]] || fail 'shared must be a real directory'
  mkdir -p "$shared"
  if [[ -e "$shared/api-bind-address" || -L "$shared/api-bind-address" ]]; then
    [[ -f "$shared/api-bind-address" && ! -L "$shared/api-bind-address" ]] || fail 'Invalid API bind address file'
    address="$(cat -- "$shared/api-bind-address")"
  fi
  [[ "$address" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || fail 'API bind address must be 127.0.0.1 or a private IPv4 address'
  IFS=. read -r a b c d <<< "$address"
  for octet in "$a" "$b" "$c" "$d"; do
    [[ "$octet" == 0 || "$octet" != 0* ]] || fail 'API bind address must use canonical IPv4 notation'
    (( 10#$octet <= 255 )) || fail 'Invalid API bind address'
  done
  [[ "$address" == 127.0.0.1 || "$a" == 10 || ( "$a" == 172 && "$b" -ge 16 && "$b" -le 31 ) || ( "$a" == 192 && "$b" == 168 ) ]] ||
    fail 'API bind address must be 127.0.0.1 or an RFC1918 private IPv4 address'
  [[ ! -L "$shared/api-private.compose.yaml" ]] || fail 'API bind override must not be a symlink'
  api_compose_args=()
  if [[ "$address" == 127.0.0.1 ]]; then
    rm -f -- "$shared/api-private.compose.yaml"
  else
    # Keep the loopback binding from the release and add a separate private interface.
    printf 'services:\n  api:\n    ports:\n      - target: 3001\n        published: "3101"\n        host_ip: "%s"\n        protocol: tcp\n' "$address" > "$shared/api-private.compose.yaml"
    chmod 600 "$shared/api-private.compose.yaml"
    api_compose_args=(-f "$shared/api-private.compose.yaml")
  fi
}
compose() {
  docker compose --project-name klan-backend-production --project-directory "$release_dir/Docker" \
    --env-file /dev/null -f "$release_dir/Docker/compose.production.yaml" "${api_compose_args[@]}" "$@"
}
select_release() {
  release_dir="$1"
  valid_release "$release_dir" || return 1
  [[ -f "$release_dir/runtime.env" && ! -L "$release_dir/runtime.env" ]] || return 1
  IMAGE_REF="$(cat -- "$release_dir/image-ref")" || return
  local sha
  sha="$(basename -- "$release_dir" | cut -d- -f1)"
  # A previous locally cached GHCR deployment remains usable for rollback.
  [[ "$IMAGE_REF" == "klan-backend:$sha" || "$IMAGE_REF" =~ ^ghcr\.io/[a-z0-9_-]+/klan-backend@sha256:[a-f0-9]{64}$ ]] || return 1
  export IMAGE_REF
  cd -- "$release_dir" || return
  unset -f service_prepare_data
  # shellcheck disable=SC1091
  source "$release_dir/Deploy/service.sh" || return
}
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if (( result != 0 && changed == 1 && finished == 0 )); then
    printf 'Release failed; stopping the failed service.\n' >&2
    if service_stop; then
      if [[ -n "$previous_release" ]]; then
        printf 'Restoring the previous release.\n' >&2
        if select_release "$previous_release" && docker image inspect "$IMAGE_REF" >/dev/null 2>&1 && service_start && service_verify; then
          printf 'Previous release restored.\n' >&2
        else
          printf 'ROLLBACK FAILED: inspect the service before retrying.\n' >&2
        fi
      else
        printf 'First deployment failed; service stopped, persistent data retained.\n' >&2
      fi
    else
      printf 'Could not stop the failed service; automatic rollback was not started.\n' >&2
    fi
  fi
  [[ -z "$scratch" ]] || rm -rf -- "$scratch"
  if [[ "$operation" == deploy && "$(dirname -- "$request_dir")" == "$deploy_root/incoming" ]]; then
    rm -f -- "$request_dir/runtime.env"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
configure_api_binding

if [[ "$operation" == deploy ]]; then
  release_id="$(basename -- "$request_dir")"
  [[ "$release_id" =~ $release_pattern && "$(dirname -- "$request_dir")" == "$deploy_root/incoming" ]] || fail 'Invalid incoming directory'
  [[ "$(realpath -- "$request_dir")" == "$request_dir" ]] || fail 'Invalid incoming path'
  sha="$(cat -- "$request_dir/commit")"
  [[ "$sha" =~ ^[a-f0-9]{40}$ && "$release_id" == "$sha-"* ]] || fail 'Invalid commit'
  [[ ! -L "$request_dir/runtime.env" ]] || fail 'Incoming runtime environment must not be a symlink'
  runtime_source="$request_dir/runtime.env"
  if [[ ! -s "$runtime_source" ]]; then runtime_source="$deploy_root/shared/runtime.env"; fi
  [[ -f "$runtime_source" && -s "$runtime_source" && ! -L "$runtime_source" ]] ||
    fail 'Missing runtime configuration: set PRODUCTION_ENV or shared/runtime.env'
  IFS= read -r git_token || fail 'Missing repository token on stdin'
  [[ -n "$git_token" ]] || fail 'Empty repository token'
  scratch="$(mktemp -d "$deploy_root/.source-XXXXXX")"
  cp -- "$runtime_source" "$scratch/runtime.env"
  chmod 600 "$scratch/runtime.env"
  cat > "$scratch/askpass" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) printf '%s\n' "$KLAN_GIT_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
  chmod 700 "$scratch/askpass"
  repository="$deploy_root/repository.git"
  [[ ! -L "$repository" ]] || fail 'Repository cache must not be a symlink'
  if [[ ! -d "$repository" ]]; then git init --bare "$repository" >/dev/null; fi
  [[ "$(git --git-dir="$repository" rev-parse --is-bare-repository)" == true ]] || fail 'Invalid repository cache'
  fetch_main() {
    # The token exists only for this Git process, never in .git/config or a Docker build.
    LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$scratch/askpass" KLAN_GIT_TOKEN="$git_token" \
      git -c credential.helper= --git-dir="$repository" fetch --no-tags \
      https://github.com/fedornabilkin/klan-backend.git '+refs/heads/main:refs/remotes/origin/main' || return
    [[ "$(git --git-dir="$repository" rev-parse 'refs/remotes/origin/main^{commit}')" == "$sha" ]] ||
      { printf 'main has changed; deploy the latest checked commit.\n' >&2; return 1; }
  }
  fetch_main
  release_dir="$deploy_root/releases/$release_id"
  [[ ! -e "$release_dir" && ! -L "$release_dir" ]] || fail 'Release already exists; use a new Actions run attempt'
  mkdir "$scratch/source"
  git --git-dir="$repository" archive --format=tar "$sha" | tar -xf - -C "$scratch/source"
  cmp -- "$script_path" "$scratch/source/Deploy/server-release.sh" >/dev/null || fail 'Deployment script does not match the checked commit'
  [[ -f "$scratch/source/Docker/Dockerfile" && -f "$scratch/source/Deploy/service.sh" ]] || fail 'Incomplete source release'
  mv -T "$scratch/source" "$release_dir"
  cp -- "$scratch/runtime.env" "$release_dir/runtime.env"
  chmod 600 "$release_dir/runtime.env"
  printf '%s\n' "$sha" > "$release_dir/commit"
  printf 'klan-backend:%s\n' "$sha" > "$release_dir/image-ref"
  select_release "$release_dir" || fail 'Invalid release metadata'
  if docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
    [[ "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE_REF")" == "$sha" ]] ||
      fail 'Existing local image does not match this commit'
  else
    build_command=(docker build)
    network_file="$deploy_root/shared/build-network"
    if [[ -e "$network_file" || -L "$network_file" ]]; then
      [[ -f "$network_file" && ! -L "$network_file" ]] || fail 'Build network setting must be a regular file'
      [[ "$(cat -- "$network_file")" == klan-build ]] || fail 'Build network must be klan-build'
      docker network inspect klan-build >/dev/null || fail 'Missing isolated klan-build network'
      # The Docker driver cannot select a custom build network with BuildKit.
      build_command=(env DOCKER_BUILDKIT=0 docker build --network klan-build)
    fi
    "${build_command[@]}" --file "$release_dir/Docker/Dockerfile" --tag "$IMAGE_REF" \
      --label "org.opencontainers.image.revision=$sha" "$release_dir"
  fi
  service_preflight
  compose config --quiet
  # Builds can take minutes; do not activate a commit superseded during the build.
  fetch_main
  unset git_token
else
  valid_release "$request_dir" || fail 'Rollback must run from a managed release'
  [[ -L "$deploy_root/previous" ]] || fail 'No previous release is available'
  release_dir="$(realpath -- "$deploy_root/previous")"
  select_release "$release_dir" || fail 'Invalid previous release'
  docker image inspect "$IMAGE_REF" >/dev/null || fail 'Previous image is not available locally'
  service_preflight
  compose config --quiet
fi
if declare -F service_prepare_data >/dev/null; then service_prepare_data; fi
changed=1
service_start
service_verify

# Keep service state and current pointer consistent when termination arrives during commit.
trap '' INT TERM
if [[ -n "$previous_release" && "$previous_release" != "$release_dir" ]]; then
  ln -s "releases/$(basename -- "$previous_release")" "$deploy_root/.previous-$$"
  mv -Tf "$deploy_root/.previous-$$" "$deploy_root/previous"
fi
ln -s "releases/$(basename -- "$release_dir")" "$deploy_root/.current-$$"
mv -Tf "$deploy_root/.current-$$" "$deploy_root/current"
finished=1
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Production backend is running release %s\n' "$(basename -- "$release_dir")"
