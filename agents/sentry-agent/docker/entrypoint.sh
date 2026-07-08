#!/bin/sh
set -e

echo "=== Graphene Sentry Agent ==="

if [ ! -f "${SECRETS_PATH:-/app/secrets/sentry-secrets.json}" ]; then
  echo "No secrets found at ${SECRETS_PATH:-/app/secrets/sentry-secrets.json}"
  echo "Run: sentry-agent init"
fi

exec "$@"
