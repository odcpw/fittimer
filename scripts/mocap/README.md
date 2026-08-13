# Mocap pipelines

## Direct 133-point whole-body capture

The current dead-bug observation lab uses RTMW3D-X directly. It retains all
133 output landmarks (body, feet, face, and both hands) from every frame of the
40-second source. It does **not** fit the motion back to OpenSim.

Raw video, the complete observation arrays, and review overlays remain in
`/home/oliver/Projects/fittimer-mocap-tools`. The reproducible 15-second browser
loop is committed as `avatar-lab/assets/deadbug-rtmw3d.json`.

Capture the retained MadFit source on `3090`:

```sh
RTMW_LIB_ROOT=/home/oliver/Projects/fittimer-mocap-tools/GVHMR/.venv/lib/python3.10/site-packages/nvidia
export LD_LIBRARY_PATH="$RTMW_LIB_ROOT/cublas/lib:$RTMW_LIB_ROOT/cuda_runtime/lib:$RTMW_LIB_ROOT/cufft/lib:$RTMW_LIB_ROOT/curand/lib:$RTMW_LIB_ROOT/cusolver/lib:$RTMW_LIB_ROOT/cusparse/lib:$RTMW_LIB_ROOT/nvjitlink/lib:${LD_LIBRARY_PATH:-}"

/home/oliver/Projects/fittimer-mocap-tools/rtmlib/.venv/bin/python \
  scripts/mocap/capture-rtmw3d.py \
  --video /home/oliver/Projects/fittimer-private-packs/creator-library-v1/pack/clips/wave-v3-dead-bug-madfit.mp4 \
  --output-dir /home/oliver/Projects/fittimer-mocap-tools/deadbug-rtmw3d-v1 \
  --preview /home/oliver/Projects/fittimer-mocap-tools/deadbug-rtmw3d-v1/wholebody-overlay.mp4 \
  --rtmlib-root /home/oliver/Projects/fittimer-mocap-tools/rtmlib \
  --source-id wave-v3-dead-bug-madfit
```

Build the reviewed bilateral loop:

```sh
/home/oliver/Projects/fittimer-mocap-tools/rtmlib/.venv/bin/python \
  scripts/mocap/build-rtmw3d-loop.py \
  --observations /home/oliver/Projects/fittimer-mocap-tools/deadbug-rtmw3d-v1/observations.npz \
  --capture /home/oliver/Projects/fittimer-mocap-tools/deadbug-rtmw3d-v1/capture.json \
  --rtmlib-root /home/oliver/Projects/fittimer-mocap-tools/rtmlib \
  --output avatar-lab/assets/deadbug-rtmw3d.json \
  --start-frame 773 \
  --end-frame 1180 \
  --duration 15 \
  --output-fps 30
```

The loop keeps RTMW3D's observed joint directions. Low-confidence samples are
interpolated, all trajectories are temporally smoothed, and 54 connected
body/finger/foot segments keep fixed lengths so an isolated depth outlier
cannot stretch a limb. This is still a monocular estimate, not ground-truth
depth or a force model.

## OpenSim motion fitting

The dead-bug lab uses OpenSim 4.4.1 and the LaiUhlrich2022 model from the
pinned OpenCap Monocular checkout. Creator media, pose arrays, fitted models,
and diagnostic renders stay in `/home/oliver/Projects/fittimer-mocap-tools`;
only the compact browser trajectory is committed here.

Reproduce the accepted MadFit side-view fit on `3090`:

```sh
/home/oliver/Projects/fittimer-mocap-tools/micromamba-bin/micromamba run \
  -p /home/oliver/Projects/fittimer-mocap-tools/envs/opensim44 \
  python scripts/mocap/fit-coco-opensim.py \
  --coco /home/oliver/Projects/fittimer-mocap-tools/opensim-deadbug-multiview-v1/inputs/dead-bug-madfit-side-coco17.npy \
  --model /home/oliver/Projects/fittimer-mocap-tools/OpenCapMonocular/utils/opensim/Model/LaiUhlrich2022.osim \
  --marker-set /home/oliver/Projects/fittimer-mocap-tools/OpenCapMonocular/utils/opensim/Model/LaiUhlrich2022_markers_openpose.xml \
  --output /home/oliver/Projects/fittimer-mocap-tools/opensim-deadbug-multiview-v1/fits/madfit-side \
  --source-id madfit-Nlys2XC7J2M-60-72 \
  --head-side left
```

The solver estimates a perspective camera and fits bounded OpenSim coordinates
to the tracked image joints with temporal and out-of-plane regularization. Its
`.osim`, `.mot`, `.trc`, overlay, and metrics outputs are the review evidence.
This is kinematic reconstruction, not a force or tissue simulation.

Different YouTube performances are not synchronized cameras and therefore
cannot be stereo-triangulated. They can be fitted independently and compared
for anatomical consistency. Literal triangulation requires synchronized views
of the same repetition with calibrated cameras.
