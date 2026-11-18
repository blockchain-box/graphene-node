# Join an existing Graphene network

Install Node.js 24+, npm, Python 3 and Docker Engine with Compose v2. From a fresh checkout or extracted participant kit run:

```sh
npm ci
npm start
```

Open the complete private loopback link printed in the terminal. Select **Validator deployments** or **Sentry deployments** in the sidebar. The kit includes its runtime, identity and checkpoint helpers; no sibling workspace folder or network controller installation is required. Repeating `npm start` reopens the authenticated console already running for that data directory. If an unrelated application occupies the default port, use `SETUP_PORT=0 npm start` to select an available port automatically.

The console guides participants through deployment: **Configuration → Network & identity → Checkpoint & install → Services & endpoints**. Overview, Networks, Validator deployments, Sentry deployments, Network health, Activity & logs and Settings cover joining and operating your own nodes. It does not create genesis, change the blockchain release, update existing nodes, or deploy application frontends.

Each network workspace can have multiple named validators and sentries. Open **Validator deployments → New validator** or **Sentry deployments → New sentry**, name the node, then choose its own local or prepared cloud host. **Manage node** opens only that node's setup, keys, checkpoint, service controls and observations. Existing deployments remain listed. Nodes use separate data directories and Docker Compose projects, including when several run on the same machine. Sentries on the same machine must use different public P2P and read-only RPC ports; their invitation URLs show the configured ports.

## Choose a public network workspace

The sidebar includes three built-in workspaces:

| Workspace | Public API | Invitation endpoint |
| --- | --- | --- |
| Dev | https://api.dev.zlinkchain.io | https://api.dev.zlinkchain.io/api/invitation |
| Test | https://api.test.zlinkchain.io | https://api.test.zlinkchain.io/api/invitation |
| Prod | https://api.zlinkchain.io | https://api.zlinkchain.io/api/invitation |

The console automatically fetches each public invitation over HTTPS. Select a workspace, then create validator or sentry nodes there. No invitation file, network definition or manually entered checksum is required. The selected API is the trust anchor; frozen genesis, network hashes, pinned images, stage and wallet RPC origin are still validated. Test maps to the runtime's `staging` stage and Prod to `production`; chain IDs and all network data come from the APIs.

Development publishes its primary sentry’s reachable P2P endpoint in `publicPeer`. Both roles use that upstream automatically. After **Update network**, an existing unprepared identity can adopt this newly published peer when its pinned deployment otherwise matches; its keys and release stay unchanged. Preparing a cloud node refreshes the participant helper automatically.

**Public networks** shows availability and network details. **Refresh public network** retries the selected endpoint. Discovery responses are cached briefly, and verified network data is kept locally so an API outage does not hide existing nodes. An unavailable API stays listed with its error and a retry action. When the network has never been fetched, node creation waits for a successful response. Previously imported networks and their nodes remain available as additional workspaces.

When the API invitation differs from the cached invitation, **Network update available** compares the installed and API release and offers **Update network**. The button rechecks the API response before applying that exact update. It updates the workspace metadata used for new nodes and retains a history copy. Existing nodes keep their own pinned invitation, release, identity, configuration and signing history. Their details continue to show their pinned release. An invitation update cannot replace the frozen network or genesis; runtime upgrades are separate from invitation updates.

Each API must serve a public `graphene-join-v1` invitation at `GET /api/invitation`, including frozen genesis, network binding, pinned runtime images and its public sentry peer. Requests do not follow redirects. These routes must be reachable without browser challenges or account login. Newly prepared participant sentries also serve their own public invitations on their configured read-only RPC port.

## Choose a deployment host

For either role, start with **Configuration → Choose deployment host**:

- **Local Docker Engine:** the node runs on this computer. Bind mounts and signing history use its local Docker Engine.
- **Cloud provider · existing host:** select Hetzner, AWS, Google Cloud, Microsoft Azure, DigitalOcean or Other cloud. Use a prepared Linux host with Node.js 24+, npm, Python 3 and Docker Compose. Enter its SSH hostname or configured alias, user, port, local private-key path and independently verified known_hosts file. Access/VPN/proxy SSH aliases work; agent forwarding is disabled. The console does not purchase or provision provider resources.

