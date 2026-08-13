#!/usr/bin/env python3
"""Capture a video's complete RTMW3D-X WholeBody3D observation stream.

This is deliberately an observation step, not a biomechanical fit. It keeps
all 133 estimated landmarks, their per-frame confidence, the source-image 2D
locations, and RTMW3D's direct 3D output so later stages can choose clean reps
without throwing away hand, foot, or face evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

KEYPOINT_PARTS = {
    "body": [0, 17],
    "feet": [17, 23],
    "face": [23, 91],
    "leftHand": [91, 112],
    "rightHand": [112, 133],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run RTMW3D-X on every frame of a retained source video."
    )
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--rtmlib-root", required=True, type=Path)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument(
        "--preview",
        type=Path,
        help="Optional MP4 path for a 2D landmark overlay review render.",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def choose_person(scores: np.ndarray) -> int:
    """Prefer the detection with the strongest movement-relevant evidence."""
    movement_scores = np.concatenate(
        (
            scores[:, KEYPOINT_PARTS["body"][0] : KEYPOINT_PARTS["feet"][1]],
            scores[:, KEYPOINT_PARTS["leftHand"][0] : KEYPOINT_PARTS["rightHand"][1]],
        ),
        axis=1,
    )
    return int(np.median(movement_scores, axis=1).argmax())


def main() -> None:
    args = parse_args()
    if not args.video.is_file():
        raise FileNotFoundError(args.video)
    if not (args.rtmlib_root / "rtmlib").is_dir():
        raise FileNotFoundError(f"rtmlib package not found under {args.rtmlib_root}")

    sys.path.insert(0, str(args.rtmlib_root))
    from rtmlib import Wholebody3d, draw_skeleton

    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {args.video}")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    declared_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if not np.isfinite(fps) or fps <= 0 or width <= 0 or height <= 0:
        raise ValueError("Source video has invalid FPS or dimensions")

    writer = None
    if args.preview:
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        writer = cv2.VideoWriter(
            str(args.preview), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
        )
        if not writer.isOpened():
            raise RuntimeError(f"Could not open preview writer at {args.preview}")

    model = Wholebody3d(backend="onnxruntime", device=args.device)
    provider = model.pose_model.session.get_providers()[0]
    if args.device.startswith("cuda") and provider != "CUDAExecutionProvider":
        raise RuntimeError(f"CUDA requested but RTMW3D selected {provider}")

    direct_3d = []
    image_2d = []
    simcc_3d = []
    confidence = []
    person_counts = []
    started = time.monotonic()
    frame_number = 0

    while True:
        ok, frame = capture.read()
        if not ok:
            break
        k3, scores, raw_simcc, k2 = model(frame)
        if k3.ndim != 3 or k3.shape[1:] != (133, 3):
            raise ValueError(f"Unexpected RTMW3D result shape {k3.shape}")
        person = choose_person(scores)
        direct_3d.append(k3[person])
        image_2d.append(k2[person])
        simcc_3d.append(raw_simcc[person])
        confidence.append(scores[person])
        person_counts.append(len(k3))

        if writer is not None:
            overlay = draw_skeleton(
                frame.copy(),
                k2[person : person + 1],
                scores[person : person + 1],
                kpt_thr=0.35,
                openpose_skeleton=False,
            )
            writer.write(overlay)
        frame_number += 1
        if frame_number % 100 == 0:
            elapsed = time.monotonic() - started
            print(
                json.dumps(
                    {
                        "processedFrames": frame_number,
                        "declaredFrames": declared_frames,
                        "framesPerSecond": round(frame_number / elapsed, 2),
                    }
                ),
                flush=True,
            )

    capture.release()
    if writer is not None:
        writer.release()
    if frame_number == 0:
        raise RuntimeError("Source video yielded no frames")

    direct_3d = np.asarray(direct_3d, dtype=np.float32)
    image_2d = np.asarray(image_2d, dtype=np.float32)
    simcc_3d = np.asarray(simcc_3d, dtype=np.float32)
    confidence = np.asarray(confidence, dtype=np.float32)
    person_counts = np.asarray(person_counts, dtype=np.uint8)
    if not all(
        np.isfinite(value).all()
        for value in (direct_3d, image_2d, simcc_3d, confidence)
    ):
        raise ValueError("RTMW3D produced a non-finite observation")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    observations_path = args.output_dir / "observations.npz"
    np.savez_compressed(
        observations_path,
        direct_3d=direct_3d,
        image_2d=image_2d,
        simcc_3d=simcc_3d,
        confidence=confidence,
        person_counts=person_counts,
    )

    movement_indices = np.r_[0:23, 91:133]
    movement_confidence = confidence[:, movement_indices]
    metadata = {
        "schemaVersion": 1,
        "kind": "rtmw3dWholeBodyObservation",
        "sourceId": args.source_id,
        "sourceVideo": str(args.video.resolve()),
        "sourceSha256": sha256(args.video),
        "model": "RTMW3D-X cocktail14 384x288",
        "modelLandmarks": 133,
        "keypointParts": KEYPOINT_PARTS,
        "fps": fps,
        "width": width,
        "height": height,
        "declaredFrames": declared_frames,
        "processedFrames": frame_number,
        "durationSeconds": frame_number / fps,
        "provider": provider,
        "peoplePerFrame": {
            "minimum": int(person_counts.min()),
            "maximum": int(person_counts.max()),
        },
        "confidence": {
            "allMedian": float(np.median(confidence)),
            "movementMedian": float(np.median(movement_confidence)),
            "movementP05": float(np.quantile(movement_confidence, 0.05)),
            "bodyMedian": float(np.median(confidence[:, 0:17])),
            "feetMedian": float(np.median(confidence[:, 17:23])),
            "leftHandMedian": float(np.median(confidence[:, 91:112])),
            "rightHandMedian": float(np.median(confidence[:, 112:133])),
        },
        "artifacts": {
            "observations": observations_path.name,
            "preview": str(args.preview.resolve()) if args.preview else None,
        },
        "elapsedSeconds": time.monotonic() - started,
    }
    metadata_path = args.output_dir / "capture.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
