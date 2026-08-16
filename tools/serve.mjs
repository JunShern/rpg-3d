// serve.mjs -- a static server for public/, with the two things Python's
// http.server got wrong here: threads, and MIME types.
//
// A browser refuses an ES module served as text/plain, and the failure mode is
// silent -- fetch() returns 200, the import throws "Failed to fetch dynamically
// imported module", and the page sits on "building the scene" with an empty
// console. Worth a file to never debug that twice.
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../public/', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 3100);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css',
  '.wasm': 'application/wasm', '.map': 'application/json',
};

createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let path = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  try {
    if ((await fs.stat(path)).isDirectory()) path = join(path, 'index.html');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
}).listen(PORT, () => console.log(`serving public/ on http://localhost:${PORT}`));
