#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const child = spawn(process.execPath, [fileURLToPath(new URL('./join-network.js', import.meta.url))], { stdio: 'inherit', env: { ...process.env, SETUP_PORT: process.env.SETUP_PORT || '8788' } });
child.on('exit', (code) => { process.exitCode = code || 0; });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
