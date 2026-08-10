# Private media pipeline

`scripts/media/pipeline.mjs` is the dependency-free, content-build pipeline for
turning curated source clips into silent landscape MP4s and posters. It is
private tooling: source files and derived media belong outside the Git checkout
and are never added to `data/` by this script.

## Tools and invocation

The pipeline shells out to the installed `ffmpeg` and `ffprobe`. A direct
`yt-dlp` executable can be supplied with `--yt-dlp`; when it is not on `PATH`,
the default discovery also tries `uvx yt-dlp`. All tool paths are configurable:

```sh
node scripts/media/pipeline.mjs \
  --catalogue /path/to/clip-catalogue.json \
  --source-cache /home/oliver/Projects/fittimer-media-research/source-cache \
  --output-root /home/oliver/Projects/fittimer-media-research/pipeline-output
```

`FITTIMER_MEDIA_SOURCE_CACHE`, `FITTIMER_MEDIA_OUTPUT_ROOT`,
`FITTIMER_MEDIA_YTDLP`, `FITTIMER_MEDIA_FFMPEG`, and
`FITTIMER_MEDIA_FFPROBE` provide equivalent defaults. The default roots are
under `/home/oliver/Projects/fittimer-media-research`. A root inside the
repository, or overlapping the other root, is rejected.

The CLI writes one JSON summary to stdout. Structured phase and error records
go to stderr, so a caller can consume stdout without scraping progress text.

## Catalogue contract

The input is schema version 1, `kind: "clipCatalogue"`, with a pack and an
explicit `clips` array. Each clip records:

- `source.url` and an optional stable `source.cacheKey`;
- `timeRange.startSeconds` and `endSeconds`;
- `movementId`, anatomical `side`, `equipment`, and `viewpoint`;
- a normalized 16:9 `crop` and normalized `safeFrame` rectangles for
  `hands`, `feet`, `equipment`, and `movementPath`;
- `loop.kind`, phase matching, phase notes, and either `reps` or judged
  `durationSeconds`; and
- `movementKind`: `normal`, `compound`, `hold`, or `mobility`.

The optional root `loopPolicy` makes loop expectations configurable rather
than implicit. Its default is:

```json
{
  "normal": {
    "minReps": 2,
    "maxReps": 5,
    "minDurationSeconds": 5,
    "maxDurationSeconds": 10
  },
  "judged": {
    "minDurationSeconds": 1,
    "maxDurationSeconds": 120
  }
}
```

Repetition loops require a matching start/end phase and a rep note. Hold and
mobility loops use a declared judged duration that matches the selected source
range. Validation rejects duplicate clip IDs, duplicate `movementId::side`
mappings, missing fields, unsafe regions outside the crop, invalid durations,
and unsupported enums. The crop is checked again after ffprobe because a
normalized rectangle must produce an exact 16:9 pixel rectangle at the source
resolution.

## Outputs and determinism

The output root contains only build artifacts:

- `clips/<clip-id>.mp4`: H.264, `yuv420p`, landscape 16:9, faststart, and no
  audio stream;
- `posters/<clip-id>.png`: one matching landscape poster frame;
- `clip-manifest.json`: provenance records with the effective loop policy,
  source hash, crop/safe-frame
  metadata, loop notes, source and output dimensions, rounded duration, byte
  size, SHA-256, codec, pixel format, and audio-stream count; and
- `media-pack.json`: the current version-1 media-pack contract shape with
  `outputFrame`, framing profile, and movement entries. The private URLs are
  relative to this output root; promotion into `data/` is a separate reviewed
  step.

The encoded crop already contains the curated safe frame, so the generated
pack's framing profile is a full-frame `contain` profile. The source crop and
all four safe regions remain in `clip-manifest.json` for review and future
pack promotion. Output dimensions never exceed the cropped source. Widths are
chosen in 32-pixel increments so the exact 16:9 height is even for
`yuv420p`; the default maximum is 1280, so a native 1280×720 crop stays at
1280×720 while smaller crops are never upsampled.

The source cache is keyed by `cacheKey` (or a stable URL hash) and records its
source URL in a sidecar. Existing matching cache entries are reused. An
existing matching clip manifest, output hash, dimensions, duration, poster,
and ffprobe result causes the second run to skip download and encode. Changed
catalogue records or source hashes fail with a stale-output error instead of
silently replacing a reviewed clip.

## Synthetic proof and future sources

`test/media-pipeline.test.mjs` creates a short synthetic 16:9 source with a
real video stream and an audio stream under
`/home/oliver/Projects/fittimer-media-research/pipeline-samples`. It runs two
catalogue mappings through the actual installed ffmpeg/ffprobe, proves zero
audio on both MP4s and posters, checks exact dimensions and manifest hashes,
and runs the same build again to prove no-work idempotence. The test also
exercises duplicate, missing, unmapped, unsafe-crop, duration, and
audio-bearing validation paths. The metadata-only fixture is
`test/fixtures/media/sample-catalogue.json`; it contains no media bytes.

For real production work, a curator should make a new catalogue with the
source URL, a stable cache key, reviewed time range, movement mapping, and
frame-safe crop. The URL is passed to yt-dlp without any channel or routine
assumption. Review the generated poster and safe-frame metadata before a
separate promotion step copies approved assets and contract records into the
shipped content pack.
