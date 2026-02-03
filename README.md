# Graphene Node Deployment

Docker-based deployment for Graphene network nodes (validator and sentry).

> ⚠️ **Note**: This documentation currently focuses on **local development only**. Test and live environments are work
> in progress.

---

## Prerequisites

- **Docker** (new Version)
    - [Install Docker](https://docs.docker.com/get-docker/)

- **Git**
    - [Install Git](https://git-scm.com/downloads)

- **Git LFS** (optional, recommended)
    - [Install Git LFS](https://git-lfs.github.com/)
    - After cloning this repository, pull LFS objects:
      ```bash
      git lfs pull
      ```

- **Bash shell** (included by default on Linux/macOS, use Git Bash on Windows)

---

## Quick Start - Local Environment

Run a complete Graphene node locally with a single command:

```bash
sh deploy.sh local
```

This will:

- Deploy validator and sentry node
- Start the Graphene blockchain network
- Expose all necessary endpoints

### Endpoints

Once deployed, access the following services:

- **EVM RPC**: `http://localhost:3003/graphene-evm/rpc`
    - Chain ID: `9991`

- **Graphene Explorer**: `http://localhost:8080`

- **Tendermint RPC**: `http://localhost:26657`

---

## Managing Local Environment

### Stop Node

```bash
sh deploy.sh --stop
```

### Restart Node

```bash
sh deploy.sh --restart local
```

### Clean Up (Remove Containers and Volumes)

```bash
sh deploy.sh --clean local
```

---

## Connect MetaMask to Local Network

1. **Add Custom Network**:
    - Network name: `Graphene Local`
    - RPC URL: `http://localhost:3003/graphene-evm/rpc`
    - Chain ID: `9991`
    - Currency symbol: `GRPH`
    - Explorer: `http://localhost:8080`

2. **Import Test Wallet** (optional):
    - Private key: `8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba`
    - ⚠️ **For testing only** - never use this key with real funds

---

## Verify Deployment

Check if Graphene Node is running:

```bash
docker ps
```

Test the EVM RPC endpoint:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  http://localhost:3003/graphene-evm/rpc
```

Check Tendermint status:

```bash
curl -s http://localhost:26657/status | jq
```

Access the blockchain explorer:

```bash
open http://localhost:8080
```

---

## Troubleshooting

- Ensure Docker daemon is running
- Check if required ports are available (3003, 8080, 26657)
- Clean and restart with `sh deploy.sh --clean local && sh deploy.sh local`

---

## Test Environment

⚠️ **Work in Progress** - Test environment configuration is under development.

---

## Live Environment

⚠️ **Work in Progress** - Live environment configuration is under development.

---

## Contributing

Contributions are welcome! Please open issues or pull requests for improvements.

---

## Support

For questions or issues, open an issue in the repository or contact the maintainers.