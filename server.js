// Static server for the style test.  Serves public/ and exposes the installed
// three.js at /vendor/three/ so the page can use a bare-specifier importmap
// without a bundler step.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean.startsWith('/vendor/three/')) {
    return path.join(ROOT, 'node_modules', 'three', clean.slice('/vendor/three/'.length));
  }
  return path.join(ROOT, 'public', clean === '/' ? 'index.html' : clean);
}

http.createServer((req, res) => {
  const file = resolve(req.url);
  if (!file.startsWith(ROOT)) {          // no traversal out of the project
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + req.url);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`style test -> http://localhost:${PORT}`));
