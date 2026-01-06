#!/bin/bash

# Debug: Print environment variables
echo "=== Healthcheck Debug ===" >&2
echo "POSTGRES_USER: $POSTGRES_USER" >&2
echo "POSTGRES_DB: $POSTGRES_DB" >&2
echo "Current time: $(date)" >&2

# Check if variables are set
if [ -z "$POSTGRES_USER" ]; then
    echo "ERROR: POSTGRES_USER is not set!" >&2
    exit 1
fi

if [ -z "$POSTGRES_DB" ]; then
    echo "ERROR: POSTGRES_DB is not set!" >&2
    exit 1
fi

# Test the pg_isready command
echo "Running: pg_isready -U $POSTGRES_USER -d $POSTGRES_DB" >&2
pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
exit_code=$?
echo "Exit code: $exit_code" >&2

exit $exit_code