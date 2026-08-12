import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APPROVED_CREATOR_IDS,
  chooseRoutineMediaPackId,
  chooseRoutineCreatorId,
  collectContentUrls,
  creatorCoverageForRoutine,
  mergePrivateMediaPackIndex,
  normalizePrivateMediaPackIndex,
  resolveMovementVisual,
  selectMediaPack,
} from '../src/app.mjs';
import { createPrivateServer } from '../scripts/private-server.mjs';

async function makeServerFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'fittimer-app-'));
  const privatePackRoot = await mkdtemp(path.join(tmpdir(), 'fittimer-private-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'data', 'routines'), { recursive: true });
  await mkdir(path.join(privatePackRoot, 'w1w4-v1'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html>');
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const ok = true;');
  await writeFile(path.join(root, 'data', 'content-index.json'), '{}');
  await writeFile(path.join(root, 'data', 'exercises.json'), 'private catalog');
  await writeFile(path.join(root, 'data', 'routines', 'one.json'), '{}');
  await writeFile(path.join(root, 'docs.md'), 'private docs');
  await writeFile(path.join(privatePackRoot, 'index.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'privateMediaPackIndex',
    mediaPacks: { 'w1w4-v1': 'w1w4-v1/media-pack.json' },
  }));
  await writeFile(path.join(privatePackRoot, 'w1w4-v1', 'media-pack.json'), '{}');
  await writeFile(path.join(privatePackRoot, 'w1w4-v1', 'clip.mp4'), Buffer.from('0123456789'));
  return { root, privatePackRoot };
}

test('private localhost server allowlists app paths, serves HEAD/MIME, and supports video ranges', async () => {
  const fixture = await makeServerFixture();
  const app = createPrivateServer({ ...fixture, port: 0 });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const index = await fetch(`${base}/index.html`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /^text\/html/);

    const rootIndex = await fetch(`${base}/`);
    assert.equal(rootIndex.status, 200);
    assert.equal(await rootIndex.text(), '<!doctype html>');

    const moduleHead = await fetch(`${base}/src/app.mjs`, { method: 'HEAD' });
    assert.equal(moduleHead.status, 200);
    assert.match(moduleHead.headers.get('content-type'), /^text\/javascript/);
    assert.equal(moduleHead.headers.get('content-length'), String(Buffer.byteLength('export const ok = true;')));
    assert.equal(await moduleHead.text(), '');

    assert.equal((await fetch(`${base}/docs.md`)).status, 404);
    assert.equal((await fetch(`${base}/.git/config`)).status, 404);
    assert.equal((await fetch(`${base}/data/content-index.json`)).status, 200);
    assert.equal((await fetch(`${base}/data/exercises.json`)).status, 404);
    assert.equal((await fetch(`${base}/private-packs/nope.txt`)).status, 404);
    assert.equal((await fetch(`${base}/private-packs/index.json`)).status, 200);

    const full = await fetch(`${base}/private-packs/w1w4-v1/clip.mp4`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(await full.text(), '0123456789');

    const range = await fetch(`${base}/private-packs/w1w4-v1/clip.mp4`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await range.text(), '2345');

    const suffix = await fetch(`${base}/private-packs/w1w4-v1/clip.mp4`, { headers: { Range: 'bytes=-3' } });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), '789');

    const invalidRange = await fetch(`${base}/private-packs/w1w4-v1/clip.mp4`, { headers: { Range: 'bytes=50-60' } });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get('content-range'), 'bytes */10');

    const traversal = await fetch(`${base}/private-packs/%252e%252e/%252e%252e/etc/passwd`);
    assert.equal(traversal.status, 404);
  } finally {
    await app.close();
    await Promise.all([rm(fixture.root, { recursive: true, force: true }), rm(fixture.privatePackRoot, { recursive: true, force: true })]);
  }
});

