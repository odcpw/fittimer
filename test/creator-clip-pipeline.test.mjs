import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { probeMedia } from '../scripts/media/pipeline.mjs';
import { CreatorClipError, runCreatorClipPipeline } from '../scripts/media/creator-clip-pipeline.mjs';

const run = promisify(execFile);
const ROOT = '/home/oliver/Projects/fittimer-media-research/pipeline-samples';

function library(sourceFile) {
  return {
    schemaVersion: 1,
    kind: 'creatorMovementLibrary',
    creators: { growingannanas: { name: 'Growingannanas' } },
    sources: {},
    records: [{
      id: 'squat-growingannanas-example',
      movementId: 'bodyweight-squat',
      displayName: 'Bodyweight squat',
      aliases: ['Squat'],
      creatorId: 'growingannanas',
      source: { id: 'source', videoId: 'example', url: 'https://example.invalid/example', title: 'Example', localPath: sourceFile },
      range: { startSeconds: 1, endSeconds: 4 },
      side: 'bilateral',
      equipment: ['bodyweight'],
      viewpoint: 'front',
      framing: 'Full body visible.',
      movementKind: 'normal',
      status: 'ready',
      formNotes: 'Reviewed.',
      mocapRange: { startSeconds: 1, endSeconds: 4 },
    }],
  };
}

test('creator clip pipeline emits silent fitted landscape variants and is idempotent', async () => {
  await mkdir(ROOT, { recursive: true });
  const working = await mkdtemp(path.join(ROOT, 'creator-clips-'));
  const source = path.join(working, 'portrait-source.mp4');
  const output = path.join(working, 'output');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '5', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
  ]);
  const first = await runCreatorClipPipeline({ library: library(source), outputRoot: output });
  assert.deepEqual({ encoded: first.encoded, skipped: first.skipped }, { encoded: 1, skipped: 0 });
  const second = await runCreatorClipPipeline({ library: library(source), outputRoot: output });
  assert.deepEqual({ encoded: second.encoded, skipped: second.skipped }, { encoded: 0, skipped: 1 });

  const manifest = JSON.parse(await readFile(path.join(output, 'clip-manifest.json'), 'utf8'));
  const pack = JSON.parse(await readFile(path.join(output, 'media-pack.json'), 'utf8'));
  assert.equal(manifest.clips.length, 1);
  assert.equal(pack.entries['bodyweight-squat'].assets.length, 2);
  assert.equal(pack.entries['bodyweight-squat'].assets[0].creatorId, 'growingannanas');
  const video = await probeMedia(path.join(output, manifest.clips[0].output.video.path));
  assert.equal(video.width * 9, video.height * 16);
  assert.equal(video.audioStreams, 0);
  assert.equal(video.codecName, 'h264');
  assert.equal(video.pixelFormat, 'yuv420p');

  const empty = library(source);
  empty.records = [];
  await assert.rejects(
    runCreatorClipPipeline({ library: empty, outputRoot: output }),
    (caught) => caught instanceof CreatorClipError && caught.code === 'STALE_OUTPUT',
  );
});

test('creator clip pipeline rejects repo outputs and ranges longer than forty seconds', async () => {
  const invalid = library('/private/missing.mp4');
  invalid.records[0].range.endSeconds = 45;
  await assert.rejects(
    runCreatorClipPipeline({ library: invalid, outputRoot: '/home/oliver/Projects/fittimer-media-research/unused-output' }),
    (caught) => caught instanceof CreatorClipError && caught.code === 'INVALID_RANGE',
  );
  await assert.rejects(
    runCreatorClipPipeline({ library: library('/private/missing.mp4'), outputRoot: process.cwd() }),
    (caught) => caught instanceof CreatorClipError && caught.code === 'OUTPUT_INSIDE_REPO',
  );
});
