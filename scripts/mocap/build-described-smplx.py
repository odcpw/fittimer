#!/usr/bin/env python3
"""Build a stable SMPL-X exercise loop from a written movement specification.

The specification defines anatomical invariants, endpoint directions, and a
timeline. A small constrained IK solve creates only the three described key
poses; smooth rotation interpolation supplies the full animation. No video,
pose detector, OpenSim model, or per-frame inverse kinematics is involved.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from itertools import pairwise
from pathlib import Path

import numpy as np
import torch
from pytorch3d.transforms import axis_angle_to_matrix, matrix_to_axis_angle
from scipy.spatial.transform import Rotation
from smplx import SMPLX
from smplx.lbs import batch_rigid_transform

SUPINE_ORIENTATION = np.asarray(
    ((0.0, -1.0, 0.0), (0.0, 0.0, 1.0), (-1.0, 0.0, 0.0)),
    dtype=np.float32,
)
OPTIMIZED_JOINTS = (1, 2, 4, 5, 7, 8, 16, 17, 18, 19)
TARGET_JOINTS = {
    "leftElbow": 18,
    "leftWrist": 20,
    "rightElbow": 19,
    "rightWrist": 21,
    "leftKnee": 4,
    "leftAnkle": 7,
    "leftFoot": 10,
    "rightKnee": 5,
    "rightAnkle": 8,
    "rightFoot": 11,
}
LIMBS = {
    "leftArm": (16, 18, 20),
    "rightArm": (17, 19, 21),
    "leftLeg": (1, 4, 7, 10),
    "rightLeg": (2, 5, 8, 11),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--iterations", type=int, default=1200)
    parser.add_argument("--learning-rate", type=float, default=0.04)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--export-vertices", action="store_true")
    return parser.parse_args()


def unit(values: list[float]) -> np.ndarray:
    vector = np.asarray(values, dtype=np.float32)
    length = float(np.linalg.norm(vector))
    if vector.shape != (3,) or length < 1e-6:
        raise ValueError("Every described direction must be a nonzero 3-vector")
    return vector / length


def load_spec(path: Path) -> dict:
    try:
        spec = json.JSONDecoder().decode(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"spec contains invalid JSON: {error}") from error
    if (
        spec.get("kind") != "describedExerciseMotion"
        or spec.get("movementId") != "dead-bug"
        or float(spec.get("fps", 0)) <= 0
        or float(spec.get("durationSeconds", 0)) <= 0
    ):
        raise ValueError("spec is not a valid described dead-bug motion")
    keyframes = spec.get("keyframes", [])
    if (
        len(keyframes) < 2
        or keyframes[0]["timeSeconds"] != 0
        or keyframes[-1]["timeSeconds"] != spec["durationSeconds"]
    ):
        raise ValueError("keyframes must span the complete described duration")
    if any(
        left["timeSeconds"] >= right["timeSeconds"]
        for left, right in pairwise(keyframes)
    ):
        raise ValueError("keyframe times must be strictly increasing")
    return spec


def shaped_rest(model: SMPLX, betas: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    vertices = model.v_template + torch.einsum(
        "bl,vcl->bvc", betas, model.shapedirs[:, :, : betas.shape[1]]
    )
    joints = torch.einsum("jv,bvc->bjc", model.J_regressor, vertices)
    return vertices, joints


def segment_length(rest: np.ndarray, first: int, second: int) -> float:
    return float(np.linalg.norm(rest[second] - rest[first]))


def endpoint_in_native_lane(
    origin: np.ndarray,
    direction: np.ndarray,
    length: float,
    lane: float,
) -> np.ndarray:
    """Place a limb endpoint without collapsing its native lateral lane."""
    sagittal_direction = direction.copy()
    sagittal_direction[2] = 0
    sagittal_direction = unit(sagittal_direction.tolist())
    lateral_distance = lane - float(origin[2])
    if abs(lateral_distance) >= length:
        raise ValueError("native lateral lane exceeds the connected segment length")
    sagittal_length = float(np.sqrt(length**2 - lateral_distance**2))
    endpoint = origin + sagittal_direction * sagittal_length
    endpoint[2] = lane
    return endpoint


def described_targets(
    spec: dict, rest: np.ndarray, base_world: np.ndarray, pose_name: str
) -> dict[str, np.ndarray]:
    tabletop = spec["targets"]["tabletop"]
    extended = spec["targets"]["extended"]
    moving = {
        "tabletop": set(),
        "left-arm-right-leg": {"leftArm", "rightLeg"},
        "right-arm-left-leg": {"rightArm", "leftLeg"},
    }
    if pose_name not in moving:
        raise ValueError(f"Unknown described pose: {pose_name}")

    targets: dict[str, np.ndarray] = {}
    for side in ("left", "right"):
        arm_name = f"{side}Arm"
        shoulder, elbow, wrist = LIMBS[arm_name]
        arm_description = extended if arm_name in moving[pose_name] else tabletop
        arm_direction = unit(arm_description["armDirection"])
        upper = segment_length(rest, shoulder, elbow)
        lower = segment_length(rest, elbow, wrist)
        targets[f"{side}Elbow"] = base_world[shoulder] + arm_direction * upper
        targets[f"{side}Wrist"] = base_world[shoulder] + arm_direction * (
            upper + lower
        )

        leg_name = f"{side}Leg"
        hip, knee, ankle, foot = LIMBS[leg_name]
        leg_description = extended if leg_name in moving[pose_name] else tabletop
        thigh_direction = unit(leg_description["thighDirection"])
        shin_direction = unit(leg_description["shinDirection"])
        foot_direction = unit(leg_description["footDirection"])
        thigh = segment_length(rest, hip, knee)
        shin = segment_length(rest, knee, ankle)
        foot_length = segment_length(rest, ankle, foot)
        targets[f"{side}Knee"] = endpoint_in_native_lane(
            base_world[hip], thigh_direction, thigh, float(base_world[knee, 2])
        )
        targets[f"{side}Ankle"] = endpoint_in_native_lane(
            targets[f"{side}Knee"],
            shin_direction,
            shin,
            float(base_world[ankle, 2]),
        )
        targets[f"{side}Foot"] = endpoint_in_native_lane(
            targets[f"{side}Ankle"],
            foot_direction,
            foot_length,
            float(base_world[foot, 2]),
        )
    return targets


def rotations_with_parameters(
    parameters: torch.Tensor, optimized_indices: torch.Tensor, device: torch.device
) -> torch.Tensor:
    rotations = torch.eye(3, device=device).repeat(55, 1, 1)
    rotations[0] = torch.as_tensor(SUPINE_ORIENTATION, device=device)
    return torch.index_copy(
        rotations,
        0,
        optimized_indices,
        axis_angle_to_matrix(parameters),
    )


def solve_pose(
    name: str,
    targets: dict[str, np.ndarray],
    rest_joints: torch.Tensor,
    parents: torch.Tensor,
    initial: torch.Tensor,
    args: argparse.Namespace,
) -> tuple[np.ndarray, dict]:
    device = rest_joints.device
    optimized_indices = torch.tensor(OPTIMIZED_JOINTS, device=device)
    parameters = torch.nn.Parameter(initial.clone())
    target_indices = torch.tensor(
        [TARGET_JOINTS[key] for key in targets], device=device
    )
    target_points = torch.as_tensor(
        np.stack(list(targets.values())), device=device
    )
    optimizer = torch.optim.Adam((parameters,), lr=args.learning_rate)
    history = []

    for iteration in range(args.iterations):
        optimizer.zero_grad(set_to_none=True)
        rotations = rotations_with_parameters(parameters, optimized_indices, device)
        posed, _ = batch_rigid_transform(
            rotations[None], rest_joints, parents
        )
        error = posed[0, target_indices] - target_points
        position_loss = torch.sqrt(error.square().sum(dim=1) + 1e-8).mean()
        rotation_prior = parameters.square().mean()
        loss = 12.0 * position_loss + 0.004 * rotation_prior
        loss.backward()
        optimizer.step()
        if iteration % 200 == 0 or iteration == args.iterations - 1:
            rms = torch.sqrt(error.square().sum(dim=1).mean()) * 1000
            history.append(
                {
                    "iteration": iteration,
                    "rmsMillimeters": float(rms.detach()),
                    "maximumMillimeters": float(
                        torch.linalg.vector_norm(error, dim=1).max().detach() * 1000
                    ),
                }
            )

    with torch.no_grad():
        rotations = rotations_with_parameters(parameters, optimized_indices, device)
        axis_angle = matrix_to_axis_angle(rotations).cpu().numpy().astype(np.float32)
    return axis_angle, {"name": name, "history": history, "final": history[-1]}


def smoothstep(value: float) -> float:
    value = min(1.0, max(0.0, value))
    return value * value * (3.0 - 2.0 * value)


def interpolate_pose(first: np.ndarray, second: np.ndarray, amount: float) -> np.ndarray:
    first_rotation = Rotation.from_rotvec(first.reshape(-1, 3))
    second_rotation = Rotation.from_rotvec(second.reshape(-1, 3))
    relative = first_rotation.inv() * second_rotation
    result = first_rotation * Rotation.from_rotvec(
        relative.as_rotvec() * smoothstep(amount)
    )
    return result.as_rotvec().reshape(55, 3).astype(np.float32)


def build_timeline(spec: dict, poses: dict[str, np.ndarray]) -> np.ndarray:
    fps = float(spec["fps"])
    frame_count = round(float(spec["durationSeconds"]) * fps)
    keyframes = spec["keyframes"]
    output = []
    segment = 0
    for frame in range(frame_count):
        time_seconds = frame / fps
        while (
            segment + 1 < len(keyframes) - 1
            and time_seconds > keyframes[segment + 1]["timeSeconds"]
        ):
            segment += 1
        left = keyframes[segment]
        right = keyframes[segment + 1]
        amount = (time_seconds - left["timeSeconds"]) / (
            right["timeSeconds"] - left["timeSeconds"]
        )
        output.append(
            interpolate_pose(poses[left["pose"]], poses[right["pose"]], amount)
        )
    return np.stack(output)


def floor_translation(
    model: SMPLX,
    axis_angle: torch.Tensor,
    betas: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    frame_count = len(axis_angle)
    device = axis_angle.device
    output = model(
        betas=betas.expand(frame_count, -1),
        expression=torch.zeros(frame_count, 10, device=device),
        global_orient=axis_angle[:, 0],
        body_pose=axis_angle[:, 1:22].reshape(frame_count, -1),
        jaw_pose=axis_angle[:, 22],
        leye_pose=axis_angle[:, 23],
        reye_pose=axis_angle[:, 24],
        left_hand_pose=axis_angle[:, 25:40].reshape(frame_count, -1),
        right_hand_pose=axis_angle[:, 40:55].reshape(frame_count, -1),
        return_verts=True,
    )
    torso_joints = torch.tensor((0, 3, 6, 9, 12, 15), device=device)
    torso_weights = model.lbs_weights[:, torso_joints].sum(dim=1)
    torso_vertices = torso_weights >= 0.55
    torso_offset = 0.012 - output.vertices[:, torso_vertices, 1].amin()
    whole_body_offset = 0.002 - output.vertices[..., 1].amin()
    offset = torch.maximum(torso_offset, whole_body_offset)
    translation = torch.zeros(frame_count, 3, device=device)
    translation[:, 1] = offset
    vertices = output.vertices + translation[:, None]
    joints = output.joints[:, :55] + translation[:, None]
    return translation, vertices, joints, torso_vertices


def lane_report(joints: torch.Tensor) -> dict:
    reports = {}
    for name, left, right in (
        ("knees", 4, 5),
        ("ankles", 7, 8),
        ("feet", 10, 11),
    ):
        signed_separation = joints[:, right, 2] - joints[:, left, 2]
        reports[name] = {
            "minimumSeparationMillimeters": float(
                signed_separation.min().cpu() * 1000
            ),
            "crossedFrames": int((signed_separation <= 0).sum().cpu()),
        }
    return reports


def main() -> None:
    args = parse_args()
    if args.iterations < 1 or args.learning_rate <= 0:
        raise ValueError("iterations and learning rate must be positive")
    if not args.spec.is_file() or not args.model.is_file():
        raise FileNotFoundError("description spec or SMPL-X model is missing")
    spec = load_spec(args.spec)
    device = torch.device(args.device)
    model = (
        SMPLX(str(args.model), use_pca=False, flat_hand_mean=True, num_betas=10)
        .to(device)
        .eval()  # ubs:ignore — PyTorch inference mode, not Python's eval builtin
    )
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    betas = torch.zeros(1, 10, device=device)
    _, rest_joints = shaped_rest(model, betas)

    base_rotations = torch.eye(3, device=device).repeat(55, 1, 1)
    base_rotations[0] = torch.as_tensor(SUPINE_ORIENTATION, device=device)
    base_world, _ = batch_rigid_transform(
        base_rotations[None], rest_joints, model.parents
    )
    rest_numpy = rest_joints[0].cpu().numpy()
    base_numpy = base_world[0].cpu().numpy()

    pose_names = ("tabletop", "left-arm-right-leg", "right-arm-left-leg")
    solved: dict[str, np.ndarray] = {}
    pose_reports = []
    initial = torch.zeros(len(OPTIMIZED_JOINTS), 3, device=device)
    for name in pose_names:
        targets = described_targets(spec, rest_numpy, base_numpy, name)
        pose, report = solve_pose(
            name, targets, rest_joints, model.parents, initial, args
        )
        solved[name] = pose
        pose_reports.append(report)
        initial = torch.as_tensor(pose[list(OPTIMIZED_JOINTS)], device=device)
        print(json.dumps(report["final"] | {"pose": name}), flush=True)

    axis_angle_numpy = build_timeline(spec, solved)
    axis_angle = torch.as_tensor(axis_angle_numpy, device=device)
    with torch.no_grad():
        translation, vertices, joints, torso_vertices = floor_translation(
            model, axis_angle, betas
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    params_path = args.output_dir / "smplx-fit.npz"
    arrays = {
        "axis_angle": axis_angle_numpy,
        "betas": betas.cpu().numpy().astype(np.float32),
        "translation": translation.cpu().numpy().astype(np.float32),
        "source_frames": np.arange(len(axis_angle_numpy), dtype=np.int32),
    }
    if args.export_vertices:
        arrays["vertices"] = vertices.cpu().numpy().astype(np.float32)
        arrays["faces"] = model.faces.astype(np.int32)
    np.savez_compressed(params_path, **arrays)

    previous_rotation = Rotation.from_rotvec(
        axis_angle_numpy[:-1].reshape(-1, 3)
    )
    next_rotation = Rotation.from_rotvec(axis_angle_numpy[1:].reshape(-1, 3))
    frame_delta = np.linalg.norm(
        (previous_rotation.inv() * next_rotation).as_rotvec(), axis=1
    )
    report = {
        "schemaVersion": 1,
        "kind": "describedSMPLXMotion",
        "movementId": spec["movementId"],
        "spec": str(args.spec.resolve()),
        "specSha256": hashlib.sha256(args.spec.read_bytes()).hexdigest(),
        "model": str(args.model.resolve()),
        "frames": len(axis_angle_numpy),
        "fps": spec["fps"],
        "durationSeconds": spec["durationSeconds"],
        "sources": spec["sources"],
        "invariants": spec["invariants"],
        "poses": pose_reports,
        "motion": {
            "rotationDeltaDegreesP95": float(
                np.degrees(np.quantile(frame_delta, 0.95))
            ),
            "rotationDeltaDegreesMaximum": float(np.degrees(frame_delta.max())),
            "rootTranslationRangeMillimeters": float(
                np.ptp(translation.cpu().numpy(), axis=0).max() * 1000
            ),
        },
        "floor": {
            "torsoVertexCount": int(torso_vertices.sum()),
            "minimumTorsoMeters": float(
                vertices[:, torso_vertices, 1].amin().cpu()
            ),
            "minimumWholeBodyMeters": float(vertices[..., 1].amin().cpu()),
        },
        "lateralLanes": lane_report(joints),
        "artifacts": {"parameters": params_path.name},
    }
    report_path = args.output_dir / "build-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
