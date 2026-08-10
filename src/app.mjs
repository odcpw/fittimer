import { IntervalEngine } from './interval-engine.mjs';
import { AudioCuePlayer } from './audio-cues.mjs';
import { createWakeLockController } from './wake-lock.mjs';
import {
  CUE_PACK_IDS,
  CUE_PACK_SYNTH_V1,
  VISUAL_PACK_IDS,
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
      visualPack: document.querySelector('#settings-visual-pack'),
      reducedMotion: document.querySelector('#settings-reduced-motion'),
      mediaStatus: document.querySelector('#settings-media-status'),
      start: document.querySelector('#start-button'),
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

let routines = [];
let selectedRoutine = null;
let activeRoutine = null;
let mediaPacks = new Map();
let contentIndex = null;
let selectedMediaPack = null;
let engine = null;
let animationFrame = null;
let renderedInterval = null;
let renderedPhase = null;
const stageNodeCleanups = new Set();
const videoPlaybackFailures = new WeakMap();
const ownedBlobUrls = new WeakMap();
const settingsStore = createSettingsStore(hasDocument ? undefined : null);
let currentSettings = settingsStore.load();
const audioCues = new AudioCuePlayer({ settings: currentSettings });
const wakeLockController = createWakeLockController();

const WORKOUT_STATES = new Set(['work', 'rest', 'paused']);

const SETTINGS_PACK_LABELS = new Map([
  [CUE_PACK_SYNTH_V1, 'Synth tones'],
  [VOICE_PACK_BROWSER_V1, 'Browser voice'],
  [VOICE_PACK_FRANKENTTS_V1, 'FrankenTTS voice'],
  [VISUAL_PACK_GIF_V1, 'GIFs'],
  [VISUAL_PACK_REFERENCE_V1, 'Reference pack'],
  [VISUAL_PACK_W1W4_V1, 'W1–W4 pack'],
]);

function requestWakeLock() {
  void wakeLockController.request();
}

function releaseWakeLock() {
  void wakeLockController.release();
}

function settingsPackLabel(packId) {
  return SETTINGS_PACK_LABELS.get(packId) ?? packId;
}

/**
 * Keep the home summary short while deriving every value from the versioned
 * settings contract instead of duplicating defaults in the UI.
 */
export function summarizeSettings(settings) {
  const normalized = normalizeSettings(settings);
  return Object.freeze({
    label: `${normalized.cues.enabled ? 'Sound on' : 'Sound off'} · ${settingsPackLabel(normalized.visuals.selectedPackId)}`,
    cueLabel: normalized.cues.enabled ? 'Sound on' : 'Sound off',
    visualLabel: settingsPackLabel(normalized.visuals.selectedPackId),
  });
}

/**
 * A valid preference may name a pack that is not installed in the current
 * content index. Keep that stable preference, but use the built-in pack for
 * rendering and offline caching until the requested pack is available.
 */
export function resolveMediaPackPreference(index, settings) {
  const normalized = normalizeSettings(settings);
  const available = isObject(index?.mediaPacks) ? index.mediaPacks : {};
  const requestedId = normalized.visuals.selectedPackId;
  const fallbackId = typeof index?.defaultMediaPack === 'string'
    ? index.defaultMediaPack
    : VISUAL_PACK_GIF_V1;
  const effectiveId = Object.hasOwn(available, requestedId)
    ? requestedId
    : Object.hasOwn(available, fallbackId)
      ? fallbackId
      : VISUAL_PACK_GIF_V1;
  return Object.freeze({ requestedId, effectiveId, isFallback: requestedId !== effectiveId });
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

function mediaKind(type) {
  if (type === 'video') return 'video';
  if (type === 'animated-webp' || type === 'gif' || type === 'poster') return 'image';
  return null;
}

function resolveFraming(mediaPack, asset) {
  if (!asset || !mediaPack) return null;
  if (typeof asset.framing === 'object' && asset.framing !== null) return asset.framing;
  if (typeof asset.framing !== 'string') return null;
  return mediaPack.framingProfiles?.[asset.framing] ?? null;
}

function shouldMirror(entry, requestedSide) {
  if (entry?.mirroring === 'always') return true;
  if (
    entry?.mirroring !== 'when-needed' ||
    !['left', 'right'].includes(requestedSide) ||
    !['left', 'right'].includes(entry.anatomicalSide)
  ) {
    return false;
  }
  return requestedSide !== entry.anatomicalSide;
}

function orderedAssets(entry, reducedMotion, requestedSide) {
  if (!Array.isArray(entry?.assets)) return [];
  const available = entry.assets.filter((asset) => MEDIA_TYPES.has(asset?.type) && resolveAssetUrl(asset?.url));
  const normalizedSide = requestedSide === undefined || requestedSide === null || requestedSide === ''
    ? null
    : String(requestedSide);
  const sideAware = normalizedSide === null
    ? available
    : available.filter((asset) => {
        const assetSide = asset?.side === undefined || asset?.side === null || asset?.side === ''
          ? null
          : String(asset.side);
        return assetSide === null || assetSide === normalizedSide;
      });
  const candidates = reducedMotion
    ? sideAware.filter((asset) => asset.type === 'poster')
    : sideAware;
  return [...candidates].sort((left, right) => {
    const mediaDifference = MEDIA_PRIORITY.get(left.type) - MEDIA_PRIORITY.get(right.type);
    if (mediaDifference !== 0 || normalizedSide === null) return mediaDifference;
    const leftSide = left.side === undefined || left.side === null || left.side === '' ? null : String(left.side);
    const rightSide = right.side === undefined || right.side === null || right.side === '' ? null : String(right.side);
    return Number(rightSide === normalizedSide) - Number(leftSide === normalizedSide);
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
  { reducedMotion = false, requestedSide = undefined } = {},
) {
  const label = typeof movement?.displayName === 'string' && movement.displayName.trim()
    ? movement.displayName
    : 'Movement';
  const movementId = typeof movement?.movementId === 'string' ? movement.movementId : null;
  const textResult = (reason) => ({
    kind: 'text',
    movementId,
    label,
    reason,
    candidates: [],
    fallback: 'text',
    mirror: false,
    framing: null,
  });

  if (movement?.textOnly === true) return textResult('text-only');
  const entry = movementId && isObject(mediaPack?.entries) ? mediaPack.entries[movementId] : null;
  if (!entry) return textResult('missing-pack-entry');

  const candidates = orderedAssets(entry, reducedMotion, requestedSide);
  if (candidates.length === 0) return textResult(reducedMotion ? 'no-poster' : 'empty-pack-entry');
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
    mirror: shouldMirror(entry, requestedSide),
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
    const resolvedUrl = resolveAssetUrl(assetUrl);
    if (!resolvedUrl) return true;
    if (seenUrls.has(resolvedUrl)) return false;
    seenUrls.add(resolvedUrl);
    return true;
  });
}

function resolveUrl(relativePath) {
  return new URL(relativePath, hasDocument ? document.baseURI : 'http://localhost/').href;
}

function resolveAssetUrl(assetUrl) {
  if (typeof assetUrl !== 'string' || assetUrl.trim() === '') return null;
  try {
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
  const index = await fetchJson('data/content-index.json');
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
    Object.entries(index.mediaPacks).map(async ([id, file]) => [id, await fetchJson(file)]),
  );
  mediaPacks = new Map(mediaPackEntries);
  contentIndex = index;
  populateSettingsOptions();
  const mediaPreference = resolveMediaPackPreference(index, currentSettings);
  selectedMediaPack = mediaPacks.get(mediaPreference.effectiveId);
  if (!selectedMediaPack) {
    throw new Error(`Default media pack is unavailable: ${index.defaultMediaPack}`);
  }
  applyOutputFrame(selectedMediaPack);
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
  renderRoutineList();
  elements.start.disabled = selectedRoutine === null;
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
    button.setAttribute('aria-pressed', String(routine === selectedRoutine));
    button.dataset.routineIndex = String(index);

    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.className = 'routine-row__title';
    title.textContent = routine.title;
    const meta = document.createElement('span');
    meta.className = 'routine-row__meta';
    meta.textContent = `${formatDuration(routine.estimatedDurationSeconds)} · ${routine.intervals.length} intervals`;
    const equipment = document.createElement('span');
    equipment.className = 'routine-row__equipment';
    equipment.textContent = routine.equipment.join(' · ');
    copy.append(title, meta, equipment);

    const arrow = document.createElement('span');
    arrow.className = 'routine-row__arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';
    button.append(copy, arrow);
    return button;
  });
  elements.routineList.replaceChildren(...rows);
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
  const unavailableVisuals = new Set(
    VISUAL_PACK_IDS.filter((packId) => contentIndex && !mediaPacks.has(packId)),
  );
  createPackOptions(elements.cuePack, CUE_PACK_IDS);
  createPackOptions(elements.voicePack, VOICE_PACK_IDS);
  createPackOptions(elements.visualPack, VISUAL_PACK_IDS, unavailableVisuals);
}

