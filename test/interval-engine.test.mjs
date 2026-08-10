import assert from 'node:assert/strict';
import test from 'node:test';

import { IntervalEngine } from '../src/interval-engine.mjs';

class FakeClock {
  value = 0;

  now = () => this.value;

  advance(milliseconds) {
    this.value += milliseconds;
  }
}

function makeEngine(intervals = [
  { displayName: 'First', workSeconds: 4, restSeconds: 2 },
  { displayName: 'Second', workSeconds: 3, restSeconds: 1 },
]) {
  const clock = new FakeClock();
  const engine = new IntervalEngine(intervals, { now: clock.now });
  const events = [];
  engine.subscribe((event) => events.push(event));
  return { clock, engine, events };
}

test('runs idle → work → rest → work → rest → done from anchored boundaries', () => {
  const { clock, engine, events } = makeEngine();
  assert.equal(engine.getSnapshot().state, 'idle');

  assert.equal(engine.start(), true);
  assert.deepEqual(
    { state: engine.getSnapshot().state, interval: engine.getSnapshot().intervalNumber, remaining: engine.getSnapshot().remainingMs },
    { state: 'work', interval: 1, remaining: 4000 },
  );

  clock.advance(4000);
  assert.equal(engine.update().state, 'rest');
  assert.equal(engine.getSnapshot().remainingMs, 2000);

  clock.advance(2000);
  assert.equal(engine.update().state, 'work');
  assert.equal(engine.getSnapshot().intervalNumber, 2);

  clock.advance(3000);
  assert.equal(engine.update().state, 'rest');
  clock.advance(1000);
  assert.equal(engine.update().state, 'done');
  assert.equal(events.find((event) => event.type === 'done').at, 10_000);
});

test('pause and resume preserve remaining time across a work-to-rest boundary', () => {
  const { clock, engine } = makeEngine();
  engine.start();
  clock.advance(3500);

  assert.equal(engine.pause(), true);
  assert.deepEqual(
    { state: engine.getSnapshot().state, phase: engine.getSnapshot().phase, remaining: engine.getSnapshot().remainingMs },
    { state: 'paused', phase: 'work', remaining: 500 },
  );

  clock.advance(10_000);
  assert.equal(engine.update().remainingMs, 500);
  assert.equal(engine.resume(), true);
  clock.advance(500);
  assert.equal(engine.update().state, 'rest');
  assert.equal(engine.getSnapshot().remainingMs, 2000);
});

test('skip controls respect first and last interval edges and keep snapshots synchronized', () => {
  const { engine } = makeEngine();
  engine.start();
  assert.equal(engine.skipBack(), false);
  assert.equal(engine.getSnapshot().intervalIndex, 0);

  assert.equal(engine.skipForward(), true);
  assert.deepEqual(
    { state: engine.getSnapshot().state, interval: engine.getSnapshot().intervalNumber, remaining: engine.getSnapshot().remainingMs },
    { state: 'work', interval: 2, remaining: 3000 },
  );

  assert.equal(engine.skipForward(), true);
  assert.equal(engine.getSnapshot().state, 'done');
  assert.equal(engine.skipForward(), false);
  assert.equal(engine.skipBack(), false);
});

test('skip back moves exactly one interval and resumes an active work phase', () => {
  const { clock, engine } = makeEngine([
    { displayName: 'First', workSeconds: 4, restSeconds: 2 },
    { displayName: 'Second', workSeconds: 4, restSeconds: 2 },
    { displayName: 'Third', workSeconds: 4, restSeconds: 2 },
  ]);
  engine.start();
  engine.skipForward();
  clock.advance(1000);
  engine.pause();

  assert.equal(engine.skipBack(), true);
  assert.deepEqual(
    { state: engine.getSnapshot().state, interval: engine.getSnapshot().intervalNumber, remaining: engine.getSnapshot().remainingMs },
    { state: 'work', interval: 1, remaining: 4000 },
  );
});

