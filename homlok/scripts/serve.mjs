import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new RangeError('PORT must be an integer between 0 and 65535.');
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function insideRoot(path) {
  const location = relative(root, path);
  return location !== '..' && !location.startsWith('../') && !isAbsolute(location);
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }

  // Decode the raw target before resolving it; URL() would silently normalize
  // traversal segments, including percent-encoded dots, before we could reject.
  let pathname;
  try {
    pathname = decodeURIComponent((request.url ?? '/').split(/[?#]/, 1)[0]);
  } catch {
    response.writeHead(400).end('Malformed URL');
    return;
  }
  if (pathname.includes('\0')) {
    response.writeHead(400).end('Malformed URL');
    return;
  }
  if (pathname.replaceAll('\\', '/').split('/').includes('..')) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let path = resolve(root, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  if (!insideRoot(path)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    // Resolve symlinks too, so a link inside the project cannot expose an
    // arbitrary file outside the project root.
    path = await realpath(path);
    if (!insideRoot(path)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!(await stat(path)).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(path);
    response.writeHead(200, {
      'Content-Type': types[extname(path)] ?? 'application/octet-stream',
      'Content-Length': body.length,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const status = error.code === 'EACCES' ? 403 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500;
    response.writeHead(status).end(status === 403 ? 'Forbidden' : status === 404 ? 'Not found' : 'Server error');
  }
});

server.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, '0.0.0.0', () => {
  console.log(`http://localhost:${server.address().port}`);
});
