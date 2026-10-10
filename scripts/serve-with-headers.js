#!/usr/bin/env node
'use strict';
/**
 * DEV ONLY: a tiny static server that applies the same response headers as vercel.json, so the Content-Security-Policy
 * can be tested locally (the browser console shows any blocked request).
 *   node scripts/serve-with-headers.js [port]          # production-like CSP
 *   CSP_LOCAL=1 node scripts/serve-with-headers.js     # also allows the Firebase emulators on 127.0.0.1
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.join(__dirname, '..');
const port = Number(process.argv[2]) || 5050;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml', '.json': 'application/json' };

function headersFor(url) {
  const h = {};
  for (const rule of cfg.headers) {
    const re = new RegExp('^' + rule.source.replace('(.*)', '.*') + '$');
    if (re.test(url)) for (const { key, value } of rule.headers) h[key] = value;
  }
  if (process.env.CSP_LOCAL && h['Content-Security-Policy']) {
    h['Content-Security-Policy'] = h['Content-Security-Policy'].replace('connect-src', 'connect-src http://127.0.0.1:* http://localhost:*').replace('upgrade-insecure-requests', '');
  }
  delete h['Strict-Transport-Security'];
  return h;
}

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(root, url);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  const ok = fs.existsSync(file);
  if (!ok) file = path.join(root, '404.html');
  res.writeHead(ok ? 200 : 404, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...headersFor(url) });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port} (headers from vercel.json)`));
