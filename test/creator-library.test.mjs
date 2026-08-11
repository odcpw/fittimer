import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  APPROVED_CREATORS,
  auditRetainedSources,
  buildRequirementsCoverage,
  compileCreatorLibrary,
  validateCandidateDocument,
} from '../scripts/media/creator-library.mjs';

function documentFor({ creatorId = 'growingannanas', creatorName = 'Growingannanas', videoId = 'video-one' } = {}) {
  return {
    schemaVersion: 1,
    kind: 'approvedCreatorMovementCandidates',
    creators: [{ id: creatorId, name: creatorName, channelId: `channel-${creatorId}` }],
    sources: [{
      id: `${creatorId}-${videoId}`,
      creatorId,
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: 'Retained workout source',
      localPath: `/home/oliver/Projects/fittimer-media-research/${creatorId}/${videoId}.mp4`,
      width: 1280,
      height: 720,
    }],
    records: [{
      movementId: 'bodyweight-squat',
      displayName: 'Bodyweight squat',
      aliases: ['Squat'],
      creatorId,
      sourceId: `${creatorId}-${videoId}`,
      startSeconds: 10,
      endSeconds: 35,
      side: 'bilateral',
      equipment: ['bodyweight'],
      viewpoint: 'front-wide',
      framing: 'Full body, hands, feet, and floor contacts remain visible.',
      movementKind: 'normal',
      status: 'ready',
      formNotes: 'Reviewed at normal speed; this is a plain squat without a compound add-on.',
      mocapRange: { startSeconds: 12, endSeconds: 30 },
    }],
  };
}

test('approved roster is the deliberate six-creator set', () => {
  assert.deepEqual(Object.keys(APPROVED_CREATORS).sort(), [
    'caroline-girvan',
    'growingannanas',
    'heather-robertson',
    'madfit',
    'pamela-reif',
    'sydney-cummings',
  ]);
  assert.throws(() => compileCreatorLibrary([]), /At least one candidate document/);
});

test('candidate documents normalize inline ranges and preserve source provenance', () => {
  const document = documentFor();
  const result = validateCandidateDocument(document);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.records[0].creatorId, 'growingannanas');
  assert.equal(result.records[0].source.videoId, 'video-one');
  assert.deepEqual(result.records[0].range, { startSeconds: 10, endSeconds: 35 });
  assert.deepEqual(result.records[0].mocapRange, { startSeconds: 12, endSeconds: 30 });
  assert.match(result.records[0].id, /^bodyweight-squat-growingannanas-[a-f0-9]{10}$/);
});

test('compiler preserves creator variants instead of collapsing a movement to one clip', () => {
  const growing = documentFor();
  growing.records.push({
    ...structuredClone(growing.records[0]),
    sourceId: growing.sources[0].id,
    startSeconds: 40,
    endSeconds: 65,
    mocapRange: { startSeconds: 42, endSeconds: 60 },
  });
  const caroline = documentFor({ creatorId: 'caroline-girvan', creatorName: 'Caroline Girvan', videoId: 'video-two' });
  const compiled = compileCreatorLibrary([growing, caroline]);
  assert.equal(compiled.library.records.length, 3);
  assert.equal(compiled.readyRecords.length, 3);
  assert.deepEqual(compiled.matrix.movements['bodyweight-squat'].growingannanas, {
    variants: 2,
    ready: 2,
    approximate: 0,
    candidate: 0,
    rejected: 0,
  });
  assert.equal(compiled.matrix.creatorCoverage['caroline-girvan'].readyMovements, 1);
});

test('requirements coverage reports missing moves and honest one-creator workout totals', () => {
  const growing = documentFor();
  const caroline = documentFor({ creatorId: 'caroline-girvan', creatorName: 'Caroline Girvan', videoId: 'video-two' });
  caroline.records[0].movementId = 'reverse-lunge';
  caroline.records[0].displayName = 'Reverse lunge';
  const compiled = compileCreatorLibrary([growing, caroline]);
  const coverage = buildRequirementsCoverage([{
    file: '/private/example-workout.json',
    document: {
      id: 'example-workout',
      title: 'Example Workout',
      intervals: [
        { movements: [{ movementId: 'bodyweight-squat', displayName: 'Squat' }] },
        { movements: [{ movementId: 'bodyweight-squat', displayName: 'Squat' }] },
        { movements: [{ movementId: 'reverse-lunge', displayName: 'Lunge' }] },
        { movements: [{ movementId: 'missing-move', displayName: 'Missing move' }] },
      ],
    },
  }], compiled.library);
  assert.deepEqual(coverage.uncoveredMovementIds, ['missing-move']);
  assert.equal(coverage.movements['bodyweight-squat'].uses, 2);
  assert.deepEqual(coverage.movements['bodyweight-squat'].readyCreators, ['growingannanas']);
  assert.deepEqual(coverage.workouts['example-workout'].creators.growingannanas, {
    ready: 1,
    total: 3,
    missing: ['missing-move', 'reverse-lunge'],
  });
});

