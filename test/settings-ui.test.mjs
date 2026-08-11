import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CUE_PACK_SYNTH_V1,
  DEFAULT_SETTINGS,
  VISUAL_PACK_GIF_V1,
  VISUAL_PACK_REFERENCE_V1,
  VOICE_PACK_BROWSER_V1,
} from '../src/settings.mjs';
import { resolveMediaPackPreference, summarizeSettings } from '../src/app.mjs';

const html = await readFile('index.html', 'utf8');
const styles = await readFile('styles.css', 'utf8');

const settingControlIds = [
  'settings-cue-pack',
  'settings-cues-enabled',
  'settings-cues-volume',
  'settings-cues-countdown',
  'settings-cues-halfway',
  'settings-voice-pack',
  'settings-voice-enabled',
  'settings-voice-volume',
  'settings-voice-exercise',
  'settings-voice-side',
  'settings-voice-next',
  'settings-visual-pack',
  'settings-reduced-motion',
];

test('home settings panel exposes every versioned preference', () => {
  assert.match(html, /<details[^>]+id="settings-panel"/);
  for (const id of settingControlIds) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /type="range"[^>]+min="0"[^>]+max="1"/);
});

test('installed landscape home owns a touch-scroll surface', () => {
  assert.match(styles, /html\[data-screen="home"\] \.app-shell\s*\{[^}]*height:\s*100dvh[^}]*overflow-y:\s*auto[^}]*touch-action:\s*pan-y/s);
  assert.match(styles, /html\[data-screen="home"\],\s*html\[data-screen="home"\] body\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /html\[data-screen="workout"\],\s*html\[data-screen="workout"\] body\s*\{[^}]*overflow:\s*hidden/s);
});

test('settings summary uses normalized defaults and reflects cue changes', () => {
  assert.deepEqual(summarizeSettings(DEFAULT_SETTINGS), {
    label: 'Sound on · GIFs',
    cueLabel: 'Sound on',
    visualLabel: 'GIFs',
  });
  assert.deepEqual(summarizeSettings({ cues: { enabled: false }, visuals: { selectedPackId: VISUAL_PACK_REFERENCE_V1 } }), {
    label: 'Sound off · Reference pack',
    cueLabel: 'Sound off',
    visualLabel: 'Reference pack',
  });
});

test('uninstalled but valid visual preferences fall back to the available media pack', () => {
  const index = {
    defaultMediaPack: VISUAL_PACK_GIF_V1,
    mediaPacks: { [VISUAL_PACK_GIF_V1]: 'data/media/gif-v1.json' },
  };
  assert.deepEqual(resolveMediaPackPreference(index, {
    cues: { packId: CUE_PACK_SYNTH_V1 },
    voice: { packId: VOICE_PACK_BROWSER_V1 },
    visuals: { selectedPackId: VISUAL_PACK_REFERENCE_V1 },
  }), {
    requestedId: VISUAL_PACK_REFERENCE_V1,
    effectiveId: VISUAL_PACK_GIF_V1,
    isFallback: true,
  });
});

process.stdout.write('Settings UI tests passed: controls, summaries, and safe media fallback.\n');
