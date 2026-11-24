#!/usr/bin/env python3
"""
Real-world style recordings written with the OFFICIAL MCAP writers (independent of
the app's TypeScript code), to verify that .lumen Replay reads "another recording":

  ros2_zstd.mcap          mcap-ros2-support, zstd chunks (default of `ros2 bag record`)
  ros2_lz4.mcap           same content, lz4 chunks
  ros2_unchunked.mcap     mcap Writer: no chunks, no index, no statistics, no summary
  ros1.mcap               mcap-ros1-support (ros1 encoding, ros1msg, CameraInfo with K/D)
  foxglove_protobuf.mcap  mcap-protobuf-support + foxglove-schemas-protobuf
  foxglove_json.mcap      Foxglove schemas in JSON (+jsonschema), bytes as base64
  misc_encodings.mcap     cbor & msgpack (schemaless), cdr+omgidl, cdr+ros2idl (root not
                          first), flatbuffer (unsupported → must not crash), uncompressed
  truncated.mcap          ros2_zstd cut at 60 %  (crash / partial recording)
  corrupt_chunk.mcap      ros2_zstd with bytes flipped inside a chunk (CRC mismatch)
  not_mcap.db3            a rosbag2 SQLite header (wrong format → clear error)

Every camera-like scenario has the same structure as the challenge: an input camera,
CameraInfo, IMU, static TF and a component publishing depth + point cloud with the
input's header stamp copied, ~50–60 ms later, with a dropped-frame burst.

Usage: python3 scripts/gen-realworld.py [out_dir]   (needs: pip install mcap
mcap-ros2-support mcap-ros1-support mcap-protobuf-support foxglove-schemas-protobuf
pillow cbor2 msgpack zstandard lz4)
"""
import base64
import io
import json
import math
import os
import struct
import sys

import cbor2
import msgpack
from PIL import Image as PILImage
from mcap.writer import CompressionType, IndexType, Writer
from mcap_ros1._vendor.genpy import dynamic as genpy_dynamic
from mcap_ros1.writer import Writer as Ros1Writer
from mcap_ros2.writer import Writer as Ros2Writer
from mcap_protobuf.writer import Writer as ProtobufWriter
from foxglove_schemas_protobuf.RawImage_pb2 import RawImage
from foxglove_schemas_protobuf.CompressedImage_pb2 import CompressedImage
from foxglove_schemas_protobuf.PointCloud_pb2 import PointCloud
from foxglove_schemas_protobuf.PackedElementField_pb2 import PackedElementField
from foxglove_schemas_protobuf.FrameTransforms_pb2 import FrameTransforms
from foxglove_schemas_protobuf.FrameTransform_pb2 import FrameTransform
from foxglove_schemas_protobuf.CameraCalibration_pb2 import CameraCalibration
from foxglove_schemas_protobuf.LaserScan_pb2 import LaserScan
from foxglove_schemas_protobuf.Log_pb2 import Log
from google.protobuf.timestamp_pb2 import Timestamp

OUT = sys.argv[1] if len(sys.argv) > 1 else "fixtures/realworld"
os.makedirs(OUT, exist_ok=True)

T0 = 1_731_500_000_000_000_000  # fixed epoch (ns) → reproducible
W, H, FPS, SECONDS = 64, 48, 10, 6
FX = W / 2 / math.tan(math.pi / 4)
K = [FX, 0.0, W / 2, 0.0, FX, H / 2, 0.0, 0.0, 1.0]
DROPS = set(range(30, 35))  # component skips frames 30–34


def ns(t):
    return T0 + int(round(t * 1e9))


