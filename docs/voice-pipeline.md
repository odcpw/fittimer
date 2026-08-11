# FitTimer voice pipeline

FitTimer ships a finite, data-derived phrase pack. The app never runs a
FrankenTTS model: content tooling renders the installed vocabulary once, and
the browser plays the resulting WebAudio clips. Missing or damaged clips fall
back to browser `SpeechSynthesis` after the Start-gesture unlock.

## Pinned upstream tool

The verified upstream release is
[Dicklesworthstone/franken_tts v0.1.5](https://github.com/Dicklesworthstone/franken_tts/releases/tag/v0.1.5),
tagged at commit `aee1ef4b7813d6d7bdfd2540e3a9a33ea39bf83c` on 2026-08-10.
The pinned CLI surface and model/config behavior were checked against the
[tagged README](https://github.com/Dicklesworthstone/franken_tts/blob/v0.1.5/README.md),
[tagged source](https://github.com/Dicklesworthstone/franken_tts/tree/v0.1.5/src),
and [tagged changelog](https://github.com/Dicklesworthstone/franken_tts/blob/v0.1.5/CHANGELOG.md).
The Linux amd64 archive is `franken_tts-0.1.5-linux_amd64.tar.gz` and was
checked against the release `SHA256SUMS.txt` entry:

```text
c92d54f08a05ee21b86286430a863c53b914eae3945b53cc162a4df542a42dad
```

The verified external tool directory is:

```text
/home/oliver/Projects/fittimer-media-research/tools/franken_tts-v0.1.5
```

The model is kept outside Git at:

```text
/home/oliver/Projects/fittimer-media-research/cache/franken_tts-v0.1.5/model
```

It is the upstream `qwen3-tts-12hz-0.6b-base` model pulled by the tagged CLI.
The tagged model-manifest file has SHA256
`2445f0abcb6a611593bd9adef7cff0989e13dd6be78637ef9d8f8831dd9705f0`.

The disposable research checkout was removed after source, README, tests,
release notes, and CLI schema facts were recorded. The release's published
checksum filename is `SHA256SUMS.txt`, while the tagged installer expects
`SHA256SUMS`; this is documented in [upstream issue #2](https://github.com/Dicklesworthstone/franken_tts/issues/2).
The Linux tarball also contains harmless AppleDouble `._*` members, so the
archive is extracted explicitly rather than piping an installer into a shell.

## Reproducible commands

From the repository root, with the external paths above present:

```sh
ftts=/home/oliver/Projects/fittimer-media-research/tools/franken_tts-v0.1.5/ftts
model=/home/oliver/Projects/fittimer-media-research/cache/franken_tts-v0.1.5/model
cache=/home/oliver/Projects/fittimer-media-research/cache/franken_tts-v0.1.5

"$ftts" --version
"$ftts" pull --model "$model"
node scripts/voice/build-pack.mjs --write
node scripts/voice/generate-clips.mjs \
  --tool-root /home/oliver/Projects/fittimer-media-research/tools/franken_tts-v0.1.5 \
  --model-dir "$model" \
  --cache-dir "$cache"
node scripts/voice/generate-clips.mjs --check
```

The generator invokes the pinned native command for each phrase:

```sh
ftts say --model <external-model-dir> --voice matt \
  --output <external-wav> <phrase-text>
ffmpeg -i <external-wav> -codec:a libmp3lame -b:a 64k \
  -ar 24000 -ac 1 <repo-asset>.mp3
```

`generate-clips.mjs --from N --limit M` is resumable and validates only that
selected range after a partial run. An unbounded run and `--check` validate all
phrases. A phrase is skipped only when its manifest text hash, voice, MIME
type, URL, on-disk SHA256, and byte count all still match. Source WAV files
remain in the external cache for provenance; only converted MP3 clips and
manifest metadata are committed.

The CLI supports `--voice` (the pack is generated with the built-in `matt`
voice), `--no-resident`, `--force`, and the environment controls documented by
`ftts robot schema`, including `FTTS_MODEL_DIR`, `FTTS_THREADS`,
`FTTS_PROFILE`, `FTTS_PACKET_FRAMES`, `FTTS_MATH_MODE`, `FTTS_QUANT`,
`FTTS_FORCE_ARCH`, `FTTS_NUMA`, `FTTS_MAX_FRAMES`, and
`FTTS_RESIDENT_IDLE_SECS`. This project sets the model directory and a short
resident idle timeout; it does not install anything globally.

## Phrase-pack contract

`scripts/voice/build-pack.mjs` walks `data/content-index.json`, every installed
schema-v2 routine and block, and every expanded interval. The current finite
inventory has 203 phrases from 180 intervals across MadFit and W1–W4:

- interval and movement display names use stable `movement-...` IDs;
- `go`, `rest`, and `next` are boundary/control phrases;
- side announcements are explicit (`side-left`, `side-right`, and so on);
- countdown digits 1–3 are included for future voice consumers.

`data/voice/voice-pack-v1.json` is versioned independently of content schema
v2. Each generated asset records its MIME type, repo-relative URL, byte count,
converted-file SHA256, source-WAV SHA256, source text SHA256, and source voice.
The current pack has digest
`993f2841bd4d7d7cf3a1397d80f9726a3b88ae18c37129aa60132bb143dc4240`.
The inventory digest prevents silently using a pack generated from different
installed content. The corrected MadFit reverse-lunge/overhead-drive phrases
were regenerated while matching assets were reused; the three obsolete snatch
artifacts were removed, leaving the disk asset set equal to the 203-phrase
manifest.

## Runtime queue

`src/voice-cues.mjs` accepts the existing `settings.voice` shape. Call
`unlock()` only from the Start button gesture; it creates/resumes WebAudio and
marks speech fallback as available. With `packId: "frankentts-v1"`, a valid
pack asset is fetched and decoded with WebAudio. Missing, unavailable, or
corrupt assets use `SpeechSynthesis` only after unlock. No media element or
media-session integration is involved.

Fresh settings default to `frankentts-v1`, so ordinary workouts use the
verified WebAudio pack without depending on browser speech. A user who has
explicitly saved `browser-speech-v1` keeps that choice; loading settings does
not rewrite it. The app starts bounded pack loading during content
initialization, sets the selected routine's intervals before Start, and keeps
Start independent of a hung pack request. The service worker v7 shell
contains the queue module, manifest, and all 203 current clips.

The queue announces `Go`, the current exercise, and its side at work start;
`Rest`, then `Next`, the next exercise, and its side during rest when the
corresponding settings toggles are enabled. `shouldPlayCountdown()` and
`arbitrateCountdown()` expose the countdown/voice arbitration decision so the
renderer can suppress a countdown tone whenever a voice window is active or
being scheduled. `resume()` is bounded for mobile/background AudioContext
restoration and does not enqueue a new announcement. Pause and End-confirm
pause cancel pending/scheduled voice while retaining announcement state, so a
resume does not repeat the current exercise or rest cue.

## Verification notes

The real smoke command used the external `matt` voice and produced a 24 kHz,
mono, 16-bit WAV before conversion. No operator-provided enrollment/reference
voice is required for this built-in voice path. Focused queue/build/settings
tests, strict pack checks, and the PWA shell checker cover the integrated
surface; a browser/offline run remains the final device-specific confidence
check.
