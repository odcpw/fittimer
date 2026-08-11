#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKS_DIR = path.join(REPO_ROOT, 'data', 'blocks');
const MEDIA_DIR = path.join(REPO_ROOT, 'data', 'media');
const ROUTINES_DIR = path.join(REPO_ROOT, 'data', 'routines');
const CONTENT_SCHEMA_VERSION = 2;
const MEDIA_SCHEMA_VERSION = 1;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SIDE_VALUES = new Set(['left', 'right', 'alternating', 'bilateral', 'first', 'second']);
const MATCH_VALUES = new Set(['exact', 'close', 'combo', 'loose', 'none']);
const ANATOMICAL_SIDE_VALUES = new Set(['left', 'right', 'bilateral', 'alternating', 'unspecified']);
const MIRRORING_VALUES = new Set(['never', 'when-needed', 'always']);
const ASSET_TYPES = new Set(['video', 'animated-webp', 'gif', 'poster']);
const FIT_VALUES = new Set(['contain', 'cover']);
const SAFE_REGION_NAMES = ['hands', 'feet', 'equipment', 'movementPath'];

class ValidationError extends Error {
  constructor(code, location, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.location = location;
  }
}

function fail(errors, code, location, message) {
  errors.push(new ValidationError(code, location, message));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkObject(value, allowedKeys, location, errors, schemaLabel = 'schema') {
  if (!isObject(value)) {
    fail(errors, 'EXPECTED_OBJECT', location, 'must be an object');
    return false;
  }

  for (const key of Object.keys(value)) {
    if (allowedKeys !== null && !allowedKeys.has(key)) {
      fail(errors, 'UNKNOWN_FIELD', `${location}.${key}`, `is not part of ${schemaLabel}`);
    }
  }
  return true;
}

function checkString(value, location, errors, { optional = false } = {}) {
  if (optional && value === undefined) return true;
  if (typeof value !== 'string' || value.trim() === '') {
    fail(errors, 'INVALID_STRING', location, 'must be a non-empty string');
    return false;
  }
  return true;
}

function checkStringArray(value, location, errors, { optional = false } = {}) {
  if (optional && value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0) {
    fail(errors, 'INVALID_STRING_ARRAY', location, 'must be a non-empty array of strings');
    return false;
  }
  value.forEach((item, index) => checkString(item, `${location}[${index}]`, errors));
  return true;
}

function checkPositiveInteger(value, location, errors) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(errors, 'INVALID_POSITIVE_INTEGER', location, 'must be a positive integer');
    return false;
  }
  return true;
}

function checkId(value, location, errors) {
  if (!checkString(value, location, errors)) return false;
  if (!ID_PATTERN.test(value)) {
    fail(errors, 'INVALID_ID', location, 'must be a lowercase kebab-case identifier');
    return false;
  }
  return true;
}

function checkNormalizedNumber(value, location, errors, { inclusiveMinimum = 0, inclusiveMaximum = 1 } = {}) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < inclusiveMinimum ||
    value > inclusiveMaximum
  ) {
    fail(
      errors,
      'INVALID_NORMALIZED_NUMBER',
      location,
      `must be a finite number from ${inclusiveMinimum} to ${inclusiveMaximum}`,
    );
    return false;
  }
  return true;
}

function validatePoint(point, location, errors) {
  if (!checkObject(point, new Set(['x', 'y']), location, errors, 'media schema')) return false;
  const validX = checkNormalizedNumber(point.x, `${location}.x`, errors);
  const validY = checkNormalizedNumber(point.y, `${location}.y`, errors);
  return validX && validY;
}

