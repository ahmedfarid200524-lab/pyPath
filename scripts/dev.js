'use strict';
/* Local test server for the online version:  DATABASE_URL=... TOKEN_SECRET=... ADMIN_PASSWORD=... node scripts/dev.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handler } = require('../lib/app');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/admin': 'admin.html' };
const STATIC = { '/sw.js': 'application/javascript', '/manifest.webmanifest': 'application/manifest+json', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' };
http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  if (p.startsWith('/api/')) return handler(req, res);
  if (p.startsWith('/content/') && /^\/content\/[\w-]+(\/[\w-]+)?\.json$|^\/content\/[\w-]+\/[\w-]+\.json$/.test(p)) { const f = path.join(ROOT, p); if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(fs.readFileSync(f)); } res.writeHead(404); return res.end('Not found'); }
  if (FILES[p]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(ROOT, FILES[p]))); }
  if (STATIC[p]) { res.writeHead(200, { 'Content-Type': STATIC[p], 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(ROOT, p))); }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, '127.0.0.1', () => console.log('pyPath (online version) on http://127.0.0.1:' + PORT));
