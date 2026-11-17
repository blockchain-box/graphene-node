import { syncProgress } from './progress.js';
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name) =>
  '<img class="glyph" alt="" src="/icons/' + name + '.svg">';
const pages = {
  overview: [
    "Workspace",
    "Overview",
    "home",
    "Your networks and the nodes you run on this machine.",
  ],
  networks: [
    "Workspace",
    "Networks",
    "network",
    "Import an invitation from the operator of an existing Graphene network.",
  ],
  validator: [
    "Deployments",
    "Validator node",
    "shield-check",
    "Enroll a validator on a running network using its approved runtime bundle.",
  ],
  sentry: [
    "Deployments",
    "Sentry node",
    "server",
    "Run a nonvoting peer that relays blocks for the network.",
  ],
  activity: [
    "Operations",
    "Activity & logs",
    "layers",
    "Review node setup and runtime actions taken on this host.",
  ],
};
const labels = {
  dev: "Development",
  staging: "Staging",
  production: "Production",
};
const actionLabels = {
  import: "Network imported",
  identity: "Validator identity created",
  "prepare-validator": "Validator prepared",
  "prepare-sentry": "Sentry prepared",
  start: "Start node",
  stop: "Stop node",
};
let token = sessionStorage.getItem("participant-session") || "";
if (/^#[a-f0-9]{64}$/.test(location.hash)) {
  token = location.hash.slice(1);
  sessionStorage.setItem("participant-session", token);
  history.replaceState(null, "", location.pathname + location.search);
}
let state,
  selected,
  page,
  formAction,
  pending = false;
const observations = new Map();
const current = () => state?.networks.find((n) => n.id === selected);
const activeNode = () => current()?.nodes.find((n) => n.role === page);
const key = () => selected + ":" + page;
async function api(action, data) {
  const r = await fetch("/api/" + action, {
    method: data ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error);
  return value;
}
function feedback(s = "") {
  $("feedback").textContent = s;
  $("feedback").hidden = !s;
}
function theme(light) {
  document.documentElement.classList.toggle("light", light);
  $("theme").textContent = light ? "☾" : "☀";
  $("theme").ariaLabel = light
    ? "Switch to dark theme"
    : "Switch to light theme";
}
theme(localStorage.getItem("graphene-theme") === "light");
$("theme").onclick = () => {
  const light = !document.documentElement.classList.contains("light");
  theme(light);
  localStorage.setItem("graphene-theme", light ? "light" : "dark");
};
function menu(show) {
  document.body.classList.toggle("nav-open", show);
  $("scrim").hidden = !show;
  $("menu").ariaExpanded = String(show);
  if (show) $("network").focus();
  else $("menu").focus();
}
$("menu").onclick = () => menu(true);
$("scrim").onclick = () => menu(false);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("nav-open"))
    menu(false);
});
const btn = (action, label, primary = false) =>
  '<button data-action="' +
  action +
  '" class="' +
  (primary ? "primary" : "") +
  '">' +
  label +
  "</button>";
const tile = (p, desc) =>
  '<a class="tile btn" href="?page=' +
  p +
  '" data-page="' +
  p +
  '"><span class="iconbox">' +
  icon(pages[p][2]) +
  "</span><div><h3>" +
  pages[p][1] +
  "</h3><p>" +
  desc +
  "</p></div><b>›</b></a>";
const surface = (title, subtitle, body, action = "") =>
  '<section class="surface"><div class="section-head"><div><h2>' +
  title +
  "</h2><p>" +
  subtitle +
  "</p></div>" +
  action +
  "</div>" +
  body +
  "</section>";
const details = (rows) =>
  '<dl class="details">' +
  rows.map(([k, v]) => "<dt>" + k + "</dt><dd>" + esc(v) + "</dd>").join("") +
  "</dl>";
const empty = (s) => '<div class="empty">' + s + "</div>";
const summary = (label, value) =>
  '<div class="surface"><p class="eyebrow">' +
  label +
  '</p><div class="metric">' +
  esc(value) +
  "</div></div>";
