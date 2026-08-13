# Local clip-to-avatar pipeline

Status: executable first slice on the `3090`, 2026-08-13. This document is the
decision record for Bead `ft-research-local-monocular-mocap-ldx`.

## Decision

Use a **movement-dependent hybrid**, selected by visible accuracy rather than
forcing one model across every camera geometry:

- use full GEM-X or GVHMR 3D only where its mesh overlay stays attached to the
  creator (the upright squat passed);
- for floor work and severe self-occlusion, make the accurate VitPose
  image-plane skeleton authoritative and add only bounded depth from GVHMR;
- normalize either result to the same Z-up joint-motion contract, then export
  through Blender to a Three.js-compatible GLB.

This decision comes from running both engines on the same difficult dead-bug
clip. Both full meshes invented visibly wrong arm geometry. GVHMR's 2D VitPose
overlay, however, tracked the real arms and legs precisely. The checked-in
`gvhmr-to-motion.py` therefore preserves that silhouette instead of hiding the
failure behind a plausible-looking 3D body.

The implemented path is:

```text
approved creator clip
  -> GEM-X or GVHMR detection + VitPose overlay
  -> full temporal 3D when visually valid
     OR image-plane skeleton + bounded depth when full 3D fails
  -> normalized Z-up joint-motion JSON
  -> Blender diagnostic avatar + animation
  -> glTF 2.0 binary (.glb)
  -> Three.js GLTFLoader + AnimationMixer
```

This does not replace the creator video in the PWA yet. The diagnostic avatar
is deliberately a simple articulated ragdoll. It proves coordinate conversion,
hierarchy, animation, provenance, Blender automation, and the GLB boundary
before time is spent modeling or skinning a polished anatomical avatar.

## Candidate comparison

