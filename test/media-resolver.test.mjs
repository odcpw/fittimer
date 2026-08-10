import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectContentUrls, resolveMovementVisual } from '../src/app.mjs';

let pack;
try {
  pack = JSON.parse(await readFile('data/media/gif-v1.json', 'utf8'));
} catch (error) {
  throw new Error('Built-in gif-v1 manifest could not be parsed', { cause: error });
}

const gifVisual = resolveMovementVisual(
  { movementId: 'step-jacks', displayName: 'Step Jacks' },
  pack,
);
assert.equal(gifVisual.kind, 'image');
assert.equal(gifVisual.asset.type, 'gif');
assert.equal(gifVisual.asset.url, 'data/gifs/3224.gif');
assert.equal(gifVisual.framing.fit, 'contain');
assert.equal(gifVisual.mirror, false);

const textOnly = resolveMovementVisual(
  { movementId: 'step-jacks', displayName: 'Text override', textOnly: true },
  pack,
);
assert.equal(textOnly.kind, 'text');
assert.equal(textOnly.reason, 'text-only');

const missing = resolveMovementVisual(
  { movementId: 'not-in-pack', displayName: 'Missing movement' },
  pack,
);
assert.equal(missing.kind, 'text');
assert.equal(missing.reason, 'missing-pack-entry');

const mixedPack = structuredClone(pack);
mixedPack.framingProfiles['poster-frame'] = mixedPack.framingProfiles['full-source-landscape'];
mixedPack.entries['mixed-media'] = {
  anatomicalSide: 'bilateral',
  mirroring: 'never',
  assets: [
    { type: 'gif', url: 'data/gifs/3224.gif', framing: 'full-source-landscape' },
    { type: 'poster', url: 'data/gifs/0260.gif', framing: 'poster-frame' },
  ],
};
const reduced = resolveMovementVisual(
  { movementId: 'mixed-media', displayName: 'Reduced movement' },
  mixedPack,
  { reducedMotion: true },
);
assert.equal(reduced.kind, 'image');
assert.equal(reduced.asset.type, 'poster');

mixedPack.entries['right-sided'] = {
  anatomicalSide: 'left',
  mirroring: 'when-needed',
  assets: [
    { type: 'gif', url: 'data/gifs/3224.gif', framing: 'full-source-landscape' },
  ],
};
assert.equal(
  resolveMovementVisual(
    { movementId: 'right-sided', displayName: 'Right-sided movement' },
    mixedPack,
    { requestedSide: 'right' },
  ).mirror,
  true,
);

const sidePack = {
  entries: {
    unilateral: {
      assets: [
        { type: 'gif', url: 'data/gifs/side-1.gif', side: 'first' },
        { type: 'gif', url: 'data/gifs/generic.gif' },
        { type: 'gif', url: 'data/gifs/side-2.gif', side: 'second' },
      ],
    },
    firstOnly: {
      assets: [{ type: 'gif', url: 'data/gifs/first-only.gif', side: 'first' }],
    },
    secondOnly: {
      assets: [{ type: 'gif', url: 'data/gifs/second-only.gif', side: 'second' }],
    },
    genericOnly: {
      assets: [{ type: 'gif', url: 'data/gifs/generic-only.gif' }],
    },
    leftAssetOnly: {
      anatomicalSide: 'bilateral',
      mirroring: 'when-needed',
      assets: [{ type: 'gif', url: 'data/gifs/left-only.gif', side: 'left' }],
    },
  },
};

const firstSide = resolveMovementVisual(
  { movementId: 'unilateral', displayName: 'First side' },
  sidePack,
  { requestedSide: 'first' },
);
assert.equal(firstSide.asset.side, 'first');

const secondSide = resolveMovementVisual(
  { movementId: 'unilateral', displayName: 'Second side' },
  sidePack,
  { requestedSide: 'second' },
);
assert.equal(secondSide.asset.side, 'second');

const genericSide = resolveMovementVisual(
  { movementId: 'genericOnly', displayName: 'Generic side' },
  sidePack,
  { requestedSide: 'second' },
);
assert.equal(genericSide.asset.url, 'data/gifs/generic-only.gif');

for (const [movementId, requestedSide] of [['firstOnly', 'second'], ['secondOnly', 'first']]) {
  const oppositeSide = resolveMovementVisual(
    { movementId, displayName: 'Opposite side' },
    sidePack,
    { requestedSide },
  );
  assert.equal(oppositeSide.kind, 'text');
  assert.equal(oppositeSide.reason, 'empty-pack-entry');
}

const mirroredAsset = resolveMovementVisual(
  { movementId: 'leftAssetOnly', displayName: 'Mirrored right' },
  sidePack,
  { requestedSide: 'right' },
);
assert.equal(mirroredAsset.asset.side, 'left');
assert.equal(mirroredAsset.mirror, true);

const index = {
  defaultMediaPack: 'gif-v1',
  mediaPacks: {
    'gif-v1': 'data/media/gif-v1.json',
    'private-v1': 'data/media/private-v1.json',
  },
  routines: ['data/routines/installed.json', 'data/routines/not-installed.json'],
  blocks: {
    installed: 'data/blocks/installed.json',
    notInstalled: 'data/blocks/not-installed.json',
  },
};
const urls = new Set(collectContentUrls(index, [{
  file: 'data/routines/installed.json',
  sequence: [{ blockId: 'installed' }],
  intervals: [{ movements: [{ movementId: 'step-jacks' }] }],
}], pack));
assert.deepEqual([...urls].sort(), [
  'data/blocks/installed.json',
  'data/content-index.json',
  'data/gifs/3224.gif',
  'data/media/gif-v1.json',
  'data/routines/installed.json',
].sort());
assert.equal(urls.has('data/gifs/0260.gif'), false);
assert.equal(urls.has('data/media/private-v1.json'), false);
assert.equal(urls.has('data/routines/not-installed.json'), false);

process.stdout.write('Media resolver tests passed: stable selection, fallback, mirroring, and scoped URLs.\n');