const importCard = () =>
  surface(
    "Connect to a network",
    "Use the invitation file and checksum supplied by your network operator.",
    empty("No network selected. Import an invitation to enable node setup."),
    btn("import", "Import invitation", true),
  );
function overview(n) {
  const list = n?.nodes || [];
  return (
    '<div class="stats">' +
    summary("Networks", state.networks.length) +
    summary("Local nodes", list.length) +
    summary("Prepared", list.filter((x) => x.prepared).length) +
    "</div>" +
    (n
      ? surface(
          "Selected network",
          labels[n.stage] + " · Chain " + esc(n.chain),
          details([
            ["Release", n.release],
            ["Peer transport", n.privatePeers ? "Approved Grph tunnel" : "Public Tendermint (sentries)"],
        ["Primary peer", n.peer.split("@")[0]],
          ]),
          btn("networks", "View network"),
        )
      : importCard()) +
    surface(
      "Network nodes",
      "Choose the role you want to run on this host.",
      '<div class="tiles">' +
        tile(
          "validator",
          "Register an independent signer and connect through an approved sentry.",
        ) +
        tile(
          "sentry",
          "Prepare a nonvoting peer using this network’s transport policy.",
        ) +
        "</div>",
    )
  );
}
function networks(n) {
  if (!n) return importCard();
  return (
    surface(
      "Network details",
      "Verified against the invitation checksum.",
      details([
        ["Stage", labels[n.stage]],
        ["Chain ID", n.chain],
        ["Network ID", n.id],
        ["Release", n.release],
        ["Primary peer", n.peer],
        ["Wallet RPC", n.rpc],
      ]),
      btn("import", "Import invitation"),
    ) +
    surface(
      "Next step",
      "Choose a role to prepare a local node.",
      '<div class="tiles">' +
        tile("validator", "Enroll and install an admitted validator.") +
        tile("sentry", "Prepare and start a nonvoting sentry.") +
        "</div>",
    )
  );
}
const step = (num, title, hint, action) =>
  '<div class="step"><span class="step-num">' +
  num +
  "</span><div><h3>" +
  title +
  "</h3><p>" +
  hint +
  "</p></div>" +
  action +
  "</div>";