function volumeLabel(value) {
  return `${Math.round(value * 100)}%`;
}

function renderSettings(settings) {
  if (!hasDocument) return;
  const normalized = normalizeSettings(settings);
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
  elements.visualPack.value = normalized.visuals.selectedPackId;
  elements.reducedMotion.checked = normalized.visuals.reducedMotion;

  const mediaPreference = resolveMediaPackPreference(contentIndex, normalized);
  elements.mediaStatus.textContent = mediaPreference.isFallback
    ? `${settingsPackLabel(mediaPreference.requestedId)} is saved; built-in GIFs stay active until that pack is installed.`
    : `${settingsPackLabel(mediaPreference.effectiveId)} active.`;
}

function persistSettings(patch) {
  currentSettings = settingsStore.update(patch);
  audioCues.setSettings(currentSettings);
  if (patch?.visuals) {
    applySelectedMediaPack();
  }
  renderSettings(currentSettings);
}

function applySelectedMediaPack() {
  if (!contentIndex) return;
  const mediaPreference = resolveMediaPackPreference(contentIndex, currentSettings);
  const nextPack = mediaPacks.get(mediaPreference.effectiveId);
  if (!nextPack) return;
  selectedMediaPack = nextPack;
  applyOutputFrame(selectedMediaPack);
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

  elements.visualPack.addEventListener('change', (event) => {
    persistSettings({ visuals: { selectedPackId: event.currentTarget.value } });
  }, listenerOptions);
  elements.reducedMotion.addEventListener('change', (event) => {
    persistSettings({ visuals: { reducedMotion: event.currentTarget.checked } });
  }, listenerOptions);
}

