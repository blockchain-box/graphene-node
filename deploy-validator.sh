#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")" && pwd)"
stage="${1:-}"
action="${2:-}"
case "$stage" in dev|staging|production) ;; *) echo 'Usage: ./deploy-validator.sh dev|staging|production init-env|init|install' >&2; exit 2 ;; esac
case "$action" in init-env|init|install) ;; *) echo 'Choose init-env, init (identity first), or install (after receiving the cloud-prepared bundle).' >&2; exit 2 ;; esac
if (( $# > 3 )) || { [[ "$action" != install ]] && (( $# > 2 )); }; then
  echo 'Usage: ./deploy-validator.sh STAGE install [ABSOLUTE_BUNDLE_DIRECTORY]' >&2
  exit 2
fi
if [[ "$action" == install && $# == 3 ]]; then
  if [[ -z "$3" ]]; then echo 'Provide the absolute folder containing the extracted Home bundle.' >&2; exit 2; fi
  export GRAPHENE_SETUP_BUNDLE="$3"
fi
file="$root/config/deployment/$stage.env"
if [[ "$action" == init-env ]]; then
  if [[ -e "$file" ]]; then echo "Env file exists; edit $file instead of replacing it." >&2; exit 2; fi
  (umask 077; set -o noclobber; cat "$file.example" > "$file")
  echo "Fill $file on this home host, then run ./deploy-validator.sh $stage init."
  exit 0
fi
if [[ ! -f "$file" ]]; then
  echo "Run ./deploy-validator.sh $stage init-env, then fill $file on this home host." >&2
  exit 2
fi
python3 - "$file" <<'PY'
import os,stat,sys
s=os.stat(sys.argv[1])
if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077 or s.st_uid not in (os.getuid(),int(os.environ.get('SUDO_UID',os.getuid()))):
    raise SystemExit('Keep the home env file owned by you and private: chmod 600 '+sys.argv[1])
PY
export GRAPHENE_EXPECTED_STAGE="$stage"
exec "${GRAPHENE_NODE_BINARY:-node}" --env-file="$file" "$root/scripts/deployment-validator.js" "$action"
