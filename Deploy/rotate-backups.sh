#!/usr/bin/env bash
# Both producers hold the backend deploy lock. Only their completed archives count.
set -euo pipefail
directory=${1:?Missing backups directory}
latest=${2:-}
[[ -d "$directory" && ! -L "$directory" ]]
cd -- "$directory"
kept=0
if [[ -n "$latest" ]]; then
  [[ "$latest" != */* && -s "$latest" && ! -L "$latest" ]]
  kept=1
fi
pattern='./([a-f0-9]{40}-[0-9]+-[0-9]+-[[:alnum:]]{6}|before-reviewed-[0-9]{8}T[0-9]{6}Z-[[:alnum:]]{8})\.dump'
# The name filter also makes newline-delimited sorting safe. Fail before unlinking on a listing error.
archives=$(find . -maxdepth 1 -regextype posix-extended -type f -regex "$pattern" ! -name "$latest" -printf '%T@ %f\n' | LC_ALL=C sort -rn)
while read -r stamp archive; do
  [[ -n "$stamp" ]] || continue
  if (( kept < 7 )); then kept=$((kept + 1)); else rm -- "$archive"; fi
done <<< "$archives"
# A hard shutdown may strand a staging file. Both writers use the same lock.
find . -maxdepth 1 -regextype posix-extended -type f \
  -regex './\.(before-reviewed-[0-9]{8}T[0-9]{6}Z-[[:alnum:]]{8}|[a-f0-9]{40}-[0-9]+-[0-9]+-[[:alnum:]]{6}\.partial)' -delete
