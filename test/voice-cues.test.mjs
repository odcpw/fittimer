import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { VoiceCueQueue } from '../src/voice-cues.mjs';

class FakeAudioContext {
  state = 'suspended';
  currentTime = 10;
  destination = {};
  sources = [];
  gains = [];
  resumeCount = 0;
  closeCount = 0;

  constructor({ resumeFails = false, resumeHangs = false, startFails = false, stopFails = false } = {}) {
    this.resumeFails = resumeFails;
    this.resumeHangs = resumeHangs;
    this.startFails = startFails;
    this.stopFails = stopFails;
  }

  async resume() {
    this.resumeCount += 1;
    if (this.resumeHangs) return new Promise(() => {});
    if (this.resumeFails) throw new Error('resume failed');
    this.state = 'running';
  }

  async close() {
    this.closeCount += 1;
    this.state = 'closed';
  }

  createBufferSource() {
    const source = {
      buffer: null,
      startAt: null,
      stopAt: null,
      stopCount: 0,
      onended: null,
      connect: (target) => target,
      start: (at) => { source.startAt = at; },
      stop: (at = null) => {
        source.stopCount += 1;
        source.stopAt = at;
        if (this.stopFails) throw new Error('stop failed');
      },
    };
    if (this.startFails) source.start = () => { throw new Error('start failed'); };
    this.sources.push(source);
    return source;
  }

  createGain() {
    const gain = {
      gain: {
        value: 0,
        setValueAtTime(value) { this.value = value; },
      },
      connect: (target) => target,
    };
    this.gains.push(gain);
    return gain;
  }

  decodeAudioData(_bytes, success) {
    const buffer = { duration: 0.4 };
    if (typeof success === 'function') success(buffer);
    return Promise.resolve(buffer);
  }
}

class FakeSpeechSynthesis {
  calls = [];
  cancelCount = 0;

  speak(utterance) {
    this.calls.push(utterance);
  }

  cancel() {
    this.cancelCount += 1;
  }
}

function utteranceFactory(text) {
  return { text, volume: null, rate: null, pitch: null };
}

function interval(displayName, side) {
  return { displayName, side, workSeconds: 40, restSeconds: 20 };
}

function event(type, at, currentInterval, intervalIndex = 0) {
  return {
    type,
    at,
    snapshot: { intervalIndex, currentInterval },
  };
}

function packWith(...ids) {
  return {
    schemaVersion: 1,
    kind: 'voicePack',
    id: 'frankentts-v1',
    phrases: ids.map((id) => ({
      id,
      kind: id.startsWith('side-') ? 'side' : 'movement',
      text: id === 'go' ? 'Go' : id,
      asset: {
        type: 'audio/mpeg',
        url: `data/voice/assets/${id}.mp3`,
        bytes: 1,
        sha256: `hash-${id}`,
      },
    })),
  };
}

function makeQueue(options = {}) {
  const context = options.context ?? new FakeAudioContext();
  const speech = options.speech ?? new FakeSpeechSynthesis();
  const queue = new VoiceCueQueue({
    voiceSettings: options.voiceSettings ?? {
      packId: 'browser-speech-v1',
      enabled: true,
      volume: 1,
      exercise: true,
      side: true,
      next: true,
    },
    pack: options.pack ?? null,
    packUrl: options.packUrl,
    baseUrl: options.baseUrl,
    intervals: options.intervals ?? [],
    contextFactory: () => context,
    fetchImpl: options.fetchImpl ?? null,
    speechSynthesis: speech,
    utteranceFactory,
    assetLoader: options.assetLoader ?? null,
    now: options.now ?? (() => 1000),
    packLoadTimeoutMs: options.packLoadTimeoutMs,
    resumeTimeoutMs: options.resumeTimeoutMs,
  });
  return { context, speech, queue };
}

