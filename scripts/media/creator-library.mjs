#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CREATOR_LIBRARY_SCHEMA_VERSION = 1;
export const APPROVED_CREATORS = Object.freeze({
  madfit: Object.freeze({ name: 'MadFit' }),
  growingannanas: Object.freeze({ name: 'Growingannanas' }),
  'caroline-girvan': Object.freeze({ name: 'Caroline Girvan' }),
  'sydney-cummings': Object.freeze({ name: 'Sydney Cummings Houdyshell' }),
  'heather-robertson': Object.freeze({ name: 'Heather Robertson' }),
  'pamela-reif': Object.freeze({ name: 'Pamela Reif' }),
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = new Set(['ready', 'approximate', 'candidate', 'rejected']);
const SIDES = new Set(['left', 'right', 'first', 'second', 'alternating', 'bilateral', 'unspecified']);
const MOVEMENT_KINDS = new Set(['normal', 'compound', 'hold', 'mobility']);
const CREATOR_CHANNEL_NAMES = new Map([
  ['madfit', 'madfit'],
  ['growingannanas', 'growingannanas'],
  ['caroline girvan', 'caroline-girvan'],
  ['sydney cummings houdyshell', 'sydney-cummings'],
  ['sydney cummings', 'sydney-cummings'],
  ['heather robertson', 'heather-robertson'],
  ['pamela reif', 'pamela-reif'],
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function error(errors, code, location, message) {
  errors.push({ code, location, message });
}

async function readJson(file) {
  const source = await readFile(file, 'utf8');
  try {
    return JSON.parse(source);
  } catch (caught) {
    throw new Error(`Invalid JSON in ${file}: ${caught.message}`, { cause: caught });
  }
}

function checkText(value, location, errors) {
  if (!text(value)) {
    error(errors, 'INVALID_STRING', location, 'must be a non-empty string');
    return false;
  }
  return true;
}

function checkId(value, location, errors) {
  if (!checkText(value, location, errors)) return false;
  if (!ID_PATTERN.test(value)) {
    error(errors, 'INVALID_ID', location, 'must be lowercase kebab-case');
    return false;
  }
  return true;
}

function checkRange(value, location, errors) {
  if (!object(value)
      || typeof value.startSeconds !== 'number'
      || !Number.isFinite(value.startSeconds)
      || typeof value.endSeconds !== 'number'
      || !Number.isFinite(value.endSeconds)
      || value.startSeconds < 0
      || value.endSeconds <= value.startSeconds) {
    error(errors, 'INVALID_RANGE', location, 'must contain ordered non-negative startSeconds/endSeconds');
    return false;
  }
  return true;
}

function canonicalSource(record, sources) {
  const indexed = text(record.sourceId) ? sources.get(record.sourceId) : null;
  return {
    sourceId: record.sourceId ?? indexed?.id ?? null,
    videoId: record.sourceVideoId ?? record.videoId ?? indexed?.videoId ?? null,
    url: record.sourceUrl ?? indexed?.url ?? null,
    title: record.sourceTitle ?? indexed?.title ?? null,
    localPath: record.localPath ?? record.sourcePath ?? indexed?.localPath ?? null,
    creatorId: record.creatorId ?? indexed?.creatorId ?? null,
    channelId: indexed?.channelId ?? null,
  };
}

function canonicalRange(record) {
  if (object(record.range)) return record.range;
  if (typeof record.startSeconds === 'number' || typeof record.endSeconds === 'number') {
    return { startSeconds: record.startSeconds, endSeconds: record.endSeconds };
  }
  return null;
}

function canonicalMocapRange(record, range) {
  if (object(record.mocapRange)) return record.mocapRange;
  return range;
}

function framingNotes(record) {
  if (text(record.framing)) return record.framing.trim();
  if (object(record.framing) && text(record.framing.notes)) return record.framing.notes.trim();
  return null;
}

function canonicalRecord(record, sources) {
  const source = canonicalSource(record, sources);
  const range = canonicalRange(record);
  const mocapRange = canonicalMocapRange(record, range);
  const seed = [record.movementId, source.creatorId, source.videoId, range?.startSeconds, range?.endSeconds].join('|');
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 10);
  return {
    id: record.id ?? `${record.movementId ?? 'unknown'}-${source.creatorId ?? 'unknown'}-${digest}`,
    movementId: record.movementId,
    displayName: record.displayName,
    aliases: Array.isArray(record.aliases) ? [...new Set(record.aliases.map((alias) => String(alias).trim()).filter(Boolean))] : [],
    creatorId: source.creatorId,
    source: {
      id: source.sourceId,
      videoId: source.videoId,
      url: source.url,
      title: source.title,
      localPath: source.localPath,
      ...(source.channelId ? { channelId: source.channelId } : {}),
    },
    range,
    side: record.side ?? 'unspecified',
    equipment: Array.isArray(record.equipment) ? [...new Set(record.equipment.map((item) => String(item).trim()).filter(Boolean))] : [],
    viewpoint: text(record.viewpoint) ? record.viewpoint.trim() : 'unspecified',
    framing: framingNotes(record),
    movementKind: record.movementKind ?? 'normal',
    status: record.status,
    ...(text(record.reason) ? { reason: record.reason.trim() } : {}),
    ...(text(record.formNotes) ? { formNotes: record.formNotes.trim() } : {}),
    ...(text(record.seamNotes) ? { seamNotes: record.seamNotes.trim() } : {}),
    mocapRange,
  };
}

function validateCreator(creator, location, errors) {
  if (!object(creator)) {
    error(errors, 'INVALID_CREATOR', location, 'must be an object');
    return;
  }
  if (!checkId(creator.id, `${location}.id`, errors)) return;
  if (!APPROVED_CREATORS[creator.id]) {
    error(errors, 'UNAPPROVED_CREATOR', `${location}.id`, 'must be in the approved six-creator roster');
  }
  checkText(creator.name, `${location}.name`, errors);
  if (APPROVED_CREATORS[creator.id] && creator.name !== APPROVED_CREATORS[creator.id].name) {
    error(errors, 'CREATOR_NAME_MISMATCH', `${location}.name`, `must be ${APPROVED_CREATORS[creator.id].name}`);
  }
  for (const field of ['channelId', 'channelUrl']) {
    if (creator[field] !== undefined && creator[field] !== null) checkText(creator[field], `${location}.${field}`, errors);
  }
}

function validateSource(source, location, errors, creatorIds) {
  if (!object(source)) {
    error(errors, 'INVALID_SOURCE', location, 'must be an object');
    return;
  }
  checkId(source.id, `${location}.id`, errors);
  if (!creatorIds.has(source.creatorId)) error(errors, 'UNKNOWN_CREATOR', `${location}.creatorId`, 'must reference this file creator registry');
  for (const field of ['videoId', 'url', 'title', 'localPath']) checkText(source[field], `${location}.${field}`, errors);
  if (text(source.localPath)) {
    if (!path.isAbsolute(source.localPath)) error(errors, 'INVALID_LOCAL_PATH', `${location}.localPath`, 'must be an absolute private path');
    const relative = path.relative(REPO_ROOT, source.localPath);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      error(errors, 'SOURCE_INSIDE_REPO', `${location}.localPath`, 'private source media must stay outside Git');
    }
  }
  for (const field of ['width', 'height']) {
    if (source[field] !== undefined && (!Number.isInteger(source[field]) || source[field] <= 0)) {
      error(errors, 'INVALID_DIMENSION', `${location}.${field}`, 'must be a positive integer');
    }
  }
}

function validateRecord(record, location, errors, sourceMap) {
  if (!object(record)) {
    error(errors, 'INVALID_RECORD', location, 'must be an object');
    return;
  }
  checkId(record.id, `${location}.id`, errors);
  checkId(record.movementId, `${location}.movementId`, errors);
  checkText(record.displayName, `${location}.displayName`, errors);
  if (!Array.isArray(record.aliases)) error(errors, 'INVALID_ALIASES', `${location}.aliases`, 'must be an array');
  if (!APPROVED_CREATORS[record.creatorId]) error(errors, 'UNAPPROVED_CREATOR', `${location}.creatorId`, 'must be in the approved roster');
  for (const field of ['videoId', 'url', 'title', 'localPath']) checkText(record.source?.[field], `${location}.source.${field}`, errors);
  if (record.source?.id && !sourceMap.has(record.source.id)) error(errors, 'UNKNOWN_SOURCE', `${location}.source.id`, 'must reference this file source registry');
  const rangeValid = checkRange(record.range, `${location}.range`, errors);
  const mocapValid = checkRange(record.mocapRange, `${location}.mocapRange`, errors);
  if (rangeValid && mocapValid
      && (record.mocapRange.startSeconds < record.range.startSeconds || record.mocapRange.endSeconds > record.range.endSeconds)) {
    error(errors, 'MOCAP_OUTSIDE_RANGE', `${location}.mocapRange`, 'must stay inside the retained source range');
  }
  if (!SIDES.has(record.side)) error(errors, 'INVALID_SIDE', `${location}.side`, 'must be a supported side value');
  if (!Array.isArray(record.equipment) || record.equipment.length === 0) {
    error(errors, 'INVALID_EQUIPMENT', `${location}.equipment`, 'must list bodyweight, dumbbells, or another observed item');
  }
  checkText(record.viewpoint, `${location}.viewpoint`, errors);
  checkText(record.framing, `${location}.framing`, errors);
  if (!MOVEMENT_KINDS.has(record.movementKind)) error(errors, 'INVALID_MOVEMENT_KIND', `${location}.movementKind`, 'must be normal, compound, hold, or mobility');
  if (!STATUSES.has(record.status)) error(errors, 'INVALID_STATUS', `${location}.status`, 'must be ready, approximate, candidate, or rejected');
  if (record.status !== 'ready' && !text(record.reason)) {
    error(errors, 'MISSING_REASON', `${location}.reason`, 'is required unless the record is ready');
  }
  if (record.status === 'ready' && !text(record.formNotes)) {
    error(errors, 'MISSING_FORM_REVIEW', `${location}.formNotes`, 'ready records require a semantic form review');
  }
}

export function validateCandidateDocument(document) {
  const errors = [];
  if (!object(document)) return { valid: false, errors: [{ code: 'INVALID_DOCUMENT', location: '$', message: 'must be an object' }] };
  if (document.schemaVersion !== 1) error(errors, 'INVALID_SCHEMA_VERSION', '$.schemaVersion', 'must equal 1');
  if (document.kind !== 'approvedCreatorMovementCandidates') {
    error(errors, 'INVALID_KIND', '$.kind', 'must equal approvedCreatorMovementCandidates');
  }
  const creators = Array.isArray(document.creators) ? document.creators : [];
  if (creators.length === 0) error(errors, 'MISSING_CREATORS', '$.creators', 'must contain at least one approved creator');
  creators.forEach((creator, index) => validateCreator(creator, `$.creators[${index}]`, errors));
  const creatorIds = new Set(creators.map((creator) => creator?.id).filter(Boolean));
  if (creatorIds.size !== creators.length) error(errors, 'DUPLICATE_CREATOR', '$.creators', 'creator IDs must be unique');

  const sources = Array.isArray(document.sources) ? document.sources : [];
  if (sources.length === 0) error(errors, 'MISSING_SOURCES', '$.sources', 'must contain retained source videos');
  sources.forEach((source, index) => validateSource(source, `$.sources[${index}]`, errors, creatorIds));
  const sourceMap = new Map(sources.map((source) => [source?.id, source]));
  if (sourceMap.size !== sources.length) error(errors, 'DUPLICATE_SOURCE', '$.sources', 'source IDs must be unique');

  const rawRecords = Array.isArray(document.records) ? document.records : [];
  if (rawRecords.length === 0) error(errors, 'MISSING_RECORDS', '$.records', 'must contain movement ranges or explicit rejections');
  const records = rawRecords.map((record) => canonicalRecord(record, sourceMap));
  records.forEach((record, index) => validateRecord(record, `$.records[${index}]`, errors, sourceMap));
  const recordIds = new Set(records.map((record) => record.id));
  if (recordIds.size !== records.length) error(errors, 'DUPLICATE_RECORD', '$.records', 'record IDs must be unique');
  return { valid: errors.length === 0, errors, records };
}

function creatorRegistry(documents) {
  const found = new Map();
  for (const document of documents) {
    for (const creator of document.creators) {
      const previous = found.get(creator.id);
      if (previous) {
        for (const field of ['name', 'channelId', 'channelUrl']) {
          if (previous[field] && creator[field] && previous[field] !== creator[field]) {
            throw new Error(`Conflicting creator metadata for ${creator.id}: ${field}`);
          }
        }
      }
      found.set(creator.id, { ...structuredClone(previous ?? {}), ...structuredClone(creator) });
    }
  }
  return Object.fromEntries([...found].sort(([left], [right]) => left.localeCompare(right)));
}

function sourceRegistry(documents) {
  const found = new Map();
  for (const document of documents) {
    for (const source of document.sources) {
      const key = `${source.creatorId}::${source.videoId}`;
      const previous = found.get(key);
      if (previous && previous.localPath !== source.localPath) {
        throw new Error(`Conflicting retained paths for ${key}`);
      }
      found.set(key, structuredClone(source));
    }
  }
  return Object.fromEntries([...found].sort(([left], [right]) => left.localeCompare(right)));
}

function coverageMatrix(creators, records) {
  const movementIds = [...new Set(records.map((record) => record.movementId))].sort();
  const creatorIds = Object.keys(creators).sort();
  const movements = {};
  for (const movementId of movementIds) {
    movements[movementId] = {};
    for (const creatorId of creatorIds) {
      const variants = records.filter((record) => record.movementId === movementId && record.creatorId === creatorId);
      if (variants.length === 0) continue;
      const counts = Object.fromEntries([...STATUSES].map((status) => [status, variants.filter((record) => record.status === status).length]));
      movements[movementId][creatorId] = { variants: variants.length, ...counts };
    }
  }
  const creatorCoverage = {};
  for (const creatorId of creatorIds) {
    const variants = records.filter((record) => record.creatorId === creatorId);
    creatorCoverage[creatorId] = {
      sourceRanges: variants.length,
      movements: new Set(variants.map((record) => record.movementId)).size,
      readyMovements: new Set(variants.filter((record) => record.status === 'ready').map((record) => record.movementId)).size,
      readyVariants: variants.filter((record) => record.status === 'ready').length,
    };
  }
  return { schemaVersion: 1, kind: 'creatorMovementMatrix', creators: creatorIds, creatorCoverage, movements };
}

function displayNameForId(movementId) {
  return movementId.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function recordsFromPacks(packs, creators, sources, existingRecords) {
  const sourceByKey = new Map(Object.values(sources).map((source) => [`${source.creatorId}::${source.videoId}`, source]));
  const seen = new Set(existingRecords.filter((record) => record.status === 'ready').map((record) => [
    record.movementId,
    record.creatorId,
    record.source.videoId,
    record.range.startSeconds,
    record.range.endSeconds,
  ].join('::')));
  const imported = [];
  for (const pack of packs) {
    if (!object(pack) || pack.kind !== 'mediaPack' || !object(pack.entries)) throw new Error('Imported mappings must be mediaPack documents');
    for (const [movementId, entry] of Object.entries(pack.entries)) {
      for (const asset of entry?.assets ?? []) {
        if (asset?.type !== 'video' || !creators[asset.creatorId]) continue;
        const source = sourceByKey.get(`${asset.creatorId}::${asset.sourceVideoId}`);
        if (!source) throw new Error(`Approved pack mapping has no retained source: ${asset.creatorId}/${asset.sourceVideoId}`);
        const sourceChapterRange = { startSeconds: asset.sourceStartSeconds, endSeconds: asset.sourceEndSeconds };
        const sourceDuration = sourceChapterRange.endSeconds - sourceChapterRange.startSeconds;
        if (!Number.isFinite(sourceDuration) || sourceDuration < 2) throw new Error(`Approved pack mapping has an invalid source range: ${movementId}/${asset.variantId}`);
        const range = sourceDuration <= 40 ? sourceChapterRange : {
          startSeconds: sourceChapterRange.startSeconds + Math.min(5, (sourceDuration - 40) / 2),
          endSeconds: sourceChapterRange.startSeconds + Math.min(5, (sourceDuration - 40) / 2) + 40,
        };
        const key = [movementId, asset.creatorId, asset.sourceVideoId, range.startSeconds, range.endSeconds].join('::');
        if (seen.has(key)) continue;
        seen.add(key);
        const digest = createHash('sha256').update(key).digest('hex').slice(0, 10);
        imported.push({
          id: `${movementId}-${asset.creatorId}-${digest}`,
          movementId,
          displayName: displayNameForId(movementId),
          aliases: [movementId],
          creatorId: asset.creatorId,
          source: {
            id: source.id,
            videoId: source.videoId,
            url: source.url,
            title: asset.sourceTitle ?? source.title,
            localPath: source.localPath,
            ...(source.channelId ? { channelId: source.channelId } : {}),
          },
          range,
          side: asset.side ?? entry.anatomicalSide ?? 'unspecified',
          equipment: Array.isArray(asset.equipment) && asset.equipment.length > 0 ? asset.equipment : ['bodyweight'],
          viewpoint: 'approved-private-pack',
          framing: 'Existing approved private-pack mapping; the complete performer frame is retained and fitted to landscape.',
          movementKind: 'normal',
          status: 'ready',
          formNotes: `Imported from approved private pack ${pack.id ?? 'unknown'} with creator and source provenance intact.`,
          mocapRange: range,
          importedFromPack: pack.id ?? 'unknown',
          ...(sourceDuration > 40 ? { sourceChapterRange } : {}),
        });
      }
    }
  }
  return imported;
}

export function compileCreatorLibrary(documents, { packs = [] } = {}) {
  if (!Array.isArray(documents) || documents.length === 0) throw new Error('At least one candidate document is required');
  const allRecords = [];
  for (const [index, document] of documents.entries()) {
    const result = validateCandidateDocument(document);
    if (!result.valid) {
      const failure = new Error(`Invalid candidate document ${index}`);
      failure.errors = result.errors;
      throw failure;
    }
    allRecords.push(...result.records);
  }
  const creators = creatorRegistry(documents);
  const sources = sourceRegistry(documents);
  allRecords.push(...recordsFromPacks(packs, creators, sources, allRecords));
  const records = allRecords.sort((left, right) => left.movementId.localeCompare(right.movementId)
    || left.creatorId.localeCompare(right.creatorId)
    || left.source.videoId.localeCompare(right.source.videoId)
    || left.range.startSeconds - right.range.startSeconds);
  const ids = new Set(records.map((record) => record.id));
  if (ids.size !== records.length) throw new Error('Duplicate record IDs across candidate documents');
  const library = {
    schemaVersion: CREATOR_LIBRARY_SCHEMA_VERSION,
    kind: 'creatorMovementLibrary',
    creators,
    sources,
    records,
  };
  return {
    library,
    matrix: coverageMatrix(creators, records),
    readyRecords: records.filter((record) => record.status === 'ready'),
    reviewQueue: records.filter((record) => record.status !== 'ready'),
  };
}

function movementsIn(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) movementsIn(item, found);
  } else if (object(value)) {
    if (text(value.movementId)) {
      found.push({ movementId: value.movementId, displayName: text(value.displayName) ? value.displayName : value.movementId });
    }
    for (const child of Object.values(value)) movementsIn(child, found);
  }
  return found;
}

export function buildRequirementsCoverage(requirements, library) {
  const creatorIds = Object.keys(library.creators).sort();
  const ready = library.records.filter((record) => record.status === 'ready');
  const workouts = {};
  const aggregate = new Map();
  for (const requirement of requirements) {
    const uses = movementsIn(requirement.document);
    const movementIds = [...new Set(uses.map((use) => use.movementId))].sort();
    const id = text(requirement.document.id) ? requirement.document.id : path.basename(requirement.file, '.json');
    workouts[id] = {
      title: text(requirement.document.title) ? requirement.document.title : id,
      sourceFile: requirement.file,
      movements: movementIds.length,
      movementUses: uses.length,
      creators: Object.fromEntries(creatorIds.map((creatorId) => {
        const covered = movementIds.filter((movementId) => ready.some((record) => record.movementId === movementId && record.creatorId === creatorId));
        return [creatorId, { ready: covered.length, total: movementIds.length, missing: movementIds.filter((movementId) => !covered.includes(movementId)) }];
      })),
    };
    for (const use of uses) {
      const value = aggregate.get(use.movementId) ?? { displayNames: new Set(), uses: 0, requiredBy: new Set() };
      value.displayNames.add(use.displayName);
      value.uses += 1;
      value.requiredBy.add(id);
      aggregate.set(use.movementId, value);
    }
  }
  const movements = {};
  for (const [movementId, requirement] of [...aggregate].sort(([left], [right]) => left.localeCompare(right))) {
    const readyCreators = creatorIds.filter((creatorId) => ready.some((record) => record.movementId === movementId && record.creatorId === creatorId));
    movements[movementId] = {
      displayNames: [...requirement.displayNames].sort(),
      uses: requirement.uses,
      requiredBy: [...requirement.requiredBy].sort(),
      readyCreators,
      missingCreators: creatorIds.filter((creatorId) => !readyCreators.includes(creatorId)),
    };
  }
  return {
    schemaVersion: 1,
    kind: 'creatorLibraryRequirementsCoverage',
    workouts,
    movements,
    uncoveredMovementIds: Object.entries(movements).filter(([, movement]) => movement.readyCreators.length === 0).map(([movementId]) => movementId),
  };
}

export async function auditRetainedSources(root, library) {
  const absoluteRoot = path.resolve(root);
  const pending = [absoluteRoot];
  const retained = new Map();
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (caught) {
      throw new Error(`Cannot scan retained media directory ${directory}: ${caught.message}`, { cause: caught });
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.info.json')) continue;
      const info = await readJson(entryPath);
      const channelName = String(info.uploader ?? info.channel ?? '').trim().toLowerCase();
      const creatorId = CREATOR_CHANNEL_NAMES.get(channelName);
      const videoId = String(info.id ?? info.display_id ?? '').trim();
      if (!creatorId || !videoId) continue;
      const key = `${creatorId}::${videoId}`;
      const value = retained.get(key) ?? {
        creatorId,
        videoId,
        title: info.title ?? null,
        url: info.webpage_url ?? `https://www.youtube.com/watch?v=${videoId}`,
        metadataFiles: [],
      };
      value.metadataFiles.push(entryPath);
      retained.set(key, value);
    }
  }
  const libraryKeys = new Set(Object.values(library.sources ?? {}).map((source) => `${source.creatorId}::${source.videoId}`));
  const retainedSources = [...retained].sort(([left], [right]) => left.localeCompare(right)).map(([key, source]) => ({
    ...source,
    metadataFiles: [...source.metadataFiles].sort(),
    accounted: libraryKeys.has(key),
  }));
  const retainedKeys = new Set(retained.keys());
  return {
    schemaVersion: 1,
    kind: 'retainedApprovedCreatorSourceAudit',
    root: absoluteRoot,
    retainedSources,
    totals: {
      retained: retainedSources.length,
      accounted: retainedSources.filter((source) => source.accounted).length,
      missing: retainedSources.filter((source) => !source.accounted).length,
    },
    missingRetainedSources: retainedSources.filter((source) => !source.accounted),
    additionalLibrarySources: Object.values(library.sources ?? {})
      .filter((source) => !retainedKeys.has(`${source.creatorId}::${source.videoId}`))
      .sort((left, right) => left.creatorId.localeCompare(right.creatorId) || left.videoId.localeCompare(right.videoId)),
  };
}

