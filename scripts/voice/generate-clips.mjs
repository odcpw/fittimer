import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  FRANKEN_TTS_COMMIT,
  FRANKEN_TTS_MODEL,
  FRANKEN_TTS_VERSION,
  PACK_ID,
  PACK_MANIFEST_PATH,
  buildManifest,
  derivePhraseInventory,
  manifestMatchesInventory,
  readJson,
} from './build-pack.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUTPUT_DIR = path.resolve(REPO_ROOT, 'data/voice/assets');

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const result = {
    root: REPO_ROOT,
    manifest: PACK_MANIFEST_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    force: false,
    check: false,
    noResident: false,
    limit: null,
    from: 0,
  };
  const valueOptions = new Set(['--root', '--manifest', '--tool-root', '--model-dir', '--cache-dir', '--voice', '--limit', '--from']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') result.force = true;
    else if (arg === '--check') result.check = true;
    else if (arg === '--no-resident') result.noResident = true;
    else if (arg === '--output-dir') result.outputDir = argv[++index];
    else if (valueOptions.has(arg)) result[arg.slice(2).replaceAll('-', '_')] = argv[++index];
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (result.limit !== null) result.limit = Number.parseInt(result.limit, 10);
  result.from = Number.parseInt(result.from, 10);
  if (!Number.isInteger(result.from) || result.from < 0) throw new Error('--from must be a non-negative integer');
  if (result.limit !== null && (!Number.isInteger(result.limit) || result.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  result.root = path.resolve(result.root);
  result.manifest = path.resolve(result.root, result.manifest);
  result.outputDir = path.resolve(result.root, result.outputDir);
  return result;
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

function run(command, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`}): ${stderr || stdout}`));
    });
  });
}

function writeManifest(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporaryPath, manifestPath);
}

function assetPathForPhrase(outputDir, phrase) {
  return path.join(outputDir, `${phrase.id}.mp3`);
}

