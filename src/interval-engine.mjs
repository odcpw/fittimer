const ACTIVE_STATES = new Set(['work', 'rest']);

function assertTimestamp(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError('clock must return a finite millisecond timestamp');
  }
}

function prepareIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) {
    throw new TypeError('intervals must be a non-empty array');
  }

  return Object.freeze(
    intervals.map((interval, index) => {
      if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
        throw new TypeError(`intervals[${index}] must be an object`);
      }
      for (const field of ['workSeconds', 'restSeconds']) {
        if (!Number.isInteger(interval[field]) || interval[field] <= 0) {
          throw new TypeError(`intervals[${index}].${field} must be a positive integer`);
        }
      }
      return Object.freeze({ ...interval });
    }),
  );
}

export class IntervalEngine {
  constructor(intervals, { now = () => performance.now() } = {}) {
    if (typeof now !== 'function') { // ubs:ignore — validates a clock callback type, not a secret or token
      throw new TypeError('now must be a function');
    }

    this.intervals = prepareIntervals(intervals);
    this._now = now;
    this._listeners = new Set();
    this._lastObservedAt = null;
    this._resetState();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  getSnapshot(at = this._peekNow()) {
    assertTimestamp(at);
    const phase = this.state === 'paused' ? this.pausedPhase : ACTIVE_STATES.has(this.state) ? this.state : null;
    let remainingMs = 0;
    let phaseDurationMs = 0;
    let elapsedMs = 0;

    if (this.state === 'paused') {
      remainingMs = this.pausedRemainingMs;
      phaseDurationMs = this.phaseDurationMs;
      elapsedMs = this.pausedElapsedMs;
    } else if (ACTIVE_STATES.has(this.state)) {
      remainingMs = Math.max(0, this.phaseEndAt - at);
      phaseDurationMs = this.phaseDurationMs;
      elapsedMs = Math.min(phaseDurationMs, Math.max(0, at - this.phaseStartedAt));
    }

    const currentInterval = this.intervalIndex < this.intervals.length
      ? this.intervals[this.intervalIndex]
      : null;

    return Object.freeze({
      state: this.state,
      phase,
      intervalIndex: this.intervalIndex,
      intervalNumber: currentInterval ? this.intervalIndex + 1 : this.intervals.length,
      totalIntervals: this.intervals.length,
      currentInterval,
      remainingMs,
      remainingSeconds: Math.ceil(remainingMs / 1000),
      phaseDurationMs,
      phaseProgress: phaseDurationMs === 0 ? 0 : elapsedMs / phaseDurationMs,
    });
  }

  start() {
    if (this.state !== 'idle') return false;
    const now = this._observeNow();
    this._enterWork(0, now, now);
    this._emitCues(now);
    this._emit('tick', now);
    return true;
  }

  update() {
    const now = this._observeNow();
    this._advanceTo(now);
    return this.getSnapshot(now);
  }

  pause() {
    if (!ACTIVE_STATES.has(this.state)) return false;
    const now = this._observeNow();
    this._advanceTo(now);
    if (!ACTIVE_STATES.has(this.state)) return false;

    this.pausedPhase = this.state;
    this.pausedRemainingMs = Math.max(0, this.phaseEndAt - now);
    this.pausedElapsedMs = Math.min(this.phaseDurationMs, Math.max(0, now - this.phaseStartedAt));
    this.state = 'paused';
    this.phaseStartedAt = null;
    this.phaseEndAt = null;
    this._emit('tick', now);
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    const now = this._observeNow();
    this.state = this.pausedPhase;
    this.phaseStartedAt = now - this.pausedElapsedMs;
    this.phaseEndAt = now + this.pausedRemainingMs;
    this.pausedPhase = null;
    this.pausedRemainingMs = 0;
    this.pausedElapsedMs = 0;
    this._emitCues(now);
    this._emit('tick', now);
    return true;
  }

  skipForward() {
    if (!ACTIVE_STATES.has(this.state) && this.state !== 'paused') return false;
    const now = this._observeNow();
    if (ACTIVE_STATES.has(this.state)) this._advanceTo(now);
    if (!ACTIVE_STATES.has(this.state) && this.state !== 'paused') return false;

    const phase = this.state === 'paused' ? this.pausedPhase : this.state;
    if (phase === 'work') { // ubs:ignore — compares a public state-machine phase, not a secret or token
      this._emit('intervalEnd', now, { reason: 'skipped' });
    }

    const nextIndex = this.intervalIndex + 1;
    if (nextIndex >= this.intervals.length) {
      this._finish(now, now);
      this._emit('tick', now);
    } else {
      this._enterWork(nextIndex, now, now);
      this._emitCues(now);
      this._emit('tick', now);
    }
    return true;
  }

  skipBack() {
    if (!ACTIVE_STATES.has(this.state) && this.state !== 'paused') return false;
    const now = this._observeNow();
    if (ACTIVE_STATES.has(this.state)) this._advanceTo(now);
    if ((!ACTIVE_STATES.has(this.state) && this.state !== 'paused') || this.intervalIndex === 0) {
      return false;
    }

    const phase = this.state === 'paused' ? this.pausedPhase : this.state;
    if (phase === 'work') { // ubs:ignore — compares a public state-machine phase, not a secret or token
      this._emit('intervalEnd', now, { reason: 'skipped-back' });
    }
    this._enterWork(this.intervalIndex - 1, now, now);
    this._emitCues(now);
    this._emit('tick', now);
    return true;
  }

  restart() {
    const now = this._observeNow();
    this._resetState();
    this._emit('tick', now);
    return true;
  }

  _peekNow() {
    const now = this._now();
    assertTimestamp(now);
    return now;
  }

  _observeNow() {
    const now = this._peekNow();
    if (this._lastObservedAt !== null && now < this._lastObservedAt) {
      throw new RangeError('clock must be monotonic');
    }
    this._lastObservedAt = now;
    return now;
  }

  _resetState() {
    this.state = 'idle';
    this.intervalIndex = 0;
    this.phaseStartedAt = null;
    this.phaseEndAt = null;
    this.phaseDurationMs = 0;
    this.pausedPhase = null;
    this.pausedRemainingMs = 0;
    this.pausedElapsedMs = 0;
    this._resetCues();
  }

  _resetCues() {
    this.halfwayEmitted = false;
    this.countdownsEmitted = new Set();
  }

  _advanceTo(now) {
    while (ACTIVE_STATES.has(this.state) && now >= this.phaseEndAt) {
      const boundaryAt = this.phaseEndAt;
      if (this.state === 'work') {
        this._emit('intervalEnd', boundaryAt, { reason: 'completed', observedAt: now });
        this._enterRest(boundaryAt);
      } else if (this.intervalIndex + 1 < this.intervals.length) {
        this._enterWork(this.intervalIndex + 1, boundaryAt, now);
      } else {
        this._finish(boundaryAt, now);
      }
    }

    if (ACTIVE_STATES.has(this.state)) this._emitCues(now);
    this._emit('tick', now);
  }

  _enterWork(index, startedAt, observedAt) {
    this.state = 'work';
    this.intervalIndex = index;
    this.phaseStartedAt = startedAt;
    this.phaseDurationMs = this.intervals[index].workSeconds * 1000;
    this.phaseEndAt = startedAt + this.phaseDurationMs;
    this.pausedPhase = null;
    this.pausedRemainingMs = 0;
    this.pausedElapsedMs = 0;
    this._resetCues();
    this._emit('intervalStart', startedAt, { observedAt });
  }

  _enterRest(startedAt) {
    this.state = 'rest';
    this.phaseStartedAt = startedAt;
    this.phaseDurationMs = this.intervals[this.intervalIndex].restSeconds * 1000;
    this.phaseEndAt = startedAt + this.phaseDurationMs;
    this._resetCues();
  }

  _finish(finishedAt, observedAt) {
    this.state = 'done';
    this.intervalIndex = this.intervals.length;
    this.phaseStartedAt = null;
    this.phaseEndAt = null;
    this.phaseDurationMs = 0;
    this.pausedPhase = null;
    this.pausedRemainingMs = 0;
    this.pausedElapsedMs = 0;
    this._resetCues();
    this._emit('done', finishedAt, { observedAt });
  }

  _emitCues(now) {
    const remainingMs = Math.max(0, this.phaseEndAt - now);
    if (this.state === 'work' && !this.halfwayEmitted) {
      const halfwayAt = this.phaseStartedAt + this.phaseDurationMs / 2;
      if (now >= halfwayAt && now < this.phaseEndAt) {
        this.halfwayEmitted = true;
        this._emit('halfway', halfwayAt, { observedAt: now });
      }
    }

    const countdown = Math.ceil(remainingMs / 1000);
    if (countdown >= 1 && countdown <= 3 && !this.countdownsEmitted.has(countdown)) {
      this.countdownsEmitted.add(countdown);
      this._emit('countdown321', this.phaseEndAt - countdown * 1000, {
        count: countdown,
        observedAt: now,
      });
    }
  }

  _emit(type, at, details = {}) {
    const event = Object.freeze({ type, at, ...details, snapshot: this.getSnapshot(at) });
    for (const listener of [...this._listeners]) listener(event);
  }
}
