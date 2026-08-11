import test from 'node:test';
import assert from 'node:assert/strict';

import { movementInventory, validateClipSourceMap } from '../scripts/media/source-map.mjs';

const TARGETS = [
  'data/blocks/iron-roots.json',
  'data/blocks/silk-coils.json',
  'data/blocks/dragon-longform.json',
  'data/blocks/crane-longform.json',
];

function rect() {
  return { x: 0, y: 0, width: 1, height: 1 };
}

function mapWith(records) {
  return {
    schemaVersion: 1,
    kind: 'clipSourceMap',
    id: 'w1w4-v1',
    localOnly: true,
    targetBlockFiles: TARGETS,
    outputContract: {
      aspectRatio: '16:9',
      orientation: 'landscape',
      normalRepRange: [2, 5],
      fullMotionPath: true,
    },
    records,
  };
}

function exactRecord(movementId) {
  return {
    movementId,
    aliases: ['Example movement'],
    requirements: { sides: ['bilateral'], equipment: ['bodyweight'], form: 'Exact primitive without support.' },
    resolution: 'exact',
    candidates: [{
      source: {
        channel: 'Example Trainer',
        title: 'Example workout',
        videoId: 'abc123',
        url: 'https://www.youtube.com/watch?v=abc123',
        localOnly: true,
        dimensions: { width: 1280, height: 720 },
      },
      side: 'bilateral',
      mirroring: 'never',
      equipment: ['bodyweight'],
      viewpoint: 'front-wide',
      range: { startSeconds: 10, endSeconds: 18 },
      crop: rect(),
      safeFrame: { hands: rect(), feet: rect(), equipment: rect(), movementPath: rect() },
      loop: { kind: 'reps', reps: 3, phaseMatch: true, startPhase: 'neutral', endPhase: 'neutral' },
      form: { quality: 'high', notes: 'Normal-speed review confirms the exact movement.' },
      verification: { status: 'verified-normal-speed', notes: 'Reviewed at 1x and at the seam.' },
    }],
  };
}

test('W1-W4 inventory has 71 stable movement IDs after push-up identity split', async () => {
  const inventory = await movementInventory(TARGETS);
  assert.equal(inventory.length, 71);
  assert.deepEqual(
    inventory.filter(({ movementId }) => movementId.includes('push-up')).map(({ movementId }) => movementId),
    ['one-and-a-half-rep-push-up', 'push-up-plus', 'push-ups', 'slow-push-up'],
  );
});

test('source map enforces exact candidate evidence and readiness separately', () => {
  const exact = exactRecord('example-movement');
  const ready = validateClipSourceMap(mapWith([exact]), { requiredMovementIds: ['example-movement'], requireReady: true });
  assert.equal(ready.valid, true, JSON.stringify(ready.errors));
  assert.equal(ready.ready, true);

  const pendingRecord = {
    movementId: 'pending-movement',
    aliases: ['Pending movement'],
    requirements: { sides: ['left', 'right'], equipment: ['bodyweight'], form: 'Exact left/right mechanics.' },
    resolution: 'search-required',
    deliberate: { reason: 'No retained exact candidate has passed review.' },
  };
  const partial = validateClipSourceMap(mapWith([exact, pendingRecord]), {
    requiredMovementIds: ['example-movement', 'pending-movement'],
  });
  assert.equal(partial.valid, true, JSON.stringify(partial.errors));
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.pending, ['pending-movement']);

  const strict = validateClipSourceMap(mapWith([exact, pendingRecord]), {
    requiredMovementIds: ['example-movement', 'pending-movement'],
    requireReady: true,
  });
  assert.equal(strict.valid, false);
  assert.ok(strict.errors.some(({ code }) => code === 'SOURCE_MAP_NOT_READY'));
});

test('source map rejects stale IDs, unsafe ranges, and unverified candidates', () => {
  const invalid = exactRecord('stale-movement');
  invalid.candidates[0].range.endSeconds = invalid.candidates[0].range.startSeconds;
  invalid.candidates[0].verification.status = 'frame-sampled-only';
  const result = validateClipSourceMap(mapWith([invalid]), { requiredMovementIds: ['wanted-movement'] });
  assert.equal(result.valid, false);
  for (const code of ['INVALID_RANGE', 'UNVERIFIED_CANDIDATE', 'UNCOVERED_MOVEMENT_ID', 'STALE_MOVEMENT_ID']) {
    assert.ok(result.errors.some((entry) => entry.code === code), `${code}: ${JSON.stringify(result.errors)}`);
  }
});

test('source map rejects distorted pixel crops and safe regions outside the crop', () => {
  const invalid = exactRecord('example-movement');
  invalid.candidates[0].crop = { x: 0.04, y: 0.04, width: 0.92, height: 0.92 };
  invalid.candidates[0].safeFrame.hands = { x: 0, y: 0, width: 0.1, height: 0.1 };
  const result = validateClipSourceMap(mapWith([invalid]), { requiredMovementIds: ['example-movement'] });
  assert.equal(result.valid, false);
  for (const code of ['NON_16_9_PIXEL_CROP', 'UNSAFE_REGION_OUTSIDE_CROP']) {
    assert.ok(result.errors.some((entry) => entry.code === code), `${code}: ${JSON.stringify(result.errors)}`);
  }
});
