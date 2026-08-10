import assert from 'node:assert/strict';
import test from 'node:test';

import { workoutNavigationState } from '../src/app.mjs';

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

process.stdout.write('Workout navigation tests passed: interval guard, Previous semantics, and completion actions.\n');
