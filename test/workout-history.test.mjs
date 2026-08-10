import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  WORKOUT_HISTORY_KEY,
  appendWorkoutHistory,
  buildMonthCalendar,
  currentStreak,
  formatDateKey,
  historySummary,
  loadWorkoutHistory,
} from '../src/workout-history.mjs';

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }
}

const date = (year, month, day) => new Date(year, month - 1, day);

test('malformed or unavailable storage returns an empty history safely', () => {
  const corrupt = new MemoryStorage();
  corrupt.setItem(WORKOUT_HISTORY_KEY, '{not json');
  assert.deepEqual(loadWorkoutHistory(corrupt), []);
  assert.deepEqual(loadWorkoutHistory(null), []);
});

test('finished and aborted records persist in the versioned local log', () => {
  const storage = new MemoryStorage();
  appendWorkoutHistory({ routine: 'madfit-30min-hiit', finished: true }, { storage, now: date(2026, 8, 11) });
  appendWorkoutHistory({ routine: 'madfit-30min-hiit', abortedAtInterval: 7 }, { storage, now: date(2026, 8, 12) });

  assert.deepEqual(loadWorkoutHistory(storage), [
    { routine: 'madfit-30min-hiit', date: '2026-08-11', finished: true },
    { routine: 'madfit-30min-hiit', date: '2026-08-12', abortedAtInterval: 7 },
  ]);
  assert.equal(storage.getItem(WORKOUT_HISTORY_KEY).includes('madfit-30min-hiit'), true);
});

test('streak counts finished consecutive local days including today, not aborts', () => {
  const entries = [
    { routine: 'one', date: '2026-08-10', abortedAtInterval: 3 },
    { routine: 'one', date: '2026-08-11', finished: true },
  ];
  assert.equal(currentStreak(entries, date(2026, 8, 11)), 1);
  assert.equal(currentStreak(entries, date(2026, 8, 12)), 0);
  assert.deepEqual(historySummary(entries), { completed: 1, aborted: 1 });
});

test('month calendar creates deterministic cells, dots, and outside-day padding', () => {
  const entries = [
    { routine: 'one', date: '2026-08-11', finished: true },
    { routine: 'one', date: '2026-08-12', abortedAtInterval: 4 },
  ];
  const calendar = buildMonthCalendar(date(2026, 8, 1), entries);
  assert.equal(calendar.label, 'August 2026');
  assert.equal(calendar.cells.length, 42);
  assert.equal(calendar.cells.filter((cell) => cell.inMonth).length, 31);
  assert.equal(calendar.cells.find((cell) => cell.date === '2026-08-11').completed, true);
  assert.equal(calendar.cells.find((cell) => cell.date === '2026-08-12').aborted, true);
  assert.equal(calendar.cells[0].inMonth, false);
  assert.equal(formatDateKey(date(2026, 8, 11)), '2026-08-11');
});

test('home history navigation is present and writes only from done and confirmed End paths', async () => {
  const html = await readFile('index.html', 'utf8');
  const application = await readFile('src/app.mjs', 'utf8');
  const serviceWorker = await readFile('sw.js', 'utf8');

  for (const id of [
    'history-panel',
    'history-streak',
    'history-previous-month',
    'history-next-month',
    'history-month-label',
    'history-calendar',
    'history-summary',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(application, /if \(event\.type === 'done'\) recordFinishedWorkout\(\)/);
  assert.match(application, /recordAbortedWorkout\(engine\.getSnapshot\(\)\)/);
  assert.match(application, /shiftHistoryMonth\(-1\)/);
  assert.match(application, /shiftHistoryMonth\(1\)/);
  assert.match(serviceWorker, /\.\/src\/workout-history\.mjs/);
  assert.doesNotMatch(serviceWorker, /localStorage/);
});

process.stdout.write('Workout history tests passed: safe storage, persistence, streaks, calendar, and navigation wiring.\n');
