// Runs the site the way Netlify does: static files from /public, /api/* through the real
// Netlify Function, with storage in a local Netlify Blobs server. Used by `npm run test:netlify`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobsServer } from '@netlify/blobs/server';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8888;
const BLOBS_PORT = PORT + 1;
const token = 'local-token';

const blobs = new BlobsServer({ directory: process.env.DATA_DIR, port: BLOBS_PORT, token });
await blobs.start();
const edgeURL = `http://localhost:${BLOBS_PORT}`;
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(
  // SIM_NO_STRONG=1 simulates an environment without strong-consistency support.
  JSON.stringify({ siteID: 'local-site', token, edgeURL, ...(process.env.SIM_NO_STRONG ? {} : { uncachedEdgeURL: edgeURL }) })
).toString('base64');

const { default: fn } = await import('../netlify/functions/api.mjs');
// Apply the "/*" headers from netlify.toml, like Netlify does for static pages.
const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const block = toml.split('[[headers]]').find((b) => /for\s*=\s*"\/\*"/.test(b)) || '';
const pageHeaders = Object.fromEntries(
  [...block.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/gm)].filter(([, k]) => k !== 'for').map(([, k, v]) => [k, v])
);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/healthz') return res.end('ok');
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const response = await fn(request, { ip: '127.0.0.1' });
      const headers = Object.fromEntries(response.headers);
      res.writeHead(response.status, headers);
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname === '/nihul-lior' ? '/nihul-lior.html' : url.pathname;
    fs.readFile(path.join(root, 'public', path.normalize(p)), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { ...pageHeaders, 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`Netlify simulation on http://localhost:${PORT} (storage: netlify-blobs)`));
