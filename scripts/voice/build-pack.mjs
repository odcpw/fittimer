import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_SCHEMA_VERSION = 1;
export const PACK_ID = 'frankentts-v1';
export const PACK_MANIFEST_PATH = 'data/voice/voice-pack-v1.json';
export const FRANKEN_TTS_VERSION = '0.1.5';
export const FRANKEN_TTS_COMMIT = 'aee1ef4b7813d6d7bdfd2540e3a9a33ea39bf83c';
export const FRANKEN_TTS_MODEL = 'qwen3-tts-12hz-0.6b-base';
export const FRANKEN_TTS_MODEL_MANIFEST_SHA256 =
  '2445f0abcb6a611593bd9adef7cff0989e13dd6be78637ef9d8f8831dd9705f0';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SIDE_ORDER = ['left', 'right', 'alternating', 'bilateral', 'first', 'second'];
const SIDE_TEXT = Object.freeze({
  left: 'Left',
  right: 'Right',
  alternating: 'Alternating sides',
  bilateral: 'Both sides',
  first: 'First side',
  second: 'Second side',
});
const CONTROL_PHRASES = Object.freeze([
  { id: 'go', kind: 'boundary', text: 'Go' },
  { id: 'rest', kind: 'boundary', text: 'Rest' },
  { id: 'next', kind: 'next', text: 'Next' },
]);

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function stableSlug(value) {
  const normalized = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/→/g, ' to ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'unnamed';
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function movementPhraseId(text) {
  return `movement-${stableSlug(text)}`;
}

function addMovementPhrase(phrases, text, source) {
  const id = movementPhraseId(text);
  const existing = phrases.get(id);
  if (existing && existing.text !== text) {
    throw new Error(`phrase ID collision: ${id} maps to both ${existing.text} and ${text}`);
  }
  if (!existing) {
    phrases.set(id, {
      id,
      kind: 'movement',
      text,
      source: {
        routineIds: new Set(),
        blockIds: new Set(),
        movementIds: new Set(),
        roles: new Set(),
      },
    });
  }
  const target = phrases.get(id).source;
  target.routineIds.add(source.routineId);
  target.blockIds.add(source.blockId);
  target.roles.add(source.role);
  for (const movementId of source.movementIds ?? []) target.movementIds.add(movementId);
}

function finalizeSource(source) {
  return {
    routineIds: [...source.routineIds].sort(),
    blockIds: [...source.blockIds].sort(),
    movementIds: [...source.movementIds].sort(),
    roles: [...source.roles].sort(),
  };
}

function sourceForAllContent(routines, blocks) {
  return {
    routineIds: routines.map((routine) => routine.id).sort(),
    blockIds: blocks.map((block) => block.id).sort(),
    movementIds: [],
    roles: ['content-wide'],
  };
}

function phraseRecord(phrase) {
  return {
    id: phrase.id,
    kind: phrase.kind,
    text: phrase.text,
    source: finalizeSource(phrase.source),
  };
}

function inventoryDigest(phrases) {
  const canonical = JSON.stringify(phrases.map(({ id, kind, text, source }) => ({
    id,
    kind,
    text,
    source,
  })));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function loadInstalledContent(root = SCRIPT_ROOT) {
  const indexPath = path.resolve(root, 'data/content-index.json');
  const index = readJson(indexPath);
  if (index.schemaVersion !== 2) throw new Error('content index must use schema version 2');

  const blocksById = new Map();
  for (const [blockId, relativePath] of Object.entries(index.blocks ?? {})) {
    const block = readJson(path.resolve(root, relativePath));
    if (block.id !== blockId) throw new Error(`content index block key ${blockId} disagrees with ${block.id}`);
    if (block.schemaVersion !== 2 || block.kind !== 'block') {
      throw new Error(`block ${blockId} is not a schema-v2 block`);
    }
    blocksById.set(blockId, block);
  }

  const routines = (index.routines ?? []).map((relativePath) => readJson(path.resolve(root, relativePath)));
  for (const routine of routines) {
    if (routine.schemaVersion !== 2 || routine.kind !== 'routine') {
      throw new Error(`routine ${routine.id ?? '<unknown>'} is not a schema-v2 routine`);
    }
    if (!Array.isArray(routine.sequence) || routine.sequence.length === 0) {
      throw new Error(`routine ${routine.id} has no sequence`);
    }
    for (const item of routine.sequence) {
      if (!blocksById.has(item.blockId)) throw new Error(`routine ${routine.id} references unknown block ${item.blockId}`);
    }
  }

  const intervals = [];
  for (const routine of routines) {
    for (const item of routine.sequence) {
      const block = blocksById.get(item.blockId);
      for (const interval of block.intervals ?? []) intervals.push({ routine, block, interval });
    }
  }
  return {
    index,
    routines,
    blocks: [...blocksById.values()],
    intervals,
  };
}

export function derivePhraseInventory(root = SCRIPT_ROOT) {
  const content = loadInstalledContent(root);
  const phrases = new Map();
  const sides = new Set();

  for (const { routine, block, interval } of content.intervals) {
    if (typeof interval.displayName !== 'string' || interval.displayName.trim() === '') {
      throw new Error(`${block.id} interval ${interval.order ?? '?'} has no displayName`);
    }
    const movementIds = (interval.movements ?? []).map((movement) => movement.movementId);
    addMovementPhrase(phrases, interval.displayName, {
      routineId: routine.id,
      blockId: block.id,
      movementIds,
      role: 'interval-display-name',
    });
    for (const movement of interval.movements ?? []) {
      if (!movement.movementId || !movement.displayName) {
        throw new Error(`${block.id} has a movement without movementId/displayName`);
      }
      addMovementPhrase(phrases, movement.displayName, {
        routineId: routine.id,
        blockId: block.id,
        movementIds: [movement.movementId],
        role: 'movement-display-name',
      });
    }
    if (interval.side) sides.add(interval.side);
  }

  const allContentSource = sourceForAllContent(content.routines, content.blocks);
  for (const control of CONTROL_PHRASES) {
    phrases.set(control.id, { ...control, source: allContentSource });
  }
  for (const side of SIDE_ORDER) {
    if (!sides.has(side)) continue;
    phrases.set(`side-${side}`, {
      id: `side-${side}`,
      kind: 'side',
      text: SIDE_TEXT[side],
      source: {
        ...allContentSource,
        roles: ['interval-side'],
      },
    });
  }
  for (const digit of [1, 2, 3]) {
    phrases.set(`digit-${digit}`, {
      id: `digit-${digit}`,
      kind: 'digit',
      text: String(digit),
      source: {
        ...allContentSource,
        roles: ['countdown-digit'],
      },
    });
  }

  const ordered = [...phrases.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(phraseRecord);
  return {
    ...content,
    phrases: ordered,
    inventoryDigest: inventoryDigest(ordered),
    sideValues: [...sides].sort(),
  };
}

function sourceEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildManifest({ root = SCRIPT_ROOT, existing = null, generatedAt = null } = {}) {
  const inventory = derivePhraseInventory(root);
  const previous = new Map((existing?.phrases ?? []).map((phrase) => [phrase.id, phrase]));
  const phrases = inventory.phrases.map((phrase) => ({
    ...phrase,
    asset: previous.get(phrase.id)?.asset ?? null,
  }));
  const assets = phrases.filter((phrase) => phrase.asset !== null).length;
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    kind: 'voicePack',
    id: PACK_ID,
    title: 'FitTimer FrankenTTS voice pack',
    language: 'en-US',
    fallback: 'speechSynthesis',
    generator: {
      tool: 'franken-tts',
      version: FRANKEN_TTS_VERSION,
      sourceCommit: FRANKEN_TTS_COMMIT,
      voice: 'matt',
      model: FRANKEN_TTS_MODEL,
      modelManifestSha256: FRANKEN_TTS_MODEL_MANIFEST_SHA256,
      command: 'ftts say --model <external-model-dir> --voice matt --output <external-wav> <phrase-text>',
      conversion: 'ffmpeg -i <external-wav> -codec:a libmp3lame -b:a 64k -ar 24000 -ac 1 <repo-asset>.mp3',
    },
    inventory: {
      source: 'data/content-index.json',
      routineIds: inventory.routines.map((routine) => routine.id),
      blockIds: inventory.blocks.map((block) => block.id),
      intervalCount: inventory.intervals.length,
      phraseCount: phrases.length,
      assetCount: assets,
      digest: inventory.inventoryDigest,
    },
    generatedAt,
    phrases,
  };
}

export function manifestMatchesInventory(manifest, inventory = derivePhraseInventory()) {
  if (!manifest || manifest.schemaVersion !== PACK_SCHEMA_VERSION || manifest.kind !== 'voicePack') return false;
  if (manifest.id !== PACK_ID) return false;
  // ubs:ignore — inventory digest equality guards content provenance, not a secret or bearer token.
  if (manifest.inventory?.digest !== inventory.inventoryDigest) return false;
  if (manifest.inventory?.phraseCount !== inventory.phrases.length) return false;
  const expected = new Map(inventory.phrases.map((phrase) => [phrase.id, phrase]));
  if (!Array.isArray(manifest.phrases) || manifest.phrases.length !== expected.size) return false;
  for (const phrase of manifest.phrases) {
    const source = expected.get(phrase.id);
    if (!source || phrase.kind !== source.kind || phrase.text !== source.text || !sourceEqual(phrase.source, source.source)) {
      return false;
    }
  }
  return true;
}

function parseArgs(argv) {
  const result = { write: false, check: false, manifestPath: null, root: SCRIPT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') result.write = true;
    else if (arg === '--check') result.check = true;
    else if (arg === '--manifest') result.manifestPath = argv[++index];
    else if (arg === '--root') result.root = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return result;
}

function writeManifest(filePath, manifest) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: node scripts/voice/build-pack.mjs [--write|--check] [--manifest PATH] [--root PATH]');
    return;
  }
  const manifestPath = path.resolve(args.root, args.manifestPath ?? PACK_MANIFEST_PATH);
  const inventory = derivePhraseInventory(args.root);
  if (args.check) {
    const manifest = readJson(manifestPath);
    if (!manifestMatchesInventory(manifest, inventory)) throw new Error(`${manifestPath} does not match installed content`);
    console.log(JSON.stringify({
      manifest: path.relative(args.root, manifestPath),
      phraseCount: inventory.phrases.length,
      intervalCount: inventory.intervals.length,
      assetCount: manifest.inventory.assetCount,
      digest: inventory.inventoryDigest,
    }));
    return;
  }
  const existing = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  const manifest = buildManifest({ root: args.root, existing, generatedAt: existing?.generatedAt ?? null });
  if (args.write) writeManifest(manifestPath, manifest);
  console.log(JSON.stringify({
    manifest: path.relative(args.root, manifestPath),
    phraseCount: manifest.phrases.length,
    intervalCount: manifest.inventory.intervalCount,
    assetCount: manifest.inventory.assetCount,
    digest: manifest.inventory.digest,
    wrote: args.write,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