function validateRect(rect, location, errors) {
  if (!checkObject(rect, new Set(['x', 'y', 'width', 'height']), location, errors, 'media schema')) {
    return false;
  }
  const validX = checkNormalizedNumber(rect.x, `${location}.x`, errors);
  const validY = checkNormalizedNumber(rect.y, `${location}.y`, errors);
  const validWidth = checkNormalizedNumber(rect.width, `${location}.width`, errors);
  const validHeight = checkNormalizedNumber(rect.height, `${location}.height`, errors);
  if (validWidth && rect.width <= 0) {
    fail(errors, 'INVALID_RECTANGLE', `${location}.width`, 'must be greater than zero');
  }
  if (validHeight && rect.height <= 0) {
    fail(errors, 'INVALID_RECTANGLE', `${location}.height`, 'must be greater than zero');
  }
  if (validX && validWidth && rect.x + rect.width > 1) {
    fail(errors, 'INVALID_RECTANGLE', location, 'must stay within the normalized source frame');
  }
  if (validY && validHeight && rect.y + rect.height > 1) {
    fail(errors, 'INVALID_RECTANGLE', location, 'must stay within the normalized source frame');
  }
  return validX && validY && validWidth && validHeight && rect.width > 0 && rect.height > 0;
}

function validateFramingProfile(profile, location, errors) {
  const allowed = new Set(['fit', 'crop', 'zoom', 'anchor', 'safeRegions']);
  if (!checkObject(profile, allowed, location, errors, 'media schema')) return null;

  if (!FIT_VALUES.has(profile.fit)) {
    fail(errors, 'INVALID_FRAMING_FIT', `${location}.fit`, 'must be "contain" or "cover"');
  }
  const cropValid = validateRect(profile.crop, `${location}.crop`, errors);
  if (
    typeof profile.zoom !== 'number' ||
    !Number.isFinite(profile.zoom) ||
    profile.zoom < 1 ||
    profile.zoom > 8
  ) {
    fail(errors, 'INVALID_FRAMING_ZOOM', `${location}.zoom`, 'must be a finite scale from 1 through 8');
  }
  validatePoint(profile.anchor, `${location}.anchor`, errors);

  if (!checkObject(profile.safeRegions, new Set(SAFE_REGION_NAMES), `${location}.safeRegions`, errors, 'media schema')) {
    return profile;
  }
  let allRegionsValid = true;
  for (const name of SAFE_REGION_NAMES) {
    const regionValid = validateRect(profile.safeRegions[name], `${location}.safeRegions.${name}`, errors);
    allRegionsValid = regionValid && allRegionsValid;
    if (
      cropValid &&
      regionValid &&
      (
        profile.safeRegions[name].x < profile.crop.x ||
        profile.safeRegions[name].y < profile.crop.y ||
        profile.safeRegions[name].x + profile.safeRegions[name].width > profile.crop.x + profile.crop.width ||
        profile.safeRegions[name].y + profile.safeRegions[name].height > profile.crop.y + profile.crop.height
      )
    ) {
      fail(
        errors,
        'UNSAFE_CROP',
        `${location}.safeRegions.${name}`,
        'must remain inside the declared crop rectangle',
      );
    }
  }

  return { cropValid, allRegionsValid };
}

async function readJson(file) {
  const absolute = path.resolve(REPO_ROOT, file);
  try {
    return JSON.parse(await readFile(absolute, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError('INVALID_JSON', file, error.message);
    }
    throw new ValidationError('READ_ERROR', file, error.message);
  }
}

async function pathIsFile(repoRelativePath) {
  const absolute = path.resolve(REPO_ROOT, repoRelativePath);
  if (!absolute.startsWith(`${REPO_ROOT}${path.sep}`)) return false;
  try {
    return (await stat(absolute)).isFile();
  } catch {
    return false;
  }
}

function normalizedDataPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || !normalized.startsWith('data/') || normalized.includes('\0')) return null;
  return normalized;
}

function expectedAssetExtensions(type) {
  return {
    video: new Set(['.mp4', '.webm', '.mov']),
    'animated-webp': new Set(['.webp']),
    gif: new Set(['.gif']),
    poster: new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']),
  }[type];
}