**Generate SSH key** creates an Ed25519 key locally and displays only its public key. Install that public key on your prepared host using your provider's normal process. The private key is never uploaded. **Save verified host key** turns an independently verified `ssh-ed25519` host public key into a pinned known_hosts file; it does not silently trust a network scan. Existing key/known_hosts files can be selected instead.

Saving a cloud connection performs a read-only SSH/Node preflight. **Install participant runtime** copies the explicit public kit allowlist, installs locked dependencies without lifecycle scripts, checks Python/Compose, and imports this network invitation. It starts no blockchain node and installs no application frontend. No HTTP control port is opened remotely: subsequent actions run over strict SSH. Node identities and signing history are generated and retained on that host, not copied between hosts. The selected host is bound once installed or an identity exists.

## Public sentry

In **Sentry deployments → Network & identity → Prepare sentry**, enter its public DNS hostname or globally routable IPv4 address. A domain is a DNS-only record pointing to the host's public IPv4. Local deployments also need router forwarding. Allow inbound TCP **26656** (Tendermint P2P) and **26657** (bounded GET-only chain reads and invitation/checkpoint files). Keep raw administrative RPC, SSH administration, databases and internal services private.

The upstream defaults to the verified invitation's public peer. Only an older private invitation needs the optional public peer field or the operator's existing Grph approval. Each sentry has its own identity and no voting power. It always publishes its public P2P/read-only gateway endpoints; an outbound-only private sentry is not offered for new deployments.

## Private validator

In **Validator deployments → Network & identity**, create your identity using your operator wallet's public address and a private passphrase of at least 32 characters. After connecting to a public sentry invitation, **Prepare from invitation** generates the fixed pinned runtime and fills the sentry connection automatically. No network/peer form or controller bundle is required for synchronization. Validators publish **no host ports** and connect outbound to the public sentry's Tendermint address and port. Private signing keys stay on the selected deployment host.

Preparation and startup grant no stake or voting power. Use **On-chain enrollment** with your operator wallet on the imported chain to register/stake and request network admission. Wallet signing and broadcasting remain in your wallet; the console does not sign transactions. The network's normal on-chain registration, sentry approval and validator admission determine voting participation. An invitation without a public peer shows **Waiting for public sentry**; the console does not ask for a local admission-bundle folder. The network must publish a reachable public upstream before direct joining is available. Never use a genesis validator's keys in this console.

## Navigation

The browser console uses React Router with path-based navigation. Workspace pages use `/dev/overview`, `/test/health` and `/prod/settings/credentials`; imported networks use their network ID as the first path segment. Node setup pages use `/dev/validators/<node-id>/<step>` or `/dev/sentries/<node-id>/<step>`. A saved run has its own `/dev/activity/<run-id>` URL. Browser refresh, Back and Forward keep the selected workspace, node, setup step and run. Previous query-based bookmarks redirect to the matching route.

`npm start` builds the browser bundle before launching the local console. Operator kits include the compiled frontend and do not need frontend build tools on node hosts.

## Settings, activity and network health

**Settings** separates network details, the pinned deployment version, individual node hosts and credentials shared across workspaces. Saved provider credentials remain private on this computer; host settings retain only the account ID. SSH keys and host trust are configured separately.

**Activity & logs** keeps persistent job history, newest first, with search, status, type, operation and server filters. Server commands open their selected run immediately and stream command output while running. Select any run to inspect its start and finish times, duration, exit code, server and saved output. Filter log lines, wrap long lines, follow output, or copy and download the loaded log. Server inspection and runtime log retrieval create their own saved runs. Inspection reports host CPU, memory, disk, service status, container resource usage and consensus health. Running commands can be cancelled; cancellation may leave completed changes, so inspect the server before retrying. Delete an individual completed run or clear completed activity for the selected workspace without removing deployed resources. If the console restarts during a run, its history is marked interrupted. Older action records remain available with an explicit notice when output was never recorded.

