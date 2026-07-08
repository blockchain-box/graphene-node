#!/bin/sh
# Create the data directory with relaxed permissions to handle
# WSL bind mounts from Windows filesystem (no chown/chmod support)
mkdir -p "$PGDATA" 2>/dev/null
chown postgres:postgres "$PGDATA" 2>/dev/null || true
chmod 700 "$PGDATA" 2>/dev/null || true
exec docker-entrypoint.sh "$@"
