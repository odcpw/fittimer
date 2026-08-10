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

- Repo scaffolded; no app code yet.
- Build plan tracked in beads (`br ready` to see unblocked work; issues in
  `.beads/issues.jsonl`).
- First routine data: [data/routines/madfit-30min-hiit.json](data/routines/madfit-30min-hiit.json)
  (reconstructed from the spec's mapping table — interim shape).

## Data recovery (blocking asset work)

The original cowork session fetched the WorkoutX exercise catalog
(1,327 exercises), 27 routine GIFs, and the YouTube transcript, but —
contrary to the handoff spec's claim — **never pushed them to GitHub**
(`odcpw/autoreport`'s workout branch is identical to its `main`). Recover
the files from that cowork session's workspace if still possible, or
re-fetch GIFs via the WorkoutX API (~330 calls left this month; catalog
would cost ~133 calls at 10 items/call).

## Layout

```
data/routines/   one JSON per installable routine
data/gifs/       exercise GIFs referenced by routines (not yet recovered)
data/exercises/  WorkoutX catalog + filter lists (not yet recovered)
docs/SPEC.md     canonical handoff spec
scripts/         content-build tooling (GIF fetcher, TTS pre-render)
```
