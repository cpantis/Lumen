/**
 * Configurable synthetic ROS 2 MCAP generator for the generality tests: any number of
 * fields of view, any topic names (namespaced or root topics with frame_ids), any camera
 * rate, with or without CameraInfo / TF / IMU, 16UC1 or 32FC1 depth, clouds with or
 * without an rgb field, injected input drops and an output stall.
 *
 * Per FOV: an rgb camera and a depth camera (inputs, same stamps, depth logged after
 * rgb), a class-map segmentation computed from rgb only, and a coloured cloud computed
 * from rgb + depth (so it is triggered by depth, the input logged last).
 *
 *   npx tsx scripts/gen-generic.ts out.mcap [--fovs a,b,c] [--hz 10] [--root] [--no-info] [--no-tf] [--no-imu] [--depth 32FC1] [--no-rgb-field]
 */
import { McapWriter, TempBuffer } from "@mcap/core";
import { parse } from "@foxglove/rosmsg";
import { MessageWriter } from "@foxglove/rosmsg2-serialization";
import { writeFileSync } from "node:fs";
import { SCHEMAS } from "./schemas";

export interface GenericOptions {
  fovs: string[];
  /** "namespace": /<fov>/…; "root": single FOV with root topics, FOV only in frame_id */
  naming?: "namespace" | "root";
  hz?: number;
  seconds?: number;
  cameraInfo?: boolean;
  tf?: boolean;
  imu?: boolean;
  depthEncoding?: "16UC1" | "32FC1";
  cloudRgb?: boolean;
  /** frame indices where the rgb input is missing (seg and cloud are then missing too) */
  dropRgb?: number[];
  /** frame indices where depth is missing (the cloud is missing, seg is not) */
  dropDepth?: number[];
  /** [first, last] frame indices where the segmentation component stalls (no output) */
  segStall?: [number, number];
  /** split the messages into this many consecutive parts */
  parts?: number;
}

export interface GenericTopics {
  rgb: string;
  depth: string;
  seg: string;
  cloud: string;
  info?: string;
}

export function topicNames(o: GenericOptions, fov: string): GenericTopics {
  if (o.naming === "root") return { rgb: "/rgb", depth: "/depth", seg: "/labels", cloud: "/fused_points", info: o.cameraInfo ? "/rgb_info" : undefined };
  return { rgb: `/${fov}/color/image`, depth: `/${fov}/aligned_depth`, seg: `/${fov}/labels`, cloud: `/${fov}/fused_points`, info: o.cameraInfo ? `/${fov}/color/camera_info` : undefined };
}

const W = 32, H = 24;
const T0 = 1_750_000_000;

/** Exact timing model of the generator (used by the tests to compute expected values). */
export const TIMING = { rgbLog: 0.008, depthLog: 0.012, segAfterRgb: 0.041, cloudAfterDepth: 0.026 };

