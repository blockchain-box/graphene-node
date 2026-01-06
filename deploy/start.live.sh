#!/usr/bin/env bash
set -euo pipefail

# create network if needed
docker network inspect graphene-net >/dev/null 2>&1 || docker network create graphene-net

# build & start compose
docker compose up --build -d -f ../compose/docker-compose.live.yml