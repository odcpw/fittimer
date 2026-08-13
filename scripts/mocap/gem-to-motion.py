#!/usr/bin/env python3
"""Convert a GEM-X/SOMA result into FitTimer's normalized joint-motion JSON.

Run this with the GEM-X virtual environment; it intentionally adds no Python
dependency to the dependency-free PWA.
"""

import argparse
import json
import math
from pathlib import Path

import torch

from gem.utils.soma_utils.soma_layer import SomaLayer


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="GEM-X hpe_results.pt")
    parser.add_argument("--output", required=True, help="normalized motion JSON")
    parser.add_argument("--fps", required=True, type=float)
    parser.add_argument("--soma-assets", default="inputs/soma_assets")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--loop", action="store_true", help="declare a pre-cut loop; validation will enforce its seam")
    return parser.parse_args()


def finite_xyz(values):
    result = [float(value) for value in values]
    if len(result) != 3 or not all(math.isfinite(value) for value in result):
        raise ValueError("SOMA returned a non-finite XYZ joint")
    return result


def main():
    args = parse_args()
    if args.fps <= 0:
        raise ValueError("--fps must be positive")

    device = torch.device(args.device)
    # GEM-X writes a tensor-only state dictionary, so keep PyTorch's restricted
    # loader enabled rather than accepting arbitrary pickle objects.
    result = torch.load(args.input, map_location=device, weights_only=True)
    body_params = result.get("body_params_global")
    if not isinstance(body_params, dict):
        raise ValueError("GEM-X result has no body_params_global")

    layer = SomaLayer(
        data_root=args.soma_assets,
        low_lod=True,
        device=args.device,
        identity_model_type="mhr",
        mode="warp",
    )
    parameters = {name: value.to(device) for name, value in body_params.items()}
    with torch.inference_mode():
        soma = layer(**parameters)
    joint_tensor = soma["joints"].detach().cpu()
    if joint_tensor.ndim != 3 or joint_tensor.shape[2] != 3:
        raise ValueError(f"unexpected SOMA joint shape: {tuple(joint_tensor.shape)}")

    # The rig file contains an extra synthetic Root before the 77 animated
    # joints. GEM-X is Y-up; FitTimer uses right-handed Z-up coordinates.
    joint_names = [str(name) for name in layer.soma.rig_data["joint_names"]][1:]
    parents = [int(parent) for parent in layer.parents]
    if len(joint_names) != joint_tensor.shape[1] or len(parents) != len(joint_names):
        raise ValueError("SOMA joint names, hierarchy, and output do not agree")

    parent_map = {
        name: None if parents[index] < 0 else joint_names[parents[index]]
        for index, name in enumerate(joint_names)
    }
    converted_frames = []
    for frame in joint_tensor:
        converted = {}
        for name, xyz in zip(joint_names, frame, strict=True):
            x, y, z = finite_xyz(xyz.tolist())
            converted[name] = [x, -z, y]
        converted_frames.append({"joints": converted})

    # Put the lowest observed joint on the ground. Preserve world translation
    # and heading so foot drift remains visible during QA rather than hidden.
    ground = min(position[2] for frame in converted_frames for position in frame["joints"].values())
    for frame in converted_frames:
        for position in frame["joints"].values():
            position[2] -= ground

    motion = {
        "schemaVersion": 1,
        "fps": args.fps,
        "coordinateSystem": {"up": "Z", "forward": "-Y", "units": "meters"},
        "loop": args.loop,
        "joints": joint_names,
        "parents": parent_map,
        "frames": converted_frames,
        "source": {
            "provider": "GEM-X/SOMA",
            "result": str(Path(args.input).resolve()),
            "coordinateTransform": "GEM (X,Y-up,Z) -> FitTimer (X,-Z,Y-up)",
        },
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(motion, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "output": str(output),
        "frames": len(converted_frames),
        "joints": len(joint_names),
        "durationSeconds": (len(converted_frames) - 1) / args.fps,
    }))


if __name__ == "__main__":
    main()
