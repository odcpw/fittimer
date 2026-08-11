# Clip library

FitTimer treats movement visuals as a reusable private library, not as artwork
embedded in one workout. A routine refers only to a stable `movementId`; each
movement may have several creator-specific variants. This lets a workout use
the best available clip, or become a patchwork made only from one creator's
videos, without editing the routine.

Every private asset records `creatorId`, `creatorName`, `variantId`, source
video ID/title/URL, source start/end, and equipment. The pack-level `creators`
registry decides which professional creators appear in the app. Older research
clips stay indexed but are not exposed as creator choices.

The canonical private catalogue is compiled with
`scripts/media/creator-library.mjs`. Its inputs are independently reviewed
`approvedCreatorMovementCandidates` files; its outputs are the complete
creator-movement library, a movement-by-creator matrix, the ready encode queue,
and the explicit review/rejection queue. Multiple ranges for the same movement
and creator are preserved as variants rather than silently collapsed.

```sh
node scripts/media/creator-library.mjs \
  --input /home/oliver/Projects/fittimer-media-research/approved-creator-library-v1 \
  --requirements data/blocks \
  --retained-root /home/oliver/Projects/fittimer-media-research \
  --require-all-retained \
  --output /home/oliver/Projects/fittimer-private-packs/creator-library-v1/catalogue \
  --verify-files
```

`--verify-files` proves every ready range still points to a retained private
source. The generated files contain private paths and therefore remain outside
Git. A range is `ready` only when its movement semantics and framing were
reviewed; `candidate`, `approximate`, and `rejected` records remain searchable
and must carry an honest reason. Supplying routine or block JSON through
`--requirements` also writes exact per-workout creator totals and the uncovered
movement search queue.
`--retained-root` deduplicates the approved channels' yt-dlp metadata by creator
and video ID; `--require-all-retained` makes an omitted retained source a hard
failure while allowing newly downloaded, fully indexed library sources.

Ready records are encoded as practical reference clips with the companion
`creator-clip-pipeline.mjs`:

```sh
node scripts/media/creator-clip-pipeline.mjs \
  --library /home/oliver/Projects/fittimer-private-packs/creator-library-v1/catalogue/creator-movement-library.json \
  --output /home/oliver/Projects/fittimer-private-packs/creator-library-v1/pack
```

This path accepts reviewed 2–40 second ranges, removes audio, fits the complete
source frame into landscape 16:9 without cropping, and emits H.264 clips,
posters, hashes, a provenance manifest, and a multi-variant creator-aware media
pack. It deliberately does not demand matching loop seams, a prescribed tempo,
or a particular demonstrated side.

## Delivery path

1. Retain source videos, subtitles, metadata, and research contact sheets in
   the private media workspace outside Git.
2. Map useful ranges to stable movement IDs and record the creator, source,
   equipment, and timestamps.
3. Convert approved candidates into private catalogues and run
   `scripts/media/pipeline.mjs` to create silent MP4 loops, posters, hashes,
   provenance, and media-pack records.
4. Import the private pack into the PWA for offline use. Source and derived
   video bytes never enter the public repository.
5. Reuse the same source ranges later for pose extraction and avatar rendering.

The private media pack is the runtime database. New variants can be appended
without deleting the current clip. Set `priority: 0` to make a reviewed variant
the Automatic choice; set `enabled: false` to retain a rejected source without
showing it in a workout.

Creator selection is strict. If Growingannanas is selected, the resolver and
offline cache use only Growingannanas assets. A missing movement shows “Video
needed”; it never borrows another creator or falls back to a GIF.

## Visual contract

- landscape 16:9 output, normally 1280×720;
- silent H.264 video plus a matching poster;
- full source fitted with `contain`; do not crop the performer;
- crop only when it cleanly removes a source timer/banner without losing the
  person, equipment, contacts, or movement path;
- usually a few clear repetitions, but 25–40 second workout slices are welcome;
- tempo and demonstrated side are reference metadata, not rejection gates;
- bodyweight or dumbbells only for the current app; and
- honest creator/source provenance on every variant.

## Future avatar and mocap stage

The useful second stage is motion retargeting, not unconstrained video
generation:

1. Extract a pose track only from a source range that already passed the form
   and seam review.
2. Clean foot contacts, joint occlusions, hand/equipment paths, and the loop
   boundary manually in Blender.
3. Store the cleaned motion independently from the rendered character.
4. Retarget that motion to interchangeable rigs: the anatomical muscle-chain
   avatar, a simple wireframe, or another stylized "ragdoll" skin.
5. Render silent 16:9 clips and feed them through the same pack validator as
   filmed clips.

The Blender MCP can automate scene setup, retargeting, cameras, materials, and
batch renders. Unity is also viable as an offline renderer, but exporting clips
keeps the shipped PWA dependency-free. Pinokio/Maestro can orchestrate local
generation experiments on the 3090; generated motion should still be checked
against the approved reference track before it is allowed into a training
pack. Neither path changes the stable movement IDs or the timer runtime.

An eventual avatar setting should select a visual pack, not alter workout
data. Beep and voice preferences remain separate WebAudio settings, so any
avatar or filmed clip continues to play silently alongside the user's music.
