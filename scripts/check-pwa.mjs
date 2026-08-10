#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function readJson(file) {
  const source = await readFile(path.join(ROOT, file), 'utf8');
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`, { cause: error });
  }
}
const exists = async (file) => access(path.join(ROOT, file));

function repoRelative(absoluteFile) {
  const relative = path.relative(ROOT, absoluteFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function staticImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /^\s*import\s+(?:(?:[\s\S]*?)\sfrom\s+)?['"]([^'"]+)['"]\s*;?/gm,
    /^\s*export\s+(?:[\s\S]*?\sfrom\s+)['"]([^'"]+)['"]\s*;?/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

async function resolveLocalModule(fromFile, specifier) {
  const base = path.resolve(ROOT, path.dirname(fromFile), specifier);
  const candidates = path.extname(base)
    ? [base]
    : [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.mjs'), path.join(base, 'index.js')];
  for (const candidate of candidates) {
    const repoPath = repoRelative(candidate);
    if (!repoPath || !/\.m?js$/.test(repoPath)) continue;
    try {
      await access(candidate);
      return repoPath;
    } catch {
      // Try the next standard extension/index form.
    }
  }
  throw new Error(`${fromFile} imports missing local module ${specifier}`);
}

async function collectStaticImportClosure(entryFile) {
  const closure = new Set();
  const pending = [entryFile];
  while (pending.length > 0) {
    const current = pending.pop();
    if (closure.has(current)) continue;
    closure.add(current);
    const source = await readFile(path.join(ROOT, current), 'utf8');
    for (const specifier of staticImportSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const localModule = await resolveLocalModule(current, specifier);
      if (!closure.has(localModule)) pending.push(localModule);
    }
  }
  return [...closure].sort();
}

const manifest = await readJson('manifest.webmanifest');
assert.equal(manifest.start_url, './');
assert.equal(manifest.scope, './');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.orientation, 'landscape');
assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose.includes('maskable')));
assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose.includes('maskable')));

for (const icon of manifest.icons) await exists(icon.src);
await exists('icons/apple-touch-icon.png');

const index = await readJson('data/content-index.json');
assert.equal(index.schemaVersion, 2);
assert.ok(index.routines.length > 0);
assert.equal(index.defaultMediaPack, 'gif-v1');
assert.ok(index.mediaPacks && typeof index.mediaPacks === 'object');

const selectedPack = await readJson(index.mediaPacks[index.defaultMediaPack]);
assert.equal(selectedPack.schemaVersion, 1);
assert.equal(selectedPack.kind, 'mediaPack');
assert.equal(selectedPack.id, index.defaultMediaPack);
assert.deepEqual(selectedPack.outputFrame, {
  orientation: 'landscape',
  width: 16,
  height: 9,
  qaViewport: { width: 844, height: 390 },
  scalePolicy: 'avoid-upsample',
});

const movementIds = new Set();
for (const routineFile of index.routines) {
  const routine = await readJson(routineFile);
  assert.equal(routine.schemaVersion, 2);
  for (const item of routine.sequence) {
    const intervals = item.interval ? [item.interval] : (await readJson(index.blocks[item.blockId])).intervals;
    for (const interval of intervals) {
      for (const movement of interval.movements) {
        assert.ok(movement.movementId);
        assert.equal('gif' in movement, false);
        movementIds.add(movement.movementId);
      }
    }
  }
}

const mediaPaths = new Set([index.mediaPacks[index.defaultMediaPack]]);
for (const movementId of movementIds) {
  const entry = selectedPack.entries[movementId];
  assert.ok(entry, `selected media pack does not cover ${movementId}`);
  for (const asset of entry.assets) {
    mediaPaths.add(asset.url);
    await exists(asset.url);
  }
}

const serviceWorker = await readFile(path.join(ROOT, 'sw.js'), 'utf8');
const shellDeclaration = serviceWorker.match(/const APP_SHELL = \[([\s\S]*?)\n\];/);
assert.ok(shellDeclaration, 'service worker APP_SHELL declaration is present');
const shellPaths = new Set([...shellDeclaration[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]));
for (const shellFile of ['index.html', 'styles.css', 'manifest.webmanifest']) {
  assert.ok(shellPaths.has(`./${shellFile}`), `APP_SHELL is missing ${shellFile}`);
}
const importClosure = await collectStaticImportClosure('src/app.mjs');
for (const importedFile of importClosure) {
  assert.ok(shellPaths.has(`./${importedFile}`), `APP_SHELL is missing static import ${importedFile}`);
}
assert.doesNotMatch(serviceWorker, /catalog_full\.json/);
assert.match(serviceWorker, /fittimer-v4/);
const assetResponse = serviceWorker.match(/async function assetResponse[\s\S]*?\n}\n/);
assert.ok(assetResponse, 'service worker asset response handler is present');
assert.doesNotMatch(assetResponse[0], /cache\.put/);

const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const application = await readFile(path.join(ROOT, 'src', 'app.mjs'), 'utf8');
assert.doesNotMatch(html, /<audio[\s>]/i, 'HTML audio elements would interfere with background music');
assert.doesNotMatch(application, /mediaSession/i, 'Media Session must not claim background music controls');

process.stdout.write(
  `PWA checks passed: ${index.routines.length} routine(s), ${mediaPaths.size - 1} selected media asset(s), ` +
    `${manifest.icons.length} install icon(s), ${importClosure.length} shell JS module(s).\n`,
);