async function validateAsset(asset, location, framingProfiles, errors) {
  const allowed = new Set(['type', 'url', 'audio', 'framing']);
  if (!checkObject(asset, allowed, location, errors, 'media schema')) return;

  if (!ASSET_TYPES.has(asset.type)) {
    fail(errors, 'INVALID_ASSET_TYPE', `${location}.type`, 'must be video, animated-webp, gif, or poster');
  }
  const hasUrl = checkString(asset.url, `${location}.url`, errors);
  const normalized = hasUrl ? normalizedDataPath(asset.url) : null;
  if (hasUrl && !normalized) {
    fail(errors, 'INVALID_ASSET_PATH', `${location}.url`, 'must be a normalized repo-relative data/ path');
  }
  if (normalized && !(await pathIsFile(normalized))) {
    fail(errors, 'ASSET_NOT_FOUND', `${location}.url`, `does not reference a file: ${normalized}`);
  }

  if (asset.type === 'video' && asset.audio !== 'none') {
    fail(errors, 'VIDEO_NOT_SILENT', `${location}.audio`, 'video assets must explicitly declare audio: "none"');
  }
  if (asset.type !== 'video' && asset.audio !== undefined) {
    fail(errors, 'INVALID_AUDIO_DECLARATION', `${location}.audio`, 'audio is only allowed on video assets');
  }

  if (ASSET_TYPES.has(asset.type) && normalized) {
    const extension = path.posix.extname(normalized).toLowerCase();
    if (!expectedAssetExtensions(asset.type)?.has(extension)) {
      fail(errors, 'ASSET_EXTENSION_MISMATCH', `${location}.url`, `does not match asset type ${asset.type}`);
    }
  }

  const framingIdValid = checkString(asset.framing, `${location}.framing`, errors);
  if (framingIdValid && !Object.hasOwn(framingProfiles, asset.framing)) {
    fail(errors, 'UNKNOWN_FRAMING_PROFILE', `${location}.framing`, `does not match a framing profile: ${asset.framing}`);
  }
}

function validateOutputFrame(outputFrame, location, errors) {
  const allowed = new Set(['orientation', 'width', 'height', 'qaViewport', 'scalePolicy']);
  if (!checkObject(outputFrame, allowed, location, errors, 'media schema')) return;

  if (outputFrame.orientation !== 'landscape') {
    fail(errors, 'INVALID_OUTPUT_ORIENTATION', `${location}.orientation`, 'must equal "landscape"');
  }
  if (outputFrame.width !== 16 || outputFrame.height !== 9) {
    fail(errors, 'INVALID_OUTPUT_FRAME', location, 'must declare the canonical 16:9 output frame');
  }
  if (outputFrame.scalePolicy !== 'avoid-upsample') {
    fail(errors, 'INVALID_SCALE_POLICY', `${location}.scalePolicy`, 'must equal "avoid-upsample"');
  }
  if (checkObject(outputFrame.qaViewport, new Set(['width', 'height']), `${location}.qaViewport`, errors, 'media schema')) {
    if (outputFrame.qaViewport.width !== 844 || outputFrame.qaViewport.height !== 390) {
      fail(errors, 'INVALID_QA_VIEWPORT', `${location}.qaViewport`, 'must declare the 844x390 landscape-first QA viewport');
    }
  }
}

