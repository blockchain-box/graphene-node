export const pages = {
  overview: [
    "Workspace",
    "Overview",
    "home",
    "Join existing networks and manage your local or cloud nodes.",
  ],
  networks: [
    "Workspace",
    "Public networks",
    "network",
    "Dev, Test and Prod are loaded automatically from their public sentry APIs.",
  ],
  monitor: [
    "Workspace",
    "Network health",
    "layers",
    "Check public gateway connectivity, consensus and the health of every node.",
  ],
  settings: [
    "Workspace",
    "Settings",
    "server",
    "Manage network settings, pinned releases, node hosts and saved cloud credentials.",
  ],
  validator: [
    "Deployments",
    "Validator deployments",
    "shield-check",
    "Create and manage multiple independent private validators on the selected network.",
  ],
  sentry: [
    "Deployments",
    "Sentry deployments",
    "server",
    "Create and manage multiple public sentries, each with its own host and endpoints.",
  ],
  activity: [
    "Operations",
    "Activity & logs",
    "layers",
    "Run commands, stream output and inspect servers in the selected workspace.",
  ],
};

const slugs = {
  overview: "overview",
  networks: "networks",
  monitor: "health",
  settings: "settings",
  validator: "validators",
  sentry: "sentries",
  activity: "activity",
};
export const publicWorkspaces = ["dev", "test", "prod"];
export const workspaceKey = (workspace) =>
  publicWorkspaces.includes(workspace) ? "workspace-" + workspace : workspace;
export function routePath({
  workspace,
  page = "overview",
  node,
  step,
  tab,
  run,
} = {}) {
  const scope = (workspace || "workspace-dev").replace(/^workspace-/, "");
  let path =
    "/" + encodeURIComponent(scope) + "/" + (slugs[page] || "overview");
  if (page === "settings" && tab) path += "/" + encodeURIComponent(tab);
  if (["validator", "sentry"].includes(page) && node) {
    path += "/" + encodeURIComponent(node);
    if (step) path += "/" + encodeURIComponent(step);
  }
  if (page === "activity" && run) path += "/" + encodeURIComponent(run);
  return path;
}
let current = { page: null, workspace: null };
let navigate;
const listeners = new Set();
export const routeState = () => current;
export const subscribeRoutes = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function connectRouter(route, navigateTo) {
  current = route;
  navigate = navigateTo;
  for (const listener of listeners) listener();
}
export function navigateRoute(route, { replace = false } = {}) {
  if (!navigate) throw new Error("The console router is not ready.");
  current = { ...route };
  navigate(routePath(current), { replace });
}

export function navigatePath(path, options = {}) {
  if (!navigate) throw new Error("The console router is not ready.");
  navigate(path, options);
}

export const routeDefinitions = [
  ["overview", "/:workspace/overview"],
  ["networks", "/:workspace/networks"],
  ["monitor", "/:workspace/health"],
  ["settings", "/:workspace/settings/:tab?"],
  ["validator", "/:workspace/validators/:node?/:step?"],
  ["sentry", "/:workspace/sentries/:node?/:step?"],
  ["activity", "/:workspace/activity/:run?"],
];
