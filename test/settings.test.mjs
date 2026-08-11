import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUE_PACK_SYNTH_V1,
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  VISUAL_PACK_GIF_V1,
  VOICE_PACK_BROWSER_V1,
  VOICE_PACK_FRANKENTTS_V1,
  createSettingsStore,
  isValidSettings,
  loadSettings,
  migrateSettings,
  normalizeSettings,
  saveSettings,
  updateSettings,
} from '../src/settings.mjs';

class FakeStorage {
  values = new Map();
  writes = [];
  throwOnRead = false;
  throwOnWrite = false;

  getItem(key) {
    if (this.throwOnRead) throw new Error('read failed');
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.throwOnWrite) throw new Error('write failed');
    this.writes.push({ key, value });
    this.values.set(key, String(value));
  }
}

function storedSettings(storage) {
  try {
    return JSON.parse(storage.values.get(SETTINGS_STORAGE_KEY));
  } catch (error) {
    assert.fail(`stored settings should be valid JSON: ${error.message}`);
  }
}

test('v1 key, pack IDs, and documented defaults are stable and isolated', () => {
  assert.equal(SETTINGS_STORAGE_KEY, 'fittimer.settings.v1');
  assert.equal(SETTINGS_SCHEMA_VERSION, 1);
  assert.deepEqual(DEFAULT_SETTINGS, {
    schemaVersion: 1,
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
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true);
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.cues), true);

  const first = loadSettings(null);
  first.cues.enabled = false;
  assert.equal(loadSettings(null).cues.enabled, true);
});

test('missing storage returns defaults and save uses exactly one versioned key', () => {
  const storage = new FakeStorage();
  const saved = saveSettings({ cues: { enabled: false } }, storage);

  assert.equal(storage.writes.length, 1);
  assert.deepEqual(storage.writes[0], {
    key: SETTINGS_STORAGE_KEY,
    value: JSON.stringify({
      schemaVersion: 1,
      cues: {
        packId: CUE_PACK_SYNTH_V1,
        enabled: false,
        volume: 1,
        countdown: true,
        halfway: true,
      },
      voice: DEFAULT_SETTINGS.voice,
      visuals: DEFAULT_SETTINGS.visuals,
    }),
  });
  assert.deepEqual(saved, loadSettings(storage));
});

test('save and load round-trip all cue, voice, and visual preferences', () => {
  const storage = new FakeStorage();
  const expected = normalizeSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    cues: {
      packId: CUE_PACK_SYNTH_V1,
      enabled: false,
      volume: 0.35,
      countdown: false,
      halfway: true,
    },
    voice: {
      packId: 'frankentts-v1',
      enabled: false,
      volume: 0.6,
      exercise: false,
      side: true,
      next: false,
    },
    visuals: {
      selectedPackId: 'reference-v1',
      reducedMotion: true,
    },
  });

  assert.deepEqual(saveSettings(expected, storage), expected);
  assert.deepEqual(loadSettings(storage), expected);
  assert.deepEqual(storedSettings(storage), expected);
  assert.equal(isValidSettings(expected), true);
  assert.equal(isValidSettings({
    visuals: { reducedMotion: true, selectedPackId: 'reference-v1' },
    voice: {
      next: false,
      side: true,
      exercise: false,
      volume: 0.6,
      enabled: false,
      packId: 'frankentts-v1',
    },
    cues: {
      halfway: true,
      countdown: false,
      volume: 0.35,
      enabled: false,
      packId: CUE_PACK_SYNTH_V1,
    },
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  }), true);
});

test('update supports nested patches and updater functions without dropping siblings', () => {
  const storage = new FakeStorage();
  saveSettings({
    cues: { volume: 0.5 },
    voice: { side: false },
    visuals: { reducedMotion: true },
  }, storage);
  storage.writes = [];

  const patched = updateSettings({ cues: { countdown: false } }, storage);
  assert.equal(patched.cues.countdown, false);
  assert.equal(patched.cues.volume, 0.5);
  assert.equal(patched.voice.side, false);
  assert.equal(patched.visuals.reducedMotion, true);
  assert.equal(storage.writes.length, 1);

  const updated = updateSettings((current) => {
    current.cues.volume = 0.2;
    current.visuals.selectedPackId = 'w1w4-v1';
    return current;
  }, storage);
  assert.equal(updated.cues.volume, 0.2);
  assert.equal(updated.visuals.selectedPackId, 'w1w4-v1');
  assert.equal(updated.cues.countdown, false);
  assert.deepEqual(loadSettings(storage), updated);
});

