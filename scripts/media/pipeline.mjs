#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const REPO_ROOT = path.resolve(SCRIPT_ROOT);
const RESEARCH_ROOT = path.resolve(REPO_ROOT, '..', '..', 'fittimer-media-research');

export const CATALOGUE_SCHEMA_VERSION = 1;
export const CLIP_MANIFEST_SCHEMA_VERSION = 1;
export const MEDIA_PACK_SCHEMA_VERSION = 1;
export const DEFAULT_OUTPUT_MAX_WIDTH = 1280;
export const MAX_REFERENCE_DURATION_SECONDS = 40;
export const DEFAULT_LOOP_POLICY = Object.freeze({
  normal: Object.freeze({
    minReps: 2,
    maxReps: 5,
    minDurationSeconds: 5,
    maxDurationSeconds: 10,
  }),
  judged: Object.freeze({
    minDurationSeconds: 1,
    maxDurationSeconds: 120,
  }),
});

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SIDE_VALUES = new Set(['left', 'right', 'first', 'second', 'alternating', 'bilateral', 'unspecified']);
const MOVEMENT_KIND_VALUES = new Set(['normal', 'compound', 'hold', 'mobility']);
const LOOP_KIND_VALUES = new Set(['reps', 'hold', 'mobility']);
const SAFE_REGION_NAMES = ['hands', 'feet', 'equipment', 'movementPath'];
const OUTPUT_FRAME = Object.freeze({
  orientation: 'landscape',
  width: 16,
  height: 9,
  qaViewport: Object.freeze({ width: 844, height: 390 }),
  scalePolicy: 'avoid-upsample',
});

export class PipelineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.details = details;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(errors, code, location, message) {
  errors.push({ code, location, message });
}

function checkObject(value, location, errors, allowedKeys = null) {
  if (!isObject(value)) {
    fail(errors, 'EXPECTED_OBJECT', location, 'must be an object');
    return false;
  }
  if (allowedKeys) {
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) fail(errors, 'UNKNOWN_FIELD', `${location}.${key}`, 'is not allowed');
    }
  }
  return true;
}

function checkString(value, location, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(errors, 'INVALID_STRING', location, 'must be a non-empty string');
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

function checkFiniteNumber(value, location, errors, { minimum = null, maximum = null } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(errors, 'INVALID_NUMBER', location, 'must be a finite number');
    return false;
  }
  if (minimum !== null && value < minimum) {
    fail(errors, 'INVALID_NUMBER', location, `must be at least ${minimum}`);
    return false;
  }
  if (maximum !== null && value > maximum) {
    fail(errors, 'INVALID_NUMBER', location, `must be at most ${maximum}`);
    return false;
  }
  return true;
}

function checkInteger(value, location, errors, { minimum = null, maximum = null } = {}) {
  if (!Number.isInteger(value)) {
    fail(errors, 'INVALID_INTEGER', location, 'must be an integer');
    return false;
  }
  if (minimum !== null && value < minimum) {
    fail(errors, 'INVALID_INTEGER', location, `must be at least ${minimum}`);
    return false;
  }
  if (maximum !== null && value > maximum) {
    fail(errors, 'INVALID_INTEGER', location, `must be at most ${maximum}`);
    return false;
  }
  return true;
}

function checkNormalized(value, location, errors) {
  return checkFiniteNumber(value, location, errors, { minimum: 0, maximum: 1 });
}

function validateRect(rect, location, errors) {
  if (!checkObject(rect, location, errors, new Set(['x', 'y', 'width', 'height']))) return false;
  const valid = [
    checkNormalized(rect.x, `${location}.x`, errors),
    checkNormalized(rect.y, `${location}.y`, errors),
    checkNormalized(rect.width, `${location}.width`, errors),
    checkNormalized(rect.height, `${location}.height`, errors),
  ].every(Boolean);
  if (valid && rect.width <= 0) fail(errors, 'INVALID_CROP', `${location}.width`, 'must be greater than zero');
  if (valid && rect.height <= 0) fail(errors, 'INVALID_CROP', `${location}.height`, 'must be greater than zero');
  if (valid && rect.x + rect.width > 1) fail(errors, 'INVALID_CROP', location, 'must stay inside the source frame');
  if (valid && rect.y + rect.height > 1) fail(errors, 'INVALID_CROP', location, 'must stay inside the source frame');
  return valid && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1 && rect.y + rect.height <= 1;
}

function rectContained(inner, outer) {
  const epsilon = 1e-9;
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon
  );
}

function validateSafeFrame(safeFrame, crop, location, errors) {
  if (!checkObject(safeFrame, location, errors, new Set(SAFE_REGION_NAMES))) return false;
  let valid = true;
  for (const name of SAFE_REGION_NAMES) {
    const regionValid = validateRect(safeFrame[name], `${location}.${name}`, errors);
    valid = regionValid && valid;
    if (regionValid && !rectContained(safeFrame[name], crop)) {
      fail(errors, 'UNSAFE_FRAME', `${location}.${name}`, 'must stay inside the selected crop');
      valid = false;
    }
  }
  return valid;
}

function validateLoopPolicy(policy, location, errors) {
  if (!checkObject(policy, location, errors, new Set(['normal', 'judged']))) return false;
  let valid = true;
  if (!checkObject(policy.normal, `${location}.normal`, errors, new Set(['minReps', 'maxReps', 'minDurationSeconds', 'maxDurationSeconds']))) {
    valid = false;
  } else {
    valid = checkInteger(policy.normal.minReps, `${location}.normal.minReps`, errors, { minimum: 1 }) && valid;
    valid = checkInteger(policy.normal.maxReps, `${location}.normal.maxReps`, errors, { minimum: 1 }) && valid;
    valid = checkFiniteNumber(policy.normal.minDurationSeconds, `${location}.normal.minDurationSeconds`, errors, { minimum: 0 }) && valid;
    valid = checkFiniteNumber(policy.normal.maxDurationSeconds, `${location}.normal.maxDurationSeconds`, errors, { minimum: 0 }) && valid;
    if (policy.normal.minReps > policy.normal.maxReps) {
      fail(errors, 'INVALID_LOOP_POLICY', `${location}.normal`, 'minReps must not exceed maxReps');
      valid = false;
    }
    if (policy.normal.minDurationSeconds > policy.normal.maxDurationSeconds) {
      fail(errors, 'INVALID_LOOP_POLICY', `${location}.normal`, 'minimum duration must not exceed maximum duration');
      valid = false;
    }
  }
  if (!checkObject(policy.judged, `${location}.judged`, errors, new Set(['minDurationSeconds', 'maxDurationSeconds']))) {
    valid = false;
  } else {
    valid = checkFiniteNumber(policy.judged.minDurationSeconds, `${location}.judged.minDurationSeconds`, errors, { minimum: 0 }) && valid;
    valid = checkFiniteNumber(policy.judged.maxDurationSeconds, `${location}.judged.maxDurationSeconds`, errors, { minimum: 0 }) && valid;
    if (policy.judged.minDurationSeconds > policy.judged.maxDurationSeconds) {
      fail(errors, 'INVALID_LOOP_POLICY', `${location}.judged`, 'minimum duration must not exceed maximum duration');
      valid = false;
    }
  }
  return valid;
}