function setButtonLabel(button, label) {
  const span = button.querySelector('span');
  if (span) span.textContent = label;
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
  const framing = visual.framing;
  if (!framing) return;
  element.style.display = 'block';
  element.style.width = '100%';
  element.style.height = '100%';
  element.style.objectFit = framing.fit;
  if (framing.anchor) {
    element.style.objectPosition = `${framing.anchor.x * 100}% ${framing.anchor.y * 100}%`;
  }
  const cropScale = framing.crop
    ? Math.max(1 / framing.crop.width, 1 / framing.crop.height)
    : 1;
  const zoom = (Number.isFinite(framing.zoom) ? framing.zoom : 1) * cropScale;
  element.style.transform = `scaleX(${visual.mirror ? -1 : 1}) scale(${zoom})`;
  element.dataset.anatomicalSide = visual.anatomicalSide ?? 'unspecified';
  element.dataset.mirroring = visual.mirror ? 'mirrored' : 'source';
}

function textVisualNode(label) {
  const text = document.createElement('p');
  text.className = 'movement-stage__text';
  text.textContent = label;
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
  if (!asset) return textVisualNode(selection.label);
  const visual = {
    ...selection,
    asset,
    kind: mediaKind(asset.type) ?? 'text',
    framing: resolveFraming(selectedMediaPack, asset),
  };
  if (visual.kind === 'text') return textVisualNode(selection.label);
  if (reducedMotionPreferred() && asset.type !== 'poster') {
    const posterIndex = selection.candidates.findIndex((candidate) => candidate.type === 'poster');
    return posterIndex >= 0
      ? createVisualNode(movement, interval, selection, posterIndex)
      : textVisualNode(selection.label);
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
      node.poster = resolveUrl(poster.url);
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
  node.src = resolveUrl(asset.url);
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
  activeRoutine = routine;
  engine = new IntervalEngine(routine.intervals);
  engine.subscribe((event) => {
    if (event.type === 'tick') renderWorkout(event.snapshot);
    else audioCues.handle(event);
  });
  renderedInterval = null;
  renderedPhase = null;
  elements.home.hidden = true;
  elements.workout.hidden = false;
  elements.endConfirmation.hidden = true;
  elements.controls.hidden = false;
  elements.completionActions.hidden = true;
  document.documentElement.dataset.phase = 'work';
  engine.start();
  requestWakeLock();
  startAnimationLoop();
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
    selection: resolveMovementVisual(movement, selectedMediaPack, {
      reducedMotion: reducedMotionPreferred(),
      requestedSide: interval.side,
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

  const labels = { work: 'WORK', rest: 'REST', paused: 'PAUSED', done: 'DONE', idle: 'READY' };
  elements.phase.textContent = labels[phase] ?? phase.toUpperCase();
  elements.timer.textContent = formatDuration(snapshot.remainingSeconds);
  elements.intervalCount.textContent = `${snapshot.intervalNumber} / ${snapshot.totalIntervals}`;

  const showingNext = snapshot.phase === 'rest' && snapshot.intervalIndex + 1 < activeRoutine.intervals.length;
  const renderKey = displayInterval ? snapshot.intervalIndex + (showingNext ? 1 : 0) : -1;
  if (renderedInterval !== renderKey || renderedPhase !== snapshot.phase) {
    renderMovement(displayInterval);
    renderedInterval = renderKey;
    renderedPhase = snapshot.phase;
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
export function collectContentUrls(index, installedRoutines = routines, mediaPack = selectedMediaPack) {
  const files = new Set(['data/content-index.json']);
  const installed = Array.isArray(installedRoutines) ? installedRoutines : [];

  const movementIds = new Set();
  for (const routine of installed) {
    if (routine.file) files.add(routine.file);
    for (const item of routine.sequence ?? []) {
      if (item.blockId && index.blocks?.[item.blockId]) files.add(index.blocks[item.blockId]);
    }
    for (const interval of routineIntervals(routine)) {
      for (const movement of interval.movements ?? []) {
        if (movement.movementId) movementIds.add(movement.movementId);
      }
    }
  }

  const packId = mediaPack?.id ?? index.defaultMediaPack;
  const packFile = packId && index.mediaPacks?.[packId];
  if (packFile) files.add(packFile);
  for (const movementId of movementIds) {
    const entry = mediaPack?.entries?.[movementId];
    for (const asset of entry?.assets ?? []) {
      if (typeof asset.url === 'string') files.add(asset.url);
    }
  }
  return [...files];
}

function resumePausedWorkout() {
  if (!engine || engine.getSnapshot().state !== 'paused') return false;
  if (!engine.resume()) return false;
  requestWakeLock();
  startAnimationLoop();
  return true;
}

function openEndConfirmation() {
  if (!engine) return;
  const snapshot = engine.getSnapshot();
  if (!WORKOUT_STATES.has(snapshot.state)) return;

  if (snapshot.state !== 'paused') {
    if (!engine.pause()) return;
    stopAnimationLoop();
  }
  releaseWakeLock();
  elements.endConfirmation.hidden = false;
  elements.keepGoing.focus({ preventScroll: true });
}

function closeEndConfirmation({ resume = true } = {}) {
  elements.endConfirmation.hidden = true;
  if (resume) resumePausedWorkout();
  elements.end.focus({ preventScroll: true });
}

function restartCompletedWorkout() {
  if (!engine || !activeRoutine || engine.getSnapshot().state !== 'done') return;
  engine.restart();
  engine.start();
  requestWakeLock();
  startAnimationLoop();
}

function goHome() {
  releaseWakeLock();
  stopAnimationLoop();
  disposeStageVisuals();
  engine = null;
  activeRoutine = null;
  elements.endConfirmation.hidden = true;
  elements.completionActions.hidden = true;
  elements.controls.hidden = false;
  elements.back.disabled = true;
  elements.end.disabled = true;
  elements.workout.hidden = true;
  elements.home.hidden = false;
  elements.next.disabled = false;
  document.documentElement.dataset.phase = 'home';
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
  const acknowledgement = new Promise((resolve, reject) => {
    channel.port1.onmessage = ({ data }) => {
      if (data?.ok) resolve();
      else reject(new Error(data?.error ?? 'Could not cache workout content'));
    };
  });
  worker.postMessage({
    type: 'CACHE_CONTENT',
    urls: collectContentUrls(index, routines, selectedMediaPack),
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
  window.addEventListener('pagehide', () => {
    void wakeLockController.dispose();
    pageLifetime.abort();
  }, { once: true });
  bindSettingsControls(listenerOptions);

  elements.routineList.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[data-routine-index]') : null;
    if (!row) return;
    selectedRoutine = routines[Number(row.dataset.routineIndex)] ?? selectedRoutine;
    renderRoutineList();
  }, listenerOptions);

  elements.start.addEventListener('click', () => {
    if (selectedRoutine) requestWakeLock();
    void audioCues
      .unlock()
      .catch(showError)
      .finally(() => {
        if (selectedRoutine) startWorkout(selectedRoutine);
      });
  }, listenerOptions);

  elements.pause.addEventListener('click', () => {
    if (!engine) return;
    const snapshot = engine.getSnapshot();
    if (snapshot.state === 'paused') {
      resumePausedWorkout();
    } else if (WORKOUT_STATES.has(snapshot.state)) {
      engine.pause();
      stopAnimationLoop();
      releaseWakeLock();
    }
  }, listenerOptions);

  elements.back.addEventListener('click', () => {
    if (!engine) return;
    if (workoutNavigationState(engine.getSnapshot()).previousDisabled) return;
    engine.skipBack();
    if (WORKOUT_STATES.has(engine.getSnapshot().state)) startAnimationLoop();
  }, listenerOptions);

  elements.next.addEventListener('click', () => {
    if (!engine) return;
    engine.skipForward();
    if (engine.getSnapshot().state !== 'done') startAnimationLoop();
  }, listenerOptions);

  elements.end.addEventListener('click', openEndConfirmation, listenerOptions);

  elements.keepGoing.addEventListener('click', () => {
    closeEndConfirmation();
  }, listenerOptions);

  elements.confirmEnd.addEventListener('click', () => {
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
