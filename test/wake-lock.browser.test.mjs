import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [application, wakeLock, serviceWorker] = await Promise.all([
  readFile('src/app.mjs', 'utf8'),
  readFile('src/wake-lock.mjs', 'utf8'),
  readFile('sw.js', 'utf8'),
]);

test('browser integration keeps wake lock lifecycle outside timer and audio ownership', () => {
  assert.match(wakeLock, /wakeLock\.request\('screen'\)/);
  assert.match(application, /createWakeLockController/);
  assert.match(application, /requestWakeLock\(\)/);
  assert.match(application, /releaseWakeLock\(\)/);
  assert.match(application, /visibilitychange/);
  assert.match(application, /wakeLockController\.dispose\(\)/);
  assert.match(application, /engine\.update\(\)/);
  assert.doesNotMatch(application, /<audio\b/i);
  assert.doesNotMatch(application, /mediaSession/i);
  assert.match(serviceWorker, /CACHE_NAME\s*=\s*'fittimer-v18'/);
  assert.match(serviceWorker, /\.\/src\/wake-lock\.mjs/);
});

process.stdout.write('Wake lock browser contract passed: lifecycle hooks, timestamp engine, and PWA shell.\n');
