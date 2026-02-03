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

show_validator_info() {
  # Extract lowercase validator address
  VALIDATOR_ADDRESS=$(jq -r '.address' "$CONFIG_VALIDATOR_KEY_PATH" | tr '[:upper:]' '[:lower:]')
  VALIDATOR_BASE64_PUBKEY=$(jq -r '.pub_key.value' "$CONFIG_VALIDATOR_KEY_PATH")
  echo "  🏷 Validator Address: 0x${VALIDATOR_ADDRESS}"
  echo
  echo "  ⚠️ Important:"
  echo "     1. Start your validator node first before submitting a stake transaction."
  echo "     2. Stake to this validator address on the Graphene chain to avoid slashing."
  echo "        Address:"
  echo "           0x${VALIDATOR_ADDRESS}"
  echo "        Public key (base64):"
  echo "           ${VALIDATOR_BASE64_PUBKEY}"
  echo "        Node ID:"
                   CMD="show-node-id"
  echo "           $(show_node_info)"
  echo
  rm -rf "$CONFIG_DIR"
  echo "⚠️ Provide these information to whitelisting authority to get your validator node whitelisted on the network.
by adding the validator address to the seed nodes of the network."
}

init_node() {
  echo "  🔧 Initializing Tendermint ($NODE_TYPE)..."

  INIT_CONTAINER="${CONTAINER_NAME}_${CMD}"

  # Clean up previous temporary container
  docker rm -f "$INIT_CONTAINER" >/dev/null 2>&1 || true

  ensure_dirs

  # Run temporary container to generate keys
  docker run \
    --name "$INIT_CONTAINER" \
    -v "$DATA_DIR":/tendermint/data \
    "$TENDERMINT_IMAGE" "$CMD" "$NODE_TYPE"

  mkdir -p "$(dirname "$CONFIG_NODE_KEY_PATH")"

  # Copy keys from container
  docker cp "$INIT_CONTAINER":/tendermint/config/node_key.json "$CONFIG_NODE_KEY_PATH"
  docker cp "$INIT_CONTAINER":/tendermint/config/priv_validator_key.json "$CONFIG_VALIDATOR_KEY_PATH"

  # Clean up temporary container
  docker rm -f "$INIT_CONTAINER"

  echo "  ✅ Tendermint initialized"

  # Base64 encode keys for environment variables
  NODE_KEY_JSON=$(base64 -i "$CONFIG_NODE_KEY_PATH" | tr -d '\n')
  PRIV_VALIDATOR_KEY_JSON=$(base64 -i "$CONFIG_VALIDATOR_KEY_PATH" | tr -d '\n')

  # Show key info for all node types
  echo
  echo "  📄 Save these keys in a safe place:"
  echo
  echo "  🔑 Node Key (node_key.json) for your environment:"
  echo "     NODE_KEY_JSON=${NODE_KEY_JSON}"
  echo
  echo "  🔐 Private Validator Key (priv_validator_key.json) for your environment:"
  echo "     PRIV_VALIDATOR_KEY_JSON=${PRIV_VALIDATOR_KEY_JSON}"
  echo

  # Show validator-specific info only if NODE_TYPE=validator
  if [ "$NODE_TYPE" = "validator" ]; then
      show_validator_info
  else
    CMD="show-node-id"
    echo "  Node ID: $(show_node_info)"
  fi
}


show_node_info() {
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
  echo "  🔎 Node id of type ${NODE_TYPE}..."
  show_node_info
elif [ "$CMD" = "show-validator" ]; then
  echo "  🔎 Validator info of type ${NODE_TYPE}..."
  show_node_info
else
  echo "Not valid command: $CMD"
  usage
fi