const badge = (s) => '<span class="badge">' + s + "</span>";
function rolePage(n) {
  if (!n) return importCard();
  const node = activeNode(),
    validator = page === "validator";
  if (node && !node.identity)
    return surface(
      "Identity incomplete",
      "Restore this node’s private directory from backup before continuing.",
      "",
    );
  const steps = validator
    ? step(
        "01",
        "Create your identity",
        "Generate signing keys on this host using your operator wallet address.",
        node
          ? btn("public", "Download public.json")
          : btn("identity", "Create identity", true),
      ) +
      step(
        "02",
        "Enroll with the network",
        "Send public.json to the network operator. Register with your wallet, request a sentry connection, and obtain the extracted admission bundle.",
        node?.prepared
          ? badge("Prepared")
          : node
            ? btn("prepare-validator", "Install bundle", true)
            : badge("Waiting for identity"),
      ) +
      step(
        "03",
        "Start and connect",
        "After startup, send the public receipt to the operator to finish the approved sentry connection.",
        node?.receipt
          ? btn("receipt", "Download receipt")
          : badge("Receipt after start"),
      )
    : step(
        "01",
        "Confirm the network",
        esc(labels[n.stage]) +
          " · Chain " +
          esc(n.chain) +
          " · " +
          esc(n.release),
        badge("Imported"),
      ) +
      step(
        "02",
        "Prepare the sentry",
        n.privatePeers ? "Generate the public request on this host. Your transport and node keys stay here." : "This network accepts direct Tendermint connections; it does not require Grph approval for sentries.",
        node?.prepared
          ? badge("Prepared")
          : btn("prepare-sentry", "Prepare sentry", true),
      );
  let html = surface(
    validator ? "Validator setup" : "Sentry setup",
    "Existing network · " + labels[n.stage],
    steps,
  );
  if (!validator && n.privatePeers && node?.identity) {
    html += surface("Apply to join as a sentry","Download the public request and give it to the network operator. Start your sentry to wait for the approved primary tunnel.",details([["Node ID",node.identity.node_id],["Grph tunnel key",node.identity.tunnel_key]]),btn("sentry-request","Download sentry application"));
  }
  if (validator && node?.identity) {
    const state = observations.get(key())?.enrollment;
    const hash = sessionStorage.getItem("participant-tx:" + key());
    const actions =
      btn("enrollment", "Check enrollment") +
      (state && !state.registered && state.balance !== "0.0"
        ? btn("register", "Register & stake")
        : state?.registered && !state.approved && !state.pending
          ? btn("request-sentry", "Request connection")
          : "") +
      (hash ? btn("tx-receipt", "Check transaction") : "");
    html += surface(
      "On-chain enrollment",
      "Use your operator wallet on chain " +
        esc(n.chain) +
        ". The network operator approves sentry requests.",
      details([
        ["Owner wallet", node.identity.operator_address],
        ["Wallet RPC", n.rpc],
        ...(state?.balance !== undefined ? [["Available balance", state.balance + " GRPH"]] : []),
        [
          "Enrollment",
          !state
            ? "Not checked"
            : state.approved
              ? "Sentry approved"
              : state.pending
                ? "Request pending"
                : state.registered
                  ? "Registered"
                  : "Unregistered",
        ],
        ...(hash ? [["Last submission", hash]] : []),
      ]) +
        (state?.balance === "0.0"
          ? "<p>Send GRPH on this network to the owner wallet above to cover the stake and transaction fees. Then check enrollment again.</p>"
          : "") +
        '<div class="buttons left">' +
        actions +
        "</div>",
    );
  }
  if (node?.prepared) {
    const obs = observations.get(key()) || {};
    html += surface(
      "Runtime",
      "Controls apply only to this local node.",
      details([
        ["Peer ID", node.identity.node_id],
        ...(validator ? [] : [["Peer connections", n.privatePeers ? "Approved primary via Grph" : node.identity.endpoint || "Outbound only"]]),
      ]) +
        '<div class="buttons left">' +
        btn("start", "Start node", true) +
        btn("stop", "Stop node") +
        btn("status", "Check services") +
        btn("health", "Check node health") +
        btn("logs", "View node logs") +
        "</div>" +
        (obs.status
          ? obs.status.length
            ? '<p>Services checked ' + esc(obs.statusAt ? new Date(obs.statusAt).toLocaleTimeString() : obs.at) + '</p>' + details(
                obs.status.map((r) => [
                  esc(r.service),
                  [r.state, r.health].filter(Boolean).join(" · "),
                ]),
              )
            : empty("No containers found for this node.")
          : "") +
        (obs.health
          ? '<p>Health checked ' + esc(new Date(obs.healthAt).toLocaleTimeString()) + '</p>' + details([
              ["Block height", obs.health.height],
              ["Primary peer", obs.health.primaryConnected ? "Connected" : "Disconnected"],
              ["Sync", obs.health.height === "0" ? "Waiting for first block" : obs.health.catchingUp ? "Catching up" : "Caught up"],
              ["Last block", obs.health.blockTime],
              ["Voting power", obs.health.votingPower],
              ...(obs.progress ? [["Replay speed", obs.progress.blocksPerSecond.toFixed(obs.progress.blocksPerSecond >= 1 ? 1 : 3) + " blocks/s"],
                ["100 blocks at this rate", "About " + Math.ceil(obs.progress.secondsPer100) + " seconds"]] : []),
            ])
          : "") +
        (obs.logs
          ? '<pre class="node-logs">' +
            esc(obs.logs.text || "No recent consensus or transport messages.") +
            "</pre>"
          : "") +
        (obs.at ? "<p>Last checked " + esc(obs.at) + "</p>" : ""),
    );
  }
  return html;
}
function activity(n) {
  const items = state.activity.filter((a) => !n || n.id === a.id);
  return surface(
    "Recent actions",
    "Most recent first · " + (n ? "Selected network" : "All networks"),
    items.length
      ? items
          .map(
            (a) =>
              '<div class="row"><div><h3>' +
              esc(actionLabels[a.action] || a.action) +
              "</h3><p>" +
              esc(
                [a.role, a.ok ? "Completed" : "Failed"]
                  .filter(Boolean)
                  .join(" · "),
              ) +
              '</p></div><time class="activity-time">' +
              esc(new Date(a.time).toLocaleString()) +
              "</time></div>",
          )
          .join("")
      : empty("No actions recorded yet."),
  );
}
function render() {
  const n = current(),
    p = pages[page];
  $("nav").innerHTML = Object.entries(pages)
    .map(
      ([id, [category, name, img]], i, all) =>
        (!i || all[i - 1][1][0] !== category
          ? '<p class="eyebrow">' + category + "</p>"
          : "") +
        '<a href="?page=' +
        id +
        '" data-page="' +
        id +
        '" ' +
        (page === id ? 'aria-current="page"' : "") +
        ">" +
        icon(img) +
        name +
        "</a>",
    )
    .join("");
  $("network").innerHTML = state.networks.length
    ? state.networks
        .map(
          (item) =>
            '<option value="' +
            item.id +
            '">' +
            esc(
              labels[item.stage] +
                " · " +
                item.chain +
                (state.networks.some(
                  (other) =>
                    other.id !== item.id &&
                    other.chain === item.chain &&
                    other.stage === item.stage,
                )
                  ? " · " + item.id.slice(0, 6)
                  : ""),
            ) +
            "</option>",
        )
        .join("")
    : "<option>No network imported</option>";
  if (n) $("network").value = n.id;
  $("crumb").textContent = n ? labels[n.stage] : "Local host";
  $("stage").textContent = n ? n.stage : "local";
  $("category").textContent = p[0];
  $("title").textContent = p[1];
  $("intro").textContent = p[3];
  $("content").innerHTML =
    page === "overview"
      ? overview(n)
      : page === "networks"
        ? networks(n)
        : page === "activity"
          ? activity(n)
          : rolePage(n);
  for (const b of $("content").querySelectorAll("button"))
    b.disabled = pending || state.busy;
}
function setRoute(push = true) {
  const url = new URL(location.href);
  url.searchParams.set("page", page);
  if (selected) url.searchParams.set("network", selected);
  else url.searchParams.delete("network");
  history[push ? "pushState" : "replaceState"](null, "", url);
}
function route() {
  const q = new URLSearchParams(location.search);
  page = Object.hasOwn(pages, q.get("page"))
    ? q.get("page")
    : state.defaultPage;
  const id =
    q.get("network") || localStorage.getItem("graphene-participant-network");
  selected = state.networks.some((n) => n.id === id)
    ? id
    : state.networks[0]?.id;
  render();
}
function go(p) {
  page = p;
  setRoute();
  feedback();
  if (document.body.classList.contains("nav-open")) menu(false);
  render();
  $("title").focus();
}
window.addEventListener("popstate", () => {
  if (state) {
    feedback();
    route();
  }
});
$("network").onchange = () => {
  selected = $("network").value;
  localStorage.setItem("graphene-participant-network", selected);
  setRoute();
  feedback();
  render();
};
async function refresh() {
  state = await api("state");
  route();
  $("gate").hidden = true;
  $("shell").hidden = false;
}
$("refresh").onclick = () =>
  refresh()
    .then(() => feedback("Dashboard refreshed."))
    .catch((e) => feedback(e.message));
