#!/usr/bin/env bash
set -euo pipefail

# create network if needed
docker network inspect graphene-net-local >/dev/null 2>&1 || docker network create graphene-net-local

docker-compose -f services/docker.compose.local.yml stop

# build & start compose
docker-compose --env-file config/env/.env.local -f services/docker.compose.local.yml up -d --build