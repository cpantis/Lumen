/**
 * Synthetic recording generator — a small, deterministic MCAP that mimics the
 * structure described in the challenge (two cameras = two FOVs, IMU, CameraInfo, TF,
 * and a component producing depth + point cloud per FOV) **with known, injected
 * defects**, so every analysis of the app can be tested reproducibly:
 *
 *   cam_front depth/points  latency ~60 ms, spike +250 ms at frames 120–125,
 *                           random drops (4 %), burst drop frames 170–178,
 *                           point cloud offset +0.8 m at frames 200–215 (consistency bug)
 *   cam_front image_raw     input gap ≈ 0.6 s at frames 240–248
 *   cam_down  depth/points  half rate (every 2nd frame), frozen depth 60–66,
 *                           empty cloud at frame 90, 70 % NaN at 100–110,
 *   cam_down  image_raw     non-monotonic stamp at frame 140
 *   imu                     200 Hz, walking at 1.8 steps/s, glitch |a|=120 m/s² at 5 s
 *   /component/status       JSON-encoded topic (generic panel)
 *
 * Usage: npm run gen:synthetic -- [out.mcap] [--seconds 20] [--unindexed] [--lz4]
 */
import { McapWriter, type IWritable } from "@mcap/core";
import { parse } from "@foxglove/rosmsg";
import { MessageWriter } from "@foxglove/rosmsg2-serialization";
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as zlib from "node:zlib";

// node:zlib zstd exists from Node 22.15 / 23.8; older Node → lz4 fallback
const nodeZstd = zlib as unknown as { zstdCompressSync?: (d: Uint8Array, o?: object) => Uint8Array; constants: Record<string, number> };
// @ts-ignore — lz4js has no type declarations
import * as lz4 from "lz4js";
import { SCHEMAS } from "./schemas";

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? "fixtures/synthetic.mcap";
const secIdx = args.indexOf("--seconds");
const SECONDS = secIdx >= 0 ? Number(args[secIdx + 1]) : 20;
const UNINDEXED = args.includes("--unindexed");
const LZ4 = args.includes("--lz4") || !nodeZstd.zstdCompressSync; // default: zstd (smaller demo download); --lz4 exercises the lz4 path

