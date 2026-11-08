import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { archiveNames, archiveStream, objectFile, readArchiveIndex } from './checkpoint-storage.js';

export const checkpointDownloadPath = /^\/checkpoints\/(latest\.json|objects\/[a-f0-9]{64}\.gz|[a-zA-Z0-9-]{1,100}\/(?:manifest\.json|enrollment\.json|index\.json|genesis\.json|app-state\.json|mpt\.tar\.gz|tendermint\.tar\.gz))$/;

function publicFile(root, relative) {
  const file = fs.realpathSync(path.join(root, relative));
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw new Error('Checkpoint not found.');
  return file;
}

// Complete archive URLs remain available to v1 clients, but are streamed from
// shared objects instead of storing a second full copy of every checkpoint.
export async function serveCheckpointDownload(req, res, publication, relative) {
  let bytes, open;
  try {
    const root = fs.realpathSync(publication);
    try {
      const file = publicFile(root, relative);
      bytes = fs.statSync(file).size;
      open = start => fs.createReadStream(file, { start });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const [id, name] = relative.split('/');
      if (!archiveNames.includes(name) || id === 'objects') throw error;
      const manifestFile = publicFile(root, `${id}/manifest.json`);
      if (fs.statSync(manifestFile).size > 65536) throw new Error('Checkpoint manifest is too large.');
      const { manifest } = JSON.parse(fs.readFileSync(manifestFile));
      const index = await readArchiveIndex(publicFile(root, `${id}/index.json`), manifest.incremental?.index, manifest.files);
      const chunks = index.archives[name];
      for (const chunk of chunks) {
        const file = publicFile(root, path.relative(root, objectFile(root, chunk.sha256)));
        if (fs.statSync(file).size !== chunk.bytes) throw new Error('Checkpoint object is unavailable.');
      }
      bytes = manifest.files[name].bytes;
      open = start => Readable.from(archiveStream(chunks, root, start));
    }
    const range = /^bytes=([0-9]+)-$/.exec(req.headers.range || '');
    if (req.headers.range && (!range || !Number.isSafeInteger(Number(range[1])) || Number(range[1]) >= bytes)) { res.writeHead(416); res.end(); return; }
    const start = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { 'Content-Type': relative.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Content-Length': bytes - start, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${bytes - 1}/${bytes}` } : {}) });
    const stream = open(start);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch {
    if (res.headersSent) res.destroy();
    else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Checkpoint not found.' })); }
  }
}
