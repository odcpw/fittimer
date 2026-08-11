const SETTINGS_VERSION = 1;

/**
 * The key intentionally includes the schema version. Deploys and service
 * worker cache changes must continue to read the same preference record.
 */
export const SETTINGS_STORAGE_KEY = 'fittimer.settings.v1';
export const SETTINGS_SCHEMA_VERSION = SETTINGS_VERSION;

export const CUE_PACK_SYNTH_V1 = 'synth-v1';
export const VOICE_PACK_BROWSER_V1 = 'browser-speech-v1';
export const VOICE_PACK_FRANKENTTS_V1 = 'frankentts-v1';
export const VISUAL_PACK_GIF_V1 = 'gif-v1';
export const VISUAL_PACK_REFERENCE_V1 = 'reference-v1';
export const VISUAL_PACK_W1W4_V1 = 'w1w4-v1';

export const CUE_PACK_IDS = Object.freeze([CUE_PACK_SYNTH_V1]);
export const VOICE_PACK_IDS = Object.freeze([
  VOICE_PACK_BROWSER_V1,
  VOICE_PACK_FRANKENTTS_V1,
]);
export const VISUAL_PACK_IDS = Object.freeze([
  VISUAL_PACK_GIF_V1,
  VISUAL_PACK_REFERENCE_V1,
  VISUAL_PACK_W1W4_V1,
]);

export const SETTINGS_PACK_IDS = Object.freeze({
  cues: Object.freeze({ synthV1: CUE_PACK_SYNTH_V1 }),
  voice: Object.freeze({
    browserV1: VOICE_PACK_BROWSER_V1,
    frankenttsV1: VOICE_PACK_FRANKENTTS_V1,
  }),
  visuals: Object.freeze({
    gifV1: VISUAL_PACK_GIF_V1,
    referenceV1: VISUAL_PACK_REFERENCE_V1,
    w1w4V1: VISUAL_PACK_W1W4_V1,
  }),
});

/**
 * Documented v1 defaults:
 * - synthesized cues are enabled at their original full level;
 * - countdown and halfway cues are enabled;
 * - the verified FrankenTTS voice pack is enabled, with all three
 *   announcement kinds enabled; an explicitly saved browser voice choice is
 *   preserved by normalization;
 * - the built-in GIF visual pack is selected and reduced motion is off.
 *
 * This object is deeply frozen. Load/save/update return fresh mutable records
 * so a future settings panel can edit a record before saving it.
 */
export const DEFAULT_SETTINGS = deepFreeze({
  schemaVersion: SETTINGS_VERSION,
  cues: {
    packId: CUE_PACK_SYNTH_V1,
    enabled: true,
    volume: 1,
    countdown: true,
    halfway: true,
  },
  voice: {
    packId: VOICE_PACK_FRANKENTTS_V1,
    enabled: true,
    volume: 1,
    exercise: true,
    side: true,
    next: true,
  },
  visuals: {
    selectedPackId: VISUAL_PACK_GIF_V1,
    reducedMotion: false,
  },
});

export const DEFAULT_CUE_SETTINGS = DEFAULT_SETTINGS.cues;
export const DEFAULT_VOICE_SETTINGS = DEFAULT_SETTINGS.voice;
export const DEFAULT_VISUAL_SETTINGS = DEFAULT_SETTINGS.visuals;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneSettings(settings) {
  return {
    schemaVersion: SETTINGS_VERSION,
    cues: { ...settings.cues },
    voice: { ...settings.voice },
    visuals: { ...settings.visuals },
  };
}