async function discoverJsonInputs(inputs, { candidateFilesOnly = false } = {}) {
  const files = [];
  for (const input of inputs) {
    const absolute = path.resolve(input);
    const pending = [absolute];
    let inputWasFile = false;
    try {
      await readFile(absolute, 'utf8');
      inputWasFile = true;
    } catch {
      // Directories are traversed below; unreadable inputs fail on readdir.
    }
    if (inputWasFile) {
      files.push(absolute);
      continue;
    }
    while (pending.length > 0) {
      const directory = pending.pop();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (caught) {
        throw new Error(`Cannot read input ${directory}: ${caught.message}`, { cause: caught });
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile() && entry.name.endsWith('.json') && (!candidateFilesOnly || entry.name === 'candidates.json')) files.push(entryPath);
      }
    }
  }
  return [...new Set(files)].sort();
}

function argumentsFor(argv) {
  const inputs = [];
  const requirements = [];
  let output = null;
  let verifyFiles = false;
  let retainedRoot = null;
  let requireAllRetained = false;
  const importPacks = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') inputs.push(argv[index += 1]);
    else if (argv[index] === '--requirements') requirements.push(argv[index += 1]);
    else if (argv[index] === '--output') output = argv[index += 1];
    else if (argv[index] === '--verify-files') verifyFiles = true;
    else if (argv[index] === '--retained-root') retainedRoot = argv[index += 1];
    else if (argv[index] === '--require-all-retained') requireAllRetained = true;
    else if (argv[index] === '--import-pack') importPacks.push(argv[index += 1]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (inputs.length === 0 || !output) {
    throw new Error('Usage: creator-library.mjs --input FILE_OR_DIR [--input ...] --output DIRECTORY [--verify-files]');
  }
  if (requireAllRetained && !retainedRoot) throw new Error('--require-all-retained requires --retained-root');
  return { inputs, requirements, output: path.resolve(output), verifyFiles, retainedRoot, requireAllRetained, importPacks };
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const files = await discoverJsonInputs(options.inputs, { candidateFilesOnly: true });
  const documents = [];
  for (const file of files) documents.push(await readJson(file));
  const packs = [];
  for (const file of options.importPacks) packs.push(await readJson(path.resolve(file)));
  const compiled = compileCreatorLibrary(documents, { packs });
  const requirementFiles = await discoverJsonInputs(options.requirements);
  const requirements = [];
  for (const file of requirementFiles) requirements.push({ file, document: await readJson(file) });
  const retainedAudit = options.retainedRoot ? await auditRetainedSources(options.retainedRoot, compiled.library) : null;
  if (options.requireAllRetained && retainedAudit.totals.missing > 0) {
    const missing = retainedAudit.missingRetainedSources.map((source) => `${source.creatorId}/${source.videoId}`);
    throw new Error(`Approved retained sources are missing from the library: ${missing.join(', ')}`);
  }
  if (options.verifyFiles) {
    for (const record of compiled.readyRecords) await access(record.source.localPath);
  }
  await mkdir(options.output, { recursive: true });
  const outputs = {
    'creator-movement-library.json': compiled.library,
    'creator-movement-matrix.json': compiled.matrix,
    'ready-records.json': { schemaVersion: 1, kind: 'readyCreatorMovementRecords', records: compiled.readyRecords },
    'review-queue.json': { schemaVersion: 1, kind: 'creatorMovementReviewQueue', records: compiled.reviewQueue },
    ...(requirements.length > 0 ? { 'requirements-coverage.json': buildRequirementsCoverage(requirements, compiled.library) } : {}),
    ...(retainedAudit ? { 'retained-source-audit.json': retainedAudit } : {}),
  };
  for (const [name, value] of Object.entries(outputs)) {
    await writeFile(path.join(options.output, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    inputFiles: files.length,
    importedPacks: packs.length,
    creators: Object.keys(compiled.library.creators).length,
    sources: Object.keys(compiled.library.sources).length,
    movements: Object.keys(compiled.matrix.movements).length,
    records: compiled.library.records.length,
    readyRecords: compiled.readyRecords.length,
    reviewRecords: compiled.reviewQueue.length,
    requirementFiles: requirements.length,
    ...(retainedAudit ? { retainedSources: retainedAudit.totals } : {}),
    output: options.output,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((caught) => {
    process.stderr.write(`${JSON.stringify({
      error: caught.message,
      ...(Array.isArray(caught.errors) ? { errors: caught.errors } : {}),
    })}\n`);
    process.exitCode = 1;
  });
}
