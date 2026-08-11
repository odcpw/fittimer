# Clip library

FitTimer treats movement visuals as a reusable private library, not as artwork
embedded in one workout. A routine refers only to a stable `movementId`; a
selected media pack supplies the best reviewed visual for that movement. This
keeps W1–W4 usable now and lets later routines mix the same safe primitives
without editing application code.

## Delivery path

1. Retain source videos, subtitles, metadata, and research contact sheets in
   the private media workspace outside Git.
2. Record reviewed source candidates in `data/media/clip-sources.json` using
   exact movement IDs, source ranges, side/equipment, loop phase, crop, safe
   regions, form notes, and verification evidence.
3. Convert approved candidates into private catalogues and run
   `scripts/media/pipeline.mjs` to create silent MP4 loops, posters, hashes,
   provenance, and media-pack records.
4. Import the private pack into the PWA for offline use. Source and derived
   video bytes never enter the public repository.
5. Reuse the same source ranges later for pose extraction and avatar rendering.

The committed source map is the bridge between research and production. A
`search-required` record is honest unfinished research; the production-ready
gate rejects it. `reuse` is allowed only when the mechanics, side, equipment,
and cadence are a real match rather than merely a similar-looking exercise.

## Visual contract

- landscape 16:9 output, normally no larger than the retained 720p source;
- silent H.264 video plus a matching poster;
- a person-forward crop with reasonably consistent scale across the pack;
- complete head, hands, feet, equipment, mat/floor contacts, and motion path;
- normally two to five complete forward-played repetitions with matching seam
  phases; slow compounds, holds, and mobility clips use an explicit judged
  duration;
- exact side and equipment metadata, with deliberate mirroring only when the
  source side is genuinely generic; and
- normal-speed and half-speed review before an asset is accepted.

The validator resolves every normalized crop against the recorded source
dimensions and rejects odd-pixel or non-16:9 rectangles. Every declared hand,
foot, equipment, and movement-path safety region must also remain inside that
crop. This catches geometry that looks plausible as decimals but would stretch
or clip when encoded.

Cropping cannot repair source framing. If the original camera cuts off an
overhead weight, a foot, or the end of the motion path, the source is retained
as reference material but another exact source supplies the production clip.

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