function firstDefined(source, ...keys) {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function validPackId(value, allowedIds, fallback) {
  return typeof value === 'string' && allowedIds.includes(value) ? value : fallback;
}

function validBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function validVolume(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function section(source, key) {
  return isRecord(source[key]) ? source[key] : {};
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
    && sameValue(left[key], right[key]));
}

/**
 * Convert a partial settings record to the canonical v1 shape. Unknown keys
 * are dropped and invalid individual values use their documented defaults.
 */
export function normalizeSettings(value) {
  const source = isRecord(value) ? value : {};
  const cues = section(source, 'cues');
  const voice = section(source, 'voice');
  const visuals = section(source, 'visuals');

  return {
    schemaVersion: SETTINGS_VERSION,
    cues: {
      packId: validPackId(
        firstDefined(cues, 'packId', 'pack'),
        CUE_PACK_IDS,
        DEFAULT_CUE_SETTINGS.packId,
      ),
      enabled: validBoolean(cues.enabled, DEFAULT_CUE_SETTINGS.enabled),
      volume: validVolume(cues.volume, DEFAULT_CUE_SETTINGS.volume),
      countdown: validBoolean(cues.countdown, DEFAULT_CUE_SETTINGS.countdown),
      halfway: validBoolean(cues.halfway, DEFAULT_CUE_SETTINGS.halfway),
    },
    voice: {
      packId: validPackId(
        firstDefined(voice, 'packId', 'pack'),
        VOICE_PACK_IDS,
        DEFAULT_VOICE_SETTINGS.packId,
      ),
      enabled: validBoolean(voice.enabled, DEFAULT_VOICE_SETTINGS.enabled),
      volume: validVolume(voice.volume, DEFAULT_VOICE_SETTINGS.volume),
      exercise: validBoolean(voice.exercise, DEFAULT_VOICE_SETTINGS.exercise),
      side: validBoolean(voice.side, DEFAULT_VOICE_SETTINGS.side),
      next: validBoolean(voice.next, DEFAULT_VOICE_SETTINGS.next),
    },
    visuals: {
      selectedPackId: validPackId(
        firstDefined(visuals, 'selectedPackId', 'selectedPack', 'packId', 'pack'),
        VISUAL_PACK_IDS,
        DEFAULT_VISUAL_SETTINGS.selectedPackId,
      ),
      reducedMotion: validBoolean(visuals.reducedMotion, DEFAULT_VISUAL_SETTINGS.reducedMotion),
    },
  };
}

/**
 * Normalize a full settings object or just its cues section for audio users.
 */
export function normalizeCueSettings(value) {
  const source = isRecord(value) && isRecord(value.cues) ? value.cues : value;
  const cues = isRecord(source) ? source : {};
  return normalizeSettings({ cues }).cues;
}

/**
 * Return true only for a complete, canonical v1 record. Load uses the
 * normalizer after this check so malformed individual fields can still fall
 * back independently.
 */
export function isValidSettings(value) {
  if (!isRecord(value) || value.schemaVersion !== SETTINGS_VERSION) return false;
  const normalized = normalizeSettings(value);
  return sameValue(normalized, value);
}

/** Alias for callers that prefer a validation-named API. */
export const validateSettings = normalizeSettings;

/**
 * Migrate the only currently supported stored shape. The alternate `version:
 * 1` envelope is accepted without introducing a second storage key. Other
 * versions are intentionally rejected and load as defaults.
 */
export function migrateSettings(value) {
  if (!isRecord(value)) return null;
  if (value.schemaVersion === SETTINGS_VERSION) return value;
  if (value.schemaVersion === undefined && value.version === SETTINGS_VERSION) {
    const withoutVersion = { ...value };
    delete withoutVersion.version;
    return { schemaVersion: SETTINGS_VERSION, ...withoutVersion };
  }
  return null;
}

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function storageLike(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.getItem === 'function'
    && typeof value.setItem === 'function';
}

function resolveStorage(storage) {
  const candidate = storage === undefined ? browserStorage() : storage;
  return storageLike(candidate) ? candidate : null;
}

/**
 * Load and normalize settings from one storage key. Missing storage, storage
 * access errors, malformed JSON, unsupported versions, and invalid fields all
 * return a usable record without logging or throwing.
 */
export function loadSettings(storage = undefined) {
  const storageArea = resolveStorage(storage);
  if (!storageArea) return cloneSettings(DEFAULT_SETTINGS);

  let serialized;
  try {
    serialized = storageArea.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    return cloneSettings(DEFAULT_SETTINGS);
  }
  if (serialized === null || serialized === undefined) return cloneSettings(DEFAULT_SETTINGS);

  try {
    const migrated = migrateSettings(JSON.parse(serialized));
    return migrated ? normalizeSettings(migrated) : cloneSettings(DEFAULT_SETTINGS);
  } catch {
    return cloneSettings(DEFAULT_SETTINGS);
  }
}

/**
 * Normalize and persist settings under the single versioned key. A storage
 * failure leaves the caller with the normalized record and does not block the
 * workout; the next load will use the last successfully stored value.
 */
export function saveSettings(value, storage = undefined) {
  const normalized = normalizeSettings(value);
  const storageArea = resolveStorage(storage);
  if (!storageArea) return normalized;

  try {
    storageArea.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Settings are optional; an unavailable or full storage area must not
    // prevent the timer from starting.
  }
  return normalized;
}

function mergeSettings(current, patch) {
  if (!isRecord(patch)) return current;
  return {
    ...current,
    cues: isRecord(patch.cues) ? { ...current.cues, ...patch.cues } : current.cues,
    voice: isRecord(patch.voice) ? { ...current.voice, ...patch.voice } : current.voice,
    visuals: isRecord(patch.visuals) ? { ...current.visuals, ...patch.visuals } : current.visuals,
  };
}

/**
 * Apply a partial nested patch, normalize it, and persist it. A function patch
 * receives a mutable snapshot, which is convenient for checkbox/slider UIs.
 */
export function updateSettings(patch, storage = undefined) {
  const current = loadSettings(storage);
  const requested = typeof patch === 'function' ? patch({
    schemaVersion: current.schemaVersion,
    cues: { ...current.cues },
    voice: { ...current.voice },
    visuals: { ...current.visuals },
  }) : patch;
  return saveSettings(mergeSettings(current, requested), storage);
}

export class SettingsStore {
  constructor(storage = undefined) {
    this.storage = storage;
  }

  load() {
    return loadSettings(this.storage);
  }

  save(value) {
    return saveSettings(value, this.storage);
  }

  update(patch) {
    return updateSettings(patch, this.storage);
  }
}

export function createSettingsStore(storage = undefined) {
  return new SettingsStore(storage);
}
