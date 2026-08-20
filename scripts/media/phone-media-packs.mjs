#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PHONE_VIDEO_WIDTH = 854;
export const PHONE_VIDEO_HEIGHT = 480;
export const PHONE_PROFILE_ID = 'landscape-phone-480p-v1';

const VIDEO_TYPES = new Set(['video']);
const POSTER_TYPES = new Set(['poster']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty POSIX relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith('../') || normalized.startsWith('/') || normalized === '..') {
    throw new Error(`${label} escapes its pack: ${value}`);
  }
  return value;
}

async function readJson(file) {
  const source = await readFile(file, 'utf8');
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`, { cause: error });
  }
}

async function writeJsonOnce(file, value) {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const current = await readFile(file, 'utf8');
    if (current !== rendered) throw new Error(`Existing generated file differs; use a new versioned output root: ${file}`);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.part`;
  await writeFile(temporary, rendered, { flag: 'wx' });
  await rename(temporary, file);
  return true;
}

export function buildPhoneMediaPack(pack, {
  sourcePackPath,
  width = PHONE_VIDEO_WIDTH,
  height = PHONE_VIDEO_HEIGHT,
} = {}) {
  if (!object(pack) || pack.kind !== 'mediaPack' || typeof pack.id !== 'string' || !object(pack.entries)) {
    throw new Error('Source pack must be a mediaPack with an id and entries');
  }
  safeRelativePath(sourcePackPath, 'sourcePackPath');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 180) {
    throw new Error('Phone dimensions must be integers of at least 320×180');
  }
  return {
    ...structuredClone(pack),
    deliveryProfile: {
      id: PHONE_PROFILE_ID,
      width,
      height,
      videoCodec: 'h264',
      audio: 'none',
      fit: 'contain',
      sourcePackPath,
      originalsRetained: true,
    },
  };
}

export function collectPackAssets(pack) {
  if (!object(pack?.entries)) throw new Error('Pack entries are required');
  const assets = new Map();
  for (const entry of Object.values(pack.entries)) {
    for (const asset of entry?.assets ?? []) {
      if (!VIDEO_TYPES.has(asset?.type) && !POSTER_TYPES.has(asset?.type)) continue;
      const url = safeRelativePath(asset.url, 'asset.url');
      const previous = assets.get(url);
      if (previous && previous.type !== asset.type) throw new Error(`Asset URL has conflicting types: ${url}`);
      assets.set(url, { type: asset.type, url });
    }
  }
  return [...assets.values()];
}

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function probe(file, ffprobe) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt',
      '-show_entries', 'format=duration,size', '-of', 'json', file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed for ${file}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`ffprobe returned invalid JSON for ${file}`, { cause: error }));
      }
    });
  });
}

function validPhoneAsset(probeResult, type, width, height) {
  const streams = probeResult?.streams ?? [];
  const video = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  if (video.length !== 1 || video[0].width !== width || video[0].height !== height || audio.length !== 0) return false;
  if (type === 'video') return video[0].codec_name === 'h264' && video[0].pix_fmt === 'yuv420p';
  return true;
}

