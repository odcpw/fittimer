# FitTimer

Phone-first, fully offline PWA interval timer for guided workouts. Exercise
video loops, WebAudio beeps, and pre-rendered voice cues
that play *over* your own music without pausing it. Routines are curated
data files composed from reusable blocks — deliberately no in-app editor.
Single user, no backend, vanilla HTML/JS/CSS, no build step.

**Read [docs/SPEC.md](docs/SPEC.md) first** — it is the complete handoff
spec: product decisions, architecture, the mapped MadFit routine, and the
historical build plan.

## Status (2026-08-11)

- Data schema v1, reusable block composition, and dependency-free validation
  are implemented; the MadFit routine expands to 30 validated intervals.
- The timestamp-anchored interval engine and the phone-first workout UI are
  implemented. The app loads the real MadFit routine, supports pause/back/next,
  and works after a verified offline reload in desktop Chromium.
- Workout cards start directly in landscape. The private Tailscale deployment
  automatically selects the MadFit or W1–W4 video pack; there is no media
  selector and no WorkoutX/GIF runtime fallback. Missing clips are shown as
  explicit `Video needed` entries.
- The installable PWA shell caches the app, routine/block files, selected video
  pack, and voice assets. Synthesized WebAudio workout cues are implemented and
  browser-tested.
- Build plan is tracked in beads (`br ready` to see unblocked work; issues in
  `.beads/issues.jsonl`).

Run the current checks with:

```sh
node --test
node scripts/validate.mjs data/routines/*.json
node scripts/check-pwa.mjs
```

Run it locally from the repository root (service workers require HTTP):

```sh
python -m http.server 8000
```

Then open `http://localhost:8000/`.

The public GitHub Pages build contains the app shell but deliberately has no
creator videos. For the complete app, join the private tailnet and install
`https://3090.tail52e2c8.ts.net/` on the phone. In Android Chrome use
**Install app**; in iOS Safari use **Share → Add to Home Screen**. Visit once
online before testing a workout offline.

The private origin is backed by the enabled `fittimer-private.service` user
service. Direct launches of `scripts/private-server.mjs` require an explicit
`--private-pack-root`; the server refuses to start without the video index so a
shell-only process cannot silently replace the working service.

## Data provenance

The recovered WorkoutX catalog and GIFs remain as historical source material,
but the service is retired and the app does not load or cache them. Current
exercise visuals are private, retained video clips served on the owner's
Tailscale network.

## Layout

```
data/routines/   one JSON per installable routine
data/gifs/       archived WorkoutX GIF source material (not used at runtime)
data/exercises/  archived WorkoutX catalog and API metadata
data/youtube/    MadFit video transcript + metadata
docs/SPEC.md     canonical handoff spec
docs/evaluation.md  historical pre-spec feasibility notes
scripts/         content-build tooling (archived GIF fetcher, TTS pre-render)
src/             dependency-free application modules
test/            Node tests and committed schema fixtures
```

The current mobile visual reference is
[`docs/design/fittimer-mobile-concept.png`](docs/design/fittimer-mobile-concept.png).
