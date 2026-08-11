#!/usr/bin/env node

import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PREFERRED_CREATORS = new Map([
  ['madfit', { name: 'MadFit', aliases: ['madfit'] }],
  ['growingannanas', { name: 'Growingannanas', aliases: ['growingannanas'] }],
  ['heather-robertson', { name: 'Heather Robertson', aliases: ['heather robertson'] }],
  ['caroline-girvan', { name: 'Caroline Girvan', aliases: ['caroline girvan'] }],
  ['sydney-cummings', { name: 'Sydney Cummings', aliases: ['sydney cummings houdyshell', 'sydney cummings'] }],
  ['pamela-reif', { name: 'Pamela Reif', aliases: ['pamela reif'] }],
]);

const KNOWN_SOURCE_CREATORS = new Map([
  ['g-i3S1fnQbQ', 'Heather Robertson'],
  ['3Eg9BvwWd8Q', 'Heather Robertson'],
  ['07c6wlJh89U', 'MadFit'],
]);

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function slug(value) {
  return String(value ?? 'unknown-creator')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'unknown-creator';
}

function canonicalCreator(name) {
  const normalized = String(name ?? '').trim().toLowerCase();
  for (const [id, creator] of PREFERRED_CREATORS) {
    if (creator.aliases.some((alias) => normalized.includes(alias))) {
      return { id, name: creator.name, selectable: true };
    }
  }
  const displayName = String(name ?? '').trim() || 'Unknown creator';
  return { id: slug(displayName), name: displayName, selectable: false };
}

async function findSourceInfo(root, wantedIds) {
  const byVideoId = new Map();
  const pending = [path.resolve(root)];
  while (pending.length > 0 && byVideoId.size < wantedIds.size) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.info.json')) {
        const expectedId = entry.name.slice(0, -'.info.json'.length);
        if (!wantedIds.has(expectedId) || byVideoId.has(expectedId)) continue;
        try {
          const info = JSON.parse(await readFile(absolute, 'utf8'));
          byVideoId.set(expectedId, {
            creatorName: info.uploader ?? info.channel ?? 'Unknown creator',
            channelId: info.channel_id ?? null,
            title: info.title ?? null,
            url: info.webpage_url ?? `https://www.youtube.com/watch?v=${expectedId}`,
          });
        } catch {
          // A malformed research sidecar must not prevent other sources being indexed.
        }
      }
    }
  }
  return byVideoId;
}

function outputPaths(clip) {
  return [
    clip?.output?.video,
    clip?.output?.poster,
    clip?.output?.loop?.video,
    clip?.output?.loop?.poster,
    clip?.output?.reference?.video,
    clip?.output?.reference?.poster,
  ].filter((value) => typeof value === 'string');
}

function sourceRange(clip) {
  return clip?.shortLoopRange ?? clip?.timeRange ?? clip?.sourceRange ?? clip?.referenceRange ?? null;
}

const packFile = argument('pack');
const manifestFile = argument('manifest');
const infoRoot = argument('info-root');
if (!packFile || !manifestFile || !infoRoot) {
  throw new Error('Usage: enrich-pack-creators.mjs --pack FILE --manifest FILE --info-root DIRECTORY');
}

const [pack, manifest] = await Promise.all([
  readFile(packFile, 'utf8').then(JSON.parse),
  readFile(manifestFile, 'utf8').then(JSON.parse),
]);
const clips = Array.isArray(manifest.clips) ? manifest.clips : [];
const wantedIds = new Set(clips.map((clip) => clip?.source?.videoId).filter(Boolean));
const infoByVideoId = await findSourceInfo(infoRoot, wantedIds);
const clipByOutput = new Map();
for (const clip of clips) {
  for (const outputPath of outputPaths(clip)) clipByOutput.set(outputPath, clip);
}

const creators = {};
let enrichedAssets = 0;
for (const [movementId, entry] of Object.entries(pack.entries ?? {})) {
  for (const asset of entry.assets ?? []) {
    const clip = clipByOutput.get(asset.url);
    const videoId = clip?.source?.videoId;
    if (!clip || !videoId) continue;
    const sourceInfo = infoByVideoId.get(videoId) ?? {};
    const creator = canonicalCreator(sourceInfo.creatorName ?? KNOWN_SOURCE_CREATORS.get(videoId));
    creators[creator.id] = {
      name: creator.name,
      selectable: creator.selectable,
      ...(sourceInfo.channelId ? { channelId: sourceInfo.channelId } : {}),
    };
    const range = sourceRange(clip);
    Object.assign(asset, {
      variantId: `${movementId}--${creator.id}--${videoId}`,
      creatorId: creator.id,
      creatorName: creator.name,
      sourceVideoId: videoId,
      sourceUrl: sourceInfo.url ?? clip.source?.canonicalUrl ?? `https://www.youtube.com/watch?v=${videoId}`,
      sourceTitle: sourceInfo.title ?? clip.source?.title ?? clip.intervalName ?? null,
      sourceStartSeconds: range?.startSeconds ?? null,
      sourceEndSeconds: range?.endSeconds ?? null,
      equipment: Array.isArray(clip.equipment) ? clip.equipment : [],
    });
    enrichedAssets += 1;
  }
}

pack.creators = Object.fromEntries(Object.entries(creators).sort(([left], [right]) => left.localeCompare(right)));
const temporary = `${packFile}.next`;
await writeFile(temporary, `${JSON.stringify(pack, null, 2)}\n`);
await rename(temporary, packFile);
process.stdout.write(`${JSON.stringify({ pack: pack.id, creators: Object.keys(creators).length, enrichedAssets })}\n`);
