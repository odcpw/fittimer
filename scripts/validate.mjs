#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKS_DIR = path.join(REPO_ROOT, 'data', 'blocks');
const ROUTINES_DIR = path.join(REPO_ROOT, 'data', 'routines');
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SIDE_VALUES = new Set(['left', 'right', 'alternating', 'bilateral', 'first', 'second']);
const MATCH_VALUES = new Set(['exact', 'close', 'combo', 'loose', 'none']);

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

function checkObject(value, allowedKeys, location, errors) {
  if (!isObject(value)) {
    fail(errors, 'EXPECTED_OBJECT', location, 'must be an object');
    return false;
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(errors, 'UNKNOWN_FIELD', `${location}.${key}`, 'is not part of schemaVersion 1');
    }
  }
  return true;
}

function checkString(value, location, errors, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') {
    fail(errors, 'INVALID_STRING', location, 'must be a non-empty string');
  }
}

function checkStringArray(value, location, errors, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    fail(errors, 'INVALID_STRING_ARRAY', location, 'must be a non-empty array of strings');
    return;
  }
  value.forEach((item, index) => checkString(item, `${location}[${index}]`, errors));
}

function checkPositiveInteger(value, location, errors) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(errors, 'INVALID_POSITIVE_INTEGER', location, 'must be a positive integer');
  }
}

