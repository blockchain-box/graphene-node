#!/usr/bin/env bash

# Re-exec with bash if invoked with sh/dash which doesn't support 'set -o pipefail'
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  echo "This script requires bash. Run with: bash $0" >&2
  exit 1
fi

set -euo pipefail

# -----------------------------
# Parameters
# -----------------------------
NODE_ENV="${1:-local}" # required: local, test, live
CMD="${2:-init}" # required: init, show-node-id, show-validator
NODE_TYPE="${3:-validator}"  # required for init: validator, full, seed

usage() {
  echo "Usage:"
  echo "Note: Full node act as sentry node for validator nodes to protect them from direct exposure to the internet."
  echo " sh $0 init [validator|full|seed]"
  echo " sh $0 show-node-id [validator|full|seed]"
  echo " sh $0 show-validator [validator|full|seed]"
  exit 1
}

validate_params() {
  # NODE_ENV: local, test, live
  case "$NODE_ENV" in
    local|test|live) ;;
    *)
      echo "Not valid env: $NODE_ENV"
      echo "You can use: local, test, live"
      usage
      ;;
  esac

  case "$CMD" in
    init|show-node-id|show-validator)
      case "$NODE_TYPE" in
        validator|full|seed) ;;
        *)
          echo "Not valid node type for $CMD: $NODE_TYPE"
          echo "You can use one of: validator, full, seed"
          usage
          ;;
      esac
      ;;
    *)
      echo "Not valid command: $CMD"
      usage
      ;;
  esac
}

validate_params


# -----------------------------
# Config
# -----------------------------
TENDERMINT_IMAGE="graphene/tendermint:${NODE_ENV}"
CONTAINER_NAME="tendermint"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Volumes (relative to script)
TENDERMINT_BASE_DIR="$SCRIPT_DIR/../volumes/${NODE_ENV}/tendermint/${NODE_TYPE}"
CONFIG_DIR="$TENDERMINT_BASE_DIR/config"
CONFIG_NODE_KEY_PATH="$CONFIG_DIR/node_key.json"
CONFIG_VALIDATOR_KEY_PATH="$CONFIG_DIR/priv_validator_key.json"
DATA_DIR="$TENDERMINT_BASE_DIR/data"

if docker image inspect "${TENDERMINT_IMAGE}" >/dev/null 2>&1; then
  echo "  ✅ Docker image ${TENDERMINT_IMAGE} already exists — skipping build"
else
  echo "  ⬇️ Building Docker image ${TENDERMINT_IMAGE}..."
  docker build \
    -t "${TENDERMINT_IMAGE}" \
    -f "${SCRIPT_DIR}/../docker/tendermint/Dockerfile" \
    "${SCRIPT_DIR}/.."
fi

# -----------------------------
# Helpers
# -----------------------------
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

init_node() {
  echo "  🔧 Initializing Tendermint ($NODE_TYPE)..."
  INIT_CONTAINER="${CONTAINER_NAME}_${CMD}"
  docker rm -f "$INIT_CONTAINER" >/dev/null 2>&1 || true
  ensure_dirs
  docker run \
     --name "$INIT_CONTAINER" \
     -v "$DATA_DIR":/tendermint/data \
     "$TENDERMINT_IMAGE" "$CMD" "$NODE_TYPE"
  mkdir -p "$(dirname "$CONFIG_NODE_KEY_PATH")"
  docker cp "$INIT_CONTAINER":/tendermint/config/node_key.json "$CONFIG_NODE_KEY_PATH"
  docker cp "$INIT_CONTAINER":/tendermint/config/priv_validator_key.json "$CONFIG_VALIDATOR_KEY_PATH"
  docker rm -f "$INIT_CONTAINER"
  echo "  ✅ Tendermint initialized"
}

show_node_info() {
  echo "  🔎 Showing your Tendermint node info of type ${NODE_TYPE}..."
  INFO_CONTAINER="${CONTAINER_NAME}_${CMD}"
  docker rm -f "$INFO_CONTAINER" >/dev/null 2>&1 || true
  docker run \
       --name "$INFO_CONTAINER" \
       -v "$DATA_DIR":/tendermint/data \
       -v "$CONFIG_NODE_KEY_PATH":/tendermint/config/node_key.json:ro \
       -v "$CONFIG_VALIDATOR_KEY_PATH":/tendermint/config/priv_validator_key.json:ro \
       "$TENDERMINT_IMAGE" "$CMD"
}

if [ "$CMD" = "init" ]; then
   init_node
elif [ "$CMD" = "show-node-id" ]; then
  show_node_info
elif [ "$CMD" = "show-validator" ]; then
  show_node_info
else
  echo "Not valid command: $CMD"
  usage
fi
