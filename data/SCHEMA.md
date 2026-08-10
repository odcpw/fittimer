# FitTimer data schema — version 2

FitTimer content is JSON split into reusable workout data and a separate
media-pack contract:

- `data/blocks/*.json` holds reusable ordered interval lists.
- `data/routines/*.json` holds picker-visible workouts.
- `data/media/*.json` describes versioned visual packs. A movement identity is
  never coupled to a GIF, video, poster, or filename.
- `data/content-index.json` discovers the installed routines, blocks, and
  built-in media packs.

All paths and IDs are repo-relative and stable. The runtime discovers routine
files through the content index; adding a valid routine must not require an
application-code change. The shipped app has no v1 content compatibility
path: every block, routine, and content index is migrated directly to
`schemaVersion: 2`.

Run the contract checks from the repository root:

```sh
node scripts/validate.mjs data/routines/*.json
node scripts/test-validator.mjs
```

Add `--json` to the validator for versioned machine-readable output. The
validator loads every block and built-in media pack, expands each requested
routine, verifies exact duration, checks movement-pack coverage, and checks
every selected media asset on disk.

## Common content rules

- `schemaVersion` is the integer `2` in every block, routine, and content-index
  file.
- `kind` is exactly `"block"` or `"routine"` in content files.
- Every `id` is unique within its kind and uses lowercase kebab-case.
- Durations are positive integer seconds. Zero and negative values are invalid.
- Unknown fields are invalid. Update this contract deliberately before adding
  new fields.
- Every movement has a stable `movementId`. The ID describes the movement,
  not the current visual asset or catalog exercise ID.
- A movement has no `gif` field. Visual selection is data-only through the
  selected media pack.

## Block

