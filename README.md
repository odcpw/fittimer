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

- Repo scaffolded, all data assets in place; no app code yet.
- Build plan tracked in beads (`br ready` to see unblocked work; issues in
  `.beads/issues.jsonl`).
- First routine data: [data/routines/madfit-30min-hiit.json](data/routines/madfit-30min-hiit.json)
  (interim shape — final block/routine schema is the first build task).

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
```
