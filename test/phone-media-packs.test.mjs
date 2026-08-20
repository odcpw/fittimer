import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHONE_PROFILE_ID,
  buildPhoneMediaPack,
  collectPackAssets,
} from '../scripts/media/phone-media-packs.mjs';

const sourcePack = {
  schemaVersion: 1,
  kind: 'mediaPack',
  id: 'test-pack',
  title: 'Test pack',
  entries: {
    squat: {
      assets: [
        { type: 'video', url: 'clips/squat.mp4', creatorId: 'madfit' },
        { type: 'poster', url: 'posters/squat.png', creatorId: 'madfit' },
      ],
    },
    duplicate: {
      assets: [{ type: 'video', url: 'clips/squat.mp4', creatorId: 'madfit' }],
    },
  },
};

test('phone pack retains source identity and records non-destructive delivery metadata', () => {
  const phone = buildPhoneMediaPack(sourcePack, { sourcePackPath: 'test-pack/media-pack.json' });
  assert.equal(phone.id, sourcePack.id);
  assert.deepEqual(phone.entries, sourcePack.entries);
  assert.deepEqual(phone.deliveryProfile, {
    id: PHONE_PROFILE_ID,
    width: 854,
    height: 480,
    videoCodec: 'h264',
    audio: 'none',
    fit: 'contain',
    sourcePackPath: 'test-pack/media-pack.json',
    originalsRetained: true,
  });
  assert.equal(sourcePack.deliveryProfile, undefined);
});

test('pack assets are deduplicated without changing their relative paths', () => {
  assert.deepEqual(collectPackAssets(sourcePack), [
    { type: 'video', url: 'clips/squat.mp4' },
    { type: 'poster', url: 'posters/squat.png' },
  ]);
});

test('unsafe paths and conflicting asset types are rejected', () => {
  assert.throws(() => collectPackAssets({ entries: { bad: { assets: [{ type: 'video', url: '../source.mp4' }] } } }), /escapes/);
  assert.throws(() => collectPackAssets({ entries: { bad: { assets: [
    { type: 'video', url: 'asset.bin' },
    { type: 'poster', url: 'asset.bin' },
  ] } } }), /conflicting types/);
});
