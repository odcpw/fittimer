import { IntervalEngine } from './interval-engine.mjs';
import { AudioCuePlayer } from './audio-cues.mjs';
import { VoiceCueQueue } from './voice-cues.mjs';
import { createWakeLockController } from './wake-lock.mjs';
import {
  appendWorkoutHistory,
  buildMonthCalendar,
  currentStreak,
  formatDateKey,
  historySummary,
  loadWorkoutHistory,
} from './workout-history.mjs';
import {
  CREATOR_AUTO,
  CUE_PACK_IDS,
  CUE_PACK_SYNTH_V1,
  VISUAL_PACK_GIF_V1,
  VISUAL_PACK_REFERENCE_V1,
  VISUAL_PACK_W1W4_V1,
  VOICE_PACK_IDS,
  VOICE_PACK_BROWSER_V1,
  VOICE_PACK_FRANKENTTS_V1,
  createSettingsStore,
  normalizeSettings,
} from './settings.mjs';

const hasDocument = typeof document !== 'undefined';
const elements = hasDocument
  ? {
      home: document.querySelector('#home-screen'),
      workout: document.querySelector('#workout-screen'),
      routineList: document.querySelector('#routine-list'),
      historyStreak: document.querySelector('#history-streak'),
      historyMonthLabel: document.querySelector('#history-month-label'),
      historyPreviousMonth: document.querySelector('#history-previous-month'),
      historyNextMonth: document.querySelector('#history-next-month'),
      historyCalendar: document.querySelector('#history-calendar'),
      historySummary: document.querySelector('#history-summary'),
      settingsSummaryStatus: document.querySelector('#settings-summary-status'),
      cuePack: document.querySelector('#settings-cue-pack'),
      cuesEnabled: document.querySelector('#settings-cues-enabled'),
      cuesVolume: document.querySelector('#settings-cues-volume'),
      cuesVolumeOutput: document.querySelector('#settings-cues-volume-output'),
      cuesCountdown: document.querySelector('#settings-cues-countdown'),
      cuesHalfway: document.querySelector('#settings-cues-halfway'),
      voicePack: document.querySelector('#settings-voice-pack'),
      voiceEnabled: document.querySelector('#settings-voice-enabled'),
      voiceVolume: document.querySelector('#settings-voice-volume'),
      voiceVolumeOutput: document.querySelector('#settings-voice-volume-output'),
      voiceExercise: document.querySelector('#settings-voice-exercise'),
      voiceSide: document.querySelector('#settings-voice-side'),
      voiceNext: document.querySelector('#settings-voice-next'),
      creator: document.querySelector('#settings-creator'),
      reducedMotion: document.querySelector('#settings-reduced-motion'),
      mediaStatus: document.querySelector('#settings-media-status'),
      offline: document.querySelector('#offline-status'),
      phase: document.querySelector('#phase-label'),
      timer: document.querySelector('#timer'),
      intervalCount: document.querySelector('#interval-count'),
      stage: document.querySelector('#movement-stage'),
      exerciseTitle: document.querySelector('#exercise-title'),
      coachNote: document.querySelector('#coach-note'),
      progressTrack: document.querySelector('.progress-track'),
      progressFill: document.querySelector('#progress-fill'),
      nextUp: document.querySelector('#next-up'),
      controls: document.querySelector('#workout-controls'),
      back: document.querySelector('#back-button'),
      pause: document.querySelector('#pause-button'),
      next: document.querySelector('#next-button'),
      end: document.querySelector('#end-button'),
      completionActions: document.querySelector('#completion-actions'),
      completionHome: document.querySelector('#completion-home'),
      completionRestart: document.querySelector('#completion-restart'),
      endConfirmation: document.querySelector('#end-confirmation'),
      keepGoing: document.querySelector('#keep-going-button'),
      confirmEnd: document.querySelector('#confirm-end-button'),
      error: document.querySelector('#app-error'),
    }
  : {};

if (hasDocument) {
  for (const [name, element] of Object.entries(elements)) {
    if (!element) throw new Error(`Missing required UI element: ${name}`);
  }
}

const MEDIA_TYPES = new Set(['video', 'animated-webp', 'gif', 'poster']);
const MEDIA_PRIORITY = new Map([
  ['video', 0],
  ['animated-webp', 1],
  ['gif', 2],
  ['poster', 3],
]);

export const APPROVED_CREATOR_IDS = Object.freeze([
  'madfit',
  'growingannanas',
  'caroline-girvan',
  'sydney-cummings',
  'heather-robertson',
  'pamela-reif',
]);
const APPROVED_CREATOR_SET = new Set(APPROVED_CREATOR_IDS);

let routines = [];
let selectedRoutine = null;
let activeRoutine = null;
let mediaPacks = new Map();
let contentIndex = null;
let selectedMediaPack = null;
let voicePack = null;
let voicePackLoad = null;
let engine = null;
let animationFrame = null;
let renderedInterval = null;
let renderedPhase = null;
let workoutHudTimeout = null;
let routineStartPending = false;
let historyMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
const stageNodeCleanups = new Set();
const videoPlaybackFailures = new WeakMap();
const ownedBlobUrls = new WeakMap();
const settingsStore = createSettingsStore(hasDocument ? undefined : null);
let currentSettings = settingsStore.load();
const audioCues = new AudioCuePlayer({ settings: currentSettings });
const voiceCues = new VoiceCueQueue({ settings: currentSettings });
const wakeLockController = createWakeLockController();

const WORKOUT_STATES = new Set(['work', 'rest', 'paused']);
export const WORKOUT_HUD_DURATION_MS = 10_000;
export const PRIVATE_MEDIA_PACK_INDEX_PATH = 'private-packs/index.json';

const SETTINGS_PACK_LABELS = new Map([
  [CUE_PACK_SYNTH_V1, 'Synth tones'],
  [VOICE_PACK_BROWSER_V1, 'Browser voice'],
  [VOICE_PACK_FRANKENTTS_V1, 'FrankenTTS voice'],
]);

function requestWakeLock() {
  void wakeLockController.request();
}

function releaseWakeLock() {
  void wakeLockController.release();
}

function startVoicePackLoad() {
  if (currentSettings.voice.packId !== VOICE_PACK_FRANKENTTS_V1) return null;
  const pending = voiceCues.loadPack();
  voicePackLoad = pending;
  void pending.then((pack) => {
    if (pack) voicePack = pack;
  }).catch(() => {
    // VoiceCueQueue bounds and absorbs pack failures; SpeechSynthesis remains the fallback.
  });
  return pending;
}

function settingsPackLabel(packId) {
  return SETTINGS_PACK_LABELS.get(packId) ?? packId;
}

function appSettings(settings) {
  return normalizeSettings(settings);
}

function safePrivatePackPath(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('/') || value.includes('\\')) return false;
  if (value.includes('?') || value.includes('#') || value.includes('\0')) return false;
  try {
    const url = new URL(value, 'http://fittimer-private.local/private-packs/index.json');
    if (url.origin !== 'http://fittimer-private.local' || !url.pathname.startsWith('/private-packs/')) return false;
    const parts = url.pathname.slice('/private-packs/'.length).split('/').filter(Boolean);
    return parts.length > 0 && parts.every((part) => part !== '.' && part !== '..');
  } catch {
    return false;
  }
}

function privatePackId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value) ? value : null;
}

function safePrivateAssetPath(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('/') || value.includes('\\') || value.includes('%')) return false;
  if (value.includes('?') || value.includes('#') || value.includes(':')) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..');
}

function privatePackAssetsAreRelative(pack) {
  return Object.values(pack?.entries ?? {}).every((entry) => Array.isArray(entry?.assets)
    && entry.assets.every((asset) => safePrivateAssetPath(asset?.url)));
}

/**
 * Validate the optional same-origin private index without ever accepting an
 * absolute filesystem path or URL into the browser content graph.
 */
