#!/bin/sh
set -e

echo "=== Graphene Validator Agent ==="

if [ -n "${KEYSTORE_PASSPHRASE}" ]; then
  export KEYSTORE_PASSPHRASE
fi

if [ ! -f "${KEYSTORE_PATH:-/app/secrets/keystore.enc}" ] && [ "$1" != "init" ]; then
  echo "❌ No keystore found at ${KEYSTORE_PATH:-/app/secrets/keystore.enc}"
  echo "Run: validator-agent init"
  exit 1
fi

exec "$@"
