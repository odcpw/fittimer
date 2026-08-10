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
for (const shellFile of ['index.html', 'styles.css', 'manifest.webmanifest', 'src/app.mjs', 'src/audio-cues.mjs', 'src/interval-engine.mjs']) {
  assert.match(serviceWorker, new RegExp(shellFile.replaceAll('.', '\\.')));
}
assert.doesNotMatch(serviceWorker, /catalog_full\.json/);
assert.match(serviceWorker, /fittimer-v2/);
const assetResponse = serviceWorker.match(/async function assetResponse[\s\S]*?\n}\n/);
assert.ok(assetResponse, 'service worker asset response handler is present');
assert.doesNotMatch(assetResponse[0], /cache\.put/);

const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const application = await readFile(path.join(ROOT, 'src', 'app.mjs'), 'utf8');
assert.doesNotMatch(html, /<audio[\s>]/i, 'HTML audio elements would interfere with background music');
assert.doesNotMatch(application, /mediaSession/i, 'Media Session must not claim background music controls');

process.stdout.write(
  `PWA checks passed: ${index.routines.length} routine(s), ${mediaPaths.size - 1} selected media asset(s), ` +
    `${manifest.icons.length} install icon(s).\n`,
);
