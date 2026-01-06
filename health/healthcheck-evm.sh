#!/bin/sh
# grph-evm/healthcheck.sh - return 0 only if JSON health endpoint contains "status":"UP"
set -eu

HEALTH_URL="http://127.0.0.1:3003/status"
TIMEOUT=5  # seconds
TMP=$(mktemp)

# Step 1: Check HTTP health endpoint
echo "Checking health endpoint $HEALTH_URL..."

# fetch body (curl preferred)
if command -v curl >/dev/null 2>&1; then
    if ! timeout "$TIMEOUT" curl -sS -f "$HEALTH_URL" -o "$TMP" 2>/dev/null; then
        echo "ERROR: Failed to fetch health endpoint (curl)" >&2
        rm -f "$TMP"
        exit 1
    fi
# fallback to wget if available
elif command -v wget >/dev/null 2>&1; then
    if ! timeout "$TIMEOUT" wget -qO "$TMP" "$HEALTH_URL" 2>/dev/null; then
        echo "ERROR: Failed to fetch health endpoint (wget)" >&2
        rm -f "$TMP"
        exit 1
    fi
else
    # fallback to TCP check for port 3003 (from HEALTH_URL)
    echo "WARNING: No http client (curl/wget) found, trying TCP check for port 3003..." >&2

    # Simple TCP check function for the fallback
    check_tcp_port() {
        local host="$1"
        local port="$2"

        # Try multiple methods for TCP checking
        # Method 1: Using /dev/tcp
        if (timeout "$TIMEOUT" bash -c "echo >/dev/tcp/$host/$port" 2>/dev/null) 2>/dev/null; then
            return 0
        fi

        # Method 2: Using nc
        if command -v nc >/dev/null 2>&1; then
            if timeout "$TIMEOUT" nc -z "$host" "$port" 2>/dev/null; then
                return 0
            fi
        fi

        # Method 3: Using python
        if command -v python3 >/dev/null 2>&1; then
            if python3 -c "
import socket
import sys
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout($TIMEOUT)
    result = sock.connect_ex(('$host', $port))
    sock.close()
    sys.exit(0 if result == 0 else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
                return 0
            fi
        fi

        return 1
    }

    # Extract port from HEALTH_URL (default to 3003 if parsing fails)
    PORT="3003"
    if echo "$HEALTH_URL" | grep -q 'http://[^:/]*:\([0-9]*\)'; then
        PORT=$(echo "$HEALTH_URL" | sed -n 's|http://[^:/]*:\([0-9]*\).*|\1|p')
    fi

    if check_tcp_port "locala" "$PORT"; then
        echo "✓ Port $PORT is open (assuming health check passes)"
        rm -f "$TMP"
        exit 0
    else
        echo "ERROR: Port $PORT is not open" >&2
        rm -f "$TMP"
        exit 1
    fi
fi

# check JSON contains: "status":"UP"
if grep -E '"status"\s*:\s*"UP"' "$TMP" >/dev/null 2>&1; then
    echo "✓ Health endpoint reports UP status"
    rm -f "$TMP"
    exit 0
else
    echo "ERROR: Health endpoint does not report UP status" >&2
    # Debug: show what we got
    if [ -f "$TMP" ]; then
        echo "Response received:" >&2
        cat "$TMP" >&2
        echo "" >&2
    fi
    rm -f "$TMP"
    exit 1
fi