async function validateMediaPack(pack, file, errors) {
  const location = file;
  const allowed = new Set([
    'schemaVersion',
    'kind',
    'id',
    'title',
    'outputFrame',
    'framingProfiles',
    'entries',
  ]);
  if (!checkObject(pack, allowed, location, errors, 'media schema')) return null;

  if (pack.schemaVersion !== MEDIA_SCHEMA_VERSION) {
    fail(errors, 'UNSUPPORTED_MEDIA_SCHEMA', `${location}.schemaVersion`, `must equal ${MEDIA_SCHEMA_VERSION}`);
  }
  if (pack.kind !== 'mediaPack') {
    fail(errors, 'INVALID_MEDIA_KIND', `${location}.kind`, 'must equal "mediaPack"');
  }
  checkId(pack.id, `${location}.id`, errors);
  checkString(pack.title, `${location}.title`, errors);
  validateOutputFrame(pack.outputFrame, `${location}.outputFrame`, errors);

  const framingProfiles = isObject(pack.framingProfiles) ? pack.framingProfiles : {};
  if (!checkObject(pack.framingProfiles, null, `${location}.framingProfiles`, errors, 'media schema')) {
    if (pack.framingProfiles === undefined) {
      fail(errors, 'MISSING_FRAMING_PROFILES', `${location}.framingProfiles`, 'must be an object');
    }
  } else if (Object.keys(framingProfiles).length === 0) {
    fail(errors, 'INVALID_FRAMING_PROFILES', `${location}.framingProfiles`, 'must contain at least one profile');
  } else {
    for (const [profileId, profile] of Object.entries(framingProfiles)) {
      if (!ID_PATTERN.test(profileId)) {
        fail(errors, 'INVALID_ID', `${location}.framingProfiles.${profileId}`, 'must be a lowercase kebab-case identifier');
      }
      validateFramingProfile(profile, `${location}.framingProfiles.${profileId}`, errors);
    }
  }

  if (!checkObject(pack.entries, null, `${location}.entries`, errors, 'media schema')) {
    return { id: pack.id, file, entries: {}, framingProfiles };
  }
  if (Object.keys(pack.entries).length === 0) {
    fail(errors, 'INVALID_MEDIA_ENTRIES', `${location}.entries`, 'must contain at least one movement entry');
  }

  for (const [movementId, entry] of Object.entries(pack.entries)) {
    const entryLocation = `${location}.entries.${movementId}`;
    if (!ID_PATTERN.test(movementId)) {
      fail(errors, 'INVALID_ID', `${entryLocation}`, 'must be a lowercase kebab-case movement ID');
    }
    const allowedEntryKeys = new Set(['anatomicalSide', 'mirroring', 'assets', 'fallback']);
    if (!checkObject(entry, allowedEntryKeys, entryLocation, errors, 'media schema')) continue;

    if (!ANATOMICAL_SIDE_VALUES.has(entry.anatomicalSide)) {
      fail(errors, 'INVALID_ANATOMICAL_SIDE', `${entryLocation}.anatomicalSide`, 'must declare the asset anatomical side');
    }
    if (!MIRRORING_VALUES.has(entry.mirroring)) {
      fail(errors, 'INVALID_MIRRORING_POLICY', `${entryLocation}.mirroring`, 'must be never, when-needed, or always');
    }
    if (entry.mirroring === 'when-needed' && !['left', 'right'].includes(entry.anatomicalSide)) {
      fail(errors, 'INVALID_MIRRORING_POLICY', `${entryLocation}.mirroring`, 'when-needed requires a left or right anatomicalSide');
    }
    if (entry.fallback !== undefined && entry.fallback !== 'text') {
      fail(errors, 'INVALID_MEDIA_FALLBACK', `${entryLocation}.fallback`, 'must be "text" when present');
    }
    if (!Array.isArray(entry.assets)) {
      fail(errors, 'INVALID_MEDIA_ASSETS', `${entryLocation}.assets`, 'must be an array');
      continue;
    }
    if (entry.assets.length === 0 && entry.fallback !== 'text') {
      fail(errors, 'MISSING_TEXT_FALLBACK', `${entryLocation}`, 'an entry without assets must declare fallback: "text"');
    }
    for (let assetIndex = 0; assetIndex < entry.assets.length; assetIndex += 1) {
      await validateAsset(
        entry.assets[assetIndex],
        `${entryLocation}.assets[${assetIndex}]`,
        framingProfiles,
        errors,
      );
    }
  }

  return {
    id: pack.id,
    file,
    entries: pack.entries,
    framingProfiles,
    entryCount: Object.keys(pack.entries).length,
  };
}

