import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const EXERCISES = Object.freeze([
  { id: 'squat', name: 'Bodyweight squat', creator: 'MadFit', asset: 'assets/bodyweight-squat.glb?v=4', camera: [0, 1.0, -4.1], target: [0, 0.88, 0] },
  { id: 'lunge', name: 'Reverse lunge + knee drive', creator: 'Sydney Cummings', asset: 'assets/reverse-lunge-knee-drive.glb?v=4', camera: [0, 1.0, -4.3], target: [0, 0.86, 0] },
  { id: 'butt-kicks', name: 'Butt kicks', creator: 'Growingannanas', asset: 'assets/butt-kicks.glb?v=4', camera: [0, 1.0, -4.3], target: [0, 0.88, 0] },
]);

const TARGET_MODEL = 'Mixamo Michelle';

const elements = {
  host: document.querySelector('#canvas-host'),
  list: document.querySelector('#exercise-list'),
  movement: document.querySelector('#movement-name'),
  source: document.querySelector('#movement-source'),
  loadState: document.querySelector('#load-state'),
  play: document.querySelector('#play-toggle'),
  restart: document.querySelector('#restart'),
  skeleton: document.querySelector('#skeleton-toggle'),
  timeline: document.querySelector('#timeline'),
  current: document.querySelector('#current-time'),
  duration: document.querySelector('#duration'),
  speeds: document.querySelector('#speed-controls'),
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
scene.fog = new THREE.Fog(0x0b0f14, 5.5, 10);
scene.add(new THREE.HemisphereLight(0xe9f3ff, 0x27313c, 2.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
keyLight.position.set(2.8, 5, 4);
keyLight.castShadow = true;
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xff9a86, 1.8);
rimLight.position.set(-4, 2.5, -2);
scene.add(rimLight);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(3.6, 80),
  new THREE.MeshStandardMaterial({ color: 0x151b22, roughness: 0.93, metalness: 0.02 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(7.2, 24, 0x384451, 0x202832);
grid.position.y = 0.004;
grid.material.transparent = true;
grid.material.opacity = 0.5;
scene.add(grid);

const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 40);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
elements.host.append(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.25;
controls.maxDistance = 8;
controls.minPolarAngle = 0.05;
controls.maxPolarAngle = Math.PI * 0.495;

const loader = new GLTFLoader();
const timer = new THREE.Timer();
timer.connect(document);
let avatar = null;
let skeletonHelper = null;
let mixer = null;
let actions = [];
let duration = 0;
let playing = true;
let speed = 1;
let skeletonVisible = true;
let selected = EXERCISES[0];
let loadGeneration = 0;

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe % 60).toFixed(2).padStart(5, '0')}`;
}

function setEnabled(enabled) {
  elements.play.disabled = !enabled;
  elements.restart.disabled = !enabled;
  elements.skeleton.disabled = !enabled;
  elements.timeline.disabled = !enabled;
  elements.speeds.disabled = !enabled;
}

function resetCamera(exercise = selected) {
  camera.position.fromArray(exercise.camera);
  controls.target.fromArray(exercise.target);
  camera.lookAt(controls.target);
  controls.update();
}

function disposeAvatar() {
  if (!avatar) return;
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper.material.dispose();
    skeletonHelper = null;
  }
  scene.remove(avatar);
  avatar.traverse((item) => {
    item.geometry?.dispose?.();
    const materials = Array.isArray(item.material) ? item.material : [item.material];
    for (const material of materials) material?.dispose?.();
  });
  mixer?.stopAllAction();
  mixer = null;
  actions = [];
  avatar = null;
}

function groundAvatar(root) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root, true);
  if (!Number.isFinite(bounds.min.y)) return 0;
  const correction = -bounds.min.y;
  root.position.y += correction;
  root.updateMatrixWorld(true);
  return correction;
}

function attachSkeleton(root) {
  skeletonHelper = new THREE.SkeletonHelper(root);
  skeletonHelper.material.color.set(0xc9ff3d);
  skeletonHelper.material.depthTest = false;
  skeletonHelper.material.transparent = true;
  skeletonHelper.material.opacity = 0.86;
  skeletonHelper.renderOrder = 4;
  skeletonHelper.visible = skeletonVisible;
  scene.add(skeletonHelper);
  elements.skeleton.setAttribute('aria-pressed', String(skeletonVisible));
  elements.skeleton.textContent = skeletonVisible ? 'Joint rig on' : 'Joint rig off';
}

function updateButtons() {
  for (const button of elements.list.querySelectorAll('button')) {
    const active = button.dataset.exercise === selected.id;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

async function loadExercise(exercise) {
  const generation = ++loadGeneration;
  selected = exercise;
  updateButtons();
  elements.movement.textContent = exercise.name;
  elements.source.textContent = `${TARGET_MODEL} · Motion source: ${exercise.creator}`;
  elements.loadState.textContent = 'Loading skinned avatar…';
  elements.loadState.className = 'load-state';
  setEnabled(false);
  disposeAvatar();
  try {
    const gltf = await loader.loadAsync(exercise.asset);
    if (generation !== loadGeneration) return;
    avatar = gltf.scene;
    avatar.traverse((item) => {
      if (item.isMesh) {
        item.castShadow = true;
        item.receiveShadow = true;
      }
    });
    scene.add(avatar);
    mixer = new THREE.AnimationMixer(avatar);
    duration = gltf.animations.reduce((maximum, clip) => Math.max(maximum, clip.duration), 0);
    actions = gltf.animations.map((clip) => mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play());
    mixer.setTime(0);
    groundAvatar(avatar);
    attachSkeleton(avatar);
    mixer.timeScale = playing ? speed : 0;
    elements.duration.textContent = formatTime(duration);
    elements.timeline.value = '0';
    elements.current.textContent = formatTime(0);
    resetCamera(exercise);
    setEnabled(true);
    elements.loadState.textContent = `${gltf.animations.length} synchronized animation tracks`;
    elements.loadState.classList.add('is-hidden');
  } catch (error) {
    console.error(error);
    elements.loadState.textContent = `Could not load ${exercise.name}`;
    elements.loadState.className = 'load-state is-error';
  }
}

for (const [index, exercise] of EXERCISES.entries()) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'exercise-button';
  button.dataset.exercise = exercise.id;
  button.setAttribute('aria-pressed', 'false');
  const exerciseIndex = document.createElement('span');
  exerciseIndex.className = 'exercise-index';
  exerciseIndex.textContent = String(index + 1).padStart(2, '0');
  const label = document.createElement('span');
  label.className = 'exercise-label';
  const name = document.createElement('strong');
  name.textContent = exercise.name;
  const creator = document.createElement('span');
  creator.textContent = exercise.creator;
  label.append(name, creator);
  button.append(exerciseIndex, label);
  button.onclick = () => loadExercise(exercise);
  elements.list.append(button);
}

elements.play.onclick = () => {
  playing = !playing;
  if (mixer) mixer.timeScale = playing ? speed : 0;
  elements.play.textContent = playing ? 'Pause' : 'Play';
};

elements.restart.onclick = () => {
  mixer?.setTime(0);
  for (const action of actions) action.play();
};

elements.skeleton.onclick = () => {
  skeletonVisible = !skeletonVisible;
  if (skeletonHelper) skeletonHelper.visible = skeletonVisible;
  elements.skeleton.setAttribute('aria-pressed', String(skeletonVisible));
  elements.skeleton.textContent = skeletonVisible ? 'Joint rig on' : 'Joint rig off';
};

elements.timeline.oninput = () => {
  mixer?.setTime(Number(elements.timeline.value) * duration);
};

elements.speeds.onclick = (event) => {
  const button = event.target.closest('button[data-speed]');
  if (!button) return;
  speed = Number(button.dataset.speed);
  if (mixer && playing) mixer.timeScale = speed;
  for (const item of elements.speeds.querySelectorAll('button')) item.classList.toggle('is-active', item === button);
};

renderer.domElement.ondblclick = () => resetCamera();

function resize() {
  const { clientWidth, clientHeight } = elements.host;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / Math.max(1, clientHeight);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(elements.host);

renderer.setAnimationLoop(() => {
  timer.update();
  mixer?.update(timer.getDelta());
  if (mixer && duration > 0) {
    const position = mixer.time % duration;
    elements.timeline.value = String(position / duration);
    elements.current.textContent = formatTime(position);
  }
  controls.update();
  renderer.render(scene, camera);
});

resetCamera();
loadExercise(selected);
