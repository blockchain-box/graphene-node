#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# Config
# -----------------------------
TENDERMINT_IMAGE="graphene/tendermint:local"
CONTAINER_NAME="tendermint"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker build \
  -t "${TENDERMINT_IMAGE}" \
  -f "${SCRIPT_DIR}/../docker/tendermint/Dockerfile" \
  "${SCRIPT_DIR}/.."

# Volumes (relative to script)
TENDERMINT_BASE_DIR="$SCRIPT_DIR/../volumes/local/tendermint"
CONFIG_DIR="$TENDERMINT_BASE_DIR/config"
CONFIG_NODE_KEY_PATH="$CONFIG_DIR/node_key.json"
CONFIG_VALIDATOR_KEY_PATH="$CONFIG_DIR/priv_validator_key.json"
DATA_DIR="$TENDERMINT_BASE_DIR/data"


# -----------------------------
# Helpers
# -----------------------------
usage() {
  echo "Usage:"
  echo "  $0 init [validator|full|seed]"
  echo "  $0 node"
  echo "  $0 unsafe-reset-all"
  exit 1
}

ensure_dirs() {
  mkdir -p "$CONFIG_DIR" "$DATA_DIR"
}

remove_container_if_exists() {
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    docker rm -f "$CONTAINER_NAME"
  fi
}

# -----------------------------
# Main
# -----------------------------
CMD="${1:-}"

#if [[ -z "$CMD" ]]; then
#  usage
#fi

ensure_dirs

NODE_TYPE="${2:-validator}"  # default to validator
echo "🔧 Initializing Tendermint ($NODE_TYPE)..."

INIT_CONTAINER="${CONTAINER_NAME}_init"

docker rm -f "$INIT_CONTAINER" >/dev/null 2>&1 || true

docker run --name "$INIT_CONTAINER" -v "$DATA_DIR":/tendermint/data "$TENDERMINT_IMAGE" init "$NODE_TYPE"

mkdir -p "$(dirname "$CONFIG_NODE_KEY_PATH")"
docker cp "$INIT_CONTAINER":/tendermint/config/node_key.json "$CONFIG_NODE_KEY_PATH"
docker cp "$INIT_CONTAINER":/tendermint/config/priv_validator_key.json "$CONFIG_VALIDATOR_KEY_PATH"
docker rm -f "$INIT_CONTAINER"

echo "✅ Tendermint initialized"
