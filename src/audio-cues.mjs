import { normalizeCueSettings } from './settings.mjs';

const DEFAULT_MAX_EVENT_LAG_MS = 500;

function browserContextFactory() {
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error('WebAudio is unavailable in this browser');
  return new AudioContextClass({ latencyHint: 'interactive' });
}

export class AudioCuePlayer {
  constructor({
    contextFactory = browserContextFactory,
    maxEventLagMs = DEFAULT_MAX_EVENT_LAG_MS,
    settings,
    cueSettings,
  } = {}) {
    if (typeof contextFactory !== 'function') throw new TypeError('contextFactory must be a function');
    if (!Number.isFinite(maxEventLagMs) || maxEventLagMs < 0) {
      throw new TypeError('maxEventLagMs must be a non-negative number');
    }
    this.contextFactory = contextFactory;
    this.maxEventLagMs = maxEventLagMs;
    this.context = null;
    this.cueSettings = normalizeCueSettings(cueSettings ?? settings);
  }

  async unlock() {
    if (!this.context) this.context = this.contextFactory();
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context.state === 'running';
  }

  async resume() {
    if (this.context?.state === 'suspended') await this.context.resume();
  }

  setSettings(settings) {
    this.cueSettings = normalizeCueSettings(settings);
    return this.getSettings();
  }

  getSettings() {
    return { ...this.cueSettings };
  }

  handle(event) {
    if (!this.context || !event || typeof event.type !== 'string') return false;
    if (!this.cueSettings.enabled) return false;
    const observedAt = Number.isFinite(event.observedAt) ? event.observedAt : event.at;
    if (Number.isFinite(observedAt) && Number.isFinite(event.at) && observedAt - event.at > this.maxEventLagMs) {
      return false;
    }

    switch (event.type) {
      case 'intervalStart':
        this._tone(660, 0, 0.09, 0.12, 'sine');
        this._tone(880, 0.1, 0.13, 0.13, 'sine');
        return true;
      case 'intervalEnd':
        this._tone(520, 0, 0.1, 0.11, 'sine');
        this._tone(330, 0.11, 0.16, 0.12, 'sine');
        return true;
      case 'halfway':
        if (!this.cueSettings.halfway) return false;
        this._tone(440, 0, 0.07, 0.07, 'triangle');
        return true;
      case 'countdown321':
        if (!this.cueSettings.countdown) return false;
        this._tone(event.count === 1 ? 1040 : 780, 0, event.count === 1 ? 0.13 : 0.08, 0.1, 'sine');
        return true;
      default:
        return false;
    }
  }

  async dispose() {
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }

  _tone(frequency, offsetSeconds, durationSeconds, volume, type) {
    if (!this.context || this.context.state === 'closed') return;
    const effectiveVolume = volume * this.cueSettings.volume;
    if (effectiveVolume <= 0) return;
    const startAt = this.context.currentTime + offsetSeconds;
    const stopAt = startAt + durationSeconds;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    envelope.gain.setValueAtTime(0.0001, startAt);
    envelope.gain.exponentialRampToValueAtTime(effectiveVolume, startAt + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    oscillator.connect(envelope);
    envelope.connect(this.context.destination);
    oscillator.start(startAt);
    oscillator.stop(stopAt + 0.01);
  }
}
