import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LOOP_POLICY,
  DEFAULT_OUTPUT_MAX_WIDTH,
  PipelineError,
  probeMedia,
  runPipeline,
  sha256File,
  validateCatalogue,
  validateManifestStructure,
  validatePosterProbe,
  validateVideoProbe,
} from '../scripts/media/pipeline.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'media', 'sample-catalogue.json');
const FFMPEG = process.env.FITTIMER_MEDIA_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FITTIMER_MEDIA_FFPROBE || 'ffprobe';
const SAMPLE_ROOT = path.join('/home/oliver/Projects/fittimer-media-research', 'pipeline-samples');

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

async function runTool(command, args) {
  try {
    return await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 8 });
  } catch (error) {
    throw new Error(`${command} failed: ${error.stderr || error.message}`, { cause: error });
  }
}

test('media pipeline validates the contract and proves real-tool idempotence', async () => {
  const fixture = parseJson(await readFile(FIXTURE, 'utf8'), FIXTURE);
  assert.equal(DEFAULT_OUTPUT_MAX_WIDTH, 1280);
  assert.deepEqual(fixture.loopPolicy, DEFAULT_LOOP_POLICY);
  assert.equal(validateCatalogue(fixture).valid, true);

  const aliasCatalogue = structuredClone(fixture);
  aliasCatalogue.clips[0].coversMovementIds = ['synthetic-squat-alias'];
  assert.equal(validateCatalogue(aliasCatalogue).valid, true, 'compound aliases are valid optional coverage');
  const duplicateAlias = structuredClone(aliasCatalogue);
  duplicateAlias.clips[0].coversMovementIds = ['synthetic-squat'];
  const duplicateAliasResult = validateCatalogue(duplicateAlias);
  assert.equal(duplicateAliasResult.valid, false);
  assert.ok(duplicateAliasResult.errors.some((error) => error.code === 'DUPLICATE_COVERAGE'));
  const duplicateAcrossRecords = structuredClone(aliasCatalogue);
  duplicateAcrossRecords.clips[1].coversMovementIds = ['synthetic-squat-alias'];
  duplicateAcrossRecords.clips[1].side = 'bilateral';
  const duplicateAcrossRecordsResult = validateCatalogue(duplicateAcrossRecords);
  assert.equal(duplicateAcrossRecordsResult.valid, false);
  assert.ok(duplicateAcrossRecordsResult.errors.some((error) => error.code === 'DUPLICATE_MAPPING'));

  const defaultPolicyCatalogue = structuredClone(fixture);
  delete defaultPolicyCatalogue.loopPolicy;
  assert.equal(validateCatalogue(defaultPolicyCatalogue).valid, true, 'documented defaults must remain usable');
  const firstSecondCatalogue = structuredClone(fixture);
  firstSecondCatalogue.clips[0].side = 'first';
  firstSecondCatalogue.clips[1].side = 'second';
  assert.equal(validateCatalogue(firstSecondCatalogue).valid, true, 'first/second side labels preserve distinct source intervals');

  const customPolicyCatalogue = structuredClone(defaultPolicyCatalogue);
  customPolicyCatalogue.clips[0].timeRange.endSeconds = 4;
  customPolicyCatalogue.clips[0].loop.reps = 1;
  const customPolicy = {
    normal: { minReps: 1, maxReps: 1, minDurationSeconds: 3, maxDurationSeconds: 4 },
    judged: { minDurationSeconds: 1, maxDurationSeconds: 120 },
  };
  assert.equal(validateCatalogue(customPolicyCatalogue, { loopPolicy: customPolicy }).valid, true, 'declared policy must control permitted loop shape');

  const duplicate = structuredClone(fixture);
  duplicate.clips[1].id = duplicate.clips[0].id;
  const duplicateResult = validateCatalogue(duplicate);
  assert.equal(duplicateResult.valid, false);
  assert.ok(duplicateResult.errors.some((error) => error.code === 'DUPLICATE_RECORD'));
  assert.ok(duplicateResult.errors.some((error) => error.code === 'DUPLICATE_MAPPING') === false);

  const duplicateMapping = structuredClone(fixture);
  duplicateMapping.clips[1].movementId = duplicateMapping.clips[0].movementId;
  duplicateMapping.clips[1].side = duplicateMapping.clips[0].side;
  const duplicateMappingResult = validateCatalogue(duplicateMapping);
  assert.equal(duplicateMappingResult.valid, false);
  assert.ok(duplicateMappingResult.errors.some((error) => error.code === 'DUPLICATE_MAPPING'));

  const invalidDuration = structuredClone(fixture);
  invalidDuration.clips[0].timeRange.endSeconds = 4;
  const invalidDurationResult = validateCatalogue(invalidDuration);
  assert.equal(invalidDurationResult.valid, false);
  assert.ok(invalidDurationResult.errors.some((error) => error.code === 'INVALID_DURATION'));

  const invalidCrop = structuredClone(fixture);
  invalidCrop.clips[0].crop = { x: 0, y: 0, width: 0.5, height: 1 };
  const invalidCropResult = validateCatalogue(invalidCrop);
  assert.equal(invalidCropResult.valid, false);
  assert.ok(invalidCropResult.errors.some((error) => error.code === 'UNSAFE_FRAME'));

  await mkdir(SAMPLE_ROOT, { recursive: true });
  const runRoot = await mkdtemp(path.join(SAMPLE_ROOT, `run-${process.pid}-`));
  const sourceDir = path.join(runRoot, 'source');
  const sourceFile = path.join(sourceDir, 'synthetic-source.mp4');
  const sourceCacheRoot = path.join(runRoot, 'source-cache');
  const outputRoot = path.join(runRoot, 'pipeline-output');
  await mkdir(sourceDir, { recursive: true });

  await runTool(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '12',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    '-movflags', '+faststart',
    sourceFile,
  ]);

  const sourceProbe = await probeMedia(sourceFile, { ffprobe: FFPROBE });
  assert.equal(sourceProbe.width, 1280);
  assert.equal(sourceProbe.height, 720);
  assert.equal(sourceProbe.audioStreams, 1, 'synthetic source must exercise audio stripping');
  const audioValidation = validateVideoProbe(sourceProbe, { requireSilent: true });
  assert.equal(audioValidation.valid, false);
  assert.ok(audioValidation.errors.some((error) => error.code === 'VIDEO_NOT_SILENT'));

  const catalogue = structuredClone(fixture);
  catalogue.clips[0].coversMovementIds = ['synthetic-squat-alias'];
  catalogue.clips[0].side = 'first';
  catalogue.clips[1].movementId = 'synthetic-squat';
  catalogue.clips[1].side = 'second';
  const sourceUrl = new URL(`file://${sourceFile}`).href;
  for (const clip of catalogue.clips) clip.source.url = sourceUrl;
  Object.assign(catalogue.clips[0], {
    intervalNumber: 1,
    intervalName: 'Synthetic Squat',
    formNotes: 'Keep the full foot contact visible.',
    seamNotes: 'Start and end at matching standing phases.',
    mocapNotes: 'Candidate range for future pose capture.',
    mocapRange: { startSeconds: 1, endSeconds: 6 },
  });
  Object.assign(catalogue.clips[0].source, {
    videoId: 'synthetic-source-v1',
    canonicalUrl: 'https://example.invalid/synthetic-source-v1',
  });
  const firstLogs = [];
  const first = await runPipeline({
    catalogue,
    sourceCacheRoot,
    outputRoot,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    logger: (event, details) => firstLogs.push({ event, ...details }),
  });
  assert.equal(first.clips, 2);
  assert.equal(first.copied, 1);
  assert.equal(first.cached, 1);
  assert.equal(first.downloaded, 0);
  assert.equal(first.encoded, 2);
  assert.equal(first.posters, 2);
  assert.equal(first.skipped, 0);
  assert.ok(firstLogs.some((entry) => entry.event === 'encode-start'));

  const manifestFile = path.join(outputRoot, 'clip-manifest.json');
  const packFile = path.join(outputRoot, 'media-pack.json');
  const manifestSource = await readFile(manifestFile, 'utf8');
  const packSource = await readFile(packFile, 'utf8');
  const manifest = parseJson(manifestSource, manifestFile);
  const pack = parseJson(packSource, packFile);
  assert.equal(validateManifestStructure(manifest, catalogue).valid, true);
  assert.deepEqual(manifest.loopPolicy, fixture.loopPolicy);
  assert.equal(pack.kind, 'mediaPack');
  assert.deepEqual(pack.outputFrame, {
    orientation: 'landscape',
    width: 16,
    height: 9,
    qaViewport: { width: 844, height: 390 },
    scalePolicy: 'avoid-upsample',
  });
  assert.equal(Object.keys(pack.entries).length, 2);
  assert.deepEqual(pack.entries['synthetic-squat-alias'].assets, pack.entries['synthetic-squat'].assets.slice(-2));
  assert.deepEqual(pack.entries['synthetic-squat'].assets.map((asset) => asset.side), ['second', 'second', 'first', 'first']);
  assert.ok(pack.entries['synthetic-squat'].assets.every((asset) => asset.side === 'first' || asset.side === 'second'));
  assert.deepEqual(
    manifest.clips.find((record) => record.id === 'synthetic-squat').coversMovementIds,
    ['synthetic-squat-alias'],
  );
  const metadataRecord = manifest.clips.find((record) => record.id === 'synthetic-squat');
  assert.equal(metadataRecord.intervalNumber, 1);
  assert.equal(metadataRecord.intervalName, 'Synthetic Squat');
  assert.equal(metadataRecord.source.videoId, 'synthetic-source-v1');
  assert.equal(metadataRecord.source.canonicalUrl, 'https://example.invalid/synthetic-source-v1');
  assert.equal(metadataRecord.formNotes, 'Keep the full foot contact visible.');
  assert.deepEqual(metadataRecord.mocapRange, { startSeconds: 1, endSeconds: 6 });

  for (const record of manifest.clips) {
    const videoFile = path.join(outputRoot, record.output.video);
    const posterFile = path.join(outputRoot, record.output.poster);
    const videoProbe = await probeMedia(videoFile, { ffprobe: FFPROBE });
    const posterProbe = await probeMedia(posterFile, { ffprobe: FFPROBE });
    assert.equal(videoProbe.audioStreams, 0);
    const expectedWidth = record.id === 'synthetic-squat' ? 1280 : 640;
    const expectedHeight = record.id === 'synthetic-squat' ? 720 : 360;
    assert.equal(videoProbe.width, expectedWidth);
    assert.equal(videoProbe.height, expectedHeight);
    assert.equal(videoProbe.width * 9, videoProbe.height * 16);
    assert.equal(videoProbe.codecName, 'h264');
    assert.equal(videoProbe.pixelFormat, 'yuv420p');
    assert.equal(posterProbe.audioStreams, 0);
    assert.equal(posterProbe.width, expectedWidth);
    assert.equal(posterProbe.height, expectedHeight);
    assert.equal(validatePosterProbe(posterProbe, { expectedWidth, expectedHeight }).valid, true);
    assert.equal(posterProbe.codecName, 'png');
    assert.equal(posterProbe.formatName, 'png_pipe');
    if (record.id === 'synthetic-squat') {
      const invalidPosterCodec = validatePosterProbe({ ...posterProbe, codecName: 'mjpeg' }, { expectedWidth, expectedHeight });
      assert.equal(invalidPosterCodec.valid, false);
      assert.ok(invalidPosterCodec.errors.some((error) => error.code === 'POSTER_CODEC'));
      const invalidPosterFormat = validatePosterProbe({ ...posterProbe, formatName: 'jpeg_pipe' }, { expectedWidth, expectedHeight });
      assert.equal(invalidPosterFormat.valid, false);
      assert.ok(invalidPosterFormat.errors.some((error) => error.code === 'POSTER_FORMAT'));
    }
    assert.equal(record.output.sizeBytes, (await stat(videoFile)).size);
    assert.equal(record.output.sha256, await sha256File(videoFile));
    assert.equal(record.output.posterSizeBytes, (await stat(posterFile)).size);
    assert.equal(record.output.posterSha256, await sha256File(posterFile));
  }

  const missing = structuredClone(manifest);
  missing.clips.pop();
  const missingResult = validateManifestStructure(missing, catalogue);
  assert.equal(missingResult.valid, false);
  assert.ok(missingResult.errors.some((error) => error.code === 'MISSING_OUTPUT'));

  const unmapped = structuredClone(manifest);
  unmapped.clips.push({
    id: 'unmapped-output',
    mappingKey: 'unmapped-movement::bilateral',
    output: {},
  });
  const unmappedResult = validateManifestStructure(unmapped, catalogue);
  assert.equal(unmappedResult.valid, false);
  assert.ok(unmappedResult.errors.some((error) => error.code === 'UNMAPPED_OUTPUT'));

  const bogusPrimary = structuredClone(manifest);
  const aliasedRecord = bogusPrimary.clips.find((record) => record.id === 'synthetic-squat');
  aliasedRecord.mappingKey = 'synthetic-squat-alias::first';
  const bogusPrimaryResult = validateManifestStructure(bogusPrimary, catalogue);
  assert.equal(bogusPrimaryResult.valid, false);
  assert.ok(bogusPrimaryResult.errors.some((error) => error.code === 'PRIMARY_MAPPING_MISMATCH'));

  const missingPrimary = structuredClone(manifest);
  const missingPrimaryRecord = missingPrimary.clips.find((record) => record.id === 'synthetic-squat');
  missingPrimaryRecord.mappingKeys = missingPrimaryRecord.mappingKeys.filter((key) => key !== missingPrimaryRecord.mappingKey);
  const missingPrimaryResult = validateManifestStructure(missingPrimary, catalogue);
  assert.equal(missingPrimaryResult.valid, false);
  assert.ok(missingPrimaryResult.errors.some((error) => error.code === 'PRIMARY_MAPPING_MISSING'));

  const second = await runPipeline({
    catalogue,
    sourceCacheRoot,
    outputRoot,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
  });
  assert.equal(second.downloaded, 0);
  assert.equal(second.copied, 0);
  assert.equal(second.encoded, 0);
  assert.equal(second.posters, 0);
  assert.equal(second.skipped, 2);
  assert.equal(second.manifestChanged, false);
  assert.equal(second.packChanged, false);
  assert.equal(await readFile(manifestFile, 'utf8'), manifestSource);
  assert.equal(await readFile(packFile, 'utf8'), packSource);

  const catalogueFile = path.join(runRoot, 'catalogue.json');
  await writeFile(catalogueFile, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');
  const cli = await execFileAsync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'media', 'pipeline.mjs'),
    '--catalogue', catalogueFile,
    '--source-cache', sourceCacheRoot,
    '--output-root', outputRoot,
    '--ffmpeg', FFMPEG,
    '--ffprobe', FFPROBE,
  ], { maxBuffer: 1024 * 1024 * 8 });
  const cliSummary = parseJson(cli.stdout, 'pipeline CLI stdout');
  assert.equal(cliSummary.skipped, 2);
  assert.match(cli.stderr, /pipeline-complete/);

  process.stdout.write(`Media pipeline samples: ${runRoot}\n`);
});

test('media pipeline rejects roots inside the checkout and unsupported sources', async () => {
  const fixture = parseJson(await readFile(FIXTURE, 'utf8'), FIXTURE);
  const invalid = structuredClone(fixture);
  invalid.clips[0].source.url = 'https://example.invalid/video';
  const result = validateCatalogue(invalid);
  assert.equal(result.valid, true);
  await assert.rejects(
    runPipeline({
      catalogue: invalid,
      sourceCacheRoot: path.join(REPO_ROOT, 'test', 'fixtures', 'media', 'cache'),
      outputRoot: path.join(SAMPLE_ROOT, `rejected-${os.tmpdir().replaceAll(path.sep, '-')}`),
    }),
    (error) => error instanceof PipelineError && error.code === 'ROOT_INSIDE_REPO',
  );
});
