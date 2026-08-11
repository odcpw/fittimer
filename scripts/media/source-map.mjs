#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOLUTIONS = new Set(['exact', 'reuse', 'poster', 'text', 'search-required']);
const SIDES = new Set(['left', 'right', 'alternating', 'bilateral', 'first', 'second', 'unspecified']);
const MIRRORING = new Set(['never', 'when-needed']);
const LOOP_KINDS = new Set(['reps', 'compound', 'hold', 'mobility']);
const QUALITY = new Set(['high', 'medium-high']);
const SAFE_REGIONS = ['hands', 'feet', 'equipment', 'movementPath'];

async function readJson(file) {
  const absoluteFile = path.resolve(REPO_ROOT, file);
  let raw;
  try {
    raw = await readFile(absoluteFile, 'utf8');
  } catch (caught) {
    throw new Error(`Cannot read ${absoluteFile}: ${caught.message}`, { cause: caught });
  }
  try {
    return JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Invalid JSON in ${absoluteFile}: ${caught.message}`, { cause: caught });
  }
}

function error(errors, code, location, message) {
  errors.push({ code, location, message });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function stringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(string);
}

function validateRect(value, location, errors) {
  if (!object(value)) {
    error(errors, 'EXPECTED_RECT', location, 'must be a normalized rectangle');
    return;
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      error(errors, 'INVALID_RECT', `${location}.${key}`, 'must be a finite number');
    }
  }
  if (errors.some((entry) => entry.location.startsWith(`${location}.`))) return;
  if (value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0 || value.x + value.width > 1 || value.y + value.height > 1) {
    error(errors, 'INVALID_RECT', location, 'must stay inside the normalized source frame');
  }
}

function rectContains(outer, inner) {
  return object(outer) && object(inner)
    && inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function validateCropPixels(candidate, location, errors) {
  const dimensions = candidate.source?.dimensions;
  if (!object(dimensions)
      || !Number.isInteger(dimensions.width)
      || !Number.isInteger(dimensions.height)
      || dimensions.width <= 0
      || dimensions.height <= 0) {
    error(errors, 'INVALID_SOURCE_DIMENSIONS', `${location}.source.dimensions`, 'must contain positive integer width and height');
    return;
  }
  if (!object(candidate.crop)) return;

  const pixels = {
    x: Math.round(candidate.crop.x * dimensions.width),
    y: Math.round(candidate.crop.y * dimensions.height),
    width: Math.round(candidate.crop.width * dimensions.width),
    height: Math.round(candidate.crop.height * dimensions.height),
  };
  if (Object.values(pixels).some((value) => value % 2 !== 0)) {
    error(errors, 'UNSAFE_CROP_PIXEL_ALIGNMENT', `${location}.crop`, `resolves to ${pixels.x},${pixels.y},${pixels.width}x${pixels.height}; yuv420p crop coordinates and dimensions must be even`);
  }
  if (pixels.width * 9 !== pixels.height * 16) {
    error(errors, 'NON_16_9_PIXEL_CROP', `${location}.crop`, `resolves to ${pixels.width}x${pixels.height}, not exact 16:9`);
  }
  if (pixels.x < 0 || pixels.y < 0 || pixels.x + pixels.width > dimensions.width || pixels.y + pixels.height > dimensions.height) {
    error(errors, 'CROP_OUTSIDE_SOURCE', `${location}.crop`, `resolves outside the ${dimensions.width}x${dimensions.height} source`);
  }
}

function validateCandidate(candidate, location, errors) {
  if (!object(candidate)) {
    error(errors, 'EXPECTED_CANDIDATE', location, 'must be an exact timed source candidate');
    return;
  }
  if (!object(candidate.source)) {
    error(errors, 'INVALID_SOURCE', `${location}.source`, 'must be an object');
  } else {
    for (const key of ['channel', 'title', 'videoId', 'url']) {
      if (!string(candidate.source[key])) error(errors, 'INVALID_SOURCE', `${location}.source.${key}`, 'must be a non-empty string');
    }
    if (candidate.source.localOnly !== true) error(errors, 'SOURCE_NOT_LOCAL_ONLY', `${location}.source.localOnly`, 'must be true');
    if (string(candidate.source.videoId) && string(candidate.source.url) && !candidate.source.url.includes(candidate.source.videoId)) {
      error(errors, 'SOURCE_ID_URL_MISMATCH', `${location}.source.url`, 'must contain the declared videoId');
    }
  }
  if (!SIDES.has(candidate.side)) error(errors, 'INVALID_SIDE', `${location}.side`, 'is not a supported side');
  if (!MIRRORING.has(candidate.mirroring)) error(errors, 'INVALID_MIRRORING', `${location}.mirroring`, 'must be never or when-needed');
  if (!stringArray(candidate.equipment)) error(errors, 'INVALID_EQUIPMENT', `${location}.equipment`, 'must be a non-empty string array');
  if (!string(candidate.viewpoint)) error(errors, 'INVALID_VIEWPOINT', `${location}.viewpoint`, 'must be a non-empty string');

  if (!object(candidate.range) || typeof candidate.range.startSeconds !== 'number' || typeof candidate.range.endSeconds !== 'number' || candidate.range.startSeconds < 0 || candidate.range.endSeconds <= candidate.range.startSeconds) {
    error(errors, 'INVALID_RANGE', `${location}.range`, 'must have ordered non-negative startSeconds/endSeconds');
  }
  validateRect(candidate.crop, `${location}.crop`, errors);
  validateCropPixels(candidate, location, errors);
  if (!object(candidate.safeFrame)) {
    error(errors, 'INVALID_SAFE_FRAME', `${location}.safeFrame`, 'must contain all four safety regions');
  } else {
    for (const region of SAFE_REGIONS) {
      validateRect(candidate.safeFrame[region], `${location}.safeFrame.${region}`, errors);
      if (object(candidate.crop) && object(candidate.safeFrame[region]) && !rectContains(candidate.crop, candidate.safeFrame[region])) {
        error(errors, 'UNSAFE_REGION_OUTSIDE_CROP', `${location}.safeFrame.${region}`, `must stay inside the proposed crop`);
      }
    }
  }

  if (!object(candidate.loop) || !LOOP_KINDS.has(candidate.loop.kind)) {
    error(errors, 'INVALID_LOOP', `${location}.loop`, 'must declare reps, compound, hold, or mobility');
  } else {
    if (candidate.loop.phaseMatch !== true) error(errors, 'UNMATCHED_LOOP', `${location}.loop.phaseMatch`, 'must be true');
    if (!string(candidate.loop.startPhase) || !string(candidate.loop.endPhase)) {
      error(errors, 'INVALID_LOOP_PHASE', `${location}.loop`, 'must describe matching start and end phases');
    }
    if (candidate.loop.kind === 'reps' || candidate.loop.kind === 'compound') {
      if (!Number.isInteger(candidate.loop.reps) || candidate.loop.reps < 1 || candidate.loop.reps > 5) {
        error(errors, 'INVALID_REP_COUNT', `${location}.loop.reps`, 'must contain one through five complete reps');
      }
    } else if (typeof candidate.loop.durationSeconds !== 'number' || candidate.loop.durationSeconds <= 0) {
      error(errors, 'INVALID_JUDGED_DURATION', `${location}.loop.durationSeconds`, 'must be positive');
    } else if (object(candidate.range) && Math.abs(candidate.loop.durationSeconds - (candidate.range.endSeconds - candidate.range.startSeconds)) > 0.05) {
      error(errors, 'JUDGED_DURATION_MISMATCH', `${location}.loop.durationSeconds`, 'must match the selected source range');
    }
  }

  if (!object(candidate.form) || !QUALITY.has(candidate.form.quality) || !string(candidate.form.notes)) {
    error(errors, 'INVALID_FORM_REVIEW', `${location}.form`, 'must contain high/medium-high quality and review notes');
  }
  if (!object(candidate.verification) || candidate.verification.status !== 'verified-normal-speed' || !string(candidate.verification.notes)) {
    error(errors, 'UNVERIFIED_CANDIDATE', `${location}.verification`, 'must record normal-speed verification evidence');
  }
}

function validateRecord(record, location, errors, seen) {
  if (!object(record)) {
    error(errors, 'EXPECTED_RECORD', location, 'must be an object');
    return;
  }
  if (!string(record.movementId) || !ID_PATTERN.test(record.movementId)) {
    error(errors, 'INVALID_MOVEMENT_ID', `${location}.movementId`, 'must be lowercase kebab-case');
  } else if (seen.has(record.movementId)) {
    error(errors, 'DUPLICATE_MOVEMENT_ID', `${location}.movementId`, `duplicates ${seen.get(record.movementId)}`);
  } else {
    seen.set(record.movementId, location);
  }
  if (!stringArray(record.aliases)) error(errors, 'INVALID_ALIASES', `${location}.aliases`, 'must contain at least one name');
  if (!object(record.requirements) || !stringArray(record.requirements.sides) || !record.requirements.sides.every((side) => SIDES.has(side)) || !stringArray(record.requirements.equipment) || !string(record.requirements.form)) {
    error(errors, 'INVALID_REQUIREMENTS', `${location}.requirements`, 'must declare sides, equipment, and exact form requirement');
  }
  if (!RESOLUTIONS.has(record.resolution)) {
    error(errors, 'INVALID_RESOLUTION', `${location}.resolution`, 'is not supported');
    return;
  }
  if (record.resolution === 'exact') {
    if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
      error(errors, 'MISSING_CANDIDATE', `${location}.candidates`, 'exact resolution requires at least one candidate');
    } else {
      record.candidates.forEach((candidate, index) => validateCandidate(candidate, `${location}.candidates[${index}]`, errors));
    }
  } else if (record.resolution === 'reuse') {
    if (!object(record.reuse) || !string(record.reuse.packId) || !string(record.reuse.movementId) || !SIDES.has(record.reuse.side) || !string(record.reuse.notes)) {
      error(errors, 'INVALID_REUSE', `${location}.reuse`, 'must identify an honest pack movement, side, and notes');
    }
  } else if (!object(record.deliberate) || !string(record.deliberate.reason)) {
    error(errors, 'MISSING_CLASSIFICATION_REASON', `${location}.deliberate.reason`, 'must explain the deliberate classification');
  }
}

export function validateClipSourceMap(map, { requiredMovementIds = [], requireReady = false } = {}) {
  const errors = [];
  if (!object(map)) return { valid: false, ready: false, errors: [{ code: 'EXPECTED_MAP', location: '$', message: 'must be an object' }] };
  if (map.schemaVersion !== 1) error(errors, 'INVALID_SCHEMA_VERSION', '$.schemaVersion', 'must equal 1');
  if (map.kind !== 'clipSourceMap') error(errors, 'INVALID_KIND', '$.kind', 'must equal clipSourceMap');
  if (!string(map.id) || !ID_PATTERN.test(map.id)) error(errors, 'INVALID_MAP_ID', '$.id', 'must be lowercase kebab-case');
  if (map.localOnly !== true) error(errors, 'MAP_NOT_LOCAL_ONLY', '$.localOnly', 'must be true');
  if (!stringArray(map.targetBlockFiles)) error(errors, 'INVALID_TARGETS', '$.targetBlockFiles', 'must list target block files');
  if (!object(map.outputContract) || map.outputContract.aspectRatio !== '16:9' || map.outputContract.orientation !== 'landscape' || map.outputContract.fullMotionPath !== true || !Array.isArray(map.outputContract.normalRepRange) || map.outputContract.normalRepRange[0] !== 2 || map.outputContract.normalRepRange[1] !== 5) {
    error(errors, 'INVALID_OUTPUT_CONTRACT', '$.outputContract', 'must require landscape 16:9, full motion path, and two-to-five normal reps');
  }
  if (!Array.isArray(map.records)) {
    error(errors, 'INVALID_RECORDS', '$.records', 'must be an array');
  } else {
    const seen = new Map();
    map.records.forEach((record, index) => validateRecord(record, `$.records[${index}]`, errors, seen));
    for (const movementId of new Set(requiredMovementIds)) {
      if (!seen.has(movementId)) error(errors, 'UNCOVERED_MOVEMENT_ID', '$.records', `missing ${movementId}`);
    }
    for (const movementId of seen.keys()) {
      if (requiredMovementIds.length > 0 && !requiredMovementIds.includes(movementId)) {
        error(errors, 'STALE_MOVEMENT_ID', seen.get(movementId), `${movementId} is not referenced by the target blocks`);
      }
    }
  }
  const pending = Array.isArray(map.records) ? map.records.filter((record) => record?.resolution === 'search-required').map((record) => record.movementId) : [];
  if (requireReady && pending.length > 0) error(errors, 'SOURCE_MAP_NOT_READY', '$.records', `still requires research: ${pending.join(', ')}`);
  return { valid: errors.length === 0, ready: errors.length === 0 && pending.length === 0, pending, errors };
}

export async function movementInventory(blockFiles) {
  const inventory = new Map();
  for (const relativeFile of blockFiles) {
    const block = await readJson(relativeFile);
    for (const interval of block.intervals ?? []) {
      for (const movement of interval.movements ?? []) {
        const record = inventory.get(movement.movementId) ?? { movementId: movement.movementId, aliases: new Set(), uses: [] };
        record.aliases.add(movement.displayName);
        record.uses.push({ blockId: block.id, intervalName: interval.displayName, side: interval.side ?? 'bilateral' });
        inventory.set(movement.movementId, record);
      }
    }
  }
  return [...inventory.values()].sort((left, right) => left.movementId.localeCompare(right.movementId)).map((record) => ({
    ...record,
    aliases: [...record.aliases].sort(),
  }));
}

export async function validateClipSourceMapFile(file, options = {}) {
  const parsed = await readJson(file);
  return validateClipSourceMap(parsed, options);
}

async function main(argv) {
  let file = 'data/media/clip-sources.json';
  let requireReady = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--file') {
      file = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--require-ready') {
      requireReady = true;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  const parsed = await readJson(file);
  const inventory = await movementInventory(parsed.targetBlockFiles ?? []);
  const result = validateClipSourceMap(parsed, {
    requiredMovementIds: inventory.map(({ movementId }) => movementId),
    requireReady,
  });
  process.stdout.write(`${JSON.stringify({ file, movementCount: inventory.length, ...result }, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((caught) => {
    process.stderr.write(`${caught.stack ?? caught.message}\n`);
    process.exitCode = 1;
  });
}
