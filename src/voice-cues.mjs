import {
  VOICE_PACK_FRANKENTTS_V1,
  normalizeSettings,
} from './settings.mjs';

const DEFAULT_PACK_URL = 'data/voice/voice-pack-v1.json';
const DEFAULT_MAX_QUEUE = 64;
const DEFAULT_MAX_EVENT_LAG_MS = 500;
const DEFAULT_PACK_LOAD_TIMEOUT_MS = 1500;
const DEFAULT_CONTEXT_RESUME_TIMEOUT_MS = 500;
const COUNTDOWN_WINDOW_MS = 180;
const SIDE_IDS = new Map([
  ['left', 'side-left'],
  ['right', 'side-right'],
  ['alternating', 'side-alternating'],
  ['bilateral', 'side-bilateral'],
  ['first', 'side-first'],
  ['second', 'side-second'],
]);

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function defaultContextFactory() {
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error('WebAudio is unavailable in this browser');
  return new AudioContextClass({ latencyHint: 'interactive' });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return Number.isFinite(value);
}

function stableSlug(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/→/g, ' to ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

export function phraseIdForText(text, kind = 'movement') {
  const normalized = String(text);
  if (kind === 'control' && ['Go', 'Rest', 'Next'].includes(normalized)) return normalized.toLowerCase();
  if (kind === 'side' && SIDE_IDS.has(normalized.toLowerCase())) return SIDE_IDS.get(normalized.toLowerCase());
  if (kind === 'digit' && /^[1-3]$/.test(normalized)) return `digit-${normalized}`;
  return `movement-${stableSlug(normalized)}`;
}

export function normalizeVoiceSettings(value) {
  const source = isRecord(value) && isRecord(value.voice) ? value : { voice: value };
  return { ...normalizeSettings(source).voice };
}

function phraseFromInterval(interval) {
  if (!isRecord(interval)) return null;
  const text = typeof interval.displayName === 'string' ? interval.displayName.trim() : '';
  if (!text) return null;
  return {
    id: phraseIdForText(text),
    text,
    kind: 'movement',
  };
}

function sidePhrase(side) {
  if (typeof side !== 'string' || !SIDE_IDS.has(side)) return null;
  const text = side === 'alternating'
    ? 'Alternating sides'
    : side === 'bilateral'
      ? 'Both sides'
      : side === 'first'
        ? 'First side'
        : side === 'second'
          ? 'Second side'
          : side[0].toUpperCase() + side.slice(1);
  return { id: SIDE_IDS.get(side), text, kind: 'side' };
}

function controlPhrase(id, text) {
  return { id, text, kind: 'control' };
}

function packPhraseMap(pack) {
  if (!isRecord(pack) || !Array.isArray(pack.phrases)) return new Map();
  return new Map(pack.phrases
    .filter((phrase) => isRecord(phrase) && typeof phrase.id === 'string')
    .map((phrase) => [phrase.id, phrase]));
}

function responseIsOk(response) {
  return response && (response.ok === undefined || response.ok === true);
}

function utteranceFor(text) {
  const Utterance = globalThis.SpeechSynthesisUtterance;
  return typeof Utterance === 'function' ? new Utterance(text) : null;
}

/**
 * WebAudio voice queue for the finite, data-derived FitTimer phrase pack.
 * `unlock()` is the Start-gesture boundary. Nothing is sent to the browser
 * speech engine before that call.
 */
export class VoiceCueQueue {
  constructor({
    settings,
    voiceSettings,
    pack = null,
    packUrl = DEFAULT_PACK_URL,
    baseUrl = globalThis.document?.baseURI ?? globalThis.location?.href ?? null,
    fetchImpl = globalThis.fetch,
    contextFactory = defaultContextFactory,
    speechSynthesis = globalThis.speechSynthesis ?? null,
    utteranceFactory = utteranceFor,
    assetLoader = null,
    intervals = [],
    now = defaultNow,
    maxQueue = DEFAULT_MAX_QUEUE,
    maxDecodedBuffers = null,
    maxEventLagMs = DEFAULT_MAX_EVENT_LAG_MS,
    packLoadTimeoutMs = DEFAULT_PACK_LOAD_TIMEOUT_MS,
    resumeTimeoutMs = DEFAULT_CONTEXT_RESUME_TIMEOUT_MS,
  } = {}) {
    if (typeof contextFactory !== 'function') throw new TypeError('contextFactory must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isInteger(maxQueue) || maxQueue < 1) throw new TypeError('maxQueue must be a positive integer');
    if (!Number.isFinite(maxEventLagMs) || maxEventLagMs < 0) throw new TypeError('maxEventLagMs must be non-negative');
    if (!Number.isFinite(packLoadTimeoutMs) || packLoadTimeoutMs <= 0) {
      throw new TypeError('packLoadTimeoutMs must be positive');
    }
    if (!Number.isFinite(resumeTimeoutMs) || resumeTimeoutMs <= 0) {
      throw new TypeError('resumeTimeoutMs must be positive');
    }
    if (typeof fetchImpl !== 'function' && assetLoader === null) fetchImpl = null;

    this.contextFactory = contextFactory;
    this.fetchImpl = fetchImpl;
    this.speechSynthesis = speechSynthesis;
    this.utteranceFactory = utteranceFactory;
    this.assetLoader = assetLoader;
    this.packUrl = packUrl;
    this.baseUrl = baseUrl;
    this.pack = pack;
    this.intervals = Array.isArray(intervals) ? intervals.slice() : [];
    this.now = now;
    this.maxQueue = maxQueue;
    this.maxEventLagMs = maxEventLagMs;
    this.packLoadTimeoutMs = packLoadTimeoutMs;
    this.resumeTimeoutMs = resumeTimeoutMs;
    this.maxDecodedBuffers = Number.isInteger(maxDecodedBuffers) && maxDecodedBuffers > 0
      ? maxDecodedBuffers
      : Math.max(1, Array.isArray(pack?.phrases) ? pack.phrases.length : 256);
    this.context = null;
    this.unlocked = false;
    this.speechUnlocked = false;
    this.queue = [];
    this.draining = false;
    this.busyUntilAudioSeconds = 0;
    this.busyUntilWallMs = 0;
    this.scheduledRanges = [];
    this.announcedWork = new Map();
    this.announcedRest = new Map();
    this.packPromise = null;
    this.sources = new Set();
    this.decodedBuffers = new Map();
    this.queueEpoch = 0;
    this.voiceSettings = normalizeVoiceSettings(voiceSettings ?? settings);
  }

  getSettings() {
    return { ...this.voiceSettings };
  }

  setSettings(settings) {
    const next = normalizeVoiceSettings(settings);
    if (!next.enabled || next.volume === 0) this.clear();
    this.voiceSettings = next;
    return this.getSettings();
  }

  setIntervals(intervals) {
    this.intervals = Array.isArray(intervals) ? intervals.slice() : [];
    this.resetAnnouncements();
    return this.intervals.slice();
  }

  async loadPack(pack = undefined) {
    if (pack !== undefined) {
      this.pack = pack;
      this.packPromise = null;
      return this.pack;
    }
    if (this.pack) return this.pack;
    if (!this.packUrl || typeof this.fetchImpl !== 'function') return null;
    if (!this.packPromise) {
      let timeoutId;
      const request = Promise.resolve()
        .then(() => this.fetchImpl(this.packUrl))
        .then((response) => {
          if (!responseIsOk(response) || typeof response.json !== 'function') throw new Error('voice pack fetch failed');
          return response.json();
        });
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('voice pack fetch timed out')), this.packLoadTimeoutMs);
      });
      this.packPromise = Promise.race([request, timeout])
        .then((loaded) => {
          this.pack = loaded;
          return loaded;
        })
        .catch(() => {
          this.packPromise = null;
          return null;
        })
        .finally(() => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        });
    }
    return this.packPromise;
  }

  /** Call only from the Start button/user gesture. */
  async unlock({ fromStartGesture = true } = {}) {
    if (fromStartGesture !== true) return false;
    if (!this.context) {
      try {
        this.context = this.contextFactory();
      } catch {
        this.context = null;
      }
    }
    try {
      if (this.context?.state === 'suspended' && !await this._resumeContext()) {
        throw new Error('voice context resume failed');
      }
    } catch {
      const failedContext = this.context;
      this.context = null;
      try {
        if (failedContext && typeof failedContext.close === 'function') await failedContext.close();
      } catch {
        // A failed resume context is still discarded even if close rejects.
      }
    }
    this.unlocked = true;
    this.speechUnlocked = Boolean(this.speechSynthesis && typeof this.speechSynthesis.speak === 'function');
    if (this.voiceSettings.packId === VOICE_PACK_FRANKENTTS_V1 && !this.pack) void this.loadPack();
    this._drain();
    return Boolean(this.context || this.speechUnlocked);
  }

  async resume() {
    return this._resumeContext();
  }

  async _resumeContext() {
    if (!this.context) return false;
    if (this.context.state !== 'suspended') return this.context.state === 'running';
    let timeoutId;
    try {
      const resumed = await Promise.race([
        Promise.resolve().then(() => this.context.resume()).then(() => true, () => false),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(false), this.resumeTimeoutMs);
        }),
      ]);
      return resumed === true;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  clear({ resetAnnouncements = true } = {}) {
    this.queueEpoch += 1;
    this.queue.length = 0;
    if (resetAnnouncements) this.resetAnnouncements();
    for (const source of [...this.sources]) {
      try {
        if (typeof source.stop === 'function') source.stop();
      } catch {
        // A source may already have ended; teardown is best effort.
      }
    }
    this.sources.clear();
    this.scheduledRanges.length = 0;
    this.busyUntilWallMs = this.now();
    this.busyUntilAudioSeconds = finite(this.context?.currentTime) ? this.context.currentTime : 0;
    try {
      if (this.speechSynthesis && typeof this.speechSynthesis.cancel === 'function') this.speechSynthesis.cancel();
    } catch {
      // SpeechSynthesis teardown is best effort across browsers.
    }
  }

  resetAnnouncements() {
    this.announcedWork.clear();
    this.announcedRest.clear();
  }

  getPendingPhraseIds() {
    return this.queue.map((item) => item.id);
  }

  getArbitrationState(at = this.now()) {
    this._pruneRanges(at);
    return {
      voiceActive: this.isVoiceActive(at),
      pending: this.queue.length,
      draining: this.draining,
      scheduledRanges: this.scheduledRanges.map((range) => ({ ...range })),
    };
  }

  isVoiceActive(at = this.now()) {
    if (!this.voiceSettings.enabled || this.voiceSettings.volume === 0) return false;
    const wallAt = finite(at) ? at : this.now();
    this._pruneRanges(wallAt);
    return this.scheduledRanges.some((range) => range.startMs <= wallAt && range.endMs > wallAt);
  }

  shouldSuppressCountdown(event = {}) {
    if (!this.voiceSettings.enabled || this.voiceSettings.volume === 0) return false;
    if (this._isStaleEvent(event)) return false;
    const at = finite(event.at) ? event.at : this.now();
    const end = at + COUNTDOWN_WINDOW_MS;
    this._pruneRanges(at);
    const active = this.scheduledRanges.some((range) => range.startMs < end && range.endMs > at);
    return active || (this.unlocked && this.draining && this.queue.length > 0);
  }

  arbitrateCountdown(event = {}) {
    const suppressed = this.shouldSuppressCountdown(event);
    return { suppressed, reason: suppressed ? 'voice' : 'clear' };
  }

  /** Return false when the caller should omit a countdown tone. */
  shouldPlayCountdown(event = {}) {
    if (this._isStaleEvent(event)) return false;
    return !this.shouldSuppressCountdown(event);
  }

  handle(event) {
    if (!isRecord(event) || typeof event.type !== 'string') return false;
    if (this._isStaleEvent(event)) return false;
    if (event.type === 'tick' && ['idle', 'done'].includes(event.snapshot?.state)) {
      this.resetAnnouncements();
      return false;
    }
    if (event.type === 'done') {
      this.resetAnnouncements();
      return false;
    }
    if (event.type === 'countdown321') return this.shouldPlayCountdown(event);
    if (!this.voiceSettings.enabled) return false;

    switch (event.type) {
      case 'intervalStart':
      case 'workStart':
        return this._announceWork(event);
      case 'intervalEnd':
      case 'restStart':
        return this._announceRest(event);
      case 'tick':
        return event.snapshot?.phase === 'rest' ? this._announceRest(event) : false;
      case 'done':
        return false;
      default:
        return false;
    }
  }

  _isStaleEvent(event) {
    const observedAt = Number.isFinite(event.observedAt) ? event.observedAt : event.at;
    return Number.isFinite(observedAt)
      && Number.isFinite(event.at)
      && observedAt - event.at > this.maxEventLagMs;
  }

  enqueuePhrase(id, { text = null, kind = 'movement', category = kind } = {}) {
    if (!this.voiceSettings.enabled || typeof id !== 'string') return false;
    const packPhrase = packPhraseMap(this.pack).get(id);
    const phraseText = text ?? packPhrase?.text;
    if (typeof phraseText !== 'string' || phraseText.length === 0) return false;
    if (this.queue.length >= this.maxQueue) this.queue.shift();
    this.queue.push({
      id,
      text: phraseText,
      kind: packPhrase?.kind ?? kind,
      category,
    });
    if (this.unlocked) this._drain();
    return true;
  }

  _announceWork(event) {
    const interval = this._currentInterval(event);
    const index = this._intervalIndex(event);
    const cycle = `${index}:${Number.isFinite(event.at) ? event.at : this.now()}`;
    if (this.announcedWork.get(index) === cycle) return false;
    this.announcedWork.set(index, cycle);
    this.announcedRest.delete(index);
    let queued = this.enqueuePhrase('go', { text: 'Go', kind: 'boundary', category: 'boundary' });
    if (this.voiceSettings.exercise) {
      const phrase = phraseFromInterval(interval);
      if (phrase) queued = this.enqueuePhrase(phrase.id, phrase) || queued;
    }
    if (this.voiceSettings.side) {
      const phrase = sidePhrase(interval?.side);
      if (phrase) queued = this.enqueuePhrase(phrase.id, phrase) || queued;
    }
    return queued;
  }

  _announceRest(event) {
    const index = this._intervalIndex(event);
    const cycle = this.announcedWork.get(index) ?? `rest:${index}:${Number.isFinite(event.at) ? event.at : this.now()}`;
    if (this.announcedRest.get(index) === cycle) return false;
    this.announcedRest.set(index, cycle);
    let queued = this.enqueuePhrase('rest', { text: 'Rest', kind: 'boundary', category: 'boundary' });
    if (this.voiceSettings.next) {
      const next = this._nextInterval(event);
      if (next) {
        queued = this.enqueuePhrase('next', { text: 'Next', kind: 'next', category: 'next' }) || queued;
        if (this.voiceSettings.exercise) {
          const phrase = phraseFromInterval(next);
          if (phrase) queued = this.enqueuePhrase(phrase.id, { ...phrase, category: 'next' }) || queued;
        }
        if (this.voiceSettings.side) {
          const phrase = sidePhrase(next?.side);
          if (phrase) queued = this.enqueuePhrase(phrase.id, { ...phrase, category: 'next' }) || queued;
        }
      }
    }
    return queued;
  }

  _intervalIndex(event) {
    return Number.isInteger(event.snapshot?.intervalIndex)
      ? event.snapshot.intervalIndex
      : Number.isInteger(event.intervalIndex)
        ? event.intervalIndex
        : -1;
  }

  _currentInterval(event) {
    return event.interval ?? event.snapshot?.currentInterval ?? this.intervals[this._intervalIndex(event)] ?? null;
  }

  _nextInterval(event) {
    if (event.nextInterval) return event.nextInterval;
    if (event.snapshot?.nextInterval) return event.snapshot.nextInterval;
    const index = this._intervalIndex(event);
    return index >= 0 ? this.intervals[index + 1] ?? null : null;
  }

  _assetFor(item) {
    if (this.voiceSettings.packId !== VOICE_PACK_FRANKENTTS_V1 || !this.pack) return null;
    const phrase = packPhraseMap(this.pack).get(item.id);
    return phrase?.asset && phrase.asset.type === 'audio/mpeg' && typeof phrase.asset.url === 'string'
      ? phrase.asset
      : null;
  }

  async _drain() {
    if (!this.unlocked || this.draining) return;
    this.draining = true;
    const epoch = this.queueEpoch;
    try {
      while (this.queue.length > 0 && this.unlocked) {
        if (epoch !== this.queueEpoch) break;
        const item = this.queue.shift();
        try {
          await this._play(item, epoch);
        } catch {
          // One bad decoder/source/utterance must not reject the detached drain.
        }
      }
    } finally {
      this.draining = false;
      if (this.unlocked && this.queue.length > 0) this._drain();
    }
  }

  async _play(item, epoch) {
    if (!this.voiceSettings.enabled || this.voiceSettings.volume === 0) return;
    const asset = this._assetFor(item);
    if (asset && this.context) {
      try {
        const buffer = await this._loadAudioBuffer(asset, item);
        if (buffer && epoch === this.queueEpoch && this.unlocked) {
          try {
            if (this._playBuffer(buffer)) return;
          } catch {
            // Fall through to speech if a detached WebAudio node rejects.
          }
        }
      } catch {
        // A corrupt/missing pack asset falls through to SpeechSynthesis.
      }
    }
    if (epoch !== this.queueEpoch || !this.unlocked) return;
    this._speak(item.text);
  }

  async _loadAudioBuffer(asset, item) {
    const cacheKey = `${item.id}:${asset.sha256 ?? asset.url}`;
    if (this.decodedBuffers.has(cacheKey)) return this.decodedBuffers.get(cacheKey);
    let loaded;
    if (typeof this.assetLoader === 'function') {
      loaded = await this.assetLoader(asset, item, this.pack);
    } else {
      if (typeof this.fetchImpl !== 'function' || !this.context?.decodeAudioData) return null;
      const url = this._resolveAssetUrl(asset.url);
      const response = await this.fetchImpl(url);
      if (!responseIsOk(response) || typeof response.arrayBuffer !== 'function') throw new Error('voice asset fetch failed');
      loaded = await response.arrayBuffer();
    }
    if (loaded && typeof loaded.duration === 'number') {
      this._cacheDecodedBuffer(cacheKey, loaded);
      return loaded;
    }
    if (!loaded || !this.context?.decodeAudioData) return null;
    const buffer = await new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const rejectOnce = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      try {
        const result = this.context.decodeAudioData(loaded, resolveOnce, rejectOnce);
        if (result && typeof result.then === 'function') result.then(resolveOnce, rejectOnce);
      } catch (error) {
        rejectOnce(error);
      }
    });
    this._cacheDecodedBuffer(cacheKey, buffer);
    return buffer;
  }

  _cacheDecodedBuffer(key, buffer) {
    this.decodedBuffers.set(key, buffer);
    while (this.decodedBuffers.size > this.maxDecodedBuffers) {
      const oldest = this.decodedBuffers.keys().next().value;
      this.decodedBuffers.delete(oldest);
    }
  }

  _resolveAssetUrl(assetUrl) {
    if (this.baseUrl) return new URL(assetUrl, this.baseUrl).toString();
    return new URL(assetUrl, 'http://localhost/').toString();
  }

  _playBuffer(buffer) {
    if (!this.context || this.voiceSettings.volume === 0 || typeof this.context.createBufferSource !== 'function') return false;
    const duration = finite(buffer.duration) && buffer.duration > 0 ? buffer.duration : 0.5;
    const current = finite(this.context.currentTime) ? this.context.currentTime : 0;
    const start = Math.max(current, this.busyUntilAudioSeconds);
    let source = null;
    try {
      source = this.context.createBufferSource();
      source.buffer = buffer;
      const gain = typeof this.context.createGain === 'function' ? this.context.createGain() : null;
      if (gain) {
        if (gain.gain && typeof gain.gain.setValueAtTime === 'function') gain.gain.setValueAtTime(this.voiceSettings.volume, start);
        else if (gain.gain) gain.gain.value = this.voiceSettings.volume;
        source.connect(gain);
        gain.connect(this.context.destination);
      } else {
        source.connect(this.context.destination);
      }
      source.start(start);
      this.sources.add(source);
      source.onended = () => this.sources.delete(source);
      try {
        if (typeof source.stop === 'function') source.stop(start + duration);
      } catch {
        // A source that cannot be explicitly stopped can still end naturally.
      }
      this._recordScheduled(start, duration);
      return true;
    } catch {
      try {
        if (source && typeof source.stop === 'function') source.stop();
      } catch {
        // Best-effort cleanup after a failed source start/connect.
      }
      if (source) this.sources.delete(source);
      return false;
    }
  }

  _speak(text) {
    if (!this.speechUnlocked || this.voiceSettings.volume === 0 || !this.speechSynthesis || typeof this.speechSynthesis.speak !== 'function') return false;
    let utterance;
    try {
      utterance = this.utteranceFactory(text);
    } catch {
      return false;
    }
    if (!utterance) return false;
    if ('volume' in utterance) utterance.volume = this.voiceSettings.volume;
    if ('rate' in utterance) utterance.rate = 1;
    if ('pitch' in utterance) utterance.pitch = 1;
    try {
      this.speechSynthesis.speak(utterance);
    } catch {
      return false;
    }
    const duration = Math.min(4, Math.max(0.35, text.length * 0.045));
    this._recordScheduled(null, duration);
    return true;
  }

  _recordScheduled(audioStart, duration) {
    const wallNow = this.now();
    const audioNow = finite(this.context?.currentTime) ? this.context.currentTime : wallNow / 1000;
    const startAudio = audioStart === null
      ? Math.max(audioNow, this.busyUntilAudioSeconds)
      : Math.max(audioStart, this.busyUntilAudioSeconds);
    const startWall = Math.max(wallNow, this.busyUntilWallMs);
    const endAudio = startAudio + duration;
    const endWall = startWall + duration * 1000;
    this.busyUntilAudioSeconds = endAudio;
    this.busyUntilWallMs = endWall;
    this.scheduledRanges.push({ startMs: startWall, endMs: endWall });
  }

  _pruneRanges(at) {
    this.scheduledRanges = this.scheduledRanges.filter((range) => range.endMs > at);
    if (this.scheduledRanges.length === 0 && at >= this.busyUntilWallMs) {
      this.busyUntilWallMs = at;
      if (this.context && finite(this.context.currentTime) && this.context.currentTime >= this.busyUntilAudioSeconds) {
        this.busyUntilAudioSeconds = this.context.currentTime;
      }
    }
  }

  async dispose() {
    this.clear();
    this.unlocked = false;
    this.speechUnlocked = false;
    this.sources.clear();
    this.decodedBuffers.clear();
    if (this.context && this.context.state !== 'closed' && typeof this.context.close === 'function') await this.context.close();
    this.context = null;
  }
}

export { DEFAULT_PACK_URL };