test('private media index accepts only relative pack paths and merges without absolute paths', () => {
  const normalized = normalizePrivateMediaPackIndex({
    schemaVersion: 1,
    kind: 'privateMediaPackIndex',
    mediaPacks: {
      'w1w4-v1': 'w1w4-v1/media-pack.json',
      'reference-v1': 'reference-v1/media-pack.json',
      badAbsolute: '/home/oliver/private/media-pack.json',
      badTraversal: '../secrets.json',
      badProtocol: 'https://example.test/media-pack.json',
    },
  });
  assert.deepEqual(normalized.mediaPacks, {
    'w1w4-v1': 'private-packs/w1w4-v1/media-pack.json',
    'reference-v1': 'private-packs/reference-v1/media-pack.json',
  });
  assert.doesNotMatch(JSON.stringify(normalized), /home\/oliver|https:/);

  const merged = mergePrivateMediaPackIndex({
    schemaVersion: 2,
    defaultMediaPack: 'gif-v1',
    mediaPacks: { 'gif-v1': 'data/media/gif-v1.json' },
  }, normalized);
  assert.equal(merged.mediaPacks['w1w4-v1'], 'private-packs/w1w4-v1/media-pack.json');
  assert.equal(merged.privateMediaPackIndexPath, 'private-packs/index.json');
});

test('selected private packs never mix in reference or GIF fallback assets', () => {
  const framing = { fit: 'contain', position: 'center' };
  const packs = new Map([
    ['gif-v1', {
      id: 'gif-v1',
      kind: 'mediaPack',
      framingProfiles: { full: framing },
      entries: {
        gifFallback: { assets: [{ type: 'gif', url: 'data/gifs/fallback.gif', framing: 'full' }] },
      },
    }],
    ['reference-v1', {
      id: 'reference-v1',
      kind: 'mediaPack',
      __sourcePath: 'private-packs/reference-v1/media-pack.json',
      creators: { growingannanas: { selectable: true, name: 'Growingannanas' } },
      framingProfiles: { full: framing },
      entries: {
        referenceFallback: { assets: [{ type: 'video', url: 'clips/reference.mp4', framing: 'full', creatorId: 'growingannanas' }] },
      },
    }],
    ['w1w4-v1', {
      id: 'w1w4-v1',
      kind: 'mediaPack',
      __sourcePath: 'private-packs/w1w4-v1/media-pack.json',
      creators: { growingannanas: { selectable: true, name: 'Growingannanas' } },
      framingProfiles: { full: framing },
      entries: {
        w1w4Primary: { assets: [{ type: 'video', url: 'clips/primary.mp4', framing: 'full', creatorId: 'growingannanas' }] },
      },
    }],
  ]);
  const selected = selectMediaPack('w1w4-v1', packs);
  assert.equal(selected.id, 'w1w4-v1');
  assert.ok(selected.entries.w1w4Primary);
  assert.equal(selected.entries.referenceFallback, undefined);
  assert.equal(selected.entries.gifFallback, undefined);
  assert.equal(resolveMovementVisual({ movementId: 'referenceFallback', displayName: 'Reference' }, selected).kind, 'text');
  assert.equal(resolveMovementVisual({ movementId: 'gifFallback', displayName: 'GIF' }, selected).kind, 'text');

  assert.equal(chooseRoutineMediaPackId({
    id: 'madfit-30min-hiit',
    intervals: [{ movements: [{ movementId: 'referenceFallback' }] }],
  }, packs), 'reference-v1');
  assert.equal(chooseRoutineMediaPackId({
    id: 'iron-roots',
    intervals: [{ movements: [
      { movementId: 'w1w4Primary' },
      { movementId: 'referenceFallback' },
    ] }],
  }, packs), 'w1w4-v1');

  const urls = collectContentUrls({
    defaultMediaPack: 'gif-v1',
    privateMediaPackIndexPath: 'private-packs/index.json',
    mediaPacks: {
      'gif-v1': 'data/media/gif-v1.json',
      'reference-v1': 'private-packs/reference-v1/media-pack.json',
      'w1w4-v1': 'private-packs/w1w4-v1/media-pack.json',
    },
  }, [{
    file: 'data/routines/private.json',
    sequence: [],
    intervals: [{ movements: [
      { movementId: 'w1w4Primary' },
      { movementId: 'referenceFallback' },
      { movementId: 'gifFallback' },
    ] }],
  }], selected);
  assert.ok(urls.includes('private-packs/index.json'));
  assert.ok(urls.includes('private-packs/w1w4-v1/media-pack.json'));
  assert.ok(urls.includes('private-packs/w1w4-v1/clips/primary.mp4'));
  assert.ok(!urls.includes('private-packs/reference-v1/media-pack.json'));
  assert.ok(!urls.includes('private-packs/reference-v1/clips/reference.mp4'));
  assert.ok(!urls.includes('data/media/gif-v1.json'));
  assert.ok(!urls.includes('data/gifs/fallback.gif'));
});

