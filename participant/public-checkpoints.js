import { publicJsonFromUrl } from "./invitation-api.js";
import { verifySelection } from "./checkpoint.js";

// The same HTTPS API that supplies the invitation is the trust anchor for its
// current signed checkpoint. Never accept an arbitrary download URL from the UI.
export class PublicCheckpoints {
  constructor(fetchJson = publicJsonFromUrl, now = Date.now) {
    this.fetchJson = fetchJson;
    this.now = now;
    this.cache = new Map();
  }
  async lookup(invite, force = false) {
    const key = JSON.stringify([
      invite.rpc,
      invite.network,
      invite.genesis,
      invite.images,
      invite.checkpoint,
    ]);
    const cached = this.cache.get(key);
    if (!force && cached && this.now() - cached.at < 60000) return cached.value;
    let value;
    try {
      const url = new URL(
        invite.checkpoint?.url || "/checkpoints/latest.json",
        invite.rpc,
      );
      if (
        url.protocol !== "https:" ||
        url.origin !== new URL(invite.rpc).origin ||
        url.pathname !== "/checkpoints/latest.json" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw Error(
          "The checkpoint must come from this network’s public HTTPS API.",
        );
      const raw = await this.fetchJson(url.href, "/checkpoints/latest.json");
      const envelope = JSON.parse(raw);
      const fingerprint =
        invite.checkpoint?.fingerprint || envelope.fingerprint;
      const baseUrl = new URL(
        "/checkpoints/" + envelope.manifest?.id + "/",
        url,
      ).href;
      const selection = verifySelection(invite, raw, fingerprint, baseUrl);
      const { id, height, createdAt, release } = selection.envelope.manifest;
      value = {
        available: true,
        id,
        height,
        createdAt,
        release,
        fingerprint,
        baseUrl,
        raw,
      };
    } catch (error) {
      value = {
        available: false,
        error: /HTTP 404/.test(error.message)
          ? "This public network has not published a current checkpoint. You can replay from genesis."
          : "No verified current checkpoint is available: " + error.message,
      };
    }
    this.cache.set(key, { at: this.now(), value });
    return value;
  }
  summary(value) {
    const { raw, ...summary } = value;
    return summary;
  }
}
