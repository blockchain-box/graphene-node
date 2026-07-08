import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PortAllocator } from '../src/port-allocator.js';

describe('PortAllocator', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-allocator-test-'));
    statePath = path.join(tmpDir, 'port-map.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allocates unique ports within range', () => {
    const allocator = new PortAllocator(40001, 40003, statePath);

    const p1 = allocator.allocate('validator-A');
    const p2 = allocator.allocate('validator-B');
    const p3 = allocator.allocate('validator-C');

    expect(p1).toBeGreaterThanOrEqual(40001);
    expect(p3).toBeLessThanOrEqual(40003);
    expect(new Set([p1, p2, p3]).size).toBe(3);
  });

  it('returns same port for same validator', () => {
    const allocator = new PortAllocator(40001, 40005, statePath);
    const p1 = allocator.allocate('validator-A');
    const p2 = allocator.allocate('validator-A');
    expect(p1).toBe(p2);
  });

  it('throws when range is exhausted', () => {
    const allocator = new PortAllocator(40001, 40001, statePath);
    allocator.allocate('validator-A');
    expect(() => allocator.allocate('validator-B')).toThrow('No available ports');
  });

  it('releases port and reuses it', () => {
    const allocator = new PortAllocator(40001, 40002, statePath);
    allocator.allocate('validator-A');
    allocator.allocate('validator-B');
    allocator.release('validator-A');

    const reused = allocator.allocate('validator-C');
    expect(reused).toBe(40001);
  });

  it('persists state across instances', () => {
    const a1 = new PortAllocator(40001, 40005, statePath);
    a1.allocate('validator-A');
    a1.allocate('validator-B');

    const a2 = new PortAllocator(40001, 40005, statePath);
    expect(a2.get('validator-A')).toBe(a1.get('validator-A'));
    expect(a2.get('validator-B')).toBe(a1.get('validator-B'));
  });

  it('release returns null for unknown validator', () => {
    const allocator = new PortAllocator(40001, 40005, statePath);
    expect(allocator.release('unknown')).toBeNull();
  });

  it('list returns a copy of allocations', () => {
    const allocator = new PortAllocator(40001, 40005, statePath);
    allocator.allocate('validator-A');
    allocator.allocate('validator-B');

    const list = allocator.list();
    expect(list.size).toBe(2);
    expect(list.get('validator-A')).toBeDefined();
  });
});