function videoEncoderArgs(encoder) {
  if (encoder === 'h264_nvenc') {
    return ['-c:v', encoder, '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '27', '-b:v', '0'];
  }
  if (encoder === 'libx264') return ['-c:v', encoder, '-preset', 'medium', '-crf', '25'];
  throw new Error(`Unsupported encoder: ${encoder}`);
}

async function encodeAsset({ source, output, type, width, height, ffmpeg, ffprobe, encoder }) {
  try {
    const existing = await probe(output, ffprobe);
    if (!validPhoneAsset(existing, type, width, height)) {
      throw new Error(`Existing output is not a valid ${width}×${height} phone asset: ${output}`);
    }
    return { encoded: false, bytes: Number(existing.format?.size ?? (await stat(output)).size) };
  } catch (error) {
    if (error?.code !== 'ENOENT' && !String(error?.message).includes('No such file or directory')) throw error;
  }

  await access(source);
  await mkdir(path.dirname(output), { recursive: true });
  const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const extension = path.extname(output) || (type === 'video' ? '.mp4' : '.png');
  const temporary = `${output}.part${extension}`;
  const args = type === 'video'
    ? [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-map', '0:v:0', '-vf', filter,
        '-an', ...videoEncoderArgs(encoder), '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart',
        '-map_metadata', '-1', temporary,
      ]
    : [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-map', '0:v:0', '-vf', filter,
        '-frames:v', '1', '-an', '-map_metadata', '-1', temporary,
      ];
  await run(ffmpeg, args, `Encode ${source}`);
  const encodedProbe = await probe(temporary, ffprobe);
  if (!validPhoneAsset(encodedProbe, type, width, height)) {
    throw new Error(`Generated output failed phone-profile validation: ${temporary}`);
  }
  await rename(temporary, output);
  return { encoded: true, bytes: Number(encodedProbe.format?.size ?? (await stat(output)).size) };
}

async function mapWithConcurrency(items, limit, work) {
  let cursor = 0;
  const results = new Array(items.length);
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function buildPhoneMediaPacks({
  sourceRoot,
  outputRoot,
  width = PHONE_VIDEO_WIDTH,
  height = PHONE_VIDEO_HEIGHT,
  jobs = 3,
  encoder = 'libx264',
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  onProgress = () => {},
}) {
  const source = path.resolve(sourceRoot);
  const output = path.resolve(outputRoot);
  if (source === output) throw new Error('Output root must differ from the source root');
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) throw new Error('jobs must be an integer from 1 to 16');

  const index = await readJson(path.join(source, 'index.json'));
  if (!object(index) || index.kind !== 'privateMediaPackIndex' || !object(index.mediaPacks)) {
    throw new Error('Source index is not a privateMediaPackIndex');
  }

  const packs = [];
  const work = [];
  for (const [id, relativeManifest] of Object.entries(index.mediaPacks)) {
    safeRelativePath(relativeManifest, `mediaPacks.${id}`);
    const sourceManifest = path.join(source, relativeManifest);
    const pack = await readJson(sourceManifest);
    if (pack.id !== id) throw new Error(`Pack ${id} does not match ${relativeManifest}`);
    const destinationManifest = path.join(output, relativeManifest);
    const phonePack = buildPhoneMediaPack(pack, { sourcePackPath: relativeManifest, width, height });
    packs.push({ relativeManifest, destinationManifest, phonePack });
    for (const asset of collectPackAssets(pack)) {
      work.push({
        ...asset,
        source: path.join(path.dirname(sourceManifest), asset.url),
        output: path.join(path.dirname(destinationManifest), asset.url),
        packId: id,
      });
    }
  }

  let completed = 0;
  const results = await mapWithConcurrency(work, jobs, async (asset) => {
    const result = await encodeAsset({ ...asset, width, height, ffmpeg, ffprobe, encoder });
    completed += 1;
    onProgress({ completed, total: work.length, encoded: result.encoded, packId: asset.packId, url: asset.url });
    return result;
  });

  for (const pack of packs) await writeJsonOnce(pack.destinationManifest, pack.phonePack);
  await writeJsonOnce(path.join(output, 'index.json'), index);

  return {
    profile: PHONE_PROFILE_ID,
    width,
    height,
    encoder,
    packs: packs.length,
    assets: work.length,
    encoded: results.filter((result) => result.encoded).length,
    skipped: results.filter((result) => !result.encoded).length,
    outputBytes: results.reduce((sum, result) => sum + result.bytes, 0),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source-root') options.sourceRoot = argv[++index];
    else if (argument === '--output-root') options.outputRoot = argv[++index];
    else if (argument === '--width') options.width = Number(argv[++index]);
    else if (argument === '--height') options.height = Number(argv[++index]);
    else if (argument === '--jobs') options.jobs = Number(argv[++index]);
    else if (argument === '--encoder') options.encoder = argv[++index];
    else if (argument === '--ffmpeg') options.ffmpeg = argv[++index];
    else if (argument === '--ffprobe') options.ffprobe = argv[++index];
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.sourceRoot || !options.outputRoot) {
    throw new Error('Usage: phone-media-packs.mjs --source-root DIR --output-root DIR [--encoder h264_nvenc] [--jobs 3]');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildPhoneMediaPacks({
    ...options,
    onProgress: ({ completed, total, packId, url }) => {
      if (completed === total || completed % 25 === 0) process.stderr.write(`[${completed}/${total}] ${packId}/${url}\n`);
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
