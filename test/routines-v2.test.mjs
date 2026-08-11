import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { validateFiles } from '../scripts/validate.mjs';

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse routine fixture ${file}`, { cause: error });
  }
}

const index = await readJson('data/content-index.json');
const mediaPack = await readJson('data/media/gif-v1.json');

const routineFiles = [
  'data/routines/iron-roots.json',
  'data/routines/silk-coils.json',
  'data/routines/dragon-longform.json',
  'data/routines/crane-longform.json',
];

const n = (name, side = null) => ({ name, side });
const pair = (name) => [n(`${name} (left)`, 'left'), n(`${name} (right)`, 'right')];

const expected = {
  'iron-roots': {
    duration: 1800,
    block: 'iron-roots',
    intervals: [
      n('March + Arm Circles'),
      n('Bodyweight Squat, Deepening'),
      n('Hip Hinge + Reach'),
      n('Ankle Pumps + Heel-to-toe Rocks'),
      n('Standing Wall Scapular Reach'),
      n('Lateral Step + Relaxed Arm Sweep'),
      ...pair('Split Squat'),
      n('Push-up'),
      ...pair('Single-leg RDL'),
      ...pair('One-arm Row'),
      n('Glute Bridge March'),
      n('Horse-stance Goblet Hold'),
      ...pair('Slow Step-up'),
      n('Prone W Raise'),
      n('Suitcase March', 'alternating'),
      n('Quadruped Thread-the-needle', 'alternating'),
      n('Dead Bug'),
      ...pair('Slow Front Kick'),
      ...pair('Single-leg Calf Raise'),
      ...pair('Wall-press Hip-abduction Isometric'),
      n('Two-hand DB Swing'),
      n('Backward Walking'),
      n('Breathing + Easy Reach'),
    ],
  },
  'silk-coils': {
    duration: 1800,
    block: 'silk-coils',
    intervals: [
      n('March + Shoulder Rolls'),
      n('Cat-cow → Child Reach'),
      n('90/90 Hip Switches'),
      n('Alternating Side-bend Reach'),
      n('Wall Slides'),
      n('Ankle Pumps + Heel-to-toe Rocks'),
      n('Goblet Squat'),
      ...pair('Lateral Lunge'),
      ...pair('B-stance RDL'),
      ...pair('Supported One-arm Row'),
      n('Slow Push-up'),
      ...pair('Half-kneeling Press'),
      ...pair('Diagonal Chop'),
      n('Front-rack Press-out', 'alternating'),
      ...pair('Wall-press Hip-abduction Isometric'),
      ...pair('Slow Roundhouse Chamber'),
      ...pair('Seated Soleus Raise'),
      n('Tibialis Raises'),
      n('DB Knee-drive March'),
      n('Foot-planted Shadowboxing'),
      n('Lateral Step-to-balance + Short-foot'),
      n('Supported Side Reach + Breathing', 'alternating'),
    ],
  },
  'dragon-longform': {
    duration: 2700,
    block: 'dragon-longform',
    intervals: [
      n('March Ramp'),
      n('Ankle Pumps + Heel-to-toe Rocks'),
      n('Bodyweight Squat, Deepening'),
      n('Hip Hinge + Reach'),
      n('90/90 Hip Switches'),
      n('Standing Wall Scapular Reach'),
      ...pair('Single-leg Balance + Short-foot'),
      ...pair('Slow Front Kick'),
      ...pair('Split Squat'),
      n('1.5-rep Push-up'),
      ...pair('Single-leg RDL'),
      ...pair('One-arm Row'),
      ...pair('Half-kneeling Press'),
      ...pair('Single-leg Glute Bridge'),
      n('Horse-stance Goblet Hold'),
      ...pair('Weighted Straight-knee Calf Raise'),
      ...pair('Seated Soleus Raise'),
      n('Knee-lift Cardio'),
      n('DB Swing'),
      ...pair('Lateral Step-and-reach'),
      n('Knees-down Inchworm Walkout'),
      n('Foot-planted Shadowboxing'),
      n('Backward Walking'),
      n('Two-DB Farmer Carry'),
      ...pair('Wall-press Hip Isometric'),
      ...pair('Seated Psoas Raise'),
      ...pair('Wall External-rotation Isometric'),
      ...pair('Supported Standing Side-leg Raise'),
      ...pair('Hip-flexor Stretch'),
      n('Breathing + Reach'),
    ],
  },
  'crane-longform': {
    duration: 2700,
    block: 'crane-longform',
    intervals: [
      n('March + Arm Circles'),
      n('Cat-cow'),
      ...pair('Controlled Leg Pendulum'),
      n('Lateral Squat Rock'),
      n('Wall Slides'),
      n('Ankle Pumps + Heel-to-toe Rocks'),
      ...pair('Lateral Step-to-balance'),
      ...pair('Crane-stance Hold'),
      ...pair('Slow Step-down'),
      ...pair('Slow Side Kick'),
      ...pair('Slow Roundhouse Chamber'),
      n('Goblet Squat'),
      n('Push-up Plus'),
      ...pair('Lateral Lunge'),
      ...pair('One-arm DB Snatch'),
      n('Two-arm Bent-over Row'),
      n('Suitcase March', 'alternating'),
      n('Two-DB Romanian Deadlift'),
      ...pair('Single-leg Glute Bridge'),
      n('Dead Bug'),
      ...pair('Weighted Straight-knee Calf Raise'),
      ...pair('Seated Soleus Raise'),
      ...pair('Hip Hitch'),
      n('Prone Y/W'),
      n('Toe-spread + Short-foot', 'alternating'),
      n('Foot-planted Shadowboxing'),
      n('Brisk Backward Walking'),
      n('Seated Straddle Active Hinge'),
      n('Supine Active Hamstring Extension', 'alternating'),
      ...pair('Hip-flexor Stretch'),
      n('Side-bend Holds', 'alternating'),
      n('Breathing'),
    ],
  },
};

function expandedIntervals(routine, blocks) {
  return routine.sequence.flatMap((item) => {
    if (item.interval) return [item.interval];
    return blocks.get(item.blockId).intervals;
  });
}

test('Fable W1-W4 preserve canonical order, sides, exact duration, and media coverage', async () => {
  assert.deepEqual(index.routines.slice(1), routineFiles, 'Fable routines must be registered after MadFit');

  const blocks = new Map();
  for (const [blockId, file] of Object.entries(index.blocks)) {
    blocks.set(blockId, await readJson(file));
  }

  const allMovementIds = new Set();
  for (const routineFile of routineFiles) {
    const routine = await readJson(routineFile);
    const spec = expected[routine.id];
    assert.ok(spec, `missing expected spec for ${routine.id}`);
    assert.equal(index.blocks[spec.block], `data/blocks/${spec.block}.json`);

    const intervals = expandedIntervals(routine, blocks);
    assert.equal(intervals.length, spec.intervals.length, `${routine.id} interval count`);
    assert.deepEqual(
      intervals.map(({ displayName, side }) => [displayName, side ?? null]),
      spec.intervals.map(({ name, side }) => [name, side]),
      `${routine.id} interval order/sides`,
    );
    assert.equal(routine.estimatedDurationSeconds, spec.duration, `${routine.id} duration metadata`);
    assert.equal(
      intervals.reduce((total, interval) => total + interval.workSeconds + interval.restSeconds, 0),
      spec.duration,
      `${routine.id} expanded duration`,
    );
    assert.ok(intervals.every((interval) => interval.workSeconds === 40 && interval.restSeconds === 20));
    assert.equal(intervals.at(-1).restSeconds, 20, `${routine.id} final rest`);
    assert.ok(routine.safetyCues.length >= 8, `${routine.id} global safety cues`);

    for (const interval of intervals) {
      for (const movement of interval.movements) {
        allMovementIds.add(movement.movementId);
        assert.match(movement.movementId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        const entry = mediaPack.entries[movement.movementId];
        assert.ok(entry, `${routine.id} movement ${movement.movementId} is covered by gif-v1`);
        if (movement.textOnly === true) {
          assert.deepEqual(entry.assets, [], `${movement.movementId} must remain text-only`);
          assert.equal(entry.fallback, 'text', `${movement.movementId} text fallback`);
        } else {
          assert.ok(
            entry.assets.length > 0 || entry.fallback === 'text',
            `${movement.movementId} needs a public visual or explicit text fallback`,
          );
        }
      }
    }
  }

  assert.ok(allMovementIds.has('push-ups'));
  assert.ok(allMovementIds.has('slow-push-up'));
  assert.ok(allMovementIds.has('one-and-a-half-rep-push-up'));
  assert.ok(allMovementIds.has('push-up-plus'));
  assert.ok(allMovementIds.has('single-leg-rdl'));
  assert.ok(allMovementIds.has('dumbbell-swing'));
  assert.ok(allMovementIds.has('inchworm'));
  assert.ok(allMovementIds.has('dumbbell-snatch'));

  const pushUpIdsByName = new Map();
  const wallPressIntervals = [];
  for (const blockId of ['iron-roots', 'silk-coils', 'dragon-longform', 'crane-longform']) {
    for (const interval of blocks.get(blockId).intervals) {
      if (interval.displayName.includes('Push-up')) {
        pushUpIdsByName.set(interval.displayName, interval.movements[0].movementId);
      }
      if (interval.movements.some(({ movementId }) => movementId === 'wall-press-hip-abduction-isometric')) {
        wallPressIntervals.push(interval);
      }
    }
  }
  assert.deepEqual(Object.fromEntries(pushUpIdsByName), {
    'Push-up': 'push-ups',
    'Slow Push-up': 'slow-push-up',
    '1.5-rep Push-up': 'one-and-a-half-rep-push-up',
    'Push-up Plus': 'push-up-plus',
  });
  assert.equal(wallPressIntervals.length, 6);
  assert.ok(wallPressIntervals.every(({ coachNote }) =>
    coachNote === 'Load the stance leg and press the inside knee into the wall in two bouts while keeping the pelvis level.'
  ));

  const result = await validateFiles(routineFiles);
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
});