export function normalizePrivateMediaPackIndex(value) {
  if (!isObject(value) || value.schemaVersion !== 1 || value.kind !== 'privateMediaPackIndex') return null;
  if (!isObject(value.mediaPacks)) return null;
  const mediaPacks = {};
  for (const [id, relativePath] of Object.entries(value.mediaPacks)) {
    const safeId = privatePackId(id);
    if (!safeId || !safePrivatePackPath(relativePath)) continue;
    mediaPacks[safeId] = relativePath.startsWith('private-packs/')
      ? relativePath
      : `private-packs/${relativePath}`;
  }
  return Object.keys(mediaPacks).length > 0 ? Object.freeze({ schemaVersion: 1, kind: value.kind, mediaPacks }) : null;
}

export function mergePrivateMediaPackIndex(index, privateIndex) {
  const normalized = normalizePrivateMediaPackIndex(privateIndex);
  if (!normalized) return index;
  const mediaPacks = { ...(index?.mediaPacks ?? {}) };
  for (const [id, file] of Object.entries(normalized.mediaPacks)) {
    if (!Object.hasOwn(mediaPacks, id)) mediaPacks[id] = file;
  }
  return { ...index, mediaPacks, privateMediaPackIndexPath: PRIVATE_MEDIA_PACK_INDEX_PATH };
}

/**
 * Keep the home summary short while deriving every value from the versioned
 * settings contract instead of duplicating defaults in the UI.
 */
export function summarizeSettings(settings) {
  const normalized = appSettings(settings);
  const voiceLabel = normalized.voice.enabled ? 'Voice on' : 'Voice off';
  return Object.freeze({
    label: `${normalized.cues.enabled ? 'Sound on' : 'Sound off'} · ${voiceLabel}`,
    cueLabel: normalized.cues.enabled ? 'Sound on' : 'Sound off',
    voiceLabel,
  });
}

/**
 * Use exactly one video pack. Missing movements remain written guidance so
 * they are visible content gaps, never silently substituted GIFs.
 */
export function selectMediaPack(packId, packs = mediaPacks) {
  const primary = packs.get(packId);
  if (!primary) return null;
  const entries = {};
  for (const [movementId, entry] of Object.entries(primary.entries ?? {})) {
    entries[movementId] = {
      ...entry,
      assets: (entry.assets ?? []).map((asset) => ({
        ...asset,
        __sourcePath: asset.__sourcePath ?? primary.__sourcePath ?? null,
        __framingProfile: typeof asset.framing === 'string'
          ? primary.framingProfiles?.[asset.framing] ?? null
          : null,
      })),
    };
  }
  return {
    ...primary,
    entries,
  };
}

function packHasVideo(pack) {
  return Object.values(pack?.entries ?? {}).some((entry) =>
    Array.isArray(entry?.assets) && entry.assets.some((asset) => asset?.type === 'video'));
}

function isApprovedCreatorId(creatorId) {
  return typeof creatorId === 'string' && APPROVED_CREATOR_SET.has(creatorId);
}

function isLegacyPublicPack(pack) {
  return !pack?.__sourcePath
    && !isObject(pack?.creators)
    && (pack?.id === VISUAL_PACK_GIF_V1 || pack?.id === undefined);
}

function routineMovements(routine) {
  const movements = new Map();
  for (const interval of routine?.intervals ?? []) {
    for (const movement of interval.movements ?? []) {
      if (typeof movement?.movementId !== 'string' || movement.textOnly === true) continue;
      movements.set(movement.movementId, movement);
    }
  }
  return [...movements.values()];
}

function routineTextOnlyCount(routine) {
  const movementIds = new Set();
  for (const interval of routine?.intervals ?? []) {
    for (const movement of interval.movements ?? []) {
      if (movement?.textOnly === true && typeof movement.movementId === 'string') {
        movementIds.add(movement.movementId);
      }
    }
  }
  return movementIds.size;
}

function assetMatchesCreator(asset, creatorId, mediaPack = null) {
  if (creatorId === null || creatorId === undefined) return false;
  if (isApprovedCreatorId(asset?.creatorId)) {
    return creatorId === CREATOR_AUTO || asset.creatorId === creatorId;
  }
  // Retain the public GIF resolver contract for the legacy built-in pack. It
  // is never loaded into the private runtime and has no creator metadata.
  return creatorId === CREATOR_AUTO
    && isLegacyPublicPack(mediaPack)
    && asset?.creatorId === undefined;
}

function packHasCreatorVideo(pack, creatorId = CREATOR_AUTO) {
  return Object.values(pack?.entries ?? {}).some((entry) =>
    Array.isArray(entry?.assets)
      && entry.assets.some((asset) => asset?.enabled !== false
        && asset?.type === 'video'
        && (creatorId === CREATOR_AUTO
          ? isApprovedCreatorId(asset?.creatorId)
          : assetMatchesCreator(asset, creatorId, pack))));
}

function creatorCandidates(pack) {
  const registered = APPROVED_CREATOR_IDS.filter((creatorId) =>
    pack?.creators?.[creatorId]?.selectable === true
    && packHasCreatorVideo(pack, creatorId));
  if (registered.length > 0) return registered;
  return APPROVED_CREATOR_IDS.filter((creatorId) => packHasCreatorVideo(pack, creatorId));
}

export function creatorCoverageForRoutine(routine, mediaPack, creatorId = CREATOR_AUTO) {
  const movements = routineMovements(routine);
  const covered = movements.filter((movement) => {
    const assets = mediaPack?.entries?.[movement.movementId]?.assets;
    return Array.isArray(assets) && assets.some((asset) => asset?.enabled !== false
      && asset?.type === 'video'
      && assetMatchesCreator(asset, creatorId, mediaPack));
  }).length;
  return Object.freeze({
    covered,
    total: movements.length,
    textOnly: routineTextOnlyCount(routine),
  });
}

export function chooseRoutineCreatorId(routine, mediaPack, creatorId = CREATOR_AUTO) {
  if (creatorId !== CREATOR_AUTO) return isApprovedCreatorId(creatorId) ? creatorId : null;
  let bestCreator = null;
  let bestCoverage = 0;
  for (const candidate of creatorCandidates(mediaPack)) {
    const coverage = creatorCoverageForRoutine(routine, mediaPack, candidate).covered;
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestCreator = candidate;
    }
  }
  return bestCreator;
}

function playbackCreatorId(routine, mediaPack, requestedCreatorId) {
  if (requestedCreatorId === CREATOR_AUTO && isLegacyPublicPack(mediaPack)) return CREATOR_AUTO;
  return chooseRoutineCreatorId(routine, mediaPack, requestedCreatorId);
}

/**
 * Pick the installed pack that covers the chosen routine instead of making
 * the user route through Settings first. MadFit prefers its own retained
 * reference pack; the four Fable routines prefer the combined W1-W4 pack.
 * Only packs containing real video participate.
 */
