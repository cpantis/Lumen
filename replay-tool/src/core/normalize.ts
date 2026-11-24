/**
 * Normalisation of decoded messages to one canonical (ROS 2-like) shape, so that the
 * analysis and every panel work identically on ROS 2, ROS 1 and Foxglove well-known
 * schemas, whatever the encoding (cdr, ros1, protobuf, json, cbor, msgpack).
 *
 * Field definitions follow the official foxglove-schemas-protobuf package
 * (foxglove.RawImage, CompressedImage, PointCloud, FrameTransform(s), CameraCalibration,
 * LaserScan, PoseInFrame). Note: Foxglove's PackedElementField.NumericType numbering
 * (UINT8=1, INT8=2, UINT16=3, INT16=4, UINT32=5, INT32=6, FLOAT32=7, FLOAT64=8)
 * differs from ROS sensor_msgs/PointField (INT8=1, UINT8=2, INT16=3, UINT16=4, …).
 */

/** Maps a schema name to the canonical type used by the app. */
export function canonicalType(schemaName: string): string {
  const n = schemaName.replace(/::/g, "/").replace("/msg/", "/");
  const map: Record<string, string> = {
    "foxglove.RawImage": "sensor_msgs/Image",
    "foxglove.CompressedImage": "sensor_msgs/CompressedImage",
    "foxglove.PointCloud": "sensor_msgs/PointCloud2",
    "foxglove.FrameTransform": "tf2_msgs/TFMessage",
    "foxglove.FrameTransforms": "tf2_msgs/TFMessage",
    "foxglove.CameraCalibration": "sensor_msgs/CameraInfo",
    "foxglove.LaserScan": "sensor_msgs/LaserScan",
    "foxglove.PoseInFrame": "geometry_msgs/PoseStamped",
    "tf/tfMessage": "tf2_msgs/TFMessage",
  };
  // Foxglove schemas also exist as ROS packages: foxglove_msgs/RawImage etc.
  const fx = /^foxglove_msgs\/(.+)$/.exec(n);
  if (fx && map[`foxglove.${fx[1]}`]) return map[`foxglove.${fx[1]}`];
  return map[n] ?? n;
}

type Any = Record<string, any>;

/** {sec,nsec} (ROS 1, Foxglove json/ros), {sec,nanosec} (ROS 2), {seconds,nanos} (protobuf). */
export function toStamp(ts: Any | undefined): { sec: number; nanosec: number } | undefined {
  if (!ts || typeof ts !== "object") return undefined;
  if (ts.sec !== undefined) return { sec: Number(ts.sec), nanosec: Number(ts.nanosec ?? ts.nsec ?? 0) };
  if (ts.seconds !== undefined) return { sec: Number(ts.seconds), nanosec: Number(ts.nanos ?? 0) };
  return undefined;
}

/** Bytes may arrive as Uint8Array, number[] (json/cbor) or base64 string (Foxglove json). */
export function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength);
  if (typeof v === "string") {
    const bin = atob(v);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return new Uint8Array();
}

const FOXGLOVE_TO_ROS_DATATYPE: Record<number, number> = { 1: 2, 2: 1, 3: 4, 4: 3, 5: 6, 6: 5, 7: 7, 8: 8 };

function header(m: Any) {
  return { stamp: toStamp(m.timestamp) ?? { sec: 0, nanosec: 0 }, frame_id: m.frame_id ?? "" };
}

function tfFromFoxglove(t: Any) {
  return {
    header: { stamp: toStamp(t.timestamp) ?? { sec: 0, nanosec: 0 }, frame_id: t.parent_frame_id ?? "" },
    child_frame_id: t.child_frame_id ?? "",
    transform: { translation: t.translation ?? { x: 0, y: 0, z: 0 }, rotation: t.rotation ?? { x: 0, y: 0, z: 0, w: 1 } },
  };
}

/** Returns the message in canonical shape (unchanged when already canonical). */
export function normalizeMessage(schemaName: string, msg: unknown): unknown {
  if (!msg || typeof msg !== "object") return msg;
  const m = msg as Any;
  const n = schemaName.replace(/^foxglove_msgs\/(msg\/)?/, "foxglove.");
  switch (n) {
    case "foxglove.RawImage":
      return { header: header(m), width: m.width ?? 0, height: m.height ?? 0, encoding: m.encoding ?? "", is_bigendian: 0, step: m.step ?? 0, data: toBytes(m.data) };
    case "foxglove.CompressedImage":
      return { header: header(m), format: m.format ?? "", data: toBytes(m.data) };
    case "foxglove.CompressedVideo":
      return { ...m, header: header(m), data: toBytes(m.data) };
    case "foxglove.PointCloud": {
      const data = toBytes(m.data);
      const stride = m.point_stride || 1;
      const width = Math.floor(data.length / stride);
      return {
        header: header(m),
        height: 1,
        width,
        fields: (m.fields ?? []).map((f: Any) => ({ name: f.name, offset: f.offset ?? 0, datatype: FOXGLOVE_TO_ROS_DATATYPE[Number(f.type)] ?? 0, count: 1 })),
        is_bigendian: false,
        point_step: stride,
        row_step: width * stride,
        data,
        is_dense: false,
        pose: m.pose, // Foxglove: pose of the cloud in frame_id (kept, not applied)
      };
    }
    case "foxglove.FrameTransform":
      return { transforms: [tfFromFoxglove(m)] };
    case "foxglove.FrameTransforms":
      return { transforms: (m.transforms ?? []).map(tfFromFoxglove) };
    case "foxglove.CameraCalibration":
      return { header: header(m), width: m.width ?? 0, height: m.height ?? 0, distortion_model: m.distortion_model ?? "", d: m.D ?? [], k: m.K ?? [], r: m.R ?? [], p: m.P ?? [] };
    case "foxglove.LaserScan": {
      const ranges: number[] = Array.from(m.ranges ?? []);
      const n2 = Math.max(1, ranges.length - 1);
      return {
        header: header(m),
        angle_min: m.start_angle ?? 0,
        angle_max: m.end_angle ?? 0,
        angle_increment: ((m.end_angle ?? 0) - (m.start_angle ?? 0)) / n2,
        range_min: 0,
        range_max: ranges.reduce((a, b) => (Number.isFinite(b) && b > a ? b : a), 0),
        ranges,
        intensities: Array.from(m.intensities ?? []),
      };
    }
    case "foxglove.PoseInFrame":
      return { header: header(m), pose: m.pose };
  }
  // ROS 1 sensor_msgs/CameraInfo uses upper-case D, K, R, P
  if (m.K !== undefined && m.k === undefined && m.width !== undefined) return { ...m, d: m.D, k: m.K, r: m.R, p: m.P };
  // generic messages with a Foxglove-style top-level timestamp: expose it as header.stamp
  if (!m.header && m.timestamp && toStamp(m.timestamp)) return { ...m, header: { stamp: toStamp(m.timestamp), frame_id: m.frame_id ?? "" } };
  return m;
}
