import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const elements = {
  host: document.querySelector('#canvas-host'),
  load: document.querySelector('#load-state'),
  play: document.querySelector('#play-toggle'),
  restart: document.querySelector('#restart'),
  timeline: document.querySelector('#timeline'),
  current: document.querySelector('#current-time'),
  duration: document.querySelector('#duration'),
  speeds: document.querySelector('#speed-controls'),
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
scene.fog = new THREE.Fog(0x0b0f14, 5.5, 10);
scene.add(new THREE.HemisphereLight(0xe9f3ff, 0x27313c, 2.8));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
keyLight.position.set(1.8, 4, 3);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xff806d, 2.0);
rimLight.position.set(-3, 2, -3);
scene.add(rimLight);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(3.6, 80),
  new THREE.MeshStandardMaterial({ color: 0x151b22, roughness: 0.94 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(7.2, 24, 0x384451, 0x202832);
grid.position.y = 0.002;
grid.material.transparent = true;
grid.material.opacity = 0.55;
scene.add(grid);

const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 40);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
elements.host.append(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.1;
controls.maxDistance = 7;
controls.maxPolarAngle = Math.PI * 0.495;

const timer = new THREE.Timer();
timer.connect(document);
const yAxis = new THREE.Vector3(0, 1, 0);
const source = new THREE.Vector3();
const target = new THREE.Vector3();
const midpoint = new THREE.Vector3();
let motion = null;
let markerIndex = null;
let joints = [];
let bones = [];
let torso = null;
let head = null;
let playhead = 0;
let playing = true;
let speed = 1;

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe % 60).toFixed(2).padStart(5, '0')}`;
}

function colorFor(name) {
  if (name.startsWith('R')) return 0xff806d;
  if (name.startsWith('L')) return 0x5dc9ff;
  return 0xc9ff3d;
}

function makeJoint(name) {
  const geometry = new THREE.SphereGeometry(name === 'midHip' ? 0.065 : 0.048, 22, 16);
  const material = new THREE.MeshStandardMaterial({
    color: colorFor(name),
    roughness: 0.48,
    metalness: 0.05,
  });
  const joint = new THREE.Mesh(geometry, material);
  scene.add(joint);
  return joint;
}

function makeBone(first, second) {
  const color = first.startsWith('R') ? 0xff806d : first.startsWith('L') ? 0x5dc9ff : 0xc9ff3d;
  const bone = new THREE.Mesh(
    new THREE.CylinderGeometry(0.027, 0.034, 1, 16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.52, metalness: 0.04 }),
  );
  scene.add(bone);
  return { first: markerIndex.get(first), second: markerIndex.get(second), mesh: bone };
}

function updateBone(bone, points) {
  source.fromArray(points[bone.first]);
  target.fromArray(points[bone.second]);
  midpoint.copy(source).add(target).multiplyScalar(0.5);
  const direction = target.clone().sub(source);
  const length = direction.length();
  bone.mesh.position.copy(midpoint);
  bone.mesh.scale.set(1, length, 1);
  bone.mesh.quaternion.setFromUnitVectors(yAxis, direction.normalize());
}

function updateTorso(points) {
  const order = ['RShoulder', 'LShoulder', 'RHip', 'LHip'];
  const position = torso.geometry.attributes.position;
  order.forEach((name, index) => {
    const point = points[markerIndex.get(name)];
    position.setXYZ(index, point[0], point[1], point[2]);
  });
  position.needsUpdate = true;
  torso.geometry.computeVertexNormals();

  const neck = source.fromArray(points[markerIndex.get('Neck')]);
  const hip = target.fromArray(points[markerIndex.get('midHip')]);
  head.position.copy(neck).add(neck.clone().sub(hip).normalize().multiplyScalar(0.15));
}

function setFrame(frameNumber) {
  const points = motion.frames[frameNumber];
  points.forEach((point, index) => joints[index].position.fromArray(point));
  bones.forEach((bone) => updateBone(bone, points));
  updateTorso(points);
}

function resetCamera() {
  camera.position.set(2.55, 1.7, 2.8);
  controls.target.set(0.05, 0.32, 0);
  camera.lookAt(controls.target);
  controls.update();
}

async function loadMotion() {
  motion = await fetch('assets/deadbug-opensim.json?v=1', {
    signal: AbortSignal.timeout(10000),
  }).then((response) => {
    if (!response.ok) throw new Error(`Motion request failed: ${response.status}`);
    return response.json();
  });
  markerIndex = new Map(motion.markerNames.map((name, index) => [name, index]));
  joints = motion.markerNames.map(makeJoint);
  bones = motion.edges.map(([first, second]) => makeBone(first, second));
  const torsoGeometry = new THREE.BufferGeometry();
  const torsoPositions = Float32Array.from({ length: 12 }, () => 0);
  torsoGeometry.setAttribute('position', new THREE.BufferAttribute(torsoPositions, 3));
  torsoGeometry.setIndex([0, 2, 1, 1, 2, 3]);
  torso = new THREE.Mesh(
    torsoGeometry,
    new THREE.MeshStandardMaterial({
      color: 0x9aa9ba,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.7,
    }),
  );
  scene.add(torso);
  head = new THREE.Mesh(
    new THREE.SphereGeometry(0.105, 28, 20),
    new THREE.MeshStandardMaterial({ color: 0xd7dee7, roughness: 0.58 }),
  );
  scene.add(head);
  setFrame(0);
  const duration = (motion.frames.length - 1) / motion.fps;
  elements.duration.textContent = formatTime(duration);
  elements.play.disabled = false;
  elements.restart.disabled = false;
  elements.timeline.disabled = false;
  elements.speeds.disabled = false;
  elements.load.textContent = `${motion.frames.length} OpenSim frames · ${motion.reprojection.rmsPixels.toFixed(1)} px RMS`;
  elements.load.classList.add('is-hidden');
}

elements.play.onclick = () => {
  playing = !playing;
  elements.play.textContent = playing ? 'Pause' : 'Play';
};

elements.restart.onclick = () => {
  playhead = 0;
  setFrame(0);
};

elements.timeline.oninput = () => {
  if (!motion) return;
  playhead = Number(elements.timeline.value) * (motion.frames.length - 1) / motion.fps;
  setFrame(Math.min(motion.frames.length - 1, Math.floor(playhead * motion.fps)));
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
    const duration = (motion.frames.length - 1) / motion.fps;
    if (playing) playhead = (playhead + timer.getDelta() * speed) % duration;
    const frame = Math.min(motion.frames.length - 1, Math.floor(playhead * motion.fps));
    setFrame(frame);
    elements.timeline.value = String(playhead / duration);
    elements.current.textContent = formatTime(playhead);
  }
  controls.update();
  renderer.render(scene, camera);
});

resetCamera();
loadMotion().catch((error) => {
  console.error(error);
  elements.load.textContent = 'Could not load the OpenSim dead-bug motion';
  elements.load.className = 'load-state is-error';
});
