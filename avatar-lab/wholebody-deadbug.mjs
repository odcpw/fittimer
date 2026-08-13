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
controls.maxDistance = 6;
controls.maxPolarAngle = Math.PI * 0.495;

const timer = new THREE.Timer();
timer.connect(document);
let mixer = null;
let skeleton = null;
let duration = 15;
let playhead = 0;
let playing = true;
let speed = 1;

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe % 60).toFixed(2).padStart(5, '0')}`;
}

function resetCamera() {
  camera.position.set(0, 1.15, 2.65);
  controls.target.set(0.02, 0.38, 0);
  camera.lookAt(controls.target);
  controls.update();
}

function setEnabled(enabled) {
  elements.play.disabled = !enabled;
  elements.restart.disabled = !enabled;
  elements.skeleton.disabled = !enabled;
  elements.timeline.disabled = !enabled;
  elements.speeds.disabled = !enabled;
}

async function loadExperience() {
  const gltf = await new GLTFLoader().loadAsync('assets/deadbug-described-smplx.glb?v=2');
  if (gltf.animations.length !== 1) throw new Error('SMPL-X body must contain one animation loop');

  gltf.scene.traverse((item) => {
    if (!item.isMesh) return;
    item.frustumCulled = false;
    item.material = item.material.clone();
    item.material.color.setHex(0xd88b72);
    item.material.roughness = 0.64;
  });
  scene.add(gltf.scene);
  skeleton = new THREE.SkeletonHelper(gltf.scene);
  skeleton.visible = false;
  skeleton.material.color.setHex(0xc9ff3d);
  scene.add(skeleton);

  duration = gltf.animations[0].duration;
  mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(gltf.animations[0]);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();
  mixer.setTime(0);

  elements.duration.textContent = formatTime(duration);
  setEnabled(true);
  elements.load.textContent = 'SMPL-X body · 55 articulated joints · description-built loop';
  elements.load.classList.add('is-hidden');
}

elements.play.onclick = () => {
  playing = !playing;
  elements.play.textContent = playing ? 'Pause' : 'Play';
};

elements.restart.onclick = () => {
  playhead = 0;
  mixer?.setTime(0);
};

elements.skeleton.onclick = () => {
  skeleton.visible = !skeleton.visible;
  elements.skeleton.setAttribute('aria-pressed', String(skeleton.visible));
  elements.skeleton.textContent = `Joint rig ${skeleton.visible ? 'on' : 'off'}`;
};

elements.timeline.oninput = () => {
  playhead = Number(elements.timeline.value) * duration;
  mixer?.setTime(playhead);
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
  if (mixer) {
    if (playing) playhead = (playhead + timer.getDelta() * speed) % duration;
    mixer.setTime(playhead);
    elements.timeline.value = String(playhead / duration);
    elements.current.textContent = formatTime(playhead);
  }
  controls.update();
  renderer.render(scene, camera);
});

resetCamera();
loadExperience().catch((error) => {
  console.error(error);
  elements.load.textContent = 'Could not load the description-built SMPL-X dead bug';
  elements.load.className = 'load-state is-error';
});
