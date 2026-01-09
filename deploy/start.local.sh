#!/usr/bin/env bash

# Re-exec with bash if this was invoked with sh/dash which doesn't support 'set -o pipefail'
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  echo "This script requires bash. Run with: bash $0" >&2
  exit 1
fi

set -euo pipefail

git lfs install && git lfs pull

NETWORK_NAME="graphene-net-local"
COMPOSE_FILE_VALIDATOR="services/local/docker.compose.validator.yml"
COMPOSE_FILE_SENTRY="services/local/docker.compose.sentry.yml"
ENV_FILE="config/env/.env.local"

# create network if needed
docker network inspect "$NETWORK_NAME" >/dev/null 2>&1 || docker network create "$NETWORK_NAME"

docker-compose -f "$COMPOSE_FILE_VALIDATOR" stop
docker-compose -f "$COMPOSE_FILE_SENTRY" stop

# build & start compose
docker-compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE_VALIDATOR" up -d --build
docker-compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE_SENTRY" up -d --build