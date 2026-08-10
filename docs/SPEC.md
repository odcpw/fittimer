# FitTimer — Full Handoff Spec

Complete specification and project plan for **FitTimer**, a personal interval-workout PWA. Self-contained: everything determined so far is in this document.

> Provenance: imported 2026-08-10 from the Claude cowork handoff artifact
> (`fittimer-spec.md`, claude.ai artifact `24319be5-2581-458d-8dda-c71876eaf1b6`).
> **Correction to §3/§8:** the data assets were NEVER actually pushed to
> `odcpw/autoreport` — that branch is identical to `main` and contains no
> `workout-app/` folder. They were recovered 2026-08-10 from the cowork
> session's workspace download (`fittimer.zip`) and now live in `data/`
> in this repo. §3's table describes them; §8's recovery item is done.

---

## 1. What FitTimer is

A phone-first, fully offline **PWA interval timer** for guided workouts:

- Runs timed exercise intervals (e.g. 40s work / 20s rest) with a **GIF animation of each exercise** instead of a video of a person.
- Plays **audio cues and voice announcements over the user's own background music** (Spotify/YouTube Music keep playing; the app never pauses them).
- Routines are **curated data files designed collaboratively** (owner + AI research), composed from reusable "blocks" — there is deliberately **no in-app routine editor UI**.
- Single user, no backend, no accounts. Vanilla HTML/JS/CSS, **no build step**.

First routine: MadFit's *"30 MIN FULL BODY HIIT with weights (NO REPEATS, NO JUMPING)"* — youtube.com/watch?v=07c6wlJh89U — reconstructed from its transcript (30 exercises, 40s on / 20s off, no repeats, no jumping, 1–2 light dumbbells).

## 2. Decisions already made (owner interview)