async function flushQueue() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('voice settings filter exercise, side, and next phrases and scale SpeechSynthesis volume', async () => {
  const { speech, queue } = makeQueue({
    voiceSettings: {
      packId: 'browser-speech-v1',
      enabled: true,
      volume: 0.35,
      exercise: false,
      side: false,
      next: false,
    },
    intervals: [interval('Goblet squat', 'left'), interval('Push-up', 'right')],
  });
  queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  queue.handle(event('intervalEnd', 100, interval('Goblet squat', 'left')));
  assert.deepEqual(queue.getPendingPhraseIds(), ['go', 'rest']);
  assert.equal(speech.calls.length, 0, 'SpeechSynthesis stays locked before Start');

  assert.equal(await queue.unlock({ fromStartGesture: false }), false);
  assert.equal(speech.calls.length, 0);
  assert.equal(await queue.unlock(), true);
  await flushQueue();
  assert.deepEqual(speech.calls.map((call) => call.text), ['Go', 'Rest']);
  assert.deepEqual(speech.calls.map((call) => call.volume), [0.35, 0.35]);
});

test('work/rest queue ordering includes sides and the next exercise during rest', () => {
  const first = interval('Goblet squat', 'left');
  const second = interval('Push-up', 'right');
  const { queue } = makeQueue();
  assert.deepEqual(queue.setIntervals([first, second]), [first, second]);
  queue.handle(event('intervalStart', 0, first));
  queue.handle(event('intervalEnd', 100, first));
  assert.deepEqual(queue.getPendingPhraseIds(), [
    'go',
    'movement-goblet-squat',
    'side-left',
    'rest',
    'next',
    'movement-push-up',
    'side-right',
  ]);
  assert.equal(queue.handle({ ...event('tick', 101, first), snapshot: { phase: 'rest', intervalIndex: 0 } }), false);
  assert.deepEqual(queue.getPendingPhraseIds(), [
    'go',
    'movement-goblet-squat',
    'side-left',
    'rest',
    'next',
    'movement-push-up',
    'side-right',
  ]);
});

test('a valid pre-rendered asset uses WebAudio and decoded buffers are reused', async () => {
  const context = new FakeAudioContext();
  const pack = packWith('go');
  let loads = 0;
  const { speech, queue } = makeQueue({
    context,
    pack,
    voiceSettings: {
      packId: 'frankentts-v1',
      enabled: true,
      volume: 0.6,
      exercise: false,
      side: false,
      next: false,
    },
    assetLoader: async () => {
      loads += 1;
      return { duration: 0.4 };
    },
  });
  queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  await queue.unlock();
  await flushQueue();
  assert.equal(loads, 1);
  assert.equal(context.sources.length, 1);
  assert.equal(speech.calls.length, 0);
  assert.equal(context.gains[0].gain.value, 0.6);

  queue.clear();
  queue.handle(event('intervalStart', 1, interval('Goblet squat', 'left')));
  await flushQueue();
  assert.equal(loads, 1);
  assert.equal(context.sources.length, 2);
});

test('fetch-backed packs resolve app-root assets under a GitHub Pages subpath and retry failed loads', async () => {
  const context = new FakeAudioContext();
  const speech = new FakeSpeechSynthesis();
  const packUrl = 'https://example.test/fittimer/data/voice/voice-pack-v1.json';
  const expectedAssetUrl = 'https://example.test/fittimer/data/voice/assets/go.mp3';
  const pack = packWith('go');
  const requested = [];
  let packAttempts = 0;
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url === packUrl) {
      packAttempts += 1;
      if (packAttempts === 1) throw new Error('transient network error');
      return { ok: true, json: async () => pack };
    }
    assert.equal(url, expectedAssetUrl);
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const { queue } = makeQueue({
    context,
    speech,
    pack: null,
    packUrl,
    baseUrl: 'https://example.test/fittimer/',
    fetchImpl,
    voiceSettings: {
      packId: 'frankentts-v1',
      enabled: true,
      volume: 1,
      exercise: false,
      side: false,
      next: false,
    },
  });

  assert.equal(await queue.loadPack(), null);
  assert.equal(await queue.loadPack(), pack);
  queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  await queue.unlock();
  await flushQueue();
  assert.deepEqual(requested, [packUrl, packUrl, expectedAssetUrl]);
  assert.equal(context.sources.length, 1);
  assert.equal(speech.calls.length, 0);
});

