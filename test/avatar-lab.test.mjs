import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const assets = [
  ['bodyweight-squat.glb', 'Bodyweight squat'],
  ['reverse-lunge-knee-drive.glb', 'Reverse lunge + knee drive'],
  ['butt-kicks.glb', 'Butt kicks'],
];

const ironRootAssets = [
  'iron-roots-march-arm-circles.glb',
  'iron-roots-deepening-squat.glb',
  'iron-roots-hip-hinge-reach.glb',
  'iron-roots-ankle-calf-rocks.glb',
  'iron-roots-wall-scapular-reach.glb',
];

async function readGlbJson(file) {
  const buffer = await readFile(path.join('avatar-lab', 'assets', file));
  assert.equal(buffer.subarray(0, 4).toString(), 'glTF');
  assert.equal(buffer.readUInt32LE(4), 2);
  assert.equal(buffer.readUInt32LE(8), buffer.length);
  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.subarray(16, 20).toString(), 'JSON');
  try {
    return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString().trim());
  } catch (error) {
    assert.fail(`${file} contains malformed glTF JSON: ${error.message}`);
  }
}

test('avatar lab ships one real skinned target with a loop for every assessment movement', async () => {
  for (const [file, expectedName] of assets) {
    const gltf = await readGlbJson(file);
    assert.equal(gltf.asset.version, '2.0');
    assert.equal(gltf.skins.length, 1);
    assert.equal(gltf.meshes.length, 1);
    assert.ok(gltf.nodes.some((node) => Number.isInteger(node.skin)), `${file} must bind its mesh to a skin`);
    assert.equal(gltf.animations.length, 1);
    assert.equal(gltf.animations[0].name, expectedName);
    assert.ok(gltf.animations[0].channels.length > 60, `${file} must animate the armature, not a prop`);

    const motion = gltf.nodes.find((node) => node.extras?.fitTimerMotion)?.extras.fitTimerMotion;
    assert.equal(motion?.retargetSpace, 'world-rest-basis-v2');
    assert.ok(motion.verification.maxJointDirectionErrorDegrees < 3, `${file} must follow source joint directions`);
    assert.ok(motion.verification.maxFootDirectionErrorDegrees < 3, `${file} must keep feet on their explicit target`);
    assert.ok(motion.verification.maxGroundErrorMeters < 0.002, `${file} must stay grounded`);

    const durations = [...new Set(gltf.animations[0].samplers.map((sampler) => sampler.input))]
      .map((accessor) => gltf.accessors[accessor].max[0]);
    assert.ok(durations.every((duration) => duration >= 2 && duration <= 5), `${file} needs a short review loop`);
  }
});

test('FitTimer links to a Michelle lab with three creator-labelled assessment controls', async () => {
  const home = await readFile('index.html', 'utf8');
  const html = await readFile('avatar-lab/index.html', 'utf8');
  const source = await readFile('avatar-lab/lab.mjs', 'utf8');
  const css = await readFile('avatar-lab/lab.css', 'utf8');

  assert.match(home, /href="avatar-lab\/index\.html"/);
  assert.match(home, /Meet Michelle/);
  assert.match(html, /Michelle/);
  assert.match(html, /Drag to rotate/);
  assert.match(html, /Scroll or pinch to zoom/);
  assert.match(html, /id="timeline"/);
  assert.match(html, /id="skeleton-toggle"/);
  assert.match(source, /new OrbitControls/);
  assert.match(source, /controls\.enablePan = false/);
  assert.match(source, /controls\.maxPolarAngle/);
  assert.match(source, /new THREE\.SkeletonHelper/);
  assert.match(source, /new THREE\.Box3\(\)\.setFromObject/);
  assert.match(source, /THREE\.LoopRepeat/);
  assert.match(html, /not yet biomechanical/);
  assert.doesNotMatch(source, /dead-bug-experimental\.glb/);
  assert.equal(source.match(/asset: 'assets\//g)?.length, 3);
  for (const [file] of assets) assert.match(source, new RegExp(file.replaceAll('.', '\\.')));
  for (const creator of ['MadFit', 'Sydney Cummings', 'Growingannanas']) assert.match(source, new RegExp(creator));
  assert.match(css, /@media \(max-width: 760px\)/);
});

test('hinge-and-push lab ships five selectable 15-second Vitruvian motion loops', async () => {
  const html = await readFile('avatar-lab/iron-roots-motion.html', 'utf8');
  const source = await readFile('avatar-lab/iron-roots-motion.mjs', 'utf8');

  assert.equal(html.match(/data-motion=/g)?.length, 5);
  assert.match(html, /March \+ Arm Circles/);
  assert.match(html, /Deepening Squat/);
  assert.match(html, /Hip Hinge \+ Reach/);
  assert.match(html, /Ankle Pumps \+ Heel-to-toe Rocks/);
  assert.match(html, /Wall Scapular Reach/);
  assert.match(source, /new OrbitControls/);
  assert.match(source, /THREE\.LoopRepeat/);

  for (const file of ironRootAssets) {
    assert.match(source, new RegExp(file.replaceAll('.', '\\.')));
    const gltf = await readGlbJson(file);
    assert.equal(gltf.skins.length, 1);
    assert.equal(gltf.meshes.length, 1);
    assert.equal(gltf.animations.length, 1);
    assert.ok(gltf.animations[0].channels.length > 500);
    const motion = gltf.nodes.find((node) => node.extras?.fitTimerMotion)?.extras.fitTimerMotion;
    assert.equal(motion?.kind, 'fitTimerRtmw3dRigifyMotion');
    assert.equal(motion?.durationSeconds, 15);
    assert.equal(motion?.loop, true);
  }
});