test('restart returns every state to a fresh idle snapshot', () => {
  const { clock, engine } = makeEngine();
  engine.start();
  clock.advance(1000);
  engine.update();
  assert.equal(engine.restart(), true);
  assert.deepEqual(
    {
      state: engine.getSnapshot().state,
      interval: engine.getSnapshot().intervalNumber,
      remaining: engine.getSnapshot().remainingMs,
      progress: engine.getSnapshot().phaseProgress,
    },
    { state: 'idle', interval: 1, remaining: 0, progress: 0 },
  );
  assert.equal(engine.start(), true);
  assert.equal(engine.getSnapshot().remainingMs, 4000);
});

test('a simulated 10-second scheduler stall catches up without accumulating drift', () => {
  const { clock, engine } = makeEngine([
    { displayName: 'First', workSeconds: 6, restSeconds: 2 },
    { displayName: 'Second', workSeconds: 6, restSeconds: 2 },
  ]);
  engine.start();
  clock.advance(10_000);

  const snapshot = engine.update();
  assert.deepEqual(
    { state: snapshot.state, interval: snapshot.intervalNumber, remaining: snapshot.remainingMs },
    { state: 'work', interval: 2, remaining: 4000 },
  );
});

test('halfway and countdown events fire once at logical timestamps without stale catch-up cues', () => {
  const { clock, engine, events } = makeEngine([{ displayName: 'Only', workSeconds: 8, restSeconds: 2 }]);
  engine.start();

  clock.advance(4100);
  engine.update();
  clock.advance(1000);
  engine.update();
  clock.advance(1000);
  engine.update();
  clock.advance(1000);
  engine.update();

  assert.deepEqual(events.filter((event) => event.type === 'halfway').map((event) => event.at), [4000]);
  assert.deepEqual(
    events.filter((event) => event.type === 'countdown321').map((event) => [event.count, event.at]),
    [[3, 5000], [2, 6000], [1, 7000]],
  );

  const stalled = makeEngine([{ displayName: 'Only', workSeconds: 8, restSeconds: 2 }]);
  stalled.engine.start();
  stalled.clock.advance(8000);
  stalled.engine.update();
  const stalledCountdowns = stalled.events.filter((event) => event.type === 'countdown321');
  assert.equal(stalledCountdowns.some((event) => event.at < 8000), false, 'stale work cues must be suppressed');
  assert.deepEqual(stalledCountdowns.map((event) => event.count), [2], 'current rest cue still fires');
});

test('thirty 40/20 intervals complete at the wall-clock anchor despite irregular updates', () => {
  const intervals = Array.from({ length: 30 }, (_, index) => ({
    displayName: `Interval ${index + 1}`,
    workSeconds: 40,
    restSeconds: 20,
  }));
  const { clock, engine, events } = makeEngine(intervals);
  engine.start();

  const updateSteps = [137, 863, 421, 1579, 250, 750];
  let step = 0;
  while (clock.value < 1_800_500) {
    clock.advance(updateSteps[step % updateSteps.length]);
    engine.update();
    step += 1;
  }

  assert.equal(engine.getSnapshot().state, 'done');
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.at, 1_800_000);
  assert.ok(done.observedAt - done.at < 1000, `completion observed ${done.observedAt - done.at}ms late`);
});

test('constructor and clock reject invalid inputs', () => {
  assert.throws(() => new IntervalEngine([]), /non-empty array/);
  assert.throws(
    () => new IntervalEngine([{ displayName: 'Bad', workSeconds: 0, restSeconds: 1 }]),
    /positive integer/,
  );

  const clock = new FakeClock();
  const engine = new IntervalEngine([{ displayName: 'Only', workSeconds: 1, restSeconds: 1 }], {
    now: clock.now,
  });
  engine.start();
  clock.value = -1;
  assert.throws(() => engine.update(), /monotonic/);
});
