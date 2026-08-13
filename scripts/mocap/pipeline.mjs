#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REQUIRED_JOB_FIELDS = [
  'movementId',
  'creator',
  'source',
  'side',
  'equipment',
  'inputClip',
  'confidence',
  'mocapAsset',
];

const DEFAULT_LOOP_TOLERANCE_METERS = 0.08;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isFiniteVector(value) {
  return Array.isArray(value)
    && value.length === 3
    && value.every((component) => Number.isFinite(component));
}

export function validateMocapJob(job) {
  assert(job && typeof job === 'object' && !Array.isArray(job), 'job must be an object');
  assert(job.schemaVersion === 1, 'job.schemaVersion must be 1');
  for (const field of REQUIRED_JOB_FIELDS) assert(job[field] !== undefined, `job.${field} is required`);
  assert(typeof job.movementId === 'string' && job.movementId.length > 0, 'job.movementId must be a non-empty string');
  assert(typeof job.creator?.id === 'string' && job.creator.id.length > 0, 'job.creator.id is required');
  assert(typeof job.creator?.name === 'string' && job.creator.name.length > 0, 'job.creator.name is required');
  assert(typeof job.source?.url === 'string' && /^https:\/\//.test(job.source.url), 'job.source.url must be HTTPS');
  assert(typeof job.source?.videoId === 'string' && job.source.videoId.length > 0, 'job.source.videoId is required');
  assert(Number.isFinite(job.source?.timeRange?.startSeconds), 'job.source.timeRange.startSeconds is required');
  assert(Number.isFinite(job.source?.timeRange?.endSeconds), 'job.source.timeRange.endSeconds is required');
  assert(job.source.timeRange.endSeconds > job.source.timeRange.startSeconds, 'source time range must have positive duration');
  assert(['left', 'right', 'bilateral', 'alternating', 'unspecified'].includes(job.side), 'job.side is invalid');
  assert(Array.isArray(job.equipment) && job.equipment.every((item) => typeof item === 'string'), 'job.equipment must be a string array');
  assert(typeof job.inputClip === 'string' && job.inputClip.length > 0, 'job.inputClip is required');
  assert(job.confidence && typeof job.confidence === 'object', 'job.confidence is required');
  assert(['unreviewed', 'pass', 'fail'].includes(job.confidence.review), 'job.confidence.review is invalid');
  assert(job.confidence.tracking === null || (Number.isFinite(job.confidence.tracking) && job.confidence.tracking >= 0 && job.confidence.tracking <= 1), 'job.confidence.tracking must be null or between 0 and 1');
  assert(typeof job.mocapAsset?.provider === 'string' && job.mocapAsset.provider.length > 0, 'job.mocapAsset.provider is required');
  assert(typeof job.mocapAsset?.resultPath === 'string' && job.mocapAsset.resultPath.length > 0, 'job.mocapAsset.resultPath is required');
  assert(typeof job.mocapAsset?.motionPath === 'string' && job.mocapAsset.motionPath.length > 0, 'job.mocapAsset.motionPath is required');
  return Object.freeze(structuredClone(job));
}

function maxLoopGap(frames, joints) {
  const first = frames[0].joints;
  const last = frames.at(-1).joints;
  let maximum = 0;
  for (const joint of joints) {
    const gap = Math.hypot(
      first[joint][0] - last[joint][0],
      first[joint][1] - last[joint][1],
      first[joint][2] - last[joint][2],
    );
    maximum = Math.max(maximum, gap);
  }
  return maximum;
}

export function validateNormalizedMotion(motion, { loopToleranceMeters = DEFAULT_LOOP_TOLERANCE_METERS } = {}) {
  assert(motion && typeof motion === 'object' && !Array.isArray(motion), 'motion must be an object');
  assert(motion.schemaVersion === 1, 'motion.schemaVersion must be 1');
  assert(Number.isFinite(motion.fps) && motion.fps > 0, 'motion.fps must be positive');
  assert(motion.coordinateSystem?.up === 'Z', 'motion.coordinateSystem.up must be Z');
  assert(motion.coordinateSystem?.units === 'meters', 'motion.coordinateSystem.units must be meters');
  assert(Array.isArray(motion.joints) && motion.joints.length >= 5, 'motion.joints must contain at least five joints');
  assert(new Set(motion.joints).size === motion.joints.length, 'motion.joints must be unique');
  assert(motion.parents && typeof motion.parents === 'object', 'motion.parents is required');
  assert(Array.isArray(motion.frames) && motion.frames.length >= 2, 'motion.frames must contain at least two frames');

  for (const [frameIndex, frame] of motion.frames.entries()) {
    assert(frame && typeof frame.joints === 'object', `motion.frames[${frameIndex}].joints is required`);
    for (const joint of motion.joints) {
      assert(isFiniteVector(frame.joints[joint]), `motion.frames[${frameIndex}].joints.${joint} must be a finite XYZ vector`);
    }
  }
  for (const [joint, parent] of Object.entries(motion.parents)) {
    assert(motion.joints.includes(joint), `motion.parents contains unknown joint ${joint}`);
    assert(parent === null || motion.joints.includes(parent), `motion.parents.${joint} contains unknown parent`);
  }

  const loopGapMeters = maxLoopGap(motion.frames, motion.joints);
  if (motion.loop === true) {
    assert(loopGapMeters <= loopToleranceMeters, `loop seam gap ${loopGapMeters.toFixed(4)}m exceeds ${loopToleranceMeters}m`);
  }
  return Object.freeze({
    frameCount: motion.frames.length,
    durationSeconds: (motion.frames.length - 1) / motion.fps,
    jointCount: motion.joints.length,
    loopGapMeters,
  });
}

function blenderScriptPath() {
  return fileURLToPath(new URL('./blender-avatar.py', import.meta.url));
}

export function runBlenderAvatarExport({ blender = 'blender', jobPath, motionPath, outputPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(blender, [
      '--background',
      '--factory-startup',
      '--python', blenderScriptPath(),
      '--',
      '--job', path.resolve(jobPath),
      '--motion', path.resolve(motionPath),
      '--output', path.resolve(outputPath),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Blender export failed with code ${code}\n${stderr || stdout}`));
        return;
      }
      try {
        const output = await stat(path.resolve(outputPath));
        assert(output.isFile() && output.size > 0, 'Blender output is empty');
        resolve({ code, stdout, stderr });
      } catch (error) {
        reject(new Error(`Blender exited without creating the GLB\n${stderr || stdout}`, { cause: error }));
      }
    });
  });
}

export async function inspectGlb(filePath) {
  const buffer = await readFile(filePath);
  assert(buffer.length >= 20, 'GLB is too small');
  assert(buffer.toString('ascii', 0, 4) === 'glTF', 'GLB magic is invalid');
  assert(buffer.readUInt32LE(4) === 2, 'GLB version must be 2');
  assert(buffer.readUInt32LE(8) === buffer.length, 'GLB declared length does not match file size');
  const jsonLength = buffer.readUInt32LE(12);
  assert(buffer.toString('ascii', 16, 20) === 'JSON', 'GLB first chunk must be JSON');
  const document = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength).trimEnd());
  return Object.freeze({
    bytes: buffer.length,
    assetVersion: document.asset?.version,
    animationCount: document.animations?.length ?? 0,
    meshCount: document.meshes?.length ?? 0,
    nodeCount: document.nodes?.length ?? 0,
    sceneCount: document.scenes?.length ?? 0,
    document,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const jobPath = value('--job');
  const motionPath = value('--motion');
  const outputPath = value('--output');
  assert(jobPath && motionPath && outputPath, 'usage: pipeline.mjs --job JOB.json --motion MOTION.json --output AVATAR.glb');
  const job = validateMocapJob(JSON.parse(await readFile(jobPath, 'utf8')));
  const motion = JSON.parse(await readFile(motionPath, 'utf8'));
  const motionSummary = validateNormalizedMotion(motion);
  await runBlenderAvatarExport({ jobPath, motionPath, outputPath });
  const glb = await inspectGlb(outputPath);
  assert(glb.assetVersion === '2.0', 'Blender did not export glTF 2.0');
  assert(glb.animationCount > 0, 'GLB contains no animation');
  assert(glb.meshCount > 0, 'GLB contains no avatar geometry');
  const { document: _document, ...glbSummary } = glb;
  process.stdout.write(`${JSON.stringify({ ok: true, movementId: job.movementId, motion: motionSummary, glb: glbSummary }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
