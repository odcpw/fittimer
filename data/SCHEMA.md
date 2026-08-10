# FitTimer data schema — version 1

FitTimer content is JSON split into two kinds of files:

- `data/blocks/*.json` holds reusable ordered interval lists.
- `data/routines/*.json` holds picker-visible workouts. A routine composes
  blocks and/or defines one-off intervals inline.

All paths and IDs are repo-relative and stable. The runtime must discover
routine files from the data directory; adding a valid routine must not require
an application-code change.

Run the contract checks from the repository root:

```sh
node scripts/validate.mjs data/routines/*.json
node scripts/test-validator.mjs
```

Add `--json` to the validator for versioned machine-readable output. The
validator loads every `data/blocks/*.json` file, expands each requested
routine, verifies exact duration, and checks every GIF reference on disk.

## Common rules

- `schemaVersion` is the integer `1` in every file.
- `kind` is exactly `"block"` or `"routine"`.
- Every `id` is unique within its kind and uses lowercase kebab-case.
- Durations are positive integer seconds. Zero and negative values are invalid.
- Unknown fields are invalid. Update this contract deliberately before adding
  new fields.
- A GIF path is normalized, repo-relative, begins with `data/gifs/`, and names
  an existing file.

## Block

```json
{
  "schemaVersion": 1,
  "kind": "block",
  "id": "ten-minute-core",
  "title": "Ten-minute core",
  "description": "Optional human-readable detail.",
  "intervals": []
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | yes | integer | Contract version; exactly `1`. |
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
  "schemaVersion": 1,
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
  "sequence": [
    { "blockId": "warm-up" },
    { "blockId": "strength" },
    {
      "interval": {
        "displayName": "One-off finisher",
        "workSeconds": 40,
        "restSeconds": 20,
        "movements": [
          { "displayName": "Fast feet", "textOnly": true }
        ]
      }
    },
    { "blockId": "cooldown" }
  ]
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | yes | integer | Contract version; exactly `1`. |
| `kind` | yes | string | Exactly `"routine"`. |
| `id` | yes | string | Unique lowercase kebab-case routine ID. |
| `title` | yes | string | Picker-visible workout name. |
| `description` | no | string | Picker-visible summary. |
| `equipment` | yes | string[] | Non-empty list; use `"none"` when appropriate. |
| `estimatedDurationSeconds` | yes | integer | Exact expanded work-plus-rest duration in seconds. |
| `source` | no | object | Attribution; at least one source subfield is required when present. |
| `source.channel` | no | string | Creator or publisher name. |
| `source.videoId` | no | string | Stable ID at the source service. |
| `source.url` | no | string | Source URL. |
| `notes` | no | string[] | Non-empty curator notes; not shown as interval coaching. |
| `sequence` | yes | sequence item[] | Non-empty ordered composition. |

Each sequence item contains exactly one field:

| Field | Type | Meaning |
| --- | --- | --- |
| `blockId` | string | ID of a block in `data/blocks/`; expanded in place. |
| `interval` | interval | A one-off interval owned by this routine. |

`estimatedDurationSeconds` must equal the sum of every expanded interval's
`workSeconds + restSeconds`. This catches stale picker metadata.

## Interval

```json
{
  "displayName": "Deadlift + upright row",
  "workSeconds": 40,
  "restSeconds": 20,
  "side": "alternating",
  "coachNote": "Alternate one rep of each movement.",
  "match": "combo",
  "movements": [
    {
      "exerciseId": "0300",
      "displayName": "Dumbbell Deadlift",
      "gif": "data/gifs/0300.gif"
    },
    {
      "exerciseId": "0437",
      "displayName": "Dumbbell Upright Row",
      "gif": "data/gifs/0437.gif"
    }
  ]
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `displayName` | yes | string | Name displayed and announced for the whole interval. |
| `workSeconds` | yes | integer | Positive work duration in seconds. |
| `restSeconds` | yes | integer | Positive following-rest duration in seconds. |
| `side` | no | enum | `left`, `right`, `alternating`, `bilateral`, `first`, or `second`. `first`/`second` preserve source routines that do not specify left/right. |
| `coachNote` | no | string | Form guidance or an explicit visual-substitution decision. |
| `match` | no | enum | Catalog visual quality: `exact`, `close`, `combo`, `loose`, or `none`. |
| `movements` | yes | movement[] | Non-empty list of visual movements. Multiple entries require `match: "combo"`; a combo requires at least two. |

Per-side exercises are separate intervals with the corresponding `side` value.
This keeps timing, announcements, history position, and skip behavior
unambiguous.

## Movement

Normal GIF-backed movement:

```json
{
  "exerciseId": "0662",
  "displayName": "Push-up",
  "gif": "data/gifs/0662.gif"
}
```

Deliberate text card when no honest animation exists:

```json
{
  "displayName": "Bum kicks",
  "textOnly": true
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `exerciseId` | no | string | External/catalog ID; omitted for uncatalogued movements. |
| `displayName` | yes | string | Movement name shown with the visual. |
| `gif` | conditional | string | Required unless `textOnly` is true; existing repo-relative GIF path. |
| `textOnly` | conditional | boolean | May only be `true`; explicitly replaces `gif`, never accompanies it. |

`textOnly` is deliberate product data, not a validator escape hatch. It lets
the workout screen render a clear instruction card rather than show a broken
or misleading animation.

## Evolution

Schema changes require a new integer `schemaVersion`, validator support, and a
documented migration. Version 1 rejects unknown fields so misspellings cannot
silently become runtime behavior.
