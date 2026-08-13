import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const elements = {
  host: document.querySelector('#canvas-host'),
  load: document.querySelector('#load-state'),
  play: document.querySelector('#play-toggle'),
  restart: document.querySelector('#restart'),
  skeleton: document.querySelector('#skeleton-toggle'),
  timeline: document.querySelector('#timeline'),
  current: document.querySelector('#current-time'),
  duration: document.querySelector('#duration'),
  speeds: document.querySelector('#speed-controls'),
  models: document.querySelector('#model-controls'),
  viewName: document.querySelector('#view-name'),
  viewDetail: document.querySelector('#view-detail'),
  characterStat: document.querySelector('#character-stat'),
  skinStat: document.querySelector('#skin-stat'),
};

const views = {
  realistic: {
    title: 'Dead bug · realistic Vitruvian',
    detail: 'Book-described motion → native skinned character',
    character: 'Vitruvian',
    skin: '37,436 vertices',
  },
  baseline: {
    title: 'Dead bug · SMPL-X pose baseline',
    detail: 'The clean source motion before character retargeting',
    character: 'SMPL-X',
    skin: '10,475 vertices',
  },
  compare: {
    title: 'Dead bug · synchronized comparison',
    detail: 'Vitruvian at left · SMPL-X baseline at right',
    character: 'Both bodies',
    skin: '47,911 total',
  },
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
controls.minDistance = 1;
controls.maxDistance = 7;
controls.maxPolarAngle = Math.PI * 0.495;

const timer = new THREE.Timer();
timer.connect(document);
const characters = new Map();
const query = new URLSearchParams(window.location.search);
const timeParameter = query.get('time');
const requestedTime = timeParameter === null ? Number.NaN : Number(timeParameter);
const hasRequestedTime = Number.isFinite(requestedTime) && requestedTime >= 0;
let view = Object.hasOwn(views, query.get('view')) ? query.get('view') : 'realistic';
let duration = 15;
let playhead = hasRequestedTime ? requestedTime : 0;
let playing = !hasRequestedTime;
let speed = 1;
let skeletonVisible = false;

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe % 60).toFixed(2).padStart(5, '0')}`;
}

function resetCamera() {
  camera.position.set(0, view === 'compare' ? 2.8 : 2, view === 'compare' ? 3.9 : 2.4);
  controls.target.set(0.02, 0.32, 0);
  camera.lookAt(controls.target);
  controls.update();
}

function setEnabled(enabled) {
  elements.play.disabled = !enabled;
  elements.restart.disabled = !enabled;
  elements.skeleton.disabled = !enabled;
  elements.timeline.disabled = !enabled;
  elements.speeds.disabled = !enabled;
  for (const button of elements.models.querySelectorAll('button')) button.disabled = !enabled;
}

function addSkeleton(root, color) {
  const helper = new THREE.SkeletonHelper(root);
  helper.visible = false;
  helper.material.color.setHex(color);
  scene.add(helper);
  return helper;
}

function applyView(nextView, reset = true) {
  view = nextView;
  const realistic = characters.get('realistic');
  const baseline = characters.get('baseline');
  if (realistic && baseline) {
    const comparing = view === 'compare';
    realistic.wrapper.visible = view !== 'baseline';
    baseline.wrapper.visible = view !== 'realistic';
    realistic.wrapper.position.x = comparing ? -1.15 : 0;
    baseline.wrapper.position.x = comparing ? 1.15 : 0;
    realistic.skeleton.visible = skeletonVisible && realistic.wrapper.visible;
    baseline.skeleton.visible = skeletonVisible && baseline.wrapper.visible;
  }

  for (const button of elements.models.querySelectorAll('button[data-model]')) {
    const active = button.dataset.model === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const copy = views[view];
  elements.viewName.textContent = copy.title;
  elements.viewDetail.textContent = copy.detail;
  elements.characterStat.textContent = copy.character;
  elements.skinStat.textContent = copy.skin;
  if (reset) resetCamera();
}

async function loadCharacter(loader, key, path, skeletonColor, prepare) {
  const gltf = await loader.loadAsync(path);
  if (gltf.animations.length !== 1) throw new Error(`${key} must contain one animation loop`);
  gltf.scene.traverse((item) => {
    if (!item.isMesh) return;
    item.frustumCulled = false;
    if (prepare) prepare(item);
  });

  const wrapper = new THREE.Group();
  wrapper.add(gltf.scene);
  scene.add(wrapper);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).setLoop(THREE.LoopRepeat, Infinity).play();
  mixer.setTime(0);
  const record = {
    wrapper,
    mixer,
    duration: gltf.animations[0].duration,
    skeleton: addSkeleton(gltf.scene, skeletonColor),
  };
  characters.set(key, record);
  return record;
}

async function loadExperience() {
  setEnabled(false);
  const loader = new GLTFLoader();
  const [realistic, baseline] = await Promise.all([
    loadCharacter(loader, 'realistic', 'assets/deadbug-vitruvian.glb?v=2', 0xc9ff3d),
    loadCharacter(loader, 'baseline', 'assets/deadbug-described-smplx.glb?v=4', 0xff806d, (item) => {
      item.material = item.material.clone();
      item.material.color.setHex(0xd88b72);
      item.material.roughness = 0.64;
    }),
  ]);
  if (Math.abs(realistic.duration - baseline.duration) > 0.05) {
    throw new Error('Character loops are not synchronized');
  }
  duration = Math.min(realistic.duration, baseline.duration);
  playhead %= duration;
  for (const character of characters.values()) character.mixer.setTime(playhead);
  elements.play.textContent = playing ? 'Pause' : 'Play';
  elements.duration.textContent = formatTime(duration);
  applyView(view, false);
  setEnabled(true);
  elements.load.textContent = 'Both skinned bodies loaded';
  elements.load.classList.add('is-hidden');
  controls.update();
  renderer.render(scene, camera);
}

elements.play.onclick = () => {
  playing = !playing;
  elements.play.textContent = playing ? 'Pause' : 'Play';
};

elements.restart.onclick = () => {
  playhead = 0;
  for (const character of characters.values()) character.mixer.setTime(0);
};

elements.skeleton.onclick = () => {
  skeletonVisible = !skeletonVisible;
  applyView(view, false);
  elements.skeleton.setAttribute('aria-pressed', String(skeletonVisible));
  elements.skeleton.textContent = `Joint rig ${skeletonVisible ? 'on' : 'off'}`;
};

elements.timeline.oninput = () => {
  playhead = Number(elements.timeline.value) * duration;
  for (const character of characters.values()) character.mixer.setTime(playhead);
};

elements.speeds.onclick = (event) => {
  const button = event.target.closest('button[data-speed]');
  if (!button) return;
  speed = Number(button.dataset.speed);
  for (const item of elements.speeds.querySelectorAll('button')) {
    item.classList.toggle('is-active', item === button);
  }
};

elements.models.onclick = (event) => {
  const button = event.target.closest('button[data-model]');
  if (!button || button.disabled) return;
  applyView(button.dataset.model);
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
  if (characters.size) {
    if (playing) playhead = (playhead + timer.getDelta() * speed) % duration;
    for (const character of characters.values()) character.mixer.setTime(playhead);
    elements.timeline.value = String(playhead / duration);
    elements.current.textContent = formatTime(playhead);
  }
  controls.update();
  renderer.render(scene, camera);
});

resetCamera();
loadExperience().catch((error) => {
  console.error(error);
  elements.load.textContent = 'Could not load both skinned dead-bug bodies';
  elements.load.className = 'load-state is-error';
});
