"""Export normalized joint motion as an animated diagnostic ragdoll GLB."""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--motion", required=True)
    parser.add_argument("--output", required=True)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def material(name, color):
    item = bpy.data.materials.new(name)
    item.diffuse_color = (*color, 1.0)
    item.metallic = 0.0
    item.roughness = 0.72
    return item


def set_keyframes(obj, frame, location, scale=None, rotation=None):
    obj.location = location
    obj.keyframe_insert(data_path="location", frame=frame)
    if scale is not None:
        obj.scale = scale
        obj.keyframe_insert(data_path="scale", frame=frame)
    if rotation is not None:
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = rotation
        obj.keyframe_insert(data_path="rotation_quaternion", frame=frame)


def main():
    args = parse_args()
    with open(args.job, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    with open(args.motion, "r", encoding="utf-8") as handle:
        motion = json.load(handle)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    scene = bpy.context.scene
    scene.frame_start = 0
    scene.frame_end = len(motion["frames"]) - 1
    scene.render.fps = round(motion["fps"])

    root = bpy.data.objects.new("FitTimerAvatar", None)
    root["schemaVersion"] = 1
    root["movementId"] = job["movementId"]
    root["creatorId"] = job["creator"]["id"]
    root["creatorName"] = job["creator"]["name"]
    root["sourceUrl"] = job["source"]["url"]
    root["sourceVideoId"] = job["source"]["videoId"]
    root["sourceStartSeconds"] = job["source"]["timeRange"]["startSeconds"]
    root["sourceEndSeconds"] = job["source"]["timeRange"]["endSeconds"]
    root["side"] = job["side"]
    root["equipment"] = ",".join(job["equipment"])
    root["mocapProvider"] = job["mocapAsset"]["provider"]
    root["mocapResultPath"] = job["mocapAsset"]["resultPath"]
    root["motionPath"] = job["mocapAsset"]["motionPath"]
    root["trackingConfidence"] = job["confidence"]["tracking"] if job["confidence"]["tracking"] is not None else -1.0
    root["reviewStatus"] = job["confidence"]["review"]
    scene.collection.objects.link(root)

    joint_material = material("JointMaterial", (0.78, 1.0, 0.24))
    bone_material = material("BoneMaterial", (0.15, 0.62, 1.0))
    joint_objects = {}
    bone_objects = {}

    for joint in motion["joints"]:
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.045)
        obj = bpy.context.object
        obj.name = f"joint:{joint}"
        obj.parent = root
        obj.data.materials.append(joint_material)
        joint_objects[joint] = obj

    for joint, parent in motion["parents"].items():
        if parent is None:
            continue
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.028, depth=1.0)
        obj = bpy.context.object
        obj.name = f"bone:{parent}->{joint}"
        obj.parent = root
        obj.data.materials.append(bone_material)
        bone_objects[joint] = obj

    for frame_index, frame in enumerate(motion["frames"]):
        joints = {name: Vector(value) for name, value in frame["joints"].items()}
        for joint, obj in joint_objects.items():
            set_keyframes(obj, frame_index, joints[joint])
        for joint, obj in bone_objects.items():
            parent = motion["parents"][joint]
            start = joints[parent]
            end = joints[joint]
            delta = end - start
            length = max(delta.length, 0.001)
            midpoint = (start + end) * 0.5
            rotation = delta.to_track_quat("Z", "Y")
            set_keyframes(obj, frame_index, midpoint, (1.0, 1.0, length), rotation)

    output = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_animations=True,
        export_extras=True,
        export_frame_range=True,
        export_force_sampling=True,
        export_yup=True,
    )
    if not os.path.isfile(output) or os.path.getsize(output) == 0:
        raise RuntimeError("Blender did not create the GLB output")
    print(json.dumps({"ok": True, "output": output, "frames": len(motion["frames"])}))


if __name__ == "__main__":
    main()
