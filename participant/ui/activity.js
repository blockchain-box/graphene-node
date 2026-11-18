import { routePath } from "./routes.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const button = (action, label, disabled = false) =>
  `<button type="button" data-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`;
const select = (id, label, rows, value) =>
  `<label class="field">${label}<select id="${id}">${rows.map(([id, name]) => `<option value="${esc(id)}" ${id === value ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label>`;
const time = (value) => (value ? new Date(value).toLocaleString() : "—");
const detail = (rows) =>
  `<dl class="details run-metadata">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;
const badge = (status) =>
  `<span class="badge run-${esc(status)}">${esc(status.replaceAll("-", " "))}</span>`;
export function jobType(job) {
  if (/^(status|health|inspect|network-health|review)$/.test(job.action))
    return "checks";
  if (job.action.startsWith("checkpoint-")) return "checkpoints";
  if (job.role === "validator") return "validators";
  if (job.role === "sentry") return "sentries";
  if (/^(host|cloud|ssh)/.test(job.action)) return "infrastructure";
  if (/^(import|workspace)/.test(job.action)) return "network";
  return "other";
}
export function duration(job, now = Date.now()) {
  const ms =
    (job.status === "running" ? now : Date.parse(job.endedAt)) -
    Date.parse(job.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? seconds + "s"
    : seconds < 3600
      ? Math.floor(seconds / 60) + "m " + (seconds % 60) + "s"
      : Math.floor(seconds / 3600) +
        "h " +
        Math.floor((seconds % 3600) / 60) +
        "m";
}
export function filterJobs(jobs, filters, labels = {}) {
  const visible = jobs.filter(
    (job) =>
      (filters.status === "all" ||
        (filters.status === "running"
          ? job.status === "running"
          : filters.status === "completed"
            ? job.status !== "running"
            : ["failed", "interrupted", "needs-attention"].includes(
                job.status,
              ))) &&
      (filters.type === "all" || jobType(job) === filters.type) &&
      (filters.operation === "all" || job.action === filters.operation) &&
      (filters.server === "all" || job.nodeId === filters.server) &&
      [
        labels[job.action],
        job.action,
        job.id,
        job.nodeName,
        job.host,
        job.provider,
        job.stage,
        job.status,
      ]
        .join(" ")
        .toLowerCase()
        .includes(filters.search.trim().toLowerCase()),
  );
  return visible.sort((a, b) =>
    filters.sort === "oldest"
      ? Date.parse(a.startedAt) - Date.parse(b.startedAt)
      : filters.sort === "running"
        ? Number(b.status === "running") - Number(a.status === "running") ||
          Date.parse(b.startedAt) - Date.parse(a.startedAt)
        : Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
}
function bytes(value) {
  return Number.isFinite(value) ? (value / 1024 ** 3).toFixed(1) + " GiB" : "—";
}
export function inspectionView(report) {
  if (!report?.host) return "";
  const host = report.host;
  return `<section class="inspection-report"><h3>Server inspection</h3><p>Observed ${esc(time(report.checkedAt))}</p>${detail(
    [
      ["Hostname", host.hostname],
      ["Platform", host.platform + " / " + host.architecture],
      ["CPU cores", host.cpus],
      ["Load averages", host.load?.map((n) => n.toFixed(2)).join(" / ")],
      [
        "Memory available",
        bytes(host.freeMemory) + " / " + bytes(host.totalMemory),
      ],
      [
        "Disk available",
        bytes(host.disk?.available) + " / " + bytes(host.disk?.total),
      ],
      ["Host uptime", Math.floor(host.uptime / 3600) + " hours"],
    ],
  )}${Object.entries(report.checks || {})
    .map(([name, check]) => {
      const labels = {
        status: "Services",
        health: "Consensus health",
        stats: "Container resources",
      };
      let content;
      if (!check.ok) content = '<p role="alert">' + esc(check.error) + "</p>";
      else if (name === "health") {
        const health = check.value;
        content = detail([
          ["Block height", health.height],
          ["Synchronization", health.catchingUp ? "Catching up" : "Caught up"],
          [
            "Upstream peer",
            health.primaryConnected ? "Connected" : "Disconnected",
          ],
          ["Last block", time(health.blockTime)],
          ["Voting power", health.votingPower],
        ]);
      } else {
        const columns =
          name === "status"
            ? [
                ["Service", "service"],
                ["State", "state"],
                ["Health", "health"],
              ]
            : [
                ["Container", "Name"],
                ["CPU", "CPUPerc"],
                ["Memory", "MemUsage"],
                ["Network I/O", "NetIO"],
                ["Disk I/O", "BlockIO"],
              ];
        content =
          '<div class="table-scroll"><table class="health-table"><thead><tr>' +
          columns.map(([label]) => "<th>" + label + "</th>").join("") +
          "</tr></thead><tbody>" +
          check.value
            .map(
              (row) =>
                "<tr>" +
                columns
                  .map(([, key]) => "<td>" + esc(row[key] || "—") + "</td>")
                  .join("") +
                "</tr>",
            )
            .join("") +
          "</tbody></table></div>";
      }
      return (
        "<details open><summary>" +
        esc(labels[name] || name) +
        " · " +
        (check.ok ? "Observed" : "Needs attention") +
        "</summary>" +
        content +
        "</details>"
      );
    })
    .join("")}</section>`;
}
export function activityView({
  jobs,
  nodes,
  networkId,
  selected,
  filters,
  log,
  labels = {},
  logSearch = "",
  wrap = false,
  follow = true,
  historyOpen = false,
}) {
  const visible = filterJobs(jobs, filters, labels);
  const job = selected ? jobs.find((job) => job.id === selected) : jobs[0];
  const operations = [
    ...new Set(
      jobs
        .filter(
          (job) => filters.type === "all" || jobType(job) === filters.type,
        )
        .map((job) => job.action),
    ),
  ].sort((a, b) => (labels[a] || a).localeCompare(labels[b] || b));
  const server =
    nodes.find((node) => node.nodeId === (filters.target || filters.server)) ||
    nodes.find((node) => node.nodeId === job?.nodeId) ||
    nodes[0];
  const text = job && log?.id === job.id ? log.text || "" : "";
  const steps = {
    host: job?.result?.kind === "cloud" ? "configuration" : "chain",
    "host-install": "chain",
    identity: "chain",
    "prepare-validator": "runtime",
    "prepare-validator-public": "runtime",
    "prepare-sentry": "runtime",
    connection: "chain",
    review: "runtime",
    "checkpoint-select": "runtime",
    "checkpoint-current": "runtime",
    "checkpoint-restore": "monitor",
  };
  const nextStep = steps[job?.action] || "monitor";
  const continueLabel =
    steps[job?.action] && job.status === "succeeded"
      ? "Continue node setup →"
      : "Inspect / manage server →";
  const output = logSearch
    ? text
        .split(/\r?\n/)
        .filter((line) => line.toLowerCase().includes(logSearch.toLowerCase()))
        .join("\n")
    : text;
  const types = [
    ["all", "All types"],
    ["validators", "Validators"],
    ["sentries", "Sentries"],
    ["checkpoints", "Checkpoints & recovery"],
    ["network", "Network preparation"],
    ["infrastructure", "Infrastructure"],
    ["checks", "Checks & verification"],
    ["other", "Other"],
  ];
  return `<div class="activity-toolbar">${button("activity-history", historyOpen ? "Hide run history" : "Browse run history (" + jobs.length + ")")}<span>${jobs.filter((job) => job.status === "running").length} running</span></div><div class="activity-layout ${historyOpen ? "history-open" : ""}"><aside id="activity-history" class="surface run-history" aria-label="Run history"><div class="history-heading"><h2>Run history</h2><p>${visible.length} of ${jobs.length} runs · ${jobs.filter((job) => job.status === "running").length} running</p>${button("activity-clear", "Clear completed activity", !jobs.some((job) => job.status !== "running"))}</div><div class="activity-filters"><label class="field">Search runs<input id="activity-search" type="search" value="${esc(filters.search)}" placeholder="Search runs…"></label>${select(
    "activity-status",
    "Status",
    [
      ["all", "All runs"],
      ["running", "Running"],
      ["attention", "Needs attention"],
      ["completed", "Completed"],
    ],
    filters.status,
  )}${select("activity-type", "Type", types, filters.type)}${select("activity-operation", "Operation", [["all", "All operations"], ...operations.map((action) => [action, labels[action] || action])], filters.operation)}${select("activity-server", "Server", [["all", "All servers"], ...nodes.map((node) => [node.nodeId, node.name || node.role])], filters.server)}${select(
    "activity-sort",
    "Sort",
    [
      ["newest", "Newest first"],
      ["oldest", "Oldest first"],
      ["running", "Running first"],
    ],
    filters.sort,
  )}${button("activity-reset", "Reset filters")}</div><div class="run-list">${visible.map((item) => `<button class="run-item" data-action="activity-select" data-run="${esc(item.id)}" ${job?.id === item.id ? 'aria-current="true"' : ""}><strong>${esc(labels[item.action] || item.action)}</strong><small>${esc(item.nodeName || "Workspace")}${item.host ? " · " + esc(item.host) : ""}</small><span>${badge(item.status)} <small>${duration(item)}</small></span><small>${esc(time(item.startedAt))} · ${esc(item.id.slice(0, 8))}</small></button>`).join("") || '<p class="empty">' + (jobs.length ? "No matching runs. Try another filter." : "No commands yet. Inspect a server to get started.") + "</p>"}</div>${job && !visible.some((item) => item.id === job.id) ? '<p class="filter-note">The selected run is outside these filters. Its output stays open.</p>' : ""}</aside><section class="surface activity-detail" aria-label="Selected run">${
    job
      ? `<div class="run-header"><div><h2>${esc(labels[job.action] || job.action)} ${badge(job.status)}</h2><p>${esc(job.stage || "Local")} workspace · ${esc(job.nodeName || "Workspace operation")}</p></div>${job.status === "running" ? button("activity-cancel", "Cancel run") : button("activity-delete", "Delete activity")}${detail(
          [
            ["Started", time(job.startedAt)],
            ["Duration", duration(job)],
            ["Exit code", job.exitCode ?? "—"],
            ["Server", job.host || "—"],
            ["Provider", job.provider || "—"],
            ["Run ID", job.id],
          ],
        )}${job.nodeId && job.role ? `<a class="btn" href="${esc(routePath({ workspace: networkId, page: job.role, node: job.nodeId, step: nextStep }))}">${continueLabel}</a>` : ""}</div><div class="run-body">${job.message ? `<p role="${job.status === "failed" ? "alert" : "status"}">${esc(job.message)}</p>` : ""}<div class="activity-console"><div class="console-toolbar"><h3>Command output ${job.status === "running" ? '<span class="live-output">● Live</span>' : ""}</h3><div>${button("activity-copy", "Copy", !text)}${button("activity-download", "Download", !text)}${button("activity-refresh", "Refresh log")}</div></div><div class="console-filters"><label class="field">Filter log lines<input type="search" id="activity-log-search" value="${esc(logSearch)}" placeholder="Filter log lines…"></label><label><input type="checkbox" id="activity-wrap" ${wrap ? "checked" : ""}> Wrap lines</label><label><input type="checkbox" id="activity-follow" ${follow ? "checked" : ""}> Follow output</label></div>${log?.id === job.id && log.error ? `<p role="alert">Could not refresh logs: ${esc(log.error)}. Showing the last loaded output.</p>` : ""}<pre id="activity-output" class="command-output ${wrap ? "wrap-output" : ""}" tabindex="0" aria-label="Command output">${esc(output || (logSearch ? "No log lines match this filter." : job.status === "running" ? "Waiting for output…" : job.legacy ? "Command output was not recorded for this legacy activity." : "Loading command output…"))}</pre><div class="console-footer"><span>${output ? output.trimEnd().split("\n").length : 0} ${logSearch ? "matching " : ""}lines${log?.truncated ? " · Last 256 KB loaded" : ""}</span><span>Credentials redacted · Copy and download use the loaded log</span></div></div>${job.endedAt ? "<p>Finished " + esc(time(job.endedAt)) + "</p>" : ""}${inspectionView(job.result)}</div>`
      : '<div class="run-body"><h2>No run selected</h2><p>Run a server inspection or choose a run from history.</p></div>'
  }<div class="server-actions"><h3>Server operations</h3><p>Inspection and logs run against the selected server and keep their output in run history.</p>${select(
    "activity-target",
    "Server",
    nodes.map((node) => [node.nodeId, node.name || node.role]),
    server?.nodeId,
  )}<div class="buttons left">${button("server-inspect", "Inspect server", !server)}${button("server-logs", "Read server logs", !server)}${button("server-status", "Check services", !server)}</div></div></section></div>`;
}