test('approved private-pack mappings add stable workout IDs without collapsing source movement names', () => {
  const growing = documentFor();
  const pack = {
    schemaVersion: 1,
    kind: 'mediaPack',
    id: 'approved-existing-v1',
    entries: {
      'bodyweight-squat-deepening': {
        anatomicalSide: 'bilateral',
        assets: [{
          type: 'video',
          creatorId: 'growingannanas',
          sourceVideoId: 'video-one',
          sourceTitle: 'Retained workout source',
          sourceStartSeconds: 10,
          sourceEndSeconds: 65,
          equipment: ['bodyweight'],
          variantId: 'existing-stable-mapping',
        }],
      },
    },
  };
  const compiled = compileCreatorLibrary([growing], { packs: [pack] });
  assert.equal(compiled.library.records.length, 2);
  assert.deepEqual(compiled.library.records.map((record) => record.movementId), ['bodyweight-squat', 'bodyweight-squat-deepening']);
  assert.equal(compiled.library.records.find((record) => record.movementId === 'bodyweight-squat-deepening').importedFromPack, 'approved-existing-v1');
  assert.deepEqual(compiled.library.records.find((record) => record.movementId === 'bodyweight-squat-deepening').range, {
    startSeconds: 15,
    endSeconds: 55,
  });
});

test('retained source audit measures every unique approved channel video without fuzzy-name leakage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'creator-source-audit-'));
  await mkdir(path.join(root, 'one'));
  await mkdir(path.join(root, 'duplicate'));
  await mkdir(path.join(root, 'other'));
  const approvedInfo = { id: 'video-one', uploader: 'growingannanas', title: 'Workout', webpage_url: 'https://youtube.test/video-one' };
  await writeFile(path.join(root, 'one', 'video-one.info.json'), JSON.stringify(approvedInfo));
  await writeFile(path.join(root, 'duplicate', 'video-one.info.json'), JSON.stringify(approvedInfo));
  await writeFile(path.join(root, 'other', 'lookalike.info.json'), JSON.stringify({ id: 'lookalike', uploader: 'MadFit With Sandra' }));
  await writeFile(path.join(root, 'other', 'missing.info.json'), JSON.stringify({ id: 'missing', uploader: 'Caroline Girvan', title: 'Missing' }));
  const compiled = compileCreatorLibrary([documentFor()]);
  const audit = await auditRetainedSources(root, compiled.library);
  assert.deepEqual(audit.totals, { retained: 2, accounted: 1, missing: 1 });
  assert.equal(audit.retainedSources.find((source) => source.videoId === 'video-one').metadataFiles.length, 2);
  assert.deepEqual(audit.missingRetainedSources.map((source) => source.videoId), ['missing']);
  assert.equal(audit.retainedSources.some((source) => source.videoId === 'lookalike'), false);
});

test('non-ready records require an honest reason and ready records require form review', () => {
  const document = documentFor();
  document.records[0].status = 'candidate';
  delete document.records[0].formNotes;
  let result = validateCandidateDocument(document);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'MISSING_REASON'));

  document.records[0].status = 'ready';
  document.records[0].reason = 'not used for ready records';
  result = validateCandidateDocument(document);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'MISSING_FORM_REVIEW'));
});

test('validator rejects unapproved creators, repo-contained source media, and invalid mocap ranges', () => {
  const document = documentFor({ creatorId: 'unknown-trainer', creatorName: 'Unknown Trainer' });
  document.sources[0].localPath = '/home/oliver/Projects/odcpw/fittimer/private-video.mp4';
  document.records[0].mocapRange = { startSeconds: 5, endSeconds: 40 };
  const result = validateCandidateDocument(document);
  assert.equal(result.valid, false);
  for (const code of ['UNAPPROVED_CREATOR', 'SOURCE_INSIDE_REPO', 'MOCAP_OUTSIDE_RANGE']) {
    assert.ok(result.errors.some((entry) => entry.code === code), `${code}: ${JSON.stringify(result.errors)}`);
  }
});

test('conflicting creator or retained source identities fail cross-document compilation', () => {
  const left = documentFor();
  const creatorConflict = documentFor({ videoId: 'video-two' });
  creatorConflict.creators[0].channelId = 'different-channel';
  assert.throws(() => compileCreatorLibrary([left, creatorConflict]), /Conflicting creator metadata/);

  const sourceConflict = documentFor();
  sourceConflict.sources[0].localPath = '/home/oliver/Projects/fittimer-media-research/elsewhere/video-one.mp4';
  assert.throws(() => compileCreatorLibrary([left, sourceConflict]), /Conflicting retained paths/);
});
