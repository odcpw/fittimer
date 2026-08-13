import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const elements = {
  host: document.querySelector('#canvas-host'),
  load: document.querySelector('#load-state'),
  play: document.querySelector('#play-toggle'),
  restart: document.querySelector('#restart'),
  face: document.querySelector('#face-toggle'),
  timeline: document.querySelector('#timeline'),
  current: document.querySelector('#current-time'),
  duration: document.querySelector('#duration'),
  speeds: document.querySelector('#speed-controls'),
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
scene.fog = new THREE.Fog(0x0b0f14, 5, 9);
scene.add(new THREE.HemisphereLight(0xe9f3ff, 0x27313c, 2.8));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.1);
keyLight.position.set(1.8, 4, 3);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xff806d, 1.8);
rimLight.position.set(-3, 2, -3);
scene.add(rimLight);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(3.2, 80),
  new THREE.MeshStandardMaterial({ color: 0x151b22, roughness: 0.94 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(6.4, 24, 0x384451, 0x202832);
grid.position.y = 0.002;
grid.material.transparent = true;
grid.material.opacity = 0.52;
scene.add(grid);

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 30);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.14;
elements.host.append(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.0;
controls.maxDistance = 6;
controls.maxPolarAngle = Math.PI * 0.495;

const LEFT = 0x5dc9ff;
const RIGHT = 0xff806d;
const CENTER = 0xc9ff3d;
const FACE = 0xdce5ef;
const yAxis = new THREE.Vector3(0, 1, 0);
const source = new THREE.Vector3();
const target = new THREE.Vector3();
const midpoint = new THREE.Vector3();
const timer = new THREE.Timer();
timer.connect(document);

let motion = null;
let joints = [];
let bones = [];
let torso = null;
let head = null;
let playhead = 0;
let playing = true;
let speed = 1;
let faceVisible = false;

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe % 60).toFixed(2).padStart(5, '0')}`;
}

function isLeft(index) {
  const name = motion.keypointNames[index];
  return name.startsWith('left_') || (index >= 91 && index < 112);
}

function isRight(index) {
  const name = motion.keypointNames[index];
  return name.startsWith('right_') || index >= 112;
}

function isFace(index) {
  const [start, end] = motion.keypointParts.face;
  return index >= start && index < end;
}

function isHand(index) {
  return index >= motion.keypointParts.leftHand[0];
}

function isFoot(index) {
  const [start, end] = motion.keypointParts.feet;
  return index >= start && index < end;
}

function colorFor(index) {
  if (isFace(index)) return FACE;
  if (isLeft(index)) return LEFT;
  if (isRight(index)) return RIGHT;
  return CENTER;
}

function jointRadius(index) {
  if (isFace(index)) return 0.006;
  if (isHand(index)) return 0.012;
  if (isFoot(index)) return 0.018;
  return index < 5 ? 0.018 : 0.031;
}

function makeJoint(index) {
  const joint = new THREE.Mesh(
    new THREE.SphereGeometry(jointRadius(index), 14, 10),
    new THREE.MeshStandardMaterial({ color: colorFor(index), roughness: 0.46, metalness: 0.04 }),
  );
  joint.visible = !isFace(index);
  scene.add(joint);
  return joint;
}

function makeBone([first, second]) {
  const detail = isHand(first) || isFoot(first) || isHand(second) || isFoot(second);
  const bone = new THREE.Mesh(
    new THREE.CylinderGeometry(detail ? 0.006 : 0.018, detail ? 0.008 : 0.024, 1, detail ? 8 : 14),
    new THREE.MeshStandardMaterial({ color: colorFor(first), roughness: 0.5, metalness: 0.03 }),
  );
  scene.add(bone);
  return { first, second, mesh: bone };
}

function updateBone(bone, points) {
  source.fromArray(points[bone.first]);
  target.fromArray(points[bone.second]);
  midpoint.copy(source).add(target).multiplyScalar(0.5);
  const direction = target.clone().sub(source);
  const length = Math.max(direction.length(), 0.0001);
  bone.mesh.position.copy(midpoint);
  bone.mesh.scale.set(1, length, 1);
  bone.mesh.quaternion.setFromUnitVectors(yAxis, direction.normalize());
}

function updateTorso(points) {
  const order = [6, 5, 12, 11];
  const positions = torso.geometry.attributes.position;
  order.forEach((index, vertex) => positions.setXYZ(vertex, ...points[index]));
  positions.needsUpdate = true;
  torso.geometry.computeVertexNormals();

  const leftEar = source.fromArray(points[3]);
  const rightEar = target.fromArray(points[4]);
  head.position.copy(leftEar).add(rightEar).multiplyScalar(0.5);
  const earDistance = Math.max(leftEar.distanceTo(rightEar), 0.06);
  head.scale.setScalar(earDistance / 0.14);
}

function interpolatedPoints(framePosition) {
  const firstFrame = Math.floor(framePosition) % motion.frames.length;
  const secondFrame = (firstFrame + 1) % motion.frames.length;
  const alpha = framePosition - Math.floor(framePosition);
  const first = motion.frames[firstFrame];
  const second = motion.frames[secondFrame];
  return first.map((point, index) => [
    THREE.MathUtils.lerp(point[0], second[index][0], alpha),
    THREE.MathUtils.lerp(point[1], second[index][1], alpha),
    THREE.MathUtils.lerp(point[2], second[index][2], alpha),
  ]);
}

function setInterpolatedFrame(framePosition) {
  const points = interpolatedPoints(framePosition);
  points.forEach((point, index) => joints[index].position.fromArray(point));
  bones.forEach((bone) => updateBone(bone, points));
  updateTorso(points);
}

function resetCamera() {
  camera.position.set(0.0, 1.15, 2.65);
  controls.target.set(0.02, 0.38, 0);
  camera.lookAt(controls.target);
  controls.update();
}

function setEnabled(enabled) {
  elements.play.disabled = !enabled;
  elements.restart.disabled = !enabled;
  elements.face.disabled = !enabled;
  elements.timeline.disabled = !enabled;
  elements.speeds.disabled = !enabled;
}

async function loadMotion() {
  motion = await fetch('assets/deadbug-rtmw3d.json?v=1', {
    signal: AbortSignal.timeout(10000),
  }).then((response) => {
    if (!response.ok) throw new Error(`Motion request failed: ${response.status}`);
    return response.json();
  });
  if (motion.modelLandmarks !== 133 || motion.frames.some((frame) => frame.length !== 133)) {
    throw new Error('Whole-body motion does not contain 133 landmarks per frame');
  }
  joints = motion.keypointNames.map((_, index) => makeJoint(index));
  bones = motion.edges.map(makeBone);

  const torsoGeometry = new THREE.BufferGeometry();
  const torsoPositions = Float32Array.from({ length: 12 }, () => 0);
  torsoGeometry.setAttribute('position', new THREE.BufferAttribute(torsoPositions, 3));
  torsoGeometry.setIndex([0, 2, 1, 1, 2, 3]);
  torso = new THREE.Mesh(
    torsoGeometry,
    new THREE.MeshStandardMaterial({
      color: 0x9aa9ba,
      transparent: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
      roughness: 0.72,
    }),
  );
  scene.add(torso);
  head = new THREE.Mesh(
    new THREE.SphereGeometry(0.10, 24, 18),
    new THREE.MeshStandardMaterial({ color: 0xd7dee7, transparent: true, opacity: 0.58, roughness: 0.58 }),
  );
  scene.add(head);

  setInterpolatedFrame(0);
  elements.duration.textContent = formatTime(motion.durationSeconds);
  setEnabled(true);
  const detailPoints = motion.modelLandmarks - (motion.keypointParts.face[1] - motion.keypointParts.face[0]);
  elements.load.textContent = `${detailPoints} movement points shown · 133 captured`;
  elements.load.classList.add('is-hidden');
}

elements.play.onclick = () => {
  playing = !playing;
  elements.play.textContent = playing ? 'Pause' : 'Play';
};

elements.restart.onclick = () => {
  playhead = 0;
  setInterpolatedFrame(0);
};

elements.face.onclick = () => {
  faceVisible = !faceVisible;
  joints.forEach((joint, index) => {
    if (isFace(index)) joint.visible = faceVisible;
  });
  elements.face.setAttribute('aria-pressed', String(faceVisible));
  elements.face.textContent = `Face points ${faceVisible ? 'on' : 'off'}`;
};

elements.timeline.oninput = () => {
  if (!motion) return;
  playhead = Number(elements.timeline.value) * motion.durationSeconds;
  setInterpolatedFrame(playhead * motion.fps);
};

elements.speeds.onclick = (event) => {
  const button = event.target.closest('button[data-speed]');
  if (!button) return;
  speed = Number(button.dataset.speed);
  for (const item of elements.speeds.querySelectorAll('button')) {
    item.classList.toggle('is-active', item === button);
  }
};

renderer.domElement.ondblclick = resetCamera;
new ResizeObserver(() => {
  const { clientWidth, clientHeight } = elements.host;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / Math.max(1, clientHeight);
  camera.updateProjectionMatrix();
}).observe(elements.host);

renderer.setAnimationLoop(() => {
  timer.update();
  if (motion) {
    if (playing) playhead = (playhead + timer.getDelta() * speed) % motion.durationSeconds;
    setInterpolatedFrame(playhead * motion.fps);
    elements.timeline.value = String(playhead / motion.durationSeconds);
    elements.current.textContent = formatTime(playhead);
  }
  controls.update();
  renderer.render(scene, camera);
});

resetCamera();
loadMotion().catch((error) => {
  console.error(error);
  elements.load.textContent = 'Could not load the RTMW3D dead-bug motion';
  elements.load.className = 'load-state is-error';
});
