# Sentry Agent

Node.js CLI sidecar that runs alongside a Graphene sentry node. Monitors the chain for new assignments targeting this sentry, decrypts the invite key with the sentry's X25519 private key, starts `GrphClient` to connect to the validator's `GrphServer`, allocates a unique local loopback port per validator, rewrites Tendermint `persistent_peers`, and restarts Tendermint via the Docker socket.

## Quick Start

```bash
cd graphene-node

# Install dependencies (from graphene-node/ root)
npm install

# Generate sentry secrets (X25519 + Ethereum key)
SECRETS_PATH=/app/secrets/sentry-secrets.json \
  node agents/sentry-agent/src/cli.js init

# Start monitoring for assignments
SECRETS_PATH=/app/secrets/sentry-secrets.json \
RPC_URL=http://app-evm-sentry:3003 \
  node agents/sentry-agent/src/cli.js start
```

## Commands

| Command | Description |
|---|---|
| `init` | Generate X25519 encryption keypair + Ethereum agent key; save to secrets file |
| `start` | Begin polling + WebSocket monitoring for assignments targeting this sentry |
| `reload` | Reload configuration (restart to apply) |
| `sync` | Force sync with contract state |
| `status` | Show tunnels, validators, ports, and identity |
| `logs` | View agent logs (`-f` to follow, `-n N` for line count) |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `RPC_URL` | `http://app-evm-sentry:3003` | EVM app JSON-RPC endpoint |
| `WS_URL` | `ws://app-abci-sentry:3002/graphene/tx-watch` | WebSocket for tx-watch events |
| `SECRETS_PATH` | `/app/secrets/sentry-secrets.json` | Path to sentry secrets file |
| `PORT_RANGE_START` | `40001` | Start of local loopback port range |
| `PORT_RANGE_END` | `40999` | End of local loopback port range |
| `TENDERMINT_CONFIG_PATH` | `/tendermint/config/config.toml` | Path to Tendermint config |
| `TENDERMINT_CONTAINER` | `sentry-node` | Docker container name for Tendermint |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path |
| `STATE_PATH` | `/app/state` | Agent state directory |
| `POLL_INTERVAL_MS` | `15000` | Assignment poll interval in ms |
| `LOG_PATH` | `/app/logs/sentry-agent.log` | Log file path |

## Architecture

```
sentry-agent
├── src/
│   ├── cli.js              CLI entry (commander)
│   ├── utils.js             Logging, hex helpers
│   ├── port-allocator.js    Port allocation + persistence
│   ├── tunnel-manager.js    GrphClient lifecycle + invite key decryption
│   ├── config-writer.js     persistent_peers rewrite in config.toml
│   ├── docker.js            Docker socket → restart Tendermint
│   └── monitor.js           Assignment polling + WebSocket + lifecycle
├── config/default.env
├── Dockerfile
└── docker/entrypoint.sh
```

## Key Generation

`init` produces the following keys:

| Key | Algorithm | Purpose |
|---|---|---|
| X25519 keypair | tweetnacl (curve25519) | Decrypt invite keys from validators |
| Agent Ethereum key | ethers.js (secp256k1) | Identity for assignment lookup |

## Assignment Flow

1. **Poll**: Agent polls `GET /graphene/state/platform/assignments?sentry=<sentry-address>` every `POLL_INTERVAL_MS`
2. **WebSocket** (optional): Connects to `WS_URL` for real-time events
3. **On new assignment**: Decrypts `encryptedConnectionString` with sentry's X25519 secret key
4. **Tunnel**: Starts `GrphClient` and connects to validator's `GrphServer` at `127.0.0.1:<allocated-port>`
5. **Config**: Adds peer entry to `persistent_peers` in `config.toml`, restarts Tendermint via Docker
6. **On revoke**: Disconnects `GrphClient`, removes peer, restarts Tendermint, frees port

## Docker

```bash
docker build -t sentry-agent:local \
  -f agents/sentry-agent/Dockerfile \
  --build-context .. .

# Run (requires mounted secrets, config, and Docker socket)
docker run --rm \
  -v /path/to/secrets:/app/secrets \
  -v /path/to/tendermint:/tendermint \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SECRETS_PATH=/app/secrets/sentry-secrets.json \
  -e RPC_URL=http://... \
  -e TENDERMINT_CONTAINER=sentry-node \
  sentry-agent:local node agents/sentry-agent/src/cli.js start
```

## Testing

```bash
npm install

# Unit: key generation
SECRETS_PATH=/tmp/sentry-secrets.json \
  node agents/sentry-agent/src/cli.js init

# Integration: requires running network
SECRETS_PATH=/app/secrets/sentry-secrets.json \
RPC_URL=http://app-evm-sentry:3003 \
  node agents/sentry-agent/src/cli.js start

# View status
node agents/sentry-agent/src/cli.js status
```
