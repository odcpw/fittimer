import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioCuePlayer } from '../src/audio-cues.mjs';

class FakeAudioParam {
  values = [];

  setValueAtTime(value, at) {
    this.values.push({ method: 'set', value, at });
  }

  exponentialRampToValueAtTime(value, at) {
    this.values.push({ method: 'ramp', value, at });
  }
}

class FakeAudioContext {
  state = 'suspended';
  currentTime = 10;
  destination = {};
  oscillators = [];
  gains = [];
  resumeCount = 0;

  async resume() {
    this.resumeCount += 1;
    this.state = 'running';
  }

  async close() {
    this.state = 'closed';
  }

  createOscillator() {
    const oscillator = {
      type: null,
      frequency: new FakeAudioParam(),
      connect: (target) => target,
      startAt: null,
      stopAt: null,
      start(at) { this.startAt = at; },
      stop(at) { this.stopAt = at; },
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    const gain = {
      gain: new FakeAudioParam(),
      connect: (target) => target,
    };
    this.gains.push(gain);
    return gain;
  }
}

function setup(settings) {
  const context = new FakeAudioContext();
  const player = new AudioCuePlayer({ contextFactory: () => context, settings });
  return { context, player };
}

function peakVolumes(context) {
  return context.gains.map((gain) => gain.gain.values[1].value);
}

test('unlock creates and resumes one WebAudio context', async () => {
  const { context, player } = setup();
  assert.equal(await player.unlock(), true);
  assert.equal(await player.unlock(), true);
  assert.equal(context.resumeCount, 1);
});

test('work start and rest boundary use distinct ascending and descending pairs', async () => {
  const { context, player } = setup();
  await player.unlock();
  assert.equal(player.handle({ type: 'intervalStart', at: 0, observedAt: 0 }), true);
  assert.equal(player.handle({ type: 'intervalEnd', at: 1, observedAt: 1 }), true);
  assert.deepEqual(
    context.oscillators.map((oscillator) => oscillator.frequency.values[0].value),
    [660, 880, 520, 330],
  );
  assert.ok(context.oscillators.every((oscillator) => oscillator.stopAt > oscillator.startAt));
});

test('countdown final beep and halfway tick have their own tone profiles', async () => {
  const { context, player } = setup();
  await player.unlock();
  player.handle({ type: 'countdown321', count: 3, at: 10, observedAt: 10 });
  player.handle({ type: 'countdown321', count: 1, at: 12, observedAt: 12 });
  player.handle({ type: 'halfway', at: 20, observedAt: 20 });
  assert.deepEqual(
    context.oscillators.map((oscillator) => [oscillator.frequency.values[0].value, oscillator.type]),
    [[780, 'sine'], [1040, 'sine'], [440, 'triangle']],
  );
});

test('cue settings filter countdown and halfway without changing boundary cues', async () => {
  const { context, player } = setup({
    cues: { countdown: false, halfway: false },
  });
  await player.unlock();

  assert.equal(player.handle({ type: 'intervalStart', at: 0, observedAt: 0 }), true);
  assert.equal(player.handle({ type: 'intervalEnd', at: 1, observedAt: 1 }), true);
  assert.equal(player.handle({ type: 'countdown321', count: 3, at: 2, observedAt: 2 }), false);
  assert.equal(player.handle({ type: 'halfway', at: 3, observedAt: 3 }), false);
  assert.equal(context.oscillators.length, 4);
});

test('disabled cues stay silent and can be enabled through the live settings API', async () => {
  const { context, player } = setup({ cues: { enabled: false } });
  await player.unlock();
  assert.equal(player.handle({ type: 'intervalStart', at: 0, observedAt: 0 }), false);
  assert.equal(player.handle({ type: 'intervalEnd', at: 1, observedAt: 1 }), false);
  assert.equal(player.handle({ type: 'countdown321', count: 1, at: 2, observedAt: 2 }), false);
  assert.equal(player.handle({ type: 'halfway', at: 3, observedAt: 3 }), false);
  assert.equal(context.oscillators.length, 0);

  assert.deepEqual(player.setSettings({ cues: { enabled: true } }), {
    packId: 'synth-v1',
    enabled: true,
    volume: 1,
    countdown: true,
    halfway: true,
  });
  assert.equal(player.handle({ type: 'halfway', at: 4, observedAt: 4 }), true);
  assert.equal(context.oscillators.length, 1);
});

test('cue volume scales every synthesized tone and zero is silent', async () => {
  const { context, player } = setup({ cues: { volume: 0.25 } });
  await player.unlock();
  player.handle({ type: 'intervalStart', at: 0, observedAt: 0 });
  player.handle({ type: 'halfway', at: 1, observedAt: 1 });
  assert.deepEqual(peakVolumes(context), [0.03, 0.0325, 0.0175]);

  player.setSettings({ cues: { volume: 0 } });
  player.handle({ type: 'intervalEnd', at: 2, observedAt: 2 });
  assert.equal(context.oscillators.length, 3);
});

test('stale catch-up events and unrelated engine events stay silent', async () => {
  const { context, player } = setup();
  await player.unlock();
  assert.equal(player.handle({ type: 'countdown321', count: 1, at: 1000, observedAt: 2000 }), false);
  assert.equal(player.handle({ type: 'tick', at: 2000, observedAt: 2000 }), false);
  assert.equal(context.oscillators.length, 0);
});

test('dispose closes the context', async () => {
  const { context, player } = setup();
  await player.unlock();
  await player.dispose();
  assert.equal(context.state, 'closed');
  assert.equal(player.context, null);
});
