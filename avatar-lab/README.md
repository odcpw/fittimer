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

## Direct SMPL-X dead bug

`/avatar-lab/wholebody-deadbug.html` maps the 15-second RTMW3D-X dead-bug
capture directly onto the native 55-joint SMPL-X skeleton and its 10,475-vertex
skin. The default view is the animated human body; **Capture overlay** reveals
the underlying 133-point observation for comparison. The fit includes explicit
supine torso/face orientation and per-frame floor contact and does not pass
through OpenSim or the Michelle/Mixamo rig.

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
