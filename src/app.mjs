import { IntervalEngine } from './interval-engine.mjs';
import { AudioCuePlayer } from './audio-cues.mjs';

const hasDocument = typeof document !== 'undefined';
const elements = hasDocument
  ? {
      home: document.querySelector('#home-screen'),
      workout: document.querySelector('#workout-screen'),
      routineList: document.querySelector('#routine-list'),
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
      back: document.querySelector('#back-button'),
      pause: document.querySelector('#pause-button'),
      next: document.querySelector('#next-button'),
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
let selectedMediaPack = null;
let engine = null;
let animationFrame = null;
let renderedInterval = null;
let renderedPhase = null;
const audioCues = new AudioCuePlayer();

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

function orderedAssets(entry, reducedMotion) {
  if (!Array.isArray(entry?.assets)) return [];
  const available = entry.assets.filter((asset) => MEDIA_TYPES.has(asset?.type) && typeof asset.url === 'string');
  const candidates = reducedMotion
    ? available.filter((asset) => asset.type === 'poster')
    : available;
  return [...candidates].sort((left, right) => MEDIA_PRIORITY.get(left.type) - MEDIA_PRIORITY.get(right.type));
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

  const candidates = orderedAssets(entry, reducedMotion);
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

function resolveUrl(relativePath) {
  return new URL(relativePath, hasDocument ? document.baseURI : 'http://localhost/').href;
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
  selectedMediaPack = mediaPacks.get(index.defaultMediaPack);
  if (!selectedMediaPack) {
    throw new Error(`Default media pack is unavailable: ${index.defaultMediaPack}`);
  }
  applyOutputFrame(selectedMediaPack);

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

function setButtonLabel(button, label) {
  const span = button.querySelector('span');
  if (span) span.textContent = label;
}

function setPauseControl(state) {
  const paused = state === 'paused';
  setButtonLabel(elements.pause, paused ? 'Resume' : state === 'done' ? 'Restart' : 'Pause');
  const path = elements.pause.querySelector('path');
  if (path) path.setAttribute('d', paused || state === 'done' ? 'M8 5v14l11-7L8 5Z' : 'M7 5h3v14H7zM14 5h3v14h-3z');
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
}

function reducedMotionPreferred() {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
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

  const node = visual.kind === 'video'
    ? document.createElement('video')
    : document.createElement('img');
  node.className = 'movement-stage__media';
  node.dataset.mediaType = asset.type;
  node.src = resolveUrl(asset.url);
  node.alt = selection.label;
  node.decoding = 'async';
  applyFraming(node, visual);

  const fallback = () => {
    if (!node.isConnected) return;
    node.replaceWith(createVisualNode(movement, interval, selection, candidateIndex + 1));
  };
  node.addEventListener('error', fallback, { once: true });

  if (visual.kind === 'video') {
    node.muted = true;
    node.defaultMuted = true;
    node.autoplay = !reducedMotionPreferred();
    node.loop = true;
    node.playsInline = true;
    node.controls = false;
    node.preload = 'metadata';
    const poster = selection.candidates.find((candidate) => candidate.type === 'poster');
    if (poster) node.poster = resolveUrl(poster.url);
    node.addEventListener('canplay', () => {
      if (node.autoplay) node.play().catch(fallback);
    }, { once: true });
  }
  return node;
}

function startWorkout(routine) {
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
  document.documentElement.dataset.phase = 'work';
  engine.start();
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
  if (!interval) {
    const done = textVisualNode('Workout complete');
    elements.stage.dataset.count = '1';
    elements.stage.replaceChildren(done);
    return;
  }

  const visuals = interval.movements.map((movement) => {
    const selection = resolveMovementVisual(movement, selectedMediaPack, {
      reducedMotion: reducedMotionPreferred(),
      requestedSide: interval.side,
    });
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
    setButtonLabel(elements.back, 'Home');
    setPauseControl('done');
    elements.next.disabled = true;
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
    setButtonLabel(elements.back, 'Back');
    setPauseControl(snapshot.state);
    elements.next.disabled = false;
  }

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

function goHome() {
  stopAnimationLoop();
  engine = null;
  activeRoutine = null;
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
  window.addEventListener('pagehide', () => pageLifetime.abort(), { once: true });

  elements.routineList.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[data-routine-index]') : null;
    if (!row) return;
    selectedRoutine = routines[Number(row.dataset.routineIndex)] ?? selectedRoutine;
    renderRoutineList();
  }, listenerOptions);

  elements.start.addEventListener('click', () => {
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
    if (snapshot.state === 'done') {
      engine.restart();
      engine.start();
      startAnimationLoop();
    } else if (snapshot.state === 'paused') {
      engine.resume();
      startAnimationLoop();
    } else {
      engine.pause();
      stopAnimationLoop();
    }
  }, listenerOptions);

  elements.back.addEventListener('click', () => {
    if (!engine) return;
    if (engine.getSnapshot().state === 'done') goHome();
    else engine.skipBack();
  }, listenerOptions);

  elements.next.addEventListener('click', () => {
    if (!engine) return;
    engine.skipForward();
    if (engine.getSnapshot().state !== 'done') startAnimationLoop();
  }, listenerOptions);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && engine && ['work', 'rest'].includes(engine.getSnapshot().state)) {
      audioCues.resume().catch(showError);
      engine.update();
      startAnimationLoop();
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
