import {
  pages,
  routePath,
  routeState,
  navigateRoute,
  navigatePath,
  subscribeRoutes,
} from "./routes.js";
import { activityView } from "./activity.js";
import { syncProgress } from "./progress.js";
import { deploymentSteps, stageIds } from "./deployment-steps.js";
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

const labels = {
  dev: "Development",
  staging: "Staging",
  production: "Production",
};
const actionLabels = {
  inspect: "Inspect server",
  status: "Check services",
  health: "Check node health",
  logs: "Read server logs",
  "network-health": "Check network health",
  "workspace-update": "Network invitation updated",
  "remove-node": "Node and owned resources removed",
  "cloud-account-save": "Cloud credential saved",
  "create-node": "Node deployment created",
  import: "Network imported",
  "import-url": "Network imported from sentry",
  identity: "Validator identity created",
  "prepare-validator": "Validator prepared",
  "prepare-validator-public": "Validator runtime prepared from invitation",
  "prepare-sentry": "Sentry prepared",
  host: "Deployment host saved",
  review: "Deployment reviewed",
  "host-install": "Cloud runtime installed",
  connection: "Public sentry connection saved",
  "checkpoint-select": "Checkpoint selected",
  "checkpoint-current": "Current public checkpoint selected",
  "checkpoint-restore": "Checkpoint restored",
  start: "Start node",
  stop: "Stop node",
};
let token = sessionStorage.getItem("participant-session") || "";
if (/^#[a-f0-9]{64}$/.test(location.hash)) {
  token = location.hash.slice(1);
  sessionStorage.setItem("participant-session", token);
  history.replaceState(history.state, "", location.pathname + location.search);
}
let state,
  selected,
  page,
  formAction,
  pending = false;
let removalReview = null;
const observations = new Map();
const healthReports = new Map();
let autoHealth = false;
let activitySearch = "",
  activityStatus = "all",
  activityOperation = "all",
  activityType = "all";
let activitySelection = "",
  activityLog = null,
  activityLogTarget = "";
let activityServer = "all",
  activitySort = "newest",
  activityTarget = "",
  activityLogSearch = "";
let activityWrap = false,
  activityFollow = true,
  activityHistoryOpen = false;
let pollingJobs = false,
  launchingJob = false;
const backgroundActions = new Set([
  "host",
  "host-install",
  "identity",
  "prepare-validator",
  "prepare-validator-public",
  "prepare-sentry",
  "connection",
  "review",
  "checkpoint-select",
  "checkpoint-current",
  "checkpoint-restore",
  "start",
  "stop",
  "remove-node",
]);
let healthSearch = "",
  healthRole = "all",
  healthFilter = "all";
const runKey = (run) =>
  run.runId || [run.time, run.action, run.nodeId || ""].join(":");
const runType = (action) =>
  /^(host|cloud|ssh)/.test(action)
    ? "infrastructure"
    : /^(import|workspace)/.test(action)
      ? "network"
      : "node";
const selectOptions = (items, value) =>
  items
    .map(
      ([id, label]) =>
        '<option value="' +
        esc(id) +
        '" ' +
        (id === value ? "selected" : "") +
        ">" +
        esc(label) +
        "</option>",
    )
    .join("");
const filterSelect = (id, label, items, value) =>
  '<label class="field">' +
  label +
  '<select id="' +
  id +
  '">' +
  selectOptions(items, value) +
  "</select></label>";
const healthLabels = {
  healthy: "Healthy",
  attention: "Needs attention",
  stale: "Needs verification",
  unchecked: "Not checked",
  "not-installed": "Not installed",
};
const healthBadge = (status) =>
  '<span class="badge health-' +
  esc(status) +
  '">' +
  esc(healthLabels[status] || status) +
  "</span>";

function workspaceNetworks() {
  const networks = state?.networks || [];
  const publicIds = new Set(
    (state?.workspaces || [])
      .map((workspace) => workspace.networkId)
      .filter(Boolean),
  );
  return [
    ...(state?.workspaces || []).map((workspace) => {
      const network = networks.find(
        (network) => network.id === workspace.networkId,
      );
      return {
        ...(network || { nodes: [], hosts: {} }),
        id: "workspace-" + workspace.id,
        networkId: network?.id || null,
        workspaceId: workspace.id,
        name: workspace.label,
        stage: workspace.stage,
        api: workspace.api,
        invitationUrl: workspace.invitationUrl,
        workspaceError: workspace.error,
        workspaceUpdate: workspace.update,
        checkedAt: workspace.checkedAt,
      };
    }),
    ...networks.filter((network) => !publicIds.has(network.id)),
  ];
}
const current = () => {
  const network = workspaceNetworks().find((n) => n.id === selected);
  const nodeId = routeState().node;
  const node = network?.nodes.find(
    (node) => node.nodeId === nodeId && node.role === page,
  );
  return node?.invitation
    ? {
        ...network,
        ...node.invitation,
        publicPeer:
          node.connection?.mode === "public"
            ? node.connection.peer
            : node.invitation.publicPeer,
        publicCheckpoint: node.publicCheckpoint,
      }
    : network;
};
const selectedNodeId = () => routeState().node;
const activeNode = () =>
  current()?.nodes.find(
    (n) => n.role === page && n.nodeId === selectedNodeId(),
  );