test('v3 creator runtime picks one approved automatic winner and caches only that creator', () => {
  assert.deepEqual(new Set(APPROVED_CREATOR_IDS), new Set([
    'madfit',
    'growingannanas',
    'caroline-girvan',
    'sydney-cummings',
    'heather-robertson',
    'pamela-reif',
  ]));

  const creators = Object.fromEntries(APPROVED_CREATOR_IDS.map((id) => [id, {
    id,
    name: id,
    selectable: true,
  }]));
  const pack = {
    id: 'creator-library-v1',
    kind: 'mediaPack',
    __sourcePath: 'private-packs/creator-library-v1/pack/media-pack.json',
    creators,
    outputFrame: { orientation: 'landscape', width: 16, height: 9 },
    entries: {
      alpha: {
        assets: [
          { type: 'video', url: 'clips/madfit-alpha.mp4', creatorId: 'madfit' },
          { type: 'video', url: 'clips/growing-alpha.mp4', creatorId: 'growingannanas' },
          { type: 'video', url: 'clips/rejected-alpha.mp4', creatorId: 'rejected-source' },
        ],
      },
      beta: {
        assets: [
          { type: 'video', url: 'clips/growing-beta.mp4', creatorId: 'growingannanas' },
          { type: 'video', url: 'clips/heather-beta.mp4', creatorId: 'heather-robertson' },
        ],
      },
      cueOnly: {
        assets: [{ type: 'video', url: 'clips/must-not-play.mp4', creatorId: 'growingannanas' }],
      },
    },
  };
  const routine = {
    id: 'iron-roots',
    file: 'data/routines/iron-roots.json',
    sequence: [],
    intervals: [{ movements: [
      { movementId: 'alpha' },
      { movementId: 'beta' },
      { movementId: 'cueOnly', textOnly: true },
    ] }],
  };

  assert.equal(chooseRoutineCreatorId(routine, pack), 'growingannanas');
  assert.equal(chooseRoutineCreatorId({ ...routine, id: 'madfit-30min-hiit' }, pack), 'madfit');
  assert.deepEqual(creatorCoverageForRoutine(routine, pack, 'growingannanas'), {
    covered: 2,
    total: 2,
    textOnly: 1,
  });
  assert.equal(resolveMovementVisual(
    { movementId: 'alpha', displayName: 'Alpha' },
    pack,
    { creatorId: 'growingannanas' },
  ).asset.creatorId, 'growingannanas');
  const textOnly = resolveMovementVisual(
    { movementId: 'cueOnly', displayName: 'Cue only', textOnly: true },
    pack,
    { creatorId: 'growingannanas' },
  );
  assert.equal(textOnly.kind, 'text');
  assert.equal(textOnly.videoNeeded, false);

  const selected = selectMediaPack('creator-library-v1', new Map([['creator-library-v1', pack]]));
  const urls = collectContentUrls({
    mediaPacks: { 'creator-library-v1': 'private-packs/creator-library-v1/pack/media-pack.json' },
    privateMediaPackIndexPath: 'private-packs/index.json',
    blocks: {},
  }, [routine], selected, null);
  assert.ok(urls.includes('private-packs/creator-library-v1/pack/clips/growing-alpha.mp4'));
  assert.ok(urls.includes('private-packs/creator-library-v1/pack/clips/growing-beta.mp4'));
  assert.ok(!urls.some((url) => url.includes('madfit-alpha') || url.includes('heather-beta') || url.includes('rejected-alpha')));
  assert.ok(!urls.includes('private-packs/creator-library-v1/pack/clips/must-not-play.mp4'));
});
