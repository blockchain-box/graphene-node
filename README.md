# Graphene Node

Run an independent validator or sentry on a network already created in **grph-deployment**.

```sh
npm ci
npm start
```

Open the private terminal link and import the network operator’s invitation. Choose **Sentry node** to run a public nonvoting peer, or **Validator node** to create an identity and install a post-genesis admission bundle. You need Node.js 24 and local Docker with Compose to run the node.

See the [participant guide](PARTICIPANTS.md) for the invitation, enrollment, ports and operating instructions. Use `npm run package:operator-kit` to build the standalone operator download.

The deployment controller still uses the host installer in this source checkout. Existing development launcher profiles remain accessible through `npm run join:legacy`. The [maintenance reference](LEGACY-MAINTENANCE.md) preserves the previous launcher, checkpoint, SDK and deployment documentation.
