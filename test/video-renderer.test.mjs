import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  deduplicateVisualSelections,
  resolveMovementVisual,
} from '../src/app.mjs';

const [application, html, styles, serviceWorker] = await Promise.all([
  readFile('src/app.mjs', 'utf8'),
  readFile('index.html', 'utf8'),
  readFile('styles.css', 'utf8'),
  readFile('sw.js', 'utf8'),
]);

const frame = {
  fit: 'contain',
  crop: { x: 0, y: 0, width: 1, height: 1 },
  zoom: 1,
  anchor: { x: 0.5, y: 0.5 },
};

function mediaPack(entries) {
  return {
    framingProfiles: { sequence: frame },
    entries,
  };
}

test('compound visuals deduplicate identical resolved URLs but retain distinct media and text', () => {
  const pack = mediaPack({
    deadlift: {
      anatomicalSide: 'bilateral',
      mirroring: 'never',
      assets: [{ type: 'video', url: 'data/video/full-sequence.mp4', framing: 'sequence' }],
    },
    uprightRow: {
      anatomicalSide: 'bilateral',
      mirroring: 'never',
      assets: [{ type: 'video', url: 'http://localhost/data/video/full-sequence.mp4', framing: 'sequence' }],
    },
    distinct: {
      anatomicalSide: 'bilateral',
      mirroring: 'never',
      assets: [{ type: 'video', url: 'data/video/distinct.mp4', framing: 'sequence' }],
    },
  });
  const selections = [
    resolveMovementVisual({ movementId: 'deadlift', displayName: 'Deadlift' }, pack),
    resolveMovementVisual({ movementId: 'uprightRow', displayName: 'Upright row' }, pack),
    resolveMovementVisual({ movementId: 'distinct', displayName: 'Distinct clip' }, pack),
    resolveMovementVisual({ movementId: 'text', displayName: 'Text fallback', textOnly: true }, pack),
  ];

  const unique = deduplicateVisualSelections(selections);
  assert.equal(unique.length, 3);
  assert.equal(unique[0].asset.url, 'data/video/full-sequence.mp4');
  assert.equal(unique[1].asset.url, 'data/video/distinct.mp4');
  assert.equal(unique[2].kind, 'text');
});

test('video candidates preserve framing/mirroring and reduced motion selects poster or text', () => {
  const pack = mediaPack({
    sideClip: {
      anatomicalSide: 'left',
      mirroring: 'when-needed',
      assets: [
        { type: 'video', url: 'data/video/side.mp4', framing: 'sequence' },
        { type: 'poster', url: 'data/video/side-poster.jpg', framing: 'sequence' },
      ],
    },
    videoOnly: {
      anatomicalSide: 'bilateral',
      mirroring: 'never',
      assets: [{ type: 'video', url: 'data/video/only.mp4', framing: 'sequence' }],
    },
    invalidFirst: {
      anatomicalSide: 'bilateral',
      mirroring: 'never',
      assets: [
        { type: 'video', url: 'http://[invalid-url', framing: 'sequence' },
        { type: 'poster', url: 'data/video/recovery.jpg', framing: 'sequence' },
      ],
    },
  });
  const video = resolveMovementVisual(
    { movementId: 'sideClip', displayName: 'Side clip' },
    pack,
    { requestedSide: 'right' },
  );
  assert.equal(video.kind, 'video');
  assert.equal(video.asset.type, 'video');
  assert.equal(video.framing.fit, 'contain');
  assert.equal(video.mirror, true);

  const reduced = resolveMovementVisual(
    { movementId: 'sideClip', displayName: 'Side clip' },
    pack,
    { reducedMotion: true },
  );
  assert.equal(reduced.kind, 'image');
  assert.equal(reduced.asset.type, 'poster');

  const noPoster = resolveMovementVisual(
    { movementId: 'videoOnly', displayName: 'Video only' },
    pack,
    { reducedMotion: true },
  );
  assert.equal(noPoster.kind, 'text');
  assert.equal(noPoster.reason, 'no-poster');

  const invalidFirst = resolveMovementVisual(
    { movementId: 'invalidFirst', displayName: 'Invalid first candidate' },
    pack,
  );
  assert.equal(invalidFirst.kind, 'image');
  assert.equal(invalidFirst.asset.type, 'poster');
});

test('bounded renderer owns video properties, cleanup, visibility replay, and safe stage framing', () => {
  for (const property of ['muted', 'autoplay', 'loop', 'playsInline', 'controls']) {
    assert.match(application, new RegExp(`node\\.${property}\\s*=`));
  }
  assert.match(application, /node\.controls\s*=\s*false/);
  assert.match(application, /node\.poster\s*=/);
  assert.match(application, /URL\.revokeObjectURL/);
  assert.match(application, /disposeStageVisuals/);
  assert.match(application, /visibilitychange/);
  assert.match(application, /replayCurrentVideos/);
  assert.match(application, /deduplicateVisualSelections/);
  assert.match(styles, /\.movement-stage[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(styles, /\.movement-stage[\s\S]*?overflow:\s*hidden/);
  assert.match(application, /element\.style\.objectFit\s*=\s*'contain'/);
  assert.match(styles, /html\[data-screen="workout"\][\s\S]*?\.movement-stage__media[\s\S]*?object-fit:\s*contain/);
  assert.match(styles, /@media \(orientation: portrait\)[\s\S]*?transform:\s*rotate\(90deg\)/);
  assert.match(application, /WORKOUT_HUD_DURATION_MS\s*=\s*10_000/);
  assert.match(application, /event\.target[\s\S]*?closest\('button/);
  assert.doesNotMatch(application, /requestFullscreen|screen\.orientation/);
  assert.doesNotMatch(html, /<audio\b/i);
  assert.doesNotMatch(application, /\b(?:new\s+)?Audio\s*\(/);
  assert.doesNotMatch(application, /mediaSession/i);
  assert.match(serviceWorker, /CACHE_NAME\s*=\s*'fittimer-v18'/);
  assert.match(serviceWorker, /isMutableCatalogueRequest[\s\S]*?url\.pathname\.endsWith\('\.json'\)/);
  assert.match(serviceWorker, /isMutableCatalogueRequest\(request\)[\s\S]*?networkFirstAssetResponse\(request\)/);
  assert.match(serviceWorker, /networkFirstAssetResponse[\s\S]*?cache\.put\(request, response\.clone\(\)\)[\s\S]*?caches\.match\(request\)/);
});

process.stdout.write('Video renderer tests passed: dedupe, fallback, reduced motion, cleanup, and invariants.\n');
