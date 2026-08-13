#!/usr/bin/env python3
"""Build a smooth, phase-safe browser loop directly from RTMW3D-X joints."""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from pathlib import Path

import numpy as np

BODY_CHAINS = [
    [5, 7, 9],
    [6, 8, 10],
    [11, 13, 15],
    [12, 14, 16],
]

HAND_CHAINS = [
    [91, 92, 93, 94, 95],
    [91, 96, 97, 98, 99],
    [91, 100, 101, 102, 103],
    [91, 104, 105, 106, 107],
    [91, 108, 109, 110, 111],
    [112, 113, 114, 115, 116],
    [112, 117, 118, 119, 120],
    [112, 121, 122, 123, 124],
    [112, 125, 126, 127, 128],
    [112, 129, 130, 131, 132],
]

FOOT_CHAINS = [
    [15, 17],
    [15, 18],
    [15, 19],
    [16, 20],
    [16, 21],
    [16, 22],
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--observations", required=True, type=Path)
    parser.add_argument("--capture", required=True, type=Path)
    parser.add_argument("--rtmlib-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--start-frame", required=True, type=int)
    parser.add_argument("--end-frame", required=True, type=int)
    parser.add_argument("--duration", default=15.0, type=float)
    parser.add_argument("--output-fps", default=30.0, type=float)
    parser.add_argument("--torso-meters", default=0.52, type=float)
    parser.add_argument("--confidence-threshold", default=0.35, type=float)
    return parser.parse_args()


def repair_low_confidence(
    positions: np.ndarray, confidence: np.ndarray, threshold: float
) -> tuple[np.ndarray, int]:
    repaired = positions.copy()
    timeline = np.arange(len(repaired))
    repair_count = 0
    for joint in range(repaired.shape[1]):
        valid = confidence[:, joint] >= threshold
        if valid.all():
            continue
        if valid.sum() < 2:
            raise ValueError(f"Joint {joint} has fewer than two credible observations")
        repair_count += int((~valid).sum())
        for axis in range(3):
            repaired[:, joint, axis] = np.interp(
                timeline,
                timeline[valid],
                repaired[valid, joint, axis],
            )
    return repaired, repair_count


def smooth_reflect(values: np.ndarray, radius: int) -> np.ndarray:
    if radius < 1:
        return values.copy()
    window = np.hanning(radius * 2 + 3)[1:-1]
    window /= window.sum()
    padded = np.pad(values, ((radius, radius), (0, 0), (0, 0)), mode="reflect")
    return sum(
        weight * padded[index : index + len(values)]
        for index, weight in enumerate(window)
    )


def circular_smooth(values: np.ndarray, radius: int) -> np.ndarray:
    if radius < 1:
        return values.copy()
    window = np.hanning(radius * 2 + 3)[1:-1]
    window /= window.sum()
    padded = np.concatenate((values[-radius:], values, values[:radius]), axis=0)
    return sum(
        weight * padded[index : index + len(values)]
        for index, weight in enumerate(window)
    )


def resample(values: np.ndarray, frames: int) -> np.ndarray:
    source_t = np.linspace(0.0, 1.0, len(values))
    output_t = np.linspace(0.0, 1.0, frames, endpoint=False)
    flattened = values.reshape(len(values), -1)
    result = np.empty((frames, flattened.shape[1]), dtype=np.float64)
    for column in range(flattened.shape[1]):
        result[:, column] = np.interp(output_t, source_t, flattened[:, column])
    return result.reshape(frames, values.shape[1], values.shape[2])


def segment_targets(values: np.ndarray) -> dict[tuple[int, int], float]:
    targets = {}
    for chain in BODY_CHAINS + HAND_CHAINS + FOOT_CHAINS:
        for parent, child in itertools.pairwise(chain):
            lengths = np.linalg.norm(values[:, child] - values[:, parent], axis=1)
            lower, upper = np.quantile(lengths, [0.15, 0.85])
            credible = lengths[(lengths >= lower) & (lengths <= upper)]
            targets[(parent, child)] = float(np.median(credible))
    return targets


def stabilize_articulated_lengths(
    values: np.ndarray, targets: dict[tuple[int, int], float]
) -> np.ndarray:
    """Keep RTMW3D directions but enforce one coherent articulated skeleton."""
    result = values.copy()
    result[:, 91] = result[:, 9]
    result[:, 112] = result[:, 10]
    for chain in BODY_CHAINS + HAND_CHAINS + FOOT_CHAINS:
        for parent, child in itertools.pairwise(chain):
            direction = values[:, child] - values[:, parent]
            length = np.linalg.norm(direction, axis=1, keepdims=True)
            direction /= np.maximum(length, 1e-8)
            result[:, child] = result[:, parent] + direction * targets[(parent, child)]
    return result


def direct_world_coordinates(raw_3d: np.ndarray, torso_meters: float) -> np.ndarray:
    """Normalize RTMW3D crop coordinates without solving another body model."""
    positions = raw_3d.astype(np.float64, copy=True)
    xy_scale = 2.1744869 / (384.0 / 2.0)
    positions[..., :2] *= xy_scale
    pelvis = (positions[:, 11] + positions[:, 12]) / 2.0
    shoulders = (positions[:, 5] + positions[:, 6]) / 2.0
    torso = np.linalg.norm(shoulders - pelvis, axis=1)
    credible = torso[
        (torso > np.quantile(torso, 0.05)) & (torso < np.quantile(torso, 0.95))
    ]
    target_torso = float(np.median(credible))
    if not np.isfinite(target_torso) or target_torso <= 0:
        raise ValueError("Could not establish a stable RTMW3D torso scale")

    positions -= pelvis[:, None]
    scale = (target_torso / torso)[:, None, None]
    scale = smooth_reflect(scale, 8)
    positions *= scale
    positions *= torso_meters / target_torso

    # RTMW3D uses image X/Y and camera depth. Three.js uses Y-up.
    positions = positions[..., [0, 1, 2]]
    positions[..., 1] *= -1
    positions[..., 2] *= -1
    positions[..., 1] += 0.14
    return positions


def main() -> None:
    args = parse_args()
    try:
        capture = json.loads(  # ubs:ignore — invalid JSON is caught and re-raised below
            args.capture.read_text(encoding="utf-8")
        )
    except json.JSONDecodeError as error:
        raise ValueError(
            f"Capture metadata is not valid JSON: {args.capture}"
        ) from error
    observations = np.load(args.observations)
    raw_3d = observations["direct_3d"]
    confidence = observations["confidence"]
    if raw_3d.shape != (capture["processedFrames"], 133, 3):
        raise ValueError(f"Unexpected observation shape {raw_3d.shape}")
    if not 0 <= args.start_frame < args.end_frame < len(raw_3d):
        raise ValueError("Selected frame range is outside the capture")
    if args.duration <= 0 or args.output_fps <= 0 or args.torso_meters <= 0:
        raise ValueError("Duration, FPS, and torso size must be positive")

    sys.path.insert(0, str(args.rtmlib_root))
    from rtmlib.visualization.skeleton.coco133 import coco133

    names = [coco133["keypoint_info"][index]["name"] for index in range(133)]
    name_to_index = {name: index for index, name in enumerate(names)}
    edges = [
        [name_to_index[edge["link"][0]], name_to_index[edge["link"][1]]]
        for edge in coco133["skeleton_info"].values()
    ]
    edges.extend(([9, 91], [10, 112]))

    positions = direct_world_coordinates(raw_3d, args.torso_meters)
    positions, repair_count = repair_low_confidence(
        positions, confidence, args.confidence_threshold
    )
    positions = smooth_reflect(positions, 7)
    selected = positions[args.start_frame : args.end_frame + 1].copy()
    targets = segment_targets(selected)
    source_seam = selected[-1] - selected[0]
    blend = np.linspace(0.0, 1.0, len(selected))[:, None, None]
    selected -= blend * source_seam

    output_frames = round(args.duration * args.output_fps)
    cycle = resample(selected, output_frames)
    cycle = circular_smooth(cycle, 3)
    cycle = stabilize_articulated_lengths(cycle, targets)
    movement = np.r_[0:23, 91:133]
    floor_height = float(cycle[:, movement, 1].min())
    cycle[..., 1] += 0.025 - floor_height
    output_seam = cycle[0] - cycle[-1]

    selected_confidence = confidence[args.start_frame : args.end_frame + 1]
    payload = {
        "schemaVersion": 1,
        "kind": "rtmw3dDirectMotion",
        "sourceId": capture["sourceId"],
        "sourceSha256": capture["sourceSha256"],
        "model": capture["model"],
        "modelLandmarks": 133,
        "coordinateSystem": "root-relative direct RTMW3D, X-right/Y-up/Z-camera",
        "fps": args.output_fps,
        "durationSeconds": args.duration,
        "keypointNames": names,
        "keypointParts": capture["keypointParts"],
        "edges": edges,
        "frames": np.round(cycle, 5).tolist(),
        "selection": {
            "sourceStartFrame": args.start_frame,
            "sourceEndFrame": args.end_frame,
            "sourceStartSeconds": args.start_frame / capture["fps"],
            "sourceEndSeconds": args.end_frame / capture["fps"],
            "sourceDurationSeconds": (args.end_frame - args.start_frame)
            / capture["fps"],
            "outputFrames": output_frames,
            "method": "phase-aligned bilateral repetition window, time-stretched to 15 seconds",
        },
        "filter": {
            "confidenceThreshold": args.confidence_threshold,
            "repairedObservations": repair_count,
            "reflectiveSmoothingFrames": 15,
            "periodicSeamSmoothingFrames": 7,
            "perFrameTorsoScaleStabilized": True,
            "articulatedSegmentLengthsStabilized": True,
            "groundClearanceMeters": 0.025,
            "biomechanicalFit": False,
        },
        "quality": {
            "selectedMovementConfidenceMedian": float(
                np.median(selected_confidence[:, movement])
            ),
            "selectedBodyConfidenceMedian": float(
                np.median(selected_confidence[:, 0:17])
            ),
            "selectedFeetConfidenceMedian": float(
                np.median(selected_confidence[:, 17:23])
            ),
            "selectedLeftHandConfidenceMedian": float(
                np.median(selected_confidence[:, 91:112])
            ),
            "selectedRightHandConfidenceMedian": float(
                np.median(selected_confidence[:, 112:133])
            ),
            "sourceSeamRmsMeters": float(np.sqrt(np.mean(source_seam[movement] ** 2))),
            "sourceSeamMaxMeters": float(
                np.linalg.norm(source_seam[movement], axis=1).max()
            ),
            "outputSeamRmsMeters": float(np.sqrt(np.mean(output_seam[movement] ** 2))),
            "outputSeamMaxMeters": float(
                np.linalg.norm(output_seam[movement], axis=1).max()
            ),
            "minimumMovementHeightMeters": float(cycle[:, movement, 1].min()),
            "articulatedSegments": len(targets),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    report = {
        key: payload[key]
        for key in (
            "kind",
            "sourceId",
            "model",
            "fps",
            "durationSeconds",
            "selection",
            "filter",
            "quality",
        )
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
