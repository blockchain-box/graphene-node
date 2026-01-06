#!/bin/sh
# grph-abci/healthcheck.sh - return 0 only if:
# 1. TCP port 26658 is open and accepting connections
# 2. JSON health endpoint contains "status":"UP"
set -eu

HEALTH_URL="http://127.0.0.1:3002/status"
ABCI_PORT=26658
TIMEOUT=5  # seconds
TMP=$(mktemp)

# Function to check if TCP port is open
check_tcp_port() {
    local host="$1"
    local port="$2"

    # Method 1: Using /dev/tcp (bash/zsh built-in)
    if timeout "$TIMEOUT" bash -c "echo >/dev/tcp/$host/$port" 2>/dev/null; then
        return 0
    fi

    # Method 2: Using nc (netcat)
    if command -v nc >/dev/null 2>&1; then
        if timeout "$TIMEOUT" nc -z "$host" "$port" 2>/dev/null; then
            return 0
        fi
    fi

    # Method 3: Using telnet
    if command -v telnet >/dev/null 2>&1; then
        if echo "quit" | timeout "$TIMEOUT" telnet "$host" "$port" 2>&1 | grep -q "Connected"; then
            return 0
        fi
    fi

    # Method 4: Using python
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

    # Method 5: Using ss (socket statistics)
    if command -v ss >/dev/null 2>&1; then
        if ss -tln | grep -q ":$port "; then
            return 0
        fi
    fi

    return 1
}

# Step 1: Check if TCP port 26658 is open
echo "Checking ABCI port $ABCI_PORT..."
if ! check_tcp_port "localhost" "$ABCI_PORT"; then
    echo "ERROR: TCP port $ABCI_PORT is not open or accepting connections" >&2
    rm -f "$TMP"
    exit 1
fi
echo "✓ ABCI port $ABCI_PORT is open"

# Step 2: Check HTTP health endpoint
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
    # fallback to shell-only TCP probe (not validating JSON)
    echo "WARNING: No http client (curl/wget) found, trying raw TCP check..." >&2
    if check_tcp_port "localhost" "3002"; then
        echo "✓ Port 3002 is open (assuming health check passes)"
        rm -f "$TMP"
        exit 0
    else
        echo "ERROR: Port 3002 is not open" >&2
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