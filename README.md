# graphene-node

Lightweight README for running a Graphene node locally (developer / testing workflow).

> Important: This README focuses on running the node locally. Sections for "Test" and "Live" are included with TODO
> placeholders for future documentation.

---

## Overview

This repository contains a Graphene node you can run locally for development and testing. The local node uses Tendermint
for consensus and exposes an EVM-compatible RPC endpoint for wallets like MetaMask.

Local EVM RPC:

- RPC URL: `http://localhost:3003/graphene-evm/rpc`
- Chain ID: `9990`

You may want to import a local wallet private key into MetaMask (see "Add a local wallet to MetaMask" below).

---

## Prerequisites

- POSIX shell (bash / sh)
- jq (recommended) for JSON extraction (optional)
- Git (to clone repository)
- Docker & docker-compose (if the provided `deploy/start.local.sh` uses them — check the script). If not using Docker,
  the script will indicate what services are expected.
- Ports: common local ports used by Tendermint and the EVM node (check `deploy/start.local.sh` and local config)

Note: Make scripts executable if needed:

```bash
chmod +x scripts/tendermint
chmod +x deploy/start.local.sh
```

---

## Quick local run (step-by-step)

1. Clone the repository (if you haven't already)

```bash
git clone https://github.com/blockchain-box/graphene-node.git
cd graphene-node
```

2. Initialize Tendermint (required)

```bash
sh scripts/tendermint init
```

This generates your local validator keys and other Tendermint artifacts.

Generated files (example paths)

- `volumes/local/tendermint/config/node_key.json`
- `volumes/local/tendermint/config/priv_validator_key.json`

3. Update the genesis validator info (required)

Open:

```
config/tendermint/local/genesis.json
```

Replace the following fields in the genesis file with values from the generated key files:

- Validator address
- Validator public key (base64)

You can inspect the generated files. Example helpful `jq` commands (adjust keys if your JSON structure differs):

```bash
# Show node address (example)
jq -r '.address // .id' volumes/local/tendermint/config/node_key.json

# Show priv_validator public key value (base64) — adjust path if different
jq -r '.pub_key.value // .priv_key.value' volumes/local/tendermint/config/priv_validator_key.json
```

Copy the appropriate values and paste them into `config/tendermint/local/genesis.json` in the validator entries.

> ⚠️ This step is required for your local validator to work correctly: the validator entry in genesis must match the
> generated keys.

4. Start the node

```bash
sh deploy/start.local.sh
```

This script boots your local node stack (check the script to see whether it runs via Docker, docker-compose, or runs
processes directly). Keep the terminal open to view logs or run it in the background as you prefer.

---

## Add a local wallet private key to MetaMask (for testing)

1. Open MetaMask.
2. Click the account circle → Import account.
3. Choose "Private Key" and paste the local private key:
   ```
   8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
   ```
    - Note: do NOT use mainnet/private keys that hold funds — this is a local test wallet only.

4. Add a custom network:
    - Network name: `Graphene Local` (or any name)
    - RPC URL: `http://localhost:3003/graphene-evm/rpc`
    - Chain ID: `9990`
    - Currency symbol: `GRPH`
    - Block explorer URL: (optional)

After adding the network and importing the private key, you can send transactions to local another wallet address via MetaMask.
---

## Verify the node is running

- Check the node logs (wherever `deploy/start.local.sh` writes logs or runs services).
- Test Tendermint RPC (example):

```bash
curl -sS http://localhost:26657/status | jq
```

- Test the EVM RPC (example JSON-RPC call):

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  http://localhost:3003/graphene-evm/rpc
```

Expected `result` should correspond to chain id `9990` (in hex: `0x2706`), if the node maps chain id properly.

---

## Volumes & Important Files

- Tendermint generated keys:
    - `volumes/local/tendermint/config/node_key.json`
    - `volumes/local/tendermint/config/priv_validator_key.json`
- Genesis file to edit:
    - `config/tendermint/local/genesis.json`
- Startup script:
    - `deploy/start.local.sh`
- Tendermint helper script:
    - `scripts/tendermint`

Keep backups of generated keys if you want consistent validator identity across restarts.

---

## Troubleshooting tips

- If the node fails to start, inspect `deploy/start.local.sh` for logs and environment it expects.
- Ensure the `genesis.json` validator address and public key exactly match the generated values.
- Make sure ports are not in use (e.g., 26656/26657 for Tendermint; 3003 for EVM RPC).
- If JSON paths differ when using `jq`, open the JSON files to see actual key names — structures may vary by Tendermint
  version.
- If MetaMask rejects the chain ID, try entering the chain id as decimal `9990` (not hex) in the MetaMask network
  configuration.

---

## Test network

TODO:

---

## Live network deployment

TODO:

- Document production deployment steps and security hardening.
- Describe validator setup for mainnet/testnet operation.
- Instructions on key management, backups, and monitoring.
- Network topology and peers configuration.

---

## Contributing

Contributions and improvements are welcome. Please open issues or PRs in the repository. When adding instructions or
automations for tests/live stages, please include reproducible examples and explicit commands.

---

## Contact / Support

For questions or issues while running locally, open an issue in this repository or reach out to the maintainers.

---

Thank you — happy testing!