async function validateMovement(movement, location, errors, movementModes) {
  const allowed = new Set(['movementId', 'exerciseId', 'displayName', 'textOnly']);
  if (!checkObject(movement, allowed, location, errors, `schemaVersion ${CONTENT_SCHEMA_VERSION}`)) return null;

  if (movement.movementId === undefined) {
    fail(errors, 'MISSING_MOVEMENT_ID', `${location}.movementId`, 'is required in schemaVersion 2');
  } else {
    checkId(movement.movementId, `${location}.movementId`, errors);
  }
  checkString(movement.displayName, `${location}.displayName`, errors);
  checkString(movement.exerciseId, `${location}.exerciseId`, errors, { optional: true });

  if (movement.textOnly !== undefined && movement.textOnly !== true) {
    fail(errors, 'INVALID_TEXT_ONLY', `${location}.textOnly`, 'may only be omitted or set to true');
  }
  if (movement.movementId && ID_PATTERN.test(movement.movementId)) {
    const priorMode = movementModes.get(movement.movementId);
    const mode = movement.textOnly === true ? 'text' : 'visual';
    if (priorMode && priorMode !== mode) {
      fail(errors, 'MOVEMENT_MODE_CONFLICT', `${location}.movementId`, `movement ${movement.movementId} is used as both visual and text-only content`);
    } else {
      movementModes.set(movement.movementId, mode);
    }
    return movement.movementId;
  }
  return null;
}

async function validateInterval(interval, location, errors, movementModes, referencedMovementIds) {
  const allowed = new Set([
    'displayName',
    'workSeconds',
    'restSeconds',
    'side',
    'tempo',
    'rpe',
    'regressions',
    'coachNote',
    'match',
    'movements',
  ]);
  if (!checkObject(interval, allowed, location, errors, `schemaVersion ${CONTENT_SCHEMA_VERSION}`)) return 0;

  checkString(interval.displayName, `${location}.displayName`, errors);
  checkPositiveInteger(interval.workSeconds, `${location}.workSeconds`, errors);
  checkPositiveInteger(interval.restSeconds, `${location}.restSeconds`, errors);
  checkString(interval.tempo, `${location}.tempo`, errors, { optional: true });
  checkString(interval.rpe, `${location}.rpe`, errors, { optional: true });
  checkStringArray(interval.regressions, `${location}.regressions`, errors, { optional: true });
  checkString(interval.coachNote, `${location}.coachNote`, errors, { optional: true });

  if (interval.side !== undefined && !SIDE_VALUES.has(interval.side)) {
    fail(errors, 'INVALID_ENUM', `${location}.side`, `must be one of: ${[...SIDE_VALUES].join(', ')}`);
  }
  if (interval.match !== undefined && !MATCH_VALUES.has(interval.match)) {
    fail(errors, 'INVALID_ENUM', `${location}.match`, `must be one of: ${[...MATCH_VALUES].join(', ')}`);
  }

  if (!Array.isArray(interval.movements) || interval.movements.length === 0) {
    fail(errors, 'INVALID_MOVEMENTS', `${location}.movements`, 'must be a non-empty array');
  } else {
    for (let index = 0; index < interval.movements.length; index += 1) {
      const movementId = await validateMovement(
        interval.movements[index],
        `${location}.movements[${index}]`,
        errors,
        movementModes,
      );
      if (movementId) referencedMovementIds.add(movementId);
    }
    if (interval.match === 'combo' && interval.movements.length < 2) {
      fail(errors, 'INVALID_COMBO', `${location}.movements`, 'must contain at least two movements for a combo');
    }
    if (interval.match !== 'combo' && interval.movements.length > 1) {
      fail(errors, 'UNMARKED_COMBO', `${location}.match`, 'must be "combo" when multiple movements are present');
    }
  }

  if (Number.isInteger(interval.workSeconds) && Number.isInteger(interval.restSeconds)) {
    return interval.workSeconds + interval.restSeconds;
  }
  return 0;
}

