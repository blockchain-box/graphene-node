# Graphene Node

Run and manage Graphene validators and sentries from a local browser dashboard.
The launcher prepares encrypted node identities, discovers nodes registered to a
wallet, reviews wallet actions, and controls nodes on this computer or connected
servers. Setup instructions are built into the launcher.

This release supports the **Graphene development network, chain ID 9876**. A node
host needs the matching provider-prepared Docker stack and a trusted checkpoint.
Cloning this repository does not provision a production server or start a new
blockchain network.

## Contents

- [Get started](#get-started)
- [Graphene operator guide](#graphene-operator-guide)
- [Signed local checkpoint bootstrap](#signed-local-checkpoint-bootstrap)
- [Software updates](#software-updates)
- [Graphene launcher overview](#graphene-launcher-overview)
- [Providing the operator software](#providing-the-operator-software)
- [Validator agent reference](#validator-agent-reference)
- [Sentry agent reference](#sentry-agent-reference)
- [Commands and documentation](#commands-and-documentation)
- [Repository layout and maintenance](#repository-layout-and-maintenance)

## Get started

You need Node.js **24 LTS**, npm, and a compatible browser wallet such as MetaMask.
To run node services, the node host also needs Docker Engine with Compose or
Docker, persistent storage, the matching development images, and the
provider's checkpoint trust configuration.

Clone the source and install its dependencies:

```sh
git clone https://github.com/blockchain-box/graphene-node.git
cd graphene-node
npm ci
npm run doctor
```

Resolve any `ACTION NEEDED` items with your provider before starting a node.
The checker reports prerequisites; it does not install software or change chain
data. If this computer only manages nodes on other hosts, use
`npm run doctor -- --identity-only` for the Node.js check. Docker and chain services
are required on the actual node hosts.

Choose a launcher:

| Role | Command | Default local address |
| --- | --- | --- |
| Validator: stake GRPH, check blocks and vote | `npm run join` | `http://127.0.0.1:8787` |
| Sentry: connect validators and review requests | `npm run join:sentry` | `http://127.0.0.1:8788` |

Open the **complete private link printed in the terminal**, including its
`#` access code. On macOS you can also open `Join Graphene.command` or
`Join Graphene Sentry.command`; Windows has matching `.cmd` files. Run them from
the same extracted source folder after installing dependencies.

In the dashboard:

1. Open **Help** and choose your role and computer/server location.
2. Choose **Setup** or **Set up a node**, select the role and location, name it, and choose a password of at least
   12 characters. A sentry also needs the reachable hostname and port from its provider.
3. Connect the owner wallet. Register a validator with its GRPH stake, or register
   a sentry with its country code and validator capacity. Review and approve in
   the wallet, then wait for network confirmation.
4. Validators request a sentry connection. Sentry operators approve or decline
   incoming validator requests. Both roles can review and revoke their assignments.
5. Check **Fund the agent** in the node drawer. Validator agents need native GRPH
   for publication fees when gas prices are nonzero. A zero gas price needs no
   publication-fee top-up; sentry agents currently submit no automatic transactions.
6. Once the host and trusted checkpoint are ready, unlock the selected node and
   choose **Start node**. Check synchronization, agent health and verified peer
   connections. Registration and connection approval do not prove that a node is online.

Each validator needs its own owner wallet account. Sentries relay traffic and do
not vote on blocks. Wallet approvals remain in the wallet; node private keys stay
on the node host. The explorer is optional and does not control node services.

## Review validator requests as a sentry owner

Connect the wallet registered as the sentry operator. **Overview → Validator join
requests** automatically lists pending requests for its sentries on the selected
network source. Check the validator address, target sentry, and request ID, then
choose **Review approval** or **Review decline**. The launcher rechecks ownership
and pending status before requesting wallet approval. A public lookup of another
wallet cannot authorize actions, and node private keys are not needed for these
wallet actions. Approval allows a connection; verify the live peer handshake.

Use **Connect wallet** in the layout header. Select a node in either table to open
its details in the right-hand drawer. Tabs separate **Node** identity (including
Tendermint addresses), **Connections**, **Agent**, validator **Staking**, and
**Doctor**. Review connections opens its tab directly. **Run Doctor** executes
only the bundled read-only host checks; it never accepts a command from the browser. The
drawer scrolls independently; click outside, close it, or press Escape to return to the same
place in Overview. On mobile, node details use the full screen.

## Find and reopen existing nodes

Connect your wallet, or enter an address under **Nodes in your wallet**
and select **Find my nodes**. Choose a connected host as the network source. The
launcher lists its registered validator and all owned sentries, including inactive
sentries. Public registrations can be viewed without local node keys; wallet
actions require the owner account.

Live status and start/stop controls require the original node host and encrypted
identity. Choose **Open saved identity** to load public identity fields from the
registration, then select the host holding the saved keys and enter the original
password. A public setup JSON can also reopen an existing identity. Neither route
creates replacement private keys.

New profiles live in `secrets/node-profiles/<id>/`. Node data and signing history
live in `secrets/runtime/grph-node-<agent-address>/`. Existing root-level
`secrets/keystore.enc` and `secrets/sentry-secrets.json` identities remain supported.
Continue using the same secrets directory when reopening or upgrading.

**Recover from a checkpoint → Reset from checkpoint & start** replaces a stopped
node’s chain data from the latest verified publication, keeps a data backup, and
preserves identity and signing history. Validators require a checkpoint at or
above their last signed height. See [Signed local checkpoint bootstrap](#signed-local-checkpoint-bootstrap).

**Stop node** refreshes validator downtime impact before confirmation. The Node
and Staking tabs show participation and projected effective-weight reductions.
Current downtime rules deduct no GRPH from stake; missed votes reduce voting and
reward weight. Exact reward loss depends on future chain activity. Validator exit
and confirmed consensus removal are still required before stopping.

**Stop node** preserves chain data and signing history. **Lock controls** discards
the dashboard's decrypted identity while Docker services continue running.
Closing the browser or launcher also leaves those Docker services running. Back
up encrypted identities and runtime/signing state together; never run two live
copies of a validator signer or delete signing state to recover a stuck node.

## Manage a remote server

Run the launcher on the node server and choose **Share this server**. On a server
without a desktop, enable sharing when launching:

```sh
GRAPHENE_P2P_SHARE=1 npm run join
# For a sentry host: GRAPHENE_P2P_SHARE=1 npm run join:sentry
```

In the launcher on your own computer, choose **Connect a server**, name the host,
and paste its private `grph://...#...` link. Keep both launchers running and allow
UDP/DHT connectivity. Remote management uses encrypted Grph P2P tunnels.
Access codes stay in memory, so reconnect after restarting the central launcher.
A node can remain running while its launcher or tunnel is unavailable.

## Checkpoints and provider preparation

Open **Checkpoints** in the launcher’s overview and choose the computer or
connected server that will run the operation. **Enroll a checkpoint provider**
accepts its public enrollment URL, independently approved publisher fingerprint
and canonical genesis hash. The selected host verifies a fresh signed checkpoint
before installing trust for its nodes. Existing enrollment is preserved.

On a host with the full provider checkout, connect your owner wallet and choose
a **Source node from your wallet**. **Create & verify checkpoint** captures that
node's managed stack, briefly pauses/resumes its writers, and performs the
isolated restore test. Only unlocked, synchronized nodes with zero voting power
are eligible. Sentries with active validator assignments can be used after an
explicit interruption warning: capture pauses the sentry and temporarily interrupts
its validator connections, which may affect network access and voting. The host
rechecks assignments and requires a separate acknowledgment before capture.
Unknown assignments and voting nodes remain blocked. The launcher never falls back to the voting bootstrap for this
operation. Confirm the selected node's pause in the launcher. Creation runs in
the background with progress in this panel; keep the host’s launcher running.
It generates the private publisher key once on that host when needed, reuses
unchanged checkpoint content, and shows the public URL, fingerprint and genesis
pin after success. Files are published locally; transfer to a separate public
checkpoint host remains manual. The operator kit supports enrollment; creation
requires the provider checkout and verifier.

Launcher creation stores public publisher details in
`.checkpoints/publisher-trust.json`, separately from receiver enrollment in
`.checkpoints/trust.json`. It never replaces the selected host’s enrolled provider.
For a separate read-only checkpoint host, use the creator’s public
`publisher-trust.json` as that host’s trust configuration, alongside the complete
publication tree.
Publication storage, publisher key location (`GRAPHENE_CHECKPOINT_KEY`) and
receiver trust path are host configuration; browser requests cannot choose them.
Restart an older launcher backend to load these controls.

Ask your provider for its approved public trust JSON and independently verify its
publisher fingerprint. Put it at `.checkpoints/trust.json` on the node host, or
set `GRAPHENE_CHECKPOINT_TRUST` to its absolute path before launching. A fresh,
unsigned node can download and restore a compatible checkpoint automatically on
**Start node**. Existing data and signing history are never overwritten by that flow.

The provider publisher CLI is part of the full source checkout:

```sh
npm run checkpoint -- keygen  # Once; keep the publisher private key private
npm run checkpoint -- export --url grph://HOST_KEY/checkpoints/latest.json  # First export
npm run checkpoint -- export  # Later exports reuse the saved publisher URL
```

Use the public URL printed by the dedicated checkpoint host or derived from an
already-shared provider launcher. `HOST_KEY` is that host’s public Grph key, without
the private launcher access code. Creating a checkpoint in the launcher generates
the publisher key automatically. CLI creation requires the one-time `keygen` step.
Both creation paths save public publisher configuration in
`.checkpoints/publisher-trust.json` and preserve receiver enrollment. The CLI reads
`--url` first, then saved publisher configuration, then legacy receiver trust as a
compatibility fallback. `--publisher-trust FILE` selects another publisher file.

**First Start node** and **Recover from a checkpoint** open a source-selection
dialog. It lists enrolled providers and published checkpoints from nodes owned by
the connected wallet on connected hosts. Node choices show their name, host,
checkpoint height, timestamp, publisher fingerprint and genesis pin. Nodes with
no fresh published checkpoint and checkpoints from another network are disabled.
Choose a source explicitly; canceling leaves node data untouched. Ordinary
restart resumes existing data without selecting or restoring a checkpoint.

Wallet-node checkpoints use immutable manifest URLs and signed source-node
identities, so publishing another node's snapshot cannot silently change a
selection. The target host verifies and stores each selected source separately
under its private `providers/` trust directory. Global receiver enrollment stays
unchanged. Existing-node recovery still requires a stopped node and a checkpoint
at or above its signing height; all archive, signature, genesis and image checks
remain enforced. CLI `export` without a managed source retains the legacy bootstrap
capture behavior; use launcher wallet-node capture to avoid pausing a voting node.

Exports automatically reuse unchanged database entries from the last compatible
publication. Writers resume after an uncompressed capture; only new or changed
entries are compressed afterward. The signed manifest records the previous
checkpoint and pins a complete archive index. Removed files are omitted from that
index. The first export after upgrading an archive-only publisher creates a new
base; later exports reuse it. Use `npm run checkpoint -- export --full` to start a
new base deliberately, including after changing publisher trust.

The publisher stores compressed entries once under
`.checkpoints/publication/objects/`. Updated receivers retain verified entries
in their checkpoint cache and download only missing content. A fresh receiver
downloads all entries listed by the latest index directly; it does not need old
manifests or a chain of delta restores. Every reconstructed archive must match its
signed full hash and pass the existing archive and restore checks. Database
compaction can replace files, so savings depend on how much content is unchanged.

Restart the provider launcher from the updated checkout before publishing this
format. It serves the index and shared objects, and streams complete resumable
archive downloads for older receivers. Serve and back up the **whole publication
tree**, including `objects/`; a checkpoint directory by itself is incomplete.
Keep any objects referenced by retained checkpoint indexes. Automatic object
garbage collection is not implemented; failed verification can leave unreferenced
objects, while the previous `latest.json` stays unchanged. The `publish` and
`verify` commands accept checkpoint directories in this shared publication tree.
Capturing, hashing and restore verification still inspect the full snapshot, and
temporary export/restore storage must accommodate uncompressed data.

Export briefly stops and resumes bootstrap writers and publishes only after an
isolated restore and canonical catch-up test. The default publication directory
is `.checkpoints/publication/`, served by the provider launcher at `/checkpoints/`.
Remote checkpoint URLs use the provider's public Grph P2P key without its launcher
access code. See [Signed local checkpoint bootstrap](#signed-local-checkpoint-bootstrap) before publishing or restoring.

### Public read-only checkpoint hosting

Run the dedicated checkpoint host on an always-on machine. It exposes only
allowlisted checkpoint downloads, public enrollment JSON and a health check over
Grph P2P. It has no node-manager, wallet, upload, deletion or signing endpoints.
The HTTP listener binds to loopback; do not expose that listener to the Internet.
The host needs Node.js and the reviewed release's dependencies, plus the public
publication tree and public publisher trust JSON. It does not need Docker, a
validator identity, or the publisher's private signing key.

The public location is `grph://HOST_KEY/checkpoints/latest.json`. Its Grph identity
is separate from the publisher signing identity and the node-manager identity.
Back up the host's private transport seed outside the publication tree: keeping
that file preserves the public location across restarts. The host checks the
latest manifest's signature, network, freshness and restore attestation against
its installed trust configuration; an expired or invalid latest manifest returns
503. Downloads are limited to eight concurrent requests by default. Each joining
validator still enforces its own pinned trust, file hashes and restore checks.

For a Linux host with systemd, install reviewed application source and dependencies
at `/opt/graphene-node`, with `/usr/bin/node` pointing to the supported Node.js
runtime. Create a dedicated account with no login shell and no Docker membership:

```sh
sudo useradd --system --user-group --home-dir /var/lib/graphene-checkpoints --shell /usr/sbin/nologin graphene-checkpoints
sudo install -d -o root -g root -m 0755 /srv/graphene-checkpoints/publication /etc/graphene-checkpoints
sudo install -d -o graphene-checkpoints -g graphene-checkpoints -m 0700 /var/lib/graphene-checkpoints
```

Generate the hosting identity before the first publication, without starting any
node or network service:

```sh
sudo -u graphene-checkpoints /usr/bin/node /opt/graphene-node/scripts/checkpoint-host.js identity \
  --publication /srv/graphene-checkpoints/publication \
  --identity /var/lib/graphene-checkpoints/p2p.json
```

Use the printed `manifestURL` as `--url` when exporting on the publisher. Transfer
only the sanitized publication tree and approved public trust JSON to the host.
Place the tree under `/srv/graphene-checkpoints/publication/` and the trust JSON at
`/etc/graphene-checkpoints/trust.json`. Keep them administrator-owned, readable
but not writable by the service account. Copy shared objects and immutable
checkpoint directories first; atomically replace `latest.json` only after all
referenced content is present. Never copy publisher keys, wallets or live node
directories to this host.

Install the supplied service, which mounts the publication and application paths
read-only and allows persistent writes only to the transport identity directory:

```sh
sudo install -m 0644 /opt/graphene-node/deploy/checkpoint-host/graphene-checkpoints.service /etc/systemd/system/graphene-checkpoints.service
sudo systemctl daemon-reload
sudo systemctl enable --now graphene-checkpoints
sudo journalctl -u graphene-checkpoints -n 30 --no-pager
```

If using a private DHT bootstrap, set `GRAPHENE_DHT_BOOTSTRAP=host:port,...` in
`/etc/graphene-checkpoints/host.env`. Allow the tested Grph UDP/DHT connectivity
through the host's firewall. Keep administrative access restricted. Validate the
public URL from a separate machine before sharing it. Service confinement follows
[systemd's execution sandbox settings](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).
The unit is a deployment template and must be checked on the chosen Linux host.

For joining validators, distribute the host URL, publisher SHA-256 fingerprint and
canonical genesis hash through an independent authenticated channel. The host's
public `/checkpoints/enrollment.json` endpoint alone is not a source of trust.
The full source and updated operator kit provide a pinned enrollment command:

```sh
npm run checkpoint:enroll -- \
  --url grph://HOST_KEY/checkpoints/enrollment.json \
  --fingerprint APPROVED_PUBLISHER_SHA256 \
  --genesis APPROVED_CANONICAL_GENESIS_HASH
npm run doctor
```

Enrollment checks those independent pins and a fresh signed latest manifest
before creating `.checkpoints/trust.json`. It refuses to overwrite existing trust
and keeps the validator's default 24-hour freshness policy. Then start the fresh
node normally. Hosting does not change the current fixed development network's
genesis/image compatibility requirements or implement public testnet provisioning.
Checkpoint scheduling and uploads remain manual; this service adds no cron job.

## Software updates

The first implementation discovers, verifies, downloads, stages and optionally
shares software through Grph P2P. Both validator and sentry agents support it.
It does **not** stop services, import images, run migrations or activate releases.
The staged journal always reports `activationSupported: false`, including for a
release classified as a consensus upgrade.

No updater configuration means existing node behavior is unchanged. A malformed
configuration disables staging and logs the reason; it does not stop the node.


[Configure a trusted profile](#configuration-boundaries), [enable agent staging](#run-under-a-node-agent), or [inspect and stage an update manually](#inspect-or-stage-on-any-host). Release publishers and maintainers can use the [publishing instructions](#publisher-and-seed) and [isolated staging test](#run-the-complete-cli-staging-pipeline-locally).

### Configuration boundaries

A host location (this computer or a server) is separate from a network
(local/test/prod), a release channel (dev/candidate/stable) and a future rollout
ring. The staging CLI can use any installed trusted network profile, at either
location. The current launcher still provisions development chain 9876 only;
using a production update profile does not provision a production node.

Profiles are trusted local operator configuration, not data accepted from update
peers. Install them through the same trusted process as genesis/checkpoint trust.
They contain public verification keys only. Never put a publisher private key,
validator identity, launcher token or keystore password in an update profile.
Profile signing/distribution, automated root rotation and consensus activation
authorization are later implementation steps.

Required JSON shape (replace all placeholders with the actual deployment values):

```json
{
  "format": 1,
  "kind": "graphene-update-profile",
  "networkId": "your-network-id",
  "environment": "local",
  "tendermintChainId": "YOUR_ACTUAL_TENDERMINT_CHAIN_ID",
  "chainId": 9876,
  "genesisHash": "YOUR_CANONICAL_GENESIS_SHA256",
  "channel": "dev",
  "role": "validator",
  "target": { "os": "linux", "arch": "arm64" },
  "currentVersion": "1.0.0",
  "seeds": ["YOUR_GRPH_UPDATE_SEED_PUBLIC_KEY"],
  "keys": {
    "release": { "release-1": "YOUR_ED25519_PUBLIC_KEY_PEM" },
    "channel": { "channel-1": "YOUR_CHANNEL_ED25519_PUBLIC_KEY_PEM" }
  },
  "maxArtifactBytes": 8589934592,
  "maxCacheBytes": 34359738368,
  "bytesPerSecond": 1048576,
  "pollIntervalMs": 60000
}
```

`environment` is `local`, `test` or `prod`. Production requires `stable`;
test disallows `dev`. No environment accepts unsigned metadata. The genesis hash
uses the same canonical genesis hashing as checkpoints, not the hash of the raw
JSON file. Chain identifiers and genesis must be actual network values; this
document does not assign testnet/mainnet identifiers.

The target OS/architecture refers to the container artifacts, so a macOS host
running Linux ARM containers uses `linux`/`arm64`. Artifact selection also matches
the configured validator/sentry role. `currentVersion` must describe the installed
release; staging validates it against the release's exact `compatibleFrom` list.
This is a preflight check, not attestation of running container versions.

Update state is separated by a hash of the full network identity, channel, role
and target architecture below the selected directory. This does not move or
rename existing Tendermint directories or Docker volumes. Full multi-network
node enrollment and runtime namespace migration remain separate planned work.

### Run under a node agent

Set trusted host environment configuration before starting either agent:

```sh
export GRAPHENE_UPDATE_PROFILE=/absolute/path/to/update-profile.json
export GRAPHENE_UPDATE_DIRECTORY=/absolute/path/to/persistent/update-state
# Optional: advertise the verified cache through a separate Grph identity.
export GRAPHENE_UPDATE_SERVE=1
```

The agent immediately starts staging independently of assignment/chain RPC and
then polls at the configured interval. Update status appears in the agent's
`/status` response under `details.updates`, including its public distribution key
when serving is enabled. It has no management methods or launcher bearer token.
The publisher must distribute that public key as a trusted seed configuration.

For launcher-managed local development nodes, set `GRAPHENE_UPDATE_PROFILE` on
the launcher process. On Start, it validates the profile against that node's
genesis and role, records `update-network.json`, and mounts a public profile
snapshot and persistent update directory into the agent container. Existing DB
passwords, secrets, signing history, volumes and runtime paths are retained.
Rebinding the same node to another update network is refused. Use a separate
role-specific launcher configuration/runtime factory for different role profiles.
The local launcher does not currently enable re-sharing automatically.

Staging persists while the agent container runs; closing the browser does not
stop that container. Desktop sleep, Docker shutdown or host reboot can interrupt
it. Persistent host supervision and secure unattended credential unlock are not
implemented here. After an abrupt crash, a leftover `worker.lock` requires an
operator to establish that no worker still owns that cache before removing only
that lock and restarting. Do not remove the replay journal to bypass a failure.

### Inspect or stage on any host

```sh
npm run update -- status \
  --profile /absolute/path/to/update-profile.json \
  --directory /absolute/path/to/update-state

npm run update -- stage \
  --profile /absolute/path/to/update-profile.json \
  --directory /absolute/path/to/update-state
```

Connections use Grph proxies bound to loopback; there is no direct HTTP/registry
fallback. Seed public keys are the initial discovery mechanism. General peer
exchange is not yet implemented. Downloads have bounded requests, connection
counts, metadata and cache sizes, and configured bandwidth limits. Bad transfer
peers are skipped for the remainder of that polling round.

Read requests retry transient Grph connection failures up to three attempts with
bounded backoff. HTTP rejections and signature/integrity failures are not retried
as transport failures.

Chunks are checked against signed hashes, saved separately, rechecked on resume,
and assembled only after all are verified. The completed artifact must match its
signed whole-file hash. A newer or same-sequence conflicting channel cannot
overwrite the accepted replay high-water mark. Expired channel metadata cannot
stage a new release; previously staged files are retained without activation.

Budget disk/cache for retained artifacts plus chunks and assembly (approximately
twice an in-progress artifact, in addition to prior retained releases). Cache
exhaustion fails staging safely. Automatic garbage collection is pending: stop
the worker before removing obsolete artifact/chunk files, preserve `state.json`
and current metadata, and never touch node signing history or chain volumes.

New configuration is disabled by default. Upgrade activation, system service
installation, on-chain H/H+1 enforcement, recovery orchestration, binary deltas
and launcher update controls remain in the implementation plan.

### Publisher and seed

Release and channel keys are separate Ed25519 signing roles. Their public keys
must already exist in the profile. Keep private key files on the release host,
outside the operator kit, node containers and Git.

Prepare a descriptor, with artifact paths relative to the descriptor file:

```json
{
  "releaseId": "1.1.0",
  "classification": "compatible",
  "compatibleFrom": ["1.0.0"],
  "artifacts": [
    {
      "file": "blockchain-linux-arm64.tar",
      "component": "blockchain",
      "role": "all",
      "os": "linux",
      "arch": "arm64"
    }
  ]
}
```

Classification is `compatible` or `consensus`. A consensus classification never
authorizes activation. The publisher computes signed chunk hashes and complete
artifact hashes, rechecks copied bytes, then commits channel metadata. It does
not build Docker images; supply reviewed archives through the release workflow.
Image identity/compatibility verification at activation remains future work.

```sh
npm run update -- publish \
  --profile /absolute/path/to/update-profile.json \
  --directory /absolute/path/to/seed-state \
  --descriptor /absolute/path/to/release.json \
  --release-key /absolute/path/to/release-private.pem --release-key-id release-1 \
  --channel-key /absolute/path/to/channel-private.pem --channel-key-id channel-1 \
  --sequence 1 --expires 2026-11-07T12:00:00Z

npm run update -- serve \
  --profile /absolute/path/to/update-profile.json \
  --directory /absolute/path/to/seed-state
```

Use a future expiry when publishing. Channel validity is bounded to seven days;
renewal requires a new sequence. The serve command prints a public Grph key.
For initial seed setup, provision its `update-p2p.json` identity in the
network/channel/target cache directory before serving, then pin its public key in
receiver profiles. Receivers never learn trust keys from the seed.

Production promotion uses the same source descriptor and unchanged bytes, but a
production profile and separately authorized channel key. The immutable release
hash excludes channel/environment metadata, so qualifying and promoting the same
bytes does not require rebuilding. Automatic CI publication and promotion gates
have not yet been added to graphene-orchestrator.

### Run the complete CLI staging pipeline locally

From the graphene-node directory:

```sh
npm run test:update:e2e
```

This runs separate publisher, Grph seed and receiver CLI processes against a
private local DHT, with fresh fixture signing keys and an isolated artifact. It
prints eight PASS steps and a path to `report.json`:

1. Publish and sign release v1 through the actual publisher CLI.
2. Start current and stale seed services as independent Grph processes.
3. Interrupt a real receiver after it saves verified chunks.
4. Restart the receiver, resume and check the complete artifact hash.
5. Stage the release for a separate sentry receiver.
6. Publish v2 and verify the validator receiver discovers and stages it.
7. Reject the older correctly signed v1 metadata from the stale seed.
8. Reject a receiver with a different pinned network identity.

The receiver CLI uses the same update worker used by node agents. This exercise
does not start the validator/sentry chain monitors, a browser or a Docker node.
The source is fixture bytes, not an installable blockchain release. Its endpoint
is verified staging; automatic installation and consensus activation are pending.

To exercise the other channel policies, repeat with fixture environments:

```sh
npm run test:update:e2e -- --environment test
npm run test:update:e2e -- --environment prod
```

These select candidate/stable metadata inside isolated local fixtures; they do
not connect to a deployed testnet or mainnet, or assign real public-network IDs.
Only the container artifact target label is ARM64: no container is executed, so
this exercise also works on an x64 host with the project's dependencies installed.

Each run retains its own directory in the OS temporary directory, including the
report, individual process logs, public profiles, fixture-only private signing
keys, signed metadata and staged artifacts. Services shut down at the end.
To retain results in a chosen location, use a new or empty directory:

```sh
npm run test:update:e2e -- --directory /absolute/path/to/new-e2e-run
```

Use `receiverProfile` and `receiverDirectory` in the report to inspect the
persisted result with the regular CLI even after services have shut down:

```sh
npm run update -- status --profile PROFILE_FROM_REPORT --directory RECEIVER_DIRECTORY_FROM_REPORT
```

A successful final status is `phase: staged`, `sequence: 2`, `releaseId: 1.2.0`
and `activationSupported: false`. Expected rejection logs live alongside the
successful process logs. Existing node configuration, identities and data are
never used by this runner.

## Commands and documentation

| Command | Purpose |
| --- | --- |
| `npm run join` / `npm run join:sentry` | Open the node manager |
| `npm run doctor` | Check node-host prerequisites without changing them |
| `npm test` | Run launcher, identity, wallet, transport and checkpoint tests |
| `npm run test:checkpoint` | Run checkpoint unit tests |
| `npm run checkpoint -- …` | Provider checkpoint key generation, export, publish and verification |
| `npm run package:operator-kit` | Build the source kit, offline guide, manifest and checksums in `dist/operator/` |
| `npm run package:explorer` | Build the sibling `grph-explorer` checkout and refresh its packaged static assets |

Docker integration tests are skipped by default. Maintainers with the required
development images can opt in with `GRAPHENE_DOCKER_TEST=1 npm test`; these tests
use isolated test identities, containers and volumes.

- [Operator guide](#graphene-operator-guide): detailed validator/sentry setup and recovery.
- [Checkpoint reference](#signed-local-checkpoint-bootstrap): trust, verification and publication.
- [Operator distribution](#providing-the-operator-software): source-kit contents and release workflow.
- [Launcher overview](#graphene-launcher-overview): entry points and retained maintenance tools.

The packaged source kit contains the launcher, agents and bundled network
libraries. It excludes private identities, node data and publisher keys. Commands
for tests, checkpoint publication, the SDK and deployment maintenance refer to
the full source checkout, not the smaller operator kit.

## Graphene operator guide

This kit prepares validator and sentry identities and controls nodes on the
Graphene local development profile (chain ID 9876). It is a source kit, not a
signed installer or a production hosted-node provisioner. The node launcher includes
the interactive guide at `/operator/guide`, for both validator and sentry roles.
The explorer has no operator routes, setup guide or launcher downloads.

### Hardware requirements

These requirements apply to the machine running the node. A computer used only
to manage remote nodes does not need the blockchain stack or its storage.

**No benchmarked Graphene minimums yet.** This development release has no
validated minimum CPU count, RAM size, disk capacity or bandwidth. Obtain sizing
from your provider for the current checkpoint and expected workload before
choosing hardware. Doctor checks prerequisites, not performance or capacity.

Both validators and sentries run Tendermint, the blockchain application,
PostgreSQL, the trie database, connection tunnels and an agent. Sentries do not
vote, but still run the full local stack. More connections increase demand.

- **CPU:** every provider-supplied Docker image must support the host processor
  architecture. Confirm the CPU allocation available to Docker and leave capacity
  for restoration, catch-up and other applications. CPU count alone is not a
  performance guarantee.
- **RAM:** budget for the entire stack, operating system and Docker virtual
  machine where used. Avoid sustained memory pressure, growing swap demand and
  out-of-memory failures. Installed RAM is not Docker's available memory.
- **Storage:** prefer persistent SSD storage. Budget for images, checkpoint
  archives, extracted databases, temporary restoration files, logs and chain
  growth. Ask the provider for current download and restored sizes. Check free
  space on Docker's actual data disk as well as the launcher filesystem.
- **Network:** provide stable connectivity and UDP/DHT access for Grph P2P,
  plus the provider-confirmed sentry endpoint when applicable. Budget for
  checkpoint downloads, catch-up and all validator connections.
- **Availability:** keep the host powered, awake and online. Preserve persistent
  Docker volumes, identities, chain data and signing history across restarts.

In Docker Desktop, check Settings → Resources for CPU, memory and disk limits.
Leave capacity for the host operating system and other applications. Docker's
Mac installation requirement of at least 4 GB RAM is not a Graphene node minimum.
Official resource settings: https://docs.docker.com/desktop/settings-and-maintenance/settings/
Mac installation requirements: https://docs.docker.com/desktop/setup/install/mac-install/

Use the node drawer's **Monitor** tab while restoring, catching up and operating.
It shows whole-machine usage; Docker volumes may live on another disk. RAM used
includes cached or reclaimable memory. On macOS, also inspect Memory Pressure
and Swap Used in Activity Monitor. For multiple nodes, budget for each separate
stack and its data, then observe resource demand before adding more nodes or
increasing sentry connection capacity.

### What does the agent do?

The agent is a background service that manages node connections. Start node
launches the agent alongside Tendermint, the blockchain application and storage.
Keep these services running in Docker; closing the explorer or launcher does
not stop them.

- **Validator agent:** watches approved sentry assignments, runs the Grph
  connection endpoint, encrypts and publishes connection details for the assigned
  sentry using its dedicated agent account, and reports connection health.
- **Sentry agent:** watches active assignments, decrypts validator connection
  details, opens Grph tunnels to relay Tendermint P2P traffic, verifies peer
  connections, removes revoked connections, and reports health.

The owner wallet approves registration, stake operations and sentry applications.
The validator's agent account is separate from that wallet; stake does not fund
it. It may need GRPH for transaction fees when gas prices are nonzero.
Tendermint signs consensus votes. Agent uptime or a connected tunnel does not
prove accepted votes or reward eligibility. Sentries relay traffic and do not vote.

Each role's public setup JSON includes `agentRole` and `fieldDescriptions`.
These describe every registration field, including the distinction between the
agent account, X25519 encryption key, Tendermint peer identity, validator
consensus and Grph transport keys, and sentry network endpoint. The launcher
ignores explanatory metadata when importing; older setup files still work.
Private keys and signing state stay on the node host.

#### Fund the agent and understand its transactions

Select a node in Overview and open **Fund the agent** in its right-hand drawer.
The launcher reads the public agent address, its native GRPH balance and the
current gas price. A validator agent publishes encrypted connection details once
for each newly approved sentry assignment. Its fee budget uses the estimated gas
limit plus 20%, multiplied by the current gas price. No universal GRPH top-up
amount applies; a zero gas price needs no publication-fee top-up.

A normal connection uses three successful transactions: validator owner request,
sentry owner approval, and validator agent publication. Registration and optional
funding are separate transactions. Polling, health checks, tunnels and consensus
votes do not create an agent transaction for every block. Pending publications are
checked by their existing transaction hash. The sentry agent currently reads chain
state and manages tunnels without automatic blockchain writes; its owner pays
approval/decline fees in the owner wallet.

Enter an amount and choose **Review agent funding** to review a native GRPH
transfer from the owner wallet to the public agent address. Check the recipient
and same Graphene network in your wallet before approving. Stake does not fund
the agent, and the agent does not control the owner wallet or consensus keys.

An unlocked node reporting **bad public key size** has reached a malformed peer
encryption key, rather than a password failure. The registered sentry key must be
32-byte X25519 hex (64 characters, optionally prefixed by `0x`). Its owner/provider
must correct that public registration or offer a valid sentry. Preserve existing
identities and signing state; funding or regenerating the validator does not fix
another node's registered encryption key.

### 1. Get your computer ready

Install Node.js 24 LTS from https://nodejs.org/en/download/ and Docker
from https://docs.docker.com/get-started/get-docker/. Start Docker.
On a Linux server, use Docker Engine and its Compose plugin instead:
https://docs.docker.com/engine/install/.

Install MetaMask in the browser on your own computer using
https://metamask.io/download/. Your wallet approves registration. Do not install
or import your wallet into the node server.

Obtain the operator kit and SHA256SUMS from the same trusted node software release.
Maintainers build these artifacts in `graphene-node/dist/operator/`.
Compare the archive checksum before extracting:

macOS: `shasum -a 256 graphene-operator-kit.zip`
Linux: `sha256sum graphene-operator-kit.zip`
Windows PowerShell: `Get-FileHash .\graphene-operator-kit.zip -Algorithm SHA256`

Checksums detect changed bytes; use a trusted release source for authenticity.
Extract the kit, open a terminal inside its `graphene-operator-kit` folder, then:

```sh
npm ci
npm run doctor
```

If a check says ACTION NEEDED, complete it with your node provider before Start
node. The kit includes the launcher and agent source, not the blockchain images,
chain data, wallet, Node.js, or Docker. Persistent disk, uptime and server sizing
must be agreed with your provider; production minimums have not been benchmarked.

### 2. Prepare the development network (provider)

On the node's Docker host, prepare matching local chain images and a bootstrap
container named `tendermint-dev` on its Compose-managed `graphene-net-dev` network.
Start controls discover the actual project name, including `graphene-quarkus`
and `graphene-local`. From the full
Graphene workspace, the provider can build the stack with:

```sh
# Create the bootstrap stack's retained local secret once.
test -e graphene-quarkus/.env || (umask 077; printf 'MPT_DB_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > graphene-quarkus/.env)
docker compose -p graphene-local -f graphene-quarkus/docker-compose.yml up -d --build
```

The launcher generates a separate random MPT API token for each node and retains
it in that node's private Compose profile across restarts. Existing profiles gain
the shared MPT/ABCI token on their next start.

This is a developer/provider command; the source kit does not contain the
Quarkus blockchain repository. Confirm ready APIs and advancing blocks first.
The current existing development chain contains a historical malformed header
at height 3303. Provision joining nodes from a consistent trusted checkpoint,
preserving their own keys and signing state. Genesis replay alone cannot cross
that header. Do not reset signing state or bypass application-hash validation.
The provider creates a signed checkpoint with `npm run checkpoint -- export`
from the full graphene-node source and pins the publisher public key for each
operator. The kit then downloads and installs it automatically on a fresh node.
An earlier sanitized checkpoint can be published with `npm run checkpoint --
publish --directory /private/previous-checkpoint` when the live chain has lost
quorum. See [Signed local checkpoint bootstrap](#signed-local-checkpoint-bootstrap) for format, verification and trusted enrollment.

### 3. Open the node manager and add nodes

Open **Join Graphene.command** on macOS, **Join Graphene.cmd** on Windows, or run
`npm run join`. Open the complete private URL printed in its terminal. Keep that
terminal open while using the manager. The launcher now opens **Your nodes**;
you can register and operate nodes here without opening the explorer.

Choose **Add node → New node**, select a location and role, name the node, and
choose a password of at least 12 characters. Sentries also need the reachable
hostname and network port supplied by their provider. Each new node has its own
encrypted identity in `secrets/node-profiles/<profile-id>/` and its own persistent
Docker project and signing state under `secrets/runtime/grph-node-<agent-address>/`.
Keep using the same launcher folder. Back up the encrypted identity, catalog,
runtime and signing state together; never run two copies of one validator signer.

To reopen a saved node, select it and choose **Unlock node**. Use **Add node →
Open a saved node** for an existing public setup file; its private identity must
already be on the selected host. Import never generates replacement signing keys.
Older `secrets/keystore.enc` and `secrets/sentry-secrets.json` identities appear as
existing nodes. Import their original public setup JSON to identify them.

### 4. Register, connect and operate from the launcher

1. Select a node and **Connect wallet**. Install MetaMask or use a compatible
   wallet browser. Approvals stay in the wallet; the manager never imports wallet
   keys. Select Graphene development chain 9876. Registration checks the network
   used by the selected host against the wallet before submitting a transaction.
2. For a validator, enter the GRPH stake and choose **Review registration**.
   Each validator requires its own owner wallet account. For a sentry, enter
   the two-letter country code and validator capacity. Review the node, wallet,
   amount and network, then choose **Approve in wallet**. Wait for confirmation;
   a submitted or failed transaction is not treated as a successful registration.
3. Validators choose a sentry under **Sentry connections** and review a request.
   Sentry operators select their node and approve or decline pending requests in
   their wallet. Validators can cancel pending requests; both roles can revoke
   the connections they own. These actions require confirmed wallet transactions.
4. Once the provider has configured matching Docker images and pinned a trusted
   checkpoint, choose **Start node** in the selected node's controls. Watch live
   state, checkpoint progress, block height, peers and agent health. On a registered
   validator, **Staking** offers additional stake, unstaking, reward claims and
   exiting stake. Review each action and approve it in the owner wallet.
5. **Stop node** stops that node's services while preserving data and signing
   history. **Lock controls** discards that node's decrypted identity from the
   manager; its Docker services keep running.
   Closing the launcher also leaves Docker services running. Reopen and unlock
   each node to resume controls. A locked node's running status is unknown until
   it is unlocked; unavailable status is not proof that a node has stopped.

Node setup and controls are in the manager. The explorer is optional.

The operator wallet and node agent address are different. Stake is locked by the
validator registration. The agent only needs GRPH if its transactions have a
nonzero network fee; a network reporting zero gas price requires no publication-fee top-up. Do not fund a
node simply to fix synchronization or a stale status message.

### 5. Manage remote servers through Grph P2P

On each node host, run the updated launcher and choose **Share this server**.
On a headless host, run `GRAPHENE_P2P_SHARE=1 npm run join` and copy its printed
private `grph://PUBLIC_KEY#ACCESS_CODE` connection link. Keep that link private.

On your own computer, open the launcher and choose **Connect a server**. Name the
server and paste its P2P link. The manager opens an encrypted Grph tunnel and
verifies the launcher access code before showing or controlling any remote nodes.
No SSH port forwarding, public HTTP control port or direct HTTP fallback is used.
The central manager needs Node.js and a wallet browser; Docker and the matching
chain stack are needed only on the actual node hosts.

Keep remote launchers running and permit outbound UDP/DHT connectivity on both
hosts. By default Grph uses its public DHT bootstrap network. A provider can set
`GRAPHENE_DHT_BOOTSTRAP=host:port,host:port` before launching to use an approved
private rendezvous network. Peer traffic still uses authenticated, encrypted Grph
streams. If a tunnel is unavailable, controls report the peer as unavailable;
this does not stop an already-running node. There is no direct-connect fallback.

Labels and public P2P identities are saved; access codes and live tunnel endpoints
stay in memory. Reconnect with the current P2P links after restarting the central
launcher. Older SSH/HTTP connection entries must be replaced with P2P links.

Bootstrap peer traffic and sentry-to-validator traffic also use Grph tunnels.
Bootstrap tunnels run as persistent Docker services, separate from the launcher.
Same-node browser, agent, database and ABCI requests stay local. These internal
service connections are not remote peer transports.

### 6. Apply a checkpoint on a fresh validator or sentry

In the node manager, select and unlock the registered node, then choose **Start
node**. All controls are in the selected node’s launcher dashboard.

Start node automatically applies a compatible trusted checkpoint on an eligible
fresh node. Registration accepts public identity setup JSON; checkpoint restore
is handled separately by the launcher.

1. Confirm eligibility. The identity may already be registered, but the node must
   have no existing chain databases or committed application/trie state, signing
   height zero, and no other deployment using its keys. A node already stuck at
   3303 has existing data even if it has never signed, so it needs provider recovery.
2. Obtain the approved public trust JSON from your provider and authenticate its
   publisher fingerprint through a trusted channel. Never automatically trust a
   public key bundled with an unverified checkpoint download.
3. Have the provider put it in `graphene-operator-kit/.checkpoints/trust.json`, or
   set GRAPHENE_CHECKPOINT_TRUST to its absolute path before launching. On a hosted
   node, the file and environment variable belong on the server, not just on the
   computer with your browser. The full source workspace finds the provider's
   `graphene-node/.checkpoints/trust.json` automatically.
4. Install dependencies with `npm ci`, then run `npm run doctor`. Resolve ACTION
   NEEDED items. Close any old setup terminal with Ctrl+C and reopen the updated
   launcher in the original identity directory; existing Docker services keep running.
5. Validator: `npm run join` (port 8787). Sentry: `npm run join:sentry` (port 8788).
   Create or unlock the intended identity and complete registration if required.
   Keep an existing matching registration rather than registering the identity again.
6. Select the intended node in the launcher. For a remote host, operate through
   its P2P connection in the node manager.
7. Select Start node. The launcher downloads, authenticates and restores the
   checkpoint automatically, preserving the node's own identity and signing files.
   Keep the launcher open through Preparing → Downloading → Verifying → Restoring
   → Catching up → Synchronized. Blocks newer than the snapshot still need replay.
8. Compare the resulting height with your provider's trusted network reference.
   Validators should also have accepted signatures in recent canonical commits.
   Sentries normally have voting power zero; check Agent Status and peer handshakes.

For an alternative trust file location, run these commands inside the extracted
kit on the node host, replacing the example path:

```sh
# macOS / Linux; use npm run join:sentry for a sentry
export GRAPHENE_CHECKPOINT_TRUST="/absolute/path/provider-trust.json"
npm run doctor
npm run join
```

```powershell
# Windows PowerShell; use npm run join:sentry for a sentry
$env:GRAPHENE_CHECKPOINT_TRUST = 'C:\Graphene\provider-trust.json'
npm run doctor
npm run join
```

An interrupted download can resume by retrying Start node in the same updated
launcher. An interrupted restoration, existing data, or signing history requires
provider inspection; do not delete data or signing files to bypass the checks.
For an expired checkpoint or incompatible images, obtain a fresh compatible
publication or matching software from your provider.

The interactive equivalent is `/operator/guide#checkpoint-setup` on your launcher, with commands
and controls adjusted to your selected role and computer/server location.

### 7. Daily operation and recovery

- Registered / Approved: on-chain registration or permission, not proof of uptime.
- Details published: encrypted connection information exists, handshake unverified.
- Peer connected (verified): a recent authenticated peer handshake was observed.
- Node running: inspect chain height against your trusted network reference.
- Agent Status: reports agent state, last update, handshakes and reported errors.
- Stale / Unavailable: the manager or explorer cannot verify live status. Check the launcher
  and P2P tunnel; the node may still be online. Refresh or reconnect the host.
- Stop node preserves data and signing state. Closing the browser or launcher
  leaves Docker services running. Keep Docker and the host running for uptime.
- Back up the encrypted identity and runtime/signing state before upgrades. Use
  provider-managed graceful shutdown and retain a rollback copy. This release
  has no automatic updater or service restart-after-host-reboot guarantee.
- Checkpoint downloads resume after interruption. Automatic restore refuses any
  existing chain data or signing history. An interrupted restoration leaves a
  journal for provider inspection; never delete signing files to bypass it.
- Port in use: reopen the existing private launcher link or stop that launcher.
  Reconnect remote hosts using their current private Grph P2P links.
- App-hash mismatch or stalled replay: stop and contact your provider with public
  logs; preserve data. Never fix it by deleting volumes or signing state.

### 8. Provider: export and publish checkpoint data

These commands run inside the **full graphene-node source directory** on the
bootstrap Docker host. The operator kit does not include the publisher CLI.
Install dependencies with `npm ci` and prepare Docker/Compose and the matching
`graphene-local` development stack (chain 9876). Check ready APIs, a synchronized
reference node and advancing block height before exporting.

Create an Ed25519 publisher key once, then reuse it for subsequent exports:

```sh
npm run checkpoint -- keygen
npm run checkpoint -- export --url grph://HOST_KEY/checkpoints/latest.json  # First publication
```

Keep `.checkpoints/publisher.pem` private and securely backed up. It is separate
from validator consensus keys. Authenticate the public-key fingerprint printed
by keygen with operators through a trusted channel; never distribute this private
key or regenerate it for each export.

Export checks progress before stopping writers. It briefly stops the bootstrap's
Tendermint, ABCI, indexer and trie services, captures a consistent committed
boundary, then resumes services that were running. PostgreSQL stays up. Plan for
the interruption; do not schedule this exporter on a production validator.

The command restores the snapshot in an isolated Docker project using a random
nonvoting identity, verifies the actual trie root and canonical catch-up, then
signs and publishes. Wait for successful completion. Failed verification leaves
the previous `latest.json` unchanged. Only sanitized application state, genesis
and native chain databases are published, excluding node configuration, private
keys, signing history, agent identities, passwords and application session tokens.

The default output is `graphene-node/.checkpoints/publication`, served during
local development at:

```text
http://127.0.0.1:8787/checkpoints/latest.json
```

Serve the whole output tree: `latest.json`, immutable `height-…` directories,
each directory's `manifest.json` and all four artifacts: `genesis.json`,
`app-state.json`, `mpt.tar.gz` and `tendermint.tar.gz`.

For a server download directory, replace the example directory and URL:

```sh
npm run checkpoint -- export --output /srv/checkpoints --url grph://PROVIDER_P2P_KEY/checkpoints/latest.json
```

Set `GRAPHENE_CHECKPOINT_PUBLICATION_DIR=/srv/checkpoints` on the provider
launcher and publish its public Grph P2P key. The CLI does not upload files or
configure a web server. Remote checkpoint URLs must use Grph P2P. Preserve directory names and
publish artifacts before replacing the latest manifest. A loopback download URL
works only on the joining host itself. Remote hosts use the public Grph P2P URL
without a launcher access code.
For a packaged explorer, rebuild/deploy static assets after export, or serve
checkpoints from a separate persistent directory; running images do not pick up
source-file changes automatically.

Successful export writes `.checkpoints/publisher-trust.json`. Transfer this **public trust
configuration** through a trusted channel and independently authenticate the
publisher fingerprint. Install it on each node host at the extracted kit's
`.checkpoints/trust.json`, or set `GRAPHENE_CHECKPOINT_TRUST` as in section 6.
Never send `publisher.pem`. Check manifest/artifact reachability from the joining
host and validate first startup with a fresh test identity. The guide's Fast sync
checkpoint card should show the new height/date. The default manifest age limit
is 24 hours; publish fresh compatible checkpoints before expiry and retain files
needed by in-progress downloads.

If the reference chain is stalled, export refuses before stopping writers.
Restore validator quorum first. An earlier consistent, sanitized checkpoint with
a canonical next block available can be revalidated and published:

```sh
npm run checkpoint -- publish --directory /private/previous-checkpoint
```

Replace the directory with the folder containing the four sanitized artifacts.
Do not use raw recovery backups. Publication still runs isolated restoration and
canonical hash checks. The manifest records the actual verified height, and a
joining node still replays blocks after the snapshot height.

Rerun isolated verification of an existing publication using the local trust file:

```sh
npm run checkpoint -- verify --directory /srv/checkpoints/height-N-ID
```

Replace the path with the actual publication folder. Never use these commands to
reset a live validator or replace its signing state. See [Signed local checkpoint bootstrap](#signed-local-checkpoint-bootstrap) in the
full source for the implementation's compatibility limits. Interactive guide:
`/operator/guide#checkpoint-export` on the launcher.

### Before production distribution

Publish versioned, signed platform installers and verified container digests;
ship a trusted chain/genesis manifest and checkpoint bootstrap; provide hosted
provisioning and persistent service supervision; validate firewall/relay support,
resource sizing, upgrades and recovery on a multi-validator network. Do not
market this development source kit as an unattended production installer.

### Reopen a node from a public setup JSON

Choose **Add node → Open a saved node**, select its original host and public file,
and enter the original node password. The saved encrypted identity must still be
in that host's node profile or legacy secrets folder. Public JSON alone cannot
restore a node on a new computer. Ask your provider to restore the encrypted
identity and signing state when these are missing. Keep the node's existing
on-chain registration.

### P2P transport policy

Remote management accepts only Grph P2P connection links. Remote checkpoint URLs
must use `grph://<provider-public-key>/checkpoints/latest.json`; use the public key
from Share this server without its # access code. Configure the publisher's
`GRAPHENE_CHECKPOINT_PUBLICATION_DIR` when its output is outside the default
node checkpoint publication directory. Checkpoint signatures, genesis pins, hashes, range
resumption and archive validation remain mandatory. Same-host loopback downloads
remain supported; remote HTTP/HTTPS download URLs are rejected.

### Launcher guide and sentry management

Open **Setup guide** in the launcher sidebar. Choose Validator or Sentry and
My computer or A hosted server, then select **Update guide**. The guide covers
prerequisites, identity recovery, registration, connections, startup, checkpoints,
live status, agent responsibilities and the complete provider reference. It is
bundled with the operator kit and works without a running explorer.

The launcher refreshes registration and requests automatically. Each sentry has
its own country, capacity, pending validator requests, active assignments and
request/connection history. Approve, decline and revoke actions use the owner
wallet, and requests that have already changed cannot be reviewed again.
Validator requests cannot duplicate a pending or active connection to the same
sentry. Both roles report live peer handshakes separately from on-chain approval.

The chain's `updateSentryHost` method selects a sentry by the signing account.
The launcher offers address updates only when the owner wallet is also the
sentry ID; other sentries require provider support. The node's peer ID remains
fixed. After an endpoint change, reopen the same identity with a public setup
file containing the confirmed endpoint before starting it.

### Find nodes already registered to your wallet

The launcher lists public registrations separately from saved host profiles.
Connect your wallet, or enter any wallet address in **Nodes registered to a
wallet**, choose the network source, and select **Find my nodes**. Discovery
queries that host’s chain state for the registered validator and all sentries
owned by the address, including inactive sentries. A manager without a local
chain can use a connected remote host as its network source.

Registrations are visible without importing private keys. Select a registration
to manage staking, sentry requests, approvals, declines, cancellations and
revocations with its owner wallet. Another address can be inspected read-only.
The launcher rechecks ownership and request state before preparing each action,
and verifies the wallet account and matching host network before signing.

A registration is not proof that a node is running. Live status and start/stop
controls require the original host and encrypted identity. **Open saved identity**
loads the public identity from the registration and asks for the original
password; the encrypted keys must already exist on the chosen host. It never
creates a replacement identity. **Connect node host** opens the existing Grph
P2P flow. Saved profiles on the selected source host are matched by their public
identity and open the existing node controls.

Changing the connected wallet clears the previous wallet inventory. Network
errors are shown separately from an empty registration list, and late responses
from a previous wallet cannot overwrite the current results. Operator setup,
public setup parsing, wallet actions and node controls now live in graphene-node;
the explorer has no operator pages, handoff or public kit downloads.

## Signed local checkpoint bootstrap

This is trusted, publisher-signed bootstrap for the fixed Graphene local Docker
profile (chain ID 9876), not ABCI/light-client state sync. A joining node must
have no committed data and no signing history. Existing deployments always resume
their own state. Recovery of an existing validator requires provider review.

### Publisher commands

From the full graphene-node source (the publisher CLI is not included in the
operator kit), create an Ed25519 publisher key once:

```sh
npm run checkpoint -- keygen
npm run checkpoint -- export --url grph://HOST_KEY/checkpoints/latest.json  # First publication
```

The private key defaults to `.checkpoints/publisher.pem` (mode 0600), outside the
public download tree and excluded from Git, Docker contexts and the operator kit.
Keep this publisher key separate from validator consensus keys. Never distribute it.

Export checks that the reference chain is advancing before touching writers.
It briefly stops the local bootstrap's Tendermint, ABCI, indexer and trie services,
captures one committed boundary, then resumes the services that were running.
PostgreSQL stays up; only the public app_states row is exported, with its session
token erased. Do not schedule exports from a production validator: a dedicated
snapshot donor and online snapshot coordination are future production work.

The copied application root must match the next canonical block header. Archives
contain only native trie databases and Tendermint block/state/evidence/index
databases. No node configuration, consensus key, node key, signing file, password,
wallet, agent identity or application session token is published.

Before publication, the tool creates an isolated Docker project with its own
random nonvoting key, restores the data, checks the actual trie root, catches up,
and compares canonical block/application hashes. Failure leaves `latest.json`
unchanged. Only the verifier's own containers/volumes are removed afterward.

If the reference chain has stopped because a new validator is offline, export
refuses before stopping writers. An earlier consistent checkpoint can still be
revalidated and published using four already-sanitized artifacts:

```sh
npm run checkpoint -- publish --directory /private/previous-checkpoint
```

Required files are `genesis.json`, `app-state.json`, `mpt.tar.gz` and
`tendermint.tar.gz`. Do not use raw recovery backups directly: they may contain
node-specific files or session tokens. The publisher copies only these four files,
sanitizes application metadata, rejects unsafe archive entries, checks the network
genesis and canonical application-hash anchor, and performs the same isolated
restore test. It needs a canonical next header after the snapshot's height.

At a stalled current tip, verification can prove state through the prior height
by matching the complete canonical next block that native Tendermint validated.
The manifest records that verified height explicitly; it does not pretend the
unanchored final application root has an independent consensus confirmation.

Custom publication destination:

```sh
npm run checkpoint -- export --output /srv/checkpoints --url grph://PROVIDER_P2P_KEY/checkpoints/latest.json
```

Serve that directory through the provider launcher: set GRAPHENE_CHECKPOINT_PUBLICATION_DIR to it, choose Share this server, and use the public key from the Grph link (without its # access code). Replace PROVIDER_P2P_KEY in the command above. The tool prepares files; it does not
upload them, grant cloud access or configure public web servers. Local development
defaults to graphene-node/.checkpoints/publication and the launcher checkpoint endpoint on port 8787.
Large checkpoint archives are Git-ignored. Publication uses immutable height/ID
directories and atomically replaces the small signed latest manifest.

### Operator enrollment and automatic restore

After successful publication, `.checkpoints/publisher-trust.json` records the
publisher public key, genesis hash, chain ID, manifest URL and default 24-hour
manifest age policy. Receiver enrollment remains separate. On each node host, use
the launcher’s Checkpoints panel to enroll, or transfer this **public trust
configuration** through a trusted channel and install it as `.checkpoints/trust.json`.
For a custom receiver location, set GRAPHENE_CHECKPOINT_TRUST before running join:

Alternatively, a provider can place the approved public configuration at
`.checkpoints/trust.json` inside the extracted kit, so desktop launchers find it
without a shell environment variable. Existing setup terminals must be closed
and reopened to load this update; closing the launcher does not stop Docker nodes.
Updated clients refuse to silently reuse an older launcher without checkpoint
support. Keep the original identity directory, unlock it and pair again.

```sh
# macOS / Linux
export GRAPHENE_CHECKPOINT_TRUST=/private/provider-trust.json
npm run doctor
npm run join
# Sentry: npm run join:sentry
```

```powershell
# Windows PowerShell
$env:GRAPHENE_CHECKPOINT_TRUST = 'C:\Graphene\provider-trust.json'
npm run doctor
npm run join
```

Authenticate the publisher fingerprint with your provider. Never automatically
trust a public key downloaded alongside an unverified checkpoint. Browser requests
cannot select the trust key, download URL, local paths, images or Docker commands.

Pair explorer controls and choose Start node. A fresh node performs:

1. Preparing: verify the pinned manifest signature, network, age, format and
   successful publisher restore-test attestation.
2. Downloading: fetch fixed artifact names from the configured HTTPS/loopback
   origin, with size limits, resumable partial files and no redirects.
3. Verifying: check all SHA-256 values and every tar entry. Reject traversal,
   links, special files, duplicate entries, truncated archives and expansion limits.
4. Restoring: require matching Docker image IDs, matching genesis, signing height
   zero, no Tendermint databases, no committed app row and empty trie roots. Stage
   native database files without rebuilding IAVL versions. Keep protected files
   untouched, update application metadata transactionally, verify the actual trie
   root, and preserve the original state for rollback.
5. Catching up: start services and let Tendermint validate later canonical blocks.
6. Synchronized: report this only after catching_up=false and the node advances
   beyond the installed checkpoint. It is not proof of accepted validator votes.

The launcher shows per-file download bytes and these phases. The guide displays
the latest publication's height, timestamp, size and a signed-manifest download.
The browser displays publisher information; the launcher enforces pinned trust.

Keep the launcher open during initial bootstrap. Interrupted downloads resume.
Detected restore failures attempt rollback with services stopped. A crash or
interrupted restore leaves a private journal; restart refuses further automatic
replacement until a provider inspects it. No signing state is reset or copied
from the publisher. Stop/start on an installed node does not restore again.

### Compatibility and limits

- This profile requires the same genesis and exact local app-abci, mpt-db,
  Tendermint and PostgreSQL image IDs. Providers must prepare compatible images
  for each supported target; cross-architecture portability is not certified.
- Trust comes from the enrolled publisher and trusted reference, not a light
  client or merely a checksum. Keys and trust files are not shipped in source kits.
- Native ABCI snapshots, public-network provisioning, automatic key rotation,
  parallel chunk download, periodic online snapshot generation and production
  resource sizing remain separate work. Signed archives can be served remotely;
  node operation still uses the fixed local Docker profile.
- Registering a large validator before it is ready can remove quorum. Bootstrap
  from a previously anchored checkpoint to bring it online; never rewrite stake
  or remove validators merely to make snapshot verification pass.

### Verification commands

```sh
npm run test:checkpoint
GRAPHENE_DOCKER_TEST=1 node --test scripts/checkpoint.integration.test.js
npm run checkpoint -- verify --directory /srv/checkpoints/height-N-ID
```

The Docker test uses a new synthetic chain and keys, checks real Java ABCI/IAVL
export/restore, HTTP download, launcher phases, preservation of receiver signing
files, and that existing state is not restored again. It never stops the user's
bootstrap chain or performs user transactions.

### Remote transport

Remote downloads require a Grph P2P URL. The launcher serves only the public
checkpoint manifest and allowlisted sanitized artifacts at `/checkpoints/`.
Direct remote HTTP/HTTPS URLs are rejected. Provider signatures, genesis pins,
file hashes and archive safety checks remain required over the encrypted tunnel.


### Reset an existing node

Ordinary **Start node** resumes saved data. To replace an existing node’s chain
state, unlock it with its owner wallet connected, stop it, then open the Node tab
and **Recover from a checkpoint → Reset from checkpoint & start**. The launcher
asks for confirmation, downloads the latest published checkpoint under the
provider’s pinned trust, restores it, and starts catch-up. It does not export a
checkpoint or stop the bootstrap stack. Normal validator exit rules still govern
stopping a running validator.

Recovery requires the selected node, agent, ABCI and trie services to be stopped.
Its database service may remain running.
The checkpoint must match the genesis, images, publisher signature, freshness,
and successful restore attestation. Its height must be at least the node’s last
signed height; an older checkpoint is refused without clearing signing history.
Identity keys and the exact signing file remain in place.

The restore journal records the backup locations: old Tendermint stores and WAL,
prior journal and application row under `checkpoint-backup-<id>/` beside the node
home, and old trie files under the named backup directory in its MPT volume.
Backups are retained after success and use additional storage. A detected failure
attempts rollback with services stopped; an interrupted restore requires provider
inspection. Backups are not complete identity backups: continue backing up keys
and signing history separately. Do not restore an old signing file to retry.

## Graphene launcher overview

Start with [Get started](#get-started) for installation and commands, then open the
launcher's **Setup guide** or read [Graphene operator guide](#graphene-operator-guide).

- `npm run join` opens the manager on loopback port 8787.
- `npm run join:sentry` opens it on port 8788 and defaults new-node setup to Sentry.
- Use the complete private terminal URL, including its fragment access code.
- The dashboard supports multiple validator and sentry profiles on local hosts
  and servers connected through encrypted Grph P2P tunnels.
- Wallet discovery lists public registrations without requiring local keys.
  Owner-wallet actions and unlocked host/runtime controls remain distinct.
- `/operator/guide` and `/guide` serve the built-in role/location guide.
- The old single-node assistant and explorer-pairing APIs have been retired.
  Original encrypted identities remain supported through the manager's import
  and unlock flow; their keys and signing history are preserved.

The current runtime supports the provider-prepared development profile on chain
9876. Each actual node host needs the matching Docker stack, persistent storage,
network access and trusted checkpoint configuration. The launcher is not an
automatic production host provisioner.

### Maintenance entry points

- `npm run package:operator-kit` creates the independent node software distribution
  in `dist/operator/`; it does not publish anything to the explorer.
- `npm run package:explorer` builds a sibling `grph-explorer` checkout into
  `docker/explorer/app/`. Node setup and controls are not part of that frontend.
- `npm run checkpoint -- …` is the provider publication and verification CLI;
  see [Signed local checkpoint bootstrap](#signed-local-checkpoint-bootstrap).
- `deploy.sh`, `services/`, `docker/`, `config/`, `health/`, `chain/` and
  `dependencies/` remain for the bundled Compose/image maintenance workflow.
  They are separate from creating and running isolated profiles in the launcher.
- `sdk/` is the independently built and tested `@grph/evm-client` package.

For distribution details, see [Providing the operator software](#providing-the-operator-software).

## Providing the operator software

Optional Grph software download/staging is described in [Software updates in the README](#software-updates).
It verifies and stages files only; persistent host supervision and coordinated
upgrade activation below remain future work.

### Available now

The node launcher's `/operator/guide` route provides validator/sentry and
computer/server instructions. The explorer contains no operator pages or downloads.

Official installation links provide Node.js, Docker and MetaMask.
Graphene supplies a development source ZIP, offline Markdown guide, release
metadata and SHA256SUMS in `graphene-node/dist/operator/`. The archive is intentionally not a
signed installer and does not contain Docker images, a production chain manifest,
chain data, an embedded checkpoint, a wallet or a private node identity.
Checkpoints are separate signed downloads described in [Signed local checkpoint bootstrap](#signed-local-checkpoint-bootstrap). The kit
includes the restore client but never ships a publisher private key or
automatically trusts a public key from the download site.

The kit's `npm run doctor` performs read-only checks for Node.js, Docker access,
Compose, matching development images and the graphene-local bootstrap container.
`--identity-only` checks Node.js for identity preparation on a hosted server.

### Build and deliver

Maintainer prerequisites: Python 3, Node.js 24/npm, and the compiled local network
packages under network/{net,utils,server,client}/dist. Use the same reviewed source
revision as the node images. The builder fails if required inputs are missing.

From graphene-node:

```sh
npm run package:operator-kit
npm run package:explorer
```

The first command writes the kit, guide, release metadata and checksums to
`graphene-node/dist/operator/`. Distribute them through the node software release
process. The second command independently builds the explorer and refreshes its
static image assets; it never builds or copies operator downloads.

The ZIP builder uses an explicit source allowlist and rejects symlinks. It
includes only launcher/runtime source, agent source and Dockerfiles, shared/network
libraries, an isolated lockfile and the operator guide. It never traverses local
secrets, runtime directories, environment files, volumes or node_modules. It
generates the npm lockfile in a temporary directory with lifecycle scripts
disabled, without changing the repository lockfile.

KIT_MANIFEST.json records each included file's SHA-256, source commit, dirty-tree
flag, development channel, chain ID, Node.js major and unsupported hosted/signed
installer features. SHA256SUMS covers the public ZIP, guide and metadata.
Checksums provide integrity; authenticity still requires a trusted delivery
source. These local working-tree artifacts have not been publicly published or
signed. Keep old immutable versions when publishing real releases.

Before delivery, extract into a clean temporary folder, verify checksums and the
embedded file manifest, run `npm ci`, import scripts/join-network.js without
starting it, then run both doctor modes on a prepared test host. Test launchers
on each target platform before claiming platform certification. The current kit
is platform-neutral source; it has been smoke-tested on this development Mac.

### Hosted service responsibilities

The provider installs the kit and Node.js on the server, prepares the matching
chain services and checkpoint, supplies the sentry endpoint, and supervises node services. The wallet remains in the operator's own browser.
Share the host through the launcher’s private Grph P2P link and connect it from
the operator’s local dashboard. The development chain ID is 9876.
Start node requires the graphene-local Docker bootstrap on that same host.
Remote public-network provisioning is not implemented by this launcher.

### Production release work

1. Publish immutable Linux amd64/arm64 blockchain/agent images pinned by digest.
2. Publish a signed network manifest (chain ID, genesis hash, peer discovery,
   trusted checkpoint policy and compatible software versions).
3. Build signed/notarized desktop installers and a signed Linux package; embed
   or verify the runtime, detect prerequisites and show actionable installation
   results. Distribute checksums and signatures through a trusted release channel.
4. Add a hosted provisioning profile with least-privilege remote access,
   secrets handling, persistent service
   supervision, firewall setup and recovery after reboot.
5. Implement/test trusted checkpoint bootstrap and one-live-signer protection,
   coordinated upgrades, backup/rollback and key rotation without resetting
   signing state.
6. Validate the supported network paths, blocked UDP/CGNAT behavior and relay
   fallback; benchmark CPU, memory, disk and bandwidth before publishing minimums.
7. Gate release on multi-validator join, synchronization, accepted votes, restart,
   revocation and recovery tests across all supported host/platform combinations.

## Validator agent reference

Node.js CLI sidecar that runs alongside a Graphene validator node. Generates encrypted secrets, operates the P2P tunnel (`GrphServer`), monitors the chain for approved sentry applications, and submits `submitConnectionString` on-chain.

### Quick Start

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

### Commands

| Command | Description |
|---|---|
| `init` | Generate seed + Grph invite key, X25519 encryption keypair, Ethereum agent signing key, Tendermint validator/node keys; encrypt to keystore |
| `connect` | Start `GrphServer` (P2P tunnel via DHT) + Tendermint + approval monitor |
| `status` | Show GrphServer state, Tendermint status |
| `disconnect` | Stop GrphServer and Tendermint |
| `logs` | View agent logs (`-f` to follow, `-n N` for line count) |
| `upgrade` | Stop agent for redeployment |

### Configuration

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

### Architecture

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

### Key Generation

`init` produces the following keys, all stored in a single encrypted keystore:

| Key | Algorithm | Purpose |
|---|---|---|
| Grph seed + keypair | hypercore-crypto (ed25519) | DHT identity + invite key |
| X25519 keypair | tweetnacl (curve25519) | Encrypt invite keys for sentries |
| Agent Ethereum key | ethers.js (secp256k1) | Sign `submitConnectionString` txs |
| Tendermint validator key | tweetnacl (ed25519) | Block signing (key type: `tendermint/PrivKeyEd25519`) |
| Tendermint node key | tweetnacl (ed25519) | P2P node identity |

*No keys are ever transmitted during `init` — everything stays local.*

### Approval Flow

1. **Poll**: Agent polls `GET /graphene/state/platform/assignments?validator=<agent-address>` every `POLL_INTERVAL_MS`
2. **WebSocket** (optional): Connects to `WS_URL` (`/graphene/tx-watch`) for real-time `ApplicationApproved` and `ConnectionStringSubmitted` events
3. **On new assignment**: Reads sentry's `encryptionPublicKey` from `/graphene/state/platform/sentries`
4. **Seal**: Encrypts the validator's invite key to the sentry's X25519 public key using `nacl.box` (sealed box)
5. **Submit**: Signs and broadcasts `submitConnectionString(assignmentId, encryptedConnectionString)` via `eth_sendRawTransaction`

### Docker

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

### Testing

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

## Sentry agent reference

Node.js CLI sidecar that runs alongside a Graphene sentry node. Monitors the chain for new assignments targeting this sentry, decrypts the invite key with the sentry's X25519 private key, starts `GrphClient` to connect to the validator's `GrphServer`, allocates a unique local loopback port per validator, rewrites Tendermint `persistent_peers`, and restarts Tendermint via the Docker socket.

### Quick Start

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

### Commands

| Command | Description |
|---|---|
| `init` | Generate X25519 encryption keypair + Ethereum agent key; save to secrets file |
| `start` | Begin polling + WebSocket monitoring for assignments targeting this sentry |
| `reload` | Reload configuration (restart to apply) |
| `sync` | Force sync with contract state |
| `status` | Show tunnels, validators, ports, and identity |
| `logs` | View agent logs (`-f` to follow, `-n N` for line count) |

### Configuration

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

### Architecture

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

### Key Generation

`init` produces the following keys:

| Key | Algorithm | Purpose |
|---|---|---|
| X25519 keypair | tweetnacl (curve25519) | Decrypt invite keys from validators |
| Agent Ethereum key | ethers.js (secp256k1) | Identity for assignment lookup |

### Assignment Flow

1. **Poll**: Agent polls `GET /graphene/state/platform/assignments?sentry=<sentry-address>` every `POLL_INTERVAL_MS`
2. **WebSocket** (optional): Connects to `WS_URL` for real-time events
3. **On new assignment**: Decrypts `encryptedConnectionString` with sentry's X25519 secret key
4. **Tunnel**: Starts `GrphClient` and connects to validator's `GrphServer` at `127.0.0.1:<allocated-port>`
5. **Config**: Adds peer entry to `persistent_peers` in `config.toml`, restarts Tendermint via Docker
6. **On revoke**: Disconnects `GrphClient`, removes peer, restarts Tendermint, frees port

### Docker

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

### Testing

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

## Repository layout and maintenance

```text
scripts/                  Launcher, browser UI, wallet actions, checkpoints and tests
agents/                   Validator/sentry sidecars and shared runtime utilities
network/                  Bundled @grph-net packages needed by the launcher and agents
sdk/                      Independent @grph/evm-client TypeScript SDK
.checkpoints/             Local trust, publisher keys and publications (gitignored)
secrets/                  Local encrypted profiles and runtime/signing data (gitignored)
dist/operator/            Generated operator distribution (gitignored)
docker/, services/        Retained Docker image and Compose maintenance assets
chain/, dependencies/     Bundled chain artifacts and MPT image dependencies
config/, health/          Compose configuration and health checks
```

`deploy.sh` is the separate Compose maintenance entry point for the bundled stack;
use `bash deploy.sh --help` to inspect its options. It is not the launcher startup
command and does not provision the current development bootstrap automatically.
Before using that bundled stack, create `graphene-node/.env` once from this
directory and validate both roles:

```sh
test -e .env || (umask 077; printf 'MPT_DB_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env)
bash deploy.sh --validate-only local
```

If `.env` already exists, retain its token or add `MPT_DB_API_TOKEN` with a random
secret of at least 32 characters. `deploy.sh` loads this ignored file for both
roles. `SECURITY_ACTIVATION_HEIGHT` defaults to `0`; set a coordinated value for
an existing network when required.

Git LFS is needed when retrieving the bundled `chain/` artifacts to build those
images. The current launcher expects the prepared `graphene-local` bootstrap and
development images; providers working in the full Graphene workspace prepare
those through `graphene-quarkus` and configure checkpoint trust separately.

The SDK has its own package and build/test commands under `sdk/`. Keep bundled
network builds and Docker maintenance assets: they are used by agent builds,
source-kit packaging or the retained Compose workflow. Update source and generated
artifacts through their respective build commands rather than editing bundles.

For a different private identity directory use `GRAPHENE_SECRETS_DIR`; for another
launcher port use `SETUP_PORT`. Remote DHT rendezvous and checkpoint publication
locations can be configured with `GRAPHENE_DHT_BOOTSTRAP` and
`GRAPHENE_CHECKPOINT_PUBLICATION_DIR` respectively.

## Governance upgrade

Validator and sentry Compose services forward `GOVERNANCE_ACTIVATION_HEIGHT` (default `0`, disabled). Set the same future positive height on every validator and retain it for replay. The upgrade seeds account holding histories, so voting requires a holding-period warmup. See [governance activation and API documentation](../graphene-quarkus/docs/GOVERNANCE.md) for defaults and usage.
