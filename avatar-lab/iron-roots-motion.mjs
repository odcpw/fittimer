import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const motions = {
  march: { name: 'March + Arm Circles', creator: 'Garage Fitness Girl', selected: '11.5 s selected', ground: 'Observed foot contact', asset: 'assets/iron-roots-march-arm-circles.glb?v=2' },
  squat: { name: 'Deepening Squat', creator: 'MadFit', selected: '5.0 s selected', ground: 'Observed foot contact', asset: 'assets/iron-roots-deepening-squat.glb?v=2' },
  hinge: { name: 'Hip Hinge + Reach', creator: 'Claire DeFitt', selected: '11.0 s selected', ground: 'Fixed planted stance', asset: 'assets/iron-roots-hip-hinge-reach.glb?v=7' },
  ankle: { name: 'Ankle Pumps + Heel-to-toe Rocks', creator: 'Dynamic Health', selected: '5.6 s selected', ground: 'Observed foot contact', asset: 'assets/iron-roots-ankle-calf-rocks.glb?v=2' },
  wall: { name: 'Wall Scapular Reach', creator: 'Inspired Life Fitness', selected: '7.6 s selected', ground: 'Fixed planted stance', asset: 'assets/iron-roots-wall-scapular-reach.glb?v=4' },
};

const elements = {
  host: document.querySelector('#canvas-host'), load: document.querySelector('#load-state'),
  play: document.querySelector('#play-toggle'), restart: document.querySelector('#restart'),
  skeleton: document.querySelector('#skeleton-toggle'), timeline: document.querySelector('#timeline'),
  current: document.querySelector('#current-time'), duration: document.querySelector('#duration'),
  speeds: document.querySelector('#speed-controls'), list: document.querySelector('#exercise-list'),
  name: document.querySelector('#movement-name'), source: document.querySelector('#movement-source'),
  stat: document.querySelector('#motion-stat'), ground: document.querySelector('#ground-stat'),
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
scene.fog = new THREE.Fog(0x0b0f14, 6, 10);
scene.add(new THREE.HemisphereLight(0xe9f3ff, 0x27313c, 2.8));
const key = new THREE.DirectionalLight(0xffffff, 3.2); key.position.set(2.5, 4.5, 3.5); scene.add(key);
const rim = new THREE.DirectionalLight(0xff806d, 1.7); rim.position.set(-3, 2.5, -2); scene.add(rim);
const floor = new THREE.Mesh(new THREE.CircleGeometry(3.2, 80), new THREE.MeshStandardMaterial({ color: 0x151b22, roughness: 0.94 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
const grid = new THREE.GridHelper(6.4, 24, 0x384451, 0x202832); grid.position.y = 0.002; grid.material.transparent = true; grid.material.opacity = 0.52; scene.add(grid);

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 30);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.14; elements.host.append(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.enablePan = false;
controls.minDistance = 1.1; controls.maxDistance = 7; controls.maxPolarAngle = Math.PI * 0.495;

const loader = new GLTFLoader();
const cache = new Map();
const timer = new THREE.Timer(); timer.connect(document);
let activeKey = 'march'; let active = null; let duration = 15; let playhead = 0;
let playing = true; let speed = 1; let skeletonVisible = false; let loadGeneration = 0;

function resetCamera() { camera.position.set(2.7, 1.65, 3.25); controls.target.set(0, 0.92, 0); camera.lookAt(controls.target); controls.update(); }
function formatTime(seconds) { const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0); return `${Math.floor(safe / 60)}:${(safe % 60).toFixed(2).padStart(5, '0')}`; }
function enable(value) { for (const item of [elements.play, elements.restart, elements.skeleton, elements.timeline]) item.disabled = !value; elements.speeds.disabled = !value; }

async function loadMotion(keyName) {
  if (cache.has(keyName)) return cache.get(keyName);
  const gltf = await loader.loadAsync(motions[keyName].asset);
  if (gltf.animations.length !== 1) throw new Error(`${motions[keyName].name} must contain one animation`);
  gltf.scene.traverse((item) => { if (item.isMesh) item.frustumCulled = false; });
  const mixer = new THREE.AnimationMixer(gltf.scene); mixer.clipAction(gltf.animations[0]).setLoop(THREE.LoopRepeat, Infinity).play();
  const skeleton = new THREE.SkeletonHelper(gltf.scene); skeleton.material.color.setHex(0xc9ff3d); skeleton.visible = false;
  const record = { root: gltf.scene, mixer, skeleton, duration: gltf.animations[0].duration };
  gltf.scene.visible = false; scene.add(gltf.scene); scene.add(skeleton); cache.set(keyName, record); return record;
}

async function selectMotion(next) {
  const generation = ++loadGeneration; enable(false); elements.load.textContent = `Loading ${motions[next].name}…`; elements.load.className = 'load-state';
  try {
    const record = await loadMotion(next); if (generation !== loadGeneration) return;
    if (active) { active.root.visible = false; active.skeleton.visible = false; }
    activeKey = next; active = record; active.root.visible = true; active.skeleton.visible = skeletonVisible;
    duration = active.duration; playhead = 0; active.mixer.setTime(0);
    const motion = motions[next]; elements.name.textContent = motion.name; elements.source.textContent = `${motion.creator} · RTMW3D-X → Vitruvian Rigify`;
    elements.stat.textContent = motion.selected; elements.ground.textContent = motion.ground; elements.duration.textContent = formatTime(duration);
    for (const button of elements.list.querySelectorAll('button[data-motion]')) { const selected = button.dataset.motion === next; button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected)); }
    elements.load.classList.add('is-hidden'); enable(true); resetCamera();
  } catch (error) { console.error(error); elements.load.textContent = `Could not load ${motions[next].name}`; elements.load.className = 'load-state is-error'; }
}

elements.list.onclick = (event) => { const button = event.target.closest('button[data-motion]'); if (button && button.dataset.motion !== activeKey) selectMotion(button.dataset.motion); };
elements.play.onclick = () => { playing = !playing; elements.play.textContent = playing ? 'Pause' : 'Play'; };
elements.restart.onclick = () => { playhead = 0; active?.mixer.setTime(0); };
elements.skeleton.onclick = () => { skeletonVisible = !skeletonVisible; if (active) active.skeleton.visible = skeletonVisible; elements.skeleton.textContent = `Joint rig ${skeletonVisible ? 'on' : 'off'}`; elements.skeleton.setAttribute('aria-pressed', String(skeletonVisible)); };
elements.timeline.oninput = () => { playhead = Number(elements.timeline.value) * duration; active?.mixer.setTime(playhead); };
elements.speeds.onclick = (event) => { const button = event.target.closest('button[data-speed]'); if (!button) return; speed = Number(button.dataset.speed); for (const item of elements.speeds.querySelectorAll('button')) item.classList.toggle('is-active', item === button); };
renderer.domElement.ondblclick = resetCamera;
new ResizeObserver(() => { const { clientWidth, clientHeight } = elements.host; renderer.setSize(clientWidth, clientHeight, false); camera.aspect = clientWidth / Math.max(1, clientHeight); camera.updateProjectionMatrix(); }).observe(elements.host);
renderer.setAnimationLoop(() => { timer.update(); if (active) { if (playing) playhead = (playhead + timer.getDelta() * speed) % duration; active.mixer.setTime(playhead); elements.timeline.value = String(playhead / duration); elements.current.textContent = formatTime(playhead); } controls.update(); renderer.render(scene, camera); });

resetCamera(); selectMotion(activeKey);
