# FitTimer

Phone-first, fully offline PWA interval timer for guided workouts. Exercise
GIFs instead of coaching video; WebAudio beeps and pre-rendered voice cues
that play *over* your own music without pausing it. Routines are curated
data files composed from reusable blocks — deliberately no in-app editor.
Single user, no backend, vanilla HTML/JS/CSS, no build step.

**Read [docs/SPEC.md](docs/SPEC.md) first** — it is the complete handoff
spec: product decisions, architecture, the mapped MadFit routine, WorkoutX
API notes, and the build plan.

## Status (2026-08-10)

- Data schema v1, reusable block composition, and dependency-free validation
  are implemented; the MadFit routine expands to 30 validated intervals.
- The timestamp-anchored interval engine and the phone-first workout UI are
  implemented. The app loads the real MadFit routine, supports pause/back/next,
  and works after a verified offline reload in desktop Chromium.
- The installable PWA shell caches the app, routine/block files, and only the 27
  referenced GIFs. Synthesized WebAudio workout cues are implemented and
  browser-tested. Android/iOS installation and Spotify mixing remain the next
  real-device milestones.
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

To install the deployed app, open `https://odcpw.github.io/fittimer/` on the
phone. In Android Chrome use **Install app**; in iOS Safari use **Share → Add
to Home Screen**. Visit once online before testing a workout in airplane mode.

## Data provenance

The cowork session's assets were never pushed to GitHub (contrary to the
handoff spec's claim) but were recovered 2026-08-10 from the session's
workspace download (`fittimer.zip`): WorkoutX catalog (1,327 exercises) +
filter lists + OpenAPI spec, all 27 routine GIFs, the original routine
JSON, and the YouTube transcript/metadata. No re-fetching needed; the
WorkoutX quota (~330 calls left this month) is only for future blocks.

## Layout

```
data/routines/   one JSON per installable routine
data/gifs/       exercise GIFs referenced by routines (27, 360×360)
data/exercises/  WorkoutX catalog + filter lists + OpenAPI spec
data/youtube/    MadFit video transcript + metadata
docs/SPEC.md     canonical handoff spec
docs/evaluation.md  historical pre-spec feasibility notes
scripts/         content-build tooling (GIF fetcher, TTS pre-render)
src/             dependency-free application modules
test/            Node tests and committed schema fixtures
```

The current mobile visual reference is
[`docs/design/fittimer-mobile-concept.png`](docs/design/fittimer-mobile-concept.png).
