# W1–W4 creator-roster mining wave

Completed 2026-08-13. This is the bounded metadata-first pass over the six
approved fitness creators. The source inventory is machine-readable in
`data/media/v3-roster-wave.json`; the actual silent clips remain in the private
creator pack and are not committed to the public repository.

## Result

- 16 named roster sources were inventoried.
- 9 were downloaded for inspection; 8 retained valid landscape source media.
- 1 Sydney source was rejected after a 403 high-format fetch and an unsuitable
  low-format stream. It is not used as a fallback.
- 9 new silent 16:9 clips were encoded: Cat & Cow, Thread the Needle, Dead Bug,
  Side Plank Crunch, Glute Bridges (MadFit), Goblet Squat (Caroline), Bent-over
  Row (Sydney), Glute Bridge and Elevated Single-leg Glute Bridge (Heather).
- Every promoted clip is H.264, 1280×720, silent, and 20–40 seconds long. The
  source frame is contained/fitted; no person crop or portrait asset is used.
- Each clip carries creator, source video ID/URL, timestamp range, side and
  equipment in both the private media pack and the wave manifest.

The new clips are additive variants. Automatic mode still chooses one creator
for a workout, while the creator selector can force one approved creator. A
missing creator movement remains visibly missing; text-only contract movements
remain written cues. There is no cross-creator or GIF fallback.

## Remaining work

The source inventory records promising leads that were not promoted as exact
clips in this bounded pass. In particular, B-stance RDL, backward walking,
bodyweight squat deepening, seated soleus raise, wall-press hip abduction, and
the two slow kick/chamber identities remain unmatched or text-only. That is an
honest research queue, not a reason to attach an approximate visual.

The nine private clips are a useful first increment for the movement database;
the existing private creator pack remains the larger library. The next mining
pass can cut the retained Caroline stretch, Heather upper/lower, Growingannanas
balance and Pamela leg/shoulder sources when those exact movement labels are
needed by a routine.
