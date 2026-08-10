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

const manifest = await readJson('manifest.webmanifest');
assert.equal(manifest.start_url, './');
assert.equal(manifest.scope, './');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.orientation, 'portrait-primary');
assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose.includes('maskable')));
assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose.includes('maskable')));

for (const icon of manifest.icons) await exists(icon.src);
await exists('icons/apple-touch-icon.png');

const index = await readJson('data/content-index.json');
assert.equal(index.schemaVersion, 1);
assert.ok(index.routines.length > 0);

const gifPaths = new Set();
for (const routineFile of index.routines) {
  const routine = await readJson(routineFile);
  for (const item of routine.sequence) {
    const intervals = item.interval ? [item.interval] : (await readJson(index.blocks[item.blockId])).intervals;
    for (const interval of intervals) {
      for (const movement of interval.movements) {
        if (movement.gif) gifPaths.add(movement.gif);
      }
    }
  }
}
for (const gif of gifPaths) await exists(gif);

const serviceWorker = await readFile(path.join(ROOT, 'sw.js'), 'utf8');
for (const shellFile of ['index.html', 'styles.css', 'manifest.webmanifest', 'src/app.mjs', 'src/interval-engine.mjs']) {
  assert.match(serviceWorker, new RegExp(shellFile.replaceAll('.', '\\.')));
}
assert.doesNotMatch(serviceWorker, /catalog_full\.json/);

process.stdout.write(
  `PWA checks passed: ${index.routines.length} routine(s), ${gifPaths.size} referenced GIF(s), ` +
    `${manifest.icons.length} install icon(s).\n`,
);
