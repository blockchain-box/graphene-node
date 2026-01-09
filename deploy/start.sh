#!/usr/bin/env bash
set -euo pipefail

NODE_ENV="${1:-local}"
NODE_TYPE="${2:-validator}"

usage() {
  echo "Usage:"
  echo " sh $0 [local|test|live] [validator|full|seed]"
  exit 1
}

validate_params() {
  # NODE_ENV: local, test, live
  case "$NODE_ENV" in
    local|test|live) ;;
    *)
      echo "Not valid env: $NODE_ENV"
      echo "You can use: local, test, live"
      usage
      ;;
  esac
  case "$NODE_TYPE" in
    validator|full|seed) ;;
    *)
      echo "Not valid node type: $NODE_TYPE"
      echo "You can use one of: validator, full, seed"
      usage
      ;;
  esac
}

validate_params

NETWORK_NAME="graphene-net-$NODE_ENV"
COMPOSE_FILE="services/$NODE_TYPE/docker.compose.$NODE_ENV.yml"
ENV_FILE="config/env/.env.$NODE_ENV"

# create network if needed
docker network inspect "$NETWORK_NAME" >/dev/null 2>&1 || docker network create "$NETWORK_NAME"

docker-compose -f "$COMPOSE_FILE" stop

# build & start compose
docker-compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build