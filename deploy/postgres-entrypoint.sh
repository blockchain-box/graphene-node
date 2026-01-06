#!/usr/bin/env sh
set -eu

# Wrapper entrypoint for postgres container
# - starts the official docker-entrypoint.sh postgres in background
# - waits for PostgreSQL to become ready
# - ensures the database ${POSTGRES_DB} exists and is owned by ${POSTGRES_USER}
# - also ensures a database named ${POSTGRES_USER} exists (some clients connect to DB == user)
# - ensures the role ${POSTGRES_USER} exists (create with POSTGRES_PASSWORD if provided)
# - waits for the postgres process to end

# Default environment variables are provided by docker-compose env_file
POSTGRES_USER=${POSTGRES_USER:-graphene}
POSTGRES_DB=${POSTGRES_DB:-graphenedb}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-}

# Path to original entrypoint in official image
ORIGINAL_ENTRYPOINT=/usr/local/bin/docker-entrypoint.sh

if [ ! -x "$ORIGINAL_ENTRYPOINT" ]; then
  echo "Original docker entrypoint not found at $ORIGINAL_ENTRYPOINT" >&2
  exec "$ORIGINAL_ENTRYPOINT" "$@"
fi

# Start the original entrypoint with 'postgres' in background
echo "Starting postgres (background) via original entrypoint..."
"$ORIGINAL_ENTRYPOINT" postgres &
PG_PID=$!

# Wait for postgres to accept connections
echo "Waiting for postgres to accept connections..."
RETRIES=60
COUNT=0
# use pg_isready without specifying a user to avoid relying on role names
until pg_isready -q >/dev/null 2>&1; do
  COUNT=$((COUNT+1))
  if [ "$COUNT" -ge "$RETRIES" ]; then
    echo "Postgres did not become ready within timeout" >&2
    kill "$PG_PID" || true
    exit 1
  fi
  sleep 1
done

# Helper: ensure role exists (create if missing)
ensure_role_exists() {
  ROLENAME="$1"
  ROLEPASS="$2"
  if [ -z "$ROLENAME" ]; then
    return
  fi

  # Try to check roles using maintenance DB 'postgres'. Use whichever superuser is available.
  # Prefer to run checks as current POSTGRES_USER if possible, fallback to connecting as the same user (may fail) and then try without user and ignore errors.
  ROLE_EXISTS=$(psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${ROLENAME}';" 2>/dev/null | tr -d '[:space:]' || true)

  if [ "$ROLE_EXISTS" = "1" ]; then
    echo "Role '${ROLENAME}' already exists."
    return
  fi

  echo "Creating role '${ROLENAME}'..."
  if [ -n "$ROLEPASS" ]; then
    # Use a DO block to create the role if it does not exist; connect to maintenance DB 'postgres'.
    psql -U "$POSTGRES_USER" -d postgres -c "DO \\\$$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${ROLENAME}') THEN CREATE ROLE \"${ROLENAME}\" WITH LOGIN PASSWORD '${ROLEPASS}'; END IF; END \\\$$;" || {
      echo "Warning: failed to create role '${ROLENAME}' as user ${POSTGRES_USER}." >&2
    }
  else
    psql -U "$POSTGRES_USER" -d postgres -c "DO \\\$$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${ROLENAME}') THEN CREATE ROLE \"${ROLENAME}\" WITH LOGIN; END IF; END \\\$$;" || {
      echo "Warning: failed to create role '${ROLENAME}' as user ${POSTGRES_USER}." >&2
    }
  fi
}

# Helper: create DB if missing
create_db_if_missing() {
  DBNAME="$1"
  OWNER="$2"
  if [ -z "$DBNAME" ]; then
    return
  fi
  # connect to maintenance db 'postgres' explicitly to avoid attempting to connect to a non-existent DB
  DB_EXISTS=$(psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DBNAME}';" | tr -d '[:space:]' || true)
  if [ "$DB_EXISTS" = "1" ]; then
    echo "Database '${DBNAME}' already exists."
  else
    echo "Creating database '${DBNAME}' with owner '${OWNER}'..."
    psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"${DBNAME}\" OWNER \"${OWNER}\";" || echo "Warning: failed to create DB ${DBNAME}"
    echo "Database '${DBNAME}' created."
  fi
}

# Ensure role for POSTGRES_USER exists (create with password if provided)
ensure_role_exists "$POSTGRES_USER" "$POSTGRES_PASSWORD"

# Ensure the configured POSTGRES_DB exists
create_db_if_missing "$POSTGRES_DB" "$POSTGRES_USER"

# Also ensure a DB with the same name as the user exists (e.g. 'graphene')
if [ "$POSTGRES_USER" != "$POSTGRES_DB" ]; then
  create_db_if_missing "$POSTGRES_USER" "$POSTGRES_USER"
fi

# Wait for the original postgres process to exit (keep container alive)
#echo "Waiting on postgres (PID $PG_PID)..."
wait "$PG_PID"

exit 0

