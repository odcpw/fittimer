#!/usr/bin/env python3
"""Retarget a direct RTMW3D-X loop onto the pinned Vitruvian Rigify body.

The source is the smoothed 133-landmark JSON emitted by
``build-rtmw3d-loop.py``. Segment directions drive native Rigify FK controls;
per-frame pelvis height drives the root so planted-foot grounding and vertical
spring survive the transfer.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector


def load_base_module():
    path = Path(__file__).with_name("retarget-rigify.py")
    spec = importlib.util.spec_from_file_location("fittimer_retarget_rigify", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load shared Rigify exporter: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BASE = load_base_module()

SEGMENTS = (
    ("spine1", "spine2", "spine_fk"),
    ("spine2", "spine3", "spine_fk.002"),
    ("spine3", "neck", "spine_fk.003"),
    ("left_collar", "left_shoulder", "shoulder.L"),
    ("right_collar", "right_shoulder", "shoulder.R"),
    ("left_shoulder", "left_elbow", "upper_arm_fk.L"),
    ("right_shoulder", "right_elbow", "upper_arm_fk.R"),
    ("left_elbow", "left_wrist", "forearm_fk.L"),
    ("right_elbow", "right_wrist", "forearm_fk.R"),
    ("left_hip", "left_knee", "thigh_fk.L"),
    ("right_hip", "right_knee", "thigh_fk.R"),
    ("left_knee", "left_ankle", "shin_fk.L"),
    ("right_knee", "right_ankle", "shin_fk.R"),
    ("left_ankle", "left_foot", "foot_fk.L"),
    ("right_ankle", "right_foot", "foot_fk.R"),
    ("neck", "head", "neck"),
)

WEB_SEGMENTS = (
    ("pelvis", "spine1", "DEF-spine"),
    ("spine1", "spine2", "DEF-spine.001"),
    ("spine2", "spine3", "DEF-spine.002"),
    ("spine3", "neck", "DEF-spine.003"),
    ("neck", "head", "DEF-spine.004"),
    ("left_shoulder", "left_elbow", "DEF-upper_arm.L"),
    ("right_shoulder", "right_elbow", "DEF-upper_arm.R"),
    ("left_elbow", "left_wrist", "DEF-forearm.L"),
    ("right_elbow", "right_wrist", "DEF-forearm.R"),
    ("left_hip", "left_knee", "DEF-thigh.L"),
    ("right_hip", "right_knee", "DEF-thigh.R"),
    ("left_knee", "left_ankle", "DEF-shin.L"),
    ("right_knee", "right_ankle", "DEF-shin.R"),
    ("left_ankle", "left_foot", "DEF-foot.L"),
    ("right_ankle", "right_foot", "DEF-foot.R"),
)

PLANTED_LOWER_BODY = (
    ("thigh_fk.L", Vector((0.0, 0.0, -1.0))),
    ("thigh_fk.R", Vector((0.0, 0.0, -1.0))),
    ("shin_fk.L", Vector((0.0, 0.0, -1.0))),
    ("shin_fk.R", Vector((0.0, 0.0, -1.0))),
    ("foot_fk.L", Vector((0.0, -1.0, -0.04))),
    ("foot_fk.R", Vector((0.0, -1.0, -0.04))),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--motion", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--poster", type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--creator", required=True)
    parser.add_argument(
        "--upper-body-only",
        action="store_true",
        help="Keep the target's lower body planted when the source crops out the legs.",
    )
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def load_motion(path: Path) -> tuple[dict, np.ndarray, float]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid motion JSON: {path}") from error
    if payload.get("kind") != "rtmw3dDirectMotion":
        raise ValueError("Motion is not an RTMW3D direct loop")
    frames = np.asarray(payload.get("frames"), dtype=np.float64)
    fps = float(payload.get("fps", 0))
    if frames.ndim != 3 or frames.shape[1:] != (133, 3):
        raise ValueError(f"Expected [frames,133,3], received {frames.shape}")
    if len(frames) < 3 or fps <= 0 or not np.isfinite(frames).all():
        raise ValueError("Motion has invalid frames or frame rate")
    # RTMW3D/Three.js X-right, Y-up, Z-camera -> Blender X-right, Z-up, -Y-camera.
    blender = np.empty_like(frames)
    blender[..., 0] = frames[..., 0]
    blender[..., 1] = -frames[..., 2]
    blender[..., 2] = frames[..., 1]
    # Camera-space observations may face toward, away from, or across the
    # camera. Canonicalize one stable sequence heading before applying those
    # directions to the front-facing target rig. A single median rotation
    # preserves observed turning within the exercise and avoids per-frame yaw
    # jitter.
    anatomical_left = (
        (blender[:, 5] - blender[:, 6])
        + (blender[:, 11] - blender[:, 12])
    ) / 2.0
    source_left = np.median(anatomical_left[:, :2], axis=0)
    if np.linalg.norm(source_left) <= 1e-8:
        raise ValueError("Motion has no stable horizontal body heading")
    heading = -math.atan2(source_left[1], source_left[0])
    cosine, sine = math.cos(heading), math.sin(heading)
    horizontal = blender[..., :2].copy()
    blender[..., 0] = cosine * horizontal[..., 0] - sine * horizontal[..., 1]
    blender[..., 1] = sine * horizontal[..., 0] + cosine * horizontal[..., 1]
    payload["headingNormalizationDegrees"] = math.degrees(heading)
    return payload, blender, fps


def anatomical_points(frame: np.ndarray) -> dict[str, Vector]:
    point = lambda index: Vector(frame[index])
    pelvis = (point(11) + point(12)) / 2
    shoulders = (point(5) + point(6)) / 2
    torso = shoulders - pelvis
    left_shoulder = point(5)
    right_shoulder = point(6)
    return {
        "pelvis": pelvis,
        "spine1": pelvis + torso * 0.25,
        "spine2": pelvis + torso * 0.5,
        "spine3": pelvis + torso * 0.75,
        "neck": shoulders,
        "head": (point(3) + point(4)) / 2,
        "left_collar": shoulders + (left_shoulder - shoulders) * 0.35,
        "right_collar": shoulders + (right_shoulder - shoulders) * 0.35,
        "left_shoulder": left_shoulder,
        "right_shoulder": right_shoulder,
        "left_elbow": point(7),
        "right_elbow": point(8),
        "left_wrist": point(9),
        "right_wrist": point(10),
        "left_hip": point(11),
        "right_hip": point(12),
        "left_knee": point(13),
        "right_knee": point(14),
        "left_ankle": point(15),
        "right_ankle": point(16),
        "left_foot": (point(17) + point(18)) / 2,
        "right_foot": (point(20) + point(21)) / 2,
    }


def target_torso_length(rig: bpy.types.Object) -> float:
    hips = (rig.pose.bones["thigh_fk.L"].head + rig.pose.bones["thigh_fk.R"].head) / 2
    shoulders = (
        rig.pose.bones["upper_arm_fk.L"].head
        + rig.pose.bones["upper_arm_fk.R"].head
    ) / 2
    length = (shoulders - hips).length
    if length <= 1e-6:
        raise RuntimeError("Vitruvian torso length collapsed")
    return length


def web_target_torso(rig: bpy.types.Object) -> tuple[float, float]:
    hips = (rig.data.bones["DEF-thigh.L"].head_local + rig.data.bones["DEF-thigh.R"].head_local) / 2
    shoulders = (
        rig.data.bones["DEF-upper_arm.L"].head_local
        + rig.data.bones["DEF-upper_arm.R"].head_local
    ) / 2
    length = (shoulders - hips).length
    if length <= 1e-6:
        raise RuntimeError("Web Vitruvian torso length collapsed")
    return length, hips.z


def load_web_target(path: Path) -> tuple[bpy.types.Object, bpy.types.Object]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    rigs = [item for item in bpy.context.scene.objects if item.type == "ARMATURE"]
    bodies = [item for item in bpy.context.scene.objects if item.type == "MESH" and item.name == "cm_vitruvian"]
    if len(rigs) != 1 or len(bodies) != 1:
        raise RuntimeError("Web target must contain one Vitruvian body and armature")
    rig, body = rigs[0], bodies[0]
    for _, _, name in WEB_SEGMENTS:
        if name not in rig.pose.bones:
            raise RuntimeError(f"Web target is missing deform bone {name}")
    for item in list(bpy.context.scene.objects):
        if item not in (rig, body):
            bpy.data.objects.remove(item, do_unlink=True)
    for item in (rig, body):
        item.animation_data_clear()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    return body, rig


def align_segment(
    rig: bpy.types.Object,
    start: Vector,
    end: Vector,
    bone_name: str,
) -> bpy.types.PoseBone:
    desired_world = end - start
    if desired_world.length_squared < 1e-10:
        raise RuntimeError(f"Observed segment {bone_name} collapsed")
    desired = (rig.matrix_world.inverted_safe().to_3x3() @ desired_world).normalized()
    bone = rig.pose.bones[bone_name]
    current = bone.tail - bone.head
    if current.length_squared < 1e-10:
        raise RuntimeError(f"Vitruvian segment {bone_name} collapsed")
    swing = current.normalized().rotation_difference(desired)
    bone.matrix = Matrix.LocRotScale(
        bone.matrix.translation,
        swing @ bone.matrix.to_quaternion(),
        Vector((1.0, 1.0, 1.0)),
    )
    bpy.context.view_layer.update()
    return bone


def animate(
    rig: bpy.types.Object,
    frames: np.ndarray,
    fps: float,
    name: str,
    creator: str,
    payload: dict,
    upper_body_only: bool = False,
) -> tuple[int, int]:
    scene = bpy.context.scene
    scene.render.fps = round(fps)
    scene.frame_start = 1
    scene.frame_end = len(frames) + 1
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    if rig.animation_data:
        rig.animation_data.action = None
    BASE.clear_target_pose(rig)

    source_torsos = [
        (anatomical_points(frame)["neck"] - anatomical_points(frame)["pelvis"]).length
        for frame in frames
    ]
    source_torso = float(np.median(source_torsos))
    if source_torso <= 1e-6:
        raise RuntimeError("Observed torso length collapsed")
    translation_scale = target_torso_length(rig) / source_torso
    segments = (
        tuple(segment for segment in SEGMENTS if not segment[2].startswith(("thigh", "shin", "foot")))
        if upper_body_only
        else SEGMENTS
    )
    controls = {target for _, _, target in segments}
    if upper_body_only:
        controls.update(target for target, _ in PLANTED_LOWER_BODY)
    root_height = float(np.median([
        anatomical_points(frame)["pelvis"].z for frame in frames
    ]))

    # Author at 2 Hz and let Blender/glTF interpolate the 30 Hz export. The
    # observed stream is already temporally smoothed; this keeps the native
    # Rigify deformation helpers (including sliding knees/elbows) affordable
    # while retaining the large-scale exercise motion and body spring.
    samples = list(range(0, len(frames), max(1, round(fps / 2))))
    if samples[-1] != len(frames) - 1:
        samples.append(len(frames) - 1)
    authored = [(index + 1, frames[index]) for index in samples]
    authored.append((len(frames) + 1, frames[0]))
    for output_frame, source in authored:
        scene.frame_set(output_frame)
        for control in controls:
            rig.pose.bones[control].matrix_basis.identity()
        points = anatomical_points(source)
        root = rig.pose.bones["root"]
        root.matrix_basis.identity()
        height = root_height if upper_body_only else points["pelvis"].z
        root.location = Vector((0.0, 0.0, height * translation_scale))
        root.keyframe_insert("location", frame=output_frame, group="root")
        for start, end, target in segments:
            bone = align_segment(rig, points[start], points[end], target)
            bone.keyframe_insert("rotation_quaternion", frame=output_frame, group=target)
        if upper_body_only:
            origin = Vector((0.0, 0.0, 0.0))
            for target, direction in PLANTED_LOWER_BODY:
                bone = align_segment(rig, origin, direction, target)
                bone.keyframe_insert(
                    "rotation_quaternion", frame=output_frame, group=target
                )

    action = rig.animation_data.action if rig.animation_data else None
    if action is None:
        raise RuntimeError("RTMW3D transfer produced no target action")
    action.name = name
    rig["fitTimerMotion"] = {
        "kind": "fitTimerRtmw3dRigifyMotion",
        "exercise": name,
        "creator": creator,
        "sourceId": payload.get("sourceId"),
        "observationModel": payload.get("model"),
        "method": "RTMW3D anatomical directions to native Rigify FK controls",
        "frames": len(frames) + 1,
        "fps": fps,
        "durationSeconds": len(frames) / fps,
        "authoredKeys": len(authored),
        "perFrameGrounding": True,
        "loop": True,
        "biomechanicalFit": False,
        "upperBodyOnly": upper_body_only,
    }
    return 1, len(frames) + 1


def animate_web(
    rig: bpy.types.Object,
    frames: np.ndarray,
    fps: float,
    name: str,
    creator: str,
    payload: dict,
) -> tuple[int, int]:
    scene = bpy.context.scene
    scene.render.fps = round(fps)
    scene.frame_start = 1
    scene.frame_end = len(frames) + 1
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    for bone in rig.pose.bones:
        bone.matrix_basis.identity()
        bone.rotation_mode = "QUATERNION"

    source_torso = float(np.median([
        (anatomical_points(frame)["neck"] - anatomical_points(frame)["pelvis"]).length
        for frame in frames
    ]))
    target_torso, target_pelvis_z = web_target_torso(rig)
    scale = target_torso / source_torso
    controls = {target for _, _, target in WEB_SEGMENTS}
    stride = max(1, round(fps / 10))
    samples = list(range(0, len(frames), stride))
    if samples[-1] != len(frames) - 1:
        samples.append(len(frames) - 1)
    authored = [(index + 1, frames[index]) for index in samples]
    authored.append((len(frames) + 1, frames[0]))

    for output_frame, source in authored:
        scene.frame_set(output_frame)
        for control in controls:
            rig.pose.bones[control].matrix_basis.identity()
        points = anatomical_points(source)
        rig.location = Vector((0.0, 0.0, points["pelvis"].z * scale - target_pelvis_z))
        rig.keyframe_insert("location", frame=output_frame, group="root")
        for start, end, target in WEB_SEGMENTS:
            bone = align_segment(rig, points[start], points[end], target)
            bone.keyframe_insert("rotation_quaternion", frame=output_frame, group=target)

    action = rig.animation_data.action if rig.animation_data else None
    if action is None:
        raise RuntimeError("Web RTMW3D transfer produced no action")
    action.name = name
    rig["fitTimerMotion"] = {
        "kind": "fitTimerRtmw3dWebRigMotion",
        "exercise": name,
        "creator": creator,
        "sourceId": payload.get("sourceId"),
        "observationModel": payload.get("model"),
        "method": "RTMW3D anatomical directions to Vitruvian deform skeleton",
        "frames": len(frames) + 1,
        "fps": fps,
        "durationSeconds": len(frames) / fps,
        "authoredKeys": len(authored),
        "perFrameGrounding": payload.get("filter", {}).get("grounding"),
        "loop": True,
        "biomechanicalFit": False,
    }
    return 1, len(frames) + 1


def export_web(body: bpy.types.Object, rig: bpy.types.Object, output: Path, start: int, end: int) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.export_scene.gltf(
        filepath=str(output), export_format="GLB", use_selection=True,
        export_animations=True, export_animation_mode="ACTIVE_ACTIONS",
        export_skins=True, export_def_bones=False, export_armature_object_remove=False,
        export_morph=False, export_cameras=False, export_lights=False,
        export_extras=True, export_frame_range=True, export_force_sampling=True,
        export_sampling_interpolation_fallback="LINEAR", export_yup=True,
        export_image_format="AUTO",
    )
    if result != {"FINISHED"} or not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("Blender did not create the web Vitruvian GLB")


def main() -> None:
    args = parse_args()
    for path in (args.target, args.motion):
        if not path.is_file():
            raise FileNotFoundError(path)
    for path in (args.output, args.poster):
        if path and path.exists() and not args.replace:
            raise FileExistsError(f"Refusing to replace {path}")
    payload, frames, fps = load_motion(args.motion)
    if args.target.suffix.lower() == ".glb":
        body, rig = load_web_target(args.target)
        start, end = animate_web(rig, frames, fps, args.name, args.creator, payload)
        export_web(body, rig, args.output.resolve(), start, end)
        atlas = "embedded web-target material"
        placement = (0.0, 0.0, 0.0)
    else:
        body, rig = BASE.load_target(args.target)
        start, end = animate(
            rig, frames, fps, args.name, args.creator, payload, args.upper_body_only
        )
        BASE.strip_morph_keys(body)
        atlas = BASE.create_skin_atlas(body, args.work_dir)
        placement = BASE.place_character(body, rig, start, end)
        BASE.export_glb(body, rig, args.output.resolve(), start, end)
        if args.poster:
            BASE.render_poster(body, rig, args.poster.resolve(), start + (end - start) // 4)
    print(json.dumps({
        "ok": True,
        "output": str(args.output.resolve()),
        "bytes": args.output.stat().st_size,
        "frames": end - start + 1,
        "fps": fps,
        "durationSeconds": (end - start) / fps,
        "placementMeters": list(placement),
        "skinAtlas": str(atlas),
    }))


if __name__ == "__main__":
    main()
