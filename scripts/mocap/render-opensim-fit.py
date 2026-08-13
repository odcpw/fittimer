#!/usr/bin/env python3
"""Render observed and OpenSim-fitted landmarks over the source video."""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np

MARKERS = [
    "Neck",
    "RShoulder",
    "LShoulder",
    "RHip",
    "LHip",
    "midHip",
    "RKnee",
    "LKnee",
    "RAnkle",
    "LAnkle",
    "RElbow",
    "LElbow",
    "RWrist",
    "LWrist",
]
EDGES = [
    ("RShoulder", "LShoulder"),
    ("Neck", "midHip"),
    ("RHip", "LHip"),
    ("RShoulder", "RElbow"),
    ("RElbow", "RWrist"),
    ("LShoulder", "LElbow"),
    ("LElbow", "LWrist"),
    ("RHip", "RKnee"),
    ("RKnee", "RAnkle"),
    ("LHip", "LKnee"),
    ("LKnee", "LAnkle"),
]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--fit", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--head-side", required=True, choices=("left", "right"))
    return parser.parse_args()


def draw_pose(frame, points, color, thickness, radius):
    index = {name: position for position, name in enumerate(MARKERS)}
    rounded = np.rint(points).astype(int)
    for first, second in EDGES:
        cv2.line(
            frame,
            tuple(rounded[index[first]]),
            tuple(rounded[index[second]]),
            color,
            thickness,
            cv2.LINE_AA,
        )
    for point in rounded:
        cv2.circle(frame, tuple(point), radius, color, -1, cv2.LINE_AA)


def main():
    args = parse_args()
    data = np.load(args.fit)
    observed = data["observed"].copy()
    projected = data["projected"].copy()
    capture = cv2.VideoCapture(str(args.video))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    if args.head_side == "right":
        observed[:, :, 0] = width - observed[:, :, 0]
        projected[:, :, 0] = width - projected[:, :, 0]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(
        str(args.output), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height)
    )
    frame_index = 0
    while frame_index < len(projected):
        ok, frame = capture.read()
        if not ok:
            break
        draw_pose(frame, observed[frame_index], (255, 220, 40), 2, 3)
        draw_pose(frame, projected[frame_index], (80, 60, 255), 4, 5)
        cv2.rectangle(frame, (18, 16), (455, 80), (10, 10, 10), -1)
        cv2.putText(
            frame,
            "cyan: measured 2D   red: OpenSim fit",
            (32, 51),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.72,
            (245, 245, 245),
            2,
            cv2.LINE_AA,
        )
        writer.write(frame)
        frame_index += 1
    capture.release()
    writer.release()
    if frame_index != len(projected):
        raise RuntimeError(
            f"Video ended at frame {frame_index}; fit contains {len(projected)} frames"
        )
    print(f"wrote {frame_index} frames to {args.output}")


if __name__ == "__main__":
    main()
