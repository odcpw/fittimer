> Historical: the cowork session's pre-spec feasibility evaluation (2026-08-10).
> Superseded by SPEC.md where they disagree (e.g. setInterval timing, in-app routine editor — both rejected in the final spec).

# Personal Workout App — Idea Evaluation & Offline Data

Evaluation of building a small personal app around the MadFit video
**"30 MIN FULL BODY HIIT with weights (NO REPEATS, NO JUMPING)"**
(https://www.youtube.com/watch?v=07c6wlJh89U), with editable exercises,
your own music, and exercise animations instead of a person.

## Verdict: very feasible, and the hard part is already done

The two risky ingredients — a machine-readable exercise database and per-exercise
animations — are both covered by the WorkoutX API, and everything needed is now
stored offline in this folder. No further API calls are required to build or run
the app.

What the app needs to be:

- **A single-page web app (PWA)** — no backend, no accounts. Open it on a phone
  or laptop, it works offline. This is the right size for a personal tool.
- **Interval engine**: 40s work / 20s rest × 30 rounds (all configurable).
  `setInterval`-based timer with WebAudio beeps for the 3-2-1 countdown and a
  Screen Wake Lock so the phone doesn't sleep mid-plank.
- **Editable routine**: the routine is just a JSON list (see
  `data/workout_madfit_30min_hiit.json`). Add/remove/reorder = editing that list
  in a UI backed by `localStorage`. The full 1,327-exercise catalog
  (`data/exercises/catalog_full.json`) is the picker: filter by body part,
  target muscle, or equipment using the bundled filter lists.
- **Animations**: each catalog exercise has a 360×360 GIF. The 27 GIFs used by
  this routine are in `data/gifs/`. Show the GIF during the work interval and
  the *next* exercise's GIF during the rest interval ("up next").
- **Music**: the one genuinely constrained feature. Options, best first:
  1. **Your own audio files** (`<audio>` + a folder of MP3s, playlist in the
     app): fully offline, gapless-enough, zero licensing issues for personal use.
  2. **Spotify/YouTube Music running in the background** and the app only plays
     short beep cues over it (phones mix audio fine). Simplest, works today.
  3. Embedded streaming SDKs (Spotify Web Playback etc.): needs Premium, OAuth,
     and an internet connection — not worth it for a personal app.

Rough effort: a usable v1 (timer + this routine + GIFs + add/remove from
catalog + local music playlist) is a single HTML/JS/CSS app of a few hundred
lines — an evening or two of work, not a project.

Caveats found while gathering the data:

- Free-plan GIFs are **watermarked** and 360×360; unwatermarked requires a paid
  plan. Fine for personal use.
- Free plan caps responses at 10 items/call and 500 calls/month — which is why
  the whole catalog was downloaded once and committed here. **Don't re-fetch;
  everything is local.** Quota used for this harvest: ~170 calls (catalog 133,
  GIFs 28, probes/lists ~9). ~330 remain this month.
- A few of the video's compound moves (commandos, plank pull-throughs, standing
  march-crunch) have no exact catalog entry — nearest matches are flagged
  `loose` in the routine JSON. Butt kicks (interval 2) has no match at all.
  For those, either live with the nearest GIF or record short clips once.
- The WorkoutX API key is **not** stored in this repo (it was only needed for
  the one-time harvest). If you ever need it again, it's in your welcome email;
  keep it out of committed files.

## What's in this folder

| Path | Contents |
| --- | --- |
| `data/workout_madfit_30min_hiit.json` | The video's 30 intervals (40s/20s), each mapped to a WorkoutX exercise ID + GIF, with match quality (`exact`/`close`/`combo`/`loose`/`none`) and coaching notes from the video |
| `data/exercises/catalog_full.json` | Complete WorkoutX catalog: 1,327 exercises with instructions, target/secondary muscles, equipment, difficulty, MET/calories, GIF URLs |
| `data/exercises/*List.json` | Valid filter values: body parts, target muscles, equipment, secondary muscles |
| `data/exercises/openapi.json` | Full API spec (endpoints & params) in case more data is ever wanted |
| `data/gifs/*.gif` | The 27 exercise animations used by this routine (360×360, watermarked) |
| `data/youtube/transcript.txt` | Full spoken transcript of the video (source for the exercise list) |
| `data/youtube/oembed.json`, `thumbnail.jpg` | Video metadata + thumbnail |

## The workout, reconstructed from the transcript

Format: 30 exercises, 40s on / 20s off, no repeats, no jumping, 1–2 light
dumbbells. Warm-up is built into the first ~6 intervals.

1. Step jacks · 2. Bum kicks · 3–4. Half-lunge knee drives (R/L) ·
5. Standing star crunch · 6. Bodyweight squats · 7. Calf raise + cross toe touch ·
8. Plank toe taps · 9. Cocoons · 10. Glute bridges ·
11. Squat to overhead press · 12. Deadlift + upright row ·
13–14. Side lunge → curtsy squat (R/L) · 15. Dumbbell swing ·
16. Commandos · 17. Weighted Russian twists · 18. Weighted sit-ups ·
19. Plank pull-throughs · 20–21. Side plank crunches (R/L) ·
22. Plank walkout + overhead press · 23. Squat + hammer curl ·
24–25. Single-leg RDL (R/L) · 26. Alternating reverse lunges ·
27. Standing dumbbell crunch (march) · 28–29. Dumbbell snatch (R/L) ·
30. Push-ups.
