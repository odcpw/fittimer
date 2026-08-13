#!/usr/bin/env python3
"""Fit direct RTMW3D-X observations to SMPL-X joint rotations.

The fitting target is the detailed joint stream produced by
``build-rtmw3d-loop.py``. OpenSim is not involved. The optimizer uses the
native SMPL-X kinematic tree and a single shared body shape, then writes the
55 local joint rotations needed to skin the actual SMPL-X mesh.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from pytorch3d.transforms import (
    axis_angle_to_matrix,
    matrix_to_axis_angle,
    matrix_to_rotation_6d,
    rotation_6d_to_matrix,
)
from smplx import SMPLX
from smplx.lbs import batch_rigid_transform

BODY_TARGETS = [
    (5, 16),
    (6, 17),
    (7, 18),
    (8, 19),
    (9, 20),
    (10, 21),
    (11, 1),
    (12, 2),
    (13, 4),
    (14, 5),
    (15, 7),
    (16, 8),
]

LEFT_HAND_TARGETS = [
    (92, 37),
    (93, 38),
    (94, 39),
    (96, 25),
    (97, 26),
    (98, 27),
    (100, 28),
    (101, 29),
    (102, 30),
    (104, 34),
    (105, 35),
    (106, 36),
    (108, 31),
    (109, 32),
    (110, 33),
]

RIGHT_HAND_TARGETS = [
    (113, 52),
    (114, 53),
    (115, 54),
    (117, 40),
    (118, 41),
    (119, 42),
    (121, 43),
    (122, 44),
    (123, 45),
    (125, 49),
    (126, 50),
    (127, 51),
    (129, 46),
    (130, 47),
    (131, 48),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--motion", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--start-frame", type=int, default=0)
    parser.add_argument("--end-frame", type=int)
    parser.add_argument("--iterations", type=int, default=1200)
    parser.add_argument("--learning-rate", type=float, default=0.035)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--export-vertices", action="store_true")
    return parser.parse_args()


SUPINE_ORIENTATION = (
    (0.0, -1.0, 0.0),
    (0.0, 0.0, 1.0),
    (-1.0, 0.0, 0.0),
)


def shaped_body(
    model: SMPLX, betas: torch.Tensor, frame_count: int
) -> tuple[torch.Tensor, torch.Tensor]:
    shaped = model.v_template + torch.einsum(
        "bl,vcl->bvc", betas, model.shapedirs[:, :, : betas.shape[1]]
    )
    joints = torch.einsum("jv,bvc->bjc", model.J_regressor, shaped)
    return shaped.expand(frame_count, -1, -1), joints.expand(frame_count, -1, -1)


def foot_targets(target: torch.Tensor) -> torch.Tensor:
    return torch.stack(
        (
            (target[:, 17] + target[:, 18]) / 2,
            (target[:, 20] + target[:, 21]) / 2,
        ),
        dim=1,
    )


def robust_position_loss(
    fitted: torch.Tensor, target: torch.Tensor, delta: float = 0.035
) -> torch.Tensor:
    distance = torch.linalg.vector_norm(fitted - target, dim=-1)
    quadratic = torch.minimum(distance, torch.tensor(delta, device=distance.device))
    linear = distance - quadratic
    return (0.5 * quadratic.square() + delta * linear).mean()


def main() -> None:
    args = parse_args()
    if args.iterations < 1 or args.learning_rate <= 0:
        raise ValueError("Iterations and learning rate must be positive")
    if not args.motion.is_file() or not args.model.is_file():
        raise FileNotFoundError("Motion or SMPL-X model is missing")

    try:
        motion = json.JSONDecoder().decode(args.motion.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"motion contains invalid JSON: {error}") from error
    source_frames = np.asarray(motion["frames"], dtype=np.float32)
    end_frame = len(source_frames) - 1 if args.end_frame is None else args.end_frame
    if not 0 <= args.start_frame <= end_frame < len(source_frames):
        raise ValueError("Selected frame range is outside the motion")
    selected = source_frames[args.start_frame : end_frame + 1]
    frame_count = len(selected)

    device = torch.device(args.device)
    target_world = torch.as_tensor(selected, device=device)
    target_root = (target_world[:, 11] + target_world[:, 12]) / 2
    target = target_world - target_root[:, None]

    model = (
        SMPLX(
            str(args.model),
            use_pca=False,
            flat_hand_mean=True,
            num_betas=10,
        )
        .to(device)
        .eval()  # ubs:ignore — PyTorch inference mode, not Python's eval builtin
    )
    for parameter in model.parameters():
        parameter.requires_grad_(False)

    supine_orientation = torch.tensor(SUPINE_ORIENTATION, device=device)
    initial_axis_angle = torch.zeros(frame_count, 55, 3, device=device)
    initial_axis_angle[:, 0] = matrix_to_axis_angle(supine_orientation)
    pose_6d = torch.nn.Parameter(
        matrix_to_rotation_6d(axis_angle_to_matrix(initial_axis_angle))
    )
    betas = torch.nn.Parameter(torch.zeros(1, 10, device=device))
    optimizer = torch.optim.Adam((pose_6d, betas), lr=args.learning_rate)

    body_target_indices = torch.tensor(
        [item[0] for item in BODY_TARGETS], device=device
    )
    body_model_indices = torch.tensor([item[1] for item in BODY_TARGETS], device=device)
    left_target_indices = torch.tensor(
        [item[0] for item in LEFT_HAND_TARGETS], device=device
    )
    left_model_indices = torch.tensor(
        [item[1] for item in LEFT_HAND_TARGETS], device=device
    )
    right_target_indices = torch.tensor(
        [item[0] for item in RIGHT_HAND_TARGETS], device=device
    )
    right_model_indices = torch.tensor(
        [item[1] for item in RIGHT_HAND_TARGETS], device=device
    )
    identity = torch.eye(3, device=device)
    history = []

    for iteration in range(args.iterations):
        optimizer.zero_grad(set_to_none=True)
        rotations = rotation_6d_to_matrix(pose_6d)
        shaped, rest_joints = shaped_body(model, betas, frame_count)
        posed_joints, transforms = batch_rigid_transform(
            rotations, rest_joints, model.parents
        )
        posed = posed_joints - posed_joints[:, :1]

        rest_nose = shaped[:, model.vertex_joint_selector.extra_joints_idxs[0]]
        nose_homogeneous = torch.cat(
            (rest_nose, torch.ones(frame_count, 1, device=device)), dim=1
        )
        posed_nose = torch.einsum("bij,bj->bi", transforms[:, 15], nose_homogeneous)[
            :, :3
        ]
        fitted_face = torch.nn.functional.normalize(
            posed_nose - posed_joints[:, 15], dim=1
        )
        target_ear_center = (target[:, 3] + target[:, 4]) / 2
        target_face = torch.nn.functional.normalize(
            target[:, 0] - target_ear_center, dim=1
        )

        body_loss = robust_position_loss(
            posed[:, body_model_indices], target[:, body_target_indices]
        )
        feet_loss = robust_position_loss(posed[:, [10, 11]], foot_targets(target))
        left_hand_loss = robust_position_loss(
            posed[:, left_model_indices], target[:, left_target_indices]
        )
        right_hand_loss = robust_position_loss(
            posed[:, right_model_indices], target[:, right_target_indices]
        )

        body_prior = (rotations[:, 1:22] - identity).square().mean()
        hand_prior = (rotations[:, 25:55] - identity).square().mean()
        face_lock = (rotations[:, 22:25] - identity).square().mean()
        face_direction_loss = (fitted_face - target_face).square().mean()
        supine_prior = (rotations[:, 0] - supine_orientation[None]).square().mean()
        shape_prior = betas.square().mean()
        if frame_count > 1:
            velocity = (rotations[1:] - rotations[:-1]).square().mean()
        else:
            velocity = torch.zeros((), device=device)
        if frame_count > 2:
            acceleration = (
                (rotations[2:] - 2 * rotations[1:-1] + rotations[:-2]).square().mean()
            )
        else:
            acceleration = torch.zeros((), device=device)

        loss = (
            8.0 * body_loss
            + 4.0 * feet_loss
            + 1.5 * left_hand_loss
            + 1.5 * right_hand_loss
            + 0.012 * body_prior
            + 0.02 * hand_prior
            + 0.2 * face_lock
            + 0.5 * face_direction_loss
            + 0.04 * supine_prior
            + 0.004 * shape_prior
            + 0.08 * velocity
            + 0.12 * acceleration
        )
        loss.backward()
        optimizer.step()

        if iteration % 100 == 0 or iteration == args.iterations - 1:
            record = {
                "iteration": iteration,
                "loss": float(loss.detach()),
                "bodyMillimeters": float(
                    torch.sqrt(
                        (
                            (
                                posed[:, body_model_indices]
                                - target[:, body_target_indices]
                            )
                            ** 2
                        )
                        .sum(-1)
                        .mean()
                    )
                    * 1000
                ),
                "feetMillimeters": float(
                    torch.sqrt(
                        ((posed[:, [10, 11]] - foot_targets(target)) ** 2)
                        .sum(-1)
                        .mean()
                    )
                    * 1000
                ),
                "handsMillimeters": float(
                    torch.sqrt(
                        torch.cat(
                            (
                                (
                                    posed[:, left_model_indices]
                                    - target[:, left_target_indices]
                                ).square(),
                                (
                                    posed[:, right_model_indices]
                                    - target[:, right_target_indices]
                                ).square(),
                            ),
                            dim=1,
                        )
                        .sum(-1)
                        .mean()
                    )
                    * 1000
                ),
                "faceDirectionDegrees": float(
                    torch.rad2deg(
                        torch.acos(
                            (fitted_face * target_face).sum(dim=1).clamp(-1.0, 1.0)
                        )
                    ).mean()
                ),
            }
            history.append(record)
            print(json.dumps(record), flush=True)

    with torch.no_grad():
        rotations = rotation_6d_to_matrix(pose_6d)
        axis_angle = matrix_to_axis_angle(rotations)
        _, rest_joints = shaped_body(model, betas, frame_count)
        posed_joints, _ = batch_rigid_transform(rotations, rest_joints, model.parents)
        root_translation = target_root - posed_joints[:, 0]

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
            transl=root_translation,
            return_verts=True,
        )
        vertices = output.vertices
        # A supine exercise needs a stable back/head contact plane. Exclude
        # fingers from the contact estimate so noisy hand landmarks cannot
        # lift the whole body, but still prevent any vertex from visibly
        # passing through the floor.
        non_hand = model.lbs_weights[:, :25].sum(dim=1) >= 0.5
        floor_offset = 0.012 - vertices[:, non_hand, 1].amin(dim=1)
        remaining_penetration = 0.002 - (vertices[..., 1].amin(dim=1) + floor_offset)
        floor_offset += torch.clamp(remaining_penetration, min=0)
        root_translation[:, 1] += floor_offset
        vertices[..., 1] += floor_offset[:, None]

    args.output_dir.mkdir(parents=True, exist_ok=True)
    params_path = args.output_dir / "smplx-fit.npz"
    arrays = {
        "axis_angle": axis_angle.cpu().numpy().astype(np.float32),
        "betas": betas.detach().cpu().numpy().astype(np.float32),
        "translation": root_translation.cpu().numpy().astype(np.float32),
        "source_frames": np.arange(args.start_frame, end_frame + 1, dtype=np.int32),
    }
    if args.export_vertices:
        arrays["vertices"] = vertices.cpu().numpy().astype(np.float32)
        arrays["faces"] = model.faces.astype(np.int32)
    np.savez_compressed(params_path, **arrays)

    report = {
        "schemaVersion": 1,
        "kind": "rtmw3dToSmplxFit",
        "motion": str(args.motion.resolve()),
        "model": str(args.model.resolve()),
        "frames": frame_count,
        "sourceStartFrame": args.start_frame,
        "sourceEndFrame": end_frame,
        "fps": motion["fps"],
        "iterations": args.iterations,
        "device": str(device),
        "vertices": int(model.v_template.shape[0]),
        "faces": int(model.faces.shape[0]),
        "fittedJoints": len(BODY_TARGETS)
        + 2
        + len(LEFT_HAND_TARGETS)
        + len(RIGHT_HAND_TARGETS),
        "history": history,
        "final": history[-1],
        "floor": {
            "method": "per-frame non-hand contact with whole-mesh penetration guard",
            "minimumMeters": float(vertices[..., 1].amin()),
            "medianMinimumMeters": float(vertices[..., 1].amin(dim=1).median()),
        },
        "artifacts": {"parameters": params_path.name},
    }
    (args.output_dir / "fit-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
