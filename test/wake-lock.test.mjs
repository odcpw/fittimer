import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMovementVisual } from '../src/app.mjs';
import { WakeLockController } from '../src/wake-lock.mjs';

class FakeSentinel extends EventTarget {
  constructor({ rejectRelease = false } = {}) {
    super();
    this.released = false;
    this.releaseCalls = 0;
    this.rejectRelease = rejectRelease;
  }

  async release() {
    this.releaseCalls += 1;
    if (this.rejectRelease) throw new Error('release rejected');
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

function fakeWakeLock({ rejectRequest = false, rejectRelease = false } = {}) {
  const state = { requestCalls: 0, sentinels: [] };
  return {
    state,
    wakeLock: {
      async request(type) {
        state.requestCalls += 1;
        assert.equal(type, 'screen');
        if (rejectRequest) throw new Error('request rejected');
        const sentinel = new FakeSentinel({ rejectRelease });
        state.sentinels.push(sentinel);
        return sentinel;
      },
    },
  };
}

test('unsupported wake lock APIs degrade to quiet false results', async () => {
  const controller = new WakeLockController({ navigatorObject: {} });
  assert.equal(controller.supported, false);
  assert.equal(await controller.request(), false);
  assert.equal(await controller.release(), false);
});

test('requests once, releases, and reacquires after a released sentinel', async () => {
  const fake = fakeWakeLock();
  const controller = new WakeLockController({ navigatorObject: fake });

  assert.equal(await controller.request(), true);
  assert.equal(await controller.request(), true);
  assert.equal(fake.state.requestCalls, 1);

  await controller.release();
  assert.equal(fake.state.sentinels[0].releaseCalls, 1);
  assert.equal(await controller.request(), true);
  assert.equal(fake.state.requestCalls, 2);
});

test('a browser release event clears the controller for visibility reacquisition', async () => {
  const fake = fakeWakeLock();
  const controller = new WakeLockController({ navigatorObject: fake });

  await controller.request();
  fake.state.sentinels[0].released = true;
  fake.state.sentinels[0].dispatchEvent(new Event('release'));

  assert.equal(await controller.request(), true);
  assert.equal(fake.state.requestCalls, 2);
});

test('request and release rejections are swallowed and do not poison later requests', async () => {
  const rejectedRequest = fakeWakeLock({ rejectRequest: true });
  const requestController = new WakeLockController({ navigatorObject: rejectedRequest });
  assert.equal(await requestController.request(), false);

  const rejectedRelease = fakeWakeLock({ rejectRelease: true });
  const releaseController = new WakeLockController({ navigatorObject: rejectedRelease });
  assert.equal(await releaseController.request(), true);
  assert.equal(await releaseController.release(), false);
  assert.equal(await releaseController.request(), true);
});

test('release cancels an in-flight request so a quick resume can reacquire', async () => {
  let resolveFirstRequest;
  const fake = {
    state: { requestCalls: 0, sentinels: [] },
    wakeLock: {
      request() {
        fake.state.requestCalls += 1;
        if (fake.state.requestCalls === 1) {
          return new Promise((resolve) => {
            resolveFirstRequest = resolve;
          });
        }
        const sentinel = new FakeSentinel();
        fake.state.sentinels.push(sentinel);
        return Promise.resolve(sentinel);
      },
    },
  };
  const controller = new WakeLockController({ navigatorObject: fake });
  const firstRequest = controller.request();
  await controller.release();
  const resumedRequest = controller.request();
  resolveFirstRequest(new FakeSentinel());

  assert.equal(await firstRequest, false);
  assert.equal(await resumedRequest, true);
  assert.equal(fake.state.requestCalls, 2);
});

test('dispose releases an active sentinel and prevents re-acquisition', async () => {
  const fake = fakeWakeLock();
  const controller = new WakeLockController({ navigatorObject: fake });
  await controller.request();
  await controller.dispose();

  assert.equal(fake.state.sentinels[0].releaseCalls, 1);
  assert.equal(await controller.request(), false);
  assert.equal(fake.state.requestCalls, 1);
});

test('side-specific media wins without selecting the opposite side, including first/second', () => {
  const pack = {
    entries: {
      unilateral: {
        assets: [
          { type: 'gif', url: 'data/gifs/side-1.gif', side: 'first' },
          { type: 'gif', url: 'data/gifs/generic.gif' },
          { type: 'gif', url: 'data/gifs/side-2.gif', side: 'second' },
        ],
      },
      generic: {
        assets: [{ type: 'gif', url: 'data/gifs/generic-only.gif' }],
      },
    },
  };

  const sideTwo = resolveMovementVisual(
    { movementId: 'unilateral', displayName: 'Side two' },
    pack,
    { requestedSide: 'second' },
  );
  assert.equal(sideTwo.asset.side, 'second');
  assert.notEqual(sideTwo.asset.side, 'first');

  const sideOne = resolveMovementVisual(
    { movementId: 'unilateral', displayName: 'Side one' },
    pack,
    { requestedSide: 'first' },
  );
  assert.equal(sideOne.asset.side, 'first');

  const generic = resolveMovementVisual(
    { movementId: 'Generic GIF', displayName: 'Generic' },
    { entries: { 'Generic GIF': pack.entries.generic } },
    { requestedSide: 'second' },
  );
  assert.equal(generic.asset.url, 'data/gifs/generic-only.gif');
});

process.stdout.write('Wake lock and side selection tests passed: lifecycle, rejection, release event, teardown, and media preference.\n');