// ---------------------------------------------------------------------------------
let seed = 0x1e5;
function rand(): number {
  // mulberry32 — deterministic
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss(): number {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

class FileWritable implements IWritable {
  #fd: number;
  #pos = 0n;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#fd = openSync(path, "w");
  }
  async write(buffer: Uint8Array): Promise<void> {
    writeSync(this.#fd, buffer);
    this.#pos += BigInt(buffer.length);
  }
  position(): bigint {
    return this.#pos;
  }
  close() {
    closeSync(this.#fd);
  }
}

const START = 1_763_000_000_000_000_000n; // fixed epoch → reproducible file
const ns = (s: number) => START + BigInt(Math.round(s * 1e9));
const stampOf = (s: number) => {
  const t = ns(s);
  return { sec: Number(t / 1_000_000_000n), nanosec: Number(t % 1_000_000_000n) };
};

const W = 160, H = 120, FPS = 15;
const FX = W / 2 / Math.tan(Math.PI / 4); // 90° HFOV
const K = [FX, 0, W / 2, 0, FX, H / 2, 0, 0, 1];
const SPEED = 1.3; // m/s

interface Cam {
  name: string;
  height: number; // m above ground
  pitch: number; // rad, positive = looking down
}
const CAMS: Cam[] = [
  { name: "cam_front", height: 1.6, pitch: (10 * Math.PI) / 180 },
  { name: "cam_down", height: 1.6, pitch: (55 * Math.PI) / 180 },
];

/** Renders RGB + depth (m) for a camera at time t. */
function render(cam: Cam, t: number): { rgb: Uint8Array; depth: Float32Array } {
  const rgb = new Uint8Array(W * H * 3);
  const depth = new Float32Array(W * H).fill(NaN);
  const walked = SPEED * t;
  const obsZ = 12 - walked; // obstacle (pole/box) approaching, 0.8 m to the right
  const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const x = (u - K[2]) / FX, y = (v - K[5]) / FX;
      // direction in level world frame (X right, Y down, Z forward)
      const dwy = y * cp + sp;
      const dwz = -y * sp + cp;
      let s = Infinity;
      let kind = 0;
      if (dwy > 1e-6) {
        s = cam.height / dwy;
        kind = 1;
      }
      if (obsZ > 0.4 && dwz > 1e-6) {
        const so = obsZ / dwz;
        const X = x * so, Y = dwy * so;
        if (so < s && X > 0.5 && X < 1.1 && Y > cam.height - 1.3 && Y < cam.height) {
          s = so;
          kind = 2;
        }
      }
      const o = (v * W + u) * 3;
      if (kind === 0 || s > 60) {
        rgb[o] = 120 + v; rgb[o + 1] = 170 + v / 2; rgb[o + 2] = 235; // sky
        continue;
      }
      depth[v * W + u] = rand() < 0.02 ? s * (1 + gauss() * 0.003) : s; // optical-frame z (direction has z = 1); sparse sensor noise keeps frames distinct while compressing well
      if (kind === 2) {
        rgb[o] = 200; rgb[o + 1] = 40; rgb[o + 2] = 50;
      } else {
        const gz = dwz * s + walked; // ground coordinate along the walk
        const gx = x * s;
        const stripe = Math.abs(gx) < 1.6 && Math.floor(gz / 0.6) % 2 === 0 && gz % 12 < 4;
        const shade = Math.max(60, 170 - s * 6) + (rand() < 0.02 ? gauss() * 3 : 0); // sparse photon noise
        rgb[o] = stripe ? 235 : shade + 40; // red-ish cycle lane like the real recording
        rgb[o + 1] = stripe ? 235 : shade * 0.45;
        rgb[o + 2] = stripe ? 235 : shade * 0.45;
      }
    }
  }
  return { rgb, depth };
}

function depthTo16UC1(depth: Float32Array): Uint8Array {
  const out = new Uint8Array(W * H * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    dv.setUint16(i * 2, Number.isFinite(d) && d < 60 ? Math.round(d * 1000) : 0, true);
  }
  return out;
}

/** Back-projects every 4th pixel into the camera *link* frame (x fwd, y left, z up). */
function depthToCloud(depth: Float32Array, nanRatio = 0, offsetX = 0): { data: Uint8Array; width: number } {
  const pts: number[] = [];
  for (let v = 0; v < H; v += 4) {
    for (let u = 0; u < W; u += 4) {
      const d = depth[v * W + u];
      let px = NaN, py = NaN, pz = NaN;
      if (Number.isFinite(d) && d < 40 && rand() >= nanRatio) {
        const xo = ((u - K[2]) / FX) * d, yo = ((v - K[5]) / FX) * d, zo = d;
        px = zo + offsetX + gauss() * 0.01;
        py = -xo;
        pz = -yo;
      }
      pts.push(px, py, pz, Number.isFinite(d) ? Math.min(255, d * 10) : 0);
    }
  }
  const n = pts.length / 4;
  const data = new Uint8Array(n * 16);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) dv.setFloat32(i * 16 + k * 4, pts[i * 4 + k], true);
  return { data, width: n };
}

