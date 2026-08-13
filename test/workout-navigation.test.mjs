import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKOUT_HUD_DURATION_MS, workoutHudState, workoutNavigationState } from '../src/app.mjs';

test('Previous is disabled for every phase of interval 1', () => {
  for (const state of ['work', 'rest', 'paused']) {
    assert.deepEqual(workoutNavigationState({ state, intervalIndex: 0 }), {
      previousDisabled: true,
      endEnabled: true,
      activeControlsVisible: true,
      completionActionsVisible: false,
    });
  }
});

test('Previous becomes available from interval 2 without changing its meaning', () => {
  const navigation = workoutNavigationState({ state: 'work', intervalIndex: 1 });
  assert.equal(navigation.previousDisabled, false);
  assert.equal(navigation.activeControlsVisible, true);
  assert.equal(navigation.completionActionsVisible, false);
});

test('completion replaces active controls with explicit Home and Restart actions', () => {
  assert.deepEqual(workoutNavigationState({ state: 'done', intervalIndex: 30 }), {
    previousDisabled: true,
    endEnabled: false,
    activeControlsVisible: false,
    completionActionsVisible: true,
  });
});

test('transient workout HUD keeps the timer and next exercise visible and restores controls for paused/done states', () => {
  assert.equal(WORKOUT_HUD_DURATION_MS, 10_000);
  assert.deepEqual(workoutHudState({ state: 'work' }, false), {
    timerVisible: true,
    nextUpVisible: true,
    detailsVisible: false,
    controlsVisible: false,
    completionActionsVisible: false,
  });
  assert.deepEqual(workoutHudState({ state: 'paused' }, false), {
    timerVisible: true,
    nextUpVisible: true,
    detailsVisible: true,
    controlsVisible: true,
    completionActionsVisible: false,
  });
  assert.deepEqual(workoutHudState({ state: 'done' }, false), {
    timerVisible: true,
    nextUpVisible: true,
    detailsVisible: true,
    controlsVisible: false,
    completionActionsVisible: true,
  });
});

test('next exercise is not owned by the transient controls selector', async () => {
  const styles = await import('node:fs/promises').then(({ readFile }) => readFile('styles.css', 'utf8'));
  const hiddenHudRule = styles.match(/\.workout-screen\[data-hud="timer"\][\s\S]*?\{\s*visibility:\s*hidden;/)?.[0] ?? '';
  assert.equal(hiddenHudRule.includes('.next-up'), false);
  assert.match(styles, /\.next-up\s*\{[\s\S]*?top:\s*max\(18px,[\s\S]*?text-align:\s*right;/);
});

process.stdout.write('Workout navigation tests passed: interval guard, Previous semantics, and completion actions.\n');
