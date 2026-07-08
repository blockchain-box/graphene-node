# Validator Agent

Node.js CLI sidecar that runs alongside a Graphene validator node. Generates encrypted secrets, operates the P2P tunnel (`GrphServer`), monitors the chain for approved sentry applications, and submits `submitConnectionString` on-chain.

## Quick Start

```bash
cd graphene-node

# Install dependencies (from graphene-node/ root)
npm install

# Generate all keys and save to encrypted keystore
KEYSTORE_PATH=/app/secrets/keystore.enc \
KEYSTORE_PASSPHRASE="your-strong-passphrase" \
  node agents/validator-agent/src/cli.js init

# Start GrphServer + Tendermint + monitor
KEYSTORE_PATH=/app/secrets/keystore.enc \
KEYSTORE_PASSPHRASE="your-strong-passphrase" \
RPC_URL=http://app-evm-validator:3003 \
CONTRACT_ADDRESS=0x... \
  node agents/validator-agent/src/cli.js connect
```

## Commands

| Command | Description |
|---|---|
| `init` | Generate seed + Grph invite key, X25519 encryption keypair, Ethereum agent signing key, Tendermint validator/node keys; encrypt to keystore |
| `connect` | Start `GrphServer` (P2P tunnel via DHT) + Tendermint + approval monitor |
| `status` | Show GrphServer state, Tendermint status |
| `disconnect` | Stop GrphServer and Tendermint |
| `logs` | View agent logs (`-f` to follow, `-n N` for line count) |
| `upgrade` | Stop agent for redeployment |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `RPC_URL` | `http://app-evm-validator:3003` | EVM app JSON-RPC endpoint |
| `WS_URL` | — | WebSocket for tx-watch events (falls back to polling) |
| `KEYSTORE_PATH` | `/app/secrets/keystore.enc` | Path to encrypted keystore file |
| `KEYSTORE_PASSPHRASE` | — | Keystore decryption passphrase (env or interactive) |
| `CONTRACT_ADDRESS` | — | Platform contract address for `submitConnectionString` |
| `AGENT_HOST` | `127.0.0.1` | GrphServer bind address |
| `AGENT_PORT` | `26658` | GrphServer port |
| `AGENT_PROTOCOL` | `tcp` | Tunnel protocol (`tcp` or `udp`) |
| `TENDERMINT_HOME` | `/tendermint` | Tendermint home directory |
| `PROXY_APP` | `tcp://app-abci-validator:26658` | ABCI app address |
| `P2P_SEEDS` | — | Tendermint seed nodes |
| `P2P_PERSISTENT_PEERS` | — | Tendermint persistent peers |
| `P2P_PRIVATE_PEER_IDS` | — | Tendermint private peer IDs |
| `POLL_INTERVAL_MS` | `15000` | Assignment poll interval in ms |

## Architecture

```
validator-agent
├── src/
│   ├── cli.js        CLI entry (commander)
│   ├── keystore.js   AES-256-GCM passphrase-encrypted storage
│   ├── keygen.js     Key generation (Grph, X25519, eth, Tendermint)
│   ├── server.js     GrphServer lifecycle management
│   ├── monitor.js    Approval detection + submitConnectionString
│   └── utils.js      Logging, hex helpers
├── config/default.env
├── Dockerfile
└── docker/entrypoint.sh
```

## Key Generation

`init` produces the following keys, all stored in a single encrypted keystore:

| Key | Algorithm | Purpose |
|---|---|---|
| Grph seed + keypair | hypercore-crypto (ed25519) | DHT identity + invite key |
| X25519 keypair | tweetnacl (curve25519) | Encrypt invite keys for sentries |
| Agent Ethereum key | ethers.js (secp256k1) | Sign `submitConnectionString` txs |
| Tendermint validator key | tweetnacl (ed25519) | Block signing (key type: `tendermint/PrivKeyEd25519`) |
| Tendermint node key | tweetnacl (ed25519) | P2P node identity |

*No keys are ever transmitted during `init` — everything stays local.*

## Approval Flow

1. **Poll**: Agent polls `GET /graphene/state/platform/assignments?validator=<agent-address>` every `POLL_INTERVAL_MS`
2. **WebSocket** (optional): Connects to `WS_URL` (`/graphene/tx-watch`) for real-time `ApplicationApproved` and `ConnectionStringSubmitted` events
3. **On new assignment**: Reads sentry's `encryptionPublicKey` from `/graphene/state/platform/sentries`
4. **Seal**: Encrypts the validator's invite key to the sentry's X25519 public key using `nacl.box` (sealed box)
5. **Submit**: Signs and broadcasts `submitConnectionString(assignmentId, encryptedConnectionString)` via `eth_sendRawTransaction`

## Docker

```bash
docker build -t validator-agent:local \
  -f agents/validator-agent/Dockerfile \
  --build-context .. .

# Run (requires mounted keystore and network access)
docker run --rm \
  -v /path/to/secrets:/app/secrets \
  -e KEYSTORE_PATH=/app/secrets/keystore.enc \
  -e KEYSTORE_PASSPHRASE=... \
  -e RPC_URL=http://... \
  -e CONTRACT_ADDRESS=0x... \
  validator-agent:local node agents/validator-agent/src/cli.js connect
```

The agent is included in `services/docker.compose.validator.yml` as the `validator-agent` service.

## Testing

```bash
npm install

# Unit: key generation and keystore
KEYSTORE_PASSPHRASE=test node agents/validator-agent/src/cli.js init
KEYSTORE_PASSPHRASE=test node agents/validator-agent/src/cli.js status
KEYSTORE_PASSPHRASE=test node agents/validator-agent/src/cli.js disconnect

# Integration: requires running network (app-abci + app-evm + Tendermint + contract)
KEYSTORE_PATH=/app/secrets/keystore.enc \
KEYSTORE_PASSPHRASE=... \
RPC_URL=http://app-evm-validator:3003 \
CONTRACT_ADDRESS=0x... \
  node agents/validator-agent/src/cli.js connect
```