function checkId(value, location, errors) {
  checkString(value, location, errors);
  if (typeof value === 'string' && !ID_PATTERN.test(value)) {
    fail(errors, 'INVALID_ID', location, 'must be a lowercase kebab-case identifier');
  }
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

async function validateMovement(movement, location, errors) {
  const allowed = new Set(['exerciseId', 'displayName', 'gif', 'textOnly']);
  if (!checkObject(movement, allowed, location, errors)) return;

  checkString(movement.displayName, `${location}.displayName`, errors);
  checkString(movement.exerciseId, `${location}.exerciseId`, errors, { optional: true });

  if (movement.textOnly !== undefined && movement.textOnly !== true) {
    fail(errors, 'INVALID_TEXT_ONLY', `${location}.textOnly`, 'may only be omitted or set to true');
  }

  if (movement.textOnly === true) {
    if (movement.gif !== undefined) {
      fail(errors, 'TEXT_ONLY_WITH_GIF', `${location}.gif`, 'must be omitted when textOnly is true');
    }
    return;
  }

  checkString(movement.gif, `${location}.gif`, errors);
  if (typeof movement.gif !== 'string' || movement.gif.trim() === '') return;

  const normalized = path.posix.normalize(movement.gif);
  if (normalized !== movement.gif || !normalized.startsWith('data/gifs/')) {
    fail(errors, 'INVALID_GIF_PATH', `${location}.gif`, 'must be a normalized repo-relative data/gifs/ path');
    return;
  }
  if (!(await pathIsFile(normalized))) {
    fail(errors, 'GIF_NOT_FOUND', `${location}.gif`, `does not reference a file: ${normalized}`);
  }
}

async function validateInterval(interval, location, errors) {
  const allowed = new Set([
    'displayName',
    'workSeconds',
    'restSeconds',
    'side',
    'coachNote',
    'match',
    'movements',
  ]);
  if (!checkObject(interval, allowed, location, errors)) return 0;

  checkString(interval.displayName, `${location}.displayName`, errors);
  checkPositiveInteger(interval.workSeconds, `${location}.workSeconds`, errors);
  checkPositiveInteger(interval.restSeconds, `${location}.restSeconds`, errors);
  checkString(interval.coachNote, `${location}.coachNote`, errors, { optional: true });

  if (interval.side !== undefined && !SIDE_VALUES.has(interval.side)) {
    fail(
      errors,
      'INVALID_ENUM',
      `${location}.side`,
      `must be one of: ${[...SIDE_VALUES].join(', ')}`,
    );
  }
  if (interval.match !== undefined && !MATCH_VALUES.has(interval.match)) {
    fail(
      errors,
      'INVALID_ENUM',
      `${location}.match`,
      `must be one of: ${[...MATCH_VALUES].join(', ')}`,
    );
  }

  if (!Array.isArray(interval.movements) || interval.movements.length === 0) {
    fail(errors, 'INVALID_MOVEMENTS', `${location}.movements`, 'must be a non-empty array');
  } else {
    await Promise.all(
      interval.movements.map((movement, index) =>
        validateMovement(movement, `${location}.movements[${index}]`, errors),
      ),
    );
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

async function validateBlock(block, file, errors) {
  const location = file;
  const allowed = new Set(['schemaVersion', 'kind', 'id', 'title', 'description', 'intervals']);
  if (!checkObject(block, allowed, location, errors)) return null;

  if (block.schemaVersion !== 1) {
    fail(errors, 'UNSUPPORTED_SCHEMA', `${location}.schemaVersion`, 'must equal 1');
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
      );
    }
  }

  return { id: block.id, file, intervalCount: block.intervals?.length ?? 0, durationSeconds };
}

function validateSource(source, location, errors) {
  const allowed = new Set(['channel', 'videoId', 'url']);
  if (!checkObject(source, allowed, location, errors)) return;
  checkString(source.channel, `${location}.channel`, errors, { optional: true });
  checkString(source.videoId, `${location}.videoId`, errors, { optional: true });
  checkString(source.url, `${location}.url`, errors, { optional: true });
  if (Object.keys(source).length === 0) {
    fail(errors, 'EMPTY_SOURCE', location, 'must contain at least one source field');
  }
}

async function validateRoutine(routine, file, blocks, errors) {
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
    'sequence',
  ]);
  if (!checkObject(routine, allowed, location, errors)) return null;

  if (routine.schemaVersion !== 1) {
    fail(errors, 'UNSUPPORTED_SCHEMA', `${location}.schemaVersion`, 'must equal 1');
  }
  if (routine.kind !== 'routine') {
    fail(errors, 'INVALID_KIND', `${location}.kind`, 'must equal "routine"');
  }
  checkId(routine.id, `${location}.id`, errors);
  checkString(routine.title, `${location}.title`, errors);
  checkString(routine.description, `${location}.description`, errors, { optional: true });
  checkStringArray(routine.equipment, `${location}.equipment`, errors);
  checkPositiveInteger(
    routine.estimatedDurationSeconds,
    `${location}.estimatedDurationSeconds`,
    errors,
  );
  if (routine.source !== undefined) validateSource(routine.source, `${location}.source`, errors);
  checkStringArray(routine.notes, `${location}.notes`, errors, { optional: true });

  let durationSeconds = 0;
  let intervalCount = 0;
  if (!Array.isArray(routine.sequence) || routine.sequence.length === 0) {
    fail(errors, 'INVALID_SEQUENCE', `${location}.sequence`, 'must be a non-empty array');
  } else {
    for (let index = 0; index < routine.sequence.length; index += 1) {
      const item = routine.sequence[index];
      const itemLocation = `${location}.sequence[${index}]`;
      if (!checkObject(item, new Set(['blockId', 'interval']), itemLocation, errors)) continue;
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
      } else {
        durationSeconds += await validateInterval(item.interval, `${itemLocation}.interval`, errors);
        intervalCount += 1;
      }
    }
  }

  if (
    Number.isInteger(routine.estimatedDurationSeconds) &&
    routine.estimatedDurationSeconds !== durationSeconds
  ) {
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

export async function validateFiles(requestedFiles) {
  const errors = [];
  const blockFiles = await jsonFiles(BLOCKS_DIR);
  const blocks = new Map();
  const blockSummaries = [];

  for (const absoluteFile of blockFiles) {
    const file = repoRelative(absoluteFile);
    try {
      const summary = await validateBlock(await readJson(file), file, errors);
      if (!summary || typeof summary.id !== 'string') continue;
      if (blocks.has(summary.id)) {
        fail(errors, 'DUPLICATE_BLOCK_ID', `${file}.id`, `duplicates block id ${summary.id}`);
      } else {
        blocks.set(summary.id, summary);
        blockSummaries.push(summary);
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
      const summary = await validateRoutine(await readJson(file), file, blocks, errors);
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

  return {
    schemaVersion: 1,
    valid: errors.length === 0,
    blocks: blockSummaries,
    routines: routineSummaries,
    errors: errors.map(({ code, location, message }) => ({ code, location, message })),
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
        `${intervalCount} expanded interval(s).\n`,
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