**Network health → Check now** checks consensus network identity and block freshness, the EVM chain ID, the public invitation and every installed node through local Docker or its configured private SSH route. Unprepared nodes show **Not installed**. Failed nodes retain their own error while other nodes are checked. Observations older than a minute need verification. Automatic checks are optional and run every 30 seconds while this page is visible.

## Review, synchronize and monitor

In **Checkpoint & install**, select **Review deployment**. Check the exact release, services, upstream peer, published ports, target data directory and configuration fingerprint. Startup and restore require a current review; changed connection/runtime files invalidate it.

For fast synchronization, **Use public checkpoint** discovers the current schema 2 signed snapshot at the selected network API’s `/checkpoints/latest.json`. Its publisher fingerprint, manifest and download location are filled automatically using the same trusted HTTPS API as the invitation. Each node checks the snapshot against its own pinned release. Missing, stale, incompatible or invalid snapshots remain unavailable, with a reason shown in the console. Both sentries and validators use the bundled restore helpers. The console checks signature, network/genesis, pinned images, artifact checksums, archives, trie root and consensus anchor before starting with the node's own identity. It requires a fresh node with zero signing history and no existing ledger. On failure, preserve the journal/fence and use **Retry checkpoint restore** with the same selection. Never delete signing history to make a validator appear fresh.

Without a checkpoint, **Start node** replays from genesis and needs an upstream serving that history. The console starts only this reviewed node's containers. **Services & endpoints** and **Network health** expose container status, peer connectivity, block height, catch-up and logs. **Stop node** retains its identity, data and signing history. Sign in to the image registry on the selected host if required. Closing the console leaves services running.

New node data lives under `~/.graphene/participants/<network-id>/instances/<node-id>/<role>/` on the selected host. Existing deployments keep their original `~/.graphene/participants/<network-id>/<role>/` directories. Back up the entire private validator directory while stopped and never run two copies of one signer. `GRAPHENE_PARTICIPANT_DIR` overrides local data storage; `SETUP_PORT` overrides the loopback console port. Cloud host data always stays in its remote user's `~/.graphene/participants` directory. Generated SSH keys and host selections are stored separately for each node under its instance directory; existing deployments keep their original paths.

## Remove a node

Use **Remove node** on a validator or sentry, review the exact files and cloud resources, then enter the displayed `REMOVE <node name>` phrase. Removal stops that node's Compose project and deletes its containers, volumes, identity, signing history, configuration and local node records. Other nodes remain in their own directories and projects. Removal does not unstake funds or submit on-chain transactions; complete any required network exit before deleting a validator identity.

For a cloud node, choose whether its VM is dedicated or shared. Dedicated VM deletion supports **Hetzner, AWS, Google Cloud, Microsoft Azure and DigitalOcean**. Add a named credential for the matching provider in **Settings → Credentials**, then select it when configuring a cloud host or reviewing removal. The host selector lists only credentials for its selected provider, and removal preselects the host’s saved account. Multiple credentials per provider are supported. Credentials stay in the console's private local store and are not uploaded to the node. The account needs permission to inspect and delete the reviewed resources.

The console identifies the VM through its cloud metadata over the pinned SSH connection, checks for other participant nodes and containers, and displays the VM and associated resources before deletion. Depending on the provider, these include exclusive disks, volumes, snapshots, public IPs, network interfaces and eligible dedicated firewalls or security groups. Shared or unowned networking is retained and shown in the review. A shared-host removal deletes only the selected node's remote runtime and local records; it retains the VM and provider resources. Remote cleanup also works with older installed participant runtimes.

Deletion progress is recorded locally. If a provider or SSH operation fails, keep the node record and retry **Remove node** to resume the reviewed removal. Keep the same cloud credential available until cleanup completes. The local record is removed only after remote cleanup and any selected cloud deletion succeed.

Maintainers can run `npm run package:operator-kit` to build the public ZIP, guide, manifest and SHA256SUMS under `dist/operator/`. Only files in `participant/kit-files.json` are included. Build tooling is not required on participant hosts.
