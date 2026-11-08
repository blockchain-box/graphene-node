import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';

export const archiveNames = ['mpt.tar.gz', 'tendermint.tar.gz'];
export const maxIndexBytes = 32 * 1024 ** 2;
const hashPattern = /^[a-f0-9]{64}$/;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function matchesFile(file, expected) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === expected.bytes && await hashFile(file) === expected.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function validateIncremental(value, height) {
  if (!value || value.format !== 1 || !hashPattern.test(value.index?.sha256 || '') || !Number.isSafeInteger(value.index.bytes) || value.index.bytes < 1 || value.index.bytes > maxIndexBytes) throw new Error('Invalid incremental checkpoint index.');
  if (value.parent !== null && (!value.parent || !/^[a-zA-Z0-9-]{1,100}$/.test(value.parent.id || '') || !/^\d+$/.test(value.parent.height || '') || BigInt(value.parent.height) < 1n || BigInt(value.parent.height) >= BigInt(height) || !hashPattern.test(value.parent.sha256 || ''))) throw new Error('Invalid checkpoint parent.');
}

export async function readArchiveIndex(file, expected, files) {
  if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > maxIndexBytes || !await matchesFile(file, expected)) throw new Error('Checkpoint index integrity check failed.');
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (index.format !== 1 || Object.keys(index.archives || {}).sort().join() !== [...archiveNames].sort().join()) throw new Error('Invalid checkpoint archive index.');
  for (const name of archiveNames) {
    const chunks = index.archives[name];
    if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > 100001) throw new Error('Invalid checkpoint chunk count.');
    let bytes = 0;
    for (const chunk of chunks) {
      if (!chunk || !hashPattern.test(chunk.sha256 || '') || !hashPattern.test(chunk.rawSha256 || '') || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > 8 * 1024 ** 3) throw new Error('Invalid checkpoint chunk.');
      bytes += chunk.bytes;
    }
    if (bytes !== files[name]?.bytes) throw new Error('Checkpoint chunks do not match the signed archive size.');
  }
  return index;
}

export const objectFile = (directory, hash) => {
  if (!hashPattern.test(hash)) throw new Error('Invalid checkpoint object hash.');
  return path.join(directory, 'objects', `${hash}.gz`);
};

// Each member is a complete tar entry. Concatenated gzip members decode into a
// normal tar archive, including for older clients. Entry boundaries survive file
// insertions/deletions, unlike chunks of a single compressed tar stream.
async function packTar(file, objects, previous, stats) {
  const handle = await fs.promises.open(file, 'r');
  const size = (await handle.stat()).size;
  const chunks = [];
  let offset = 0;
  try {
    while (offset + 512 <= size) {
      const header = Buffer.alloc(512);
      await handle.read(header, 0, 512, offset);
      if (header.every(byte => byte === 0)) break;
      const entryBytes = parseInt(header.subarray(124, 136).toString().split('\0')[0].trim(), 8);
      const padded = Math.ceil(entryBytes / 512) * 512;
      if (!Number.isSafeInteger(padded) || offset + 512 + padded > size) throw new Error('Truncated checkpoint tar entry.');
      // Metadata is irrelevant to database restore. Normalize it so a changed
      // directory mtime does not invalidate otherwise identical content.
      header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
      header.write('00000000000\0', 136, 12);
      header.fill(0, 265, 329);
      header.fill(32, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
      const start = offset + 512, end = start + padded - 1;
      const content = async function* () {
        yield header;
        if (padded) yield* fs.createReadStream(file, { start, end });
      };
      const hash = crypto.createHash('sha256');
      for await (const part of content()) hash.update(part);
      chunks.push(await storeMember(content, hash.digest('hex'), objects, previous, stats));
      offset += 512 + padded;
    }
    const footer = Buffer.alloc(1024);
    chunks.push(await storeMember(async function* () { yield footer; }, digest(footer), objects, previous, stats));
    return chunks;
  } finally { await handle.close(); }
}

async function storeMember(content, rawSha256, objects, previous, stats) {
  const cached = previous.get(rawSha256);
  if (cached && await matchesFile(objectFile(objects, cached.sha256), cached)) {
    stats.reusedBytes += cached.bytes; stats.reusedChunks++;
    return cached;
  }
  const temporary = path.join(objects, 'objects', `.${crypto.randomBytes(12).toString('hex')}.part`);
  try {
    await pipeline(Readable.from(content()), createGzip(), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
    const chunk = { sha256: await hashFile(temporary), bytes: fs.statSync(temporary).size, rawSha256 };
    fs.renameSync(temporary, objectFile(objects, chunk.sha256));
    previous.set(rawSha256, chunk);
    stats.createdBytes += chunk.bytes; stats.createdChunks++;
    return chunk;
  } finally { fs.rmSync(temporary, { force: true }); }
}

// The caller validates the complete raw tar before packing it. A complete recipe
// represents deletions by omission; it never patches a live database in place.
export async function createArchiveIndex(directory, output, previousIndex = null) {
  fs.mkdirSync(path.join(output, 'objects'), { recursive: true, mode: 0o755 });
  const previous = new Map();
  for (const chunks of Object.values(previousIndex?.archives || {})) for (const chunk of chunks) previous.set(chunk.rawSha256, chunk);
  const stats = { reusedBytes: 0, reusedChunks: 0, createdBytes: 0, createdChunks: 0 };
  const index = { format: 1, archives: {} };
  for (const name of archiveNames) {
    const raw = path.join(directory, name.replace(/\.gz$/, ''));
    index.archives[name] = await packTar(raw, output, previous, stats);
    await assembleArchive(index.archives[name], output, path.join(directory, name));
  }
  const data = Buffer.from(JSON.stringify(index));
  if (data.length > maxIndexBytes) throw new Error('Checkpoint archive index is too large.');
  fs.writeFileSync(path.join(directory, 'index.json'), data);
  return { index: { bytes: data.length, sha256: digest(data) }, stats };
}

export async function unpackArchive(file, destination) {
  await pipeline(fs.createReadStream(file), createGunzip(), fs.createWriteStream(destination, { mode: 0o600 }));
}

export async function assembleArchive(chunks, objects, destination) {
  const partial = destination + '.assembling';
  try {
    await pipeline(Readable.from(archiveStream(chunks, objects)), fs.createWriteStream(partial, { mode: 0o600 }));
    fs.renameSync(partial, destination);
  } finally { fs.rmSync(partial, { force: true }); }
}

export async function materializePublication(directory, manifest, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const index = await readArchiveIndex(path.join(directory, 'index.json'), manifest.incremental?.index, manifest.files);
  for (const name of ['genesis.json', 'app-state.json', 'manifest.json', 'index.json']) fs.copyFileSync(path.join(directory, name), path.join(destination, name));
  for (const name of archiveNames) {
    for (const chunk of index.archives[name]) if (!await matchesFile(objectFile(path.dirname(directory), chunk.sha256), chunk)) throw new Error('Checkpoint publication object integrity check failed.');
    await assembleArchive(index.archives[name], path.dirname(directory), path.join(destination, name));
    if (!await matchesFile(path.join(destination, name), manifest.files[name])) throw new Error('Reconstructed checkpoint archive integrity check failed.');
  }
  return destination;
}

export async function* archiveStream(chunks, objects, offset = 0) {
  for (const chunk of chunks) {
    if (offset >= chunk.bytes) { offset -= chunk.bytes; continue; }
    const file = objectFile(objects, chunk.sha256);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== chunk.bytes) throw new Error('Checkpoint object is unavailable.');
    yield* fs.createReadStream(file, { start: offset });
    offset = 0;
  }
}