const activeHost = () => current()?.hosts?.[selectedNodeId() || page];
const key = () => selected + ":" + page + ":" + (selectedNodeId() || "");
async function api(action, data, options = {}) {
  if (data?.id?.startsWith("workspace-")) {
    const workspace = workspaceNetworks().find(
      (network) => network.id === data.id,
    );
    if (!workspace?.networkId)
      throw new Error(
        "This public workspace is unavailable. Retry its API connection before creating nodes.",
      );
    data = { ...data, id: workspace.networkId };
  }
  if (data?.id && data.role && selectedNodeId() && !data.nodeId)
    data = { ...data, nodeId: selectedNodeId() };
  const r = await fetch("/api/" + action, {
    method: data ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      ...(options.background ? { Prefer: "respond-async" } : {}),
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
  '<a class="tile btn" href="' +
  esc(routePath({ workspace: selected, page: p })) +
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
function publicWorkspaceCards() {
  return surface(
    "Public network workspaces",
    "Each public API is a separate workspace. Network identity, genesis, pinned images and sentry peer are fetched automatically; no invitation file or checksum entry is needed.",
    '<div class="tiles">' +
      workspaceNetworks()
        .filter((network) => network.workspaceId)
        .map(
          (network) =>
            '<a class="tile btn" href="' +
            esc(routePath({ workspace: network.id, page: "overview" })) +
            '"><div><h3>' +
            esc(network.name) +
            "</h3><p>" +
            esc(network.api) +
            "</p><p>" +
            esc(
              network.workspaceUpdate
                ? "Network update available"
                : network.networkId
                  ? network.workspaceError
                    ? "Cached network · API unavailable"
                    : "Ready to join"
                  : "API unavailable",
            ) +
            "</p></div></a>",
        )
        .join("") +
      "</div>",
  );
}
function workspaceUnavailable(n) {
  return surface(
    esc(n.name) + " public network",
    n.api,
    '<p role="alert">' +
      esc(n.workspaceError || "Network invitation has not been loaded yet.") +
      "</p>" +
      '<p class="dialog-copy">The API must publish its public network invitation at ' +
      esc(n.invitationUrl) +
      ". Retry to load this workspace automatically.</p>",
    btn("workspace-refresh", "Retry public API", true),
  );
}
const importCard = () => publicWorkspaceCards();

function overview(n) {
  const list = n?.nodes || [];
  return (
    '<div class="stats">' +
    summary("Networks", workspaceNetworks().length) +
    summary("Node deployments", list.length) +
    summary("Prepared", list.filter((x) => x.prepared).length) +
    "</div>" +
    (n
      ? surface(
          "Selected network",
          (n.name || labels[n.stage]) + " · Chain " + esc(n.chain),
          details([
            ["Release", n.release],
            [
              "Peer transport",
              n.publicPeer
                ? "Public Tendermint"
                : n.privatePeers
                  ? "Approved Grph upstream"
                  : "Public Tendermint",
            ],
            ["Sentry peer", n.publicPeer || n.peer],
          ]),
          btn("networks", "View network"),
        )
      : importCard()) +
    surface(
      "Network nodes",
      "Choose a role, a local or cloud host, and its network connection.",
      '<div class="tiles">' +
        tile(
          "validator",
          "Register an independent signer and connect through an approved sentry.",
        ) +
        tile(
          "sentry",
          "Deploy a public sentry with a domain and read-only chain gateway.",
        ) +
        "</div>",
    )
  );
}
function networks(n) {
  if (!n) return importCard();
  if (n.workspaceId && !n.networkId)
    return publicWorkspaceCards() + workspaceUnavailable(n);
  return (
    publicWorkspaceCards() +
    surface(
      "Network details",
      n.workspaceId
        ? "Loaded automatically from this workspace’s HTTPS public sentry API."
        : "Verified against the invitation checksum.",
      details([
        ["Stage", labels[n.stage]],
        ["Chain ID", n.chain],
        ["Network ID", n.networkId || n.id],
        ["Release", n.release],
        ["Sentry peer", n.publicPeer || n.peer],
        ["Wallet RPC", n.rpc],
        [
          "Current public checkpoint",
          n.publicCheckpoint?.available
            ? "Block " +
              n.publicCheckpoint.height +
              " · " +
              n.publicCheckpoint.createdAt
            : n.publicCheckpoint?.error || "Checking public network",
        ],
      ]),
      n.workspaceId ? btn("workspace-refresh", "Refresh public network") : "",
    ) +
    surface(
      "Next step",
      "Choose a role and its deployment host.",
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
function selectedStep(n, node) {
  const requested = routeState().step;
  if (stageIds.includes(requested)) return stageIds.indexOf(requested);
  if (!activeHost()?.configured && !node) return 0;
  return !node?.prepared ? 1 : 2;
}
function hostCard(n, role) {
  const host = activeHost() || { kind: "local" };
  return surface(
    "Deployment host",
    "Choose the same local or prepared-cloud-host path used by the deployment console.",
    details([
      [
        "Target",
        host.kind === "cloud"
          ? providerLabels[host.provider] || host.provider
          : "Local Docker Engine",
      ],
      [
        "Host",
        host.kind === "cloud"
          ? host.user + "@" + host.address + ":" + host.port
          : "This computer",
      ],
      [
        "Identity storage",
        host.kind === "cloud"
          ? "Private directory on the cloud host"
          : "Private directory on this computer",
      ],
      [
        "Runtime",
        host.kind === "cloud"
          ? host.installed
            ? "Installed"
            : "Install required"
          : "Bundled with this console",
      ],
    ]) +
      (host.error ? '<p role="alert">' + esc(host.error) + "</p>" : "") +
      "<p>Cloud hosts need Linux, Node.js 24+, npm, Python 3 and Docker Compose. Use an existing provider host and its verified SSH host-key file. Private validators can be reached through your SSH alias, VPN or Access proxy.</p>",
    (!activeNode()?.hasData && !host.installed
      ? btn("host", "Choose deployment host", true)
      : "") +
      (host.kind === "cloud" && !host.installed
        ? btn("host-install", "Install participant runtime", true)
        : "") +
      ((host.configured || activeNode()?.hasData) &&
      (host.kind === "local" || host.installed)
        ? '<button data-step="chain" class="primary">Continue to network & identity →</button>'
        : ""),
  );
}
const providerLabels = {
  hetzner: "Hetzner",
  aws: "AWS",
  gcp: "Google Cloud",
  azure: "Microsoft Azure",
  digitalocean: "DigitalOcean",
  other: "Other cloud",
};
function cloudAccountsCard() {
  const accounts = state.cloudAccounts?.accounts || [];
  return surface(
    "Cloud credentials",
    "Save named provider accounts to review and delete the dedicated VM and cloud resources of a removed node. Secrets stay on this computer.",
    accounts.length
      ? accounts
          .map(
            (account) =>
              '<div class="row"><div><h3>' +
              esc(account.name) +
              "</h3><p>" +
              esc(providerLabels[account.provider]) +
              '</p></div><button data-action="cloud-account-edit" data-account-id="' +
              account.id +
              '">Edit</button></div>',
          )
          .join("")
      : empty("No cloud credentials saved."),
    btn("cloud-account-open", "Add cloud credential", true),
  );
}
function settingsPage(n) {
  const tabs = [
    ["network", "Network"],
    ["version", "Deployment version"],
    ["nodes", "Node hosts"],
    ["credentials", "Credentials"],
  ];
  const requested = routeState().tab;
  const tab = tabs.some(([id]) => id === requested) ? requested : "network";
  const navigation =
    '<nav class="settings-tabs" aria-label="Settings sections">' +
    tabs
      .map(
        ([id, label]) =>
          '<a class="btn" href="' +
          esc(routePath({ workspace: selected, page: "settings", tab: id })) +
          '" ' +
          (tab === id ? 'aria-current="page"' : "") +
          ">" +
          label +
          "</a>",
      )
      .join("") +
    "</nav>";
  if (tab === "credentials")
    return (
      navigation + '<p class="eyebrow">All workspaces</p>' + cloudAccountsCard()
    );
  if (!n || (n.workspaceId && !n.networkId))
    return (
      navigation + empty("Select an available network to view its settings.")
    );
  const description =
    tab === "network"
      ? "Configure the selected network, infrastructure and access."
      : tab === "version"
        ? "The verified network invitation selects the shared runtime release for new nodes."
        : "Configure local or cloud hosts for individual nodes in this network.";
  return (
    navigation +
    '<p class="eyebrow">' +
    esc(n.name || n.stage) +
    " workspace</p><p>" +
    description +
    "</p>" +
    (tab === "nodes"
      ? surface(
          "Node hosts",
          "Select a node to configure its host and access.",
          n.nodes
            .map(
              (node) =>
                '<div class="row"><div><h3>' +
                esc(node.name || node.role) +
                "</h3><p>" +
                esc(n.hosts?.[node.nodeId]?.address || "Local Docker Engine") +
                '</p></div><a class="btn" href="' +
                esc(
                  routePath({
                    workspace: n.id,
                    page: node.role,
                    node: node.nodeId,
                    step: "configuration",
                  }),
                ) +
                '">Configure host</a></div>',
            )
            .join("") || empty("No nodes yet."),
        )
      : surface(
          tab === "version" ? "Deployment version" : "Network settings",
          "The public invitation pins this workspace’s genesis and release.",
          details([
            ["Network ID", n.networkId || n.id],
            ["Release", n.release],
            ["Chain ID", n.chain],
            ["Public sentry API", n.api || "Imported invitation"],
          ]) +
            (tab === "network"
              ? '<div class="tiles">' +
                tile(
                  "validator",
                  "Configure private validator hosts and public sentry connections.",
                ) +
                tile("sentry", "Configure public sentry hosts and domains.") +
                "</div>"
              : "<p>Existing nodes retain their pinned release. Review available invitation updates before creating new nodes.</p>"),
        ))
  );
}
function healthNodeState(row) {
  return row?.checkedAt && Date.now() - Date.parse(row.checkedAt) > 60000
    ? "stale"
    : row?.status || "unchecked";
}
function monitorPage(n) {
  if (!n) return importCard();
  const report = healthReports.get(n.networkId || n.id);
  const stale = report && Date.now() - Date.parse(report.checkedAt) > 60000;
  const overall = !report
    ? "unchecked"
    : stale
      ? "stale"
      : report.checks.every((c) => c.status === "healthy")
        ? "healthy"
        : "attention";
  const rows = n.nodes.map((node) => ({
    node,
    observation: report?.nodes.find((row) => row.nodeId === node.nodeId),
  }));
  const visible = rows.filter(({ node, observation }) => {
    const status = healthNodeState(observation);
    return (
      (healthRole === "all" || node.role === healthRole) &&
      (healthFilter === "all" ||
        (healthFilter === "attention"
          ? ["attention", "stale"].includes(status)
          : healthFilter === "pending"
            ? ["unchecked", "not-installed"].includes(status)
            : status === healthFilter)) &&
      [
        node.name,
        node.nodeId,
        n.hosts?.[node.nodeId]?.address,
        n.hosts?.[node.nodeId]?.provider,
      ]
        .join(" ")
        .toLowerCase()
        .includes(healthSearch.toLowerCase())
    );
  });
  const consensus = report?.checks.find((c) => c.label === "Consensus");
  return (
    surface(
      "Public network health",
      "Check the expected network, recent consensus blocks and public API responses.",
      healthBadge(overall) +
        '<p role="status">' +
        (report
          ? "Observed " + esc(new Date(report.checkedAt).toLocaleString())
          : "No completed gateway check") +
        " · " +
        (autoHealth
          ? "Automatic checks every 30 seconds"
          : "Automatic checks paused") +
        "</p>",
      btn(
        "health-auto",
        autoHealth ? "Pause auto checks" : "Resume auto checks",
      ) + btn("network-health", "Check now", true),
    ) +
    '<div class="health-metrics">' +
    [
      ["Consensus height", consensus?.height ?? "—"],
      [
        "Consensus response",
        consensus?.latencyMs === undefined ? "—" : consensus.latencyMs + " ms",
      ],
      [
        "Healthy nodes",
        rows.filter((r) => healthNodeState(r.observation) === "healthy")
          .length +
          " / " +
          rows.length,
      ],
      [
        "Nodes needing attention",
        rows.filter((r) =>
          ["attention", "stale"].includes(healthNodeState(r.observation)),
        ).length,
      ],
    ]
      .map(
        ([label, value]) =>
          '<div class="surface metric"><p>' +
          label +
          "</p><strong>" +
          esc(value) +
          "</strong></div>",
      )
      .join("") +
    "</div>" +
    surface(
      "Public gateway checks",
      "Expected network: graphene-" + esc(n.stage) + "-" + esc(n.chain),
      report
        ? '<div class="health-checks">' +
            report.checks
              .map(
                (check) =>
                  '<div class="check-card"><h3>' +
                  esc(check.label) +
                  " " +
                  healthBadge(stale ? "stale" : check.status) +
                  "</h3><p>" +
                  esc(
                    check.message ||
                      (check.status === "healthy"
                        ? "Expected network verified."
                        : "Check block freshness and synchronization."),
                  ) +
                  "</p><code>" +
                  esc(check.url) +
                  "</code>" +
                  details([
                    ["Block height", check.height ?? "—"],
                    [
                      "Response",
                      check.latencyMs === undefined
                        ? "—"
                        : check.latencyMs + " ms",
                    ],
                  ]) +
                  "</div>",
              )
              .join("") +
            "</div><p>Block freshness warns after 120 seconds. These checks do not prove validator quorum or P2P port reachability.</p>"
        : empty(
            "Run checks to verify the public consensus endpoint and sentry API.",
          ),
    ) +
    surface(
      "Node health",
      "Validators use the configured private Docker or SSH connection. Installation alone does not mark a node healthy.",
      '<div class="filter-bar"><label class="field">Find a node<input id="health-search" type="search" placeholder="Name, host or provider" value="' +
        esc(healthSearch) +
        '"></label>' +
        filterSelect(
          "health-role",
          "Role",
          [
            ["all", "All roles"],
            ["validator", "Validators"],
            ["sentry", "Sentries"],
          ],
          healthRole,
        ) +
        filterSelect(
          "health-filter",
          "Health",
          [
            ["all", "All states"],
            ["healthy", "Healthy"],
            ["attention", "Needs attention"],
            ["pending", "Not checked / installed"],
          ],
          healthFilter,
        ) +
        '</div><div class="table-scroll"><table class="health-table"><caption class="sr-only">Node health observations</caption><thead><tr><th>Node</th><th>Provider / host</th><th>Health</th><th>Block height</th><th>Last observation</th><th>Manage</th></tr></thead><tbody>' +
        visible
          .map(
            ({ node, observation }) =>
              "<tr><td><strong>" +
              esc(node.name || node.role) +
              "</strong><p>" +
              esc(node.role) +
              "</p></td><td>" +
              esc(providerLabels[n.hosts?.[node.nodeId]?.provider] || "Local") +
              "<p>" +
              esc(n.hosts?.[node.nodeId]?.address || "Docker Engine") +
              "</p></td><td>" +
              healthBadge(healthNodeState(observation)) +
              "<p>" +
              esc(observation?.message || "") +
              "</p></td><td>" +
              esc(observation?.health?.height ?? "—") +
              "</td><td>" +
              esc(
                observation?.checkedAt
                  ? new Date(observation.checkedAt).toLocaleTimeString()
                  : "Not checked",
              ) +
              '</td><td><a class="btn" href="' +
              esc(
                routePath({
                  workspace: n.id,
                  page: node.role,
                  node: node.nodeId,
                  step: "monitor",
                }),
              ) +
              '">Manage</a></td></tr>',
          )
          .join("") +
        "</tbody></table></div>" +
        (!visible.length ? empty("No nodes match these filters.") : ""),
    )
  );
}
function nodeList(n) {
  const nodes = n.nodes.filter((node) => node.role === page);
  const plural = page === "validator" ? "validators" : "sentries";
  return surface(
    page === "validator" ? "Validator nodes" : "Sentry nodes",
    nodes.length +
      " " +
      plural +
      " on this network. Every node has its own host, identity, data and service controls.",
    nodes.length
      ? nodes
          .map((node) => {
            const host = n.hosts?.[node.nodeId];
            return (
              '<div class="row"><div><h3>' +
              esc(node.name) +
              "</h3><p>" +
              esc(
                host?.kind === "cloud"
                  ? (providerLabels[host.provider] || host.provider) +
                      " · " +
                      host.address
                  : "Local Docker Engine",
              ) +
              " · " +
              esc(
                node.prepared
                  ? "Prepared"
                  : node.identity
                    ? "Identity created"
                    : "Setup pending",
              ) +
              '</p></div><div class="buttons left"><a class="btn" href="' +
              esc(routePath({ workspace: n.id, page, node: node.nodeId })) +
              '">Manage node</a><button data-action="server-inspect" data-node-id="' +
              node.nodeId +
              '">Inspect server</button><button class="danger" data-action="remove-node" data-node-id="' +
              node.nodeId +
              '">Remove node</button></div></div>'
            );
          })
          .join("")
      : empty(
          "No " +
            plural +
            " yet. Create a node to choose its host and begin setup.",
        ),
    btn(
      "create-node",
      page === "validator" ? "New validator" : "New sentry",
      true,
    ),
  );
}
function rolePage(n) {
  if (!n) return importCard();
  if (!selectedNodeId() || !activeNode()) return nodeList(n);
  const node = activeNode()?.hasData ? activeNode() : undefined,
    validator = page === "validator";
  const phase = selectedStep(n, node);
  const navigation = deploymentSteps(phase, [
    ...(node?.identity ? [0] : []),
    ...(node?.prepared ? [1] : []),
    ...(node?.restore?.phase === "complete" ? [2] : []),
  ]);
  if (phase === 0) return navigation + hostCard(n, page);
  const host = activeHost();
  if (host?.error) return navigation + hostCard(n, page);
  if (host?.kind === "cloud" && !host.installed)
    return navigation + hostCard(n, page);
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
        n.publicPeer
          ? "Use the verified invitation to prepare the pinned runtime and public sentry connection automatically. Register and stake with your wallet to request voting participation."
          : "This invitation advertises private transport but no public sentry peer. The network must publish a public upstream before this node can join directly. Its network data is already loaded; no bundle folder is required here.",
        node?.prepared
          ? badge("Prepared")
          : node
            ? n.publicPeer
              ? btn("prepare-validator-public", "Prepare from invitation", true)
              : badge("Waiting for public sentry")
            : badge("Waiting for identity"),
      ) +
      step(
        "03",
        "Start and connect",
        "Start synchronization after reviewing the deployment. Voting power requires the network’s normal on-chain registration and admission.",
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
        n.publicPeer
          ? "Use your sentry’s public domain. The upstream connection comes automatically from the network invitation; no Grph approval is needed."
          : n.privatePeers
            ? "Use your sentry’s public domain and the invitation’s approved Grph upstream."
            : "This network accepts direct Tendermint connections; it does not require Grph approval for sentries.",
        node?.prepared
          ? badge("Prepared")
          : btn("prepare-sentry", "Prepare sentry", true),
      );
  let html = surface(
    validator ? "Validator setup" : "Sentry setup",
    "Existing network · " + labels[n.stage],
    steps,
  );
  html = phase === 1 ? html : "";
  if (
    phase === 1 &&
    !validator &&
    n.privatePeers &&
    node?.identity &&
    node.connection?.mode !== "public"
  ) {
    html += surface(
      "Apply to join as a sentry",
      "Download the public request and give it to the network operator. Start your sentry to wait for the approved primary tunnel.",
      details([
        ["Node ID", node.identity.node_id],
        ["Grph tunnel key", node.identity.tunnel_key],
      ]),
      btn("sentry-request", "Download sentry application"),
    );
  }
  if (phase === 1 && validator && node?.identity) {
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
        ...(state?.balance !== undefined
          ? [["Available balance", state.balance + " GRPH"]]
          : []),
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
  if (phase === 1 && !validator && node?.invitationFingerprint) {
    html += surface(
      "Invite validators & sentries",
      "Share this API URL and confirm its SHA-256 independently. It contains only public network and peer data.",
      details([
        [
          "Invitation API",
          "http://" +
            node.connection.domain +
            ":" +
            (node.connection.rpcPort || 26657) +
            "/api/invitation",
        ],
        ["Invitation SHA-256", node.invitationFingerprint],
      ]),
      btn("sentry-invitation", "Download invitation JSON"),
    );
  }
  if (phase === 1 && node?.prepared) {
    html += surface(
      "Network connection",
      validator
        ? "The validator has no published ports. It connects outbound to a public sentry."
        : "Publish this domain as a DNS-only record pointing to your host or router. Forward this node’s selected P2P and RPC ports.",
      details(
        validator
          ? [
              ["Sentry peer", node.connection?.peer || "Not configured"],
              ["Validator ingress", "No published ports"],
            ]
          : [
              [
                "Public domain / IP",
                node.connection?.domain || node.identity.endpoint,
              ],
              [
                "P2P",
                node.identity.node_id +
                  "@" +
                  (node.connection?.domain || "your-domain") +
                  ":" +
                  (node.connection?.p2pPort || 26656),
              ],
              [
                "Read-only RPC",
                "http://" +
                  (node.connection?.domain || "your-domain") +
                  ":" +
                  (node.connection?.rpcPort || 26657),
              ],
            ],
      ),
      (validator && !node.connection
        ? btn(
            "connection",
            n.publicPeer
              ? "Use sentry from invitation"
              : "Configure public sentry",
            true,
          )
        : "") +
        '<button data-step="runtime">Continue to checkpoint & install →</button>',
    );
  }
  if (phase >= 2 && !node?.prepared)
    html =
      empty("Complete Network & identity before installing this node.") +
      '<button data-step="chain">Go to network & identity</button>';
  if (
    phase === 2 &&
    node?.prepared &&
    validator &&
    node.connection?.mode !== "public"
  )
    return (
      navigation +
      surface(
        "Public sentry connection required",
        "Configure the private validator’s upstream peer before installing.",
        "",
        '<button data-step="chain">Configure network connection</button>',
      )
    );
  if (phase >= 2 && node?.prepared) {
    const cp = node.checkpoint;
    if (phase === 2)
      html += surface(
        "Review deployment",
        "Review the pinned release, upstream peer and published ports before starting containers.",
        node.deployment
          ? details([
              ["Release", node.deployment.release],
              ["Upstream peer", node.deployment.peer],
              ["Services", node.deployment.services.join(", ")],
              [
                "Published ports",
                node.deployment.ports.join("; ") || "None · private validator",
              ],
              ["Data directory on target host", node.deployment.storage],
              ["Configuration fingerprint", node.deployment.fingerprint],
            ])
          : empty(
              "Review the deployment to confirm its service topology and port exposure.",
            ),
        btn("review", "Review deployment", true),
      );
    if (phase === 2)
      html += surface(
        "Fast checkpoint sync",
        "Restore a signed full snapshot before the first start. The publisher, frozen network, release images and downloaded bytes are verified. Keep your own identity and signing history.",
        cp
          ? details([
              ["Selected block", cp.height],
              ["Checkpoint", cp.id],
              ["Publisher fingerprint", cp.fingerprint],
              ["Restore", node.restore?.phase || "Ready to restore"],
            ])
          : n.publicCheckpoint?.available
            ? details([
                ["Current public block", n.publicCheckpoint.height],
                ["Published", n.publicCheckpoint.createdAt],
                ["Publisher", n.publicCheckpoint.fingerprint],
              ])
            : "<p>" +
              esc(
                n.publicCheckpoint?.error ||
                  "Checking the public network for a current checkpoint.",
              ) +
              "</p>",
        (!node.restore && n.publicCheckpoint?.available
          ? btn(
              "checkpoint-current",
              cp ? "Use current public checkpoint" : "Use public checkpoint",
              true,
            )
          : "") +
          (cp && node.restore?.phase !== "complete"
            ? btn(
                "checkpoint-restore",
                node.restore
                  ? "Retry checkpoint restore"
                  : "Restore checkpoint & start",
                true,
              )
            : ""),
      );
    const obs = observations.get(key()) || {};
    html += surface(
      "Runtime",
      "Controls apply only to the selected deployment host. Validator ports remain private; sentries publish P2P and bounded read-only RPC.",
      details([
        ["Peer ID", node.identity.node_id],
        ...(validator
          ? []
          : [
              [
                "Public peer endpoint",
                node.identity.endpoint ||
                  node.connection?.domain ||
                  "Legacy configuration",
              ],
            ]),
      ]) +
        '<div class="buttons left">' +
        btn("start", "Start node", true) +
        btn("stop", "Stop node") +
        btn("server-inspect", "Inspect server") +
        btn("status", "Check services") +
        btn("health", "Check node health") +
        btn("logs", "View node logs") +
        "</div>" +
        (obs.status
          ? obs.status.length
            ? "<p>Services checked " +
              esc(
                obs.statusAt
                  ? new Date(obs.statusAt).toLocaleTimeString()
                  : obs.at,
              ) +
              "</p>" +
              details(
                obs.status.map((r) => [
                  esc(r.service),
                  [r.state, r.health].filter(Boolean).join(" · "),
                ]),
              )
            : empty("No containers found for this node.")
          : "") +
        (obs.health
          ? "<p>Health checked " +
            esc(new Date(obs.healthAt).toLocaleTimeString()) +
            "</p>" +
            details([
              ["Block height", obs.health.height],
              [
                "Primary peer",
                obs.health.primaryConnected ? "Connected" : "Disconnected",
              ],
              [
                "Sync",
                obs.health.height === "0"
                  ? "Waiting for first block"
                  : obs.health.catchingUp
                    ? "Catching up"
                    : "Caught up",
              ],
              ["Last block", obs.health.blockTime],
              ["Voting power", obs.health.votingPower],
              ...(obs.progress
                ? [
                    [
                      "Replay speed",
                      obs.progress.blocksPerSecond.toFixed(
                        obs.progress.blocksPerSecond >= 1 ? 1 : 3,
                      ) + " blocks/s",
                    ],
                    [
                      "100 blocks at this rate",
                      "About " +
                        Math.ceil(obs.progress.secondsPer100) +
                        " seconds",
                    ],
                  ]
                : []),
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
  return navigation + html;
}
function activity(n) {
  const networkId = n?.networkId || n?.id;
  return activityView({
    jobs: (state.jobs || []).filter(
      (job) => !networkId || job.networkId === networkId || !job.networkId,
    ),
    nodes: n?.nodes || [],
    networkId: n?.id || "",
    selected: activitySelection,
    filters: {
      search: activitySearch,
      status: activityStatus,
      type: activityType,
      operation: activityOperation,
      server: activityServer,
      sort: activitySort,
      target: activityTarget,
    },
    log: activityLog,
    labels: actionLabels,
    logSearch: activityLogSearch,
    wrap: activityWrap,
    follow: activityFollow,
    historyOpen: activityHistoryOpen,
  });
}
async function launchJob(action, body) {
  if (launchingJob) return;
  launchingJob = true;
  try {
    const response = await api(action, body, { background: true });
    if (!response.job)
      throw new Error(
        "Restart the node console to enable background jobs, then retry.",
      );
    const job = response.job;
    state.jobs = [
      job,
      ...(state.jobs || []).filter((item) => item.id !== job.id),
    ];
    state.busy = job.status === "running";
    activitySelection = job.id;
    activityLog = null;
    activityLogSearch = "";
    pending = false;
    if ($("dialog").open) $("dialog").close();
    go("activity", { run: job.id });
    feedback(
      job.status === "running"
        ? "Run started. Output is saved with this activity."
        : "Run " + job.status + ". Output is saved with this activity.",
    );
    void pollJobs();
  } finally {
    launchingJob = false;
  }
}
function selectedJob() {
  const n = current(),
    id = n?.networkId || n?.id;
  const jobs = (state.jobs || []).filter(
    (job) => !id || job.networkId === id || !job.networkId,
  );
  return activitySelection
    ? jobs.find((job) => job.id === activitySelection)
    : jobs[0];
}
async function pollJobs(force = false) {
  if (!state || pollingJobs || !token) return;
  pollingJobs = true;
  try {
    const before = new Map(
      (state.jobs || []).map((job) => [job.id, job.status]),
    );
    const previous = new Map((state.jobs || []).map((job) => [job.id, job]));
    state.jobs = (await api("jobs")).map((job) => ({
      ...previous.get(job.id),
      ...job,
    }));
    const finished = state.jobs.some(
      (job) => before.get(job.id) === "running" && job.status !== "running",
    );
    state.busy = state.jobs.some((job) => job.status === "running");
    const job = selectedJob();
    if (
      page === "activity" &&
      job &&
      (force ||
        activityLog?.id !== job.id ||
        job.status === "running" ||
        activityLog?.status !== job.status)
    ) {
      try {
        const [detail, logs] = await Promise.all([
          api("jobs/" + job.id),
          api("jobs/" + job.id + "/logs"),
        ]);
        state.jobs = state.jobs.map((item) =>
          item.id === job.id ? detail : item,
        );
        activityLog = { ...logs, id: job.id, status: job.status };
      } catch (error) {
        activityLog = {
          ...(activityLog?.id === job.id ? activityLog : {}),
          id: job.id,
          error: error.message,
        };
      }
    }
    if (finished) {
      const detailed = state.jobs;
      await refresh();
      state.jobs = detailed;
      if (job)
        feedback(
          "Run " +
            job.status.replaceAll("-", " ") +
            ". Output is saved with this activity.",
        );
    }
    if (page === "activity") {
      const active = document.activeElement;
      if (!["INPUT", "SELECT"].includes(active?.tagName)) {
        const output = $("activity-output"),
          scroll = output?.scrollTop;
        render();
        if ($("activity-output"))
          $("activity-output").scrollTop = activityFollow
            ? $("activity-output").scrollHeight
            : scroll || 0;
      }
    } else if (finished) render();
  } catch (error) {
    if (page === "activity")
      feedback("Could not refresh activity: " + error.message);
  } finally {
    pollingJobs = false;
  }
}
function render() {
  const n = current(),
    p = pages[page];
  $("network").innerHTML = workspaceNetworks().length
    ? workspaceNetworks()
        .map(
          (item) =>
            '<option value="' +
            item.id +
            '">' +
            esc(
              (labels[item.stage] || item.name) +
                (!item.workspaceId &&
                workspaceNetworks().some(
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
  $("crumb").textContent = n ? n.name || labels[n.stage] : "Local host";
  $("stage").textContent = n ? n.workspaceId || n.stage : "local";
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
          : page === "settings"
            ? settingsPage(n)
            : page === "monitor"
              ? monitorPage(n)
              : (selectedNodeId() && activeNode()
                  ? surface(
                      esc(activeNode().name),
                      "Manage only this node’s host, identity and services.",
                      "",
                      btn(
                        "all-nodes",
                        "All " +
                          (page === "validator" ? "validators" : "sentries"),
                      ) +
                        btn(
                          "create-node",
                          page === "validator" ? "New validator" : "New sentry",
                        ) +
                        '<button class="danger" data-action="remove-node">Remove node</button>',
                    )
                  : "") + rolePage(n);
  if (n?.workspaceUpdate) {
    const update = n.workspaceUpdate;
    $("content").insertAdjacentHTML(
      "afterbegin",
      surface(
        "Network update available",
        "Installed release " +
          esc(update.currentRelease) +
          " · API release " +
          esc(update.release),
        '<p class="dialog-copy">Update the workspace invitation for new nodes. Existing nodes keep their pinned release, identity, data and service configuration.</p>' +
          (update.networkChanged
            ? '<p role="alert">The API advertises a different frozen network. It cannot replace the network of your existing nodes.</p>'
            : ""),
        update.networkChanged
          ? ""
          : btn("workspace-update", "Update network", true),
      ),
    );
  }
  if (
    n?.workspaceId &&
    !n.networkId &&
    !["networks", "settings", "activity"].includes(page)
  ) {
    $("content").innerHTML = workspaceUnavailable(n);
  } else if (n?.workspaceId && n.workspaceError && page !== "networks") {
    $("content").insertAdjacentHTML(
      "afterbegin",
      surface(
        "Public API unavailable",
        "Your saved nodes and last verified network remain available.",
        '<p role="alert">' + esc(n.workspaceError) + "</p>",
        btn("workspace-refresh", "Retry public API"),
      ),
    );
  }
  for (const b of $("content").querySelectorAll("button"))
    b.disabled =
      b.disabled ||
      ((pending || state.busy) &&
        !b.dataset.action?.startsWith("activity-") &&
        ![
          "activity-select",
          "activity-reset",
          "activity-copy",
          "activity-download",
          "health-auto",
        ].includes(b.dataset.action));
}
function setRoute(push = true, patch = {}) {
  navigateRoute(
    { ...routeState(), workspace: selected, page, ...patch },
    { replace: !push },
  );
}
function route() {
  const requested = routeState();
  page = Object.hasOwn(pages, requested.page)
    ? requested.page
    : state.defaultPage;
  activitySelection = page === "activity" ? requested.run || "" : "";
  const id =
    requested.workspace || localStorage.getItem("graphene-participant-network");
  selected = workspaceNetworks().some((network) => network.id === id)
    ? id
    : workspaceNetworks()[0]?.id;
  if (
    selected &&
    (!requested.workspace ||
      requested.workspace !== selected ||
      requested.page !== page)
  ) {
    setRoute(false, { node: undefined, step: undefined, run: undefined });
  }
  render();
}
function go(p, patch = {}) {
  page = p;
  navigateRoute({ workspace: selected, page: p, ...patch });
  feedback();
  if (document.body.classList.contains("nav-open")) menu(false);
  render();
  $("title").focus();
}
subscribeRoutes(() => {
  if (state) {
    const closeNavigation = document.body.classList.contains("nav-open");
    if (closeNavigation) menu(false);
    feedback();
    route();
    if (closeNavigation) $("title").focus();
  }
});
$("network").onchange = () => {
  selected = $("network").value;
  localStorage.setItem("graphene-participant-network", selected);
  navigateRoute({ workspace: selected, page });
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
const field = (
  name,
  label,
  type = "text",
  help = "",
  opts = "",
  required = true,
) =>
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
function fieldHelp(text) {
  return (
    '<details class="field-help"><summary aria-label="Field help">?</summary><p>' +
    esc(text) +
    "</p></details>"
  );
}
function credentialForm(provider = "hetzner", editing = null) {
  formAction = "cloud-account-save";
  const specs = state.cloudAccounts?.providers || {};
  $("dialog-category").textContent = "Cloud credentials";
  $("dialog-title").textContent = editing
    ? "Edit cloud credential"
    : "Add cloud credential";
  $("form-error").textContent = "";
  $("fields").innerHTML =
    '<p class="dialog-copy">Use a provider account allowed to inspect and delete this node’s VM, disks, snapshots and dedicated network resources. Blank fields preserve saved values when editing.</p>' +
    (editing
      ? '<input type="hidden" name="id" value="' + editing.id + '">'
      : "") +
    '<label class="field">Provider<select id="account-provider" name="provider" ' +
    (editing ? "disabled" : "") +
    ">" +
    Object.entries(specs)
      .map(
        ([key, spec]) =>
          '<option value="' +
          key +
          '" ' +
          (key === provider ? "selected" : "") +
          ">" +
          esc(spec.name) +
          "</option>",
      )
      .join("") +
    "</select></label>" +
    field(
      "name",
      "Credential name",
      "text",
      "Choose a unique name for this provider account.",
      'maxlength="80" value="' + esc(editing?.name || "") + '"',
    ) +
    '<button type="button" id="account-name-generate">Generate name</button>' +
    (specs[provider]?.fields || [])
      .map((key) => {
        const optional = key.endsWith("?");
        key = key.replace("?", "");
        const label =
          {
            token: "API token",
            accessKeyId: "AWS access key ID",
            secretAccessKey: "AWS secret access key",
            sessionToken: "AWS session token (optional)",
            serviceAccountJson: "Service account JSON",
            tenantId: "Tenant ID",
            subscriptionId: "Subscription ID",
            clientId: "Client ID",
            clientSecret: "Client secret",
          }[key] || key;
        const help =
          "Use the value issued by your cloud provider. This cannot be generated by the node console. Credentials are saved privately and never returned to this form.";
        return (
          (key === "serviceAccountJson"
            ? '<label class="field">' +
              label +
              '<textarea name="' +
              key +
              '" autocomplete="off" spellcheck="false" ' +
              (!editing ? "required" : "") +
              "></textarea></label>"
            : field(
                key,
                label,
                ["tenantId", "subscriptionId", "clientId"].includes(key)
                  ? "text"
                  : "password",
                "",
                'autocomplete="off" spellcheck="false"',
                !editing && !optional,
              )) + fieldHelp(help)
        );
      })
      .join("") +
    (provider === "aws" && editing
      ? '<label class="field"><input type="checkbox" name="clearSessionToken"> Clear the saved optional AWS session token</label>'
      : "");
  $("submit").textContent = "Save credential";
  $("account-provider").onchange = () =>
    credentialForm($("account-provider").value);
  $("account-name-generate").onclick = () => {
    $("fields").querySelector('[name="name"]').value =
      (specs[provider]?.name || provider) +
      "-" +
      crypto.randomUUID().slice(0, 8);
  };
  $("dialog").showModal();
}
function removalForm() {
  removalReview = null;
  formAction = "remove-preview";
  const node = activeNode(),
    host = activeHost();
  $("dialog-category").textContent = "Node removal";
  $("dialog-title").textContent = "Remove " + node.name;
  $("form-error").textContent = "";
  $("fields").innerHTML =
    '<p class="dialog-copy">This permanently removes this node’s containers, volumes, keys, data, checkpoint files and local configuration. A cloud node also removes its verified dedicated VM and the associated resources listed in the review.</p>' +
    (page === "validator"
      ? '<p class="dialog-copy">This stops validator participation. On-chain registration and stake must be managed separately in your wallet.</p>'
      : "") +
    (host?.kind === "cloud"
      ? '<label class="field">Cloud host ownership<select id="removal-cloud-mode" name="cloudMode"><option value="dedicated">Delete a dedicated VM and its associated resources</option><option value="shared">Remove this node from a shared host; keep the VM</option></select></label>' +
        fieldHelp(
          "Delete the VM only when it belongs exclusively to this node. A shared VM is retained while this node’s containers and data are removed over SSH.",
        ) +
        '<label class="field">' +
        esc(providerLabels[host.provider]) +
        ' credential<select name="credentialId" required><option value="">Choose a saved provider credential</option>' +
        (state.cloudAccounts?.accounts || [])
          .filter((account) => account.provider === host.provider)
          .map(
            (account) =>
              '<option value="' +
              account.id +
              '" ' +
              (account.id === host.credentialId ? "selected" : "") +
              ">" +
              esc(account.name) +
              "</option>",
          )
          .join("") +
        "</select></label>" +
        fieldHelp(
          "Only saved credentials for this node’s cloud provider can be selected. Add or edit an account in Settings → Cloud credentials.",
        ) +
        '<label class="field"><input type="checkbox" name="dedicated" required> This VM is dedicated to this node and may be permanently deleted.</label><p class="dialog-copy">Removal is blocked if other nodes or containers are detected on this VM.</p>'
      : "");
  if (host?.kind === "cloud")
    $("removal-cloud-mode").onchange = () => {
      const dedicated = $("removal-cloud-mode").value === "dedicated";
      const account = $("fields").querySelector('[name="credentialId"]');
      const confirmation = $("fields").querySelector('[name="dedicated"]');
      account.required = dedicated;
      account.disabled = !dedicated;
      confirmation.required = dedicated;
      confirmation.disabled = !dedicated;
    };
  $("submit").textContent = "Review removal";
  $("dialog").showModal();
}
function removalDetails(plan) {
  removalReview = plan;
  formAction = "remove-node";
  $("fields").innerHTML =
    '<p class="dialog-copy">Permanently delete the following resources for <strong>' +
    esc(plan.name) +
    "</strong>. This cannot be undone.</p>" +
    details([
      ["Containers and volumes", plan.project],
      ["Cloud account", plan.accountName || "Not required"],
      ["Local files", plan.files.join("\n") || "None"],
      ["Remote files", plan.remoteFiles.join("\n") || "None"],
    ]) +
    (plan.resources.length
      ? "<h3>Cloud resources</h3><ul>" +
        plan.resources
          .map(
            (resource) =>
              "<li>" +
              esc(resource.type) +
              " · " +
              esc(resource.name || resource.id) +
              "</li>",
          )
          .join("") +
        "</ul>"
      : "") +
    (plan.retained.length
      ? '<p class="dialog-copy">Shared resources retained: ' +
        esc(plan.retained.join(", ")) +
        "</p>"
      : "") +
    (plan.resuming
      ? '<p class="dialog-copy">Resuming interrupted removal. Completed: ' +
        esc(plan.completed.join(", ") || "none") +
        "</p>"
      : "") +
    '<p class="dialog-copy">Shared workspace data, credential profiles and shared Docker images are retained.</p><p id="removal-progress" role="status"></p>' +
    field(
      "confirmation",
      "Type " + esc(plan.confirmation),
      "text",
      "Confirm deletion of this exact node.",
      'autocomplete="off"',
    );
  $("submit").textContent = "Remove permanently";
}
function dialog(action) {
  formAction = action;
  $("form-error").textContent = "";
  const data = {
    review: [
      "Review deployment",
      "Check the generated service topology and port exposure for this existing network. No containers are started by this action.",
      "",
      "Review deployment",
    ],
    host: [
      "Choose deployment host",
      "Use your local Docker Engine, or connect a prepared cloud host. No paid server is created by this action.",
      '<label class="field">Deployment target<select name="kind" id="host-kind"><option value="local">Local Docker Engine</option><option value="cloud">Cloud provider · existing host</option></select></label>' +
        '<fieldset id="cloud-fields" hidden disabled><legend>Cloud host connection</legend><label class="field">Cloud provider<select name="provider" id="host-provider">' +
        Object.entries(providerLabels)
          .map(
            ([id, name]) => '<option value="' + id + '">' + name + "</option>",
          )
          .join("") +
        "</select></label>" +
        '<label class="field" id="host-credential-field">Saved cloud credential<select name="credentialId" id="host-credential"></select></label><p id="host-credential-help" class="dialog-copy"></p><a class="btn" href="' +
        esc(
          routePath({
            workspace: selected,
            page: "settings",
            tab: "credentials",
          }),
        ) +
        '">Manage saved credentials</a>' +
        field("address", "SSH hostname or configured alias") +
        field("user", "SSH user", "text", "", 'value="root"') +
        field(
          "port",
          "SSH port",
          "number",
          "",
          'value="22" min="1" max="65535"',
        ) +
        field("key", "Private SSH key path on this computer") +
        '<button type="button" id="ssh-generate">Generate SSH key</button><div id="ssh-public"></div>' +
        field(
          "knownHosts",
          "Verified known_hosts file path",
          "text",
          "Confirm the cloud host key independently before connecting. The private SSH key stays on this computer.",
        ) +
        field(
          "hostPublicKey",
          "Verified SSH host public key",
          "text",
          "Optional: paste the host’s independently verified ssh-ed25519 public key to generate a known_hosts file.",
          "",
          false,
        ) +
        '<button type="button" id="ssh-trust">Save verified host key</button><p id="ssh-result" role="status"></p></fieldset>',
      "Check & save host",
    ],
    "host-install": [
      "Install cloud participant runtime",
      "Copy only the bundled public participant runtime to the selected SSH host, install its locked npm dependencies, and import this network invitation. Identities are generated on that host. This does not update existing blockchain services or deploy any frontend.",
      "",
      "Install participant runtime",
    ],
    connection: [
      "Connect private validator to public sentry",
      "Network and peer details come from the verified sentry invitation. This validator never publishes an incoming port.",
      current()?.publicPeer
        ? details([["Sentry peer", current().publicPeer]])
        : field(
            "peer",
            "Public sentry peer address",
            "text",
            "Import this sentry’s invitation API to fill the peer automatically.",
          ),
      "Save sentry connection",
    ],
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
    "import-url": [
      "Connect to public sentry",
      "Load this sentry’s public invitation JSON to populate its network, genesis, pinned images and Tendermint peer. Confirm the invitation SHA-256 through a trusted channel.",
      field(
        "url",
        "Sentry invitation API URL",
        "url",
        "For example: http://sentry.example.com:26657/api/invitation",
      ) +
        field(
          "fingerprint",
          "Invitation SHA-256",
          "text",
          "",
          'minlength="64" maxlength="64" pattern="[A-Fa-f0-9]{64}" spellcheck="false"',
        ),
      "Load & verify network",
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
    "create-node": [
      page === "validator" ? "New validator" : "New sentry",
      "Create a separate named deployment on this network. Its keys, host, data directory and service controls belong only to this node.",
      field(
        "name",
        "Node name",
        "text",
        "Use a unique name for this role and network.",
        'maxlength="80"',
      ) +
        '<div class="buttons left"><button type="button" id="node-name-generate">Generate name</button></div>',
      "Create node",
    ],
    identity: [
      "Create validator identity",
      "Keys are generated on the selected deployment host. Back up its private directory and passphrase.",
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
          "Use at least 32 characters. Save this passphrase in your password manager before creating the identity.",
          'minlength="32" autocomplete="new-password"',
        ) +
        '<div class="buttons left"><button type="button" id="passphrase-generate">Generate passphrase</button><button type="button" id="passphrase-show" aria-pressed="false">Show passphrase</button><button type="button" id="passphrase-help" aria-label="Keystore passphrase help" aria-expanded="false" aria-controls="passphrase-explanation">?</button></div>' +
        '<p id="passphrase-explanation" class="dialog-copy" hidden>This passphrase encrypts your validator keystore. Generate creates 64 random hexadecimal characters locally in your browser. Keep it with your private-directory backup; you need it to unlock the keystore.</p>' +
        '<p id="passphrase-status" role="status"></p>',
      "Create identity",
    ],
    "prepare-validator-public": [
      "Prepare validator from invitation",
      "Use the verified sentry invitation’s genesis, pinned images and public Tendermint peer. Your own keys remain on the selected host. This prepares synchronization; it does not grant stake or voting power.",
      "",
      "Prepare from invitation",
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
      "Configure a public endpoint for this sentry. Use a DNS-only record and allow inbound TCP on its selected P2P and read-only RPC ports.",
      field(
        "address",
        "Public sentry domain or IPv4",
        "text",
        "For local deployment, forward this node’s two ports from your router to this host. Use different ports for each sentry on the same machine.",
      ) +
        field(
          "p2pPort",
          "Public P2P port",
          "number",
          "Use a free host port; each sentry on this host needs its own port.",
          'value="26656" min="1" max="65535"',
        ) +
        field(
          "rpcPort",
          "Public read-only RPC port",
          "number",
          "Use another free host port for this sentry’s invitation API and read-only RPC.",
          'value="26657" min="1" max="65535"',
        ),
      "Prepare sentry",
    ],
    "checkpoint-select": [
      "Select checkpoint",
      "Confirm the publisher fingerprint through a trusted channel with the network operator. Use a full state snapshot from the same network and release.",
      field(
        "file",
        "Signed checkpoint manifest",
        "file",
        "",
        'accept=".json,application/json"',
      ) +
        field(
          "fingerprint",
          "Publisher fingerprint",
          "text",
          "",
          'minlength="64" maxlength="64" pattern="[A-Fa-f0-9]{64}" spellcheck="false"',
        ) +
        field(
          "baseUrl",
          "Public snapshot folder URL",
          "url",
          "For example: http://203.0.113.1:26657/checkpoints/0123456789abcdef01234567/",
        ),
      "Verify & select",
    ],
    "checkpoint-current": [
      "Use current public checkpoint",
      "Fetch the latest signed checkpoint from this network’s public HTTPS API. The signature, publisher, frozen genesis, release images and age are checked automatically. Your node’s private identity is retained.",
      details([
        ["Block", current()?.publicCheckpoint?.height],
        ["Published", current()?.publicCheckpoint?.createdAt],
        ["Publisher", current()?.publicCheckpoint?.fingerprint],
      ]),
      "Verify & select",
    ],
    "checkpoint-restore": [
      "Restore checkpoint & start " + page,
      "This requires Python 3 on macOS or Linux and a local Docker engine. Keep this console open while the verified snapshot downloads and restores. Only a fresh node with no signing history or ledger data is eligible. Services must be stopped. After verification the node starts with its original keys and approved peer settings. An interrupted restore keeps its recovery journal; retry the same checkpoint.",
      "",
      "Restore checkpoint & start",
    ],
    start: [
      "Start " + page,
      page === "sentry"
        ? "Start only this reviewed sentry using its selected public P2P and read-only RPC ports. Keep databases and administrative RPC private. Syncing can take time."
        : "Start the reviewed private validator. It publishes no host ports and connects outbound to the configured public sentry. Syncing can take time.",
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
  if (action === "create-node") {
    $("node-name-generate").onclick = () => {
      $("fields").querySelector('[name="name"]').value =
        (page === "validator" ? "Validator-" : "Sentry-") +
        crypto.randomUUID().slice(0, 8);
    };
  }
  if (action === "identity") {
    const password = $("fields").querySelector('[name="password"]');
    $("passphrase-generate").onclick = () => {
      if (pending) return;
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      password.value = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      password.dispatchEvent(new Event("input", { bubbles: true }));
      $("passphrase-status").textContent =
        "Passphrase generated. Use Show passphrase to copy it into your password manager before creating the identity.";
    };
    $("passphrase-show").onclick = () => {
      if (pending) return;
      const show = password.type === "password";
      password.type = show ? "text" : "password";
      $("passphrase-show").textContent = show
        ? "Hide passphrase"
        : "Show passphrase";
      $("passphrase-show").setAttribute("aria-pressed", String(show));
    };
    $("passphrase-help").onclick = () => {
      const explanation = $("passphrase-explanation");
      explanation.hidden = !explanation.hidden;
      $("passphrase-help").setAttribute(
        "aria-expanded",
        String(!explanation.hidden),
      );
    };
  }
  if (action === "host") {
    const sshAction = async (action) => {
      $("form-error").textContent = "";
      $("submit").disabled = true;
      $("ssh-generate").disabled = $("ssh-trust").disabled = true;
      try {
        const values = Object.fromEntries(new FormData($("form")));
        const result = await api(action, {
          ...values,
          id: selected,
          role: page,
        });
        if (action === "ssh-generate") {
          $("fields").querySelector("[name=key]").value = result.privateKeyPath;
          $("ssh-public").innerHTML =
            '<p>Install this public key on your cloud host. The private key stays here.</p><pre class="node-logs">' +
            esc(result.publicKey) +
            "</pre>";
        } else {
          $("fields").querySelector("[name=knownHosts]").value =
            result.knownHosts;
          $("ssh-result").textContent =
            "Pinned host key · " + result.fingerprint;
        }
      } catch (error) {
        $("form-error").textContent = error.message;
      } finally {
        $("submit").disabled = false;
        $("ssh-generate").disabled = $("ssh-trust").disabled = false;
      }
    };
    const updateCredentials = () => {
      const provider = $("host-provider").value;
      const accounts = (state.cloudAccounts?.accounts || []).filter(
        (account) => account.provider === provider,
      );
      const supported = provider !== "other";
      $("host-credential-field").hidden = !supported;
      $("host-credential").disabled = !supported;
      $("host-credential").innerHTML = selectOptions(
        [
          ["", "No credential selected"],
          ...accounts.map((account) => [account.id, account.name]),
        ],
        "",
      );
      $("host-credential-help").textContent = !supported
        ? "This provider uses your SSH connection."
        : accounts.length
          ? "Select a saved provider account for this host’s cloud resource management. SSH access is configured separately."
          : "No credentials saved for this provider. Add an account in Settings → Credentials, or configure SSH now and select credentials during removal.";
      const previous = activeHost();
      if (
        previous?.provider === provider &&
        accounts.some((a) => a.id === previous.credentialId)
      )
        $("host-credential").value = previous.credentialId;
    };
    const previous = activeHost();
    if (previous?.kind === "cloud") {
      $("host-kind").value = "cloud";
      $("cloud-fields").hidden = false;
      $("cloud-fields").disabled = false;
      $("host-provider").value = previous.provider;
      for (const name of ["address", "user", "port", "key", "knownHosts"])
        $("fields").querySelector('[name="' + name + '"]').value =
          previous[name] || "";
    }
    $("host-provider").onchange = updateCredentials;
    updateCredentials();
    $("ssh-generate").onclick = () => sshAction("ssh-generate");
    $("ssh-trust").onclick = () => sshAction("ssh-trust");
    $("host-kind").onchange = () => {
      const cloud = $("host-kind").value === "cloud";
      $("cloud-fields").hidden = !cloud;
      $("cloud-fields").disabled = !cloud;
    };
  }
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
  if (
    ["activity-cancel", "activity-delete", "activity-clear"].includes(action)
  ) {
    const job = selectedJob(),
      network = current()?.networkId || current()?.id;
    const route =
      action === "activity-clear"
        ? "jobs?completed=true&network=" + encodeURIComponent(network)
        : "jobs/" + job.id + (action === "activity-cancel" ? "/cancel" : "");
    $("submit").disabled = true;
    try {
      const result = await fetch("/api/" + route, {
        method: action === "activity-cancel" ? "POST" : "DELETE",
        headers: { Authorization: "Bearer " + token },
      });
      if (!result.ok) throw new Error((await result.json()).error);
      $("dialog").close();
      if (action !== "activity-cancel") {
        activitySelection = "";
        activityLog = null;
        setRoute(false, { run: undefined });
      }
      await pollJobs(true);
    } catch (error) {
      $("form-error").textContent = error.message;
    } finally {
      $("submit").disabled = false;
    }
    return;
  }
  let body = { id: selected, role: page, ...Object.fromEntries(data) };
  if (action === "cloud-account-save") {
    const provider =
      data.get("provider") ||
      state.cloudAccounts.accounts.find(
        (account) => account.id === data.get("id"),
      )?.provider;
    body = {
      ...(data.get("id") ? { id: data.get("id") } : {}),
      name: data.get("name"),
      provider,
      clearSessionToken: data.get("clearSessionToken") === "on",
      values: Object.fromEntries(
        (state.cloudAccounts.providers[provider]?.fields || [])
          .map((key) => key.replace("?", ""))
          .map((key) => [key, data.get(key) || ""]),
      ),
    };
  }
  if (action === "remove-preview")
    body = {
      ...body,
      dedicated: data.get("dedicated") === "on",
      deleteCloud: data.get("cloudMode") === "dedicated",
      sharedHost: data.get("cloudMode") === "shared",
    };
  if (action === "remove-node")
    body = {
      id: selected,
      role: page,
      token: removalReview.token,
      confirmation: data.get("confirmation"),
    };
  if (action === "checkpoint-current")
    body = {
      ...body,
      checkpointId: current().publicCheckpoint.id,
      fingerprint: current().publicCheckpoint.fingerprint,
    };
  pending = true;
  $("submit").disabled =
    $("cancel").disabled =
    $("close-dialog").disabled =
      true;
  const progressTimer =
    action === "remove-node"
      ? setInterval(async () => {
          try {
            const status = await api("removal-status");
            const progress = status.removals.find(
              (item) => item.nodeId === removalReview.nodeId,
            );
            if (progress && $("removal-progress"))
              $("removal-progress").textContent =
                "Removed " +
                progress.completed +
                " of " +
                progress.total +
                " resource groups. Waiting for provider confirmation…";
          } catch {
            /* The removal request reports its own error. */
          }
        }, 2000)
      : null;
  const original = $("submit").textContent;
  $("submit").textContent = "Working…";
  $("form-error").textContent = "";
  try {
    if (["import", "checkpoint-select"].includes(action)) {
      if (data.get("file").size > 7 * 1024 * 1024)
        throw new Error("Choose an invitation smaller than 7 MiB.");
      body.raw = await data.get("file").text();
      body.fingerprint = body.fingerprint.trim().toLowerCase();
      if (action === "checkpoint-select") body.baseUrl = body.baseUrl.trim();
      delete body.file;
    }
    if (action === "import-url") {
      body.url = body.url.trim();
      body.fingerprint = body.fingerprint.trim().toLowerCase();
    }
    if (action === "connection" && current().publicPeer)
      body.peer = current().publicPeer;
    if (backgroundActions.has(action)) {
      await launchJob(action, body);
      return;
    }
    const result = await api(action, body);
    if (action === "remove-preview") {
      removalDetails(result);
      return;
    }
    if (action === "remove-node") {
      setRoute(false, { node: undefined, step: undefined });
    }
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
    if (action === "create-node") {
      setRoute(false, { node: result.nodeId, step: "configuration" });
    }
    if (["import", "import-url"].includes(action)) {
      selected = result.id;
      localStorage.setItem("graphene-participant-network", selected);
      setRoute(false);
    }
    observations.delete(key());
    $("dialog").close();
    await refresh();
    if (
      (action === "host" && body.kind === "local") ||
      action === "host-install"
    ) {
      setRoute(false, { step: "chain" });
      render();
    }
    feedback((actionLabels[action] || action) + " · completed.");
  } catch (error) {
    if (action === "checkpoint-restore") {
      try {
        await refresh();
      } catch {
        /* Keep the original restore error. */
      }
    }
    $("form-error").textContent = error.message;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    pending = false;
    $("submit").disabled =
      $("cancel").disabled =
      $("close-dialog").disabled =
        false;
    $("submit").textContent =
      formAction === action
        ? original
        : formAction === "remove-node"
          ? "Remove permanently"
          : original;
    render();
  }
};
document.addEventListener("click", async (e) => {
  if (e.defaultPrevented) return;
  const stage = e.target.closest("[data-step]");
  if (stage && !pending) {
    setRoute(true, { step: stage.dataset.step });
    feedback();
    render();
    return;
  }
  const link = e.target.closest("[data-page]");
  if (link) {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    go(link.dataset.page);
    return;
  }
  const anchor = e.target.closest("a[href]");
  if (
    anchor &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    !e.altKey &&
    !anchor.target
  ) {
    const target = new URL(anchor.href, location.href);
    if (
      target.origin === location.origin &&
      /^\/(?:dev|test|prod|[a-f0-9]{64})\//.test(target.pathname)
    ) {
      e.preventDefault();
      navigatePath(target.pathname);
      if ($("dialog").open && !pending) $("dialog").close();
      return;
    }
  }
  const b = e.target.closest("[data-action]");
  if (!b || pending) return;
  const action = b.dataset.action;
  if (action === "activity-select") {
    activitySelection = b.dataset.run;
    activityLog = null;
    activityLogSearch = "";
    activityHistoryOpen = false;
    setRoute(true, { run: activitySelection });
    render();
    void pollJobs(true);
    return;
  }
  if (action === "activity-history") {
    activityHistoryOpen = !activityHistoryOpen;
    render();
    return;
  }
  if (action === "activity-reset") {
    activitySearch = "";
    activityStatus = activityOperation = activityType = activityServer = "all";
    activitySort = "newest";
    render();
    return;
  }
  if (action === "activity-copy") {
    try {
      await navigator.clipboard.writeText(activityLog?.text || "");
      feedback("Log copied.");
    } catch (error) {
      feedback("Could not copy log: " + error.message);
    }
    return;
  }
  if (action === "activity-download") {
    const url = URL.createObjectURL(
      new Blob([activityLog?.text || ""], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "graphene-" + (selectedJob()?.id || "run") + ".log";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (action === "activity-refresh") {
    void pollJobs(true);
    return;
  }
  if (
    ["activity-cancel", "activity-delete", "activity-clear"].includes(action)
  ) {
    const job = selectedJob();
    if (action !== "activity-clear" && !job) return;
    const title =
      action === "activity-cancel"
        ? "Cancel this run?"
        : action === "activity-clear"
          ? "Clear completed activity?"
          : "Delete this activity?";
    $("dialog-title").textContent = title;
    $("dialog-category").textContent = "Activity";
    $("fields").innerHTML =
      '<p class="dialog-copy">' +
      (action === "activity-cancel"
        ? "Cancellation stops commands where possible. Completed changes remain; inspect the server before retrying."
        : "This removes the selected activity records and their saved logs. Deployed servers and node data are kept.") +
      "</p>";
    $("form-error").textContent = "";
    $("submit").textContent =
      action === "activity-cancel" ? "Cancel run" : "Delete activity";
    formAction = action;
    $("dialog").showModal();
    return;
  }
  if (["server-inspect", "server-logs", "server-status"].includes(action)) {
    const n = current(),
      target =
        b.dataset.nodeId || $("activity-target")?.value || selectedNodeId();
    const node = n?.nodes.find((node) => node.nodeId === target);
    if (!node || state.busy) return;
    try {
      await launchJob(
        action === "server-inspect"
          ? "inspect"
          : action === "server-logs"
            ? "logs"
            : "status",
        { id: selected, role: node.role, nodeId: node.nodeId },
      );
    } catch (error) {
      feedback(error.message);
    }
    return;
  }
  if (action === "health-auto") {
    autoHealth = !autoHealth;
    render();
    if (autoHealth) await checkNetworkHealth();
    return;
  }
  if (action === "network-health") {
    await checkNetworkHealth();
    return;
  }
  if (action === "cloud-account-open") return credentialForm();
  if (action === "cloud-account-edit") {
    const account = state.cloudAccounts.accounts.find(
      (account) => account.id === b.dataset.accountId,
    );
    return credentialForm(account.provider, account);
  }
  if (action === "remove-node") {
    if (b.dataset.nodeId) {
      setRoute(false, { node: b.dataset.nodeId });
      render();
    }
    return removalForm();
  }
  if (action === "workspace-update") {
    const workspace = current();
    pending = true;
    render();
    try {
      await api(action, {
        workspace: workspace.workspaceId,
        fingerprint: workspace.workspaceUpdate.fingerprint,
      });
      await refresh();
      feedback(
        "Network invitation updated. Existing nodes retain their pinned runtimes.",
      );
    } catch (error) {
      try {
        await refresh();
      } catch {
        /* Preserve the update error. */
      }
      feedback(error.message);
    } finally {
      pending = false;
      render();
    }
    return;
  }
  if (action === "workspace-refresh") {
    pending = true;
    render();
    try {
      await api(action, { workspace: current().workspaceId });
      await refresh();
      feedback(current()?.workspaceError || "Public network refreshed.");
    } catch (error) {
      feedback(error.message);
    } finally {
      pending = false;
      render();
    }
    return;
  }
  if (action === "networks") return go(action);
  if (action === "all-nodes") return go(page);
  if (action === "sentry-invitation") {
    try {
      download(
        await api(action, { id: selected, role: "sentry" }),
        "graphene-invitation.json",
      );
    } catch (error) {
      feedback(error.message);
    }
    return;
  }
  if (action === "sentry-request")
    return download(activeNode().identity, "sentry-application.json");
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
  if (["status", "health", "logs"].includes(action)) {
    try {
      await launchJob(action, {
        id: selected,
        role: page,
        nodeId: selectedNodeId(),
      });
    } catch (error) {
      feedback(error.message);
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
      const previous = observations.get(k) || {},
        at = Date.now();
      observations.set(k, {
        ...previous,
        [action]: value,
        [action + "At"]: at,
        ...(action === "health"
          ? {
              progress: syncProgress(
                previous.health,
                value,
                previous.healthAt,
                at,
              ),
            }
          : {}),
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
async function initializeConsole() {
  $("gate-help").hidden = true;
  $("gate-error").textContent = "";
  $("gate-retry").hidden = true;
  $("gate-retry").disabled = true;
  if (!token) {
    $("gate-title").textContent = "Open your node console";
    $("gate-status").textContent =
      "Use the private link printed by the launcher.";
    $("gate-help").hidden = false;
    return;
  }
  $("gate-title").textContent = "Loading your node console…";
  $("gate-status").textContent =
    "Restoring your session and loading workspaces.";
  try {
    await refresh();
  } catch (error) {
    $("gate-title").textContent = "Unable to load the console";
    $("gate-status").textContent =
      "Retry loading, or reopen the private link from your launcher.";
    $("gate-error").textContent = error.message;
    $("gate-retry").hidden = false;
  } finally {
    $("gate-retry").disabled = false;
  }
}
$("gate-retry").onclick = initializeConsole;
void initializeConsole();

async function checkNetworkHealth() {
  const n = current();
  if (pending || state?.busy || !n || (n.workspaceId && !n.networkId)) return;
  const id = n.networkId || n.id;
  pending = true;
  render();
  try {
    healthReports.set(id, await api("network-health", { id }));
    feedback("Network health check complete.");
  } catch (error) {
    feedback(error.message);
  } finally {
    pending = false;
    render();
  }
}
setInterval(() => {
  if (page === "monitor" && autoHealth && !document.hidden)
    void checkNetworkHealth();
}, 30000);
document.addEventListener("change", (e) => {
  const value = e.target.value;
  switch (e.target.id) {
    case "activity-status":
      activityStatus = value;
      break;
    case "activity-type":
      activityType = value;
      activityOperation = "all";
      break;
    case "activity-operation":
      activityOperation = value;
      break;
    case "activity-server":
      activityServer = value;
      break;
    case "activity-sort":
      activitySort = value;
      break;
    case "activity-target":
      activityTarget = value;
      break;
    case "activity-wrap":
      activityWrap = e.target.checked;
      break;
    case "activity-follow":
      activityFollow = e.target.checked;
      break;
    case "health-role":
      healthRole = value;
      break;
    case "health-filter":
      healthFilter = value;
      break;
    default:
      return;
  }
  render();
});
document.addEventListener("input", (e) => {
  if (
    !["activity-search", "activity-log-search", "health-search"].includes(
      e.target.id,
    )
  )
    return;
  const id = e.target.id,
    value = e.target.value,
    position = e.target.selectionStart;
  if (id === "activity-search") activitySearch = value;
  else if (id === "activity-log-search") activityLogSearch = value;
  else healthSearch = value;
  render();
  $(id).focus();
  $(id).setSelectionRange(position, position);
});

setInterval(() => {
  if (
    page === "monitor" &&
    !pending &&
    !document.hidden &&
    !["INPUT", "SELECT"].includes(document.activeElement?.tagName)
  )
    render();
}, 10000);

setInterval(() => {
  if (
    state &&
    (page === "activity" ||
      pending ||
      state.jobs?.some((job) => job.status === "running"))
  )
    void pollJobs();
}, 1000);