function download(value, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const field = (name, label, type = "text", help = "", opts = "", required = true) =>
  '<label class="field">' +
  label +
  '<input name="' +
  name +
  '" type="' +
  type +
  (required ? '" required ' : '" ') +
  opts +
  ">" +
  (help ? "<small>" + help + "</small>" : "") +
  "</label>";
function dialog(action) {
  formAction = action;
  $("form-error").textContent = "";
  const data = {
    register: [
      "Register validator & stake",
      "Review the chain, wallet and stake before confirming the transaction in your wallet.",
      field(
        "amount",
        "Initial GRPH stake",
        "text",
        "Enter the amount you intend to stake.",
      ),
      "Review in wallet",
    ],
    "request-sentry": [
      "Request sentry connection",
      "Request an assignment to this network’s primary sentry. Network fees may apply.",
      "",
      "Review in wallet",
    ],
    import: [
      "Import network invitation",
      "Confirm the file fingerprint through a separate trusted channel with the network operator.",
      field(
        "file",
        "Invitation file",
        "file",
        "",
        'accept=".json,application/json"',
      ) +
        field(
          "fingerprint",
          "Invitation SHA-256",
          "text",
          "",
          'minlength="64" maxlength="64" pattern="[A-Fa-f0-9]{64}" spellcheck="false"',
        ),
      "Verify & import",
    ],
    identity: [
      "Create validator identity",
      "Keep the private directory and passphrase backed up on this host.",
      field(
        "operator",
        "Operator wallet address",
        "text",
        "Use the public address of the wallet that owns the stake.",
        'pattern="0x[a-fA-F0-9]{40}"',
      ) +
        field(
          "password",
          "Keystore passphrase",
          "password",
          "Use at least 32 characters.",
          'minlength="32" autocomplete="new-password"',
        ),
      "Create identity",
    ],
    "prepare-validator": [
      "Install admission bundle",
      "Use the extracted bundle issued for this validator by your deployment operator.",
      field(
        "bundle",
        "Absolute folder path",
        "text",
        "Choose the folder containing validator-admission.json.",
      ),
      "Install bundle",
    ],
    "prepare-sentry": [
      "Prepare sentry",
      current()?.privatePeers ? "The approved primary dials this host through Grph. No public peer port is needed." : "This host will connect to the primary sentry listed in the network invitation.",
      current()?.privatePeers ? "" : field(
        "address",
        "Advertised IPv4 address (optional)",
        "text",
        "Leave empty to sync locally. To serve other peers, enter your public IPv4 address and allow TCP 26656 and 26657.",
        "", false,
      ),
      "Prepare sentry",
    ],
    start: [
      "Start " + page,
      "Docker will pull the pinned release if needed and start services. Syncing can take time.",
      "",
      "Start node",
    ],
    stop: [
      "Stop " + page,
      page === "validator"
        ? "Stopping a voting validator interrupts consensus participation and can reduce rewards. Data and signing history stay on disk."
        : "Stopping this sentry interrupts peer connections. Data and identity stay on disk.",
      "",
      "Stop node",
    ],
  }[action];
  $("dialog-category").textContent =
    action === "import" ? "Network invitation" : "Node setup";
  $("dialog-title").textContent = data[0];
  $("fields").innerHTML =
    '<p class="dialog-copy">' + esc(data[1]) + "</p>" + data[2];
  if (["register", "request-sentry"].includes(action))
    $("fields").insertAdjacentHTML(
      "beforeend",
      details([
        ["Wallet", activeNode().identity.operator_address],
        ["Chain ID", current().chain],
        ["Contract", "0x0000000000000000000000000000000000000004"],
        ["Sentry", current().sentryId],
      ]),
    );
  $("submit").textContent = data[3];
  $("dialog").showModal();
}
$("close-dialog").onclick = $("cancel").onclick = () => $("dialog").close();
$("dialog").addEventListener("cancel", (e) => {
  if (pending) e.preventDefault();
});
$("dialog").addEventListener("close", () => {
  $("fields").replaceChildren();
});
$("form").onsubmit = async (e) => {
  e.preventDefault();
  if (pending) return;
  const data = new FormData(e.target),
    action = formAction;
  const body = { id: selected, role: page, ...Object.fromEntries(data) };
  pending = true;
  $("submit").disabled =
    $("cancel").disabled =
    $("close-dialog").disabled =
      true;
  const original = $("submit").textContent;
  $("submit").textContent = "Working…";
  $("form-error").textContent = "";
  try {
    if (action === "import") {
      if (data.get("file").size > 7 * 1024 * 1024)
        throw new Error("Choose an invitation smaller than 7 MiB.");
      body.raw = await data.get("file").text();
      body.fingerprint = body.fingerprint.trim().toLowerCase();
      delete body.file;
    }
    const result = await api(action, body);
    if (["register", "request-sentry"].includes(action)) {
      const w = window.ethereum;
      if (!w)
        throw new Error(
          "Open this private link in a browser with an Ethereum wallet.",
        );
      const accounts = await w.request({ method: "eth_requestAccounts" });
      if (
        accounts[0]?.toLowerCase() !== result.from ||
        BigInt(await w.request({ method: "eth_chainId" })) !==
          BigInt(result.chainId)
      )
        throw new Error(
          "Select this validator’s operator account and chain in your wallet.",
        );
      const hash = await w.request({
        method: "eth_sendTransaction",
        params: [result],
      });
      if (!/^0x[a-f0-9]{64}$/i.test(hash))
        throw new Error(
          "Check wallet activity before retrying. No transaction hash was returned.",
        );
      sessionStorage.setItem("participant-tx:" + key(), hash);
      observations.delete(key());
      $("dialog").close();
      feedback(
        "Transaction submitted. Check its receipt, then refresh enrollment.",
      );
      return;
    }
    if (action === "import") {
      selected = result.id;
      localStorage.setItem("graphene-participant-network", selected);
      setRoute(false);
    }
    observations.delete(key());
    $("dialog").close();
    await refresh();
    feedback((actionLabels[action] || action) + " · completed.");
  } catch (error) {
    $("form-error").textContent = error.message;
  } finally {
    pending = false;
    $("submit").disabled =
      $("cancel").disabled =
      $("close-dialog").disabled =
        false;
    $("submit").textContent = original;
    render();
  }
};
document.addEventListener("click", async (e) => {
  const link = e.target.closest("[data-page]");
  if (link) {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    go(link.dataset.page);
    return;
  }
  const b = e.target.closest("[data-action]");
  if (!b || pending) return;
  const action = b.dataset.action;
  if (action === "networks") return go(action);
  if (action === "sentry-request") return download(activeNode().identity, "sentry-application.json");
  if (action === "public" || action === "receipt")
    return download(
      action === "public" ? activeNode().identity : activeNode().receipt,
      action === "public" ? "public.json" : "home-ready.json",
    );
  if (action === "tx-receipt") {
    try {
      const w = window.ethereum;
      if (
        !w ||
        BigInt(await w.request({ method: "eth_chainId" })) !==
          BigInt(current().chain)
      )
        throw new Error("Connect your wallet to the selected chain.");
      const receipt = await w.request({
        method: "eth_getTransactionReceipt",
        params: [sessionStorage.getItem("participant-tx:" + key())],
      });
      feedback(
        !receipt
          ? "Transaction pending."
          : receipt.status === "0x1"
            ? "Transaction confirmed. Check enrollment for the current state."
            : "Transaction failed. Check your wallet activity.",
      );
    } catch (err) {
      feedback(err.message);
    }
    return;
  }
  if (["status", "health", "logs", "enrollment"].includes(action)) {
    pending = true;
    const k = key();
    render();
    feedback(
      "Checking " +
        (action === "status"
          ? "services"
          : action === "health"
            ? "node health"
            : action === "logs"
              ? "node logs"
              : "on-chain enrollment") +
        "…",
    );
    try {
      const value = await api(action, { id: selected, role: page });
      const previous = observations.get(k) || {}, at = Date.now();
      observations.set(k, {
        ...previous,
        [action]: value,
        [action + 'At']: at,
        ...(action === 'health' ? {progress: syncProgress(previous.health, value, previous.healthAt, at)} : {}),
        at: new Date().toLocaleTimeString(),
      });
      feedback("Check complete.");
    } catch (err) {
      observations.delete(k);
      feedback(err.message);
    } finally {
      pending = false;
      render();
    }
    return;
  }
  dialog(action);
});
if (token)
  refresh().catch((e) => {
    $("gate-error").textContent = e.message;
  });
