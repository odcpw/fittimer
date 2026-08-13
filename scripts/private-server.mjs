#!/usr/bin/env node

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const PRIVATE_PREFIX = '/private-packs/';

const PUBLIC_FILES = new Set([
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'sw.js',
  'data/content-index.json',
]);
const PUBLIC_DIRECTORIES = [
  'icons',
  'avatar-lab',
  'src',
  'data/blocks',
  'data/routines',
  'data/media',
  'data/gifs',
  'data/voice',
];
const PRIVATE_EXTENSIONS = new Set([
  '.json',
  '.gif',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.mp4',
  '.m4v',
  '.webm',
  '.mov',
]);
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.glb', 'model/gltf-binary'],
  ['.html', 'text/html; charset=utf-8'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.m4v', 'video/mp4'],
  ['.manifest', 'application/manifest+json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webm', 'video/webm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function decodeRoutePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded.slice(1);
  if (!relative) return '';
  const parts = relative.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (parts.some((part) => part.startsWith('.'))) return null;
  return parts.join('/');
}

function isPublicPath(relative) {
  if (PUBLIC_FILES.has(relative)) return true;
  return PUBLIC_DIRECTORIES.some((directory) => relative.startsWith(`${directory}/`));
}

function privatePathAllowed(relative) {
  if (!relative || relative === 'index.json') return relative === 'index.json';
  const extension = path.extname(relative).toLowerCase();
  return PRIVATE_EXTENSIONS.has(extension);
}

function contentType(file) {
  return MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
}

function parseRange(range, size) {
  if (typeof range !== 'string' || !range.startsWith('bytes=') || range.includes(',')) return null;
  const value = range.slice('bytes='.length).trim();
  const match = /^(\d*)-(\d*)$/.exec(value);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (start >= size || start > end) return { unsatisfiable: true };
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function resolveFile(root, relative) {
  if (!relative) return null;
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) return null;
  let resolved;
  try {
    resolved = await realpath(candidate);
    if (!isInside(root, resolved)) return null;
    const metadata = await stat(resolved);
    if (!metadata.isFile()) return null;
    return { file: resolved, size: metadata.size, mtimeMs: metadata.mtimeMs };
  } catch {
    return null;
  }
}

function requestPath(request) {
  try {
    return new URL(request.url ?? '/', 'http://localhost/');
  } catch {
    return null;
  }
}

function sendText(response, status, text) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

function serveFile(request, response, resolved, { discovery = false } = {}) {
  const range = request.headers.range;
  const parsedRange = range ? parseRange(range, resolved.size) : null;
  if (range && (!parsedRange || parsedRange.unsatisfiable)) {
    response.writeHead(416, {
      'Content-Range': `bytes */${resolved.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': '0',
      'Cache-Control': discovery ? 'no-store' : 'private, max-age=0, must-revalidate',
    });
    response.end();
    return;
  }
  const start = parsedRange?.start ?? 0;
  const end = parsedRange?.end ?? Math.max(0, resolved.size - 1);
  const length = resolved.size === 0 ? 0 : end - start + 1;
  const headers = {
    'Content-Type': contentType(resolved.file),
    'Content-Length': length,
    'Accept-Ranges': 'bytes',
    'Cache-Control': discovery ? 'no-store' : 'private, max-age=0, must-revalidate',
  };
  // ubs:ignore — only a validated range branch adds the fixed Content-Range header below.
  if (parsedRange) {
    // ubs:ignore — the key is a fixed response header; validated numeric range endpoints are not object keys.
    headers['Content-Range'] = `bytes ${start}-${end}/${resolved.size}`;
  }
  response.writeHead(parsedRange ? 206 : 200, headers);
  if (request.method === 'HEAD' || length === 0) {
    response.end();
    return;
  }
  createReadStream(resolved.file, { start, end }).on('error', () => response.destroy()).pipe(response);
}

export function parseServerArgs(argv = []) {
  const options = {
    root: process.env.FITTIMER_ROOT ?? SCRIPT_ROOT,
    privatePackRoot: process.env.FITTIMER_PRIVATE_PACK_ROOT ?? null,
    host: process.env.FITTIMER_HOST ?? DEFAULT_HOST,
    port: Number(process.env.FITTIMER_PORT ?? DEFAULT_PORT),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--root') options.root = argv[++index];
    else if (argument === '--private-pack-root') options.privatePackRoot = argv[++index];
    else if (argument === '--host') options.host = argv[++index];
    else if (argument === '--port') options.port = Number(argv[++index]);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error('port must be an integer from 0 to 65535');
  }
  if (!isLoopbackHost(options.host)) throw new Error('host must be localhost, 127.0.0.1, or ::1');
  return options;
}

export function createPrivateServer(options = {}) {
  const root = path.resolve(options.root ?? SCRIPT_ROOT);
  const privatePackRoot = options.privatePackRoot ? path.resolve(options.privatePackRoot) : null;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  if (!isLoopbackHost(host)) throw new Error('host must be localhost, 127.0.0.1, or ::1');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('port must be an integer from 0 to 65535');

  const server = http.createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      sendText(response, 405, 'Method Not Allowed');
      return;
    }
    const url = requestPath(request);
    const pathname = url?.pathname;
    const relative = pathname ? decodeRoutePath(pathname) : null;
    if (relative === null) {
      sendText(response, 404, 'Not Found');
      return;
    }
    const isPrivate = relative.startsWith(PRIVATE_PREFIX.slice(1));
    let resolved = null;
    let discovery = false;
    if (isPrivate) {
      const privateRelative = relative.slice(PRIVATE_PREFIX.length - 1);
      discovery = privateRelative === 'index.json';
      if (privatePackRoot && privatePathAllowed(privateRelative)) {
        resolved = await resolveFile(privatePackRoot, privateRelative);
      }
    } else if (relative === '' || isPublicPath(relative)) {
      resolved = await resolveFile(root, relative || 'index.html');
    }
    if (!resolved) {
      sendText(response, 404, 'Not Found');
      return;
    }
    serveFile(request, response, resolved, { discovery });
  });

  return {
    server,
    host,
    port,
    root,
    privatePackRoot,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function main() {
  const options = parseServerArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/private-server.mjs --private-pack-root DIR [--port PORT] [--host 127.0.0.1]\n');
    return;
  }
  if (!options.privatePackRoot) {
    throw new Error('private pack root is required; pass --private-pack-root DIR or FITTIMER_PRIVATE_PACK_ROOT');
  }
  await access(options.root);
  await access(path.join(options.privatePackRoot, 'index.json'));
  const app = createPrivateServer(options);
  const address = await app.listen();
  const port = typeof address === 'object' && address ? address.port : options.port;
  process.stdout.write(`FitTimer private server listening at http://${options.host}:${port}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