| Question | Decision |
|---|---|
| Platform | **PWA, phone-first**; installable, offline via service worker; works on laptop too |
| Music | **Background app + cues**: user plays their own music app; FitTimer only plays beeps/voice over it |
| Routine editing | **No tick-box editor.** Routines designed together with AI (incl. researched physio content), added as data files |
| v1 must include | Voice announcements · workout history/streaks · multiple named routines |
| Content to build | MadFit 30-min HIIT (first) · warm-up/cooldown blocks · physio/rehab blocks · 2 dumbbell strength routines |
| Physio blocks | **Deferred until MVP runs on the phone** — then a dedicated interview on problem areas, research from reputable physio sources, citations kept in block files |
| Session lengths | 20–30 min and 40+ min (long sessions composed from blocks) |
| Repo | `odcpw/fittimer`, **public** (⚠ not yet created on GitHub as of 2026-08-10) |
| Issue tracker | **beads** (`br` on the owner's 3090 machine; issues as `.beads/issues.jsonl` in git) |

## 3. Data assets (recovered from the cowork session, now in `data/`)

| Path | Contents |
|---|---|
| `data/workout_madfit_30min_hiit.json` | The 30 mapped intervals (schema in §5) |
| `data/exercises/catalog_full.json` | **Complete WorkoutX catalog: 1,327 exercises** — name, bodyPart, target, secondaryMuscles, equipment, step-by-step instructions, gifUrl, difficulty, mechanic, force, MET, caloriesPerMinute, isUnilateral, recommended sets/reps |
| `data/exercises/bodyPartList.json` etc. | Valid filter values (body parts, targets, equipment, secondary muscles) |
| `data/exercises/openapi.json` | Full WorkoutX API spec |
| `data/gifs/*.gif` | **27 exercise GIFs** (360×360, watermarked) used by the MadFit routine |
| `data/youtube/transcript.txt` | Full spoken transcript of the video (source of the exercise list) |
| `data/youtube/oembed.json`, `thumbnail.jpg` | Video metadata |

## 4. WorkoutX API (only needed for GIFs of NEW exercises)

- Base: `https://api.workoutxapp.com/v1` — auth header `X-WorkoutX-Key: <key>` (key is in the owner's welcome email; **never commit it**; read from `WORKOUTX_KEY` env var).
- Free plan: **500 requests/month; ~330 remaining** (as of 2026-08-10). Rate limit **30 req/min**. Responses capped at **10 items/call**. GIF downloads **count against the same 500** and are watermarked; quota headers: `X-Quota-Remaining` etc.
- Useful endpoints: `GET /exercises` (params: `name` partial match, `bodyPart`, `target`, `equipment`, `muscle`, `limit`, `offset`), `GET /exercises/exercise/{id}`, `GET /exercises/{id}/similar`, `GET /exercises/{id}/alternatives`, `GET /gifs/{id}.gif`.
- The full catalog was already fetched once — API is only needed to **download GIFs for exercises added to new blocks** (and to re-download if the cowork assets are unrecoverable). Note: GIF ids 5202/5204 return 503 "watermarked GIF unavailable" on free plan; treat 503 as skip-and-substitute.

## 5. The MadFit routine (mapped, interval by interval)

Format: 30 intervals × (40s work + 20s rest). `match`: exact / close / combo (two catalog exercises) / loose / none, vs the WorkoutX catalog. GIF file = `data/gifs/<id>.gif`.

| # | Exercise (as coached) | Catalog id → name | Match |
|---|---|---|---|
| 1 | Step jacks | 3224 Jack Jump | close (step, don't jump) |
| 2 | Bum kicks side-to-side | — | **none** (no GIF; text card or reuse #1) |
| 3 | Half-lunge + knee drive R | 3655 Walking High Knees Lunge | close |
| 4 | Half-lunge + knee drive L | 3655 | close |
| 5 | Standing star crunch | 3213 Side-to-side Toe Touch | close |
| 6 | Bodyweight squats | 1685 Squat To Overhead Reach | close (skip the reach) |
| 7 | Calf raise + cross toe touch | 1373 Bodyweight Standing Calf Raise | close (add reach/touch) |
| 8 | High-plank toe taps | 0630 Mountain Climber | close (slow tempo) |
| 9 | Cocoons | 0260 Cocoons | **exact** |
| 10 | Glute bridges | 3013 Low Glute Bridge On Floor | exact |
| 11 | Squat → overhead press (2 DB) | 0550 Kettlebell Thruster | close (use dumbbells) |
| 12 | Deadlift + upright row (2 DB) | 0300 Dumbbell Deadlift **+** 0437 Dumbbell Upright Row | combo |
| 13 | Side lunge → curtsy squat R | 3769 Curtsey Squat | close |
| 14 | Side lunge → curtsy squat L | 3769 | close |
| 15 | Dumbbell swing (both hands) | 0549 Kettlebell Swing | close |
| 16 | Commandos + step-outs | 0664 Push-up To Side Plank | **loose** |
| 17 | Weighted Russian twist | 0846 Weighted Russian Twist | exact |
| 18 | Weighted sit-up | 3204 Arms Overhead Full Sit-up | close (hold DB) |
| 19 | Plank pull-throughs (1 DB) | 0521 KB Alternating Renegade Row | **loose** |
| 20 | Side plank crunch (side 1) | 0705 Side Bridge V. 2 | close |
| 21 | Side plank crunch (side 2) | 0705 | close |
| 22 | Plank walkout + overhead press | 1471 Inchworm **+** 0426 DB Standing Overhead Press | combo |
| 23 | Squat + hammer curl (2 DB) | 0413 Dumbbell Squat **+** 0313 Dumbbell Hammer Curl | combo |
| 24 | Single-leg RDL (side 1) | 1757 Dumbbell Single Leg Deadlift | exact |
| 25 | Single-leg RDL (side 2) | 1757 | exact |
| 26 | Alternating reverse lunges (2 DB) | 0381 Dumbbell Rear Lunge | exact |
| 27 | Standing DB crunch (march) | 1005 Band Standing Crunch | **loose** |
| 28 | Dumbbell snatch (side 1) | 3888 Dumbbell One Arm Snatch | exact |
| 29 | Dumbbell snatch (side 2) | 3888 | exact |
| 30 | Push-ups (final minute) | 0662 Push-up | exact |

Existing JSON per interval: `{order, name, workSeconds, restSeconds, match, exerciseId, catalogName, gif, target, bodyPart, note, comboWith?}` plus routine-level `{title, source, format, notes}`. This is an interim shape — the first build task defines the final block/routine schema and converts it.

## 6. Architecture spec

**Stack**: vanilla HTML/JS/CSS, no framework, no build step. Deploy on GitHub Pages. All assets local (data + GIFs shipped with the app).

1. **Routine/block schema** (the contract everything depends on).
   Block = named, reusable ordered list of intervals: `{exerciseId, displayName, gif, workSeconds, restSeconds, side?, coachNote?}`. Routine = metadata `{title, equipment, estDuration}` + ordered list of block refs and/or inline intervals. Must support per-side exercises, combo intervals (two movements alternated in one interval), and blocks shared across routines. Includes `data/SCHEMA.md` + a small dependency-free node validator script.
2. **PWA shell**: manifest + service worker precaching app files, routine JSONs, and only the GIFs referenced by installed routines (not the 1,327-exercise catalog's worth). Acceptance: full session in airplane mode after one online visit; Add-to-Home-Screen works on Android + iOS.
3. **Interval engine**: pure JS state machine (idle/work/rest/paused/done), **timestamp-anchored timing** (never accumulated `setInterval` drift), pause/resume, skip forward/back, restart. Emits events: `tick`, `intervalStart`, `intervalEnd`, `halfway`, `countdown321`. UI and audio are subscribers. Acceptance: 30-interval run within 1s of wall clock; skip/pause never desyncs.
4. **Workout screen** (phone-first, portrait, dark): big remaining time, current GIF + name, next-up preview during rest, interval counter n/30, progress bar, thumb-sized pause/skip.
5. **Audio cues**: **WebAudio only** — short synthesized beeps (3-2-1 countdown, distinct work-start / rest-start tones, optional halfway tick). Never use an `<audio>` element / media session, which would pause or duck background music. Must be verified on Android Chrome and iOS Safari with Spotify playing.
6. **Voice announcements**: announce next exercise (and side) during rest, "go"/"rest" at boundaries; toggleable; queued to not overlap the beeps.
   **Chosen approach**: pre-render every phrase with **FrankenTTS** (Jeff Emanuel / Dicklesworthstone — `github.com/Dicklesworthstone/franken_tts`, frankentts.com; Rust reimplementation of Qwen3-TTS; MIT + Apache-2.0 weights). It is **not viable at runtime on phones** (~2 GB model, several GB RAM, desktop-only, 0.31× real time in WASM) — but the app's vocabulary is tiny and fixed (exercise names, "go", "rest", digits), so run the **native CLI at content-build time** (fast on the owner's RTX 3090 box), ship small audio clips with the PWA, play via WebAudio. **Fallback**: browser SpeechSynthesis for any phrase lacking a clip (note: iOS requires a user-gesture unlock for speech — init on the Start tap).
7. **Wake lock**: Screen Wake Lock API, re-acquire on `visibilitychange`. Timestamp anchoring must keep the timer honest through brief backgrounding.
8. **Home screen**: routine picker listing `data/routines/*.json` (title, duration, equipment, exercise count). Adding a routine file must require zero code changes. History/streaks lives here later.
9. **History/streaks**: localStorage log `{routine, date, completedAt interval n | finished}`; month calendar with dots + current streak. No charts, no export.
10. **GIF fetch tooling**: `scripts/fetch-gifs.mjs <ids…>` — reads `WORKOUTX_KEY` env, skips already-present files, paces under 30 req/min, appends to a committed quota ledger. Every new content block spends from the ~330-call budget.

## 7. Build plan (18 issues, dependency-ordered)

Tracked in beads (`.beads/issues.jsonl`, prefix `ft`). `→` = blocked by.

**Epic MVP — run the MadFit session on the owner's phone** *(P1)*

| Task | Depends on |
|---|---|
| 1. Routine & block schema + validator; convert MadFit JSON | — |
| 2. PWA shell (offline, installable) | 1 |
| 3. Interval engine | 1 |
| 4. Workout screen UI | 2, 3 |
| 5. Audio cues that don't kill background music | 3 |
| 6. Voice: pre-rendered FrankenTTS clips + SpeechSynthesis fallback | 5 |
| 7. Wake lock + ergonomics | 4 |
| 8. Home screen routine picker | 1, 2 |
| 9. Port MadFit to final schema + GIF audit (fix the 3 loose matches + missing #2) | 1 |
| 10. **Deploy to GitHub Pages + real-phone test** (done = owner completes one real workout) | 4, 5, 8, 9 |
| 11. Workout history + streaks | 4 |

**Epic Content — routine & block library** *(P2)*

| Task | Depends on |
|---|---|
| 1. GIF fetch script + quota ledger | — |
| 2. Warm-up & cooldown blocks (designed with owner) | MVP.1, C.1 |
| 3. Two 20–30 min dumbbell strength routines (designed with owner) | MVP.1, C.1 |
| 4. **Physio**: interview owner on problem areas → research reputable sources → rehab/mobility blocks with citations. **Hard rule: not before MVP.10 is done** | MVP.10, C.1 |
| 5. Compose 40+ min sessions from blocks (pure data) | C.2, C.3 |

(The original cowork beads ids `ft-c1b.*` / `ft-mzi.*` were never exported; the issues were re-created in this repo's beads DB — see `.beads/issues.jsonl` for current ids.)

## 8. Gotchas & open items

- ~~**Data recovery**~~ done 2026-08-10: catalog, GIFs, transcript, and the original MadFit JSON recovered from the cowork session's `fittimer.zip` (they were never on GitHub, despite what the original spec claimed).
- **API key**: never in the repo; env var only. The repo is intended to be public.
- **Public-repo caveat**: the bundled WorkoutX GIFs are watermarked free-tier assets being redistributed in a public repo — acceptable to the owner so far, but flag if licensing matters.
- **iOS quirks**: SpeechSynthesis needs a user-gesture unlock; Wake Lock needs iOS ≥ 16.4; test WebAudio-over-Spotify mixing on a real device early.
- **Interval #2 (bum kicks)** has no catalog match — use a text-only card or reuse the step-jacks GIF rather than a misleading animation.
- Owner's dumbbells ≈ light set (video uses 2×10 lb) — relevant when designing strength blocks.
