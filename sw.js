// fittimer-v16 and earlier caches are intentionally superseded; activateApp removes every older cache.
const CACHE_NAME = 'fittimer-v17';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './src/app.mjs',
  './src/audio-cues.mjs',
  './src/interval-engine.mjs',
  './src/settings.mjs',
  './src/voice-cues.mjs',
  './src/wake-lock.mjs',
  './src/workout-history.mjs',
  './data/content-index.json',
  './data/voice/voice-pack-v1.json',
  './data/voice/assets/digit-1.mp3',
  './data/voice/assets/digit-2.mp3',
  './data/voice/assets/digit-3.mp3',
  './data/voice/assets/go.mp3',
  './data/voice/assets/movement-1-5-rep-push-up.mp3',
  './data/voice/assets/movement-90-90-hip-switches.mp3',
  './data/voice/assets/movement-alternating-reverse-lunges-2-dumbbells.mp3',
  './data/voice/assets/movement-alternating-side-bend-reach.mp3',
  './data/voice/assets/movement-ankle-pumps-plus-heel-to-toe-rocks.mp3',
  './data/voice/assets/movement-arms-overhead-full-sit-up-male.mp3',
  './data/voice/assets/movement-b-stance-rdl.mp3',
  './data/voice/assets/movement-b-stance-rdl-left.mp3',
  './data/voice/assets/movement-b-stance-rdl-right.mp3',
  './data/voice/assets/movement-backward-walking.mp3',
  './data/voice/assets/movement-band-standing-crunch.mp3',
  './data/voice/assets/movement-bodyweight-squat.mp3',
  './data/voice/assets/movement-bodyweight-squat-deepening.mp3',
  './data/voice/assets/movement-bodyweight-standing-calf-raise.mp3',
  './data/voice/assets/movement-breathing.mp3',
  './data/voice/assets/movement-breathing-plus-easy-reach.mp3',
  './data/voice/assets/movement-breathing-plus-reach.mp3',
  './data/voice/assets/movement-brisk-backward-walking.mp3',
  './data/voice/assets/movement-bum-kicks-butt-kicks-side-to-side.mp3',
  './data/voice/assets/movement-calf-raise-plus-cross-toe-touch.mp3',
  './data/voice/assets/movement-cat-cow.mp3',
  './data/voice/assets/movement-cat-cow-to-child-reach.mp3',
  './data/voice/assets/movement-cocoons.mp3',
  './data/voice/assets/movement-commandos-plus-step-out.mp3',
  './data/voice/assets/movement-controlled-leg-pendulum.mp3',
  './data/voice/assets/movement-controlled-leg-pendulum-left.mp3',
  './data/voice/assets/movement-controlled-leg-pendulum-right.mp3',
  './data/voice/assets/movement-crane-stance-hold.mp3',
  './data/voice/assets/movement-crane-stance-hold-left.mp3',
  './data/voice/assets/movement-crane-stance-hold-right.mp3',
  './data/voice/assets/movement-curtsey-squat.mp3',
  './data/voice/assets/movement-db-knee-drive-march.mp3',
  './data/voice/assets/movement-db-swing.mp3',
  './data/voice/assets/movement-dead-bug.mp3',
  './data/voice/assets/movement-deadlift-plus-upright-row-2-dumbbells.mp3',
  './data/voice/assets/movement-diagonal-chop.mp3',
  './data/voice/assets/movement-diagonal-chop-left.mp3',
  './data/voice/assets/movement-diagonal-chop-right.mp3',
  './data/voice/assets/movement-dumbbell-deadlift.mp3',
  './data/voice/assets/movement-dumbbell-hammer-curl.mp3',
  './data/voice/assets/movement-dumbbell-rear-lunge.mp3',
  './data/voice/assets/movement-dumbbell-single-leg-deadlift.mp3',
  './data/voice/assets/movement-dumbbell-squat.mp3',
  './data/voice/assets/movement-dumbbell-standing-overhead-press.mp3',
  './data/voice/assets/movement-dumbbell-swing.mp3',
  './data/voice/assets/movement-dumbbell-upright-row.mp3',
  './data/voice/assets/movement-foot-planted-shadowboxing.mp3',
  './data/voice/assets/movement-front-rack-press-out.mp3',
  './data/voice/assets/movement-glute-bridge-march.mp3',
  './data/voice/assets/movement-glute-bridges.mp3',
  './data/voice/assets/movement-goblet-squat.mp3',
  './data/voice/assets/movement-half-kneeling-press.mp3',
  './data/voice/assets/movement-half-kneeling-press-left.mp3',
  './data/voice/assets/movement-half-kneeling-press-right.mp3',
  './data/voice/assets/movement-high-plank-toe-taps.mp3',
  './data/voice/assets/movement-hip-flexor-stretch.mp3',
  './data/voice/assets/movement-hip-flexor-stretch-left.mp3',
  './data/voice/assets/movement-hip-flexor-stretch-right.mp3',
  './data/voice/assets/movement-hip-hinge-plus-reach.mp3',
  './data/voice/assets/movement-hip-hitch.mp3',
  './data/voice/assets/movement-hip-hitch-left.mp3',
  './data/voice/assets/movement-hip-hitch-right.mp3',
  './data/voice/assets/movement-horse-stance-goblet-hold.mp3',
  './data/voice/assets/movement-inchworm.mp3',
  './data/voice/assets/movement-jack-jump-male.mp3',
  './data/voice/assets/movement-kettlebell-alternating-renegade-row.mp3',
  './data/voice/assets/movement-kettlebell-swing.mp3',
  './data/voice/assets/movement-kettlebell-thruster.mp3',
  './data/voice/assets/movement-knee-lift-cardio.mp3',
  './data/voice/assets/movement-knees-down-inchworm-walkout.mp3',
  './data/voice/assets/movement-lateral-lunge.mp3',
  './data/voice/assets/movement-lateral-lunge-left.mp3',
  './data/voice/assets/movement-lateral-lunge-right.mp3',
  './data/voice/assets/movement-lateral-squat-rock.mp3',
  './data/voice/assets/movement-lateral-step-and-reach.mp3',
  './data/voice/assets/movement-lateral-step-and-reach-left.mp3',
  './data/voice/assets/movement-lateral-step-and-reach-right.mp3',
  './data/voice/assets/movement-lateral-step-plus-relaxed-arm-sweep.mp3',
  './data/voice/assets/movement-lateral-step-to-balance.mp3',
  './data/voice/assets/movement-lateral-step-to-balance-left.mp3',
  './data/voice/assets/movement-lateral-step-to-balance-plus-short-foot.mp3',
  './data/voice/assets/movement-lateral-step-to-balance-right.mp3',
  './data/voice/assets/movement-low-glute-bridge-on-floor.mp3',
  './data/voice/assets/movement-march-plus-arm-circles.mp3',
  './data/voice/assets/movement-march-plus-shoulder-rolls.mp3',
  './data/voice/assets/movement-march-ramp.mp3',
  './data/voice/assets/movement-mountain-climber.mp3',
  './data/voice/assets/movement-one-arm-db-snatch.mp3',
  './data/voice/assets/movement-one-arm-db-snatch-left.mp3',
  './data/voice/assets/movement-one-arm-db-snatch-right.mp3',
  './data/voice/assets/movement-one-arm-dumbbell-reverse-lunge-plus-overhead-drive.mp3',
  './data/voice/assets/movement-one-arm-dumbbell-reverse-lunge-plus-overhead-drive-side-1.mp3',
  './data/voice/assets/movement-one-arm-dumbbell-reverse-lunge-plus-overhead-drive-side-2.mp3',
  './data/voice/assets/movement-one-arm-row.mp3',
  './data/voice/assets/movement-one-arm-row-left.mp3',
  './data/voice/assets/movement-one-arm-row-right.mp3',
  './data/voice/assets/movement-plank-pull-throughs.mp3',
  './data/voice/assets/movement-plank-walkout-plus-overhead-press.mp3',
  './data/voice/assets/movement-power-half-lunge-plus-knee-drive-left.mp3',
  './data/voice/assets/movement-power-half-lunge-plus-knee-drive-right.mp3',
  './data/voice/assets/movement-prone-w-raise.mp3',
  './data/voice/assets/movement-prone-y-w.mp3',
  './data/voice/assets/movement-push-up.mp3',
  './data/voice/assets/movement-push-up-plus.mp3',
  './data/voice/assets/movement-push-up-to-side-plank.mp3',
  './data/voice/assets/movement-push-ups-final-minute.mp3',
  './data/voice/assets/movement-quadruped-thread-the-needle.mp3',
  './data/voice/assets/movement-seated-psoas-raise.mp3',
  './data/voice/assets/movement-seated-psoas-raise-left.mp3',
  './data/voice/assets/movement-seated-psoas-raise-right.mp3',
  './data/voice/assets/movement-seated-soleus-raise.mp3',
  './data/voice/assets/movement-seated-soleus-raise-left.mp3',
  './data/voice/assets/movement-seated-soleus-raise-right.mp3',
  './data/voice/assets/movement-seated-straddle-active-hinge.mp3',
  './data/voice/assets/movement-side-bend-holds.mp3',
  './data/voice/assets/movement-side-bridge-v-2.mp3',
  './data/voice/assets/movement-side-lunge-to-curtsy-squat-left.mp3',
  './data/voice/assets/movement-side-lunge-to-curtsy-squat-right.mp3',
  './data/voice/assets/movement-side-plank-crunch-side-1.mp3',
  './data/voice/assets/movement-side-plank-crunch-side-2.mp3',
  './data/voice/assets/movement-side-to-side-toe-touch-male.mp3',
  './data/voice/assets/movement-single-leg-balance-plus-short-foot.mp3',
  './data/voice/assets/movement-single-leg-balance-plus-short-foot-left.mp3',
  './data/voice/assets/movement-single-leg-balance-plus-short-foot-right.mp3',
  './data/voice/assets/movement-single-leg-calf-raise.mp3',
  './data/voice/assets/movement-single-leg-calf-raise-left.mp3',
  './data/voice/assets/movement-single-leg-calf-raise-right.mp3',
  './data/voice/assets/movement-single-leg-glute-bridge.mp3',
  './data/voice/assets/movement-single-leg-glute-bridge-left.mp3',
  './data/voice/assets/movement-single-leg-glute-bridge-right.mp3',
  './data/voice/assets/movement-single-leg-rdl.mp3',
  './data/voice/assets/movement-single-leg-rdl-left.mp3',
  './data/voice/assets/movement-single-leg-rdl-right.mp3',
  './data/voice/assets/movement-single-leg-rdl-side-1.mp3',
  './data/voice/assets/movement-single-leg-rdl-side-2.mp3',
  './data/voice/assets/movement-slow-front-kick.mp3',
  './data/voice/assets/movement-slow-front-kick-left.mp3',
  './data/voice/assets/movement-slow-front-kick-right.mp3',
  './data/voice/assets/movement-slow-push-up.mp3',
  './data/voice/assets/movement-slow-roundhouse-chamber.mp3',
  './data/voice/assets/movement-slow-roundhouse-chamber-left.mp3',
  './data/voice/assets/movement-slow-roundhouse-chamber-right.mp3',
  './data/voice/assets/movement-slow-side-kick.mp3',
  './data/voice/assets/movement-slow-side-kick-left.mp3',
  './data/voice/assets/movement-slow-side-kick-right.mp3',
  './data/voice/assets/movement-slow-step-down.mp3',
  './data/voice/assets/movement-slow-step-down-left.mp3',
  './data/voice/assets/movement-slow-step-down-right.mp3',
  './data/voice/assets/movement-slow-step-up.mp3',
  './data/voice/assets/movement-slow-step-up-left.mp3',
  './data/voice/assets/movement-slow-step-up-right.mp3',
  './data/voice/assets/movement-split-squat.mp3',
  './data/voice/assets/movement-split-squat-left.mp3',
  './data/voice/assets/movement-split-squat-right.mp3',
  './data/voice/assets/movement-squat-plus-hammer-curl-2-dumbbells.mp3',
  './data/voice/assets/movement-squat-to-overhead-press-2-dumbbells.mp3',
  './data/voice/assets/movement-squat-to-overhead-reach.mp3',
  './data/voice/assets/movement-standing-crunch-with-dumbbell-march.mp3',
  './data/voice/assets/movement-standing-star-crunch.mp3',
  './data/voice/assets/movement-standing-wall-scapular-reach.mp3',
  './data/voice/assets/movement-step-jacks.mp3',
  './data/voice/assets/movement-suitcase-march.mp3',
  './data/voice/assets/movement-supine-active-hamstring-extension.mp3',
  './data/voice/assets/movement-supported-one-arm-row.mp3',
  './data/voice/assets/movement-supported-one-arm-row-left.mp3',
  './data/voice/assets/movement-supported-one-arm-row-right.mp3',
  './data/voice/assets/movement-supported-side-reach-plus-breathing.mp3',
  './data/voice/assets/movement-supported-standing-side-leg-raise.mp3',
  './data/voice/assets/movement-supported-standing-side-leg-raise-left.mp3',
  './data/voice/assets/movement-supported-standing-side-leg-raise-right.mp3',
  './data/voice/assets/movement-tibialis-raises.mp3',
  './data/voice/assets/movement-toe-spread-plus-short-foot.mp3',
  './data/voice/assets/movement-two-arm-bent-over-row.mp3',
  './data/voice/assets/movement-two-db-farmer-carry.mp3',
  './data/voice/assets/movement-two-db-romanian-deadlift.mp3',
  './data/voice/assets/movement-two-hand-db-swing.mp3',
  './data/voice/assets/movement-walking-high-knees-lunge.mp3',
  './data/voice/assets/movement-wall-external-rotation-isometric.mp3',
  './data/voice/assets/movement-wall-external-rotation-isometric-left.mp3',
  './data/voice/assets/movement-wall-external-rotation-isometric-right.mp3',
  './data/voice/assets/movement-wall-press-hip-abduction-isometric.mp3',
  './data/voice/assets/movement-wall-press-hip-abduction-isometric-left.mp3',
  './data/voice/assets/movement-wall-press-hip-abduction-isometric-right.mp3',
  './data/voice/assets/movement-wall-press-hip-isometric.mp3',
  './data/voice/assets/movement-wall-press-hip-isometric-left.mp3',
  './data/voice/assets/movement-wall-press-hip-isometric-right.mp3',
  './data/voice/assets/movement-wall-slides.mp3',
  './data/voice/assets/movement-weighted-russian-twist.mp3',
  './data/voice/assets/movement-weighted-sit-up.mp3',
  './data/voice/assets/movement-weighted-straight-knee-calf-raise.mp3',
  './data/voice/assets/movement-weighted-straight-knee-calf-raise-left.mp3',
  './data/voice/assets/movement-weighted-straight-knee-calf-raise-right.mp3',
  './data/voice/assets/next.mp3',
  './data/voice/assets/rest.mp3',
  './data/voice/assets/side-alternating.mp3',
  './data/voice/assets/side-first.mp3',
  './data/voice/assets/side-left.mp3',
  './data/voice/assets/side-right.mp3',
  './data/voice/assets/side-second.mp3',
];