export async function genGeneric(o: GenericOptions): Promise<Uint8Array[]> {
  const hz = o.hz ?? 10;
  const seconds = o.seconds ?? 6;
  const frames = Math.floor(seconds * hz);
  const depthEnc = o.depthEncoding ?? "16UC1";
  const msgs: Array<{ topic: string; type: string; log: number; msg: unknown }> = [];
  const stampOf = (s: number) => ({ sec: T0 + Math.floor(s), nanosec: Math.round((s - Math.floor(s)) * 1e9) });
  const dropRgb = new Set(o.dropRgb ?? []);
  const dropDepth = new Set(o.dropDepth ?? []);
  for (const fov of o.fovs) {
    const tn = topicNames(o, fov);
    const frame = (kind: string) => `${fov}_${kind}_optical_frame`;
    for (let k = 0; k < frames; k++) {
      const s = 0.05 + k / hz;
      const st = stampOf(s);
      const jit = ((k * 7919) % 13) * 1e-4;
      const hasRgb = !dropRgb.has(k), hasDepth = !dropDepth.has(k);
      if (hasRgb) {
        const data = new Uint8Array(W * H * 3);
        for (let i = 0; i < W * H; i++) data.set([(i * 5 + k) % 256, (i * 3) % 256, (k * 9) % 256], i * 3);
        msgs.push({ topic: tn.rgb, type: "sensor_msgs/msg/Image", log: s + TIMING.rgbLog + jit, msg: { header: { stamp: st, frame_id: frame("color") }, height: H, width: W, encoding: "rgb8", is_bigendian: 0, step: W * 3, data } });
        if (tn.info) msgs.push({ topic: tn.info, type: "sensor_msgs/msg/CameraInfo", log: s + TIMING.rgbLog + jit + 0.0002, msg: { header: { stamp: st, frame_id: frame("color") }, height: H, width: W, distortion_model: "plumb_bob", d: [0, 0, 0, 0, 0], k: [30, 0, 16, 0, 30, 12, 0, 0, 1], r: [1, 0, 0, 0, 1, 0, 0, 0, 1], p: [30, 0, 16, 0, 0, 30, 12, 0, 0, 0, 1, 0], binning_x: 0, binning_y: 0, roi: { x_offset: 0, y_offset: 0, height: 0, width: 0, do_rectify: false } } });
      }
      if (hasDepth) {
        const isF = depthEnc === "32FC1";
        const data = new Uint8Array(W * H * (isF ? 4 : 2));
        const dv = new DataView(data.buffer);
        for (let i = 0; i < W * H; i++) {
          const m = i % 17 === 0 ? 0 : 1 + (i % W) * 0.1; // some 0 = no data, valid up to 4.1 m
          if (isF) dv.setFloat32(i * 4, m, true);
          else dv.setUint16(i * 2, Math.round(m * 1000), true);
        }
        msgs.push({ topic: tn.depth, type: "sensor_msgs/msg/Image", log: s + TIMING.depthLog + jit, msg: { header: { stamp: st, frame_id: frame("depth") }, height: H, width: W, encoding: depthEnc, is_bigendian: 0, step: W * (isF ? 4 : 2), data } });
      }
      const stalled = o.segStall && k >= o.segStall[0] && k <= o.segStall[1];
      if (hasRgb && !stalled) {
        const data = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) data[i] = ((i >> 3) + k) % 5; // 5 classes
        msgs.push({ topic: tn.seg, type: "sensor_msgs/msg/Image", log: s + TIMING.rgbLog + jit + TIMING.segAfterRgb, msg: { header: { stamp: st, frame_id: frame("color") }, height: H, width: W, encoding: "mono8", is_bigendian: 0, step: W, data } });
      }
      if (hasRgb && hasDepth) {
        const n = 64;
        const step = o.cloudRgb === false ? 16 : 16;
        const data = new Uint8Array(n * step);
        const dv = new DataView(data.buffer);
        for (let i = 0; i < n; i++) {
          dv.setFloat32(i * step, (i % 8) * 0.2 - 0.7, true);
          dv.setFloat32(i * step + 4, 0.1, true);
          dv.setFloat32(i * step + 8, 1 + Math.floor(i / 8) * 0.4, true);
          if (o.cloudRgb === false) dv.setFloat32(i * step + 12, i, true);
          else dv.setUint32(i * step + 12, ((i * 4) << 16) | (128 << 8) | 255, true);
        }
        const fields = ["x", "y", "z", o.cloudRgb === false ? "intensity" : "rgb"].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 }));
        msgs.push({ topic: tn.cloud, type: "sensor_msgs/msg/PointCloud2", log: s + TIMING.depthLog + jit + TIMING.cloudAfterDepth, msg: { header: { stamp: st, frame_id: frame("depth") }, height: 1, width: n, fields, is_bigendian: false, point_step: step, row_step: n * step, data, is_dense: true } });
      }
    }
    if (o.tf) {
      const tf = (child: string) => ({ header: { stamp: stampOf(0), frame_id: "base_link" }, child_frame_id: child, transform: { translation: { x: 0.1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
      msgs.push({ topic: "/tf_static", type: "tf2_msgs/msg/TFMessage", log: 0.001, msg: { transforms: [tf(frame("color")), tf(frame("depth"))] } });
    }
  }
  if (o.imu) {
    for (let k = 0; k < seconds * 100; k++) {
      const s = 0.01 + k / 100;
      msgs.push({ topic: "/imu", type: "sensor_msgs/msg/Imu", log: s + 0.001, msg: { header: { stamp: stampOf(s), frame_id: "imu_link" }, orientation: { x: 0, y: 0, z: 0, w: 1 }, orientation_covariance: [-1, 0, 0, 0, 0, 0, 0, 0, 0], angular_velocity: { x: 0, y: 0, z: 0 }, angular_velocity_covariance: new Array(9).fill(0), linear_acceleration: { x: 0, y: 0, z: 9.81 }, linear_acceleration_covariance: new Array(9).fill(0) } });
    }
  }
  msgs.sort((a, b) => a.log - b.log);
  const nParts = Math.max(1, o.parts ?? 1);
  const out: Uint8Array[] = [];
  const writers = new Map<string, MessageWriter>();
  for (let p = 0; p < nParts; p++) {
    const slice = msgs.slice(Math.floor((p * msgs.length) / nParts), Math.floor(((p + 1) * msgs.length) / nParts));
    const buf = new TempBuffer();
    const w = new McapWriter({ writable: buf, useChunks: true, chunkSize: 128 * 1024, compressChunk: undefined });
    await w.start({ profile: "ros2", library: "StampTrace generic generator" });
    const chan = new Map<string, number>();
    const schemaIds = new Map<string, number>();
    for (const m of slice) {
      if (chan.has(m.topic)) continue;
      if (!schemaIds.has(m.type)) schemaIds.set(m.type, await w.registerSchema({ name: m.type, encoding: "ros2msg", data: new TextEncoder().encode(SCHEMAS[m.type]) }));
      if (!writers.has(m.type)) writers.set(m.type, new MessageWriter(parse(SCHEMAS[m.type], { ros2: true })));
      chan.set(m.topic, await w.registerChannel({ topic: m.topic, messageEncoding: "cdr", schemaId: schemaIds.get(m.type)!, metadata: new Map() }));
    }
    let seq = 0;
    for (const m of slice) {
      const log = BigInt(T0) * 1_000_000_000n + BigInt(Math.round(m.log * 1e9));
      await w.addMessage({ channelId: chan.get(m.topic)!, sequence: seq++, logTime: log, publishTime: log, data: writers.get(m.type)!.writeMessage(m.msg) });
    }
    await w.end();
    out.push(buf.get());
  }
  return out;
}

// CLI
if (process.argv[1]?.endsWith("gen-generic.ts")) {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const opt = (f: string) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : undefined);
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "generic.mcap";
  const parts = await genGeneric({
    fovs: (opt("--fovs") ?? "left,right").split(","),
    naming: has("--root") ? "root" : "namespace",
    hz: Number(opt("--hz") ?? 10),
    seconds: Number(opt("--seconds") ?? 6),
    cameraInfo: !has("--no-info"),
    tf: !has("--no-tf"),
    imu: !has("--no-imu"),
    depthEncoding: (opt("--depth") as "16UC1" | "32FC1") ?? "16UC1",
    cloudRgb: !has("--no-rgb-field"),
    dropRgb: [12, 13, 30],
    dropDepth: [5, 21, 22, 40],
    segStall: [44, 50],
    parts: Number(opt("--parts") ?? 1),
  });
  parts.forEach((b, i) => writeFileSync(parts.length > 1 ? file.replace(/\.mcap$/, `_${i}.mcap`) : file, b));
  console.log(`Wrote ${parts.length} file(s) for ${file}`);
}
