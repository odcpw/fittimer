function defaultNavigator() {
  return typeof navigator === 'object' && navigator !== null ? navigator : null;
}

function sentinelIsHeld(sentinel) {
  return sentinel !== null && sentinel !== undefined && sentinel.released !== true;
}

/**
 * Small injectable boundary around the Screen Wake Lock API. The workout
 * engine owns timing; this controller only owns the best-effort screen lock.
 */
export class WakeLockController {
  constructor({ navigatorObject = defaultNavigator() } = {}) {
    this._navigator = navigatorObject;
    this._sentinel = null;
    this._releaseHandler = null;
    this._requestPromise = null;
    this._requestPromiseGeneration = null;
    this._requestGeneration = 0;
    this._disposed = false;
  }

  get supported() {
    try {
      return typeof this._navigator?.wakeLock?.request === 'function';
    } catch {
      return false;
    }
  }

  async request() {
    if (this._disposed || !this.supported) return false;
    if (sentinelIsHeld(this._sentinel)) return true;
    this._clearSentinel(this._sentinel);
    if (this._requestPromise) {
      const pending = this._requestPromise;
      const pendingGeneration = this._requestPromiseGeneration;
      return pending.then((acquired) => {
        if (acquired || this._disposed || pendingGeneration === this._requestGeneration) return acquired;
        return this.request();
      });
    }

    const requestGeneration = this._requestGeneration;
    const pending = (async () => {
      try {
        const sentinel = await this._navigator.wakeLock.request('screen');
        if (!sentinel || this._disposed || requestGeneration !== this._requestGeneration) {
          try {
            await sentinel?.release?.();
          } catch {
            // Wake lock failure is deliberately non-blocking.
          }
          return false;
        }
        this._attachSentinel(sentinel);
        return true;
      } catch {
        return false;
      } finally {
        if (this._requestPromise === pending) {
          this._requestPromise = null;
          this._requestPromiseGeneration = null;
        }
      }
    })();
    this._requestPromise = pending;
    this._requestPromiseGeneration = requestGeneration;
    return pending;
  }

  async release() {
    this._requestGeneration += 1;
    const sentinel = this._sentinel;
    if (!sentinel) return false;
    this._clearSentinel(sentinel);
    try {
      await sentinel.release?.();
      return true;
    } catch {
      return false;
    }
  }

  async dispose() {
    this._disposed = true;
    await this.release();
  }

  _attachSentinel(sentinel) {
    this._sentinel = sentinel;
    if (typeof sentinel.addEventListener !== 'function') return;
    const releaseHandler = () => {
      this._clearSentinel(sentinel);
    };
    try {
      sentinel.addEventListener('release', releaseHandler); // ubs:ignore — _clearSentinel removes this handler during sentinel teardown
      this._releaseHandler = releaseHandler;
    } catch {
      // A non-standard sentinel should still be usable without event hooks.
    }
  }

  _clearSentinel(sentinel) {
    if (!sentinel || this._sentinel !== sentinel) return;
    const releaseHandler = this._releaseHandler;
    this._sentinel = null;
    this._releaseHandler = null;
    if (!releaseHandler || typeof sentinel.removeEventListener !== 'function') return;
    try {
      sentinel.removeEventListener('release', releaseHandler);
    } catch {
      // Cleanup is best effort for browser and test doubles alike.
    }
  }
}

export const ScreenWakeLockController = WakeLockController;

export function createWakeLockController(options) {
  return new WakeLockController(options);
}
