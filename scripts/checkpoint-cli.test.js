import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tunnelPublicKey } from '../agents/lib/grph-tunnel.js';

test('export resolves launcher publisher trust before looking for its signing key', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-cli-config-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const publisherTrust = path.join(folder, 'publisher-trust.json');
  fs.writeFileSync(publisherTrust, JSON.stringify({ manifestURL: `grph://${tunnelPublicKey('a'.repeat(64))}/checkpoints/latest.json` }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./checkpoint-cli.js', import.meta.url)), 'export', '--publisher-trust', publisherTrust, '--trust', path.join(folder, 'no-receiver-trust.json'), '--key', path.join(folder, 'missing-publisher.pem')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Provide --url/);
  assert.match(result.stderr, /missing-publisher\.pem/);
});

test('explicit URLs win over publisher configuration, with legacy receiver URLs as the final fallback', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-cli-precedence-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const publisherTrust = path.join(folder, 'publisher.json'), receiverTrust = path.join(folder, 'receiver.json');
  const saved = `grph://${tunnelPublicKey('b'.repeat(64))}/checkpoints/latest.json`;
  fs.writeFileSync(publisherTrust, JSON.stringify({ manifestURL: saved }));
  fs.writeFileSync(receiverTrust, JSON.stringify({ manifestURL: 'https://invalid.example/checkpoints/latest.json' }));
  const cli = fileURLToPath(new URL('./checkpoint-cli.js', import.meta.url));
  const run = extra => spawnSync(process.execPath, [cli, 'export', '--publisher-trust', publisherTrust, '--trust', receiverTrust, '--key', path.join(folder, 'missing.pem'), ...extra], { encoding: 'utf8' });
  assert.match(run([]).stderr, /No publisher key/);
  assert.match(run(['--url', 'https://invalid.example/checkpoints/latest.json']).stderr, /P2P endpoint/);
  fs.rmSync(publisherTrust);
  fs.writeFileSync(receiverTrust, JSON.stringify({ manifestURL: saved }));
  assert.match(run([]).stderr, /No publisher key/);
  fs.rmSync(receiverTrust);
  assert.match(run([]).stderr, /Provide --url/);
});