function assetUrl(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

export function assetMetadataMatches({ asset, phrase, outputPath, outputUrl, voice }) {
  if (!asset || asset.type !== 'audio/mpeg' || asset.url !== outputUrl) return false;
  if (asset.sourceTextSha256 !== sha256Text(phrase.text) || asset.sourceVoice !== voice) return false;
  if (!isFile(outputPath)) return false;
  const bytes = fs.readFileSync(outputPath);
  return bytes.length === asset.bytes && sha256Bytes(bytes) === asset.sha256;
}

function assertPhraseAsset(manifestPhrase, phrase, root, expectedVoice) {
  if (!manifestPhrase?.asset || manifestPhrase.asset.type !== 'audio/mpeg' || typeof manifestPhrase.asset.url !== 'string') {
    throw new Error(`phrase ${phrase.id} has no generated audio asset`);
  }
  const filePath = path.resolve(root, manifestPhrase.asset.url);
  if (!isFile(filePath)) throw new Error(`missing audio asset for ${phrase.id}: ${manifestPhrase.asset.url}`);
  const bytes = fs.readFileSync(filePath);
  const digest = sha256Bytes(bytes);
  // ubs:ignore — generated-file SHA256/size integrity checks are not secret-token comparisons.
  if (digest !== manifestPhrase.asset.sha256 || bytes.length !== manifestPhrase.asset.bytes) {
    throw new Error(`audio hash/size mismatch for ${phrase.id}`);
  }
  if (manifestPhrase.asset.sourceTextSha256 !== sha256Text(phrase.text)) {
    throw new Error(`audio source text mismatch for ${phrase.id}`);
  }
  if (manifestPhrase.asset.sourceVoice !== expectedVoice) {
    throw new Error(`audio source voice mismatch for ${phrase.id}`);
  }
}

export function assertPackAssets(manifest, root, selectedPhrases = null) {
  const inventory = derivePhraseInventory(root);
  if (!manifestMatchesInventory(manifest, inventory)) {
    throw new Error('voice pack manifest does not match the installed content inventory; run build-pack first');
  }
  const selected = selectedPhrases ?? inventory.phrases;
  const manifestById = new Map(manifest.phrases.map((phrase) => [phrase.id, phrase]));
  for (const phrase of selected) {
    const manifestPhrase = manifestById.get(phrase.id);
    if (!manifestPhrase) throw new Error(`manifest lost phrase ${phrase.id}`);
    assertPhraseAsset(manifestPhrase, phrase, root, manifest.generator?.voice);
  }
  return inventory;
}

export function assertGeneratedPack(manifest, root) {
  return assertPackAssets(manifest, root);
}

async function checkPack(args) {
  const manifest = readJson(args.manifest);
  const inventory = assertGeneratedPack(manifest, args.root);
  console.log(JSON.stringify({
    manifest: path.relative(args.root, args.manifest),
    packId: manifest.id,
    phraseCount: inventory.phrases.length,
    assetCount: manifest.inventory.assetCount,
    digest: inventory.inventoryDigest,
  }));
}

async function generatePack(args) {
  if (!args.tool_root || !args.model_dir || !args.cache_dir) {
    throw new Error('--tool-root, --model-dir, and --cache-dir are required for generation');
  }
  const toolRoot = path.resolve(args.tool_root);
  const modelDir = path.resolve(args.model_dir);
  const cacheDir = path.resolve(args.cache_dir);
  const ftts = path.join(toolRoot, 'ftts');
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
  if (!isFile(ftts)) throw new Error(`missing FrankenTTS binary: ${ftts}`);
  if (!isDirectory(modelDir)) throw new Error(`missing model directory: ${modelDir}`);
  fs.mkdirSync(args.outputDir, { recursive: true });
  fs.mkdirSync(path.join(cacheDir, 'wav'), { recursive: true });
  const version = await run(ftts, ['--version']);
  if (version.stdout.trim() !== `ftts ${FRANKEN_TTS_VERSION}`) {
    throw new Error(`expected ftts ${FRANKEN_TTS_VERSION}, got ${version.stdout.trim()}`);
  }

  const existing = fs.existsSync(args.manifest) ? readJson(args.manifest) : null;
  const inventory = derivePhraseInventory(args.root);
  const voice = args.voice ?? 'matt';
  let manifest = buildManifest({
    root: args.root,
    existing,
    generatedAt: existing?.generatedAt ?? new Date().toISOString(),
  });
  if (manifest.id !== PACK_ID || manifest.generator.sourceCommit !== FRANKEN_TTS_COMMIT) {
    throw new Error('manifest generator pin is not the assigned FrankenTTS release');
  }
  if (voice !== manifest.generator.voice) {
    throw new Error(`voice pack is pinned to ${manifest.generator.voice}, not ${voice}`);
  }
  writeManifest(args.manifest, manifest);

  const end = args.limit === null
    ? inventory.phrases.length
    : Math.min(inventory.phrases.length, args.from + args.limit);
  const selected = inventory.phrases.slice(args.from, end);
  let generated = 0;
  let skipped = 0;
  const environment = {
    ...process.env,
    FTTS_MODEL_DIR: modelDir,
    FTTS_RESIDENT_IDLE_SECS: '2',
  };

  for (const phrase of selected) {
    const manifestPhrase = manifest.phrases.find((candidate) => candidate.id === phrase.id);
    if (!manifestPhrase) throw new Error(`manifest lost phrase ${phrase.id}`);
    const outputPath = assetPathForPhrase(args.outputDir, phrase);
    const outputUrl = assetUrl(args.root, outputPath);
    if (!args.force && assetMetadataMatches({
      asset: manifestPhrase.asset,
      phrase,
      outputPath,
      outputUrl,
      voice,
    })) {
      skipped += 1;
      continue;
    }
    const wavPath = path.join(cacheDir, 'wav', `${phrase.id}.wav`);
    const fttsArgs = [
      'say',
      '--model', modelDir,
      '--voice', voice,
      '--output', wavPath,
      '--robot',
    ];
    if (args.noResident) fttsArgs.push('--no-resident');
    fttsArgs.push(phrase.text);
    await run(ftts, fttsArgs, { env: environment });
    await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      wavPath,
      '-map_metadata',
      '-1',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '64k',
      '-ar',
      '24000',
      '-ac',
      '1',
      outputPath,
    ], { env: environment });
    const sourceWavBytes = fs.readFileSync(wavPath);
    const assetBytes = fs.readFileSync(outputPath);
    manifestPhrase.asset = {
      type: 'audio/mpeg',
      url: outputUrl,
      bytes: assetBytes.length,
      sha256: sha256Bytes(assetBytes),
      sourceWavSha256: sha256Bytes(sourceWavBytes),
      sourceTextSha256: sha256Text(phrase.text),
      sourceVoice: voice,
    };
    manifest.inventory.assetCount = manifest.phrases.filter((candidate) => candidate.asset !== null).length;
    writeManifest(args.manifest, manifest);
    generated += 1;
    console.error(`${generated + skipped}/${selected.length}: ${phrase.id}`);
  }

  if (!args.noResident) await new Promise((resolve) => setTimeout(resolve, 2500));
  manifest = readJson(args.manifest);
  const wholePack = args.from === 0 && args.limit === null;
  assertPackAssets(manifest, args.root, wholePack ? null : selected);
  console.log(JSON.stringify({
    manifest: path.relative(args.root, args.manifest),
    packId: manifest.id,
    phraseCount: inventory.phrases.length,
    assetCount: manifest.inventory.assetCount,
    generated,
    skipped,
    checkedCount: wholePack ? inventory.phrases.length : selected.length,
    digest: inventory.inventoryDigest,
  }));
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: node scripts/voice/generate-clips.mjs --tool-root PATH --model-dir PATH --cache-dir PATH [options]');
    console.log('Options: --manifest PATH --output-dir PATH --voice NAME --force --check --no-resident --from N --limit N');
    return;
  }
  if (args.check) await checkPack(args);
  else await generatePack(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