function scopedUrl(relativePath) {
  return new URL(relativePath, self.registration.scope).href;
}

async function installApp() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL.map(scopedUrl));
  await self.skipWaiting();
}

async function activateApp() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
  await self.clients.claim();
}

async function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(installApp());
}); // ubs:ignore — service-worker lifecycle listeners live for the worker global's lifetime

self.addEventListener('activate', (event) => {
  event.waitUntil(activateApp());
}); // ubs:ignore — service-worker lifecycle listeners live for the worker global's lifetime

async function navigationResponse(request) {
  try {
    const response = await fetchWithTimeout(request);
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
    return response;
  } catch {
    return caches.match(scopedUrl('./index.html'));
  }
}

async function assetResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return fetchWithTimeout(request);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(event.request.mode === 'navigate' ? navigationResponse(event.request) : assetResponse(event.request));
}); // ubs:ignore — service-worker fetch listeners live for the worker global's lifetime

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_CONTENT' || !Array.isArray(event.data.urls)) return;

  event.waitUntil((async () => {
    try {
      const scope = new URL(self.registration.scope);
      const urls = [...new Set(event.data.urls)].map((relativePath) => new URL(relativePath, scope));
      const safe = urls.every((url) => {
        if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return false;
        const relativePath = url.pathname.slice(scope.pathname.length);
        return (
          relativePath === '' ||
          relativePath === 'index.html' ||
          relativePath === 'styles.css' ||
          relativePath === 'manifest.webmanifest' ||
          relativePath.startsWith('icons/') ||
          relativePath.startsWith('src/') ||
          relativePath === 'data/content-index.json' ||
          relativePath.startsWith('data/blocks/') ||
          relativePath.startsWith('data/routines/') ||
          relativePath.startsWith('data/voice/')
          || relativePath.startsWith('private-packs/')
        );
      });
      if (!safe) throw new Error('Refused to cache content outside the service-worker scope');
      const cache = await caches.open(CACHE_NAME);
      const missing = [];
      for (const url of urls) {
        if (!(await cache.match(url.href))) missing.push(url.href);
      }
      if (missing.length > 0) await cache.addAll(missing);
      event.ports[0]?.postMessage({ ok: true, cached: urls.length, fetched: missing.length });
    } catch (error) {
      event.ports[0]?.postMessage({ ok: false, error: error.message });
    }
  })());
}); // ubs:ignore — service-worker message listeners live for the worker global's lifetime