def stamp2(t):
    v = ns(t)
    return {"sec": v // 1_000_000_000, "nanosec": v % 1_000_000_000}


def scene(f):
    """RGB bytes + depth (m) for frame f: ground plane + approaching box."""
    rgb = bytearray(W * H * 3)
    depth = [float("nan")] * (W * H)
    box = 6.0 - 0.13 * f
    for v in range(H):
        for u in range(W):
            y = (v - H / 2) / FX
            x = (u - W / 2) / FX
            d = float("nan")
            col = (130 + v, 180, 235)
            if y > 0.02:
                d = 1.5 / y
                col = (180, 70, 70)
            if box > 0.5 and abs(x * box) < 0.4 and y * box > 0.3:
                d = box
                col = (40, 40, 200)
            o = (v * W + u) * 3
            rgb[o : o + 3] = bytes(int(c) & 255 for c in col)
            depth[v * W + u] = d if d == d and d < 40 else float("nan")
    return bytes(rgb), depth


def jpeg(rgb):
    buf = io.BytesIO()
    PILImage.frombytes("RGB", (W, H), rgb).save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def cloud_bytes(depth):
    pts = bytearray()
    for v in range(0, H, 3):
        for u in range(0, W, 3):
            d = depth[v * W + u]
            if d != d:
                x = y = z = float("nan")
            else:
                x, y, z = d, -((u - W / 2) / FX) * d, -((v - H / 2) / FX) * d  # link frame
            pts += struct.pack("<fff", x, y, z)
    return bytes(pts), len(pts) // 12


def depth32(depth):
    return struct.pack(f"<{len(depth)}f", *[d if d == d else float("nan") for d in depth])


# ------------------------------------------------------------------ ROS 2 schemas
SEP = "\n" + "=" * 80 + "\n"
HDR2 = "MSG: std_msgs/Header\nbuiltin_interfaces/Time stamp\nstring frame_id" + SEP + "MSG: builtin_interfaces/Time\nint32 sec\nuint32 nanosec"
R2 = {
    "sensor_msgs/msg/Image": "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data" + SEP + HDR2,
    "sensor_msgs/msg/CompressedImage": "std_msgs/Header header\nstring format\nuint8[] data" + SEP + HDR2,
    "sensor_msgs/msg/CameraInfo": "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\nuint32 binning_x\nuint32 binning_y\nsensor_msgs/RegionOfInterest roi"
    + SEP + HDR2 + SEP + "MSG: sensor_msgs/RegionOfInterest\nuint32 x_offset\nuint32 y_offset\nuint32 height\nuint32 width\nbool do_rectify",
    "sensor_msgs/msg/Imu": "std_msgs/Header header\ngeometry_msgs/Quaternion orientation\nfloat64[9] orientation_covariance\ngeometry_msgs/Vector3 angular_velocity\nfloat64[9] angular_velocity_covariance\ngeometry_msgs/Vector3 linear_acceleration\nfloat64[9] linear_acceleration_covariance"
    + SEP + HDR2 + SEP + "MSG: geometry_msgs/Quaternion\nfloat64 x\nfloat64 y\nfloat64 z\nfloat64 w" + SEP + "MSG: geometry_msgs/Vector3\nfloat64 x\nfloat64 y\nfloat64 z",
    "sensor_msgs/msg/PointCloud2": "std_msgs/Header header\nuint32 height\nuint32 width\nsensor_msgs/PointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense"
    + SEP + HDR2 + SEP + "MSG: sensor_msgs/PointField\nuint8 INT8=1\nuint8 UINT8=2\nuint8 INT16=3\nuint8 UINT16=4\nuint8 INT32=5\nuint8 UINT32=6\nuint8 FLOAT32=7\nuint8 FLOAT64=8\nstring name\nuint32 offset\nuint8 datatype\nuint32 count",
    "tf2_msgs/msg/TFMessage": "geometry_msgs/TransformStamped[] transforms" + SEP + "MSG: geometry_msgs/TransformStamped\nstd_msgs/Header header\nstring child_frame_id\ngeometry_msgs/Transform transform"
    + SEP + HDR2 + SEP + "MSG: geometry_msgs/Transform\ngeometry_msgs/Vector3 translation\ngeometry_msgs/Quaternion rotation" + SEP + "MSG: geometry_msgs/Vector3\nfloat64 x\nfloat64 y\nfloat64 z" + SEP + "MSG: geometry_msgs/Quaternion\nfloat64 x\nfloat64 y\nfloat64 z\nfloat64 w",
    "rcl_interfaces/msg/Log": "builtin_interfaces/Time stamp\nuint8 level\nstring name\nstring msg\nstring file\nstring function\nuint32 line" + SEP + "MSG: builtin_interfaces/Time\nint32 sec\nuint32 nanosec",
}


def ros2_events():
    """(log_time_s, topic, type, msg) for the ROS 2 scenario, unsorted."""
    ev = []
    q = {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}
    ev.append((0.0, "/tf_static", "tf2_msgs/msg/TFMessage", {"transforms": [
        {"header": {"stamp": stamp2(0), "frame_id": "base_link"}, "child_frame_id": "camera_link", "transform": {"translation": {"x": 0.1, "y": 0.0, "z": 1.5}, "rotation": q}},
        {"header": {"stamp": stamp2(0), "frame_id": "camera_link"}, "child_frame_id": "camera_optical", "transform": {"translation": {"x": 0.0, "y": 0.0, "z": 0.0}, "rotation": {"x": -0.5, "y": 0.5, "z": -0.5, "w": 0.5}}},
    ]}))
    for i in range(int(SECONDS * 100)):
        t = i / 100
        ev.append((t + 0.001, "/imu/data", "sensor_msgs/msg/Imu", {
            "header": {"stamp": stamp2(t), "frame_id": "imu_link"}, "orientation": q, "orientation_covariance": [-1.0] + [0.0] * 8,
            "angular_velocity": {"x": 0.0, "y": 0.2 * math.sin(2 * math.pi * 1.8 * t), "z": 0.0}, "angular_velocity_covariance": [0.0] * 9,
            "linear_acceleration": {"x": 0.3, "y": 0.0, "z": 9.81 + 2.0 * max(0.0, math.sin(2 * math.pi * 1.8 * t)) ** 3}, "linear_acceleration_covariance": [0.0] * 9}))
    for f in range(SECONDS * FPS):
        t = f / FPS
        rgb, depth = scene(f)
        hdr = {"stamp": stamp2(t), "frame_id": "camera_optical"}
        ev.append((t + 0.006, "/camera/image_raw", "sensor_msgs/msg/Image", {"header": hdr, "height": H, "width": W, "encoding": "rgb8", "is_bigendian": 0, "step": W * 3, "data": rgb}))
        ev.append((t + 0.007, "/camera/image_raw/compressed", "sensor_msgs/msg/CompressedImage", {"header": hdr, "format": "jpeg", "data": jpeg(rgb)}))
        ev.append((t + 0.0065, "/camera/camera_info", "sensor_msgs/msg/CameraInfo", {"header": hdr, "height": H, "width": W, "distortion_model": "plumb_bob", "d": [0.0] * 5, "k": K, "r": [1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0], "p": [FX, 0, W / 2, 0, 0, FX, H / 2, 0, 0, 0, 1, 0], "binning_x": 0, "binning_y": 0, "roi": {"x_offset": 0, "y_offset": 0, "height": 0, "width": 0, "do_rectify": False}}))
        if f in DROPS:
            continue
        ev.append((t + 0.05, "/perception/depth", "sensor_msgs/msg/Image", {"header": hdr, "height": H, "width": W, "encoding": "32FC1", "is_bigendian": 0, "step": W * 4, "data": depth32(depth)}))
        data, n = cloud_bytes(depth)
        ev.append((t + 0.058, "/perception/points", "sensor_msgs/msg/PointCloud2", {"header": {"stamp": stamp2(t), "frame_id": "camera_link"}, "height": 1, "width": n,
                   "fields": [{"name": c, "offset": 4 * k, "datatype": 7, "count": 1} for k, c in enumerate("xyz")], "is_bigendian": False, "point_step": 12, "row_step": 12 * n, "data": data, "is_dense": False}))
    ev.append((1.0, "/rosout", "rcl_interfaces/msg/Log", {"stamp": stamp2(1.0), "level": 20, "name": "perception", "msg": "pipeline started", "file": "node.cpp", "function": "init", "line": 42}))
    return sorted(ev, key=lambda e: e[0])


def write_ros2(path, compression):
    with open(path, "wb") as fh:
        w = Ros2Writer(fh, compression=compression)
        schemas = {name: w.register_msgdef(name, text) for name, text in R2.items()}
        for t, topic, typ, msg in ros2_events():
            w.write_message(topic, schemas[typ], msg, log_time=ns(t))
        w.finish()


def write_ros2_unchunked(path):
    """Same content through the low-level Writer: no chunks, no indexes, no summary."""
    from mcap_ros2._dynamic import serialize_dynamic
    with open(path, "wb") as fh:
        w = Writer(fh, use_chunking=False, index_types=IndexType.NONE, use_statistics=False, use_summary_offsets=False, repeat_channels=False, repeat_schemas=False)
        w.start(profile="ros2", library="gen-realworld unchunked")
        enc, chan = {}, {}
        for name, text in R2.items():
            sid = w.register_schema(name=name, encoding="ros2msg", data=text.encode())
            enc[name] = (sid, serialize_dynamic(name, text)[name])
        for t, topic, typ, msg in ros2_events():
            sid, fn = enc[typ]
            if topic not in chan:
                chan[topic] = w.register_channel(topic=topic, message_encoding="cdr", schema_id=sid)
            w.add_message(channel_id=chan[topic], log_time=ns(t), publish_time=ns(t), data=fn(msg))
        w.finish()


# ------------------------------------------------------------------ ROS 1
R1_HDR = "MSG: std_msgs/Header\nuint32 seq\ntime stamp\nstring frame_id"
R1 = {
    "sensor_msgs/Image": "Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data" + SEP + R1_HDR,
    "sensor_msgs/CameraInfo": "Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] D\nfloat64[9] K\nfloat64[9] R\nfloat64[12] P\nuint32 binning_x\nuint32 binning_y\nRegionOfInterest roi"
    + SEP + R1_HDR + SEP + "MSG: sensor_msgs/RegionOfInterest\nuint32 x_offset\nuint32 y_offset\nuint32 height\nuint32 width\nbool do_rectify",
    "sensor_msgs/PointCloud2": "Header header\nuint32 height\nuint32 width\nPointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense"
    + SEP + R1_HDR + SEP + "MSG: sensor_msgs/PointField\nuint8 INT8=1\nuint8 UINT8=2\nuint8 INT16=3\nuint8 UINT16=4\nuint8 INT32=5\nuint8 UINT32=6\nuint8 FLOAT32=7\nuint8 FLOAT64=8\nstring name\nuint32 offset\nuint8 datatype\nuint32 count",
}


def write_ros1(path):
    from mcap_ros1._vendor import genpy
    cls = {}
    for name, text in R1.items():
        cls[name] = genpy_dynamic.generate_dynamic(name, text)[name]
    hdr_cls = genpy_dynamic.generate_dynamic("std_msgs/Header", "uint32 seq\ntime stamp\nstring frame_id")["std_msgs/Header"]
    with open(path, "wb") as fh:
        w = Ros1Writer(fh)
        for f in range(SECONDS * FPS):
            t = f / FPS
            rgb, depth = scene(f)
            v = ns(t)
            mk_hdr = lambda fid: hdr_cls(seq=f, stamp=genpy.Time(v // 1_000_000_000, v % 1_000_000_000), frame_id=fid)
            w.write_message("/camera/image_raw", cls["sensor_msgs/Image"](header=mk_hdr("camera_optical"), height=H, width=W, encoding="bgr8", is_bigendian=0, step=W * 3, data=rgb), log_time=ns(t + 0.005))
            ci = cls["sensor_msgs/CameraInfo"]()
            ci.header, ci.height, ci.width, ci.distortion_model, ci.D, ci.K, ci.R, ci.P = mk_hdr("camera_optical"), H, W, "plumb_bob", [0.0] * 5, K, [1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0], [FX, 0, W / 2, 0, 0, FX, H / 2, 0, 0, 0, 1, 0]
            w.write_message("/camera/camera_info", ci, log_time=ns(t + 0.0052))
            if f in DROPS:
                continue
            data, n = cloud_bytes(depth)
            pc = cls["sensor_msgs/PointCloud2"]()
            pf = pc.fields.__class__  # list
            field_cls = genpy_dynamic.generate_dynamic("sensor_msgs/PointField", R1["sensor_msgs/PointCloud2"].split(SEP)[-1].replace("MSG: sensor_msgs/PointField\n", ""))["sensor_msgs/PointField"]
            pc.header, pc.height, pc.width, pc.is_bigendian, pc.point_step, pc.row_step, pc.data, pc.is_dense = mk_hdr("camera_link"), 1, n, False, 12, 12 * n, data, False
            pc.fields = pf(field_cls(name=c, offset=4 * k, datatype=7, count=1) for k, c in enumerate("xyz"))
            w.write_message("/perception/points", pc, log_time=ns(t + 0.06))
        w.finish()


# ------------------------------------------------------------------ Foxglove (protobuf / json)
def ts(t):
    v = ns(t)
    return Timestamp(seconds=v // 1_000_000_000, nanos=v % 1_000_000_000)


def fields_pb():
    return [PackedElementField(name=c, offset=4 * k, type=PackedElementField.FLOAT32) for k, c in enumerate("xyz")] + [PackedElementField(name="intensity", offset=12, type=PackedElementField.UINT8)]


def cloud_with_intensity(depth):
    data, n = cloud_bytes(depth)
    out = bytearray()
    for i in range(n):
        out += data[i * 12 : i * 12 + 12] + bytes([min(255, i % 256)]) + b"\0\0\0"
    return bytes(out), n


def write_foxglove_protobuf(path):
    with open(path, "wb") as fh, ProtobufWriter(fh) as w:
        tf = FrameTransforms(transforms=[FrameTransform(timestamp=ts(0), parent_frame_id="base_link", child_frame_id="camera", translation={"x": 0.1, "z": 1.5}, rotation={"w": 1.0})])
        w.write_message("/tf", tf, log_time=ns(0), publish_time=ns(0))
        for f in range(SECONDS * FPS):
            t = f / FPS
            rgb, depth = scene(f)
            w.write_message("/camera/image", RawImage(timestamp=ts(t), frame_id="camera", width=W, height=H, encoding="rgb8", step=W * 3, data=rgb), log_time=ns(t + 0.005), publish_time=ns(t + 0.005))
            w.write_message("/camera/compressed", CompressedImage(timestamp=ts(t), frame_id="camera", format="jpeg", data=jpeg(rgb)), log_time=ns(t + 0.006), publish_time=ns(t + 0.006))
            w.write_message("/camera/calibration", CameraCalibration(timestamp=ts(t), frame_id="camera", width=W, height=H, distortion_model="plumb_bob", D=[0.0] * 5, K=K, R=[1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0], P=[FX, 0, W / 2, 0, 0, FX, H / 2, 0, 0, 0, 1, 0]), log_time=ns(t + 0.0055), publish_time=ns(t + 0.0055))
            if f in DROPS:
                continue
            data, n = cloud_with_intensity(depth)
            w.write_message("/perception/cloud", PointCloud(timestamp=ts(t), frame_id="camera", point_stride=16, fields=fields_pb(), data=data), log_time=ns(t + 0.055), publish_time=ns(t + 0.055))
            w.write_message("/perception/scan", LaserScan(timestamp=ts(t), frame_id="camera", start_angle=-0.7, end_angle=0.7, ranges=[depth[(H * 3 // 4) * W + u] if depth[(H * 3 // 4) * W + u] == depth[(H * 3 // 4) * W + u] else 0.0 for u in range(W)]), log_time=ns(t + 0.056), publish_time=ns(t + 0.056))
        w.write_message("/log", Log(timestamp=ts(1), level=Log.INFO, message="started", name="perception", file="n.cpp", line=1), log_time=ns(1), publish_time=ns(1))


def write_foxglove_json(path):
    with open(path, "wb") as fh:
        w = Writer(fh, compression=CompressionType.LZ4)
        w.start(profile="", library="gen-realworld json")
        js = lambda title: json.dumps({"title": title, "type": "object"}).encode()
        s_img = w.register_schema(name="foxglove.RawImage", encoding="jsonschema", data=js("foxglove.RawImage"))
        s_pc = w.register_schema(name="foxglove.PointCloud", encoding="jsonschema", data=js("foxglove.PointCloud"))
        s_tf = w.register_schema(name="foxglove.FrameTransform", encoding="jsonschema", data=js("foxglove.FrameTransform"))
        c_img = w.register_channel(topic="/camera/image", message_encoding="json", schema_id=s_img)
        c_pc = w.register_channel(topic="/perception/cloud", message_encoding="json", schema_id=s_pc)
        c_tf = w.register_channel(topic="/tf", message_encoding="json", schema_id=s_tf)
        tsj = lambda t: {"sec": ns(t) // 1_000_000_000, "nsec": ns(t) % 1_000_000_000}
        put = lambda c, t, obj: w.add_message(channel_id=c, log_time=ns(t), publish_time=ns(t), data=json.dumps(obj).encode())
        put(c_tf, 0, {"timestamp": tsj(0), "parent_frame_id": "base_link", "child_frame_id": "camera", "translation": {"x": 0, "y": 0, "z": 1.5}, "rotation": {"x": 0, "y": 0, "z": 0, "w": 1}})
        events = []
        for f in range(SECONDS * FPS):
            t = f / FPS
            rgb, depth = scene(f)
            events.append((t + 0.005, c_img, {"timestamp": tsj(t), "frame_id": "camera", "width": W, "height": H, "encoding": "rgb8", "step": W * 3, "data": base64.b64encode(rgb).decode()}))
            if f not in DROPS:
                data, n = cloud_with_intensity(depth)
                events.append((t + 0.055, c_pc, {"timestamp": tsj(t), "frame_id": "camera", "pose": {"position": {"x": 0, "y": 0, "z": 0}, "orientation": {"x": 0, "y": 0, "z": 0, "w": 1}}, "point_stride": 16,
                                                  "fields": [{"name": c, "offset": 4 * k, "type": 7} for k, c in enumerate("xyz")] + [{"name": "intensity", "offset": 12, "type": 1}], "data": base64.b64encode(data).decode()}))
        for t, c, obj in sorted(events, key=lambda e: e[0]):
            put(c, t, obj)
        w.finish()


# ------------------------------------------------------------------ misc encodings
OMG_IDL = "module lumen { module msg { struct Time { int32 sec; uint32 nanosec; }; struct Header { Time stamp; string frame_id; }; struct Obstacle { Header header; float distance; double bearing; }; }; };"
ROS2IDL = (
    "=" * 80 + "\nIDL: builtin_interfaces/msg/Time\nmodule builtin_interfaces { module msg { struct Time { int32 sec; uint32 nanosec; }; }; };\n"
    + "=" * 80 + "\nIDL: lumen_msgs/msg/Haptic\n#include \"builtin_interfaces/msg/Time.idl\"\nmodule lumen_msgs { module msg { struct Haptic { builtin_interfaces::msg::Time stamp; uint8 motor; float intensity; }; }; };\n"
)


def cdr_obstacle(t, dist, bearing):
    v = ns(t)
    body = struct.pack("<iI", v // 1_000_000_000, v % 1_000_000_000)
    fid = b"camera\0"
    body += struct.pack("<I", len(fid)) + fid
    while len(body) % 4:
        body += b"\0"
    body += struct.pack("<f", dist)
    while len(body) % 8:
        body += b"\0"
    body += struct.pack("<d", bearing)
    return b"\x00\x01\x00\x00" + body


def cdr_haptic(t, motor, inten):
    v = ns(t)
    body = struct.pack("<iIB", v // 1_000_000_000, v % 1_000_000_000, motor)
    while len(body) % 4:
        body += b"\0"
    return b"\x00\x01\x00\x00" + body + struct.pack("<f", inten)


def write_misc(path):
    with open(path, "wb") as fh:
        w = Writer(fh, compression=CompressionType.NONE)
        w.start(profile="", library="gen-realworld misc")
        c_cbor = w.register_channel(topic="/diag/cbor", message_encoding="cbor", schema_id=0)
        c_mp = w.register_channel(topic="/diag/msgpack", message_encoding="msgpack", schema_id=0)
        s_omg = w.register_schema(name="lumen::msg::Obstacle", encoding="omgidl", data=OMG_IDL.encode())
        c_omg = w.register_channel(topic="/perception/obstacle", message_encoding="cdr", schema_id=s_omg)
        s_idl = w.register_schema(name="lumen_msgs/msg/Haptic", encoding="ros2idl", data=ROS2IDL.encode())
        c_idl = w.register_channel(topic="/haptic/cmd", message_encoding="cdr", schema_id=s_idl)
        s_fb = w.register_schema(name="lumen.Status", encoding="flatbuffer", data=b"\x00\x01\x02\x03")
        c_fb = w.register_channel(topic="/status/flatbuffer", message_encoding="flatbuffer", schema_id=s_fb)
        for i in range(20):
            t = i * 0.1
            w.add_message(channel_id=c_cbor, log_time=ns(t), publish_time=ns(t), data=cbor2.dumps({"cpu": 40 + i, "temp_c": 51.5, "ok": True}))
            w.add_message(channel_id=c_mp, log_time=ns(t + 0.01), publish_time=ns(t + 0.01), data=msgpack.packb({"battery": 0.9 - i * 0.01, "mode": "walk"}))
            w.add_message(channel_id=c_omg, log_time=ns(t + 0.02), publish_time=ns(t + 0.02), data=cdr_obstacle(t, 5.0 - i * 0.2, 0.1 * i))
            w.add_message(channel_id=c_idl, log_time=ns(t + 0.03), publish_time=ns(t + 0.03), data=cdr_haptic(t, i % 4, 0.25 * (i % 4)))
            w.add_message(channel_id=c_fb, log_time=ns(t + 0.04), publish_time=ns(t + 0.04), data=b"\x10\x00\x00\x00")
        w.finish()


if __name__ == "__main__":
    p = lambda n: os.path.join(OUT, n)
    write_ros2(p("ros2_zstd.mcap"), CompressionType.ZSTD)
    write_ros2(p("ros2_lz4.mcap"), CompressionType.LZ4)
    write_ros2_unchunked(p("ros2_unchunked.mcap"))
    write_ros1(p("ros1.mcap"))
    write_foxglove_protobuf(p("foxglove_protobuf.mcap"))
    write_foxglove_json(p("foxglove_json.mcap"))
    write_misc(p("misc_encodings.mcap"))
    raw = open(p("ros2_zstd.mcap"), "rb").read()
    open(p("truncated.mcap"), "wb").write(raw[: int(len(raw) * 0.6)])
    bad = bytearray(raw)
    mid = len(bad) // 3
    for k in range(mid, mid + 64):
        bad[k] ^= 0xFF
    open(p("corrupt_chunk.mcap"), "wb").write(bytes(bad))
    open(p("not_mcap.db3"), "wb").write(b"SQLite format 3\x00" + b"\x00" * 100)
    for n in sorted(os.listdir(OUT)):
        print(f"{n:28s} {os.path.getsize(p(n)):>9d} B")