```json
{
  "schemaVersion": 2,
  "kind": "block",
  "id": "ten-minute-core",
  "title": "Ten-minute core",
  "description": "Optional human-readable detail.",
  "intervals": []
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | yes | integer | Contract version; exactly `2`. |
| `kind` | yes | string | Exactly `"block"`. |
| `id` | yes | string | Unique lowercase kebab-case block ID. |
| `title` | yes | string | Human-readable block name. |
| `description` | no | string | Curator-facing summary. |
| `intervals` | yes | interval[] | Non-empty ordered interval list. |

A block has no routine ownership. Any number of routines can reference the
same `id`, which is the cross-routine reuse mechanism.

## Routine

```json
{
  "schemaVersion": 2,
  "kind": "routine",
  "id": "forty-minute-session",
  "title": "Forty-minute session",
  "description": "Optional picker summary.",
  "equipment": ["mat", "light dumbbells"],
  "estimatedDurationSeconds": 2400,
  "source": {
    "channel": "Optional source name",
    "videoId": "Optional source ID",
    "url": "https://example.com/optional-source"
  },
  "notes": ["Optional curator note."],
  "safetyCues": ["Routine-wide safety or regression rule."],
  "sequence": [
    { "blockId": "warm-up" },
    { "blockId": "strength" },
    {
      "interval": {
        "displayName": "One-off finisher",
        "workSeconds": 40,
        "restSeconds": 20,
        "movements": [
          { "movementId": "fast-feet", "displayName": "Fast feet", "textOnly": true }
        ]
      }
    }
  ]
}
```

`estimatedDurationSeconds` must equal the sum of every expanded interval's
`workSeconds + restSeconds`. This catches stale picker metadata.

`safetyCues`, when present, carries routine-wide form, load, pain, and
regression rules that apply in addition to an interval's own `coachNote`.

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | yes | integer | Contract version; exactly `2`. |
| `kind` | yes | string | Exactly `"routine"`. |
| `id` | yes | string | Unique lowercase kebab-case routine ID. |
| `title` | yes | string | Human-readable routine name. |
| `description` | no | string | Picker-facing summary. |
| `equipment` | yes | string[] | Equipment needed for the routine. |
| `estimatedDurationSeconds` | yes | integer | Exact expanded work-plus-rest duration. |
| `source` | no | object | Provenance fields; at least one field when present. |
| `notes` | no | string[] | Curator-facing notes. |
| `safetyCues` | no | string[] | Routine-wide form, load, pain, or regression cues. |
| `sequence` | yes | sequence[] | Ordered block references and/or inline intervals. |

The sequence item rules are unchanged from the composition model: each item
contains exactly one `blockId` or one inline `interval`.

## Interval

```json
{
  "displayName": "Deadlift + upright row",
  "workSeconds": 40,
  "restSeconds": 20,
  "side": "alternating",
  "tempo": "controlled hinge; no bounce",
  "rpe": "6–7",
  "regressions": ["Use a lighter load or shorten the range if form changes."],
  "coachNote": "Alternate one rep of each movement.",
  "match": "combo",
  "movements": [
    {
      "movementId": "dumbbell-deadlift",
      "exerciseId": "0300",
      "displayName": "Dumbbell Deadlift"
    },
    {
      "movementId": "dumbbell-upright-row",
      "exerciseId": "0437",
      "displayName": "Dumbbell Upright Row"
    }
  ]
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `displayName` | yes | string | Name displayed and announced for the whole interval. |
| `workSeconds` | yes | integer | Positive work duration in seconds. |
| `restSeconds` | yes | integer | Positive following-rest duration in seconds. |
| `side` | no | enum | `left`, `right`, `alternating`, `bilateral`, `first`, or `second`. |
| `tempo` | no | string | Prescribed rep cadence, pause, hold, or controlled-speed cue. |
| `rpe` | no | string | Target effort notation, retained as written by the routine author (for example `8`, `6–7`, or `2→4`). |
| `regressions` | no | string[] | One or more explicit lower-load, supported, range, or toe-safe options. |
| `coachNote` | no | string | Form guidance or an explicit visual-substitution decision. |
| `match` | no | enum | `exact`, `close`, `combo`, `loose`, or `none`. |
| `movements` | yes | movement[] | Non-empty list of visual movements. |

Multiple movements require `match: "combo"`; a combo requires at least two.
Per-side exercises remain separate intervals so timing, announcements,
history position, and skip behavior are unambiguous.

## Movement

Normal visual movement:

```json
{
  "movementId": "push-ups",
  "exerciseId": "0662",
  "displayName": "Push-up"
}
```

Deliberate text card when no honest animation exists:

```json
{
  "movementId": "bum-kicks",
  "displayName": "Bum kicks",
  "textOnly": true
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `movementId` | yes | string | Stable lowercase kebab-case movement identity. |
| `exerciseId` | no | string | External/catalog ID; never the visual selector. |
| `displayName` | yes | string | Movement name shown with the visual. |
| `textOnly` | no | `true` | Deliberately request the text fallback; never accompanies a visual field. |

`textOnly` is product data, not a validator escape hatch. A manifest entry is
still required for a text-only movement so the pack's coverage is explicit;
it has an empty `assets` list and `fallback: "text"`.

## Content index

```json
{
  "schemaVersion": 2,
  "defaultMediaPack": "gif-v1",
  "mediaPacks": { "gif-v1": "data/media/gif-v1.json" },
  "routines": ["data/routines/madfit-30min-hiit.json"],
  "blocks": { "madfit-30min-hiit": "data/blocks/madfit-30min-hiit.json" }
}
```

The default pack is the pack used for offline preparation and runtime
resolution. A routine references blocks by ID; the index maps those IDs to
files. The runtime caches only the selected pack manifest and assets reachable
from installed routine movements, never the full exercise catalog or every
asset in a pack.

## Media pack

A media pack has its own independent manifest version because `gif-v1` is a
pack release name, not a legacy content schema. The built-in manifest uses:

```json
{
  "schemaVersion": 1,
  "kind": "mediaPack",
  "id": "gif-v1",
  "outputFrame": {
    "orientation": "landscape",
    "width": 16,
    "height": 9,
    "qaViewport": { "width": 844, "height": 390 },
    "scalePolicy": "avoid-upsample"
  },
  "framingProfiles": {
    "full-source-landscape": {
      "fit": "contain",
      "crop": { "x": 0, "y": 0, "width": 1, "height": 1 },
      "zoom": 1,
      "anchor": { "x": 0.5, "y": 0.5 },
      "safeRegions": {
        "hands": { "x": 0, "y": 0, "width": 1, "height": 1 },
        "feet": { "x": 0, "y": 0, "width": 1, "height": 1 },
        "equipment": { "x": 0, "y": 0, "width": 1, "height": 1 },
        "movementPath": { "x": 0, "y": 0, "width": 1, "height": 1 }
      }
    }
  },
  "entries": {
    "push-ups": {
      "anatomicalSide": "bilateral",
      "mirroring": "never",
      "assets": [
        { "type": "gif", "url": "data/gifs/0662.gif", "framing": "full-source-landscape" }
      ]
    }
  }
}
```

`outputFrame.width` and `.height` are ratio units, not an instruction to
render a 16×9 pixel bitmap. `qaViewport` records the required landscape-first
stage QA target. `scalePolicy: "avoid-upsample"` means a renderer may derive a
16:9 stage from that target but must not enlarge a source beyond its native
resolution when a contained render can preserve it. Portrait is a renderer
fallback only; it is not a pack or output orientation.

### Media entry and asset rules

Each `entries[movementId]` record requires:

- `anatomicalSide`: `left`, `right`, `bilateral`, `alternating`, or
  `unspecified`.
- `mirroring`: `never`, `when-needed`, or `always`. `when-needed` mirrors only
  when a requested left/right interval differs from a left/right asset side;
  `never` preserves the source orientation; `always` is an explicit pack
  decision.
- `assets`: ordered fallback candidates. They may have type `video` (and must
  declare `audio: "none"`), `animated-webp`, `gif`, or `poster`.
- `fallback: "text"` when the entry has no assets. Missing, corrupt, or
  unsupported assets always end in the movement display name as a safe text
  fallback; a poster is preferred before text.

Every asset has a normalized repo-relative `url` and a `framing` profile. A
framing profile contains:

- `fit`: `contain` or `cover`.
- `crop`: normalized source rectangle (`x`, `y`, `width`, `height`) in the
  range 0–1.
- `zoom`: a positive scale factor for a consistent useful trainer size.
- `anchor`: normalized crop anchor (`x`, `y`) in the range 0–1.
- `safeRegions`: normalized bounding rectangles for `hands`, `feet`,
  `equipment`, and `movementPath`. These are conservative bounds that the
  chosen crop must retain. They make a crop decision explicit rather than
  relying on filename or pixel heuristics.

The validator rejects a crop that excludes any safe region. The current GIFs
use the full source frame, `contain`, and `zoom: 1`: the entire square source
is retained inside the new 16:9 landscape stage, so no MadFit visual is
cropped or unnecessarily upsampled.

## Evolution

Content schema changes require a new integer `schemaVersion`, validator
support, and a documented migration. Version 2 deliberately rejects v1 files
and old direct GIF fields. Media-pack changes use the pack's own versioned ID;
changing a visual for an existing movement requires only a media-pack data
change, not a routine or application-code change.
