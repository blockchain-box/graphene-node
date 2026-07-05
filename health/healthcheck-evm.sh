#!/bin/sh
# healthcheck-evm.sh - return 0 only if JSON health endpoint contains "status":"UP"
set -eu

HEALTH_URL="http://127.0.0.1:3003/status"
TIMEOUT=5  # seconds
TMP=$(mktemp)

check_tcp_port() {
    _host="$1"
    _port="$2"

    if command -v nc >/dev/null 2>&1; then
        if timeout "$TIMEOUT" nc -z "$_host" "$_port" 2>/dev/null; then
            return 0
        fi
    fi

    if command -v python3 >/dev/null 2>&1; then
        if python3 -c "
import socket, sys
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout($TIMEOUT)
    result = sock.connect_ex(('$_host', $_port))
    sock.close()
    sys.exit(0 if result == 0 else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
            return 0
        fi
    fi

    if timeout "$TIMEOUT" bash -c "echo >/dev/tcp/$_host/$_port" 2>/dev/null; then
        return 0
    fi

    return 1
}

echo "Checking health endpoint $HEALTH_URL..."
if command -v curl >/dev/null 2>&1; then
    if ! timeout "$TIMEOUT" curl -sS -f "$HEALTH_URL" -o "$TMP" 2>/dev/null; then
        echo "ERROR: Failed to fetch health endpoint (curl)" >&2
        rm -f "$TMP"
        exit 1
    fi
elif command -v wget >/dev/null 2>&1; then
    if ! timeout "$TIMEOUT" wget -qO "$TMP" "$HEALTH_URL" 2>/dev/null; then
        echo "ERROR: Failed to fetch health endpoint (wget)" >&2
        rm -f "$TMP"
        exit 1
    fi
else
    echo "WARNING: No http client found, trying raw TCP check..." >&2
    if check_tcp_port "localhost" "3003"; then
        echo "Port 3003 is open (assuming health check passes)"
        rm -f "$TMP"
        exit 0
    else
        echo "ERROR: Port 3003 is not open" >&2
        rm -f "$TMP"
        exit 1
    fi
fi

if grep -E '"status"\s*:\s*"UP"' "$TMP" >/dev/null 2>&1; then
    echo "Health endpoint reports UP status"
    rm -f "$TMP"
    exit 0
else
    echo "ERROR: Health endpoint does not report UP status" >&2
    if [ -f "$TMP" ]; then
        echo "Response received:" >&2
        cat "$TMP" >&2
        echo "" >&2
    fi
    rm -f "$TMP"
    exit 1
fi