async function validateBlock(block, file, errors, movementModes, referencedMovementIds) {
  const location = file;
  const allowed = new Set(['schemaVersion', 'kind', 'id', 'title', 'description', 'intervals']);
  if (!checkObject(block, allowed, location, errors, `schemaVersion ${CONTENT_SCHEMA_VERSION}`)) return null;

  if (block.schemaVersion !== CONTENT_SCHEMA_VERSION) {
    fail(errors, 'UNSUPPORTED_SCHEMA', `${location}.schemaVersion`, `must equal ${CONTENT_SCHEMA_VERSION}`);
  }
  if (block.kind !== 'block') {
    fail(errors, 'INVALID_KIND', `${location}.kind`, 'must equal "block"');
  }
  checkId(block.id, `${location}.id`, errors);
  checkString(block.title, `${location}.title`, errors);
  checkString(block.description, `${location}.description`, errors, { optional: true });

  let durationSeconds = 0;
  if (!Array.isArray(block.intervals) || block.intervals.length === 0) {
    fail(errors, 'INVALID_INTERVALS', `${location}.intervals`, 'must be a non-empty array');
  } else {
    for (let index = 0; index < block.intervals.length; index += 1) {
      durationSeconds += await validateInterval(
        block.intervals[index],
        `${location}.intervals[${index}]`,
        errors,
        movementModes,
        referencedMovementIds,
      );
    }
  }

  return { id: block.id, file, intervalCount: block.intervals?.length ?? 0, durationSeconds };
}

function validateSource(source, location, errors) {
  const allowed = new Set(['channel', 'videoId', 'url']);
  if (!checkObject(source, allowed, location, errors, `schemaVersion ${CONTENT_SCHEMA_VERSION}`)) return;
  checkString(source.channel, `${location}.channel`, errors, { optional: true });
  checkString(source.videoId, `${location}.videoId`, errors, { optional: true });
  checkString(source.url, `${location}.url`, errors, { optional: true });
  if (Object.keys(source).length === 0) {
    fail(errors, 'EMPTY_SOURCE', location, 'must contain at least one source field');
  }
}

