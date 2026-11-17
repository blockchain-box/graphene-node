# Graphene Node

Run and manage your own **validator** or **sentry** through a local browser console. Join an existing Dev, Test or Prod network, choose a local or prepared cloud host, then set up and monitor your node.

## 1. Install the requirements

On the computer where you open the console, install:

- **Node.js 24 or newer** with npm.
- A current web browser.
- **Python 3** for checkpoint restore.
- **Docker Engine with Compose v2**, or Docker Desktop with Linux containers, to run nodes locally. Start Docker before setting up a local node.

For a cloud node, prepare a Linux host with Node.js 24+, npm, Python 3 and Docker Compose v2. Your console computer also needs OpenSSH (`ssh` and `ssh-keygen`), `tar`, and access to that host. The Linux host needs `tar` as well. The console connects to an existing host; create the server with your cloud provider first.

Check your local installation:

```sh
node --version
npm --version
python3 --version
docker info
docker compose version
```

For a cloud deployment, run the Docker checks on the cloud host.

## 2. Start the frontend

Open a terminal in the `graphene-node` folder, then run:

```sh
npm ci
npm start
```

The console opens in your browser. If it does not open automatically, copy the **complete private link printed in the terminal**, including the part after `#`. The default address starts with `http://127.0.0.1:8787/`.

Keep this terminal running while using the console. The frontend and its local API start together; no separate frontend install or build command is needed. Keep the private link to yourself.

Run `npm start` from the `graphene-node` folder on macOS, Windows or Linux. Use **Validator deployments** or **Sentry deployments** in the console to choose the node role.

## 3. Select the network and host

1. Select **Dev**, **Test** or **Prod** in the sidebar. The console fetches and verifies that network's invitation automatically.
2. Open **Validator deployments → New validator** or **Sentry deployments → New sentry**, and give the node a name.
3. Under **Configuration → Choose deployment host**, choose **Local Docker Engine** or **Cloud provider · existing host**.
4. For a cloud host, enter its SSH connection, private-key path and verified `known_hosts` file. Save the connection, then select **Install participant runtime**. You can generate an SSH key in the console and install its public key on the server first.

You can run several named nodes. Each has its own data directory and Docker Compose project. Use **Manage node** to open one node's setup and controls.

## 4. Set up a validator

A validator connects outbound to a public sentry and keeps its signing keys on the selected host.

1. Open your validator's **Network & identity** step.
2. Enter your operator wallet's **public address** and a private passphrase of at least **32 characters**. Create the identity and keep the passphrase safe.
3. Select **Prepare from invitation**. The console configures the pinned runtime and sentry connection from the verified network invitation.
4. Follow **On-chain enrollment** with your operator wallet to register, stake and request admission. Sign transactions in your wallet. Starting containers alone does not grant voting power.
5. Continue with **Start and monitor** below.

Validators publish no host ports. If you see **Waiting for public sentry**, the network needs to publish a reachable sentry before you can join. Never reuse a genesis validator's keys or run two copies of one validator identity.

## 5. Set up a sentry

A sentry is a public peer with no voting power. Before preparing it:

- Point a DNS-only hostname to the host's public IPv4 address, or use a globally routable IPv4 address directly.
- Allow inbound TCP **26656** for P2P and **26657** for the read-only RPC gateway and public invitation/checkpoint files. For a local host behind a router, forward these ports to it.
- Keep administrative RPC, databases and internal services private. Multiple sentries on one host need different public P2P and read-only RPC ports.

In your sentry's **Network & identity** step, enter its public hostname or IP and select **Prepare sentry**. The upstream peer comes from the verified invitation. Then continue below.

## 6. Start and monitor

1. In **Checkpoint & install**, select **Review deployment**. Check the host, release, upstream, ports and data directory.
2. For a fresh node, choose **Use public checkpoint** if a compatible signed snapshot is available. The console verifies it and restores with your node's own identity. Otherwise, **Start node** replays from genesis and requires a peer serving that history.
3. Start the reviewed node. Use **Services & endpoints**, **Network monitor** and **Activity & logs** to check containers, peers, block height, catch-up and errors.

If checkpoint restore fails, retain the restore journal and use **Retry checkpoint restore** with the same selection. Never delete signing history to make a validator appear fresh.

**Stop node** stops the node while retaining its identity and data. Closing the browser or stopping the console with `Ctrl+C` leaves node containers running. Run `npm start` again to reopen the console.

Local node data defaults to `~/.graphene/participants/`. Cloud data stays under the remote user's `~/.graphene/participants/`. Back up the entire private validator directory while the node is stopped. **Remove node** deletes its identity and data after review; complete any required on-chain exit first.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Console port is busy | Set `SETUP_PORT=0` and run `npm start` again to choose a free port. On macOS/Linux: `SETUP_PORT=0 npm start`. In PowerShell: `$env:SETUP_PORT=0; npm start`. |
| Browser shows an authorization error | Use the complete private terminal link, including its `#` token. |
| Docker connection fails | Start Docker and confirm `docker info` and `docker compose version` work on the selected deployment host. |
| Network API is unavailable | Use **Refresh public network** to retry. A new network needs a verified invitation before node creation. |
| Image pull is denied | Sign in to the required image registry on the selected deployment host. |
| Cloud connection fails | Check SSH access, the selected key and the independently verified host key. |
| Sentry cannot be reached | Check DNS, cloud firewall, router forwarding and the node's configured public ports. |

See [PARTICIPANTS.md](PARTICIPANTS.md) for network endpoints, cloud credentials, checkpoint details and removal/recovery instructions.

## For maintainers

```sh
npm test
npm run package:operator-kit
```

The standalone operator ZIP, guide and checksums are written to `dist/operator/`. Packaging uses the explicit public file list in `participant/kit-files.json` and excludes local node data and secrets.

The source contains the browser console and host runtime (`participant/`), shared identity helpers (`agents/`), bundled key utilities (`network/utils/`), participant tests and kit packaging (`scripts/`). Frontend assets, including icons, live in `participant/ui/`. Node setup and service controls run through the participant runtime. Nodes use images pinned by their network invitation. Network creation, image builds, the old launcher, explorer assets and the EVM client SDK are outside this repository's scope.
