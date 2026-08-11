#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { probeMedia, sha256File, validatePosterProbe, validateVideoProbe } from './pipeline.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_VERSION = 1;
const MAX_WIDTH = 1280;

export class CreatorClipError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CreatorClipError';
    this.code = code;
    this.details = details;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function assertExternal(directory) {
  const absolute = path.resolve(directory);
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new CreatorClipError('OUTPUT_INSIDE_REPO', 'Creator clips must stay outside Git', { outputRoot: absolute });
  }
  return absolute;
}

async function run(command, args, label) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (caught) => reject(new CreatorClipError('TOOL_START_FAILED', `${label}: ${caught.message}`, { command })));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new CreatorClipError('TOOL_FAILED', `${label} exited ${code}`, { command, stderr: stderr.slice(-4000) }));
    });
  });
}

function outputDimensions(source) {
  const boundedWidth = Math.min(MAX_WIDTH, source.width);
  const width = Math.max(32, Math.floor(boundedWidth / 32) * 32);
  return { width, height: width * 9 / 16 };
}

function videoFilter(dimensions) {
  return `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

function validateLibrary(library) {
  if (!object(library) || library.schemaVersion !== 1 || library.kind !== 'creatorMovementLibrary') {
    throw new CreatorClipError('INVALID_LIBRARY', 'Input must be a schema-version 1 creatorMovementLibrary');
  }
  if (!object(library.creators) || !Array.isArray(library.records)) {
    throw new CreatorClipError('INVALID_LIBRARY', 'Library must contain creators and records');
  }
  const records = library.records.filter((record) => record?.status === 'ready');
  const ids = new Set();
  for (const record of records) {
    if (typeof record.id !== 'string' || ids.has(record.id)) throw new CreatorClipError('DUPLICATE_RECORD', `Ready record ID is missing or duplicated: ${record.id}`);
    ids.add(record.id);
    if (!library.creators[record.creatorId]) throw new CreatorClipError('UNKNOWN_CREATOR', `Unknown creator for ${record.id}`);
    if (typeof record.source?.localPath !== 'string' || !path.isAbsolute(record.source.localPath)) {
      throw new CreatorClipError('INVALID_SOURCE', `Ready record has no absolute retained source: ${record.id}`);
    }
    const duration = record.range?.endSeconds - record.range?.startSeconds;
    if (!Number.isFinite(duration) || duration < 2 || duration > 40) {
      throw new CreatorClipError('INVALID_RANGE', `Ready reference range must be 2–40 seconds: ${record.id}`, { duration });
    }
  }
  return records;
}

async function readJson(file) {
  const source = await readFile(file, 'utf8');
  try {
    return JSON.parse(source);
  } catch (caught) {
    throw new CreatorClipError('INVALID_JSON', `Invalid JSON in ${file}: ${caught.message}`);
  }
}

async function writeManifest(file, manifest) {
  const next = `${file}.next`;
  await writeFile(next, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(next, file);
}

function outputDescriptor(root, record) {
  return {
    video: path.join(root, 'clips', `${record.id}.mp4`),
    poster: path.join(root, 'posters', `${record.id}.png`),
  };
}

async function verifiedExisting(root, record, previous, ffprobe) {
  const output = outputDescriptor(root, record);
  if (!previous || previous.recordFingerprint !== hash(record)) return false;
  if (!existsSync(output.video) || !existsSync(output.poster)) return false;
  const [videoSha, posterSha, videoProbe, posterProbe] = await Promise.all([
    sha256File(output.video),
    sha256File(output.poster),
    probeMedia(output.video, { ffprobe }),
    probeMedia(output.poster, { ffprobe }),
  ]);
  return videoSha === previous.output.video.sha256
    && posterSha === previous.output.poster.sha256
    && validateVideoProbe(videoProbe, {
      expectedWidth: previous.output.video.width,
      expectedHeight: previous.output.video.height,
      expectedDurationSeconds: record.range.endSeconds - record.range.startSeconds,
      requireSilent: true,
    }).valid
    && validatePosterProbe(posterProbe, {
      expectedWidth: previous.output.poster.width,
      expectedHeight: previous.output.poster.height,
    }).valid;
}

async function encodeRecord(root, record, { ffmpeg, ffprobe, log }) {
  const sourceProbe = await probeMedia(record.source.localPath, { ffprobe });
  if (sourceProbe.videoStreams !== 1 || !sourceProbe.width || !sourceProbe.height) {
    throw new CreatorClipError('INVALID_SOURCE', `Source must have exactly one video stream: ${record.id}`);
  }
  if (sourceProbe.durationSeconds === null || record.range.endSeconds > sourceProbe.durationSeconds + 0.05) {
    throw new CreatorClipError('RANGE_OUTSIDE_SOURCE', `Range exceeds retained source: ${record.id}`, { sourceDuration: sourceProbe.durationSeconds });
  }
  const dimensions = outputDimensions(sourceProbe);
  const filter = videoFilter(dimensions);
  const duration = record.range.endSeconds - record.range.startSeconds;
  const output = outputDescriptor(root, record);
  await mkdir(path.dirname(output.video), { recursive: true });
  await mkdir(path.dirname(output.poster), { recursive: true });
  if (existsSync(output.video) || existsSync(output.poster)) {
    throw new CreatorClipError('UNTRACKED_OUTPUT', `Output exists without a matching manifest record: ${record.id}`);
  }
  log('encode-start', { id: record.id, creatorId: record.creatorId, movementId: record.movementId, durationSeconds: duration });
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(record.range.startSeconds), '-i', record.source.localPath,
    '-t', String(duration), '-map', '0:v:0', '-vf', filter,
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', '-map_metadata', '-1',
    output.video,
  ], `Encode ${record.id}`);
  const posterAt = record.range.startSeconds + Math.min(duration / 2, 5);
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(posterAt), '-i', record.source.localPath,
    '-map', '0:v:0', '-vf', filter, '-frames:v', '1', '-an', '-map_metadata', '-1', output.poster,
  ], `Poster ${record.id}`);
  const [videoProbe, posterProbe, videoSha, posterSha, videoStat, posterStat] = await Promise.all([
    probeMedia(output.video, { ffprobe }),
    probeMedia(output.poster, { ffprobe }),
    sha256File(output.video),
    sha256File(output.poster),
    stat(output.video),
    stat(output.poster),
  ]);
  const videoResult = validateVideoProbe(videoProbe, {
    expectedWidth: dimensions.width,
    expectedHeight: dimensions.height,
    expectedDurationSeconds: duration,
    requireSilent: true,
  });
  const posterResult = validatePosterProbe(posterProbe, { expectedWidth: dimensions.width, expectedHeight: dimensions.height });
  if (!videoResult.valid || !posterResult.valid) {
    throw new CreatorClipError('OUTPUT_INVALID', `Encoded output failed validation: ${record.id}`, { video: videoResult.errors, poster: posterResult.errors });
  }
  return {
    id: record.id,
    movementId: record.movementId,
    displayName: record.displayName,
    creatorId: record.creatorId,
    side: record.side,
    equipment: record.equipment,
    source: record.source,
    range: record.range,
    mocapRange: record.mocapRange,
    recordFingerprint: hash(record),
    output: {
      video: { path: `clips/${record.id}.mp4`, width: dimensions.width, height: dimensions.height, durationSeconds: videoProbe.durationSeconds, sizeBytes: videoStat.size, sha256: videoSha },
      poster: { path: `posters/${record.id}.png`, width: dimensions.width, height: dimensions.height, sizeBytes: posterStat.size, sha256: posterSha },
    },
  };
}

function buildMediaPack(library, clips) {
  const entries = {};
  for (const clip of clips) {
    if (!entries[clip.movementId]) entries[clip.movementId] = { assets: [] };
    const provenance = {
      variantId: clip.id,
      creatorId: clip.creatorId,
      creatorName: library.creators[clip.creatorId].name,
      sourceVideoId: clip.source.videoId,
      sourceUrl: clip.source.url,
      sourceTitle: clip.source.title,
      sourceStartSeconds: clip.range.startSeconds,
      sourceEndSeconds: clip.range.endSeconds,
      equipment: clip.equipment,
      side: clip.side,
    };
    entries[clip.movementId].assets.push(
      { type: 'video', url: clip.output.video.path, framing: 'landscape-contain', ...provenance },
      { type: 'poster', url: clip.output.poster.path, framing: 'landscape-contain', ...provenance },
    );
  }
  return {
    schemaVersion: 1,
    kind: 'mediaPack',
    id: 'creator-library-v1',
    title: 'Approved creator movement library',
    outputFrame: { orientation: 'landscape', width: 16, height: 9, scalePolicy: 'fit-no-crop' },
    framingProfiles: {
      'landscape-contain': {
        fit: 'contain', crop: { x: 0, y: 0, width: 1, height: 1 }, zoom: 1, anchor: { x: 0.5, y: 0.5 },
      },
    },
    creators: Object.fromEntries(Object.entries(library.creators).map(([id, creator]) => [id, { ...creator, selectable: true }])),
    entries,
  };
}

export async function runCreatorClipPipeline({ library, libraryFile, outputRoot, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', logger = () => {} }) {
  const sourceLibrary = library ?? await readJson(libraryFile);
  const records = validateLibrary(sourceLibrary);
  const root = assertExternal(outputRoot);
  await mkdir(root, { recursive: true });
  const manifestFile = path.join(root, 'clip-manifest.json');
  const existing = existsSync(manifestFile) ? await readJson(manifestFile) : null;
  if (existing && (existing.kind !== 'creatorClipManifest' || existing.schemaVersion !== MANIFEST_VERSION)) {
    throw new CreatorClipError('INVALID_MANIFEST', 'Existing creator clip manifest has an incompatible contract');
  }
  const byId = new Map((existing?.clips ?? []).map((clip) => [clip.id, clip]));
  const currentIds = new Set(records.map((record) => record.id));
  const staleIds = [...byId.keys()].filter((id) => !currentIds.has(id));
  if (staleIds.length > 0) {
    throw new CreatorClipError('STALE_OUTPUT', 'Existing pack contains variants no longer present in the ready library', { staleIds });
  }
  const completed = [];
  let encoded = 0;
  let skipped = 0;
  for (const record of records) {
    const previous = byId.get(record.id);
    if (previous && previous.recordFingerprint !== hash(record)) {
      throw new CreatorClipError('STALE_OUTPUT', `Ready record changed after encoding: ${record.id}`);
    }
    if (await verifiedExisting(root, record, previous, ffprobe)) {
      completed.push(previous);
      skipped += 1;
      continue;
    }
    const result = await encodeRecord(root, record, { ffmpeg, ffprobe, log: logger });
    completed.push(result);
    encoded += 1;
    await writeManifest(manifestFile, { schemaVersion: MANIFEST_VERSION, kind: 'creatorClipManifest', clips: completed });
  }
  completed.sort((left, right) => left.movementId.localeCompare(right.movementId) || left.creatorId.localeCompare(right.creatorId) || left.id.localeCompare(right.id));
  const manifest = { schemaVersion: MANIFEST_VERSION, kind: 'creatorClipManifest', clips: completed };
  await writeManifest(manifestFile, manifest);
  await writeManifest(path.join(root, 'media-pack.json'), buildMediaPack(sourceLibrary, completed));
  return { records: records.length, encoded, skipped, manifestFile, outputRoot: root };
}

function cliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--library') options.libraryFile = path.resolve(argv[index += 1]);
    else if (argv[index] === '--output') options.outputRoot = path.resolve(argv[index += 1]);
    else if (argv[index] === '--ffmpeg') options.ffmpeg = argv[index += 1];
    else if (argv[index] === '--ffprobe') options.ffprobe = argv[index += 1];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.libraryFile || !options.outputRoot) throw new Error('Usage: creator-clip-pipeline.mjs --library FILE --output DIRECTORY');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCreatorClipPipeline({
    ...cliArguments(process.argv.slice(2)),
    logger: (event, details) => process.stderr.write(`${JSON.stringify({ event, ...details })}\n`),
  }).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((caught) => {
    process.stderr.write(`${JSON.stringify({ error: caught.message, code: caught.code ?? 'UNEXPECTED', details: caught.details ?? {} })}\n`);
    process.exitCode = 1;
  });
}
