# OpenSim motion fitting

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
