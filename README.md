# Graphene Node

Run an independent validator or sentry on a network already created in **grph-deployment**.

The participant console supports local Docker or prepared Linux cloud hosts, public sentry domains and invitation APIs, and private validators configured directly from a verified sentry invitation. It joins existing networks without changing their release or deploying application frontends. See [PARTICIPANTS.md](PARTICIPANTS.md).

```sh
npm ci
npm start
```

Open the private terminal link and select the built-in **Dev**, **Test** or **Prod** workspace. Its public API automatically supplies the verified network invitation; no file or checksum entry is required. Choose **Sentry deployments** for a public nonvoting peer, or **Validator deployments** to generate an identity and prepare a private runtime directly from that invitation. Choose local Docker or an existing prepared Linux cloud host. Both roles retain **Fast checkpoint sync** using an operator-signed full snapshot and bundled helpers. See the guide for prerequisites, enrollment and deployment steps.

See the [participant guide](PARTICIPANTS.md) for the invitation, enrollment, ports and operating instructions. Use `npm run package:operator-kit` to build the standalone operator download.

The deployment controller still uses the host installer in this source checkout. Existing development launcher profiles remain accessible through `npm run join:legacy`. The [maintenance reference](LEGACY-MAINTENANCE.md) preserves the previous launcher, checkpoint, SDK and deployment documentation.
