#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="/tendermint/config"
DATA_DIR="/tendermint/data"

# Create necessary directories
mkdir -p "$CONFIG_DIR"
mkdir -p "$DATA_DIR"

# Process configuration files from base64 encoded environment variables
if [ -n "${NODE_KEY_JSON:-}" ]; then
  echo "$NODE_KEY_JSON" | base64 -d > "$CONFIG_DIR/node_key.json"
fi

if [ -n "${PRIV_VALIDATOR_KEY_JSON:-}" ]; then
  echo "$PRIV_VALIDATOR_KEY_JSON" | base64 -d > "$CONFIG_DIR/priv_validator_key.json"
fi


# Set secure permissions on JSON files
chmod 600 "$CONFIG_DIR"/*.json || true

PRIV_VALIDATOR_STATE_FILE="$DATA_DIR/priv_validator_state.json"
if [ ! -f "$PRIV_VALIDATOR_STATE_FILE" ]; then
  echo "Creating priv_validator_state.json with initial state..."
  cat > "$PRIV_VALIDATOR_STATE_FILE" << EOF
{
  "height": "0",
  "round": 0,
  "step": 0
}
EOF
  chmod 600 "$PRIV_VALIDATOR_STATE_FILE"
fi

# Start Tendermint with all passed arguments
tendermint "$@"