test('settings store wraps the same load/save/update contract', () => {
  const storage = new FakeStorage();
  const store = createSettingsStore(storage);
  assert.equal(store.load().schemaVersion, SETTINGS_SCHEMA_VERSION);
  store.save({ voice: { enabled: false } });
  assert.equal(store.load().voice.enabled, false);
  assert.equal(store.update({ visuals: { reducedMotion: true } }).visuals.reducedMotion, true);
});

test('malformed JSON, unsupported versions, and storage errors fall back quietly', () => {
  const storage = new FakeStorage();
  storage.values.set(SETTINGS_STORAGE_KEY, '{not-json');
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);

  storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify({ schemaVersion: 99 }));
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);

  storage.throwOnRead = true;
  assert.deepEqual(loadSettings(storage), DEFAULT_SETTINGS);

  storage.throwOnRead = false;
  storage.throwOnWrite = true;
  const saved = saveSettings({ cues: { enabled: false } }, storage);
  assert.equal(saved.cues.enabled, false);
});

test('unknown IDs and malformed fields fall back independently while valid fields survive', () => {
  const storage = new FakeStorage();
  storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    cues: {
      packId: 'missing-cue-pack',
      enabled: false,
      volume: 0.4,
      countdown: 'yes',
      halfway: false,
    },
    voice: {
      packId: 'missing-voice-pack',
      enabled: 'no',
      volume: 2,
      exercise: false,
      side: true,
      next: null,
    },
    visuals: {
      selectedPackId: 'missing-visual-pack',
      reducedMotion: true,
    },
  }));

  assert.deepEqual(loadSettings(storage), {
    schemaVersion: 1,
    cues: {
      packId: CUE_PACK_SYNTH_V1,
      enabled: false,
      volume: 0.4,
      countdown: true,
      halfway: false,
    },
    voice: {
      packId: VOICE_PACK_FRANKENTTS_V1,
      enabled: true,
      volume: 1,
      exercise: false,
      side: true,
      next: true,
    },
    visuals: {
      selectedPackId: VISUAL_PACK_GIF_V1,
      reducedMotion: true,
    },
  });
});

test('an explicitly saved browser voice choice remains stable', () => {
  const storage = new FakeStorage();
  const saved = saveSettings({ voice: { packId: VOICE_PACK_BROWSER_V1 } }, storage);
  assert.equal(saved.voice.packId, VOICE_PACK_BROWSER_V1);
  assert.equal(loadSettings(storage).voice.packId, VOICE_PACK_BROWSER_V1);
});

test('the supported v1 version envelope migrates without another key', () => {
  const legacy = {
    version: 1,
    cues: { enabled: false },
  };
  assert.deepEqual(migrateSettings(legacy), {
    schemaVersion: 1,
    cues: { enabled: false },
  });

  const storage = new FakeStorage();
  storage.values.set(SETTINGS_STORAGE_KEY, JSON.stringify(legacy));
  assert.equal(loadSettings(storage).cues.enabled, false);
  assert.equal(migrateSettings({ version: 0 }), null);
});

test('normalization accepts only bounded numeric volumes and strict booleans', () => {
  const normalized = normalizeSettings({
    cues: { volume: Number.NaN },
    voice: { volume: Infinity },
    visuals: { reducedMotion: 0 },
  });
  assert.equal(normalized.cues.volume, 1);
  assert.equal(normalized.voice.volume, 1);
  assert.equal(normalized.visuals.reducedMotion, false);
  assert.equal(isValidSettings({ ...normalized, extra: true }), false);
});
