import os from 'node:os';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const percent = (used, total) => total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0;
const cpuSnapshot = cpus => ({
 cores: cpus.length,
 idle: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0),
 total: cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0),
});

// Sample the launcher host, including other applications. Never execute browser-supplied commands.
export function createHostMonitor(directory, { system = os, readStorage = statfs, wait = delay } = {}) {
 let pending;
 return function monitor() {
  if (pending) return pending;
  pending = (async () => {
   const previous = cpuSnapshot(system.cpus());
   await wait(250);
   const next = cpuSnapshot(system.cpus()), elapsed = next.total - previous.total;
   const usedPercent = elapsed > 0 && next.cores === previous.cores
    ? percent(elapsed - (next.idle - previous.idle), elapsed) : null;
   const total = system.totalmem(), free = system.freemem();
   let storage;
   try {
    // A fresh launcher may not have created its state directory yet.
    let folder = path.resolve(directory), stats;
    for (;;) {
     try { stats = await readStorage(folder); break; }
     catch (error) { const parent = path.dirname(folder); if (error.code !== 'ENOENT' || parent === folder) throw error; folder = parent; }
    }
    const total = stats.blocks * stats.bsize, free = stats.bavail * stats.bsize;
    const used = (stats.blocks - stats.bfree) * stats.bsize;
    storage = { total, used, free, reserved: Math.max(0, total - used - free), usedPercent: percent(used, total) };
   } catch { storage = { error: 'Storage usage is unavailable on this host.' }; }
   return {
    sampledAt: new Date().toISOString(), hostname: system.hostname(),
    cpu: { cores: next.cores, usedPercent, freePercent: usedPercent === null ? null : 100 - usedPercent },
    memory: { total, used: total - free, free, usedPercent: percent(total - free, total) },
    storage,
   };
  })().finally(() => { pending = null; });
  return pending;
 };
}