| Candidate | Actual role and output | Local 3090 result | FitTimer decision |
|---|---|---|---|
| [DWPose](https://github.com/IDEA-Research/DWPose) | Fast whole-body **2D** keypoints/overlay; it does not recover depth or world motion. | Not needed yet because both tested runners already provide strong 2D pose. | Alternative detector if VitPose later loses a subject. |
| [EasyMocap](https://github.com/zju3dv/EasyMocap) | Fits SMPL/SMPL-X from keypoints, including Internet video. | Not installed; its multi-stage optimization is heavier than the working path. | Cleanup candidate only if a valuable movement defeats both current routes. |
| [GVHMR](https://github.com/zju3dv/GVHMR) | Temporal world-grounded recovery plus YOLO/VitPose observations; produces `hmr4d_results.pt`. | **Installed and ran end-to-end on 360 dead-bug frames.** Full mesh was better grounded than GEM-X but still got the arms wrong. Its VitPose overlay was excellent. | Source for the difficult-clip hybrid and a full-3D candidate when overlay QA passes. |
| [Mocap-2-to-3](https://wangzhumei.github.io/mocap-2-to-3/) | Diffusion-based lifting from monocular 2D pose to absolute SMPL/global motion. | Official repository cloned. It exposes dataset training/evaluation rather than a ready arbitrary-video demo, so a useful comparison needs an input adapter. | Next serious lifting challenger if the hybrid's bounded depth is insufficient. |
| [DanceHMR](https://shenwenhao01.github.io/dancehmr/) | Temporally coherent SMPL-X body and hand motion for occlusion and blur. | No runnable public implementation was established. | Revisit if released; not a present executable option. |
| [GEM-X](https://github.com/NVlabs/GEM-X) | Detection, 77-joint 2D pose, temporal whole-body 3D SOMA parameters and mesh renders. | **Passed the 150-frame upright squat. Failed the 360-frame dead-bug mesh alignment.** | Full 3D for clips where the actual overlay passes; never assumed correct from model output alone. |
| Generative video tools (Maestro/Pinokio video generation) | Synthesize pixels rather than a deterministic joint hierarchy and retargetable animation. | Not needed for extraction. | Possible later renderer, not the measured motion source. |

Runtime inputs are recorded for reproducibility, not used as a quality veto:
DWPose needs detector/pose weights; EasyMocap and GVHMR need SMPL-family body
assets and checkpoints; GEM-X needs SOMA and ONNX weights; Mocap-2-to-3 needs
its checkpoint plus an input adapter. Their upstream repositories contain the
current code/model license files. No candidate in this personal prototype is
rejected merely because its terms differ from another candidate's.

### Why the result is hybrid rather than 2D-only or 3D-only

A 2D overlay is useful for detecting a lost subject, swapped limb or clipped
hand. A freely rotated avatar eventually needs depth, but the test disproved
the assumption that inferred depth is always more truthful than visible 2D
form. The hybrid keeps image-plane coordinates authoritative and limits the
effect of inferred depth. The normalized JSON prevents Blender, Three.js, or a
future avatar from depending on either model's private tensor layout.

## Verified machine setup

- Machine: `3090`, NVIDIA RTX 3090 24 GB, driver 610.57.04.
- Blender: 5.2 LTS at `/usr/bin/blender`.
- Media/runtime: FFmpeg 9, Python 3.12 virtual environment, `uv` 0.11.6,
  PyTorch 2.10.0+cu126, torchvision 0.25.0+cu126.
- Local tool checkouts and weights live outside the public repository under
  `/home/oliver/Projects/fittimer-mocap-tools/`.
- The official GEM-X checkout includes public SOMA and SAM-3D-Body submodules.
  Git LFS 3.7.1 was installed locally after verifying its published SHA-256.
- The optional Unitree G1 retargeter was not installed; it is irrelevant to a
  Blender/Three.js human avatar.
- Detectron2 compilation failed because the host `nvcc` is CUDA 13.3 while the
  selected PyTorch wheel is CUDA 12.6. This does not block the chosen accelerated
  runner: its YOLOX + ONNX path completed the real smoke test without Detectron2.
- GVHMR runs in a separate Python 3.10 environment with CUDA PyTorch and the
  required YOLO, VitPose, HMR2, GVHMR and body-model assets. Its complete
  detection, pose, recovery and rendering pipeline ran on the same RTX 3090.
- Mocap-2-to-3 is retained as a source checkout, but no claim is made that its
  dataset-oriented runners accept arbitrary creator video today.

The official GEM-X installation describes Python 3.12, a CUDA 12.6+ GPU, Git
LFS and `uv`, and the demo documents its YOLOX -> VitPose -> GEM -> SOMA stages,
static-camera flag, structured outputs and optional `--no-imgfeat` path.

### Pinokio status and direct fallback

Pinokio's `pterm` client is installed at
`/home/oliver/pinokio/bin/npm/bin/pterm`, but the control plane was unreachable
during this task (`ECONNREFUSED 192.168.1.150:42000`). No false Pinokio success
is claimed. The working direct-run fallback is an isolated GEM-X checkout and
virtual environment:

```bash
cd /home/oliver/Projects/fittimer-mocap-tools/GEM-X
source .venv/bin/activate
python scripts/demo/demo_soma_onnx.py \
  --video /absolute/path/to/clip.mp4 \
  --output_root /home/oliver/Projects/fittimer-mocap-tools/outputs \
  -s --no-imgfeat --verbose
```

Static creator clips should use `-s`. The first invocation downloads several
GB of model weights; later clips reuse them. The repository remains dependency
free at runtime because all Python and model work is content-build tooling.

## Real smoke-test results

Input: the existing 1280x720, 30 fps, five-second MadFit clip
`bodyweight-squat-deepening-madfit-320e552dbc.mp4`, source video
`07c6wlJh89U`, range 371-376 seconds.

Observed result:

- all 150 frames received person boxes and 77-joint 2D keypoints;
- GEM-X produced `hpe_results.pt`, an in-camera mesh render, a global render,
  and a 2560x720 side-by-side QA video;
- the midpoint QA frame was visually inspected: the recovered mesh and global
  pose both matched the deep squat without an obvious inversion or lost limb;
- `gem-to-motion.py` produced 150 frames x 77 joints in meters and Z-up
  coordinates in 5.0 seconds on CPU after assets were cached;
- `pipeline.mjs` passed the real motion into Blender 5.2 and exported a
  1,434,468-byte glTF 2.0 GLB with 153 meshes, 153 animation tracks, 154 nodes,
  and embedded source/creator/movement metadata;
- the untrimmed five-second range has a 0.177 m start/end maximum joint gap.
  It is correctly marked `loop: false`; a phase-matched cut is still required
  before a production loop can claim continuity.

First-run wall time was roughly nine minutes, dominated by one-time weight
downloads and initialization. Reported clip-stage timings were approximately
75 s detection, 6 s VitPose, sub-second GEM denoising, and 18 s total mesh
rendering. This is acceptable for an offline content pipeline, not for the PWA.

The generated private evidence remains outside Git at:

```text
/home/oliver/Projects/fittimer-mocap-tools/smoke-outputs/
  bodyweight-squat-deepening-madfit-320e552dbc/
    hpe_results.pt
    motion.json
    avatar.glb
    qa-midpoint.png
    *_1_incam.mp4
    *_2_global.mp4
    *_3_incam_global_horiz.mp4
```

The harder comparison used the existing 1280x720 Sydney Cummings dead-bug
clip, 360 frames / 12 seconds:

- GEM-X tracked all frames, but its recovered mesh visibly lost the floor
  exercise's arm and leg geometry;
- GVHMR completed detection, VitPose, HMR inference and three mesh renders, but
  its full mesh raised an overhead arm vertically and folded the other arm
  toward the torso;
- GVHMR's 2D pose overlay followed the visible dead-bug form accurately, with
  a mean joint confidence of 0.915 and a tracked-frame fraction of 1.0;
- `gvhmr-to-motion.py` converted that silhouette plus bounded depth into 360
  frames x 15 joints, and Blender exported a 455,732-byte GLB containing 29
  meshes, 29 animation clips and 30 nodes;
- the raw 12-second range is truthfully non-looping (0.976 m seam). Loop
  trimming remains an editing decision rather than a mocap failure;
- the checked-in Three.js harness loaded and animated that real GLB in headless
  Chromium, reporting `avatar-hybrid.glb · 29 animation clip(s)` with no load
  error. The captured view is recognizably a dead-bug diagnostic ragdoll.

The private comparison evidence lives at:

```text
/home/oliver/Projects/fittimer-mocap-tools/
  smoke-outputs/dead-bug-sydney-cummings-6388a89b35/
  gvhmr-smoke-outputs/dead-bug-sydney-cummings-6388a89b35/
    hmr4d_results.pt
    motion-hybrid.json
    avatar-hybrid.glb
    three-preview-loaded.png
```

## Data contract

The checked-in scripts enforce two versioned JSON boundaries.

The job record preserves source truth:

```json
{
  "schemaVersion": 1,
  "movementId": "bodyweight-squat-deepening",
  "creator": { "id": "madfit", "name": "MadFit" },
  "source": {
    "url": "https://www.youtube.com/watch?v=07c6wlJh89U",
    "videoId": "07c6wlJh89U",
    "timeRange": { "startSeconds": 371, "endSeconds": 376 }
  },
  "side": "bilateral",
  "equipment": ["bodyweight", "mat"],
  "inputClip": "/private/path/to/clip.mp4",
  "confidence": { "tracking": 1.0, "review": "pass" },
  "mocapAsset": {
    "provider": "GEM-X/SOMA",
    "resultPath": "/private/path/hpe_results.pt",
    "motionPath": "/private/path/motion.json"
  }
}
```

The normalized motion record contains `fps`, a meters/Z-up coordinate system,
`loop`, a named joint list, parent mapping, and per-frame XYZ joint maps. The
validator rejects unknown parents, missing/non-finite joints, duplicate joint
names, invalid coordinate systems, and a declared loop whose maximum joint
seam exceeds 0.08 m. Blender copies provenance and confidence into glTF extras.

Commands after GEM-X inference:

```bash
cd /home/oliver/Projects/fittimer-mocap-tools/GEM-X
source .venv/bin/activate
python /home/oliver/Projects/odcpw/fittimer/scripts/mocap/gem-to-motion.py \
  --input /path/hpe_results.pt --output /path/motion.json \
  --fps 30 --soma-assets inputs/soma_assets

cd /home/oliver/Projects/odcpw/fittimer
node scripts/mocap/pipeline.mjs \
  --job /path/job.json --motion /path/motion.json --output /path/avatar.glb
```

For a difficult GVHMR clip, convert the accurate pose observations and bounded
depth instead:

```bash
python scripts/mocap/gvhmr-to-motion.py \
  --vitpose /path/vitpose.pt --hmr4d-results /path/hmr4d_results.pt \
  --output /path/motion-hybrid.json --fps 30
node scripts/mocap/pipeline.mjs \
  --job /path/job-hybrid.json --motion /path/motion-hybrid.json \
  --output /path/avatar-hybrid.glb
python -m http.server 8877 --directory /path/to/evidence
# open three-preview.html?asset=avatar-hybrid.glb
```

The GLB is the Three.js boundary. The dev-only `three-preview.html` uses
`GLTFLoader`, `AnimationMixer`, and `OrbitControls`; it is intentionally not
loaded by the dependency-free PWA. The test above proves the real browser
load/playback boundary. Embedding it into the workout screen is a later product
change after a stable skinned avatar replaces the diagnostic ragdoll.

## Bounded three-clip gate

Do not mine the whole library yet. Run these existing clips because together
they expose the important failure classes:

| Clip | Why it is in the gate | Current state |
|---|---|---|
| MadFit `bodyweight-squat-deepening-madfit-320e552dbc.mp4` | Upright bilateral movement, hands near one another, deep joint flexion. | GEM-X + normalized motion + Blender GLB **passed**. Production loop cut pending. |
| Sydney Cummings `dead-bug-sydney-cummings-6388a89b35.mp4` | Supine floor orientation and crossing limbs; tests orientation assumptions and self-occlusion. | GEM-X and GVHMR full meshes **failed**. VitPose-authoritative hybrid + Blender GLB + Three.js playback **passed** as a diagnostic avatar. |
| Sydney Cummings `reverse-lunge-knee-drive-sydney-cummings-6d0a7f248b.mp4` | Unilateral balance and meaningful root/foot travel; tests planted-foot stability. | Pending. |

For each clip, pass only when:

1. a single person is tracked on at least 95% of frames, with no identity jump;
2. the authoritative 2D overlay remains attached to the visible body;
3. any full-3D result used as authoritative has plausible orientation and no
   catastrophic limb flip; otherwise the clip uses the bounded-depth hybrid;
4. planted-foot horizontal jitter is no more than 0.05 m over a planted phase;
5. a phase-matched 2-5-rep production cut has a maximum normalized joint seam
   no greater than 0.08 m, or is truthfully stored as a non-looping reference;
6. the Blender process creates a non-empty animated glTF 2.0 GLB with geometry,
   animation, and provenance extras;
7. a browser harness using Three.js `GLTFLoader` and `AnimationMixer` can load
   and play the GLB without console errors before PWA integration begins.

## Blockers, risks, and falsifier

- Monocular recovery can infer an attractive but wrong depth solution. That
  happened twice on the dead bug. The pipeline now preserves reliable visible
  form and treats depth as optional evidence for those clips.
- The current Blender output is a diagnostic articulated figure, not a skinned
  anatomical model. Retargeting to one stable armature and designing muscle
  highlights are the next distinct artifact after the three-clip gate.
- The test GLB has one mesh per joint and bone. A production avatar should use
  a skinned mesh and a smaller animation payload.
- The ONNX runtime warned about execution-provider registration and may place
  some operations on CPU. It still completed correctly; optimize only if repeat
  runs prove throughput is a real bottleneck.
- Pinokio remains unavailable until its control plane is reachable. Direct-run
  output is the current source of truth.

**Falsifier:** reject the hybrid for a clip if its browser playback no longer
preserves the movement's visible silhouette, loses a subject, or introduces a
depth offset that obscures the form. Use full 3D only when its overlay also
passes. If both routes fail on a valuable movement, evaluate Mocap-2-to-3 with
an arbitrary-video adapter, then Blender-assisted cleanup or manual keyframes;
do not hide bad tracking behind a polished mesh.

## Primary references

- [GEM-X repository](https://github.com/NVlabs/GEM-X),
  [installation](https://github.com/NVlabs/GEM-X/blob/main/docs/INSTALL.md), and
  [demo/output contract](https://github.com/NVlabs/GEM-X/blob/main/docs/DEMO.md)
- [DWPose](https://github.com/IDEA-Research/DWPose)
- [EasyMocap](https://github.com/zju3dv/EasyMocap)
- [GVHMR](https://github.com/zju3dv/GVHMR)
- [Mocap-2-to-3](https://wangzhumei.github.io/mocap-2-to-3/)
- [DanceHMR](https://shenwenhao01.github.io/dancehmr/)
- [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) and
  [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html)
- [Blender glTF exporter](https://docs.blender.org/manual/en/latest/addons/import_export/scene_gltf2.html)
