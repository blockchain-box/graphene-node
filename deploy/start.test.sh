#!/usr/bin/env bash
set -euo pipefail

# create network if needed
docker network inspect graphene-net-test >/dev/null 2>&1 || docker network create graphene-net-local

# build & start compose
docker compose up --build -d