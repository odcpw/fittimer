#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFiles } from './validate.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'schema');
const EXPECTED_CODES = new Map([
  ['invalid-side.json', 'INVALID_ENUM'],
  ['missing-gif.json', 'GIF_NOT_FOUND'],
  ['nonpositive-seconds.json', 'INVALID_POSITIVE_INTEGER'],
  ['unknown-block.json', 'UNKNOWN_BLOCK'],
]);

const realResult = await validateFiles(['data/routines/madfit-30min-hiit.json']);
assert.equal(realResult.valid, true, JSON.stringify(realResult.errors, null, 2));

const fixtureFiles = (await readdir(FIXTURES_DIR)).filter((name) => name.endsWith('.json')).sort();
const fixtures = fixtureFiles.filter((name) => name !== 'valid-shared-block.json');
assert.deepEqual(fixtures, [...EXPECTED_CODES.keys()].sort(), 'invalid fixture set changed without test expectations');

const reuseResult = await validateFiles(['test/fixtures/schema/valid-shared-block.json']);
assert.equal(reuseResult.valid, true, JSON.stringify(reuseResult.errors, null, 2));

for (const fixture of fixtures) {
  const relative = path.relative(REPO_ROOT, path.join(FIXTURES_DIR, fixture));
  const result = await validateFiles([relative]);
  assert.equal(result.valid, false, `${fixture} unexpectedly passed validation`);
  assert.ok(
    result.errors.some((error) => error.code === EXPECTED_CODES.get(fixture)),
    `${fixture} did not produce ${EXPECTED_CODES.get(fixture)}: ${JSON.stringify(result.errors)}`,
  );
}

process.stdout.write(
  `Validator tests passed: 1 production routine, 1 shared-block routine, ` +
    `${fixtures.length} invalid fixtures.\n`,
);
