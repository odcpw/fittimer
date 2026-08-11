import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  derivePhraseInventory,
  manifestMatchesInventory,
  readJson,
} from '../scripts/voice/build-pack.mjs';
import {
  assertPackAssets,
  assetMetadataMatches,
} from '../scripts/voice/generate-clips.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_PACK = path.join(ROOT, 'scripts/voice/build-pack.mjs');
const GENERATE_CLIPS = path.join(ROOT, 'scripts/voice/generate-clips.mjs');

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${contents}\n`);
  fs.chmodSync(filePath, 0o755);
}

async function runNode(script, args, env = {}) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024,
  });
}

test('voice inventory is mechanically complete for MadFit and W1-W4', () => {
  const inventory = derivePhraseInventory(ROOT);
  assert.deepEqual(
    inventory.routines.map((routine) => routine.id),
    ['madfit-30min-hiit', 'iron-roots', 'silk-coils', 'dragon-longform', 'crane-longform'],
  );
  assert.equal(inventory.intervals.length, 180);
  assert.equal(inventory.phrases.length, 203);
  assert.deepEqual(inventory.sideValues, ['alternating', 'first', 'left', 'right', 'second']);
  for (const requiredId of ['go', 'rest', 'next', 'digit-1', 'digit-2', 'digit-3', 'side-left', 'side-right']) {
    assert.ok(inventory.phrases.some((phrase) => phrase.id === requiredId), requiredId);
  }
  assert.ok(inventory.phrases.every((phrase) => phrase.text.length > 0));
});

test('checked voice manifest matches all installed content and generated assets', () => {
  const inventory = derivePhraseInventory(ROOT);
  const manifest = readJson(path.join(ROOT, 'data/voice/voice-pack-v1.json'));
  assert.equal(manifestMatchesInventory(manifest, inventory), true);
  assert.equal(manifest.generator.version, '0.1.5');
  assert.equal(manifest.generator.voice, 'matt');
  assert.equal(manifest.inventory.assetCount, inventory.phrases.length);
  assert.equal(manifest.phrases.filter((phrase) => phrase.asset).length, inventory.phrases.length);
  assertPackAssets(manifest, ROOT);
});

test('partial generation checks only its range and skips only matching assets', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fittimer-voice-build-'));
  try {
    const toolRoot = path.join(temporaryRoot, 'tool');
    const modelDir = path.join(temporaryRoot, 'model');
    const cacheDir = path.join(temporaryRoot, 'cache');
    const outputDir = path.join(temporaryRoot, 'assets');
    const manifestPath = path.join(temporaryRoot, 'voice-pack.json');
    const ffmpegPath = path.join(toolRoot, 'ffmpeg-stub');
    fs.mkdirSync(toolRoot, { recursive: true });
    fs.mkdirSync(modelDir);
    writeExecutable(path.join(toolRoot, 'ftts'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('ftts 0.1.5'); process.exit(0); }
const output = args[args.indexOf('--output') + 1];
fs.writeFileSync(output, Buffer.from('wav:' + args.at(-1), 'utf8'));
`);
    writeExecutable(ffmpegPath, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const output = args.at(-1);
fs.writeFileSync(output, Buffer.concat([Buffer.from('mp3:', 'utf8'), fs.readFileSync(input)]));
`);

    const common = [
      '--root', ROOT,
      '--manifest', manifestPath,
      '--output-dir', outputDir,
      '--tool-root', toolRoot,
      '--model-dir', modelDir,
      '--cache-dir', cacheDir,
      '--no-resident',
      '--from', '0',
      '--limit', '1',
    ];
    const first = JSON.parse((await runNode(GENERATE_CLIPS, common, { FFMPEG: ffmpegPath })).stdout);
    assert.equal(first.generated, 1);
    assert.equal(first.skipped, 0);
    assert.equal(first.checkedCount, 1);

    const inventory = derivePhraseInventory(ROOT);
    const firstPhrase = inventory.phrases[0];
    const firstManifest = readJson(manifestPath);
    const firstAsset = firstManifest.phrases.find((phrase) => phrase.id === firstPhrase.id).asset;
    const firstPath = path.join(outputDir, `${firstPhrase.id}.mp3`);
    assert.equal(assetMetadataMatches({
      asset: firstAsset,
      phrase: firstPhrase,
      outputPath: firstPath,
      outputUrl: path.relative(ROOT, firstPath).split(path.sep).join('/'),
      voice: 'matt',
    }), true);
    assert.ok(fs.existsSync(firstPath));

    const second = JSON.parse((await runNode(GENERATE_CLIPS, common, { FFMPEG: ffmpegPath })).stdout);
    assert.equal(second.generated, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.checkedCount, 1);

    firstManifest.phrases.find((phrase) => phrase.id === firstPhrase.id).asset.sourceVoice = 'judy';
    fs.writeFileSync(manifestPath, `${JSON.stringify(firstManifest, null, 2)}\n`);
    const third = JSON.parse((await runNode(GENERATE_CLIPS, common, { FFMPEG: ffmpegPath })).stdout);
    assert.equal(third.generated, 1);
    assert.equal(third.skipped, 0);

    const repairedManifest = readJson(manifestPath);
    const repairedAsset = repairedManifest.phrases.find((phrase) => phrase.id === firstPhrase.id).asset;
    assert.equal(repairedAsset.sourceVoice, 'matt');
    const partial = inventory.phrases.slice(0, 1);
    assert.doesNotThrow(() => assertPackAssets(repairedManifest, ROOT, partial));
    assert.throws(() => assertPackAssets(repairedManifest, ROOT), /phrase/);

    await assert.rejects(
      runNode(GENERATE_CLIPS, [...common.slice(0, -4), '--check'], { FFMPEG: ffmpegPath }),
      /phrase|no generated audio asset/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('asset metadata matching rejects changed bytes even when the file remains', () => {
  const bytes = Buffer.from('stable voice bytes');
  const phrase = { id: 'go', text: 'Go' };
  const temporaryPath = path.join(os.tmpdir(), `fittimer-voice-${crypto.randomUUID()}.mp3`);
  try {
    fs.writeFileSync(temporaryPath, bytes);
    const base = {
      type: 'audio/mpeg',
      url: 'data/voice/assets/go.mp3',
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sourceTextSha256: crypto.createHash('sha256').update('Go').digest('hex'),
      sourceVoice: 'matt',
    };
    assert.equal(assetMetadataMatches({
      asset: base,
      phrase,
      outputPath: temporaryPath,
      outputUrl: base.url,
      voice: 'matt',
    }), true);
    fs.writeFileSync(temporaryPath, Buffer.from('changed bytes'));
    assert.equal(assetMetadataMatches({
      asset: base,
      phrase,
      outputPath: temporaryPath,
      outputUrl: base.url,
      voice: 'matt',
    }), false);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
});
