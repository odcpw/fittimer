import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_SETTINGS,
  VISUAL_PACK_REFERENCE_V1,
} from '../src/settings.mjs';
import { summarizeSettings } from '../src/app.mjs';

const html = await readFile('index.html', 'utf8');
const styles = await readFile('styles.css', 'utf8');
const application = await readFile('src/app.mjs', 'utf8');

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
  'settings-creator',
  'settings-reduced-motion',
];

test('home settings panel exposes every versioned preference', () => {
  assert.match(html, /<details[^>]+id="settings-panel"/);
  for (const id of settingControlIds) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /type="range"[^>]+min="0"[^>]+max="1"/);
  assert.doesNotMatch(html, /id="settings-visual-pack"/);
  assert.match(html, /Video creator/);
  assert.match(html, /Automatic/);
});

test('installed landscape home owns a touch-scroll surface', () => {
  assert.match(styles, /html\[data-screen="home"\] \.app-shell\s*\{[^}]*height:\s*100dvh[^}]*overflow-y:\s*auto[^}]*touch-action:\s*pan-y/s);
  assert.match(styles, /html\[data-screen="home"\],\s*html\[data-screen="home"\] body\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /html\[data-screen="workout"\],\s*html\[data-screen="workout"\] body\s*\{[^}]*overflow:\s*hidden/s);
});

test('workout cards are explicit direct-start controls', () => {
  assert.match(application, /button\.setAttribute\('aria-label', `Start \$\{routine\.title\}`\)/);
  assert.match(application, /arrow\.textContent\s*=\s*'Start ▶'/);
  assert.match(application, /elements\.routineList\.addEventListener\('click',[\s\S]*?startRoutineFromUserGesture\(routine\)/);
  assert.doesNotMatch(html, /id="start-button"/);
});

test('settings summary uses normalized defaults and reflects cue changes', () => {
  assert.deepEqual(summarizeSettings(DEFAULT_SETTINGS), {
    label: 'Sound on · Voice on',
    cueLabel: 'Sound on',
    voiceLabel: 'Voice on',
  });
  assert.deepEqual(summarizeSettings({ cues: { enabled: false }, visuals: { selectedPackId: VISUAL_PACK_REFERENCE_V1 } }), {
    label: 'Sound off · Voice on',
    cueLabel: 'Sound off',
    voiceLabel: 'Voice on',
  });
});

process.stdout.write('Settings UI tests passed: controls, summaries, and automatic video UI.\n');