async function main() {
  const fw = new FileWritable(out);
  const writer = new McapWriter({
    writable: fw,
    useChunks: true,
    useStatistics: !UNINDEXED,
    useSummaryOffsets: !UNINDEXED,
    useChunkIndex: !UNINDEXED,
    useMessageIndex: !UNINDEXED,
    useAttachmentIndex: !UNINDEXED,
    useMetadataIndex: !UNINDEXED,
    chunkSize: 1 << 20,
    compressChunk: (data) =>
      LZ4
        ? { compression: "lz4", compressedData: Uint8Array.from((lz4 as { compress: (d: Uint8Array) => ArrayLike<number> }).compress(data)) }
        : { compression: "zstd", compressedData: new Uint8Array(nodeZstd.zstdCompressSync!(data, { params: { [nodeZstd.constants.ZSTD_c_compressionLevel]: 12 } })) },
  });
  await writer.start({ profile: "ros2", library: "lumen-replay synthetic generator" });

  const writers = new Map<string, MessageWriter>();
  const schemaIds = new Map<string, number>();
  for (const [name, text] of Object.entries(SCHEMAS)) {
    schemaIds.set(name, await writer.registerSchema({ name, encoding: "ros2msg", data: new TextEncoder().encode(text) }));
    writers.set(name, new MessageWriter(parse(text, { ros2: true })));
  }
  const jsonSchema = await writer.registerSchema({
    name: "lumen/ComponentStatus",
    encoding: "jsonschema",
    data: new TextEncoder().encode(JSON.stringify({ type: "object", properties: { state: { type: "string" }, fps: { type: "number" }, queue: { type: "integer" } } })),
  });

  const channels = new Map<string, { id: number; type: string }>();
  const chan = async (topic: string, type: string) => {
    const id = await writer.registerChannel({ topic, messageEncoding: type === "json" ? "json" : "cdr", schemaId: type === "json" ? jsonSchema : schemaIds.get(type)!, metadata: new Map() });
    channels.set(topic, { id, type });
  };
  for (const c of CAMS) {
    await chan(`/${c.name}/image_raw`, "sensor_msgs/msg/Image");
    await chan(`/${c.name}/camera_info`, "sensor_msgs/msg/CameraInfo");
    await chan(`/${c.name}/depth`, "sensor_msgs/msg/Image");
    await chan(`/${c.name}/points`, "sensor_msgs/msg/PointCloud2");
  }
  await chan("/imu/data", "sensor_msgs/msg/Imu");
  await chan("/tf_static", "tf2_msgs/msg/TFMessage");
  await chan("/component/status", "json");

  // Messages are buffered and written sorted by log time (like a real recorder).
  const queue: Array<{ topic: string; log: bigint; msg: unknown }> = [];
  const push = (topic: string, logS: number, msg: unknown) => queue.push({ topic, log: ns(logS), msg });

  // static TF (latched at t=0)
  const q = (roll: number, pitch: number, yaw: number) => {
    const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2), cpp = Math.cos(pitch / 2), spp = Math.sin(pitch / 2), cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    return { w: cr * cpp * cy + sr * spp * sy, x: sr * cpp * cy - cr * spp * sy, y: cr * spp * cy + sr * cpp * sy, z: cr * cpp * sy - sr * spp * cy };
  };
  const tf = (parent: string, child: string, t: [number, number, number], r: [number, number, number]) => ({
    header: { stamp: stampOf(0), frame_id: parent },
    child_frame_id: child,
    transform: { translation: { x: t[0], y: t[1], z: t[2] }, rotation: q(...r) },
  });
  push("/tf_static", 0, {
    transforms: [
      tf("base_link", "cam_front_link", [0.05, 0, 1.6], [0, CAMS[0].pitch, 0]),
      tf("cam_front_link", "cam_front_optical", [0, 0, 0], [-Math.PI / 2, 0, -Math.PI / 2]),
      tf("base_link", "cam_down_link", [0.05, 0, 1.6], [0, CAMS[1].pitch, 0]),
      tf("cam_down_link", "cam_down_optical", [0, 0, 0], [-Math.PI / 2, 0, -Math.PI / 2]),
      tf("base_link", "imu_link", [0, 0, 1.55], [0, 0, 0]),
    ],
  });

  // IMU 200 Hz
  for (let t = 0; t < SECONDS; t += 1 / 200) {
    const step = 1.8;
    let az = 9.81 + 2.2 * Math.max(0, Math.sin(2 * Math.PI * step * t)) ** 3 - 0.5 + gauss() * 0.15;
    const ax = 0.6 * Math.sin(2 * Math.PI * step * t + 1) + gauss() * 0.1;
    if (Math.abs(t - 5) < 0.0026) az = 120; // glitch
    push("/imu/data", t + 0.001, {
      header: { stamp: stampOf(t), frame_id: "imu_link" },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      orientation_covariance: [-1, 0, 0, 0, 0, 0, 0, 0, 0],
      angular_velocity: { x: gauss() * 0.02, y: 0.3 * Math.sin(2 * Math.PI * step * t) + gauss() * 0.02, z: gauss() * 0.02 },
      angular_velocity_covariance: new Array(9).fill(0),
      linear_acceleration: { x: ax, y: gauss() * 0.1, z: az },
      linear_acceleration_covariance: new Array(9).fill(0),
    });
  }

  const frames = Math.floor(SECONDS * FPS);
  const lastDepth = new Map<string, Uint8Array>();
  let prevDownStamp = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / FPS + 0.02;
    for (const c of CAMS) {
      const front = c.name === "cam_front";
      let st = front ? t : t + 0.003; // the two cameras are not hardware-synchronised
      if (!front && f === 140) st = prevDownStamp - 0.01; // non-monotonic stamp
      if (!front) prevDownStamp = st;
      if (front && f >= 240 && f <= 248) continue; // input gap ≈ 0.6 s
      const { rgb, depth } = render(c, t);
      const header = { stamp: stampOf(st), frame_id: `${c.name}_optical` };
      const camLog = t + 0.008 + Math.abs(gauss()) * 0.002;
      push(`/${c.name}/image_raw`, camLog, { header, height: H, width: W, encoding: "rgb8", is_bigendian: 0, step: W * 3, data: rgb });
      push(`/${c.name}/camera_info`, camLog + 0.0002, {
        header,
        height: H,
        width: W,
        distortion_model: "plumb_bob",
        d: [0, 0, 0, 0, 0],
        k: K,
        r: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        p: [FX, 0, W / 2, 0, 0, FX, H / 2, 0, 0, 0, 1, 0],
        binning_x: 0,
        binning_y: 0,
        roi: { x_offset: 0, y_offset: 0, height: 0, width: 0, do_rectify: false },
      });

      // --- component outputs -------------------------------------------------------
      if (!front && f % 2 === 1) continue; // down FOV processed at half rate
      if (front && (rand() < 0.04 || (f >= 170 && f <= 178))) continue; // drops
      let lat = 0.06 + gauss() * 0.008;
      if (front && f >= 120 && f <= 125) lat += 0.25;
      if (!front) lat += 0.02;
      lat = Math.max(0.03, lat);
      let depthBytes = depthTo16UC1(depth);
      if (!front && f >= 60 && f <= 66 && lastDepth.has(c.name)) depthBytes = lastDepth.get(c.name)!; // frozen
      lastDepth.set(c.name, depthBytes);
      push(`/${c.name}/depth`, st + lat, { header, height: H, width: W, encoding: "16UC1", is_bigendian: 0, step: W * 2, data: depthBytes });

      const cloud = !front && f === 90 ? { data: new Uint8Array(), width: 0 } : depthToCloud(depth, !front && f >= 100 && f <= 110 ? 0.7 : 0.02, front && f >= 200 && f <= 215 ? 0.8 : 0);
      push(`/${c.name}/points`, st + lat + 0.005 + Math.abs(gauss()) * 0.002, {
        header: { stamp: header.stamp, frame_id: `${c.name}_link` },
        height: 1,
        width: cloud.width,
        fields: ["x", "y", "z", "intensity"].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 })),
        is_bigendian: false,
        point_step: 16,
        row_step: cloud.width * 16,
        data: cloud.data,
        is_dense: false,
      });
    }
    if (f % 15 === 0) push("/component/status", t + 0.1, { state: f >= 170 && f <= 178 ? "degraded" : "running", fps: 14 + rand(), queue: Math.floor(rand() * 3) });
  }

  queue.sort((a, b) => (a.log < b.log ? -1 : a.log > b.log ? 1 : 0));
  let seq = 0;
  const enc = new TextEncoder();
  for (const m of queue) {
    const ch = channels.get(m.topic)!;
    const data = ch.type === "json" ? enc.encode(JSON.stringify(m.msg)) : writers.get(ch.type)!.writeMessage(m.msg);
    await writer.addMessage({ channelId: ch.id, sequence: seq++, logTime: m.log, publishTime: m.log, data });
  }
  await writer.addMetadata({ name: "recording", metadata: new Map([["device", "synthetic .lumen glasses"], ["scenario", "outdoor walk, crosswalk"]]) });
  await writer.end();
  fw.close();
  console.log(`Scris ${out}: ${queue.length} mesaje, ${SECONDS} s${UNINDEXED ? " (neindexat)" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
