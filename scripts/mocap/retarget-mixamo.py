#!/usr/bin/env python3
"""Retarget normalized joint positions to a skinned Mixamo-compatible GLB.

Run through Blender:

    blender --background --factory-startup --python retarget-mixamo.py -- \
      --target Michelle.glb --motion motion.json --output exercise.glb

The source positions drive the visible limb directions. Blender bakes those
constraints into the target armature before glTF export, so the browser receives
one ordinary skinned mesh and one loopable animation clip.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

MIXAMO = "mixamorig:"
CANONICAL_ALIASES = {
    "pelvis": ("pelvis", "Hips"),
    "neck": ("neck", "Neck2", "Neck1", "Chest"),
    "head": ("nose", "Head", "HeadEnd"),
    "leftShoulder": ("leftShoulder", "LeftShoulder", "LeftArm"),
    "leftElbow": ("leftElbow", "LeftForeArm"),
    "leftWrist": ("leftWrist", "LeftHand"),
    "rightShoulder": ("rightShoulder", "RightShoulder", "RightArm"),
    "rightElbow": ("rightElbow", "RightForeArm"),
    "rightWrist": ("rightWrist", "RightHand"),
    "leftHip": ("leftHip", "LeftLeg"),
    "leftKnee": ("leftKnee", "LeftShin"),
    "leftAnkle": ("leftAnkle", "LeftFoot"),
    "rightHip": ("rightHip", "RightLeg"),
    "rightKnee": ("rightKnee", "RightShin"),
    "rightAnkle": ("rightAnkle", "RightFoot"),
}

ROTATION_TRACKS = {
    # COCO/GVHMR's "nose" is a facial direction, not the crown of the head.
    # Driving the neck-to-head bone toward it pitches the entire head forward.
    # The pelvis-to-neck torso axis is the stable anatomical up direction.
    "Neck": ("pelvis", "neck", "Head"),
    "LeftArm": ("leftShoulder", "leftElbow", "LeftForeArm"),
    "LeftForeArm": ("leftElbow", "leftWrist", "LeftHand"),
    "RightArm": ("rightShoulder", "rightElbow", "RightForeArm"),
    "RightForeArm": ("rightElbow", "rightWrist", "RightHand"),
    "LeftUpLeg": ("leftHip", "leftKnee", "LeftLeg"),
    "LeftLeg": ("leftKnee", "leftAnkle", "LeftFoot"),
    "RightUpLeg": ("rightHip", "rightKnee", "RightLeg"),
    "RightLeg": ("rightKnee", "rightAnkle", "RightFoot"),
}


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--motion", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--name", default="Exercise loop")
    parser.add_argument("--start-frame", type=int)
    parser.add_argument("--end-frame", type=int)
    parser.add_argument("--min-loop-seconds", type=float, default=2.0)
    parser.add_argument("--max-loop-seconds", type=float, default=6.0)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def load_motion(path):
    with open(path, encoding="utf-8") as handle:
        try:
            motion = json.JSONDecoder().decode(handle.read())
        except json.JSONDecodeError as error:
            raise ValueError(f"motion contains invalid JSON: {error}") from error
    fps = float(motion.get("fps", 0))
    frames = motion.get("frames")
    if (
        not math.isfinite(fps)
        or fps <= 0
        or not isinstance(frames, list)
        or len(frames) < 3
    ):
        raise ValueError("motion must contain positive fps and at least three frames")
    if motion.get("coordinateSystem") != {
        "up": "Z",
        "forward": "-Y",
        "units": "meters",
    }:
        raise ValueError("motion must use the FitTimer meters/Z-up/-Y-forward contract")
    return motion


def canonical_frame(frame):
    source = frame.get("joints", {})
    result = {}
    for canonical, aliases in CANONICAL_ALIASES.items():
        for alias in aliases:
            if alias in source:
                point = source[alias]
                if len(point) != 3 or not all(
                    math.isfinite(float(value)) for value in point
                ):
                    raise ValueError(f"invalid position for {alias}")
                result[canonical] = Vector(point)
                break
        if canonical not in result:
            raise ValueError(
                f"motion is missing {canonical}; accepted aliases: {aliases}"
            )
    # Preserve anatomical joint names and the captured world heading. A
    # side-on subject can have left/right separation mainly on Y; reflecting X
    # in that case reverses flexion while leaving the torso unchanged.
    return result


def loop_score(left, right):
    distances = [(left[name] - right[name]).length for name in left]
    return sum(distances) / len(distances) + max(distances) * 0.25


def choose_window(frames, fps, start_frame, end_frame, minimum, maximum):
    if start_frame is not None or end_frame is not None:
        start = 0 if start_frame is None else start_frame
        end = len(frames) - 1 if end_frame is None else end_frame
        if start < 0 or end >= len(frames) or end <= start:
            raise ValueError("invalid explicit loop window")
        return start, end, loop_score(frames[start], frames[end])
    min_gap = max(2, round(minimum * fps))
    max_gap = min(len(frames) - 1, round(maximum * fps))
    if min_gap > max_gap:
        raise ValueError("motion is shorter than the requested loop window")
    candidates = (
        (loop_score(frames[start], frames[start + gap]), start, start + gap)
        for gap in range(min_gap, max_gap + 1)
        for start in range(len(frames) - gap)
    )
    score, start, end = min(candidates)
    return start, end, score


def imported_character(target):
    bpy.ops.import_scene.gltf(filepath=str(Path(target).resolve()))
    for item in bpy.context.scene.objects:
        item.animation_data_clear()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    armatures = [item for item in bpy.context.scene.objects if item.type == "ARMATURE"]
    if not armatures:
        raise ValueError("target GLB has no armature")
    armature = max(armatures, key=lambda item: len(item.data.bones))
    if f"{MIXAMO}Hips" not in armature.data.bones:
        raise ValueError("target armature is not Mixamo-compatible")
    skinned = [
        item
        for item in bpy.context.scene.objects
        if item.type == "MESH"
        and any(
            modifier.type == "ARMATURE" and modifier.object == armature
            for modifier in item.modifiers
        )
    ]
    if not skinned:
        raise ValueError("target GLB has no mesh skinned to its Mixamo armature")
    keep = {armature, *skinned}
    for item in list(bpy.context.scene.objects):
        if item not in keep:
            bpy.data.objects.remove(item, do_unlink=True)
    return armature, skinned


def world_head(armature, bone_name):
    return (
        armature.matrix_world @ armature.data.bones[f"{MIXAMO}{bone_name}"].head_local
    )


def scale_and_origin(armature, first):
    model_torso = (world_head(armature, "Head") - world_head(armature, "Hips")).length
    source_torso = (first["head"] - first["pelvis"]).length
    if source_torso <= 1e-6:
        raise ValueError("source torso length is zero")
    scale = model_torso / source_torso
    model_hips = world_head(armature, "Hips")
    base_location = Vector((0.0, 0.0, first["pelvis"].z * scale - model_hips.z))
    origin = model_hips + base_location - first["pelvis"] * scale
    return scale, origin, base_location


def add_target(name):
    target = bpy.data.objects.new(f"target:{name}", None)
    target.empty_display_type = "PLAIN_AXES"
    target.hide_render = True
    bpy.context.scene.collection.objects.link(target)
    return target


def world_rest_rotation(armature, bone):
    return (
        armature.matrix_world.to_quaternion() @ bone.matrix_local.to_quaternion()
    ).normalized()


def world_rest_direction(armature, bone, child):
    direction = child.head_local - bone.head_local
    return (armature.matrix_world.to_3x3() @ direction).normalized()


def configure_constraints(armature, targets):
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="POSE")
    constrained = []
    hips_pose = armature.pose.bones.get(f"{MIXAMO}Hips")
    hips_bone = armature.data.bones.get(f"{MIXAMO}Hips")
    if hips_pose is None or hips_bone is None:
        raise ValueError("target armature has no Mixamo hips")
    hips_target = targets["rotation:Hips"]
    hips_constraint = hips_pose.constraints.new(type="COPY_ROTATION")
    hips_constraint.target = hips_target
    hips_constraint.target_space = "WORLD"
    hips_constraint.owner_space = "WORLD"
    hips_constraint.mix_mode = "REPLACE"
    constrained.append(hips_pose)
    hips_rest_rotation = world_rest_rotation(armature, hips_bone)

    rotation_specs = {}
    for bone_name, (source_start, source_end, child_name) in ROTATION_TRACKS.items():
        pose_bone = armature.pose.bones.get(f"{MIXAMO}{bone_name}")
        bone = armature.data.bones.get(f"{MIXAMO}{bone_name}")
        child = armature.data.bones.get(f"{MIXAMO}{child_name}")
        if pose_bone is None or bone is None or child is None:
            continue
        target = targets[f"rotation:{bone_name}"]
        constraint = pose_bone.constraints.new(type="COPY_ROTATION")
        constraint.target = target
        constraint.target_space = "WORLD"
        constraint.owner_space = "WORLD"
        constraint.mix_mode = "REPLACE"
        constrained.append(pose_bone)
        rotation_specs[bone_name] = (
            source_start,
            source_end,
            world_rest_direction(armature, bone, child),
            world_rest_rotation(armature, bone),
        )

    foot_rest_rotations = {}
    for bone_name in ("LeftFoot", "RightFoot"):
        pose_bone = armature.pose.bones.get(f"{MIXAMO}{bone_name}")
        bone = armature.data.bones.get(f"{MIXAMO}{bone_name}")
        if pose_bone is None or bone is None:
            continue
        target = targets[f"rotation:{bone_name}"]
        constraint = pose_bone.constraints.new(type="COPY_ROTATION")
        constraint.target = target
        constraint.target_space = "WORLD"
        constraint.owner_space = "WORLD"
        constraint.mix_mode = "REPLACE"
        constrained.append(pose_bone)
        foot_rest_rotations[bone_name] = world_rest_rotation(armature, bone)
    bpy.ops.object.mode_set(mode="OBJECT")
    return constrained, rotation_specs, hips_rest_rotation, foot_rest_rotations


def torso_rotation(source_frame):
    source_up = source_frame["neck"] - source_frame["pelvis"]
    source_left = (
        source_frame["leftShoulder"]
        - source_frame["rightShoulder"]
        + source_frame["leftHip"]
        - source_frame["rightHip"]
    )
    if source_up.length <= 1e-6 or source_left.length <= 1e-6:
        raise ValueError("source torso axes are degenerate")
    source_up.normalize()
    source_left = source_left - source_up * source_left.dot(source_up)
    if source_left.length <= 1e-6:
        raise ValueError("source torso left/up axes are parallel")
    source_left.normalize()
    source_forward = source_left.cross(source_up).normalized()
    source_basis = Matrix((source_left, source_up, source_forward)).transposed()
    # FitTimer's canonical anatomical axes are left=+X, up=+Z,
    # forward=-Y. Map that rest frame onto the captured torso frame.
    canonical_basis = Matrix(((1.0, 0.0, 0.0), (0.0, 0.0, -1.0), (0.0, 1.0, 0.0)))
    return (source_basis @ canonical_basis.transposed()).to_quaternion().normalized()


def torso_heading_rotation(source_frame):
    source_left = (
        source_frame["leftShoulder"]
        - source_frame["rightShoulder"]
        + source_frame["leftHip"]
        - source_frame["rightHip"]
    )
    source_left.z = 0.0
    if source_left.length <= 1e-6:
        return Matrix.Identity(3).to_quaternion()
    source_left.normalize()
    world_up = Vector((0.0, 0.0, 1.0))
    source_forward = source_left.cross(world_up).normalized()
    source_basis = Matrix((source_left, world_up, source_forward)).transposed()
    canonical_basis = Matrix(((1.0, 0.0, 0.0), (0.0, 0.0, -1.0), (0.0, 1.0, 0.0)))
    return (source_basis @ canonical_basis.transposed()).to_quaternion().normalized()


def animate(
    armature,
    targets,
    rotation_specs,
    hips_rest_rotation,
    foot_rest_rotations,
    frames,
    start,
    end,
    fps,
    scale,
    origin,
    base_location,
):
    scene = bpy.context.scene
    scene.render.fps = round(fps)
    scene.frame_start = 1
    scene.frame_end = end - start + 1
    source_origin = frames[start]["pelvis"].copy()
    model_hips = world_head(armature, "Hips")
    for output_frame, source_frame in enumerate(frames[start : end + 1], 1):
        root_delta = (source_frame["pelvis"] - source_origin) * scale
        armature.location = base_location + root_delta
        armature.keyframe_insert(data_path="location", frame=output_frame)
        for name, point in source_frame.items():
            targets[name].location = origin + point * scale + root_delta * 0
            targets[name].keyframe_insert(data_path="location", frame=output_frame)
        captured_torso_rotation = torso_rotation(source_frame)
        captured_heading_rotation = torso_heading_rotation(source_frame)
        hips_target = targets["rotation:Hips"]
        hips_target.rotation_mode = "QUATERNION"
        hips_target.rotation_quaternion = captured_torso_rotation @ hips_rest_rotation
        hips_target.keyframe_insert(data_path="rotation_quaternion", frame=output_frame)
        for bone_name, (
            source_start,
            source_end,
            rest_direction,
            rest_rotation,
        ) in rotation_specs.items():
            direction = (
                source_frame[source_end] - source_frame[source_start]
            ).normalized()
            rotation_target = targets[f"rotation:{bone_name}"]
            rotation_target.rotation_mode = "QUATERNION"
            rotation_target.rotation_quaternion = (
                rest_direction.rotation_difference(direction) @ rest_rotation
            ).normalized()
            rotation_target.keyframe_insert(
                data_path="rotation_quaternion", frame=output_frame
            )
        for bone_name, rest_rotation in foot_rest_rotations.items():
            foot_target = targets[f"rotation:{bone_name}"]
            foot_target.rotation_mode = "QUATERNION"
            foot_target.rotation_quaternion = captured_heading_rotation @ rest_rotation
            foot_target.keyframe_insert(
                data_path="rotation_quaternion", frame=output_frame
            )
    # Make the last frame numerically identical to the first for an explicit seam.
    scene.frame_set(1)
    first_root = armature.location.copy()
    first_targets = {name: target.location.copy() for name, target in targets.items()}
    first_rotations = {
        name: target.rotation_quaternion.copy()
        for name, target in targets.items()
        if target.rotation_mode == "QUATERNION"
    }
    scene.frame_set(scene.frame_end)
    armature.location = first_root
    armature.keyframe_insert(data_path="location", frame=scene.frame_end)
    for name, target in targets.items():
        target.location = first_targets[name]
        target.keyframe_insert(data_path="location", frame=scene.frame_end)
        if name in first_rotations:
            target.rotation_quaternion = first_rotations[name]
            target.keyframe_insert(
                data_path="rotation_quaternion", frame=scene.frame_end
            )
    scene.frame_set(1)
    return model_hips


def evaluated_mesh_minimum_z(meshes):
    dependency_graph = bpy.context.evaluated_depsgraph_get()
    minimum = math.inf
    for mesh in meshes:
        evaluated = mesh.evaluated_get(dependency_graph)
        evaluated_mesh = evaluated.to_mesh()
        try:
            matrix = evaluated.matrix_world
            for vertex in evaluated_mesh.vertices:
                minimum = min(minimum, (matrix @ vertex.co).z)
        finally:
            evaluated.to_mesh_clear()
    if not math.isfinite(minimum):
        raise ValueError("could not measure the skinned target's ground contact")
    return minimum


def ground_non_flight_animation(armature, meshes, start, end):
    scene = bpy.context.scene
    corrections = []
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        correction = -evaluated_mesh_minimum_z(meshes)
        armature.location.z += correction
        armature.keyframe_insert(data_path="location", frame=frame)
        corrections.append(correction)
    scene.frame_set(start)
    return corrections


def direction_error_degrees(actual, expected):
    if actual.length <= 1e-6 or expected.length <= 1e-6:
        raise ValueError("cannot compare a zero-length joint direction")
    cosine = max(-1.0, min(1.0, actual.normalized().dot(expected.normalized())))
    return math.degrees(math.acos(cosine))


def posed_bone_direction(armature, bone_name, child_name):
    bone = armature.pose.bones.get(f"{MIXAMO}{bone_name}")
    child = armature.pose.bones.get(f"{MIXAMO}{child_name}")
    if bone is None or child is None:
        raise ValueError(f"target armature is missing {bone_name} or {child_name}")
    return armature.matrix_world.to_3x3() @ (child.head - bone.head)


def verify_baked_motion(armature, meshes, frames, source_start, source_end):
    """Reject a plausible-looking GLB whose baked joints do not follow the source.

    Container checks can prove that a file has a skin and animation channels but
    cannot detect a reversed knee, twisted head, or floating model. Measure the
    deformed result at every exported frame instead.
    """
    scene = bpy.context.scene
    direction_errors = []
    foot_direction_errors = []
    ground_errors = []
    output_end = source_end - source_start + 1
    for output_frame in range(1, output_end + 1):
        scene.frame_set(output_frame)
        bpy.context.view_layer.update()
        # animate() makes the final frame identical to frame 1 to close the seam.
        source_frame = frames[
            source_start
            if output_frame == output_end
            else source_start + output_frame - 1
        ]
        for bone_name, (
            source_name,
            target_name,
            child_name,
        ) in ROTATION_TRACKS.items():
            actual = posed_bone_direction(armature, bone_name, child_name)
            expected = source_frame[target_name] - source_frame[source_name]
            direction_errors.append(direction_error_degrees(actual, expected))
        captured_heading = torso_heading_rotation(source_frame)
        for bone_name, child_name in (
            ("LeftFoot", "LeftToeBase"),
            ("RightFoot", "RightToeBase"),
        ):
            actual = posed_bone_direction(armature, bone_name, child_name)
            rest_bone = armature.data.bones[f"{MIXAMO}{bone_name}"]
            rest_child = armature.data.bones[f"{MIXAMO}{child_name}"]
            rest = world_rest_direction(armature, rest_bone, rest_child)
            foot_direction_errors.append(
                direction_error_degrees(actual, captured_heading @ rest)
            )
        ground_errors.append(abs(evaluated_mesh_minimum_z(meshes)))
    scene.frame_set(1)
    result = {
        "maxJointDirectionErrorDegrees": max(direction_errors),
        "meanJointDirectionErrorDegrees": sum(direction_errors) / len(direction_errors),
        "maxFootDirectionErrorDegrees": max(foot_direction_errors),
        "maxGroundErrorMeters": max(ground_errors),
    }
    if result["maxJointDirectionErrorDegrees"] > 3.0:
        raise ValueError(
            "baked joint direction diverges from source by "
            f"{result['maxJointDirectionErrorDegrees']:.3f} degrees"
        )
    if result["maxFootDirectionErrorDegrees"] > 3.0:
        raise ValueError(
            "baked foot diverges from the level target by "
            f"{result['maxFootDirectionErrorDegrees']:.3f} degrees"
        )
    if result["maxGroundErrorMeters"] > 0.002:
        raise ValueError(
            "baked mesh misses the ground by "
            f"{result['maxGroundErrorMeters']:.6f} meters"
        )
    return result


def bake(armature, _constrained, start, end):
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.nla.bake(
        frame_start=start,
        frame_end=end,
        step=1,
        only_selected=False,
        visual_keying=True,
        clear_constraints=True,
        clear_parents=False,
        use_current_action=True,
        clean_curves=True,
        bake_types={"POSE"},
    )
    bpy.ops.object.mode_set(mode="OBJECT")


def polish_materials(skinned):
    for mesh in skinned:
        for material in mesh.data.materials:
            if material is None:
                continue
            material.diffuse_color = (0.32, 0.44, 0.51, 1.0)
            material.metallic = 0.0
            material.roughness = 0.58
        mesh["fitTimerSkinnedTarget"] = True


def main():
    args = arguments()
    motion = load_motion(args.motion)
    frames = [canonical_frame(frame) for frame in motion["frames"]]
    start, end, score = choose_window(
        frames,
        float(motion["fps"]),
        args.start_frame,
        args.end_frame,
        args.min_loop_seconds,
        args.max_loop_seconds,
    )
    armature, skinned = imported_character(args.target)
    scale, origin, base_location = scale_and_origin(armature, frames[start])
    targets = {
        name: add_target(name)
        for name in (
            *CANONICAL_ALIASES,
            "rotation:Hips",
            "rotation:LeftFoot",
            "rotation:RightFoot",
            *(f"rotation:{name}" for name in ROTATION_TRACKS),
        )
    }
    constrained, rotation_specs, hips_rest_rotation, foot_rest_rotations = (
        configure_constraints(armature, targets)
    )
    animate(
        armature,
        targets,
        rotation_specs,
        hips_rest_rotation,
        foot_rest_rotations,
        frames,
        start,
        end,
        float(motion["fps"]),
        scale,
        origin,
        base_location,
    )
    bake(armature, constrained, 1, end - start + 1)
    ground_corrections = ground_non_flight_animation(
        armature, skinned, 1, end - start + 1
    )
    verification = verify_baked_motion(armature, skinned, frames, start, end)
    polish_materials(skinned)
    armature["fitTimerMotion"] = {
        "sourceMotion": Path(args.motion).name,
        "loopStartFrame": start,
        "loopEndFrame": end,
        "sourceSeamScoreMeters": score,
        "groundCorrectionRangeMeters": [
            min(ground_corrections),
            max(ground_corrections),
        ],
        "retargetSpace": "world-rest-basis-v2",
        "verification": verification,
    }
    if armature.animation_data and armature.animation_data.action:
        armature.animation_data.action.name = args.name
    for target in targets.values():
        bpy.data.objects.remove(target, do_unlink=True)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(output),
                "target": Path(args.target).name,
                "skinnedMeshes": [item.name for item in skinned],
                "frames": end - start + 1,
                "fps": float(motion["fps"]),
                "loopStartFrame": start,
                "loopEndFrame": end,
                "sourceSeamScoreMeters": score,
                "groundCorrectionRangeMeters": [
                    min(ground_corrections),
                    max(ground_corrections),
                ],
                "verification": verification,
                "bytes": output.stat().st_size,
            }
        )
    )


if __name__ == "__main__":
    main()