function validateClip(clip, index, policy, errors) {
  const location = `clips[${index}]`;
  const allowed = new Set([
    'id',
    'intervalNumber',
    'intervalName',
    'source',
    'timeRange',
    'referenceRange',
    'movementId',
    'coversMovementIds',
    'side',
    'equipment',
    'viewpoint',
    'crop',
    'safeFrame',
    'loop',
    'movementKind',
    'formNotes',
    'seamNotes',
    'mocapNotes',
    'mocapRange',
  ]);
  if (!checkObject(clip, location, errors, allowed)) return;
  checkId(clip.id, `${location}.id`, errors);
  const hasIntervalNumber = clip.intervalNumber !== undefined;
  const hasIntervalName = clip.intervalName !== undefined;
  if (hasIntervalNumber !== hasIntervalName) {
    fail(errors, 'INVALID_INTERVAL_METADATA', location, 'intervalNumber and intervalName must be provided together');
  }
  if (hasIntervalNumber) checkInteger(clip.intervalNumber, `${location}.intervalNumber`, errors, { minimum: 1 });
  if (hasIntervalName) checkString(clip.intervalName, `${location}.intervalName`, errors);
  if (checkObject(clip.source, `${location}.source`, errors, new Set(['url', 'cacheKey', 'videoId', 'canonicalUrl']))) {
    checkString(clip.source.url, `${location}.source.url`, errors);
    if (clip.source.cacheKey !== undefined) checkId(clip.source.cacheKey, `${location}.source.cacheKey`, errors);
    if (clip.source.videoId !== undefined) checkString(clip.source.videoId, `${location}.source.videoId`, errors);
    if (clip.source.canonicalUrl !== undefined) checkString(clip.source.canonicalUrl, `${location}.source.canonicalUrl`, errors);
  }
  let duration = null;
  if (checkObject(clip.timeRange, `${location}.timeRange`, errors, new Set(['startSeconds', 'endSeconds']))) {
    const startValid = checkFiniteNumber(clip.timeRange.startSeconds, `${location}.timeRange.startSeconds`, errors, { minimum: 0 });
    const endValid = checkFiniteNumber(clip.timeRange.endSeconds, `${location}.timeRange.endSeconds`, errors, { minimum: 0 });
    if (startValid && endValid) {
      duration = clip.timeRange.endSeconds - clip.timeRange.startSeconds;
      if (!(duration > 0)) fail(errors, 'INVALID_DURATION', `${location}.timeRange`, 'endSeconds must be greater than startSeconds');
    }
  }
  if (clip.referenceRange !== undefined) {
    if (checkObject(clip.referenceRange, `${location}.referenceRange`, errors, new Set(['startSeconds', 'endSeconds']))) {
      const startValid = checkFiniteNumber(clip.referenceRange.startSeconds, `${location}.referenceRange.startSeconds`, errors, { minimum: 0 });
      const endValid = checkFiniteNumber(clip.referenceRange.endSeconds, `${location}.referenceRange.endSeconds`, errors, { minimum: 0 });
      if (startValid && endValid) {
        const referenceDuration = clip.referenceRange.endSeconds - clip.referenceRange.startSeconds;
        if (!(referenceDuration > 0)) {
          fail(errors, 'INVALID_DURATION', `${location}.referenceRange`, 'endSeconds must be greater than startSeconds');
        } else if (referenceDuration > MAX_REFERENCE_DURATION_SECONDS) {
          fail(errors, 'INVALID_DURATION', `${location}.referenceRange`, `reference segments must be at most ${MAX_REFERENCE_DURATION_SECONDS} seconds`);
        }
        if (duration !== null && (clip.timeRange.startSeconds < clip.referenceRange.startSeconds || clip.timeRange.endSeconds > clip.referenceRange.endSeconds)) {
          fail(errors, 'INVALID_REFERENCE_RANGE', `${location}.referenceRange`, 'must contain the short loop timeRange');
        }
      }
    }
  }
  for (const field of ['formNotes', 'seamNotes', 'mocapNotes']) {
    if (clip[field] !== undefined) checkString(clip[field], `${location}.${field}`, errors);
  }
  if (clip.mocapRange !== undefined && checkObject(clip.mocapRange, `${location}.mocapRange`, errors, new Set(['startSeconds', 'endSeconds']))) {
    const mocapStartValid = checkFiniteNumber(clip.mocapRange.startSeconds, `${location}.mocapRange.startSeconds`, errors, { minimum: 0 });
    const mocapEndValid = checkFiniteNumber(clip.mocapRange.endSeconds, `${location}.mocapRange.endSeconds`, errors, { minimum: 0 });
    if (mocapStartValid && mocapEndValid && clip.mocapRange.endSeconds <= clip.mocapRange.startSeconds) {
      fail(errors, 'INVALID_MOCAP_RANGE', `${location}.mocapRange`, 'endSeconds must be greater than startSeconds');
    }
    if (mocapStartValid && mocapEndValid && clip.timeRange?.startSeconds !== undefined && clip.timeRange?.endSeconds !== undefined) {
      if (clip.mocapRange.startSeconds < clip.timeRange.startSeconds || clip.mocapRange.endSeconds > clip.timeRange.endSeconds) {
        fail(errors, 'INVALID_MOCAP_RANGE', `${location}.mocapRange`, 'must stay inside the selected time range');
      }
    }
  }
  checkId(clip.movementId, `${location}.movementId`, errors);
  if (clip.coversMovementIds !== undefined) {
    if (!Array.isArray(clip.coversMovementIds) || clip.coversMovementIds.length === 0) {
      fail(errors, 'INVALID_STRING_ARRAY', `${location}.coversMovementIds`, 'must be a non-empty array when present');
    } else {
      const coveredIds = new Set();
      for (const [coveredIndex, movementId] of clip.coversMovementIds.entries()) {
        const validId = checkId(movementId, `${location}.coversMovementIds[${coveredIndex}]`, errors);
        if (!validId) continue;
        if (movementId === clip.movementId || coveredIds.has(movementId)) {
          fail(errors, 'DUPLICATE_COVERAGE', `${location}.coversMovementIds[${coveredIndex}]`, 'must not repeat the primary or another covered movement ID');
        }
        coveredIds.add(movementId);
      }
    }
  }
  if (!SIDE_VALUES.has(clip.side)) fail(errors, 'INVALID_ENUM', `${location}.side`, 'must be a supported anatomical side');
  if (!Array.isArray(clip.equipment) || clip.equipment.length === 0) {
    fail(errors, 'INVALID_STRING_ARRAY', `${location}.equipment`, 'must list at least one equipment value');
  } else {
    clip.equipment.forEach((item, itemIndex) => checkString(item, `${location}.equipment[${itemIndex}]`, errors));
  }
  checkString(clip.viewpoint, `${location}.viewpoint`, errors);
  const cropValid = validateRect(clip.crop, `${location}.crop`, errors);
  if (cropValid) validateSafeFrame(clip.safeFrame, clip.crop, `${location}.safeFrame`, errors);
  if (!MOVEMENT_KIND_VALUES.has(clip.movementKind)) {
    fail(errors, 'INVALID_ENUM', `${location}.movementKind`, 'must be normal, compound, hold, or mobility');
  }
  if (checkObject(clip.loop, `${location}.loop`, errors, new Set(['kind', 'reps', 'durationSeconds', 'phaseMatch', 'phaseNotes']))) {
    if (!LOOP_KIND_VALUES.has(clip.loop.kind)) {
      fail(errors, 'INVALID_ENUM', `${location}.loop.kind`, 'must be reps, hold, or mobility');
    }
    if (typeof clip.loop.phaseMatch !== 'boolean') {
      fail(errors, 'INVALID_BOOLEAN', `${location}.loop.phaseMatch`, 'must explicitly state whether loop phases match');
    } else if (!clip.loop.phaseMatch) {
      fail(errors, 'INVALID_LOOP', `${location}.loop.phaseMatch`, 'must be true for an encoded loop');
    }
    if (!checkObject(clip.loop.phaseNotes, `${location}.loop.phaseNotes`, errors)) {
      // The object validator has already reported the useful error.
    } else {
      const requiredNotes = clip.loop.kind === 'reps' ? ['start', 'end', 'rep'] : ['start', 'end', clip.loop.kind];
      for (const note of requiredNotes) checkString(clip.loop.phaseNotes[note], `${location}.loop.phaseNotes.${note}`, errors);
    }
    if (clip.loop.kind === 'reps') {
      if (clip.loop.reps === undefined) {
        fail(errors, 'INVALID_LOOP', `${location}.loop.reps`, 'is required for a repetition loop');
      } else {
        checkInteger(clip.loop.reps, `${location}.loop.reps`, errors, {
          minimum: policy.normal.minReps,
          maximum: policy.normal.maxReps,
        });
      }
      if (duration !== null && (duration < policy.normal.minDurationSeconds || duration > policy.normal.maxDurationSeconds)) {
        fail(
          errors,
          'INVALID_DURATION',
          `${location}.timeRange`,
          `repetition loops must be ${policy.normal.minDurationSeconds}-${policy.normal.maxDurationSeconds} seconds under the declared loop policy`,
        );
      }
    } else {
      if (clip.loop.durationSeconds === undefined) {
        fail(errors, 'INVALID_DURATION', `${location}.loop.durationSeconds`, 'is required for judged-duration loops');
      } else {
        const judgedValid = checkFiniteNumber(clip.loop.durationSeconds, `${location}.loop.durationSeconds`, errors, {
          minimum: policy.judged.minDurationSeconds,
          maximum: policy.judged.maxDurationSeconds,
        });
        if (judgedValid && duration !== null && Math.abs(clip.loop.durationSeconds - duration) > 0.05) {
          fail(errors, 'INVALID_DURATION', `${location}.loop.durationSeconds`, 'must match the selected time range');
        }
      }
    }
    if ((clip.movementKind === 'hold' && clip.loop.kind !== 'hold') || (clip.movementKind === 'mobility' && clip.loop.kind !== 'mobility')) {
      fail(errors, 'INVALID_LOOP', `${location}.loop.kind`, `must match movementKind ${clip.movementKind}`);
    }
    if ((clip.movementKind === 'normal' || clip.movementKind === 'compound') && clip.loop.kind !== 'reps') {
      fail(errors, 'INVALID_LOOP', `${location}.loop.kind`, `must be reps for movementKind ${clip.movementKind}`);
    }
  }
}

