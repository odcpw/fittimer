# FitTimer Motion Lab

Open `/avatar-lab/index.html` through the FitTimer private server. The page
loads one skinned Michelle armature and lets you rotate, zoom, pause, scrub, and
change speed while comparing three retargeted motion loops.

The clips are MadFit bodyweight squat, Sydney Cummings reverse lunge with knee
drive, and Growingannanas butt kicks. The page is a visual mocap prototype, not
the later biomechanical model.

Creator and source provenance are stored in each animation's glTF extras. The
Motion Lab is an online evaluation surface and is not loaded by the offline
workout PWA.

## Description-constrained SMPL-X dead bug

`/avatar-lab/wholebody-deadbug.html` builds a 15-second contralateral dead bug
from a structured written-form specification derived from Contreras, NSCA, and
NASM descriptions. A constrained solver creates three key poses on the native
55-joint SMPL-X skeleton; smooth joint rotations connect them while the trunk
stays fixed. No video observation, pose detector, OpenSim retarget, or
Michelle/Mixamo rig drives this version. **Joint rig** reveals its armature.

The earlier direct RTMW3D-X artifacts remain available for diagnosis, but are
not loaded by this page because their monocular frame jitter produced unstable
full-body motion.

## OpenSim dead bug

`/avatar-lab/opensim-deadbug.html` is the first biomechanics-backed evaluation
surface. It plays a MadFit dead bug fitted directly to the OpenSim 4.4
LaiUhlrich2022 articulated model. The page exposes the actual fitted marker
trajectory with orbit, zoom, scrubbing, and playback-speed controls.

The source is a clean near-side view. A Sydney Cummings oblique view was also
tested but rejected because its monocular fit was geometrically inconsistent;
it is not blended into the accepted motion. The present result is kinematic,
not a force or tissue simulation, and uses a generic rather than personalized
body model.
