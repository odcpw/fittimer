import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectGlb,
  runBlenderAvatarExport,
  validateMocapJob,
  validateNormalizedMotion,
} from '../scripts/mocap/pipeline.mjs';

const job = {
  schemaVersion: 1,
  movementId: 'avatar-pipeline-smoke',
  creator: { id: 'test-creator', name: 'Test Creator' },
  source: {
    url: 'https://www.youtube.com/watch?v=smoke-test',
    videoId: 'smoke-test',
    timeRange: { startSeconds: 10, endSeconds: 14 },
  },
  side: 'bilateral',
  equipment: ['none'],
  inputClip: '/private/input/smoke-test.mp4',
  confidence: { tracking: 1, review: 'pass' },
  mocapAsset: {
    provider: 'synthetic-test',
    resultPath: '/private/output/result.pt',
    motionPath: '/private/output/motion.json',
  },
};

function pose(armLift = 0) {
  return {
    pelvis: [0, 0, 1.0],
    chest: [0, 0, 1.45],
    head: [0, 0, 1.78],
    leftHand: [-0.55, 0, 1.35 + armLift],
    rightHand: [0.55, 0, 1.35 + armLift],
    leftFoot: [-0.18, 0, 0.05],
    rightFoot: [0.18, 0, 0.05],
  };
}

const motion = {
  schemaVersion: 1,
  fps: 12,
  coordinateSystem: { up: 'Z', forward: '-Y', units: 'meters' },
  loop: true,
  joints: ['pelvis', 'chest', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'],
  parents: {
    pelvis: null,
    chest: 'pelvis',
    head: 'chest',
    leftHand: 'chest',
    rightHand: 'chest',
    leftFoot: 'pelvis',
    rightFoot: 'pelvis',
  },
  frames: [
    { joints: pose(0) },
    { joints: pose(0.25) },
    { joints: pose(0.5) },
    { joints: pose(0.25) },
    { joints: pose(0) },
  ],
};

test('mocap job contract preserves creator and source provenance', () => {
  const validated = validateMocapJob(job);
  assert.equal(validated.movementId, 'avatar-pipeline-smoke');
  assert.equal(validated.creator.name, 'Test Creator');
  assert.equal(validated.source.timeRange.startSeconds, 10);
  assert.throws(() => validateMocapJob({ ...job, creator: null }), /creator\.id/);
});

test('normalized motion contract measures and enforces a clean loop seam', () => {
  const summary = validateNormalizedMotion(motion);
  assert.deepEqual(summary, {
    frameCount: 5,
    durationSeconds: 1 / 3,
    jointCount: 7,
    loopGapMeters: 0,
  });
  const broken = structuredClone(motion);
  broken.frames.at(-1).joints.leftHand[2] += 0.2;
  assert.throws(() => validateNormalizedMotion(broken), /loop seam gap/);
});

test('Blender exports animated glTF 2.0 GLB geometry for the Three.js seam', { timeout: 30_000 }, async (context) => {
  if (process.env.CI && process.env.FITTIMER_BLENDER_TEST !== '1') {
    context.skip('set FITTIMER_BLENDER_TEST=1 on CI hosts with Blender installed');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fittimer-mocap-'));
  const jobPath = path.join(directory, 'job.json');
  const motionPath = path.join(directory, 'motion.json');
  const outputPath = path.join(directory, 'avatar.glb');
  await Promise.all([
    writeFile(jobPath, JSON.stringify(job)),
    writeFile(motionPath, JSON.stringify(motion)),
  ]);
  await runBlenderAvatarExport({ jobPath, motionPath, outputPath });
  const result = await inspectGlb(outputPath);
  assert.equal(result.assetVersion, '2.0');
  assert.ok(result.animationCount >= 1);
  assert.ok(result.meshCount >= motion.joints.length);
  assert.ok(result.nodeCount > result.meshCount);
  assert.equal(result.sceneCount, 1);
});

test('Three.js preview loads GLB animation without changing the PWA runtime', async () => {
  const preview = await readFile('scripts/mocap/three-preview.html', 'utf8');
  assert.match(preview, /new GLTFLoader\(\)\.load\(asset/);
  assert.match(preview, /new THREE\.AnimationMixer\(gltf\.scene\)/);
  assert.match(preview, /three@0\.185\.1/);
  assert.equal(preview.includes('../src/'), false);
});
