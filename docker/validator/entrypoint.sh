#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="/tendermint/config"

mkdir -p "$CONFIG_DIR"

if [ -n "${NODE_KEY_JSON:-}" ]; then
  echo "$NODE_KEY_JSON" | base64 -d > "$CONFIG_DIR/node_key.json"
fi

if [ -n "${PRIV_VALIDATOR_KEY_JSON:-}" ]; then
  echo "$PRIV_VALIDATOR_KEY_JSON" | base64 -d > "$CONFIG_DIR/priv_validator_key.json"
fi

if [ -n "${GENESIS_JSON:-}" ]; then
  echo "$GENESIS_JSON" | base64 -d > "$CONFIG_DIR/genesis.json"
fi

chmod 600 "$CONFIG_DIR"/*.json || true

tendermint "$@"
