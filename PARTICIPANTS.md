# Join a Graphene network

Install Node.js 24, npm, and a local Docker Engine with Compose v2 on the machine where the node will run. Sign in to the network's image registry if required. Install from a checkout or extract the participant kit on that host:

```sh
npm ci
npm start
```

Open the complete private link printed in the terminal. The console listens only on 127.0.0.1:8787. `npm run join` opens the same console; `npm run join:sentry` opens the sentry setup directly. Run one launcher per host. Closing it leaves Docker services running.

1. Ask the network operator for the public invitation from **grph-deployment → Overview → Invite node operators**. Confirm its SHA-256 over a separate trusted channel. In **Networks**, select **Import invitation**, choose the file and enter the checksum. A network's stage, chain ID, frozen genesis, primary peer and pinned images come from that invitation.
2. **Private sentry:** if Networks shows **Approved Grph tunnel**, prepare a sentry, download its public application and confirm its node ID and Grph key with the operator. Start the node; it waits until the operator approves the application and applies the peer list. Check node health for the primary peer, catch-up and block height. The consensus port is never published in this mode.

   **Public-network sentry:** choose **Sentry node**, leave the advertised address empty to sync outbound with a loopback-only read gateway. To serve other peers, enter this host's reachable IPv4 address and allow inbound TCP 26656 (P2P) and 26657 (read-only chain gateway). Start the node and use **Check node health** to see catch-up and block height. This is an independent, nonvoting full peer; it does not automatically receive validator assignments. Use one publicly listening sentry per host/IP.
3. **Validator:** create a new identity with the operator wallet's public address and a private passphrase. Download only **public.json** and send it to the network operator. They create a non-primary validator deployment for the existing network and import that public identity. In your local console use **On-chain enrollment → Check enrollment → Register & stake** with the operator wallet on the invitation’s chain. Check the transaction receipt, refresh enrollment, and request a sentry connection. After registration, the network operator uses **Check enrollment & prepare runtime** and returns the admitted Home bundle. Extract it locally, choose **Install bundle**, enter the absolute folder path and start your node. Download **home-ready.json** and return it to the network operator. They import the receipt, approve the sentry assignment and choose **Connect validator to chain**. Starting containers alone does not grant voting power.
4. Check local services and consensus status in the node's setup screen. **Activity & logs** records operations in this console. Nodes sync by replay from peers; the peer must serve the needed chain history. Operators with pruned history must use the deployment's supported snapshot bootstrap workflow separately.

Runtime data is under `~/.graphene/participants/<network-id>/<role>/`. Back up the validator's entire private directory and signing history while stopped; never run a second copy of the same signer. Do not send the private directory or passphrase to the controller. The installer does not overwrite existing identities, create a chain, or issue genesis stake. Pick a local Docker context with access to this directory. A port conflict or registry login error can be corrected and **Start node** retried. `SETUP_PORT` overrides the console port; `GRAPHENE_PARTICIPANT_DIR` selects a private persistent root.

## Network operator

Use a deployed stage and its current release. From **Overview** download the invitation and share it alongside the participant kit.  The export contains public network configuration and immutable image references; it excludes identities, credentials and controller access. Anyone with an invitation can prepare a sentry; a validator also needs its own approved admission bundle.

From the graphene-node source checkout run `npm run package:operator-kit` to build the distributable ZIP, guide, manifest and SHA256SUMS under `dist/operator/`. No sibling checkout is required on participant hosts.