test('missing or corrupt assets safely fall back to speech after unlock', async () => {
  const { context, speech, queue } = makeQueue({
    pack: packWith('go'),
    voiceSettings: {
      packId: 'frankentts-v1',
      enabled: true,
      volume: 1,
      exercise: false,
      side: false,
      next: false,
    },
    assetLoader: async () => { throw new Error('decode failed'); },
  });
  queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  assert.equal(await queue.unlock(), true);
  await flushQueue();
  assert.equal(context.sources.length, 0);
  assert.deepEqual(speech.calls.map((call) => call.text), ['Go']);
});

test('countdown arbitration suppresses tones that would overlap queued voice', async () => {
  let now = 1000;
  const { queue } = makeQueue({
    now: () => now,
    voiceSettings: {
      packId: 'browser-speech-v1',
      enabled: true,
      volume: 1,
      exercise: false,
      side: false,
      next: false,
    },
  });
  await queue.unlock();
  queue.handle(event('intervalStart', now, interval('Goblet squat', 'left')));
  await flushQueue();
  assert.equal(queue.shouldPlayCountdown({ type: 'countdown321', at: now }), false);
  assert.deepEqual(queue.arbitrateCountdown({ at: now }), { suppressed: true, reason: 'voice' });
  now = 10_000;
  assert.equal(queue.shouldPlayCountdown({ type: 'countdown321', at: now }), true);
});

test('clear and dispose stop WebAudio sources and cancel browser speech', async () => {
  const webAudio = makeQueue({
    pack: packWith('go'),
    voiceSettings: {
      packId: 'frankentts-v1',
      enabled: true,
      volume: 1,
      exercise: false,
      side: false,
      next: false,
    },
    assetLoader: async () => ({ duration: 2 }),
  });
  webAudio.queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  await webAudio.queue.unlock();
  await flushQueue();
  assert.equal(webAudio.context.sources.length, 1);
  await webAudio.queue.dispose();
  assert.ok(webAudio.context.sources[0].stopCount >= 2, 'scheduled and teardown stops are both safe');
  assert.equal(webAudio.speech.cancelCount, 1);
  assert.equal(webAudio.queue.context, null);
  assert.equal(webAudio.queue.shouldSuppressCountdown({ at: 1000 }), false);

  const speechOnly = makeQueue();
  speechOnly.queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  await speechOnly.queue.unlock();
  await flushQueue();
  assert.equal(speechOnly.speech.calls.length, 3);
  await speechOnly.queue.dispose();
  assert.equal(speechOnly.speech.cancelCount, 1);
});

test('rejects stale catch-up events and re-announces after skip-back, restart, or explicit reset', () => {
  const first = interval('Goblet squat', 'left');
  const second = interval('Push-up', 'right');
  const { queue } = makeQueue({ intervals: [first, second] });
  assert.equal(queue.handle({ ...event('intervalStart', 0, first), observedAt: 1000 }), false);
  assert.deepEqual(queue.getPendingPhraseIds(), []);

  assert.equal(queue.handle(event('intervalStart', 0, first)), true);
  assert.equal(queue.handle(event('intervalEnd', 100, first)), true);
  assert.equal(queue.handle(event('intervalStart', 200, second, 1)), true);
  assert.equal(queue.handle(event('intervalStart', 300, first)), true, 'skip-back gets a new cycle token');

  queue.handle({ type: 'tick', snapshot: { state: 'idle' }, at: 400, observedAt: 400 });
  assert.equal(queue.handle(event('intervalStart', 500, first)), true, 'restart idle tick resets announcements');
  queue.resetAnnouncements();
  assert.equal(queue.handle(event('intervalStart', 600, first)), true, 'explicit navigation reset allows re-announcement');
});

test('disabling voice cancels queued/scheduled work and zero volume never suppresses countdown', async () => {
  const active = makeQueue();
  await active.queue.unlock();
  active.queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  await flushQueue();
  assert.equal(active.queue.isVoiceActive(1000), true);
  active.queue.setSettings({ voice: { enabled: false } });
  assert.equal(active.queue.getPendingPhraseIds().length, 0);
  assert.equal(active.queue.isVoiceActive(1000), false);
  assert.equal(active.queue.shouldPlayCountdown({ at: 1000 }), true);
  assert.equal(active.speech.cancelCount, 1);

  const silent = makeQueue({
    voiceSettings: {
      packId: 'browser-speech-v1',
      enabled: true,
      volume: 0,
      exercise: true,
      side: true,
      next: true,
    },
  });
  await silent.queue.unlock();
  silent.queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  await flushQueue();
  assert.equal(silent.speech.calls.length, 0);
  assert.equal(silent.queue.isVoiceActive(1000), false);
  assert.equal(silent.queue.shouldPlayCountdown({ at: 1000 }), true);
});

