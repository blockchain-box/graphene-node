import os from "node:os";
import fs from "node:fs";
import { logOutput } from "./jobs.js";
export async function inspectNode(nodes, id, role) {
  const dir = nodes.dir(id, role),
    report = {
      checkedAt: new Date().toISOString(),
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        architecture: os.arch(),
        cpus: os.cpus().length,
        load: os.loadavg(),
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        uptime: os.uptime(),
      },
      checks: {},
    };
  try {
    const disk = fs.statfsSync(fs.existsSync(dir) ? dir : nodes.root);
    report.host.disk = {
      total: disk.blocks * disk.bsize,
      available: disk.bavail * disk.bsize,
    };
  } catch (error) {
    report.host.diskError = error.message;
  }
  for (const action of ["status", "health", "stats"]) {
    logOutput(`Inspecting ${action}…\n`);
    try {
      report.checks[action] = {
        ok: true,
        value:
          action === "stats"
            ? await (async () => {
                const raw = await nodes.runner(dir, nodes.project(id, role), [
                  "stats",
                  "--no-stream",
                  "--format",
                  "json",
                ]);
                return raw.trim()
                  ? raw
                      .trim()
                      .split("\n")
                      .flatMap((line) => JSON.parse(line))
                  : [];
              })()
            : await nodes.operate(id, role, action),
      };
    } catch (error) {
      report.checks[action] = { ok: false, error: error.message };
    }
  }
  return report;
}
