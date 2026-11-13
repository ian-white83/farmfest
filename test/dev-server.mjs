// Local preview: `npm run dev`, then open http://localhost:8888
// Codes: event FF27, organiser ORG, treasurer CASH (override with env vars).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../lib/handler.mjs';
import { localStore } from './local-store.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const env = { EVENT_CODE: process.env.EVENT_CODE || 'FF27', ADMIN_CODE: process.env.ADMIN_CODE || 'ORG', TREASURER_CODE: process.env.TREASURER_CODE || 'CASH' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };
const { store } = await localStore(process.env.BLOBS_DIR);
const port = Number(process.env.PORT || 8888);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/api') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const r = await handle(request, store, env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const file = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, () => console.log(`Farm Fest dev server on http://localhost:${port} (codes ${env.EVENT_CODE} / ${env.ADMIN_CODE} / ${env.TREASURER_CODE})`));
