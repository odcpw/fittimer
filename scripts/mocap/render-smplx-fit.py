#!/usr/bin/env python3
"""Render an SMPL-X fit frame for quick visual QA in Blender."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--fit", type=Path)
    source.add_argument("--glb", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--frame", type=int, default=0)
    parser.add_argument(
        "--view", choices=("side", "three-quarter", "top"), default="side"
    )
    return parser.parse_args(argv)


def look_at(camera: bpy.types.Object, point: Vector) -> None:
    camera.rotation_euler = (
        (point - camera.location).to_track_quat("-Z", "Y").to_euler()
    )


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    world = bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.color = (0.008, 0.011, 0.016)

    if args.glb:
        bpy.context.scene.render.fps = 30
        bpy.ops.import_scene.gltf(filepath=str(args.glb.resolve()))
        scene = bpy.context.scene
        scene.frame_set(args.frame)
        bodies = [item for item in scene.objects if item.type == "MESH"]
        if not bodies:
            raise ValueError("GLB has no visible body mesh")
        body = max(bodies, key=lambda item: len(item.data.vertices))
        vertex_count = len(body.data.vertices)
        face_count = len(body.data.polygons)
        armatures = [item for item in scene.objects if item.type == "ARMATURE"]
        pose_joints = {}
        if armatures:
            armature = max(armatures, key=lambda item: len(item.pose.bones))
            for name in (
                "pelvis",
                "left_shoulder",
                "left_elbow",
                "left_wrist",
                "left_hip",
                "left_knee",
                "left_ankle",
                "right_hip",
                "right_knee",
                "right_ankle",
            ):
                point = armature.matrix_world @ armature.pose.bones[name].head
                pose_joints[name] = [round(value, 6) for value in point]
    else:
        fit = np.load(args.fit)
        vertices = fit["vertices"]
        faces = fit["faces"]
        if not 0 <= args.frame < len(vertices):
            raise ValueError("Requested frame is outside the fit")
        # Source/Three.js is Y-up; Blender is Z-up.
        frame = vertices[args.frame][:, [0, 2, 1]]
        mesh = bpy.data.meshes.new("SMPL-X body")
        mesh.from_pydata(frame.tolist(), [], faces.tolist())
        mesh.update()
        body = bpy.data.objects.new("SMPL-X body", mesh)
        bpy.context.collection.objects.link(body)

        material = bpy.data.materials.new("Skin")
        material.diffuse_color = (0.52, 0.23, 0.16, 1.0)
        material.metallic = 0.0
        material.roughness = 0.64
        body.data.materials.append(material)
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        vertex_count = len(frame)
        face_count = len(faces)
        pose_joints = {}

    bpy.ops.mesh.primitive_plane_add(size=6, location=(0, 0, 0))
    floor = bpy.context.object
    floor_material = bpy.data.materials.new("Floor")
    floor_material.diffuse_color = (0.025, 0.035, 0.047, 1.0)
    floor_material.roughness = 0.9
    floor.data.materials.append(floor_material)

    bpy.ops.object.light_add(type="AREA", location=(-0.8, -2.2, 3.2))
    key = bpy.context.object
    key.data.energy = 900
    key.data.shape = "DISK"
    key.data.size = 3.0
    look_at(key, Vector((0, 0, 0.45)))
    bpy.ops.object.light_add(type="AREA", location=(1.8, 1.5, 2.0))
    rim = bpy.context.object
    rim.data.energy = 550
    rim.data.color = (1.0, 0.32, 0.22)
    rim.data.size = 2.0
    look_at(rim, Vector((0, 0, 0.4)))

    bpy.ops.object.camera_add()
    camera = bpy.context.object
    if args.view == "side":
        camera.location = (0.0, -3.65, 1.1)
    elif args.view == "top":
        camera.location = (0.0, 0.0, 4.0)
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = 2.35
    else:
        camera.location = (2.45, -2.85, 1.75)
    camera.data.lens = 58
    look_at(camera, Vector((0, 0, 0.48)))
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 560
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(args.output)
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.image_settings.color_mode = "RGBA"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)
    print(
        json.dumps(
            {
                "ok": True,
                "frame": args.frame,
                "view": args.view,
                "vertices": vertex_count,
                "faces": face_count,
                "poseJoints": pose_joints,
                "output": str(args.output),
            }
        )
    )


if __name__ == "__main__":
    main()