async function validateRoutine(routine, file, blocks, errors, movementModes, referencedMovementIds) {
  const location = file;
  const allowed = new Set([
    'schemaVersion',
    'kind',
    'id',
    'title',
    'description',
    'equipment',
    'estimatedDurationSeconds',
    'source',
    'notes',
    'safetyCues',
    'sequence',
  ]);
  if (!checkObject(routine, allowed, location, errors, `schemaVersion ${CONTENT_SCHEMA_VERSION}`)) return null;

  if (routine.schemaVersion !== CONTENT_SCHEMA_VERSION) {
    fail(errors, 'UNSUPPORTED_SCHEMA', `${location}.schemaVersion`, `must equal ${CONTENT_SCHEMA_VERSION}`);
  }
  if (routine.kind !== 'routine') {
    fail(errors, 'INVALID_KIND', `${location}.kind`, 'must equal "routine"');
  }
  checkId(routine.id, `${location}.id`, errors);
  checkString(routine.title, `${location}.title`, errors);
  checkString(routine.description, `${location}.description`, errors, { optional: true });
  checkStringArray(routine.equipment, `${location}.equipment`, errors);
  checkPositiveInteger(routine.estimatedDurationSeconds, `${location}.estimatedDurationSeconds`, errors);
  if (routine.source !== undefined) validateSource(routine.source, `${location}.source`, errors);
  checkStringArray(routine.notes, `${location}.notes`, errors, { optional: true });
  checkStringArray(routine.safetyCues, `${location}.safetyCues`, errors, { optional: true });

  let durationSeconds = 0;
  let intervalCount = 0;
  if (!Array.isArray(routine.sequence) || routine.sequence.length === 0) {
    fail(errors, 'INVALID_SEQUENCE', `${location}.sequence`, 'must be a non-empty array');
  } else {
    for (let index = 0; index < routine.sequence.length; index += 1) {
      const item = routine.sequence[index];
      const itemLocation = `${location}.sequence[${index}]`;
      if (!checkObject(item, new Set(['blockId', 'interval']), itemLocation, errors, `schemaVersion ${CONTENT_SCHEMA_VERSION}`)) continue;
      const hasBlock = Object.hasOwn(item, 'blockId');
      const hasInterval = Object.hasOwn(item, 'interval');
      if (hasBlock === hasInterval) {
        fail(errors, 'INVALID_SEQUENCE_ITEM', itemLocation, 'must contain exactly one of blockId or interval');
        continue;
      }
      if (hasBlock) {
        checkId(item.blockId, `${itemLocation}.blockId`, errors);
        const block = blocks.get(item.blockId);
        if (!block) {
          fail(errors, 'UNKNOWN_BLOCK', `${itemLocation}.blockId`, `does not match a block id: ${item.blockId}`);
          continue;
        }
        durationSeconds += block.durationSeconds;
        intervalCount += block.intervalCount;
        for (const movementId of block.movementIds) referencedMovementIds.add(movementId);
      } else {
        durationSeconds += await validateInterval(
          item.interval,
          `${itemLocation}.interval`,
          errors,
          movementModes,
          referencedMovementIds,
        );
        intervalCount += 1;
      }
    }
  }

  if (Number.isInteger(routine.estimatedDurationSeconds) && routine.estimatedDurationSeconds !== durationSeconds) {
    fail(
      errors,
      'DURATION_MISMATCH',
      `${location}.estimatedDurationSeconds`,
      `declares ${routine.estimatedDurationSeconds}s but sequence expands to ${durationSeconds}s`,
    );
  }

  return { id: routine.id, file, intervalCount, durationSeconds };
}

