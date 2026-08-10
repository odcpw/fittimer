Root operating manual: /home/oliver/.codex/AGENTS.md — binds in full.

# FitTimer — Local Truth

- **Purpose**: personal offline PWA interval timer. Canonical spec:
  `docs/SPEC.md` (read it before any implementation work).
- **Canonical checkout**: `/home/oliver/Projects/odcpw/fittimer` on `3090`.
- **Git identity**: `odcpw` / `odcpw@users.noreply.github.com`; remote (once
  created) `git@github-odcpw:odcpw/fittimer.git`, branch `main`. Repo is
  intended to be **public** — never commit the WorkoutX API key
  (`WORKOUTX_KEY` env var only).
- **Stack**: vanilla HTML/JS/CSS, no framework, **no build step**, no
  dependencies. Deploy target: GitHub Pages. Node only for dev-time scripts
  (`scripts/`), which must stay dependency-free.
- **Tracker**: beads (`br`), issues in `.beads/issues.jsonl` committed to git.
  Work top-down from `br ready`; the dependency graph encodes the build order.
- **Domain invariants**: audio via WebAudio only (never `<audio>`/media
  session — it pauses background music); timer must be timestamp-anchored,
  not `setInterval`-accumulated; adding a routine JSON must require zero code
  changes; physio content is blocked until the MVP phone test passes.
- **Data caveat**: all assets recovered and committed (see README "Data
  provenance"). Do not re-fetch anything already in `data/`; new-block GIF
  fetches must go through the quota ledger (WorkoutX ~330 calls/month left).
