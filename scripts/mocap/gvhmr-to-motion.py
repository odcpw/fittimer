#!/usr/bin/env python3
"""Build silhouette-faithful 2.5D motion from GVHMR's 2D and 3D outputs.

The image-plane coordinates are authoritative because monocular HMR can invent
an attractive but wrong depth solution. Recovered depth is retained only as a
bounded hint for a useful Three.js/Blender side view.
"""

import argparse
import json
import math
from pathlib import Path

import torch

from hmr4d.utils.smplx_utils import make_smplx


COCO_NAMES = [
    "nose", "leftEye", "rightEye", "leftEar", "rightEar",
    "leftShoulder", "rightShoulder", "leftElbow", "rightElbow",
    "leftWrist", "rightWrist", "leftHip", "rightHip", "leftKnee",
    "rightKnee", "leftAnkle", "rightAnkle",
]
BODY_NAMES = [
    "pelvis", "neck", "nose",
    "leftShoulder", "leftElbow", "leftWrist",
    "rightShoulder", "rightElbow", "rightWrist",
    "leftHip", "leftKnee", "leftAnkle",
    "rightHip", "rightKnee", "rightAnkle",
]
PARENTS = {
    "pelvis": None,
    "neck": "pelvis",
    "nose": "neck",
    "leftShoulder": "neck",
    "leftElbow": "leftShoulder",
    "leftWrist": "leftElbow",
    "rightShoulder": "neck",
    "rightElbow": "rightShoulder",
    "rightWrist": "rightElbow",
    "leftHip": "pelvis",
    "leftKnee": "leftHip",
    "leftAnkle": "leftKnee",
    "rightHip": "pelvis",
    "rightKnee": "rightHip",
    "rightAnkle": "rightKnee",
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vitpose", required=True)
    parser.add_argument("--hmr4d-results", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--fps", type=float, required=True)
    parser.add_argument("--torso-meters", type=float, default=0.55)
    parser.add_argument("--depth-weight", type=float, default=0.35)
    parser.add_argument("--loop", action="store_true")
    return parser.parse_args()


def midpoint(points, left, right):
    return (points[:, left] + points[:, right]) * 0.5


def named_body(points):
    named = {name: points[:, index] for index, name in enumerate(COCO_NAMES)}
    named["pelvis"] = midpoint(points, 11, 12)
    named["neck"] = midpoint(points, 5, 6)
    return {name: named[name] for name in BODY_NAMES}


def median_positive(values, label):
    values = values[torch.isfinite(values) & (values > 1e-6)]
    if values.numel() == 0:
        raise ValueError(f"cannot measure {label}")
    return float(values.median())


def main():
    args = parse_args()
    if args.fps <= 0 or args.torso_meters <= 0:
        raise ValueError("fps and torso size must be positive")
    if not 0 <= args.depth_weight <= 1:
        raise ValueError("depth weight must be between zero and one")

    pose2d = torch.load(args.vitpose, map_location="cpu", weights_only=True).float()
    result = torch.load(args.hmr4d_results, map_location="cpu", weights_only=True)
    if pose2d.ndim != 3 or pose2d.shape[1:] != (17, 3):
        raise ValueError(f"unexpected VitPose shape: {tuple(pose2d.shape)}")
    parameters = result.get("smpl_params_incam")
    if not isinstance(parameters, dict):
        raise ValueError("GVHMR result has no smpl_params_incam")

    lite_model = make_smplx("supermotion_v437coco17")
    with torch.inference_mode():
        _vertices, pose3d = lite_model(**parameters)
    pose3d = pose3d.float().cpu()
    if pose3d.shape != pose2d[:, :, :3].shape:
        raise ValueError(f"2D/3D frame or joint mismatch: {tuple(pose2d.shape)} vs {tuple(pose3d.shape)}")

    body2d = named_body(pose2d[:, :, :2])
    body3d = named_body(pose3d)
    torso_pixels = torch.linalg.vector_norm(body2d["neck"] - body2d["pelvis"], dim=-1)
    meters_per_pixel = args.torso_meters / median_positive(torso_pixels, "2D torso")
    torso_3d = torch.linalg.vector_norm(body3d["neck"] - body3d["pelvis"], dim=-1)
    depth_scale = args.torso_meters / median_positive(torso_3d, "3D torso")

    first_pelvis = body2d["pelvis"][0]
    converted = []
    minimum_height = math.inf
    for frame_index in range(pose2d.shape[0]):
        joints = {}
        pelvis_depth = body3d["pelvis"][frame_index, 2]
        for name in BODY_NAMES:
            image_xy = body2d[name][frame_index]
            inferred_depth = body3d[name][frame_index, 2] - pelvis_depth
            xyz = [
                float((image_xy[0] - first_pelvis[0]) * meters_per_pixel),
                float(-inferred_depth * depth_scale * args.depth_weight),
                float(-(image_xy[1] - first_pelvis[1]) * meters_per_pixel),
            ]
            if not all(math.isfinite(value) for value in xyz):
                raise ValueError(f"non-finite joint at frame {frame_index}: {name}")
            minimum_height = min(minimum_height, xyz[2])
            joints[name] = xyz
        converted.append({"joints": joints})

    for frame in converted:
        for position in frame["joints"].values():
            position[2] -= minimum_height

    confidence = pose2d[:, :, 2]
    motion = {
        "schemaVersion": 1,
        "fps": args.fps,
        "coordinateSystem": {"up": "Z", "forward": "-Y", "units": "meters"},
        "loop": args.loop,
        "joints": BODY_NAMES,
        "parents": PARENTS,
        "frames": converted,
        "source": {
            "provider": "GVHMR VitPose + bounded GVHMR depth",
            "vitpose": str(Path(args.vitpose).resolve()),
            "hmr4dResult": str(Path(args.hmr4d_results).resolve()),
            "mode": "silhouette-first-2.5d",
            "depthWeight": args.depth_weight,
            "mean2dConfidence": float(confidence.mean()),
            "trackedFrameFraction": float((confidence.max(dim=1).values > 0.5).float().mean()),
        },
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(motion, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "output": str(output),
        "frames": len(converted),
        "joints": len(BODY_NAMES),
        "metersPerPixel": meters_per_pixel,
        "mean2dConfidence": motion["source"]["mean2dConfidence"],
        "trackedFrameFraction": motion["source"]["trackedFrameFraction"],
    }))


if __name__ == "__main__":
    main()
