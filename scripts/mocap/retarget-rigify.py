#!/usr/bin/env python3
"""Retarget a skinned SMPL-X exercise GLB to the pinned Vitruvian Rigify body.

The transfer aligns native Rigify FK controls to evaluated SMPL-X joint
directions. This preserves the target's segment lengths, native knee/elbow
sliding joints, and laterality; it never stretches limbs to fit a source body.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

# Parent controls precede children so each swing is solved in the already
# posed parent frame. SMPL-X joint heads are the anatomical observations; its
# Blender bone tails and local axes are exporter details and cannot be used as
# limb directions.
DIRECTION_MAP = (
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

# The description-built source deliberately uses held endpoints around each
# of its three anatomical poses. Retargeting these authored keys is both more
# faithful and much faster than sampling Rigify's 1,000-bone constraint graph
# on every exported frame. Blender still bakes a smooth 15-second web clip.
KEY_TIMES_SECONDS = (0.0, 0.75, 3.25, 3.75, 6.25, 7.5, 10.0, 10.5, 13.0, 15.0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--poster", type=Path)
    parser.add_argument("--name", default="Dead bug · Vitruvian")
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def validate_inputs(args: argparse.Namespace) -> None:
    for name in ("target", "source"):
        path = getattr(args, name).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"{name} is missing: {path}")
    if args.output.exists() and not args.replace:
        raise FileExistsError(f"Refusing to replace existing GLB: {args.output}")
    if args.poster and args.poster.exists() and not args.replace:
        raise FileExistsError(f"Refusing to replace existing poster: {args.poster}")


def load_target(path: Path) -> tuple[bpy.types.Object, bpy.types.Object]:
    bpy.ops.wm.open_mainfile(filepath=str(path.resolve()))
    body = bpy.data.objects.get("cm_vitruvian")
    rig = bpy.data.objects.get("cm_vitruvian_rig")
    if not body or body.type != "MESH" or not rig or rig.type != "ARMATURE":
        raise RuntimeError("Target is not the pinned Vitruvian Rigify character")
    # Control widgets and any factory-scene objects are authoring aids, not
    # dependencies of the deform skeleton. Detach them before web export.
    for pose_bone in rig.pose.bones:
        pose_bone.custom_shape = None
    for item in list(bpy.data.objects):
        if item not in (body, rig):
            bpy.data.objects.remove(item, do_unlink=True)
    for _, _, target_name in DIRECTION_MAP:
        if target_name not in rig.pose.bones:
            raise RuntimeError(f"Target is missing Rigify control {target_name}")
    if "root" not in rig.pose.bones:
        raise RuntimeError("Target is missing Rigify root control")
    return body, rig


def load_source(path: Path) -> tuple[bpy.types.Object, bpy.types.Action]:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    imported = set(bpy.data.objects) - before
    armatures = [item for item in imported if item.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError("Source GLB must contain exactly one armature")
    armature = armatures[0]
    action = armature.animation_data.action if armature.animation_data else None
    if action is None:
        raise RuntimeError("Source GLB has no active animation")
    source_names = {"pelvis"}
    for source_start, source_end, _ in DIRECTION_MAP:
        source_names.update((source_start, source_end))
    for source_name in source_names:
        if source_name not in armature.pose.bones:
            raise RuntimeError(f"Source is missing SMPL-X bone {source_name}")
    return armature, action


def clear_target_pose(rig: bpy.types.Object) -> None:
    for item in ("upper_arm_parent.L", "upper_arm_parent.R", "thigh_parent.L", "thigh_parent.R"):
        # Rigify's slider is 1.0 for the FK controls used by this transfer.
        rig.pose.bones[item]["IK_FK"] = 1.0
    for bone in rig.pose.bones:
        bone.matrix_basis.identity()
        bone.rotation_mode = "QUATERNION"
    bpy.context.view_layer.update()


def set_root_pose(
    source: bpy.types.Object,
    target: bpy.types.Object,
) -> bpy.types.PoseBone:
    source_pose = source.pose.bones["pelvis"]
    target_pose = target.pose.bones["root"]
    source_rest_world = source.matrix_world @ source_pose.bone.matrix_local
    target_rest_world = target.matrix_world @ target_pose.bone.matrix_local
    source_pose_world = source.matrix_world @ source_pose.matrix
    delta_world = source_pose_world @ source_rest_world.inverted_safe()
    desired_world = delta_world @ target_rest_world
    target_pose.matrix = target.matrix_world.inverted_safe() @ desired_world
    bpy.context.view_layer.update()
    return target_pose


def align_segment(
    source: bpy.types.Object,
    target: bpy.types.Object,
    source_start: str,
    source_end: str,
    target_name: str,
) -> bpy.types.PoseBone:
    start = source.matrix_world @ source.pose.bones[source_start].head
    end = source.matrix_world @ source.pose.bones[source_end].head
    desired_world = end - start
    if desired_world.length_squared < 1e-10:
        raise RuntimeError(f"Source segment {source_start} -> {source_end} collapsed")
    desired_armature = (
        target.matrix_world.inverted_safe().to_3x3() @ desired_world
    ).normalized()

    pose = target.pose.bones[target_name]
    current = pose.tail - pose.head
    if current.length_squared < 1e-10:
        raise RuntimeError(f"Target segment {target_name} collapsed")
    swing = current.normalized().rotation_difference(desired_armature)
    pose.matrix = Matrix.LocRotScale(
        pose.matrix.translation,
        swing @ pose.matrix.to_quaternion(),
        Vector((1.0, 1.0, 1.0)),
    )
    bpy.context.view_layer.update()
    return pose


def transfer_animation(
    source: bpy.types.Object,
    source_action: bpy.types.Action,
    target: bpy.types.Object,
    name: str,
) -> tuple[int, int, int]:
    scene = bpy.context.scene
    start = math.floor(source_action.frame_range[0])
    end = math.ceil(source_action.frame_range[1])
    scene.frame_start = start
    scene.frame_end = end
    motion = source.get("fitTimerMotion", {})
    loop_seconds = float(motion.get("loopSeconds", 0))
    fps = (
        round((end - start) / loop_seconds)
        if loop_seconds > 0
        else scene.render.fps
    )
    if fps <= 0:
        raise RuntimeError("Source animation has no valid frame rate")
    scene.render.fps = fps
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"

    if target.animation_data:
        # Keep Rigify's constraint drivers; animation_data_clear() removes
        # them and leaves the deform skeleton frozen in its rest pose.
        target.animation_data.action = None
    clear_target_pose(target)
    keyframes = sorted(
        {
            max(start, min(end, round(start + seconds * fps)))
            for seconds in KEY_TIMES_SECONDS
        }
    )
    for frame in keyframes:
        scene.frame_set(frame)
        root = set_root_pose(source, target)
        root.keyframe_insert("location", frame=frame, group="root")
        root.keyframe_insert("rotation_quaternion", frame=frame, group="root")
        for source_start, source_end, target_name in DIRECTION_MAP:
            pose = align_segment(
                source, target, source_start, source_end, target_name
            )
            pose.keyframe_insert("rotation_quaternion", frame=frame, group=target_name)

    action = target.animation_data.action if target.animation_data else None
    if action is None:
        raise RuntimeError("Retargeting did not create a target action")
    action.name = name
    target["fitTimerMotion"] = {
        "kind": "fitTimerRetargetedMotion",
        "source": "deadbug-described-smplx.glb",
        "method": "SMPL-X joint directions to native Rigify FK controls",
        "authoredKeys": len(keyframes),
        "frames": end - start + 1,
        "fps": fps,
        "durationSeconds": (end - start) / fps,
        "loop": True,
        "openSim": False,
    }
    return start, end, fps


def strip_morph_keys(body: bpy.types.Object) -> None:
    keys = body.data.shape_keys
    if not keys or not keys.key_blocks:
        return
    final = keys.key_blocks.get("charmorph_final")
    if final is None:
        raise RuntimeError("Vitruvian final morph key is missing")
    coords = np.empty(len(final.data) * 3, dtype=np.float32)
    final.data.foreach_get("co", coords)
    body.data.vertices.foreach_set("co", coords)
    keys.animation_data_clear()
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    bpy.ops.object.shape_key_remove(all=True, apply_mix=False)
    body.select_set(False)


def simple_material(name: str, color: tuple[float, float, float, float], roughness: float = 0.6) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    return material


def create_skin_atlas(body: bpy.types.Object, work_dir: Path) -> Path:
    source = next(
        (image for image in bpy.data.images if "Light_Skin_Color" in image.name),
        None,
    )
    if source is None or "<UDIM>" not in source.filepath:
        raise RuntimeError("Vitruvian light-skin UDIM source is missing")
    tile_size = 1024
    atlas_size = tile_size * 2
    pixels = np.zeros((atlas_size, atlas_size, 4), dtype=np.float32)
    for tile_index, tile_number in enumerate(range(1001, 1005)):
        path = Path(bpy.path.abspath(source.filepath.replace("<UDIM>", str(tile_number))))
        image = bpy.data.images.load(str(path), check_existing=False)
        image.scale(tile_size, tile_size)
        tile = np.empty(tile_size * tile_size * 4, dtype=np.float32)
        image.pixels.foreach_get(tile)
        tile = tile.reshape((tile_size, tile_size, 4))
        row, column = divmod(tile_index, 2)
        pixels[
            row * tile_size : (row + 1) * tile_size,
            column * tile_size : (column + 1) * tile_size,
        ] = tile
        bpy.data.images.remove(image)

    work_dir.mkdir(parents=True, exist_ok=True)
    output = work_dir / "vitruvian-light-skin-atlas.png"
    atlas = bpy.data.images.new("Vitruvian skin atlas", atlas_size, atlas_size)
    atlas.colorspace_settings.name = "sRGB"
    atlas.pixels.foreach_set(pixels.reshape(-1))
    atlas.file_format = "PNG"
    atlas.filepath_raw = str(output)
    atlas.save()

    skin_index = next(
        (
            index
            for index, slot in enumerate(body.material_slots)
            if slot.material and slot.material.name == "UDIM.Skin"
        ),
        None,
    )
    if skin_index is None:
        raise RuntimeError("Vitruvian skin material slot is missing")
    uv_layer = body.data.uv_layers.active
    if uv_layer is None:
        raise RuntimeError("Vitruvian body has no UV map")
    for polygon in body.data.polygons:
        if polygon.material_index != skin_index:
            continue
        for loop_index in polygon.loop_indices:
            uv = uv_layer.data[loop_index].uv
            tile = max(0, min(3, math.floor(uv.x)))
            row, column = divmod(tile, 2)
            uv.x = ((uv.x - tile) + column) / 2
            uv.y = (uv.y + row) / 2

    # Vitruvian carries seven authoring UV sets; its skin set is normally the
    # seventh. glTF preserves that as TEXCOORD_6, which exceeds the material UV
    # channels reliably available in Three.js. Copy the remapped skin UVs to
    # TEXCOORD_0 and remove the unused authoring layers from the web artifact.
    primary_uv = body.data.uv_layers[0]
    if primary_uv != uv_layer:
        for index, loop in enumerate(uv_layer.data):
            primary_uv.data[index].uv = loop.uv
    while len(body.data.uv_layers) > 1:
        body.data.uv_layers.remove(body.data.uv_layers[-1])
    body.data.uv_layers.active_index = 0
    primary_uv.active_render = True

    skin = bpy.data.materials.new("Vitruvian web skin")
    skin.use_nodes = True
    nodes = skin.node_tree.nodes
    for node in list(nodes):
        nodes.remove(node)
    output_node = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = atlas
    bsdf.inputs["Roughness"].default_value = 0.56
    bsdf.inputs["IOR"].default_value = 1.42
    skin.node_tree.links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    skin.node_tree.links.new(bsdf.outputs["BSDF"], output_node.inputs["Surface"])
    body.material_slots[skin_index].material = skin

    replacements = {
        "Iris": simple_material("Vitruvian iris", (0.045, 0.12, 0.14, 1.0), 0.32),
        "Mouth": simple_material("Vitruvian mouth", (0.36, 0.075, 0.065, 1.0), 0.58),
        "Pupil": simple_material("Vitruvian pupil", (0.004, 0.006, 0.007, 1.0), 0.26),
        "Sclera_Cornea": simple_material("Vitruvian sclera", (0.72, 0.72, 0.68, 1.0), 0.28),
        "charmorph_censor": simple_material("Vitruvian censor", (0.035, 0.19, 0.20, 1.0), 0.72),
        "EyeHair": simple_material("Vitruvian eye hair", (0.015, 0.008, 0.006, 1.0), 0.68),
        "Tearline": simple_material("Vitruvian tearline", (0.55, 0.6, 0.62, 1.0), 0.2),
    }
    for slot in body.material_slots:
        if slot.material and slot.material.name in replacements:
            slot.material = replacements[slot.material.name]

    outfit = simple_material("Vitruvian training kit", (0.035, 0.19, 0.20, 1.0), 0.72)
    body.data.materials.append(outfit)
    outfit_index = len(body.data.materials) - 1
    for polygon in body.data.polygons:
        if polygon.material_index != skin_index:
            continue
        center = sum((body.data.vertices[i].co for i in polygon.vertices), Vector()) / len(polygon.vertices)
        fitted_top = 1.08 <= center.z <= 1.37 and abs(center.x) <= 0.31
        fitted_shorts = 0.68 <= center.z <= 1.00 and abs(center.x) <= 0.34
        if fitted_top or fitted_shorts:
            polygon.material_index = outfit_index
    return output


def delete_source(source: bpy.types.Object) -> None:
    source_objects = {source}
    source_objects.update(
        item for item in bpy.data.objects if item.parent == source
    )
    source_action = source.animation_data.action if source.animation_data else None
    for item in source_objects:
        bpy.data.objects.remove(item, do_unlink=True)
    if source_action and source_action.users == 0:
        bpy.data.actions.remove(source_action)


def place_character(
    body: bpy.types.Object,
    rig: bpy.types.Object,
    start: int,
    end: int,
) -> tuple[float, float, float]:
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    minimum = float("inf")
    step = max(1, (end - start) // 60)
    for frame in range(start, end + 1, step):
        scene.frame_set(frame)
        evaluated = body.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            transform = evaluated.matrix_world
            minimum = min(
                minimum,
                min((transform @ vertex.co).z for vertex in mesh.vertices),
            )
        finally:
            evaluated.to_mesh_clear()
    z_offset = 0.018 - minimum
    rig.location.z += z_offset

    scene.frame_set(start)
    evaluated = body.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        points = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
        center_x = (min(point.x for point in points) + max(point.x for point in points)) / 2
        center_y = (min(point.y for point in points) + max(point.y for point in points)) / 2
    finally:
        evaluated.to_mesh_clear()
    rig.location.x -= center_x
    rig.location.y -= center_y
    return -center_x, -center_y, z_offset


def export_glb(
    body: bpy.types.Object,
    rig: bpy.types.Object,
    output: Path,
    start: int,
    end: int,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.context.scene.frame_start = start
    bpy.context.scene.frame_end = end
    result = bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_animation_mode="ACTIVE_ACTIONS",
        export_skins=True,
        export_def_bones=True,
        export_armature_object_remove=False,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_frame_range=True,
        export_force_sampling=True,
        export_sampling_interpolation_fallback="LINEAR",
        export_yup=True,
        export_image_format="AUTO",
    )
    if result != {"FINISHED"} or not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("Blender did not create the Vitruvian GLB")


def look_at(item: bpy.types.Object, target: Vector) -> None:
    item.rotation_euler = (target - item.location).to_track_quat("-Z", "Y").to_euler()


def render_poster(
    body: bpy.types.Object,
    rig: bpy.types.Object,
    poster: Path,
    frame: int,
) -> None:
    scene = bpy.context.scene
    scene.frame_set(frame)
    floor = bpy.data.meshes.new("Preview floor")
    floor_obj = bpy.data.objects.new("Preview floor", floor)
    scene.collection.objects.link(floor_obj)
    vertices = [(-2.4, -2.4, 0), (2.4, -2.4, 0), (2.4, 2.4, 0), (-2.4, 2.4, 0)]
    floor.from_pydata(vertices, [], [(0, 1, 2, 3)])
    floor_obj.data.materials.append(simple_material("Preview floor", (0.025, 0.035, 0.045, 1), 0.9))

    camera_data = bpy.data.cameras.new("Preview camera")
    camera = bpy.data.objects.new("Preview camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (2.4, -2.8, 2.35)
    look_at(camera, Vector((0, 0, 0.48)))
    camera_data.lens = 52
    scene.camera = camera
    for name, location, energy, size in (
        ("Key", (1.8, -1.0, 3.2), 950, 3.0),
        ("Fill", (-2.0, -0.5, 2.0), 600, 2.4),
        ("Rim", (0.0, 2.5, 2.2), 750, 2.0),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        light = bpy.data.objects.new(name, data)
        light.location = location
        look_at(light, Vector((0, 0, 0.5)))
        scene.collection.objects.link(light)

    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(poster)
    scene.render.film_transparent = False
    scene.world.color = (0.008, 0.012, 0.018)
    poster.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)


def main() -> None:
    args = parse_args()
    validate_inputs(args)
    args.work_dir.mkdir(parents=True, exist_ok=True)
    body, rig = load_target(args.target)
    source, source_action = load_source(args.source)
    start, end, fps = transfer_animation(source, source_action, rig, args.name)
    strip_morph_keys(body)
    atlas = create_skin_atlas(body, args.work_dir)
    delete_source(source)
    placement = place_character(body, rig, start, end)
    export_glb(body, rig, args.output.resolve(), start, end)
    if args.poster:
        render_poster(body, rig, args.poster.resolve(), start + (end - start) // 4)
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(args.output.resolve()),
                "bytes": args.output.stat().st_size,
                "frames": end - start + 1,
                "fps": fps,
                "durationSeconds": (end - start) / fps,
                "vertices": len(body.data.vertices),
                "rigBones": len(rig.data.bones),
                "placementMeters": list(placement),
                "skinAtlas": str(atlas),
                "poster": str(args.poster.resolve()) if args.poster else None,
            }
        )
    )


if __name__ == "__main__":
    main()
