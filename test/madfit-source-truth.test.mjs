import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { validateFiles } from '../scripts/validate.mjs';
import { resolveMovementVisual } from '../src/app.mjs';

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse source-truth fixture ${file}`, { cause: error });
  }
}

test('MadFit final strength intervals match the observed source movement', async () => {
  const blockFile = 'data/blocks/madfit-30min-hiit.json';
  const routineFile = 'data/routines/madfit-30min-hiit.json';
  const block = await readJson(blockFile);
  const mediaPack = await readJson('data/media/gif-v1.json');
  const compoundId = 'one-arm-dumbbell-reverse-lunge-overhead-drive';
  const [first, second, final] = block.intervals.slice(-3);

  assert.equal(first.displayName, 'One-Arm Dumbbell Reverse Lunge + Overhead Drive (side 1)');
  assert.equal(second.displayName, 'One-Arm Dumbbell Reverse Lunge + Overhead Drive (side 2)');
  assert.equal(first.side, 'first');
  assert.equal(second.side, 'second');
  assert.deepEqual(first.movements.map(({ movementId }) => movementId), [compoundId]);
  assert.deepEqual(second.movements.map(({ movementId }) => movementId), [compoundId]);
  assert.ok(first.movements.every(({ exerciseId }) => exerciseId === undefined));
  assert.ok(second.movements.every(({ exerciseId }) => exerciseId === undefined));

  assert.deepEqual(mediaPack.entries[compoundId].assets, []);
  assert.equal(mediaPack.entries[compoundId].fallback, 'text');
  const builtInFallback = resolveMovementVisual(first.movements[0], mediaPack, {
    requestedSide: first.side,
  });
  assert.equal(builtInFallback.kind, 'text');
  assert.equal(builtInFallback.reason, 'empty-pack-entry');
  assert.equal(final.displayName, 'Push-ups (final minute)');
  assert.equal(final.movements[0].movementId, 'push-ups');

  const result = await validateFiles([routineFile]);
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
});
