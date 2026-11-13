// Spins up the official Netlify Blobs local server so tests and the dev
// server use the real @netlify/blobs client (including conditional writes).
import { BlobsServer } from '@netlify/blobs/server';
import { getStore } from '@netlify/blobs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// The local server derives ETags from file mtime (millisecond resolution), so two
// writes in the same millisecond share an ETag. Netlify's hosted store uses content
// ETags; hash the content here too so concurrency tests mean something.
BlobsServer.generateETag = async (filePath) => {
  try { return `"${createHash('sha256').update(await readFile(filePath)).digest('hex')}"`; } catch { return ''; }
};

export async function localStore(dir) {
  const token = 'local-token';
  const server = new BlobsServer({ directory: dir || mkdtempSync(join(tmpdir(), 'ffblobs-')), token });
  const { port } = await server.start();
  const store = getStore({ name: 'farmfest', siteID: 'local', token, edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}`, consistency: 'strong' });
  return { store, stop: () => server.stop() };
}

// In-memory store with atomic conditional writes, matching how Netlify's hosted
// store behaves. The local file server checks then writes non-atomically, so it
// can't exercise races; this can. Reads yield to the event loop like real I/O.
export function memoryStore() {
  let value = null, etag = null, n = 0;
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));
  return {
    async getWithMetadata() { await tick(); return value == null ? null : { data: JSON.parse(value), etag, metadata: {} }; },
    async get() { await tick(); return value == null ? null : JSON.parse(value); },
    async list() { await tick(); return { blobs: value == null ? [] : [{ key: 'state', etag }], directories: [] }; },
    async setJSON(_k, data, opts = {}) {
      await tick();
      if (opts.onlyIfNew && value != null) return { modified: false };
      if (opts.onlyIfMatch && opts.onlyIfMatch !== etag) return { modified: false };
      value = JSON.stringify(data); etag = `"${++n}"`;
      return { modified: true, etag };
    },
  };
}
