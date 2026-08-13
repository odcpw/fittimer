#!/usr/bin/env python3
"""Export a fitted SMPL-X sequence as one browser-ready skinned GLB.

Run through Blender:

    blender --background --factory-startup --python export-smplx-glb.py -- \
      --fit smplx-fit.npz --model SMPLX_NEUTRAL.npz --output deadbug.glb

The SMPL-X joint rotations remain the animation source. This script builds the
native 55-bone skin around them; it does not retarget through OpenSim or a
second character rig.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

JOINT_NAMES = (
    "pelvis",
    "left_hip",
    "right_hip",
    "spine1",
    "left_knee",
    "right_knee",
    "spine2",
    "left_ankle",
    "right_ankle",
    "spine3",
    "left_foot",
    "right_foot",
    "neck",
    "left_collar",
    "right_collar",
    "head",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "jaw",
    "left_eye",
    "right_eye",
    "left_index1",
    "left_index2",
    "left_index3",
    "left_middle1",
    "left_middle2",
    "left_middle3",
    "left_pinky1",
    "left_pinky2",
    "left_pinky3",
    "left_ring1",
    "left_ring2",
    "left_ring3",
    "left_thumb1",
    "left_thumb2",
    "left_thumb3",
    "right_index1",
    "right_index2",
    "right_index3",
    "right_middle1",
    "right_middle2",
    "right_middle3",
    "right_pinky1",
    "right_pinky2",
    "right_pinky3",
    "right_ring1",
    "right_ring2",
    "right_ring3",
    "right_thumb1",
    "right_thumb2",
    "right_thumb3",
)

# Source motion is right-handed Y-up/Z-camera. Blender is right-handed Z-up.
SOURCE_TO_BLENDER = np.asarray(
    ((1.0, 0.0, 0.0), (0.0, 0.0, -1.0), (0.0, 1.0, 0.0)),
    dtype=np.float64,
)


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--fit", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--name", default="SMPL-X exercise loop")
    parser.add_argument("--motion", default="fitted SMPL-X motion")
    return parser.parse_args(argv)


def validate_arrays(
    fit: np.lib.npyio.NpzFile, model: np.lib.npyio.NpzFile
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    axis_angle = np.asarray(fit["axis_angle"], dtype=np.float64)
    translation = np.asarray(fit["translation"], dtype=np.float64)
    betas = np.asarray(fit["betas"], dtype=np.float64).reshape(-1)
    if axis_angle.ndim != 3 or axis_angle.shape[1:] != (55, 3):
        raise ValueError("fit axis_angle must have shape [frames, 55, 3]")
    if translation.shape != (len(axis_angle), 3):
        raise ValueError("fit translation must have shape [frames, 3]")
    if len(betas) < 10 or not np.isfinite(axis_angle).all():
        raise ValueError("fit contains invalid SMPL-X parameters")

    template = np.asarray(model["v_template"], dtype=np.float64)
    shapedirs = np.asarray(model["shapedirs"], dtype=np.float64)
    shaped = template + np.einsum(
        "vcl,l->vc", shapedirs[:, :, :10], betas[:10], optimize=True
    )
    joints = np.asarray(model["J_regressor"], dtype=np.float64) @ shaped
    weights = np.asarray(model["weights"], dtype=np.float64)
    faces = np.asarray(model["f"], dtype=np.int32)
    if weights.shape != (len(shaped), 55) or joints.shape != (55, 3):
        raise ValueError("model is not the expected 55-joint SMPL-X body")
    return axis_angle, translation, shaped, joints, weights, faces


def axis_angle_matrix(vector: np.ndarray) -> np.ndarray:
    angle = float(np.linalg.norm(vector))
    if angle < 1e-10:
        return np.eye(3)
    axis = vector / angle
    x, y, z = axis
    cross = np.asarray(((0, -z, y), (z, 0, -x), (-y, x, 0)))
    return np.eye(3) + np.sin(angle) * cross + (1 - np.cos(angle)) * (cross @ cross)


def make_armature(joints: np.ndarray, parents: np.ndarray) -> bpy.types.Object:
    armature_data = bpy.data.armatures.new("SMPL-X 55-joint rig")
    armature = bpy.data.objects.new("SMPL-X direct rig", armature_data)
    bpy.context.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    converted = (SOURCE_TO_BLENDER @ joints.T).T
    edit_bones = []
    for name, position in zip(JOINT_NAMES, converted, strict=True):
        bone = armature_data.edit_bones.new(name)
        bone.head = Vector(position)
        # Identical rest axes make SMPL-X local rotation matrices usable
        # directly after the one coordinate-system conversion below.
        bone.tail = Vector(position + np.asarray((0.0, 0.05, 0.0)))
        bone.use_connect = False
        edit_bones.append(bone)
    for index in range(1, len(edit_bones)):
        edit_bones[index].parent = edit_bones[int(parents[index])]
    bpy.ops.object.mode_set(mode="OBJECT")
    armature.show_in_front = True
    return armature


def make_skinned_body(
    armature: bpy.types.Object,
    vertices: np.ndarray,
    faces: np.ndarray,
    weights: np.ndarray,
) -> bpy.types.Object:
    converted = (SOURCE_TO_BLENDER @ vertices.T).T
    mesh = bpy.data.meshes.new("SMPL-X body mesh")
    mesh.from_pydata(converted.tolist(), [], faces.tolist())
    mesh.update()
    body = bpy.data.objects.new("SMPL-X body", mesh)
    bpy.context.collection.objects.link(body)
    for polygon in mesh.polygons:
        polygon.use_smooth = True

    material = bpy.data.materials.new("FitTimer skin")
    material.diffuse_color = (0.46, 0.20, 0.14, 1.0)
    material.metallic = 0.0
    material.roughness = 0.62
    body.data.materials.append(material)

    # glTF's portable skin contract is four normalized influences per vertex.
    strongest = np.argpartition(weights, -4, axis=1)[:, -4:]
    selected = np.take_along_axis(weights, strongest, axis=1)
    selected /= np.maximum(selected.sum(axis=1, keepdims=True), 1e-12)
    groups = [body.vertex_groups.new(name=name) for name in JOINT_NAMES]
    for vertex_index in range(len(vertices)):
        for slot in range(4):
            weight = float(selected[vertex_index, slot])
            if weight > 1e-6:
                group_index = int(strongest[vertex_index, slot])
                groups[group_index].add([vertex_index], weight, "REPLACE")

    modifier = body.modifiers.new("SMPL-X skin", "ARMATURE")
    modifier.object = armature
    body.parent = armature
    return body


def animate(
    armature: bpy.types.Object,
    axis_angle: np.ndarray,
    translation: np.ndarray,
    fps: float,
    action_name: str,
) -> None:
    scene = bpy.context.scene
    scene.render.fps = round(fps)
    scene.render.fps_base = round(fps) / fps
    scene.frame_start = 0
    scene.frame_end = len(axis_angle)

    previous_quaternions = [None] * len(JOINT_NAMES)
    for output_frame in range(len(axis_angle) + 1):
        source_frame = output_frame % len(axis_angle)
        for joint_index, name in enumerate(JOINT_NAMES):
            rotation = axis_angle_matrix(axis_angle[source_frame, joint_index])
            converted = SOURCE_TO_BLENDER @ rotation @ SOURCE_TO_BLENDER.T
            quaternion = Matrix(converted.tolist()).to_quaternion()
            previous = previous_quaternions[joint_index]
            if previous is not None and quaternion.dot(previous) < 0:
                quaternion.negate()
            previous_quaternions[joint_index] = quaternion.copy()
            bone = armature.pose.bones[name]
            bone.rotation_mode = "QUATERNION"
            bone.rotation_quaternion = quaternion
            bone.keyframe_insert("rotation_quaternion", frame=output_frame)

        root = armature.pose.bones[JOINT_NAMES[0]]
        root.location = Vector(SOURCE_TO_BLENDER @ translation[source_frame])
        root.keyframe_insert("location", frame=output_frame)

    if armature.animation_data and armature.animation_data.action:
        action = armature.animation_data.action
        action.name = action_name


def main() -> None:
    args = parse_args()
    if args.fps <= 0 or not args.fit.is_file() or not args.model.is_file():
        raise ValueError("fit/model must exist and fps must be positive")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    fit = np.load(args.fit, allow_pickle=False)
    model = np.load(args.model, allow_pickle=False)
    axis_angle, translation, shaped, joints, weights, faces = validate_arrays(
        fit, model
    )
    parents = np.asarray(model["kintree_table"][0], dtype=np.int64)

    armature = make_armature(joints, parents)
    body = make_skinned_body(armature, shaped, faces, weights)
    animate(armature, axis_angle, translation, args.fps, args.name)
    armature["fitTimerMotion"] = {
        "schemaVersion": 1,
        "model": "SMPL-X neutral",
        "motion": args.motion,
        "frames": len(axis_angle),
        "fps": args.fps,
        "loopSeconds": len(axis_angle) / args.fps,
        "joints": len(JOINT_NAMES),
        "openSim": False,
    }
    body["fitTimerSkinnedTarget"] = True

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    body.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_frame_range=True,
        export_force_sampling=True,
        export_yup=True,
    )
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("Blender did not create the GLB output")
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(output),
                "bytes": output.stat().st_size,
                "frames": len(axis_angle),
                "fps": args.fps,
                "joints": len(JOINT_NAMES),
                "vertices": len(shaped),
                "faces": len(faces),
            }
        )
    )


if __name__ == "__main__":
    main()
