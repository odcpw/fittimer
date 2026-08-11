import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  APPROVED_CREATORS,
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