test('hung pack loading is bounded and speech fallback starts without waiting for it', async () => {
  const { speech, queue } = makeQueue({
    packUrl: 'https://example.test/fittimer/data/voice/voice-pack-v1.json',
    baseUrl: 'https://example.test/fittimer/',
    fetchImpl: () => new Promise(() => {}),
    packLoadTimeoutMs: 10,
    voiceSettings: {
      packId: 'frankentts-v1',
      enabled: true,
      volume: 1,
      exercise: false,
      side: false,
      next: false,
    },
  });
  queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  const start = Date.now();
  assert.equal(await queue.unlock(), true);
  assert.ok(Date.now() - start < 100, 'Start must not await pack fetch');
  await flushQueue();
  assert.deepEqual(speech.calls.map((call) => call.text), ['Go']);
  assert.equal(await Promise.race([
    queue.loadPack(),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 100)),
  ]), null);
});

test('visibility resume restores a suspended voice context without re-announcing', async () => {
  const context = new FakeAudioContext();
  const { speech, queue } = makeQueue({ context });
  await queue.unlock();
  queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  await flushQueue();
  const speechCount = speech.calls.length;
  context.state = 'suspended';
  assert.equal(await queue.resume(), true);
  assert.equal(context.resumeCount, 2);
  assert.equal(speech.calls.length, speechCount);
});

test('voice context resume is bounded when a mobile resume hangs', async () => {
  const context = new FakeAudioContext({ resumeHangs: true });
  const { queue } = makeQueue({ context, resumeTimeoutMs: 10 });
  const startedAt = Date.now();
  assert.equal(await queue.resume(), false);
  assert.ok(Date.now() - startedAt < 100, 'visibility handling must not wait indefinitely');
});

test('app wiring resumes voice, preserves pause announcements, and arbitrates countdowns', async () => {
  const application = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(application, /import \{ VoiceCueQueue \} from '\.\/voice-cues\.mjs'/);
  assert.match(application, /voiceCues\.setIntervals\(routine\.intervals\)/);
  assert.match(application, /voiceCues\.clear\(\{ resetAnnouncements: false \}\)/);
  assert.match(application, /voiceCues\.resume\(\)/);
  assert.match(application, /voiceAllowsCountdown/);
});

test('failed WebAudio resume is closed before context disposal and playback exceptions stay per-item', async () => {
  const failedContext = new FakeAudioContext({ resumeFails: true });
  const failed = makeQueue({ context: failedContext });
  assert.equal(await failed.queue.unlock(), true);
  assert.equal(failedContext.closeCount, 1);
  assert.equal(failed.queue.context, null);

  const throwingContext = new FakeAudioContext({ startFails: true });
  const throwing = makeQueue({
    context: throwingContext,
    pack: packWith('go'),
    voiceSettings: {
      packId: 'frankentts-v1',
      enabled: true,
      volume: 1,
      exercise: false,
      side: false,
      next: false,
    },
    assetLoader: async () => ({ duration: 0.4 }),
  });
  throwing.queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  await throwing.queue.unlock();
  await flushQueue();
  assert.deepEqual(throwing.speech.calls.map((call) => call.text), ['Go']);
  assert.equal(throwing.queue.draining, false);

  const stopThrowingContext = new FakeAudioContext({ stopFails: true });
  const stopThrowing = makeQueue({
    context: stopThrowingContext,
    pack: packWith('go'),
    voiceSettings: {
      packId: 'frankentts-v1',
      enabled: true,
      volume: 1,
      exercise: false,
      side: false,
      next: false,
    },
    assetLoader: async () => ({ duration: 0.4 }),
  });
  stopThrowing.queue.handle(event('intervalStart', 0, interval('Goblet squat', 'left')));
  await stopThrowing.queue.unlock();
  await flushQueue();
  assert.equal(stopThrowingContext.sources.length, 1);
  assert.equal(stopThrowing.queue.draining, false);
});