async function jsonFiles(directory) {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(directory, name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function repoRelative(file) {
  return path.relative(REPO_ROOT, path.resolve(REPO_ROOT, file)).split(path.sep).join('/');
}

function formatErrors(errors) {
  return errors.map(({ code, location, message }) => ({ code, location, message }));
}

export async function validateMediaPackFile(file) {
  const errors = [];
  try {
    const pack = await readJson(file);
    const summary = await validateMediaPack(pack, repoRelative(file), errors);
    return {
      schemaVersion: MEDIA_SCHEMA_VERSION,
      valid: errors.length === 0,
      mediaPacks: summary ? [summary] : [],
      errors: formatErrors(errors),
    };
  } catch (error) {
    errors.push(error);
    return {
      schemaVersion: MEDIA_SCHEMA_VERSION,
      valid: false,
      mediaPacks: [],
      errors: formatErrors(errors),
    };
  }
}

export async function validateFiles(requestedFiles = []) {
  const errors = [];
  const movementModes = new Map();
  const referencedMovementIds = new Set();
  const blockFiles = await jsonFiles(BLOCKS_DIR);
  const blocks = new Map();
  const blockSummaries = [];

  for (const absoluteFile of blockFiles) {
    const file = repoRelative(absoluteFile);
    try {
      const block = await readJson(file);
      const blockMovementIds = new Set();
      const summary = await validateBlock(block, file, errors, movementModes, blockMovementIds);
      if (!summary || typeof summary.id !== 'string') continue;
      summary.movementIds = blockMovementIds;
      if (blocks.has(summary.id)) {
        fail(errors, 'DUPLICATE_BLOCK_ID', `${file}.id`, `duplicates block id ${summary.id}`);
      } else {
        blocks.set(summary.id, summary);
        blockSummaries.push(summary);
      }
      for (const movementId of blockMovementIds) referencedMovementIds.add(movementId);
    } catch (error) {
      errors.push(error);
    }
  }

  const mediaPacks = new Map();
  const mediaPackSummaries = [];
  for (const absoluteFile of await jsonFiles(MEDIA_DIR)) {
    const file = repoRelative(absoluteFile);
    try {
      const summary = await validateMediaPack(await readJson(file), file, errors);
      if (!summary || typeof summary.id !== 'string') continue;
      if (mediaPacks.has(summary.id)) {
        fail(errors, 'DUPLICATE_MEDIA_PACK_ID', `${file}.id`, `duplicates media pack id ${summary.id}`);
      } else {
        mediaPacks.set(summary.id, summary);
        mediaPackSummaries.push(summary);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  const routineFiles = requestedFiles.length > 0
    ? requestedFiles.map(repoRelative)
    : (await jsonFiles(ROUTINES_DIR)).map(repoRelative);
  const routineSummaries = [];
  const routineIds = new Map();
  for (const file of routineFiles) {
    try {
      const summary = await validateRoutine(
        await readJson(file),
        file,
        blocks,
        errors,
        movementModes,
        referencedMovementIds,
      );
      if (!summary || typeof summary.id !== 'string') continue;
      if (routineIds.has(summary.id)) {
        fail(errors, 'DUPLICATE_ROUTINE_ID', `${file}.id`, `duplicates routine id ${summary.id}`);
      } else {
        routineIds.set(summary.id, file);
        routineSummaries.push(summary);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  let selectedPackId = 'gif-v1';
  try {
    const index = await readJson('data/content-index.json');
    if (index.schemaVersion !== CONTENT_SCHEMA_VERSION) {
      fail(errors, 'UNSUPPORTED_INDEX_SCHEMA', 'data/content-index.json.schemaVersion', `must equal ${CONTENT_SCHEMA_VERSION}`);
    }
    if (typeof index.defaultMediaPack === 'string') selectedPackId = index.defaultMediaPack;
    else {
      fail(errors, 'MISSING_DEFAULT_MEDIA_PACK', 'data/content-index.json.defaultMediaPack', 'must name the selected media pack');
    }
    if (!isObject(index.mediaPacks) || !Object.hasOwn(index.mediaPacks, selectedPackId)) {
      fail(errors, 'UNKNOWN_DEFAULT_MEDIA_PACK', 'data/content-index.json.defaultMediaPack', `is not mapped in data/content-index.json: ${selectedPackId}`);
    }
  } catch (error) {
    errors.push(error);
  }
  const selectedPack = mediaPacks.get(selectedPackId);
  if (!selectedPack) {
    fail(errors, 'NO_MEDIA_PACK', 'data/media', 'at least one valid media pack is required');
  } else {
    for (const movementId of referencedMovementIds) {
      const entry = selectedPack.entries[movementId];
      if (!entry) {
        fail(
          errors,
          'UNCOVERED_MOVEMENT_ID',
          `media:${selectedPack.id}.${movementId}`,
          `is referenced by content but has no entry in ${selectedPack.id}`,
        );
      }
    }
  }

  return {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    valid: errors.length === 0,
    mediaPacks: mediaPackSummaries.map(({ id, file, entryCount }) => ({ id, file, entryCount })),
    blocks: blockSummaries.map(({ id, file, intervalCount, durationSeconds }) => ({
      id,
      file,
      intervalCount,
      durationSeconds,
    })),
    routines: routineSummaries,
    errors: formatErrors(errors),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter((arg) => arg !== '--json');
  const result = await validateFiles(files);

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.valid) {
    const intervalCount = result.routines.reduce((total, routine) => total + routine.intervalCount, 0);
    process.stdout.write(
      `Validated ${result.routines.length} routine(s), ${result.blocks.length} block(s), ` +
        `${result.mediaPacks.length} media pack(s), ${intervalCount} expanded interval(s).\n`,
    );
  } else {
    for (const error of result.errors) {
      process.stderr.write(`${error.code} ${error.location}: ${error.message}\n`);
    }
  }

  process.exitCode = result.valid ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