export function validateCatalogue(catalogue, { loopPolicy } = {}) {
  const errors = [];
  if (!checkObject(catalogue, 'catalogue', errors, new Set(['schemaVersion', 'kind', 'pack', 'loopPolicy', 'clips']))) {
    return { valid: false, errors };
  }
  if (catalogue.schemaVersion !== CATALOGUE_SCHEMA_VERSION) {
    fail(errors, 'INVALID_SCHEMA_VERSION', 'catalogue.schemaVersion', `must be ${CATALOGUE_SCHEMA_VERSION}`);
  }
  if (catalogue.kind !== 'clipCatalogue') fail(errors, 'INVALID_KIND', 'catalogue.kind', 'must be clipCatalogue');
  if (checkObject(catalogue.pack, 'catalogue.pack', errors, new Set(['id', 'title']))) {
    checkId(catalogue.pack.id, 'catalogue.pack.id', errors);
    checkString(catalogue.pack.title, 'catalogue.pack.title', errors);
  }
  const declaredPolicy = loopPolicy || catalogue.loopPolicy || DEFAULT_LOOP_POLICY;
  validateLoopPolicy(declaredPolicy, loopPolicy ? 'options.loopPolicy' : (catalogue.loopPolicy ? 'catalogue.loopPolicy' : 'defaultLoopPolicy'), errors);
  const policy = isObject(declaredPolicy) && isObject(declaredPolicy.normal) && isObject(declaredPolicy.judged)
    ? declaredPolicy
    : DEFAULT_LOOP_POLICY;
  if (!Array.isArray(catalogue.clips) || catalogue.clips.length === 0) {
    fail(errors, 'INVALID_CLIPS', 'catalogue.clips', 'must contain at least one clip record');
  } else {
    const ids = new Map();
    const mappings = new Map();
    catalogue.clips.forEach((clip, index) => {
      validateClip(clip, index, policy, errors);
      if (typeof clip?.id === 'string') {
        if (ids.has(clip.id)) fail(errors, 'DUPLICATE_RECORD', `clips[${index}].id`, `duplicates clips[${ids.get(clip.id)}].id`);
        else ids.set(clip.id, index);
      }
      if (typeof clip?.side === 'string') {
        for (const movementId of clipCoverageMovementIds(clip)) {
          if (typeof movementId !== 'string') continue;
          const mappingKey = `${movementId}::${clip.side}`;
          if (mappings.has(mappingKey)) {
            fail(errors, 'DUPLICATE_MAPPING', `${locationFor(index)}.movementId`, `duplicates ${mappings.get(mappingKey)}`);
          } else {
            mappings.set(mappingKey, `clips[${index}]`);
          }
        }
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

function locationFor(index) {
  return `clips[${index}]`;
}

function expectedMappingKey(clip) {
  return `${clip.movementId}::${clip.side}`;
}

function clipCoverageMovementIds(clip) {
  return [clip.movementId, ...(Array.isArray(clip.coversMovementIds) ? clip.coversMovementIds : [])];
}

function recordMappingKeys(record) {
  return Array.isArray(record.mappingKeys) && record.mappingKeys.length > 0
    ? record.mappingKeys
    : [record.mappingKey];
}

function sameTimeRange(left, right) {
  return isObject(left) && isObject(right)
    && left.startSeconds === right.startSeconds
    && left.endSeconds === right.endSeconds;
}

function loopOutputFromRecord(record) {
  return isObject(record?.output?.loop) ? record.output.loop : record?.output;
}

function validateOutputDescriptor(output, location, errors, { poster = false } = {}) {
  if (!checkObject(output, location, errors)) return false;
  let valid = checkString(output.video, `${location}.video`, errors);
  if (poster) valid = checkString(output.poster, `${location}.poster`, errors) && valid;
  return valid;
}

export function validateManifestStructure(manifest, catalogue) {
  const errors = [];
  if (!checkObject(manifest, 'manifest', errors, new Set(['schemaVersion', 'kind', 'pack', 'loopPolicy', 'outputFrame', 'clips']))) {
    return { valid: false, errors };
  }
  if (manifest.schemaVersion !== CLIP_MANIFEST_SCHEMA_VERSION) {
    fail(errors, 'INVALID_SCHEMA_VERSION', 'manifest.schemaVersion', `must be ${CLIP_MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.kind !== 'clipManifest') fail(errors, 'INVALID_KIND', 'manifest.kind', 'must be clipManifest');
  if (!Array.isArray(manifest.clips)) {
    fail(errors, 'INVALID_CLIPS', 'manifest.clips', 'must be an array');
    return { valid: false, errors };
  }
  const expected = new Map();
  const expectedPrimaryById = new Map();
  for (const clip of catalogue?.clips || []) {
    const primaryMappingKey = expectedMappingKey(clip);
    if (expectedPrimaryById.has(clip.id) && expectedPrimaryById.get(clip.id) !== primaryMappingKey) {
      fail(errors, 'DUPLICATE_RECORD', 'catalogue.clips', `record ${clip.id} has multiple primary mapping keys`);
    } else {
      expectedPrimaryById.set(clip.id, primaryMappingKey);
    }
    for (const movementId of clipCoverageMovementIds(clip)) {
      const mappingKey = `${movementId}::${clip.side}`;
      if (expected.has(mappingKey)) {
        fail(errors, 'DUPLICATE_MAPPING', 'catalogue.clips', `contains duplicate ${mappingKey}`);
      } else {
        expected.set(mappingKey, clip.id);
      }
    }
  }
  const seenIds = new Map();
  const seenMappings = new Map();
  for (const [index, record] of manifest.clips.entries()) {
    const location = `manifest.clips[${index}]`;
    if (!checkObject(record, location, errors)) continue;
    if (typeof record.id !== 'string') fail(errors, 'INVALID_STRING', `${location}.id`, 'must be a string');
    if (typeof record.mappingKey !== 'string') fail(errors, 'INVALID_MAPPING', `${location}.mappingKey`, 'must be a string');
    if (record.mappingKeys !== undefined && (!Array.isArray(record.mappingKeys) || record.mappingKeys.length === 0)) {
      fail(errors, 'INVALID_MAPPING', `${location}.mappingKeys`, 'must be a non-empty array when present');
    }
    const expectedPrimary = expectedPrimaryById.get(record.id);
    if (typeof record.mappingKey === 'string' && expectedPrimary !== undefined && record.mappingKey !== expectedPrimary) {
      fail(errors, 'PRIMARY_MAPPING_MISMATCH', `${location}.mappingKey`, `must equal the catalogue primary mapping ${expectedPrimary}`);
    }
    if (Array.isArray(record.mappingKeys) && typeof record.mappingKey === 'string' && !record.mappingKeys.includes(record.mappingKey)) {
      fail(errors, 'PRIMARY_MAPPING_MISSING', `${location}.mappingKeys`, 'must include mappingKey');
    }
    if (typeof record.id === 'string') {
      if (seenIds.has(record.id)) fail(errors, 'DUPLICATE_RECORD', `${location}.id`, `duplicates ${seenIds.get(record.id)}`);
      else seenIds.set(record.id, location);
    }
    for (const [mappingIndex, mappingKey] of recordMappingKeys(record).entries()) {
      const mappingLocation = `${location}.mappingKeys[${mappingIndex}]`;
      if (typeof mappingKey !== 'string') {
        fail(errors, 'INVALID_MAPPING', mappingLocation, 'must be a string');
        continue;
      }
      if (seenMappings.has(mappingKey)) fail(errors, 'DUPLICATE_MAPPING', mappingLocation, `duplicates ${seenMappings.get(mappingKey)}`);
      else seenMappings.set(mappingKey, location);
      if (!expected.has(mappingKey)) fail(errors, 'UNMAPPED_OUTPUT', mappingLocation, `has no catalogue record for ${mappingKey}`);
      else if (expected.get(mappingKey) !== record.id) fail(errors, 'MAPPING_ID_MISMATCH', `${location}.id`, 'does not match the catalogue mapping');
    }
    if (!isObject(record.output)) {
      fail(errors, 'MISSING_OUTPUT', `${location}.output`, 'must describe encoded outputs');
    } else {
      const catalogueClip = (catalogue?.clips || []).find((clip) => clip?.id === record.id);
      if (catalogueClip?.referenceRange !== undefined) {
        if (!sameTimeRange(record.referenceRange, catalogueClip.referenceRange)) {
          fail(errors, 'REFERENCE_RANGE_MISMATCH', `${location}.referenceRange`, 'must match the catalogue referenceRange');
        }
        if (!isObject(record.output.reference)) {
          fail(errors, 'MISSING_REFERENCE_OUTPUT', `${location}.output.reference`, 'must describe the encoded reference segment');
        } else {
          validateOutputDescriptor(record.output.reference, `${location}.output.reference`, errors);
        }
        if (!isObject(record.output.loop)) {
          fail(errors, 'MISSING_LOOP_OUTPUT', `${location}.output.loop`, 'must describe the encoded short loop');
        } else {
          validateOutputDescriptor(record.output.loop, `${location}.output.loop`, errors, { poster: true });
        }
      } else {
        validateOutputDescriptor(record.output, `${location}.output`, errors, { poster: true });
      }
      if (!isObject(loopOutputFromRecord(record))) {
        fail(errors, 'MISSING_LOOP_OUTPUT', `${location}.output`, 'must describe the encoded short loop');
      }
    }
  }
  for (const [mappingKey, id] of expected) {
    if (!seenMappings.has(mappingKey)) fail(errors, 'MISSING_OUTPUT', 'manifest.clips', `missing output for ${mappingKey} (${id})`);
  }
  return { valid: errors.length === 0, errors };
}

function throwValidation(result, message) {
  if (!result.valid) {
    throw new PipelineError('VALIDATION_FAILED', message, { errors: result.errors });
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(file, code = 'INVALID_JSON') {
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new PipelineError('READ_FAILED', `Could not read ${file}`, { file, cause: error.message });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new PipelineError(code, `${file} is not valid JSON`, { file, cause: error.message });
  }
}

export async function readCatalogue(file) {
  const catalogue = await readJsonFile(file);
  throwValidation(validateCatalogue(catalogue), `Invalid clip catalogue: ${file}`);
  return catalogue;
}

async function writeJsonIfChanged(file, value) {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  if (await pathExists(file)) {
    const previous = await readFile(file, 'utf8');
    if (previous === source) return false;
  }
  await writeFile(file, source, 'utf8');
  return true;
}

function assertExternalRoot(root, label) {
  const absolute = path.resolve(root);
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new PipelineError('ROOT_INSIDE_REPO', `${label} must be outside the Git checkout`, { label, root: absolute });
  }
  return absolute;
}

function assertDistinctRoots(sourceCacheRoot, outputRoot) {
  const sourceRelative = path.relative(sourceCacheRoot, outputRoot);
  const outputRelative = path.relative(outputRoot, sourceCacheRoot);
  if (sourceRelative === '' || outputRelative === '' || (!sourceRelative.startsWith('..') && !path.isAbsolute(sourceRelative)) || (!outputRelative.startsWith('..') && !path.isAbsolute(outputRelative))) {
    throw new PipelineError('ROOT_OVERLAP', 'source cache and output roots must be separate directories', { sourceCacheRoot, outputRoot });
  }
}

function normalizedPathFromSourceUrl(url, baseDirectory) {
  if (url.startsWith('file:')) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      throw new PipelineError('INVALID_SOURCE', `Invalid file source URL: ${url}`, { cause: error.message });
    }
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      throw new PipelineError('INVALID_SOURCE', 'file source URLs may not name a remote host', { url });
    }
    return path.resolve(fileURLToPath(parsed));
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) return null;
  return path.resolve(baseDirectory, url);
}

function cacheKeyForSource(source) {
  return source.cacheKey || `source-${hashText(source.url).slice(0, 20)}`;
}

function sourceCacheFile(root, source) {
  const cacheKey = cacheKeyForSource(source);
  const extension = source.url.startsWith('file:') || !/^[a-z][a-z\d+.-]*:/i.test(source.url)
    ? path.extname(normalizedPathFromSourceUrl(source.url, process.cwd()) || '').toLowerCase()
    : '.mp4';
  return {
    cacheKey,
    file: path.join(root, `${cacheKey}${extension || '.media'}`),
    metadata: path.join(root, `${cacheKey}.json`),
  };
}

function commandResult(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new PipelineError('TOOL_NOT_FOUND', `Could not start ${command}`, { command, cause: error.message }));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new PipelineError('TOOL_NOT_FOUND', `Could not start ${command}`, { command, cause: error.message })));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runRequiredTool(command, args, label) {
  const result = await commandResult(command, args);
  if (result.code !== 0) {
    throw new PipelineError('TOOL_FAILED', `${label} failed with exit code ${result.code}`, {
      command,
      args,
      exitCode: result.code,
      signal: result.signal,
      stderr: result.stderr.trim().slice(-4000),
    });
  }
  return result;
}

async function resolveYtDlp(explicit) {
  if (explicit) return { command: explicit, args: [] };
  const candidates = [
    { command: process.env.FITTIMER_MEDIA_YTDLP || 'yt-dlp', args: [] },
    { command: process.env.FITTIMER_MEDIA_UVX || 'uvx', args: ['yt-dlp'] },
  ];
  for (const candidate of candidates) {
    try {
      const result = await commandResult(candidate.command, [...candidate.args, '--version']);
      if (result.code === 0) return candidate;
    } catch {
      // Try the next configured discovery path.
    }
  }
  throw new PipelineError('TOOL_NOT_FOUND', 'yt-dlp was not found; configure --yt-dlp or FITTIMER_MEDIA_YTDLP', { candidates });
}

async function downloadWithYtDlp(source, cacheRoot, target, explicitYtDlp) {
  const tool = await resolveYtDlp(explicitYtDlp);
  const tempRoot = await mkdtemp(path.join(cacheRoot, '.yt-dlp-'));
  try {
    const template = path.join(tempRoot, '%(id)s.%(ext)s');
    await runRequiredTool(
      tool.command,
      [...tool.args, '--no-playlist', '--no-progress', '--no-warnings', '--no-part', '--merge-output-format', 'mp4', '-o', template, '--', source.url],
      'yt-dlp',
    );
    const candidates = (await readdir(tempRoot))
      .filter((name) => !name.startsWith('.') && !name.endsWith('.part'))
      .map((name) => path.join(tempRoot, name));
    if (candidates.length !== 1) {
      throw new PipelineError('SOURCE_DOWNLOAD_INVALID', 'yt-dlp did not produce exactly one source file', { source: source.url, candidates });
    }
    await copyFile(candidates[0], target);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function ensureCachedSource(source, { sourceCacheRoot, catalogueDirectory, ytDlp }, log) {
  const target = sourceCacheFile(sourceCacheRoot, source);
  const metadata = {
    schemaVersion: 1,
    sourceUrl: source.url,
    cacheKey: target.cacheKey,
  };
  if (await pathExists(target.file) || await pathExists(target.metadata)) {
    if (!(await pathExists(target.file)) || !(await pathExists(target.metadata))) {
      throw new PipelineError('CACHE_METADATA_MISSING', `Source cache entry is incomplete for ${target.cacheKey}`, { file: target.file, metadata: target.metadata });
    }
    const previous = await readJsonFile(target.metadata, 'INVALID_CACHE_METADATA');
    if (previous.sourceUrl !== source.url || previous.cacheKey !== target.cacheKey) {
      throw new PipelineError('CACHE_KEY_COLLISION', `Cache key ${target.cacheKey} belongs to another source`, { expected: metadata, actual: previous });
    }
    const sourceStat = await stat(target.file);
    if (!sourceStat.isFile() || sourceStat.size === 0) throw new PipelineError('EMPTY_SOURCE', `Cached source is empty: ${target.file}`, { file: target.file });
    const sha256 = await sha256File(target.file);
    log('source-cache-hit', { cacheKey: target.cacheKey, sizeBytes: sourceStat.size });
    return { ...target, sha256, downloaded: false, copied: false };
  }

  await mkdir(sourceCacheRoot, { recursive: true });
  const localPath = normalizedPathFromSourceUrl(source.url, catalogueDirectory);
  if (localPath) {
    if (!(await pathExists(localPath))) throw new PipelineError('SOURCE_MISSING', `Local source does not exist: ${localPath}`, { source: source.url, file: localPath });
    await copyFile(localPath, target.file);
    log('source-copied', { cacheKey: target.cacheKey, source: source.url });
    await writeJsonIfChanged(target.metadata, metadata);
    const sourceStat = await stat(target.file);
    return { ...target, sha256: await sha256File(target.file), downloaded: false, copied: true, sizeBytes: sourceStat.size };
  }
  if (!/^https?:\/\//i.test(source.url)) {
    throw new PipelineError('INVALID_SOURCE', `Unsupported source URL: ${source.url}`, { source: source.url });
  }
  await downloadWithYtDlp(source, sourceCacheRoot, target.file, ytDlp);
  await writeJsonIfChanged(target.metadata, metadata);
  const sourceStat = await stat(target.file);
  if (!sourceStat.isFile() || sourceStat.size === 0) throw new PipelineError('EMPTY_SOURCE', `Downloaded source is empty: ${target.file}`, { file: target.file });
  log('source-downloaded', { cacheKey: target.cacheKey, source: source.url, sizeBytes: sourceStat.size });
  return { ...target, sha256: await sha256File(target.file), downloaded: true, copied: false, sizeBytes: sourceStat.size };
}

export async function probeMedia(file, { ffprobe = process.env.FITTIMER_MEDIA_FFPROBE || 'ffprobe' } = {}) {
  const result = await runRequiredTool(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    'ffprobe',
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new PipelineError('INVALID_FFPROBE_JSON', `ffprobe returned invalid JSON for ${file}`, { file, cause: error.message });
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const durationCandidate = parsed.format?.duration ?? video[0]?.duration;
  const durationSeconds = Number.isFinite(Number(durationCandidate)) ? Number(durationCandidate) : null;
  return {
    file,
    width: video[0]?.width ?? null,
    height: video[0]?.height ?? null,
    durationSeconds,
    videoStreams: video.length,
    audioStreams: audio.length,
    codecName: video[0]?.codec_name ?? null,
    pixelFormat: video[0]?.pix_fmt ?? null,
    formatName: parsed.format?.format_name ?? null,
  };
}

export function validateVideoProbe(probe, { expectedWidth, expectedHeight, expectedDurationSeconds, requireSilent = true } = {}) {
  const errors = [];
  if (probe.videoStreams !== 1) fail(errors, 'VIDEO_STREAM_COUNT', 'probe.videoStreams', 'must contain exactly one video stream');
  if (requireSilent && probe.audioStreams !== 0) fail(errors, 'VIDEO_NOT_SILENT', 'probe.audioStreams', 'must contain no audio streams');
  if (probe.codecName !== 'h264') fail(errors, 'VIDEO_CODEC', 'probe.codecName', 'must be H.264');
  if (probe.pixelFormat !== 'yuv420p') fail(errors, 'VIDEO_PIXEL_FORMAT', 'probe.pixelFormat', 'must be yuv420p');
  if (!Number.isInteger(probe.width) || !Number.isInteger(probe.height) || probe.width <= 0 || probe.height <= 0) {
    fail(errors, 'VIDEO_DIMENSIONS', 'probe', 'must report positive dimensions');
  } else if (probe.width * 9 !== probe.height * 16) {
    fail(errors, 'VIDEO_ASPECT_RATIO', 'probe', 'must be exact 16:9');
  }
  if (expectedWidth !== undefined && probe.width !== expectedWidth) fail(errors, 'VIDEO_DIMENSIONS', 'probe.width', `must be ${expectedWidth}`);
  if (expectedHeight !== undefined && probe.height !== expectedHeight) fail(errors, 'VIDEO_DIMENSIONS', 'probe.height', `must be ${expectedHeight}`);
  if (expectedDurationSeconds !== undefined && (probe.durationSeconds === null || Math.abs(probe.durationSeconds - expectedDurationSeconds) > 0.15)) {
    fail(errors, 'VIDEO_DURATION', 'probe.durationSeconds', `must be within 0.15 seconds of ${expectedDurationSeconds}`);
  }
  return { valid: errors.length === 0, errors };
}

export function validatePosterProbe(probe, { expectedWidth, expectedHeight, allowedCodecs = ['png'], allowedFormats = ['png_pipe', 'png'] } = {}) {
  const errors = [];
  if (probe.videoStreams !== 1) fail(errors, 'POSTER_STREAM_COUNT', 'probe.videoStreams', 'must contain exactly one video stream');
  if (probe.audioStreams !== 0) fail(errors, 'POSTER_NOT_SILENT', 'probe.audioStreams', 'must contain no audio streams');
  if (!allowedCodecs.includes(probe.codecName)) fail(errors, 'POSTER_CODEC', 'probe.codecName', `must be one of ${allowedCodecs.join(', ')}`);
  if (!allowedFormats.includes(probe.formatName)) fail(errors, 'POSTER_FORMAT', 'probe.formatName', `must be one of ${allowedFormats.join(', ')}`);
  if (expectedWidth !== undefined && probe.width !== expectedWidth) fail(errors, 'POSTER_DIMENSIONS', 'probe.width', `must be ${expectedWidth}`);
  if (expectedHeight !== undefined && probe.height !== expectedHeight) fail(errors, 'POSTER_DIMENSIONS', 'probe.height', `must be ${expectedHeight}`);
  return { valid: errors.length === 0, errors };
}

function cropPixels(crop, sourceWidth, sourceHeight) {
  let x = Math.round(crop.x * sourceWidth);
  let y = Math.round(crop.y * sourceHeight);
  let width = Math.round(crop.width * sourceWidth);
  let height = Math.round(crop.height * sourceHeight);
  if (x % 2) x -= 1;
  if (y % 2) y -= 1;
  if (width % 2) width -= 1;
  if (height % 2) height -= 1;
  if (x < 0 || y < 0 || width < 2 || height < 2 || x + width > sourceWidth || y + height > sourceHeight) {
    throw new PipelineError('INVALID_CROP', 'Normalized crop does not produce a valid even-pixel source rectangle', { crop, sourceWidth, sourceHeight });
  }
  if (width * 9 !== height * 16) {
    throw new PipelineError('INVALID_CROP', 'Normalized crop must produce an exact 16:9 pixel rectangle at source resolution', {
      crop,
      sourceWidth,
      sourceHeight,
      pixelCrop: { x, y, width, height },
    });
  }
  return { x, y, width, height };
}

function outputDimensions(pixelCrop, maxWidth) {
  const requestedMax = Math.floor(maxWidth);
  const width = Math.floor(Math.min(pixelCrop.width, requestedMax) / 32) * 32;
  if (width < 32) throw new PipelineError('OUTPUT_TOO_SMALL', 'Crop is too small for an even 16:9 H.264 output without upsampling', { pixelCrop, maxWidth });
  const height = (width / 16) * 9;
  return { width, height };
}

function filterFor(pixelCrop, output) {
  return `crop=${pixelCrop.width}:${pixelCrop.height}:${pixelCrop.x}:${pixelCrop.y},scale=${output.width}:${output.height}:flags=lanczos,setsar=1`;
}

function outputToRecord(output, { video, poster } = {}) {
  return {
    video,
    ...(poster ? { poster } : {}),
    width: output.width,
    height: output.height,
    durationSeconds: output.durationSeconds,
    sizeBytes: output.sizeBytes,
    sha256: output.sha256,
    codec: output.codec,
    pixelFormat: output.pixelFormat,
    audioStreams: output.audioStreams,
    ...(output.poster ? {
      posterWidth: output.poster.width,
      posterHeight: output.poster.height,
      posterSizeBytes: output.poster.sizeBytes,
      posterSha256: output.poster.sha256,
    } : {}),
  };
}

function mappingToRecord(clip, sourceInfo, sourceProbe, loop, reference, recordFingerprint) {
  const loopOutput = outputToRecord(loop.output, {
    video: `clips/${clip.id}.mp4`,
    poster: `posters/${clip.id}.png`,
  });
  const output = reference
    ? {
        reference: outputToRecord(reference.output, { video: `references/${clip.id}.mp4` }),
        loop: loopOutput,
      }
    : loopOutput;
  return {
    id: clip.id,
    ...(clip.intervalNumber !== undefined ? { intervalNumber: clip.intervalNumber } : {}),
    ...(clip.intervalName !== undefined ? { intervalName: clip.intervalName } : {}),
    mappingKey: expectedMappingKey(clip),
    mappingKeys: clipCoverageMovementIds(clip).map((movementId) => `${movementId}::${clip.side}`),
    source: {
      url: clip.source.url,
      cacheKey: sourceInfo.cacheKey,
      sha256: sourceInfo.sha256,
      ...(clip.source.videoId !== undefined ? { videoId: clip.source.videoId } : {}),
      ...(clip.source.canonicalUrl !== undefined ? { canonicalUrl: clip.source.canonicalUrl } : {}),
    },
    timeRange: {
      startSeconds: clip.timeRange.startSeconds,
      endSeconds: clip.timeRange.endSeconds,
      durationSeconds: roundNumber(clip.timeRange.endSeconds - clip.timeRange.startSeconds),
    },
    ...(clip.referenceRange !== undefined
      ? {
          referenceRange: {
            startSeconds: clip.referenceRange.startSeconds,
            endSeconds: clip.referenceRange.endSeconds,
            durationSeconds: roundNumber(clip.referenceRange.endSeconds - clip.referenceRange.startSeconds),
          },
        }
      : {}),
    movementId: clip.movementId,
    ...(Array.isArray(clip.coversMovementIds) && clip.coversMovementIds.length > 0
      ? { coversMovementIds: [...clip.coversMovementIds] }
      : {}),
    side: clip.side,
    equipment: [...clip.equipment],
    viewpoint: clip.viewpoint,
    crop: structuredClone(clip.crop),
    safeFrame: structuredClone(clip.safeFrame),
    loop: structuredClone(clip.loop),
    movementKind: clip.movementKind,
    ...(clip.formNotes !== undefined ? { formNotes: clip.formNotes } : {}),
    ...(clip.seamNotes !== undefined ? { seamNotes: clip.seamNotes } : {}),
    ...(clip.mocapNotes !== undefined ? { mocapNotes: clip.mocapNotes } : {}),
    ...(clip.mocapRange !== undefined ? { mocapRange: structuredClone(clip.mocapRange) } : {}),
    sourceMedia: {
      width: sourceProbe.width,
      height: sourceProbe.height,
      durationSeconds: roundNullable(sourceProbe.durationSeconds),
      audioStreams: sourceProbe.audioStreams,
    },
    output,
    recordFingerprint,
  };
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function roundNullable(value) {
  return value === null ? null : roundNumber(value);
}

function buildMediaPack(catalogue, records) {
  const profileId = 'encoded-landscape';
  const full = { x: 0, y: 0, width: 1, height: 1 };
  const framing = {
    fit: 'contain',
    crop: full,
    zoom: 1,
    anchor: { x: 0.5, y: 0.5 },
    safeRegions: {
      hands: full,
      feet: full,
      equipment: full,
      movementPath: full,
    },
  };
  const entries = {};
  for (const record of [...records].sort((left, right) => left.movementId.localeCompare(right.movementId) || left.id.localeCompare(right.id))) {
    const loopOutput = loopOutputFromRecord(record);
    for (const movementId of [record.movementId, ...(record.coversMovementIds || [])]) {
      if (!entries[movementId]) {
        entries[movementId] = {
          anatomicalSide: record.side === 'first' || record.side === 'second' ? 'unspecified' : record.side,
          mirroring: 'never',
          assets: [],
        };
      }
      entries[movementId].assets.push(
        { type: 'video', url: loopOutput.video, framing: profileId, side: record.side },
        { type: 'poster', url: loopOutput.poster, framing: profileId, side: record.side },
      );
    }
  }
  return {
    schemaVersion: MEDIA_PACK_SCHEMA_VERSION,
    kind: 'mediaPack',
    id: catalogue.pack.id,
    title: catalogue.pack.title,
    outputFrame: structuredClone(OUTPUT_FRAME),
    framingProfiles: { [profileId]: framing },
    entries,
  };
}

async function encodeVideoOutput({ clipId, outputKind, range, sourceInfo, sourceProbe, outputFile, filter, dimensions, tools, log }) {
  const duration = range.endSeconds - range.startSeconds;
  await mkdir(path.dirname(outputFile), { recursive: true });
  log('encode-start', {
    clipId,
    outputKind,
    durationSeconds: duration,
    width: dimensions.width,
    height: dimensions.height,
    seek: 'input',
  });
  await runRequiredTool(
    tools.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      // Keep seeking before the input so late source ranges do not decode from
      // time zero for every derived output. -t remains an output duration gate.
      '-ss', String(range.startSeconds),
      '-i', sourceInfo.file,
      '-t', String(duration),
      '-map', '0:v:0',
      '-vf', filter,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-movflags', '+faststart',
      '-map_metadata', '-1',
      outputFile,
    ],
    `ffmpeg ${outputKind} video encode`,
  );
  const videoProbe = await probeMedia(outputFile, { ffprobe: tools.ffprobe });
  const videoValidation = validateVideoProbe(videoProbe, {
    expectedWidth: dimensions.width,
    expectedHeight: dimensions.height,
    expectedDurationSeconds: duration,
  });
  throwValidation(videoValidation, `Encoded ${outputKind} video failed validation for ${clipId}`);
  const videoStat = await stat(outputFile);
  const videoSha = await sha256File(outputFile);
  return {
    videoProbe,
    videoStat,
    videoSha,
    output: {
      width: videoProbe.width,
      height: videoProbe.height,
      durationSeconds: roundNumber(videoProbe.durationSeconds),
      sizeBytes: videoStat.size,
      sha256: videoSha,
      codec: videoProbe.codecName,
      pixelFormat: videoProbe.pixelFormat,
      audioStreams: videoProbe.audioStreams,
    },
  };
}

async function encodePoster({ clipId, range, sourceInfo, outputFile, filter, dimensions, tools, log }) {
  await mkdir(path.dirname(outputFile), { recursive: true });
  log('poster-start', {
    clipId,
    durationSeconds: 0,
    width: dimensions.width,
    height: dimensions.height,
    seek: 'input',
  });
  await runRequiredTool(
    tools.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      // The poster uses the same input-side seek as the short loop.
      '-ss', String(range.startSeconds),
      '-i', sourceInfo.file,
      '-map', '0:v:0',
      '-vf', filter,
      '-frames:v', '1',
      '-an',
      '-map_metadata', '-1',
      outputFile,
    ],
    'ffmpeg poster encode',
  );
  const posterProbe = await probeMedia(outputFile, { ffprobe: tools.ffprobe });
  const posterValidation = validatePosterProbe(posterProbe, {
    expectedWidth: dimensions.width,
    expectedHeight: dimensions.height,
  });
  throwValidation(posterValidation, `Poster failed validation for ${clipId}`);
  const posterStat = await stat(outputFile);
  const posterSha = await sha256File(outputFile);
  return {
    posterProbe,
    posterStat,
    posterSha,
    output: {
      width: posterProbe.width,
      height: posterProbe.height,
      sizeBytes: posterStat.size,
      sha256: posterSha,
    },
  };
}

async function encodeClip(clip, sourceInfo, sourceProbe, outputRoot, tools, maxWidth, log) {
  if (sourceProbe.width === null || sourceProbe.height === null) {
    throw new PipelineError('SOURCE_NO_VIDEO', `Source has no video dimensions: ${sourceInfo.file}`, { file: sourceInfo.file });
  }
  const pixelCrop = cropPixels(clip.crop, sourceProbe.width, sourceProbe.height);
  const output = outputDimensions(pixelCrop, maxWidth);
  const filter = filterFor(pixelCrop, output);
  const videoFile = path.join(outputRoot, 'clips', `${clip.id}.mp4`);
  const posterFile = path.join(outputRoot, 'posters', `${clip.id}.png`);
  const referenceFile = clip.referenceRange ? path.join(outputRoot, 'references', `${clip.id}.mp4`) : null;
  const reference = clip.referenceRange
    ? await encodeVideoOutput({
        clipId: clip.id,
        outputKind: 'reference',
        range: clip.referenceRange,
        sourceInfo,
        sourceProbe,
        outputFile: referenceFile,
        filter,
        dimensions: output,
        tools,
        log,
      })
    : null;
  const loop = await encodeVideoOutput({
    clipId: clip.id,
    outputKind: 'loop',
    range: clip.timeRange,
    sourceInfo,
    sourceProbe,
    outputFile: videoFile,
    filter,
    dimensions: output,
    tools,
    log,
  });
  const poster = await encodePoster({
    clipId: clip.id,
    range: clip.timeRange,
    sourceInfo,
    outputFile: posterFile,
    filter,
    dimensions: output,
    tools,
    log,
  });
  return {
    reference,
    loop: {
      ...loop,
      output: {
        ...loop.output,
        poster: poster.output,
      },
    },
  };
}

async function loadExistingManifest(file) {
  if (!(await pathExists(file))) return null;
  return readJsonFile(file, 'INVALID_MANIFEST_JSON');
}

function assertNoUnexpectedExistingOutput(outputRoot, existingManifest, clip) {
  if (existingManifest) return;
  const videoFile = path.join(outputRoot, 'clips', `${clip.id}.mp4`);
  const posterFile = path.join(outputRoot, 'posters', `${clip.id}.png`);
  const referenceFile = clip.referenceRange ? path.join(outputRoot, 'references', `${clip.id}.mp4`) : null;
  if (pathExistsSync(videoFile) || pathExistsSync(posterFile) || (referenceFile && pathExistsSync(referenceFile))) {
    throw new PipelineError('OUTPUT_EXISTS_WITHOUT_MANIFEST', `Output exists without a pipeline manifest for ${clip.id}`, {
      videoFile,
      posterFile,
      ...(referenceFile ? { referenceFile } : {}),
    });
  }
}

function pathExistsSync(file) {
  try {
    // This is intentionally limited to the two expected output paths; async stat is used for all normal I/O.
    return existsSync(file);
  } catch {
    return false;
  }
}

export async function runPipeline(options = {}) {
  const cataloguePath = options.cataloguePath || options.catalogueFile;
  const catalogue = typeof options.catalogue === 'object' ? options.catalogue : await readCatalogue(cataloguePath);
  const requestedPolicy = options.loopPolicy || catalogue.loopPolicy;
  throwValidation(
    validateCatalogue(catalogue, requestedPolicy ? { loopPolicy: requestedPolicy } : {}),
    'Invalid clip catalogue',
  );
  const effectivePolicy = requestedPolicy || DEFAULT_LOOP_POLICY;
  const catalogueDirectory = options.catalogueDirectory || (cataloguePath ? path.dirname(path.resolve(cataloguePath)) : process.cwd());
  const sourceCacheRoot = assertExternalRoot(
    options.sourceCacheRoot || process.env.FITTIMER_MEDIA_SOURCE_CACHE || path.join(RESEARCH_ROOT, 'source-cache'),
    'source cache root',
  );
  const outputRoot = assertExternalRoot(
    options.outputRoot || process.env.FITTIMER_MEDIA_OUTPUT_ROOT || path.join(RESEARCH_ROOT, 'pipeline-output'),
    'output root',
  );
  assertDistinctRoots(sourceCacheRoot, outputRoot);
  const maxWidth = options.maxWidth === undefined ? DEFAULT_OUTPUT_MAX_WIDTH : Number(options.maxWidth);
  if (!Number.isInteger(maxWidth) || maxWidth < 32) throw new PipelineError('INVALID_OUTPUT_WIDTH', 'maxWidth must be an integer of at least 32', { maxWidth });
  const tools = {
    ffmpeg: options.ffmpeg || process.env.FITTIMER_MEDIA_FFMPEG || 'ffmpeg',
    ffprobe: options.ffprobe || process.env.FITTIMER_MEDIA_FFPROBE || 'ffprobe',
  };
  const log = typeof options.logger === 'function' ? options.logger : () => {};
  const outputManifestFile = path.join(outputRoot, 'clip-manifest.json');
  const outputPackFile = path.join(outputRoot, 'media-pack.json');
  await mkdir(outputRoot, { recursive: true });
  const existingManifest = await loadExistingManifest(outputManifestFile);
  if (existingManifest) throwValidation(validateManifestStructure(existingManifest, catalogue), 'Existing clip manifest does not match the catalogue');
  const existingById = new Map((existingManifest?.clips || []).map((record) => [record.id, record]));
  const counts = { cached: 0, copied: 0, downloaded: 0, encoded: 0, references: 0, loops: 0, posters: 0, skipped: 0 };
  const records = [];
  const started = Date.now();
  for (const clip of catalogue.clips) {
    assertNoUnexpectedExistingOutput(outputRoot, existingManifest, clip);
    const sourceInfo = await ensureCachedSource(clip.source, { sourceCacheRoot, catalogueDirectory, ytDlp: options.ytDlp }, log);
    if (!sourceInfo.copied && !sourceInfo.downloaded) counts.cached += 1;
    if (sourceInfo.copied) counts.copied += 1;
    if (sourceInfo.downloaded) counts.downloaded += 1;
    const sourceProbe = await probeMedia(sourceInfo.file, { ffprobe: tools.ffprobe });
    if (sourceProbe.videoStreams !== 1 || sourceProbe.width === null || sourceProbe.height === null) {
      throw new PipelineError('SOURCE_VIDEO_INVALID', `Source must contain exactly one video stream: ${clip.id}`, { source: sourceInfo.file, probe: sourceProbe });
    }
    const ranges = [
      { name: 'timeRange', value: clip.timeRange },
      ...(clip.referenceRange ? [{ name: 'referenceRange', value: clip.referenceRange }] : []),
    ];
    for (const range of ranges) {
      if (sourceProbe.durationSeconds === null || range.value.endSeconds > sourceProbe.durationSeconds + 0.05) {
        throw new PipelineError('INVALID_DURATION', `${range.name} exceeds source duration for ${clip.id}`, {
          clip: range.value,
          range: range.name,
          sourceDurationSeconds: sourceProbe.durationSeconds,
        });
      }
    }
    // This is the source-resolution crop gate. Safe-frame containment was checked structurally above.
    const pixelCrop = cropPixels(clip.crop, sourceProbe.width, sourceProbe.height);
    const dimensions = outputDimensions(pixelCrop, maxWidth);
    const fingerprint = hashText(stableJson(clip));
    const previous = existingById.get(clip.id);
    const videoFile = path.join(outputRoot, 'clips', `${clip.id}.mp4`);
    const posterFile = path.join(outputRoot, 'posters', `${clip.id}.png`);
    const referenceFile = clip.referenceRange ? path.join(outputRoot, 'references', `${clip.id}.mp4`) : null;
    let encoded;
    if (previous && previous.recordFingerprint !== fingerprint) {
      throw new PipelineError('STALE_OUTPUT', `Catalogue record changed for existing output ${clip.id}; use a new output root or remove only that owned output`, { clipId: clip.id });
    }
    if (previous && previous.source?.sha256 !== sourceInfo.sha256) {
      throw new PipelineError('STALE_SOURCE_CACHE', `Source changed for existing output ${clip.id}; use a new cache/output key`, { clipId: clip.id });
    }
    if (previous && await pathExists(videoFile) && await pathExists(posterFile) && (!referenceFile || await pathExists(referenceFile))) {
      const loopOutput = loopOutputFromRecord(previous);
      const referenceOutput = isObject(previous.output?.reference) ? previous.output.reference : null;
      const videoProbe = await probeMedia(videoFile, { ffprobe: tools.ffprobe });
      const posterProbe = await probeMedia(posterFile, { ffprobe: tools.ffprobe });
      const videoStat = await stat(videoFile);
      const posterStat = await stat(posterFile);
      const videoSha = await sha256File(videoFile);
      const posterSha = await sha256File(posterFile);
      const valid = validateVideoProbe(videoProbe, {
        expectedWidth: dimensions.width,
        expectedHeight: dimensions.height,
        expectedDurationSeconds: clip.timeRange.endSeconds - clip.timeRange.startSeconds,
      });
      const posterValid = validatePosterProbe(posterProbe, {
        expectedWidth: dimensions.width,
        expectedHeight: dimensions.height,
      });
      let referenceValid = { valid: true, errors: [] };
      let referenceMatches = true;
      if (clip.referenceRange) {
        const referenceProbe = await probeMedia(referenceFile, { ffprobe: tools.ffprobe });
        referenceValid = validateVideoProbe(referenceProbe, {
          expectedWidth: dimensions.width,
          expectedHeight: dimensions.height,
          expectedDurationSeconds: clip.referenceRange.endSeconds - clip.referenceRange.startSeconds,
        });
        const referenceStat = await stat(referenceFile);
        const referenceSha = await sha256File(referenceFile);
        referenceMatches = Boolean(referenceOutput)
          && referenceOutput.video === `references/${clip.id}.mp4`
          && referenceOutput.sha256 === referenceSha
          && referenceOutput.sizeBytes === referenceStat.size;
      }
      if (
        valid.valid
        && posterValid.valid
        && referenceValid.valid
        && isObject(loopOutput)
        && loopOutput.video === `clips/${clip.id}.mp4`
        && loopOutput.poster === `posters/${clip.id}.png`
        && loopOutput.sha256 === videoSha
        && loopOutput.sizeBytes === videoStat.size
        && loopOutput.posterSha256 === posterSha
        && loopOutput.posterSizeBytes === posterStat.size
        && referenceMatches
      ) {
        records.push(previous);
        counts.skipped += 1;
        log('clip-skip', { clipId: clip.id, reason: 'manifest-and-output-match' });
        continue;
      }
    }
    encoded = await encodeClip(clip, sourceInfo, sourceProbe, outputRoot, tools, maxWidth, log);
    counts.encoded += clip.referenceRange ? 2 : 1;
    counts.references += clip.referenceRange ? 1 : 0;
    counts.loops += 1;
    counts.posters += 1;
    records.push(mappingToRecord(
      clip,
      sourceInfo,
      sourceProbe,
      encoded.loop,
      encoded.reference,
      fingerprint,
    ));
  }
  records.sort((left, right) => left.mappingKey.localeCompare(right.mappingKey));
  const manifest = {
    schemaVersion: CLIP_MANIFEST_SCHEMA_VERSION,
    kind: 'clipManifest',
    pack: { ...catalogue.pack },
    loopPolicy: structuredClone(effectivePolicy),
    outputFrame: structuredClone(OUTPUT_FRAME),
    clips: records,
  };
  throwValidation(validateManifestStructure(manifest, catalogue), 'Generated clip manifest is incomplete');
  const pack = buildMediaPack(catalogue, records);
  const manifestChanged = await writeJsonIfChanged(outputManifestFile, manifest);
  const packChanged = await writeJsonIfChanged(outputPackFile, pack);
  const summary = {
    schemaVersion: CLIP_MANIFEST_SCHEMA_VERSION,
    outputRoot,
    sourceCacheRoot,
    clipManifest: outputManifestFile,
    mediaPack: outputPackFile,
    clips: records.length,
    ...counts,
    manifestChanged,
    packChanged,
    durationMs: Date.now() - started,
  };
  log('pipeline-complete', summary);
  return summary;
}

function parseArgs(argv) {
  const options = {};
  const aliases = new Map([
    ['catalogue', 'cataloguePath'],
    ['source-cache', 'sourceCacheRoot'],
    ['output-root', 'outputRoot'],
    ['yt-dlp', 'ytDlp'],
    ['ffmpeg', 'ffmpeg'],
    ['ffprobe', 'ffprobe'],
    ['max-width', 'maxWidth'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!argument.startsWith('--')) throw new PipelineError('INVALID_ARGUMENT', `Unknown argument ${argument}`);
    const equals = argument.indexOf('=');
    const rawName = equals >= 0 ? argument.slice(2, equals) : argument.slice(2);
    const name = aliases.get(rawName);
    if (!name) throw new PipelineError('INVALID_ARGUMENT', `Unknown argument --${rawName}`);
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new PipelineError('INVALID_ARGUMENT', `Argument --${rawName} requires a value`);
    options[name] = name === 'maxWidth' ? Number(value) : value;
  }
  if (!options.cataloguePath) throw new PipelineError('INVALID_ARGUMENT', '--catalogue is required');
  return options;
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/media/pipeline.mjs --catalogue FILE [options]',
    '',
    'Options:',
    '  --source-cache DIR  External source cache (FITTIMER_MEDIA_SOURCE_CACHE)',
    '  --output-root DIR   External output root (FITTIMER_MEDIA_OUTPUT_ROOT)',
    '  --yt-dlp COMMAND    Configurable yt-dlp executable; uvx yt-dlp is the fallback',
    '  --ffmpeg COMMAND    Configurable ffmpeg executable',
    '  --ffprobe COMMAND   Configurable ffprobe executable',
    '  --max-width N       Maximum encoded width; defaults to 1280',
    '',
  ].join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const summary = await runPipeline({
    ...options,
    logger: (event, details) => process.stderr.write(`${JSON.stringify({ event, ...details })}\n`),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const payload = {
      event: 'error',
      code: error.code || 'PIPELINE_FAILED',
      message: error.message,
      details: error.details || {},
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  });
}