export function chooseRoutineMediaPackId(routine, packs, creatorId = CREATOR_AUTO) {
  if (!(packs instanceof Map) || packs.size === 0) return null;
  const routineDefault = routine?.id === 'madfit-30min-hiit'
    ? VISUAL_PACK_REFERENCE_V1
    : VISUAL_PACK_W1W4_V1;
  const candidateIds = [...new Set([
    routineDefault,
    VISUAL_PACK_W1W4_V1,
    VISUAL_PACK_REFERENCE_V1,
    ...packs.keys(),
  ])].filter((id) => packs.has(id) && packHasVideo(packs.get(id)) && packHasCreatorVideo(packs.get(id), creatorId));
  let bestId = candidateIds[0] ?? null;
  let bestCoverage = -1;
  for (const id of candidateIds) {
    const pack = selectMediaPack(id, packs);
    const coverage = creatorId === CREATOR_AUTO
      ? Math.max(0, ...creatorCandidates(pack).map((candidate) =>
        creatorCoverageForRoutine(routine, pack, candidate).covered))
      : creatorCoverageForRoutine(routine, pack, creatorId).covered;
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Describe which workout actions belong on screen for a timestamped snapshot.
 * Keeping this decision pure makes the safety-critical navigation contract
 * testable without a browser or a running clock.
 */
export function workoutNavigationState(snapshot) {
  const state = snapshot?.state;
  const intervalIndex = Number.isInteger(snapshot?.intervalIndex) ? snapshot.intervalIndex : 0;
  const inWorkout = WORKOUT_STATES.has(state);
  const completed = state === 'done';
  return Object.freeze({
    previousDisabled: !inWorkout || intervalIndex === 0,
    endEnabled: inWorkout,
    activeControlsVisible: !completed,
    completionActionsVisible: completed,
  });
}

/**
 * The timer is the one workout element that never disappears. The exercise
 * HUD is transient during active playback, but pausing or finishing a workout
 * makes the explanatory copy and its available actions persistent again.
 */
export function workoutHudState(snapshot, hudVisible = true) {
  const state = snapshot?.state;
  const persistent = state === 'paused' || state === 'done';
  const detailsVisible = persistent || hudVisible === true;
  return Object.freeze({
    timerVisible: true,
    detailsVisible,
    controlsVisible: state !== 'done' && WORKOUT_STATES.has(state) && detailsVisible,
    completionActionsVisible: state === 'done',
  });
}

function mediaKind(type) {
  if (type === 'video') return 'video';
  if (type === 'animated-webp' || type === 'gif' || type === 'poster') return 'image';
  return null;
}

function resolveFraming(mediaPack, asset) {
  if (!asset || !mediaPack) return null;
  if (typeof asset.framing === 'object' && asset.framing !== null) return asset.framing;
  if (asset.__framingProfile && typeof asset.__framingProfile === 'object') return asset.__framingProfile;
  if (typeof asset.framing !== 'string') return null;
  return mediaPack.framingProfiles?.[asset.framing] ?? null;
}

function assetSide(asset) {
  if (asset?.side === undefined || asset?.side === null || asset.side === '') return null;
  return String(asset.side);
}

function shouldMirror(entry, requestedSide, selectedAsset = null) {
  const sourceSide = assetSide(selectedAsset) ?? assetSide({ side: entry?.anatomicalSide });
  if (entry?.mirroring === 'always') return true;
  if (
    entry?.mirroring !== 'when-needed' ||
    !['left', 'right'].includes(requestedSide) ||
    !['left', 'right'].includes(sourceSide)
  ) {
    return false;
  }
  return requestedSide !== sourceSide;
}

function orderedAssets(entry, reducedMotion, requestedSide, mediaPack = null, creatorId = CREATOR_AUTO) {
  if (!Array.isArray(entry?.assets)) return [];
  const available = entry.assets.filter((asset) => asset?.enabled !== false
    && MEDIA_TYPES.has(asset?.type)
    && assetMatchesCreator(asset, creatorId, mediaPack)
    && resolvePackAssetUrl(mediaPack, asset?.url, asset));
  const normalizedSide = assetSide({ side: requestedSide });
  const mirroredSide = normalizedSide === 'left' ? 'right' : normalizedSide === 'right' ? 'left' : null;
  const sideAware = normalizedSide === null
    ? available
    : available.filter((asset) => {
        const candidateSide = assetSide(asset);
        return candidateSide === null
          || candidateSide === normalizedSide
          || entry.mirroring === 'when-needed' && candidateSide === mirroredSide;
      });
  const candidates = reducedMotion
    ? sideAware.filter((asset) => asset.type === 'poster')
    : sideAware;
  return [...candidates].sort((left, right) => {
    const rank = (asset) => {
      const candidateSide = assetSide(asset);
      if (candidateSide === normalizedSide) return 0;
      if (candidateSide === null) return 1;
      return 2;
    };
    if (normalizedSide !== null) {
      const sideDifference = rank(left) - rank(right);
      if (sideDifference !== 0) return sideDifference;
    }
    const priority = (asset) => Number.isFinite(Number(asset.priority)) ? Number(asset.priority) : 100;
    const priorityDifference = priority(left) - priority(right);
    if (priorityDifference !== 0) return priorityDifference;
    return MEDIA_PRIORITY.get(left.type) - MEDIA_PRIORITY.get(right.type);
  });
}

/**
 * Resolve one movement without touching the DOM. The returned candidates are
 * ordered fallback data; a renderer can move from video/image to poster/text
 * after a resource fails without knowing anything about the routine schema.
 */
export function resolveMovementVisual(
  movement,
  mediaPack,
  { reducedMotion = false, requestedSide = undefined, creatorId = CREATOR_AUTO } = {},
) {
  const label = typeof movement?.displayName === 'string' && movement.displayName.trim()
    ? movement.displayName
    : 'Movement';
  const movementId = typeof movement?.movementId === 'string' ? movement.movementId : null;
  const resolverCreatorId = creatorId === CREATOR_AUTO && !isLegacyPublicPack(mediaPack)
    ? creatorCandidates(mediaPack)[0] ?? null
    : creatorId;
  const textResult = (reason) => ({
    kind: 'text',
    movementId,
    label,
    reason,
    candidates: [],
    fallback: 'text',
    videoNeeded: reason !== 'text-only',
    mirror: false,
    framing: null,
    mediaPackBasePath: mediaPack?.__sourcePath ?? null,
  });

  if (movement?.textOnly === true) return textResult('text-only');
  const entry = movementId && isObject(mediaPack?.entries) ? mediaPack.entries[movementId] : null;
  if (!entry) return textResult('missing-pack-entry');

  const candidates = orderedAssets(entry, reducedMotion, requestedSide, mediaPack, resolverCreatorId);
  if (candidates.length === 0) {
    return textResult(
      resolverCreatorId !== CREATOR_AUTO
        ? 'creator-not-covered'
        : reducedMotion ? 'no-poster' : 'empty-pack-entry',
    );
  }
  const asset = candidates[0];
  return {
    kind: mediaKind(asset.type) ?? 'text',
    movementId,
    label,
    asset,
    candidates,
    entry,
    framing: resolveFraming(mediaPack, asset),
    anatomicalSide: entry.anatomicalSide,
    mediaPackBasePath: mediaPack?.__sourcePath ?? null,
    mirror: shouldMirror(entry, requestedSide, asset),
    fallback: 'text',
  };
}

/**
 * Compound intervals may describe one full-sequence clip more than once. Keep
 * one visual for each resolved asset URL while leaving text-only entries and
 * genuinely distinct assets untouched.
 */
export function deduplicateVisualSelections(selections) {
  if (!Array.isArray(selections)) return [];
  const seenUrls = new Set();
  return selections.filter((selection) => {
    const assetUrl = selection?.asset?.url;
    if (typeof assetUrl !== 'string') return true;
    const resolvedUrl = resolveAssetUrl(assetUrl, selection?.asset?.__sourcePath ?? selection?.mediaPackBasePath);
    if (!resolvedUrl) return true;
    if (seenUrls.has(resolvedUrl)) return false;
    seenUrls.add(resolvedUrl);
    return true;
  });
}

function resolveUrl(relativePath) {
  return new URL(relativePath, hasDocument ? document.baseURI : 'http://localhost/').href;
}

function resolveAssetUrl(assetUrl, basePath = undefined) {
  if (typeof assetUrl !== 'string' || assetUrl.trim() === '') return null;
  try {
    return basePath ? new URL(assetUrl, resolveUrl(basePath)).href : resolveUrl(assetUrl);
  } catch {
    return null;
  }
}

function resolvePackAssetUrl(mediaPack, assetUrl, asset = null) {
  if (typeof assetUrl !== 'string' || assetUrl.trim() === '') return null;
  try {
    const sourcePath = asset?.__sourcePath ?? mediaPack?.__sourcePath;
    if (typeof sourcePath === 'string') {
      return new URL(assetUrl, resolveUrl(sourcePath)).href;
    }
    return resolveUrl(assetUrl);
  } catch {
    return null;
  }
}

async function fetchJson(relativePath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(resolveUrl(relativePath), { signal: controller.signal });
    if (!response.ok) throw new Error(`Could not load ${relativePath} (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOptionalPrivateIndex() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(resolveUrl(PRIVATE_MEDIA_PACK_INDEX_PATH), {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return null;
    try {
      return normalizePrivateMediaPackIndex(await response.json());
    } catch {
      // GitHub Pages may return its HTML fallback for an unknown path.
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function applyOutputFrame(mediaPack) {
  const frame = mediaPack?.outputFrame;
  if (!frame || !elements.stage) return;
  if (Number.isFinite(frame.width) && Number.isFinite(frame.height)) {
    elements.stage.style.aspectRatio = `${frame.width} / ${frame.height}`;
  }
  elements.stage.dataset.outputOrientation = frame.orientation ?? 'landscape';
  elements.stage.dataset.qaViewport = frame.qaViewport
    ? `${frame.qaViewport.width}x${frame.qaViewport.height}`
    : '';
}

async function loadContent() {
  const publicIndex = await fetchJson('data/content-index.json');
  const index = mergePrivateMediaPackIndex(publicIndex, await fetchOptionalPrivateIndex());
  if (
    index.schemaVersion !== 2 ||
    !Array.isArray(index.routines) ||
    !isObject(index.blocks) ||
    !isObject(index.mediaPacks) ||
    typeof index.defaultMediaPack !== 'string'
  ) {
    throw new Error('data/content-index.json is not schemaVersion 2');
  }

  const mediaPackEntries = await Promise.all(
    Object.entries(index.mediaPacks)
      .filter(([id]) => id !== VISUAL_PACK_GIF_V1)
      .map(async ([id, file]) => {
      const pack = await fetchJson(file);
      if (!isObject(pack) || pack.id !== id || pack.kind !== 'mediaPack') {
        throw new Error(`Media pack ${id} does not match ${file}`);
      }
      if (file.startsWith('private-packs/') && !privatePackAssetsAreRelative(pack)) {
        throw new Error(`Private media pack ${id} contains an unsafe asset path`);
      }
      return [id, file.startsWith('private-packs/') ? { ...pack, __sourcePath: file } : pack];
      }),
  );
  mediaPacks = new Map(mediaPackEntries);
  contentIndex = index;
  currentSettings = settingsStore.load();
  populateSettingsOptions();
  selectedMediaPack = null;
  renderSettings(currentSettings);

  const blockEntries = await Promise.all(
    Object.entries(index.blocks).map(async ([id, file]) => [id, await fetchJson(file)]),
  );
  const blocks = new Map(blockEntries);
  const routineData = await Promise.all(index.routines.map((file) => fetchJson(file)));

  routines = routineData.map((routine, routineIndex) => {
    const intervals = routine.sequence.flatMap((item) => {
      if (item.interval) return [item.interval];
      const block = blocks.get(item.blockId);
      if (!block) throw new Error(`Routine ${routine.id} references unknown block ${item.blockId}`);
      return block.intervals;
    });
    return {
      ...routine,
      file: index.routines[routineIndex],
      intervals,
    };
  });

  selectedRoutine = routines[0] ?? null;
  voiceCues.setIntervals(selectedRoutine?.intervals ?? []);
  startVoicePackLoad();
  renderSettings(currentSettings);
  renderRoutineList();
  return index;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function renderRoutineList() {
  const rows = routines.map((routine, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'routine-row';
    button.setAttribute('aria-label', `Start ${routine.title}`);
    button.setAttribute('aria-pressed', String(routine === selectedRoutine));
    button.dataset.routineIndex = String(index);

    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.className = 'routine-row__title';
    title.textContent = routine.title;
    const meta = document.createElement('span');
    meta.className = 'routine-row__meta';
    const creatorId = currentSettings.visuals.creatorId;
    const coverage = routineCreatorCoverage(routine, creatorId);
    const coverageCreatorId = coverage.creatorId ?? creatorId;
    const coverageLabel = ` · ${coverage.covered}/${coverage.total} ${creatorLabel(coverageCreatorId)}`;
    meta.textContent = `${formatDuration(routine.estimatedDurationSeconds)} · ${routine.intervals.length} intervals${coverageLabel}`;
    const equipment = document.createElement('span');
    equipment.className = 'routine-row__equipment';
    equipment.textContent = routine.equipment.join(' · ');
    copy.append(title, meta, equipment);

    const arrow = document.createElement('span');
    arrow.className = 'routine-row__arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = 'Start ▶';
    button.append(copy, arrow);
    return button;
  });
  elements.routineList.replaceChildren(...rows);
}

function renderHistory() {
  if (!hasDocument) return;
  const entries = loadWorkoutHistory();
  const calendar = buildMonthCalendar(historyMonth, entries);
  const today = formatDateKey(new Date());
  const streak = currentStreak(entries);
  const summary = historySummary(entries);

  elements.historyStreak.textContent = String(streak);
  elements.historyStreak.parentElement?.setAttribute(
    'aria-label',
    `Current consecutive-day streak: ${streak} ${streak === 1 ? 'day' : 'days'}`,
  );
  elements.historyMonthLabel.textContent = calendar.label;

  const cells = calendar.cells.map((cell) => {
    const element = document.createElement('span');
    element.className = 'history-calendar__cell';
    if (!cell.inMonth) element.classList.add('history-calendar__cell--outside');
    if (cell.date === today) element.classList.add('history-calendar__cell--today');
    if (cell.completed) element.classList.add('history-calendar__cell--completed');
    if (cell.aborted) element.classList.add('history-calendar__cell--aborted');
    element.dataset.date = cell.date;
    element.dataset.inMonth = String(cell.inMonth);
    element.setAttribute('role', 'gridcell');
    const status = cell.completed ? 'workout completed' : cell.aborted ? 'workout ended early' : 'no workout';
    element.setAttribute('aria-label', `${cell.date}: ${status}`);
    element.textContent = String(cell.day);
    return element;
  });
  elements.historyCalendar.replaceChildren(...cells);

  const completedLabel = `${summary.completed} completed ${summary.completed === 1 ? 'workout' : 'workouts'}`;
  const abortedLabel = summary.aborted > 0
    ? ` · ${summary.aborted} ended early`
    : '';
  elements.historySummary.textContent = summary.completed > 0 || summary.aborted > 0
    ? `${completedLabel}${abortedLabel}`
    : 'No completed workouts yet.';
}

function shiftHistoryMonth(delta) {
  historyMonth = new Date(historyMonth.getFullYear(), historyMonth.getMonth() + delta, 1);
  renderHistory();
}

function activeRoutineHistoryId() {
  if (typeof activeRoutine?.id === 'string' && activeRoutine.id.trim() !== '') return activeRoutine.id;
  if (typeof activeRoutine?.title === 'string' && activeRoutine.title.trim() !== '') return activeRoutine.title;
  return 'workout';
}

function recordFinishedWorkout() {
  if (!activeRoutine) return;
  appendWorkoutHistory({ routine: activeRoutineHistoryId(), finished: true });
  renderHistory();
}

function recordAbortedWorkout(snapshot) {
  if (!activeRoutine || !snapshot) return;
  appendWorkoutHistory({
    routine: activeRoutineHistoryId(),
    abortedAtInterval: Math.max(1, snapshot.intervalNumber),
  });
  renderHistory();
}

function createPackOptions(select, ids, unavailableIds = new Set()) {
  const options = ids.map((packId) => {
    const option = document.createElement('option');
    option.value = packId;
    option.textContent = unavailableIds.has(packId)
      ? `${settingsPackLabel(packId)} · not installed`
      : settingsPackLabel(packId);
    return option;
  });
  select.replaceChildren(...options);
}

function populateSettingsOptions() {
  if (!hasDocument) return;
  createPackOptions(elements.cuePack, CUE_PACK_IDS);
  createPackOptions(elements.voicePack, VOICE_PACK_IDS);
}

function availableCreators() {
  const creators = new Map();
  for (const pack of mediaPacks.values()) {
    for (const [creatorId, creator] of Object.entries(pack?.creators ?? {})) {
      if (!isApprovedCreatorId(creatorId)) continue;
      if (creator?.selectable !== true) continue;
      if (!packHasCreatorVideo(pack, creatorId)) continue;
      const name = typeof creator?.name === 'string' && creator.name.trim()
        ? creator.name.trim()
        : creatorId;
      creators.set(creatorId, { id: creatorId, name });
    }
  }
  return [...creators.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function populateCreatorOptions(selectedId = CREATOR_AUTO) {
  const options = [{ id: CREATOR_AUTO, name: 'Automatic · best available' }, ...availableCreators()]
    .map(({ id, name }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = name;
      return option;
    });
  elements.creator.replaceChildren(...options);
  elements.creator.value = options.some((option) => option.value === selectedId)
    ? selectedId
    : CREATOR_AUTO;
}

export function routineCreatorCoverage(routine, creatorId = CREATOR_AUTO) {
  const packId = chooseRoutineMediaPackId(routine, mediaPacks, creatorId);
  const pack = packId ? selectMediaPack(packId) : null;
  const selectedCreatorId = playbackCreatorId(routine, pack, creatorId);
  return {
    ...creatorCoverageForRoutine(routine, pack, selectedCreatorId),
    creatorId: selectedCreatorId,
  };
}

function creatorLabel(creatorId) {
  if (creatorId === CREATOR_AUTO) return 'Automatic';
  return availableCreators().find((creator) => creator.id === creatorId)?.name ?? creatorId;
}

function volumeLabel(value) {
  return `${Math.round(value * 100)}%`;
}

function renderSettings(settings) {
  if (!hasDocument) return;
  const normalized = appSettings(settings);
  const summary = summarizeSettings(normalized);
  elements.settingsSummaryStatus.textContent = summary.label;
  elements.cuePack.value = normalized.cues.packId;
  elements.cuesEnabled.checked = normalized.cues.enabled;
  elements.cuesVolume.value = String(normalized.cues.volume);
  elements.cuesVolumeOutput.textContent = volumeLabel(normalized.cues.volume);
  elements.cuesCountdown.checked = normalized.cues.countdown;
  elements.cuesHalfway.checked = normalized.cues.halfway;
  elements.voicePack.value = normalized.voice.packId;
  elements.voiceEnabled.checked = normalized.voice.enabled;
  elements.voiceVolume.value = String(normalized.voice.volume);
  elements.voiceVolumeOutput.textContent = volumeLabel(normalized.voice.volume);
  elements.voiceExercise.checked = normalized.voice.exercise;
  elements.voiceSide.checked = normalized.voice.side;
  elements.voiceNext.checked = normalized.voice.next;
  populateCreatorOptions(normalized.visuals.creatorId);
  elements.reducedMotion.checked = normalized.visuals.reducedMotion;

  if (!contentIndex?.privateMediaPackIndexPath) {
    elements.mediaStatus.textContent = 'No video library is installed; written movement guidance will be shown.';
  } else if (normalized.visuals.creatorId === CREATOR_AUTO) {
    const coverage = routineCreatorCoverage(selectedRoutine, normalized.visuals.creatorId);
    const winner = coverage.creatorId ? `${creatorLabel(coverage.creatorId)} only` : 'no creator clip selected';
    elements.mediaStatus.textContent = `Automatic · ${winner} · ${coverage.covered}/${coverage.total} movements in ${selectedRoutine?.title ?? 'this workout'}. Text-only intervals stay cue-only; missing clips stay visibly missing.`;
  } else {
    const coverage = routineCreatorCoverage(selectedRoutine, normalized.visuals.creatorId);
    elements.mediaStatus.textContent = `${creatorLabel(normalized.visuals.creatorId)} only · ${coverage.covered}/${coverage.total} movements in ${selectedRoutine?.title ?? 'this workout'}. Missing clips stay visibly missing.`;
  }
}

function persistSettings(patch) {
  currentSettings = settingsStore.update(patch);
  audioCues.setSettings(currentSettings);
  voiceCues.setSettings(currentSettings);
  startVoicePackLoad();
  if (patch?.visuals) {
    applySelectedMediaPack();
    renderRoutineList();
    if (contentIndex) void prepareOffline(contentIndex).catch(showError);
  }
  renderSettings(currentSettings);
}

function applySelectedMediaPack() {
  const packId = chooseRoutineMediaPackId(selectedRoutine, mediaPacks, currentSettings.visuals.creatorId);
  selectedMediaPack = packId ? selectMediaPack(packId) : null;
  if (selectedMediaPack) applyOutputFrame(selectedMediaPack);
}

function bindSettingsControls(listenerOptions) {
  populateSettingsOptions();
  renderSettings(currentSettings);

  elements.cuePack.addEventListener('change', (event) => {
    persistSettings({ cues: { packId: event.currentTarget.value } });
  }, listenerOptions);
  elements.cuesEnabled.addEventListener('change', (event) => {
    persistSettings({ cues: { enabled: event.currentTarget.checked } });
  }, listenerOptions);
  elements.cuesVolume.addEventListener('input', (event) => {
    persistSettings({ cues: { volume: event.currentTarget.valueAsNumber } });
  }, listenerOptions);
  elements.cuesCountdown.addEventListener('change', (event) => {
    persistSettings({ cues: { countdown: event.currentTarget.checked } });
  }, listenerOptions);
  elements.cuesHalfway.addEventListener('change', (event) => {
    persistSettings({ cues: { halfway: event.currentTarget.checked } });
  }, listenerOptions);

  elements.voicePack.addEventListener('change', (event) => {
    persistSettings({ voice: { packId: event.currentTarget.value } });
  }, listenerOptions);
  elements.voiceEnabled.addEventListener('change', (event) => {
    persistSettings({ voice: { enabled: event.currentTarget.checked } });
  }, listenerOptions);
  elements.voiceVolume.addEventListener('input', (event) => {
    persistSettings({ voice: { volume: event.currentTarget.valueAsNumber } });
  }, listenerOptions);
  elements.voiceExercise.addEventListener('change', (event) => {
    persistSettings({ voice: { exercise: event.currentTarget.checked } });
  }, listenerOptions);
  elements.voiceSide.addEventListener('change', (event) => {
    persistSettings({ voice: { side: event.currentTarget.checked } });
  }, listenerOptions);
  elements.voiceNext.addEventListener('change', (event) => {
    persistSettings({ voice: { next: event.currentTarget.checked } });
  }, listenerOptions);

  elements.creator.addEventListener('change', (event) => {
    persistSettings({ visuals: { creatorId: event.currentTarget.value } });
  }, listenerOptions);

  elements.reducedMotion.addEventListener('change', (event) => {
    persistSettings({ visuals: { reducedMotion: event.currentTarget.checked } });
  }, listenerOptions);
}

function setButtonLabel(button, label) {
  const span = button.querySelector('span');
  if (span) span.textContent = label;
}

function clearWorkoutHudTimeout() {
  if (workoutHudTimeout !== null) clearTimeout(workoutHudTimeout);
  workoutHudTimeout = null;
}

function setWorkoutHudVisible(visible) {
  if (!hasDocument) return;
  elements.workout.dataset.hud = visible ? 'visible' : 'timer';
}

function revealWorkoutHud({ temporary = true } = {}) {
  if (!hasDocument) return;
  clearWorkoutHudTimeout();
  setWorkoutHudVisible(true);
  if (!temporary) return;
  workoutHudTimeout = setTimeout(() => {
    workoutHudTimeout = null;
    const state = engine?.getSnapshot().state;
    if (state && !['paused', 'done'].includes(state)) setWorkoutHudVisible(false);
  }, WORKOUT_HUD_DURATION_MS);
}

function setPauseControl(state) {
  const paused = state === 'paused';
  setButtonLabel(elements.pause, paused ? 'Resume' : 'Pause');
  const path = elements.pause.querySelector('path');
  if (path) path.setAttribute('d', paused ? 'M8 5v14l11-7L8 5Z' : 'M7 5h3v14H7zM14 5h3v14h-3z');
}

function applyNavigationState(snapshot) {
  const navigation = workoutNavigationState(snapshot);
  elements.back.disabled = navigation.previousDisabled;
  elements.end.disabled = !navigation.endEnabled;
  elements.controls.hidden = !navigation.activeControlsVisible;
  elements.completionActions.hidden = !navigation.completionActionsVisible;
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
}

function reducedMotionPreferred() {
  return currentSettings.visuals.reducedMotion
    || typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function applyFraming(element, visual) {
  element.style.display = 'block';
  element.style.width = '100%';
  element.style.height = '100%';
  // Workout playback is a full-frame, landscape surface. Keep the complete
  // source visible even when a pack carries older crop/zoom metadata; only a
  // deliberate anatomical mirror is allowed to transform the pixels.
  element.style.objectFit = 'contain';
  element.style.objectPosition = 'center';
  element.style.transform = `scaleX(${visual.mirror ? -1 : 1})`;
  element.dataset.anatomicalSide = visual.anatomicalSide ?? 'unspecified';
  element.dataset.mirroring = visual.mirror ? 'mirrored' : 'source';
}

function textVisualNode(label, videoNeeded = true) {
  const text = document.createElement('p');
  text.className = 'movement-stage__text';
  text.dataset.videoStatus = videoNeeded ? 'missing' : 'text-only';
  text.textContent = videoNeeded ? `Video needed · ${label}` : label;
  return text;
}

function trackOwnedBlobUrl(node, asset) {
  if (asset?.ownedBlobUrl !== true || typeof asset.url !== 'string' || !asset.url.startsWith('blob:')) return;
  const urls = ownedBlobUrls.get(node) ?? new Set();
  urls.add(asset.url);
  ownedBlobUrls.set(node, urls);
}

function revokeOwnedBlobUrls(node) {
  const urls = ownedBlobUrls.get(node);
  if (!urls) return;
  for (const url of urls) {
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  }
  ownedBlobUrls.delete(node);
}

function cleanupMediaNode(node) {
  if (node?.nodeName?.toLowerCase() === 'video') {
    node.pause();
    node.removeAttribute('src');
    node.removeAttribute('poster');
    node.load();
  }
  revokeOwnedBlobUrls(node);
}

function disposeStageVisuals() {
  for (const cleanup of [...stageNodeCleanups]) cleanup();
  stageNodeCleanups.clear();
  if (elements.stage) elements.stage.replaceChildren();
}

function playVideo(node, onFailure) {
  try {
    const playback = node.play();
    if (playback && typeof playback.catch === 'function') playback.catch(onFailure);
  } catch {
    onFailure();
  }
}

function createVisualNode(movement, interval, selection, candidateIndex = 0) {
  const asset = selection.candidates[candidateIndex];
  if (!asset) return textVisualNode(selection.label, selection.videoNeeded !== false);
  const visual = {
    ...selection,
    asset,
    kind: mediaKind(asset.type) ?? 'text',
    framing: resolveFraming(selectedMediaPack, asset),
    mirror: shouldMirror(selection.entry, interval?.side, asset),
  };
  if (visual.kind === 'text') return textVisualNode(selection.label, selection.videoNeeded !== false);
  if (reducedMotionPreferred() && asset.type !== 'poster') {
    const posterIndex = selection.candidates.findIndex((candidate) => candidate.type === 'poster');
    return posterIndex >= 0
      ? createVisualNode(movement, interval, selection, posterIndex)
      : textVisualNode(selection.label, selection.videoNeeded !== false);
  }

  const node = visual.kind === 'video'
    ? document.createElement('video')
    : document.createElement('img');
  node.className = 'movement-stage__media';
  node.dataset.mediaType = asset.type;
  node.alt = selection.label;
  node.decoding = 'async';
  applyFraming(node, visual);

  let disposed = false;
  let onError;
  let onCanPlay;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (onError) node.removeEventListener('error', onError);
    if (onCanPlay) node.removeEventListener('canplay', onCanPlay);
    videoPlaybackFailures.delete(node);
    stageNodeCleanups.delete(dispose);
    cleanupMediaNode(node);
  };

  const fallback = () => {
    if (disposed || !node.isConnected) return;
    const replacement = createVisualNode(movement, interval, selection, candidateIndex + 1);
    dispose();
    node.replaceWith(replacement);
  };
  onError = fallback;
  node.addEventListener('error', onError, { once: true });

  if (visual.kind === 'video') {
    node.muted = true;
    node.defaultMuted = true;
    node.autoplay = !reducedMotionPreferred();
    node.loop = true;
    node.playsInline = true;
    node.controls = false;
    node.preload = 'metadata';
    const poster = selection.candidates.find((candidate) => candidate.type === 'poster');
    if (poster) {
      node.poster = resolvePackAssetUrl(selectedMediaPack, poster.url, poster);
      trackOwnedBlobUrl(node, poster);
    }
    videoPlaybackFailures.set(node, fallback);
    onCanPlay = () => {
      if (node.autoplay && !reducedMotionPreferred()) playVideo(node, fallback);
    };
    node.addEventListener('canplay', onCanPlay, { once: true });
  }
  trackOwnedBlobUrl(node, asset);
  stageNodeCleanups.add(dispose);
  node.src = resolvePackAssetUrl(selectedMediaPack, asset.url, asset);
  return node;
}

function replayCurrentVideos() {
  if (reducedMotionPreferred() || !elements.stage) return;
  for (const node of elements.stage.querySelectorAll('video')) {
    if (!node.autoplay) continue;
    playVideo(node, videoPlaybackFailures.get(node) ?? (() => {}));
  }
}

function startWorkout(routine) {
  stopAnimationLoop();
  clearWorkoutHudTimeout();
  const routinePackId = chooseRoutineMediaPackId(routine, mediaPacks, currentSettings.visuals.creatorId);
  const routinePack = routinePackId ? selectMediaPack(routinePackId) : null;
  const mediaPackChanged = routinePack && routinePack.id !== selectedMediaPack?.id;
  if (routinePack) {
    selectedMediaPack = routinePack;
    applyOutputFrame(selectedMediaPack);
  }
  activeRoutine = routine;
  voiceCues.setIntervals(routine.intervals);
  engine = new IntervalEngine(routine.intervals);
  engine.subscribe((event) => {
    const voiceAllowsCountdown = voiceCues.handle(event);
    if (event.type === 'done') recordFinishedWorkout();
    if (event.type === 'done') voiceCues.clear();
    if (event.type === 'tick') renderWorkout(event.snapshot);
    else if (event.type === 'countdown321') {
      if (voiceAllowsCountdown) audioCues.handle(event);
    } else {
      audioCues.handle(event);
    }
  });
  renderedInterval = null;
  renderedPhase = null;
  elements.home.hidden = true;
  elements.workout.hidden = false;
  elements.endConfirmation.hidden = true;
  elements.controls.hidden = false;
  elements.completionActions.hidden = true;
  document.documentElement.dataset.phase = 'work';
  document.documentElement.dataset.screen = 'workout';
  elements.workout.dataset.confirmation = 'closed';
  elements.workout.dataset.workoutState = 'ready';
  setWorkoutHudVisible(true);
  engine.start();
  requestWakeLock();
  startAnimationLoop();
  if (mediaPackChanged && contentIndex) void prepareOffline(contentIndex).catch(showError);
}

function startRoutineFromUserGesture(routine) {
  if (!routine || routineStartPending) return;
  routineStartPending = true;
  selectedRoutine = routine;
  voiceCues.setIntervals(routine.intervals);
  renderRoutineList();
  elements.routineList.setAttribute('aria-busy', 'true');
  requestWakeLock();
  void Promise.all([audioCues.unlock(), voiceCues.unlock()])
    .catch(showError)
    .finally(() => {
      routineStartPending = false;
      elements.routineList.removeAttribute('aria-busy');
      startWorkout(routine);
    });
}

function startAnimationLoop() {
  if (animationFrame !== null) return;
  const frame = () => {
    animationFrame = null;
    if (!engine || !['work', 'rest'].includes(engine.getSnapshot().state)) return;
    engine.update();
    animationFrame = requestAnimationFrame(frame);
  };
  animationFrame = requestAnimationFrame(frame);
}

function stopAnimationLoop() {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
}

function calculateWorkoutProgress(snapshot) {
  if (!activeRoutine) return 0;
  if (snapshot.state === 'done') return 1;

  const completed = activeRoutine.intervals
    .slice(0, snapshot.intervalIndex)
    .reduce((total, interval) => total + interval.workSeconds + interval.restSeconds, 0);
  const interval = snapshot.currentInterval;
  if (!interval || !snapshot.phase) return completed / activeRoutine.estimatedDurationSeconds;

  const phaseElapsedMs = snapshot.phaseDurationMs * snapshot.phaseProgress;
  const currentElapsedSeconds = snapshot.phase === 'rest'
    ? interval.workSeconds + phaseElapsedMs / 1000
    : phaseElapsedMs / 1000;
  return Math.min(1, (completed + currentElapsedSeconds) / activeRoutine.estimatedDurationSeconds);
}

function movementForSnapshot(snapshot) {
  if (!activeRoutine || !snapshot.currentInterval) return null;
  if (snapshot.phase === 'rest' && snapshot.intervalIndex + 1 < activeRoutine.intervals.length) {
    return activeRoutine.intervals[snapshot.intervalIndex + 1];
  }
  return snapshot.currentInterval;
}

function renderMovement(interval) {
  disposeStageVisuals();
  if (!interval) {
    const done = textVisualNode('Workout complete');
    elements.stage.dataset.count = '1';
    elements.stage.replaceChildren(done);
    return;
  }

  const movementSelections = interval.movements.map((movement) => ({
    movement,
    selection: resolveMovementVisual({ ...movement, displayName: interval.displayName }, selectedMediaPack, {
      reducedMotion: reducedMotionPreferred(),
      requestedSide: interval.side,
      creatorId: playbackCreatorId(activeRoutine ?? selectedRoutine, selectedMediaPack, currentSettings.visuals.creatorId),
    }),
  }));
  const uniqueSelections = deduplicateVisualSelections(
    movementSelections.map(({ selection }) => selection),
  );
  const visuals = uniqueSelections.map((selection) => {
    const { movement } = movementSelections.find((item) => item.selection === selection);
    return createVisualNode(movement, interval, selection);
  });
  elements.stage.dataset.count = String(visuals.length);
  elements.stage.replaceChildren(...visuals);
}

function renderWorkout(snapshot) {
  const phase = snapshot.state === 'paused' ? 'paused' : snapshot.state;
  const displayInterval = movementForSnapshot(snapshot);
  document.documentElement.dataset.phase = phase;
  elements.workout.dataset.workoutState = snapshot.state;

  const labels = { work: 'WORK', rest: 'REST', paused: 'PAUSED', done: 'DONE', idle: 'READY' };
  elements.phase.textContent = labels[phase] ?? phase.toUpperCase();
  elements.timer.textContent = formatDuration(snapshot.remainingSeconds);
  elements.intervalCount.textContent = `${snapshot.intervalNumber} / ${snapshot.totalIntervals}`;

  const showingNext = snapshot.phase === 'rest' && snapshot.intervalIndex + 1 < activeRoutine.intervals.length;
  const renderKey = displayInterval ? snapshot.intervalIndex + (showingNext ? 1 : 0) : -1;
  const movementChanged = renderedInterval !== renderKey || renderedPhase !== snapshot.phase;
  if (movementChanged) {
    renderMovement(displayInterval);
    renderedInterval = renderKey;
    renderedPhase = snapshot.phase;
  }

  if (snapshot.state === 'paused' || snapshot.state === 'done') {
    clearWorkoutHudTimeout();
    setWorkoutHudVisible(true);
  } else if (movementChanged) {
    revealWorkoutHud();
  }

  if (snapshot.state === 'done') {
    elements.exerciseTitle.textContent = 'Workout complete';
    elements.coachNote.textContent = 'Nice work. You finished every interval.';
    elements.nextUp.textContent = '30 minutes · complete';
    releaseWakeLock();
    stopAnimationLoop();
  } else if (displayInterval) {
    elements.exerciseTitle.textContent = displayInterval.displayName;
    elements.coachNote.textContent = displayInterval.coachNote ?? '';
    const next = activeRoutine.intervals[snapshot.intervalIndex + 1];
    elements.nextUp.replaceChildren();
    if (next) {
      const lead = document.createElement('strong');
      lead.textContent = snapshot.phase === 'rest' ? 'Up now' : 'Next';
      elements.nextUp.append(lead, document.createTextNode(` · ${next.displayName}`));
    } else {
      elements.nextUp.textContent = 'Final interval';
    }
    setPauseControl(snapshot.state);
  }

  elements.next.disabled = !WORKOUT_STATES.has(snapshot.state);
  applyNavigationState(snapshot);

  const progress = calculateWorkoutProgress(snapshot);
  const percent = Math.round(progress * 100);
  elements.progressFill.style.width = `${progress * 100}%`;
  elements.progressTrack.setAttribute('aria-valuenow', String(percent));
}

function routineIntervals(routine) {
  return Array.isArray(routine?.intervals) ? routine.intervals : [];
}

/**
 * Return only URLs needed to install the selected content set. Routine and
 * block JSON remains available for the offline picker, but media assets are
 * reached through movement IDs in those installed routines and the selected
 * pack only. Unreferenced pack entries and the exercise catalog are excluded.
 */
export function collectContentUrls(
  index,
  installedRoutines = routines,
  mediaPack = selectedMediaPack,
  installedVoicePack = voicePack,
  { creatorId = CREATOR_AUTO } = {},
) {
  const files = new Set(['data/content-index.json']);
  const installed = Array.isArray(installedRoutines) ? installedRoutines : [];

  for (const routine of installed) {
    if (routine.file) files.add(routine.file);
    for (const item of routine.sequence ?? []) {
      if (item.blockId && index.blocks?.[item.blockId]) files.add(index.blocks[item.blockId]);
    }
  }

  const packId = mediaPack?.id;
  const packFile = packId && index.mediaPacks?.[packId];
  const packFiles = new Set();
  if (packFile) packFiles.add(packFile);
  for (const file of packFiles) files.add(file);
  if ([...packFiles].some((file) => file.startsWith('private-packs/')) && index.privateMediaPackIndexPath) {
    files.add(index.privateMediaPackIndexPath);
  }
  for (const routine of installed) {
    const selectedCreatorId = playbackCreatorId(routine, mediaPack, creatorId);
    const movementIds = new Set(routineMovements(routine).map((movement) => movement.movementId));
    for (const movementId of movementIds) {
      const entry = mediaPack?.entries?.[movementId];
      for (const asset of entry?.assets ?? []) {
        if (typeof asset.url !== 'string') continue;
        if (asset.enabled === false) continue;
        if (!assetMatchesCreator(asset, selectedCreatorId, mediaPack)) continue;
        const sourcePath = asset.__sourcePath;
        if (typeof sourcePath === 'string' && sourcePath.startsWith('private-packs/')) {
          try {
            const resolved = new URL(asset.url, new URL(sourcePath, 'http://fittimer-content.local/'));
            if (resolved.origin === 'http://fittimer-content.local') files.add(resolved.pathname.replace(/^\//, ''));
          } catch {
            // Ignore malformed optional private assets; written guidance remains visible.
          }
        } else {
          files.add(asset.url);
        }
      }
    }
  }
  if (installedVoicePack?.id === VOICE_PACK_FRANKENTTS_V1) {
    files.add('data/voice/voice-pack-v1.json');
    for (const phrase of installedVoicePack.phrases ?? []) {
      if (typeof phrase.asset?.url === 'string') files.add(phrase.asset.url);
    }
  }
  return [...files];
}

function resumePausedWorkout() {
  if (!engine || engine.getSnapshot().state !== 'paused') return false;
  if (!engine.resume()) return false;
  revealWorkoutHud();
  requestWakeLock();
  startAnimationLoop();
  return true;
}

function openEndConfirmation() {
  if (!engine) return;
  const snapshot = engine.getSnapshot();
  if (!WORKOUT_STATES.has(snapshot.state)) return;

  if (snapshot.state !== 'paused') {
    voiceCues.clear({ resetAnnouncements: false });
    if (!engine.pause()) return;
    stopAnimationLoop();
  }
  releaseWakeLock();
  clearWorkoutHudTimeout();
  setWorkoutHudVisible(true);
  elements.workout.dataset.confirmation = 'open';
  elements.endConfirmation.hidden = false;
  elements.keepGoing.focus({ preventScroll: true });
}

function closeEndConfirmation({ resume = true } = {}) {
  elements.endConfirmation.hidden = true;
  elements.workout.dataset.confirmation = 'closed';
  if (resume) resumePausedWorkout();
  elements.end.focus({ preventScroll: true });
}

function restartCompletedWorkout() {
  if (!engine || !activeRoutine || engine.getSnapshot().state !== 'done') return;
  voiceCues.clear();
  voiceCues.setIntervals(activeRoutine.intervals);
  engine.restart();
  engine.start();
  requestWakeLock();
  startAnimationLoop();
}

function goHome() {
  releaseWakeLock();
  stopAnimationLoop();
  clearWorkoutHudTimeout();
  voiceCues.clear();
  disposeStageVisuals();
  engine = null;
  activeRoutine = null;
  routineStartPending = false;
  applySelectedMediaPack();
  elements.endConfirmation.hidden = true;
  elements.completionActions.hidden = true;
  elements.controls.hidden = false;
  elements.back.disabled = true;
  elements.end.disabled = true;
  elements.workout.hidden = true;
  elements.home.hidden = false;
  elements.next.disabled = false;
  elements.workout.dataset.confirmation = 'closed';
  elements.workout.dataset.workoutState = 'idle';
  setWorkoutHudVisible(true);
  document.documentElement.dataset.phase = 'home';
  document.documentElement.dataset.screen = 'home';
}

async function prepareOffline(index) {
  const status = elements.offline.querySelector('span:last-child');
  if (!('serviceWorker' in navigator)) {
    status.textContent = 'Offline install unavailable';
    return;
  }

  await navigator.serviceWorker.register('./sw.js');
  const registration = await navigator.serviceWorker.ready;
  const worker = registration.active;
  if (!worker) throw new Error('Service worker did not become active');

  const channel = new MessageChannel();
  const installedVoicePack = voicePack ?? await voicePackLoad ?? null;
  const acknowledgement = new Promise((resolve, reject) => {
    channel.port1.onmessage = ({ data }) => {
      if (data?.ok) resolve();
      else reject(new Error(data?.error ?? 'Could not cache workout content'));
    };
  });
  worker.postMessage({
    type: 'CACHE_CONTENT',
    urls: collectContentUrls(index, routines, selectedMediaPack, installedVoicePack, {
      creatorId: currentSettings.visuals.creatorId,
    }),
  }, [channel.port2]);
  try {
    await acknowledgement;
  } finally {
    channel.port1.close();
  }
  elements.offline.dataset.ready = 'true';
  status.textContent = 'Available offline';
}

if (hasDocument) {
  const pageLifetime = new AbortController();
  const listenerOptions = { signal: pageLifetime.signal };
  document.documentElement.dataset.screen = 'home';
  elements.workout.dataset.hud = 'visible';
  elements.workout.dataset.confirmation = 'closed';
  elements.workout.dataset.workoutState = 'idle';
  window.addEventListener('pagehide', () => {
    clearWorkoutHudTimeout();
    void voiceCues.dispose().catch(() => {});
    void wakeLockController.dispose();
    pageLifetime.abort();
  }, { once: true });
  bindSettingsControls(listenerOptions);
  renderHistory();

  elements.routineList.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[data-routine-index]') : null;
    if (!row) return;
    const routine = routines[Number(row.dataset.routineIndex)] ?? null;
    startRoutineFromUserGesture(routine);
  }, listenerOptions);

  elements.historyPreviousMonth.addEventListener('click', () => {
    shiftHistoryMonth(-1);
  }, listenerOptions);

  elements.historyNextMonth.addEventListener('click', () => {
    shiftHistoryMonth(1);
  }, listenerOptions);

  elements.workout.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button, a, input, select, textarea, [role="dialog"], .workout-controls, .completion-actions')) {
      return;
    }
    const snapshot = engine?.getSnapshot();
    if (snapshot && WORKOUT_STATES.has(snapshot.state)) revealWorkoutHud();
  }, listenerOptions);

  elements.pause.addEventListener('click', () => {
    if (!engine) return;
    const snapshot = engine.getSnapshot();
    if (snapshot.state === 'paused') {
      void voiceCues.resume().catch(showError);
      resumePausedWorkout();
    } else if (WORKOUT_STATES.has(snapshot.state)) {
      voiceCues.clear({ resetAnnouncements: false });
      engine.pause();
      stopAnimationLoop();
      releaseWakeLock();
    }
  }, listenerOptions);

  elements.back.addEventListener('click', () => {
    if (!engine) return;
    if (workoutNavigationState(engine.getSnapshot()).previousDisabled) return;
    voiceCues.clear();
    engine.skipBack();
    if (WORKOUT_STATES.has(engine.getSnapshot().state)) startAnimationLoop();
  }, listenerOptions);

  elements.next.addEventListener('click', () => {
    if (!engine) return;
    voiceCues.clear();
    engine.skipForward();
    if (engine.getSnapshot().state !== 'done') startAnimationLoop();
  }, listenerOptions);

  elements.end.addEventListener('click', openEndConfirmation, listenerOptions);

  elements.keepGoing.addEventListener('click', () => {
    closeEndConfirmation();
  }, listenerOptions);

  elements.confirmEnd.addEventListener('click', () => {
    if (engine) recordAbortedWorkout(engine.getSnapshot());
    goHome();
  }, listenerOptions);

  elements.completionHome.addEventListener('click', goHome, listenerOptions);
  elements.completionRestart.addEventListener('click', restartCompletedWorkout, listenerOptions);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.endConfirmation.hidden) {
      event.preventDefault();
      closeEndConfirmation();
    }
  }, listenerOptions);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && engine && ['work', 'rest'].includes(engine.getSnapshot().state)) {
      audioCues.resume().catch(showError);
      voiceCues.resume().catch(showError);
      const snapshot = engine.update();
      if (['work', 'rest'].includes(snapshot.state)) {
        requestWakeLock();
        replayCurrentVideos();
        startAnimationLoop();
      }
    }
  }, listenerOptions);

  try {
    const index = await loadContent();
    prepareOffline(index).catch(showError);
  } catch (error) {
    showError(error);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
