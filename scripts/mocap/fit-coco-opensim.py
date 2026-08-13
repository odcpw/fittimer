#!/usr/bin/env python3
"""Fit an OpenSim body directly to a monocular COCO-17 pose sequence.

The solver keeps OpenSim's articulated body and coordinate limits authoritative.
It estimates a static perspective camera, then minimizes image-space landmark
error per frame with temporal and out-of-plane regularization. The resulting
motion is useful for visual animation and kinematic inspection; monocular input
does not support kinetic claims.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import opensim as osim
from scipy.optimize import least_squares
from scipy.signal import savgol_filter
from scipy.spatial.transform import Rotation

COCO = {
    "nose": 0,
    "LShoulder": 5,
    "RShoulder": 6,
    "LElbow": 7,
    "RElbow": 8,
    "LWrist": 9,
    "RWrist": 10,
    "LHip": 11,
    "RHip": 12,
    "LKnee": 13,
    "RKnee": 14,
    "LAnkle": 15,
    "RAnkle": 16,
}

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

VARIABLE_COORDS = [
    "hip_flexion_r",
    "hip_flexion_l",
    "hip_adduction_r",
    "hip_adduction_l",
    "hip_rotation_r",
    "hip_rotation_l",
    "knee_angle_r",
    "knee_angle_l",
    "ankle_angle_r",
    "ankle_angle_l",
    "arm_flex_r",
    "arm_flex_l",
    "arm_add_r",
    "arm_add_l",
    "arm_rot_r",
    "arm_rot_l",
    "elbow_flex_r",
    "elbow_flex_l",
    "lumbar_extension",
]

ROOT_DEFAULTS = {
    "pelvis_tilt": math.pi / 2,
    "pelvis_list": 0.0,
    "pelvis_rotation": 0.0,
    "pelvis_tx": 0.0,
    "pelvis_ty": 0.18,
    "pelvis_tz": 0.0,
    "lumbar_bending": 0.0,
    "lumbar_rotation": 0.0,
    "pro_sup_r": 1.0,
    "pro_sup_l": 1.0,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--coco", required=True, type=Path, help="F x 17 x 3 .npy")
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--marker-set", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--focal", type=float, default=1468.6)
    parser.add_argument(
        "--head-side",
        required=True,
        choices=("left", "right"),
        help="Image side containing the head; right-facing inputs are mirrored for fitting.",
    )
    parser.add_argument("--confidence", type=float, default=0.55)
    parser.add_argument("--camera-stride", type=int, default=10)
    parser.add_argument("--camera-rounds", type=int, default=2)
    return parser.parse_args()


def interpolate_and_smooth(coco: np.ndarray, threshold: float) -> np.ndarray:
    result = coco.astype(float, copy=True)
    frames = np.arange(len(result))
    for joint in range(result.shape[1]):
        valid = np.isfinite(result[:, joint, :2]).all(axis=1) & (
            result[:, joint, 2] >= threshold
        )
        if valid.sum() < 2:
            raise ValueError(f"COCO joint {joint} has fewer than two usable observations")
        for axis in (0, 1):
            result[:, joint, axis] = np.interp(
                frames, frames[valid], result[valid, joint, axis]
            )
            window = min(11, len(result) if len(result) % 2 else len(result) - 1)
            if window >= 5:
                result[:, joint, axis] = savgol_filter(
                    result[:, joint, axis], window, 3, mode="interp"
                )
    return result


def canonical_observations(coco: np.ndarray, width: int, head_side: str):
    xy = coco[:, :, :2].copy()
    if head_side == "right":
        xy[:, :, 0] = width - xy[:, :, 0]
    conf = np.clip(coco[:, :, 2], 0.0, 1.0)

    marker_xy = []
    marker_conf = []
    for name in MARKERS:
        if name == "Neck":
            ids = [COCO["RShoulder"], COCO["LShoulder"]]
        elif name == "midHip":
            ids = [COCO["RHip"], COCO["LHip"]]
        else:
            ids = [COCO[name]]
        marker_xy.append(xy[:, ids].mean(axis=1))
        marker_conf.append(conf[:, ids].min(axis=1))
    return np.stack(marker_xy, axis=1), np.stack(marker_conf, axis=1)


def angle(vector: np.ndarray) -> float:
    return float(math.atan2(-vector[1], vector[0]))


def bend_angle(first: np.ndarray, second: np.ndarray) -> float:
    denominator = max(np.linalg.norm(first) * np.linalg.norm(second), 1e-8)
    cosine = float(np.clip(np.dot(first, second) / denominator, -1.0, 1.0))
    return float(math.acos(cosine))


def initial_coordinates(coco_xy: np.ndarray) -> np.ndarray:
    output = np.zeros((len(coco_xy), len(VARIABLE_COORDS)), dtype=float)
    at = {name: index for index, name in enumerate(VARIABLE_COORDS)}
    sides = (("r", "R"), ("l", "L"))
    for frame, points in enumerate(coco_xy):
        for suffix, side in sides:
            shoulder = points[COCO[f"{side}Shoulder"]]
            elbow = points[COCO[f"{side}Elbow"]]
            wrist = points[COCO[f"{side}Wrist"]]
            hip = points[COCO[f"{side}Hip"]]
            knee = points[COCO[f"{side}Knee"]]
            ankle = points[COCO[f"{side}Ankle"]]
            output[frame, at[f"hip_flexion_{suffix}"]] = angle(knee - hip)
            output[frame, at[f"knee_angle_{suffix}"]] = bend_angle(
                knee - hip, ankle - knee
            )
            output[frame, at[f"arm_flex_{suffix}"]] = angle(elbow - shoulder)
            output[frame, at[f"elbow_flex_{suffix}"]] = bend_angle(
                elbow - shoulder, wrist - elbow
            )
    return output


def configure_model(model_path: Path, marker_path: Path, output_path: Path):
    osim.Logger.setLevelString("error")
    model = osim.Model(str(model_path))
    model.updateMarkerSet(osim.MarkerSet(str(marker_path)))

    coordinates = model.updCoordinateSet()
    for name, value in ROOT_DEFAULTS.items():
        coordinates.get(name).setDefaultValue(value)
    for side in ("r", "l"):
        limits = {
            f"arm_flex_{side}": (-math.pi, math.pi),
            f"arm_add_{side}": (-2.0, 2.0),
            f"arm_rot_{side}": (-1.6, 1.6),
        }
        for name, (minimum, maximum) in limits.items():
            coordinate = coordinates.get(name)
            coordinate.setRangeMin(minimum)
            coordinate.setRangeMax(maximum)
            coordinate.set_clamped(True)
            coordinate.setDefaultValue(0.0)
        coordinates.get(f"elbow_flex_{side}").setDefaultValue(0.0)

    model.finalizeConnections()
    model.printToXML(str(output_path))
    state = model.initSystem()
    return model, state


def coordinate_bounds(model: osim.Model):
    lower = []
    upper = []
    for name in VARIABLE_COORDS:
        coordinate = model.getCoordinateSet().get(name)
        lower.append(coordinate.getRangeMin())
        upper.append(coordinate.getRangeMax())
    return np.asarray(lower), np.asarray(upper)


def set_coordinates(model: osim.Model, state, values: np.ndarray):
    coordinate_set = model.updCoordinateSet()
    for name, value in ROOT_DEFAULTS.items():
        coordinate_set.get(name).setValue(state, value, False)
    for name, value in zip(VARIABLE_COORDS, values):
        coordinate_set.get(name).setValue(state, float(value), False)
    model.realizePosition(state)


def marker_positions(model: osim.Model, state) -> np.ndarray:
    marker_set = model.getMarkerSet()
    positions = []
    for name in MARKERS:
        value = marker_set.get(name).getLocationInGround(state)
        positions.append([value.get(0), value.get(1), value.get(2)])
    return np.asarray(positions)


def camera_rotation(delta: np.ndarray) -> np.ndarray:
    base = Rotation.from_euler("x", math.pi).as_matrix()
    return Rotation.from_rotvec(delta).as_matrix() @ base


def project(points: np.ndarray, camera: np.ndarray, focal: float, center: np.ndarray):
    rotation = camera_rotation(camera[:3])
    translation = np.array([camera[3], camera[4], math.exp(camera[5])])
    camera_points = points @ rotation.T + translation
    depth = np.maximum(camera_points[:, 2], 0.2)
    pixels = np.empty((len(points), 2))
    pixels[:, 0] = focal * camera_points[:, 0] / depth + center[0]
    pixels[:, 1] = focal * camera_points[:, 1] / depth + center[1]
    return pixels


def initial_camera(
    model: osim.Model,
    state,
    initial_q: np.ndarray,
    marker_xy: np.ndarray,
    focal: float,
    center: np.ndarray,
) -> np.ndarray:
    segment_pairs = [
        ("RShoulder", "RElbow"),
        ("LShoulder", "LElbow"),
        ("RElbow", "RWrist"),
        ("LElbow", "LWrist"),
        ("RHip", "RKnee"),
        ("LHip", "LKnee"),
        ("RKnee", "RAnkle"),
        ("LKnee", "LAnkle"),
    ]
    set_coordinates(model, state, initial_q[len(initial_q) // 2])
    model_markers = marker_positions(model, state)
    marker_index = {name: index for index, name in enumerate(MARKERS)}
    pixels_per_meter = []
    for first, second in segment_pairs:
        i = marker_index[first]
        j = marker_index[second]
        model_length = np.linalg.norm(model_markers[i] - model_markers[j])
        image_lengths = np.linalg.norm(marker_xy[:, i] - marker_xy[:, j], axis=1)
        pixels_per_meter.append(np.quantile(image_lengths, 0.9) / model_length)
    scale = float(np.median(pixels_per_meter))
    distance = float(np.clip(focal / scale, 1.5, 10.0))
    root = np.median(marker_xy[:, MARKERS.index("midHip")], axis=0)
    tx = (root[0] - center[0]) * distance / focal
    ty = (root[1] - center[1]) * distance / focal + ROOT_DEFAULTS["pelvis_ty"]
    return np.array([0.0, 0.0, 0.0, tx, ty, math.log(distance)])


def fit_camera(
    model,
    state,
    q,
    marker_xy,
    marker_conf,
    camera,
    focal,
    center,
    stride,
):
    indices = np.arange(0, len(q), stride)
    points = []
    for frame in indices:
        set_coordinates(model, state, q[frame])
        points.append(marker_positions(model, state))
    points = np.asarray(points)

    def residual(parameters):
        chunks = []
        for row, frame in enumerate(indices):
            reprojection = project(points[row], parameters, focal, center)
            weight = np.sqrt(np.clip(marker_conf[frame], 0.05, 1.0))[:, None]
            chunks.append(((reprojection - marker_xy[frame]) * weight).ravel())
        chunks.append(parameters[:3] * 8.0)
        return np.concatenate(chunks)

    lower = np.array([-1.2, -1.2, -0.5, -5.0, -5.0, math.log(1.0)])
    upper = np.array([1.2, 1.2, 0.5, 5.0, 5.0, math.log(20.0)])
    return least_squares(
        residual,
        camera,
        bounds=(lower, upper),
        loss="soft_l1",
        f_scale=12.0,
        max_nfev=150,
    ).x


def fit_motion(
    model,
    state,
    initial_q,
    marker_xy,
    marker_conf,
    camera,
    focal,
    center,
):
    lower, upper = coordinate_bounds(model)
    q = np.clip(initial_q.copy(), lower + 1e-5, upper - 1e-5)
    weak_names = {
        "hip_adduction_r",
        "hip_adduction_l",
        "hip_rotation_r",
        "hip_rotation_l",
        "arm_add_r",
        "arm_add_l",
        "arm_rot_r",
        "arm_rot_l",
    }
    weak_indices = [VARIABLE_COORDS.index(name) for name in weak_names]

    for frame in range(len(q)):
        prior = q[frame - 1] if frame else q[frame]

        def residual(values, frame=frame, prior=prior):
            set_coordinates(model, state, values)
            reprojection = project(marker_positions(model, state), camera, focal, center)
            weight = np.sqrt(np.clip(marker_conf[frame], 0.05, 1.0))[:, None]
            image = ((reprojection - marker_xy[frame]) * weight).ravel()
            temporal = (values - prior) * (12.0 if frame else 2.0)
            depth_prior = values[weak_indices] * 7.0
            return np.concatenate((image, temporal, depth_prior))

        q[frame] = least_squares(
            residual,
            q[frame] if frame == 0 else prior,
            bounds=(lower, upper),
            loss="soft_l1",
            f_scale=10.0,
            max_nfev=60,
            xtol=2e-6,
            ftol=2e-6,
            gtol=2e-6,
        ).x
    return q


def write_motion(path: Path, model, q: np.ndarray, fps: float):
    coordinates = model.getCoordinateSet()
    names = [coordinates.get(i).getName() for i in range(coordinates.getSize())]
    rows = []
    state = model.initSystem()
    for values in q:
        set_coordinates(model, state, values)
        row = []
        for name in names:
            value = coordinates.get(name).getValue(state)
            if name not in {"pelvis_tx", "pelvis_ty", "pelvis_tz"}:
                value = math.degrees(value)
            row.append(value)
        rows.append(row)
    with path.open("w", encoding="utf-8") as stream:
        stream.write(f"name {path.stem}\n")
        stream.write(f"nRows={len(rows)}\n")
        stream.write(f"nColumns={len(names) + 1}\n")
        stream.write("inDegrees=yes\nendheader\n")
        stream.write("time\t" + "\t".join(names) + "\n")
        for frame, row in enumerate(rows):
            values = "\t".join(f"{value:.9g}" for value in row)
            stream.write(f"{frame / fps:.9g}\t{values}\n")


def write_trc(path: Path, positions: np.ndarray, fps: float):
    with path.open("w", encoding="utf-8") as stream:
        stream.write(f"PathFileType\t4\t(X/Y/Z)\t{path.name}\n")
        stream.write(
            "DataRate\tCameraRate\tNumFrames\tNumMarkers\tUnits\t"
            "OrigDataRate\tOrigDataStartFrame\tOrigNumFrames\n"
        )
        stream.write(
            f"{fps:g}\t{fps:g}\t{len(positions)}\t{len(MARKERS)}\tm\t"
            f"{fps:g}\t1\t{len(positions)}\n"
        )
        stream.write("Frame#\tTime\t" + "\t\t\t".join(MARKERS) + "\t\t\n")
        axes = []
        for index in range(1, len(MARKERS) + 1):
            axes.extend((f"X{index}", f"Y{index}", f"Z{index}"))
        stream.write("\t\t" + "\t".join(axes) + "\n")
        for frame, points in enumerate(positions):
            values = "\t".join(f"{value:.9g}" for value in points.ravel())
            stream.write(f"{frame + 1}\t{frame / fps:.9g}\t{values}\n")


def evaluate(model, q, marker_xy, marker_conf, camera, focal, center):
    state = model.initSystem()
    positions = []
    projected = []
    errors = []
    for frame, values in enumerate(q):
        set_coordinates(model, state, values)
        points = marker_positions(model, state)
        pixels = project(points, camera, focal, center)
        positions.append(points)
        projected.append(pixels)
        errors.extend(
            np.linalg.norm(pixels - marker_xy[frame], axis=1)[marker_conf[frame] >= 0.55]
        )
    errors = np.asarray(errors)
    return np.asarray(positions), np.asarray(projected), {
        "meanPixels": float(errors.mean()),
        "rmsPixels": float(np.sqrt(np.mean(errors**2))),
        "p95Pixels": float(np.quantile(errors, 0.95)),
        "maxPixels": float(errors.max()),
    }


def write_viewer_motion(path: Path, positions: np.ndarray, fps: float, source_id: str, metrics):
    edges = [
        ["RShoulder", "LShoulder"],
        ["Neck", "midHip"],
        ["RHip", "LHip"],
        ["RShoulder", "RElbow"],
        ["RElbow", "RWrist"],
        ["LShoulder", "LElbow"],
        ["LElbow", "LWrist"],
        ["RHip", "RKnee"],
        ["RKnee", "RAnkle"],
        ["LHip", "LKnee"],
        ["LKnee", "LAnkle"],
    ]
    payload = {
        "schemaVersion": 1,
        "sourceId": source_id,
        "model": "LaiUhlrich2022 OpenSim",
        "fps": fps,
        "markerNames": MARKERS,
        "edges": edges,
        "frames": np.round(positions, 6).tolist(),
        "reprojection": metrics,
    }
    path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    raw = np.load(args.coco)
    if raw.ndim != 3 or raw.shape[1:] != (17, 3):
        raise ValueError(f"Expected F x 17 x 3 COCO input, received {raw.shape}")
    smoothed = interpolate_and_smooth(raw, args.confidence)
    coco_xy = smoothed[:, :, :2].copy()
    if args.head_side == "right":
        coco_xy[:, :, 0] = args.width - coco_xy[:, :, 0]
    marker_xy, marker_conf = canonical_observations(
        smoothed, args.width, args.head_side
    )

    model_path = args.output / "deadbug-fitted.osim"
    model, state = configure_model(args.model, args.marker_set, model_path)
    initial_q = initial_coordinates(coco_xy)
    center = np.array([args.width / 2, args.height / 2], dtype=float)
    camera = initial_camera(
        model, state, initial_q, marker_xy, args.focal, center
    )
    q = initial_q
    for _ in range(args.camera_rounds):
        camera = fit_camera(
            model,
            state,
            q,
            marker_xy,
            marker_conf,
            camera,
            args.focal,
            center,
            args.camera_stride,
        )
        q = fit_motion(
            model,
            state,
            q,
            marker_xy,
            marker_conf,
            camera,
            args.focal,
            center,
        )

    positions, projected, metrics = evaluate(
        model, q, marker_xy, marker_conf, camera, args.focal, center
    )
    motion_path = args.output / "deadbug-fitted.mot"
    trc_path = args.output / "deadbug-fitted.trc"
    write_motion(motion_path, model, q, args.fps)
    write_trc(trc_path, positions, args.fps)
    viewer_path = args.output / "viewer-motion.json"
    write_viewer_motion(viewer_path, positions, args.fps, args.source_id, metrics)
    np.savez_compressed(
        args.output / "fit-data.npz",
        coordinates=q,
        observed=marker_xy,
        confidence=marker_conf,
        projected=projected,
        markers3d=positions,
        camera=camera,
    )

    coordinate_ranges = {}
    for name in (
        "hip_flexion_r",
        "hip_flexion_l",
        "knee_angle_r",
        "knee_angle_l",
        "arm_flex_r",
        "arm_flex_l",
        "elbow_flex_r",
        "elbow_flex_l",
    ):
        values = np.degrees(q[:, VARIABLE_COORDS.index(name)])
        coordinate_ranges[name] = {
            "p05Degrees": float(np.quantile(values, 0.05)),
            "p95Degrees": float(np.quantile(values, 0.95)),
        }
    midhip_y = positions[:, MARKERS.index("midHip"), 1]
    shoulder_y = positions[
        :, [MARKERS.index("RShoulder"), MARKERS.index("LShoulder")], 1
    ].mean(axis=1)
    report = {
        "schemaVersion": 1,
        "sourceId": args.source_id,
        "method": "OpenSim articulated-body 2D perspective inverse kinematics",
        "frames": len(q),
        "fps": args.fps,
        "inputMeanConfidence": float(np.clip(raw[..., 2], 0, 1).mean()),
        "camera": {
            "focalPixels": args.focal,
            "rotationVector": camera[:3].tolist(),
            "translationMeters": [
                float(camera[3]),
                float(camera[4]),
                float(math.exp(camera[5])),
            ],
        },
        "reprojection": metrics,
        "support": {
            "midHipHeightMeanMeters": float(midhip_y.mean()),
            "midHipHeightStdMeters": float(midhip_y.std()),
            "shoulderCenterHeightMeanMeters": float(shoulder_y.mean()),
            "shoulderCenterHeightStdMeters": float(shoulder_y.std()),
        },
        "coordinateRanges": coordinate_ranges,
        "outputs": {
            "model": model_path.name,
            "motion": motion_path.name,
            "markers": trc_path.name,
            "fitData": "fit-data.npz",
            "viewerMotion": viewer_path.name,
        },
        "limitations": [
            "Single-view depth is constrained by the OpenSim body, camera fit, priors, and temporal continuity rather than directly observed.",
            "TRC markers are generated from the fitted OpenSim motion; primary accuracy evidence is 2D reprojection error.",
            "The output is kinematic and must not be interpreted as joint loading, muscle force, or clinical measurement.",
        ],
    }
    (args.output / "report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
