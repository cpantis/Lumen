/**
 * Compatibility with "another recording":
 *  1. the 416 official MCAP conformance files (foxglove/mcap, MIT) — every variant of
 *     chunking / indexes / summary / statistics / padding / repeated records;
 *  2. recordings written by the OFFICIAL Python writers (scripts/gen-realworld.py):
 *     ROS 2 (zstd, lz4, unchunked), ROS 1, Foxglove schemas in protobuf and JSON, cbor,
 *     msgpack, omgidl, ros2idl, flatbuffer (unsupported), truncated, corrupt, not-MCAP.
 */
import { describe, expect, it } from "vitest";
import { analyzeRecording, iterateAll, openRecording } from "../../src/core/analyze";
import { makeDecoder } from "../../src/core/decode";
import { pixelValue, type RosImage } from "../../src/core/image";
import { parsePointCloud, type RosPointCloud2 } from "../../src/core/pointcloud";
import type { Analysis } from "../../src/core/types";
import { nodeSource } from "../../scripts/node-source";
import { runConformance } from "../../scripts/conformance";

const RW = "fixtures/realworld";

async function analyze(name: string): Promise<Analysis> {
  return (await analyzeRecording(nodeSource(`${RW}/${name}`), { hash: false })).analysis;
}

/** First decoded message of a topic (via the same decoders as the app). */
async function first(name: string, topic: string): Promise<any> {
  const rec = await openRecording(nodeSource(`${RW}/${name}`));
  const ch = [...rec.channels.values()].find((c) => c.topic === topic)!;
  const dec = makeDecoder(ch, rec.schemas.get(ch.schemaId));
  for await (const m of iterateAll(rec, [topic])) return dec(m.data);
}

const T = (a: Analysis, topic: string) => a.topics.find((t) => t.topic === topic)!;

describe("official MCAP conformance files", () => {
  it("reads all 416 variants with exactly the expected messages", async () => {
    const res = await runConformance("fixtures/conformance");
    expect(res.length).toBe(416);
    expect(res.filter((r) => !r.ok).map((r) => `${r.file}: ${r.error}`)).toEqual([]);
  }, 120_000);
});

describe("ROS 2 recordings from mcap-ros2-support", () => {
  for (const f of ["ros2_zstd.mcap", "ros2_lz4.mcap", "ros2_unchunked.mcap"]) {
    it(`${f}: topics, rates, classification, causality, FOV`, async () => {
      const a = await analyze(f);
      expect(a.topics.reduce((s, t) => s + t.count, 0)).toBe(892);
      expect(a.indexed).toBe(f !== "ros2_unchunked.mcap");
      expect(T(a, "/imu/data").rate.meanHz).toBeCloseTo(100, 0);
      // hardware-synchronised IMU stamps must NOT make the camera an "output"
      expect(T(a, "/camera/image_raw").autoRole).toBe("input");
      expect(T(a, "/camera/image_raw/compressed").autoRole).toBe("input");
      expect(T(a, "/perception/depth").autoRole).toBe("output");
      expect(T(a, "/perception/points").autoRole).toBe("output");
      expect(a.edges.some((e) => e.input === "/imu/data")).toBe(false);
      const e = a.edges.find((x) => x.input === "/camera/image_raw" && x.output === "/perception/depth")!;
      expect(e.latencySummary.p50 / 1e6).toBeCloseTo(50, 0);
      expect(e.dropRuns.some(([, , n]) => n === 5)).toBe(true);
      expect(a.fovGroups).toHaveLength(1);
      expect(a.motion.method).toBe("imu-steps");
    });
  }
  it("decodes 32FC1 depth and the JPEG CompressedImage", async () => {
    const d = (await first("ros2_zstd.mcap", "/perception/depth")) as RosImage;
    expect(d.encoding).toBe("32FC1");
    expect(pixelValue(d, 32, 47)).toBeGreaterThan(1);
    const c = await first("ros2_zstd.mcap", "/camera/image_raw/compressed");
    expect(Array.from(c.data.slice(0, 2))).toEqual([0xff, 0xd8]); // JPEG SOI
  });
});

describe("ROS 1 recording from mcap-ros1-support", () => {
  it("decodes ros1/ros1msg, normalises CameraInfo K→k, finds the causal chain", async () => {
    const a = await analyze("ros1.mcap");
    expect(T(a, "/camera/image_raw").type).toBe("sensor_msgs/Image");
    expect(T(a, "/camera/image_raw").details["encoding"]).toBe("bgr8");
    expect(T(a, "/camera/camera_info").details["intrinseci"]).toContain("fx=32.0");
    expect(T(a, "/perception/points").autoRole).toBe("output");
    const ci = await first("ros1.mcap", "/camera/camera_info");
    expect(Array.from(ci.k as number[])[0]).toBeCloseTo(32, 6);
    expect(ci.header.stamp.nsec ?? ci.header.stamp.nanosec).toBeDefined();
  });
});

describe("Foxglove well-known schemas", () => {
  it("protobuf (mcap-protobuf-support + foxglove-schemas-protobuf)", async () => {
    const a = await analyze("foxglove_protobuf.mcap");
    expect(T(a, "/camera/image").type).toBe("sensor_msgs/Image");
    expect(T(a, "/camera/compressed").type).toBe("sensor_msgs/CompressedImage");
    expect(T(a, "/camera/calibration").type).toBe("sensor_msgs/CameraInfo");
    expect(T(a, "/perception/cloud").type).toBe("sensor_msgs/PointCloud2");
    expect(T(a, "/perception/scan").type).toBe("sensor_msgs/LaserScan");
    expect(T(a, "/tf").type).toBe("tf2_msgs/TFMessage");
    expect(T(a, "/perception/cloud").autoRole).toBe("output");
    expect(T(a, "/perception/cloud").autoFov).toBe("camera");
    // PackedElementField.NumericType UINT8=1 must become ROS PointField UINT8=2
    const pc = (await first("foxglove_protobuf.mcap", "/perception/cloud")) as RosPointCloud2;
    expect(pc.fields.find((f) => f.name === "intensity")!.datatype).toBe(2);
    const parsed = parsePointCloud(pc);
    expect(parsed.count).toBe(352);
    expect(parsed.fields.intensity[3]).toBe(3);
    expect(Number.isFinite(parsed.positions[parsed.count * 3 - 3])).toBe(true);
    const img = (await first("foxglove_protobuf.mcap", "/camera/image")) as RosImage & { header: { stamp: { sec: number } } };
    expect(img.width).toBe(64);
    expect(img.header.stamp.sec).toBe(1_731_500_000);
  });
  it("json (base64 bytes, {sec,nsec} timestamps)", async () => {
    const a = await analyze("foxglove_json.mcap");
    expect(T(a, "/camera/image").type).toBe("sensor_msgs/Image");
    expect(T(a, "/camera/image").hasHeader).toBe(true);
    const img = (await first("foxglove_json.mcap", "/camera/image")) as RosImage;
    expect(img.data.length).toBe(64 * 48 * 3);
    expect(a.edges.find((e) => e.output === "/perception/cloud")!.latencySummary.p50 / 1e6).toBeCloseTo(55, 0);
  });
});

describe("other registry encodings", () => {
  it("cbor, msgpack (schemaless), cdr+omgidl, cdr+ros2idl (root not first)", async () => {
    expect(await first("misc_encodings.mcap", "/diag/cbor")).toEqual({ cpu: 40, temp_c: 51.5, ok: true });
    expect((await first("misc_encodings.mcap", "/diag/msgpack")).mode).toBe("walk");
    const ob = await first("misc_encodings.mcap", "/perception/obstacle");
    expect(ob.distance).toBeCloseTo(5, 5);
    expect(ob.header.frame_id).toBe("camera");
    const h = await first("misc_encodings.mcap", "/haptic/cmd");
    expect(h.motor).toBe(0);
    expect(h.stamp.sec).toBe(1_731_500_000);
  });
  it("flatbuffer is reported as unsupported without crashing the analysis", async () => {
    const a = await analyze("misc_encodings.mcap");
    const t = T(a, "/status/flatbuffer");
    expect(t.count).toBe(20);
    expect(t.content.decodeError.every((x) => x === 1)).toBe(true);
    expect(t.firstError).toContain("flatbuffer");
    expect(T(a, "/perception/obstacle").content.decodeError.some((x) => x === 1)).toBe(false);
  });
});

describe("damaged / wrong files", () => {
  it("truncated file: sequential fallback keeps the readable part, with a warning", async () => {
    const a = await analyze("truncated.mcap");
    expect(a.indexed).toBe(false);
    expect(a.warnings.join(" ")).toMatch(/Index MCAP inutilizabil/);
    expect(T(a, "/camera/image_raw").count).toBeGreaterThan(20);
    expect(a.durationNs / 1e9).toBeLessThan(6);
  });
  it("corrupt chunk: damaged chunk skipped and reported, the rest recovered, real time span kept", async () => {
    const a = await analyze("corrupt_chunk.mcap");
    expect(a.warnings.join(" ")).toMatch(/1 din 2 chunk-uri sunt deteriorate/);
    expect(T(a, "/imu/data").count).toBeGreaterThan(200);
    expect(T(a, "/imu/data").rate.meanHz).toBeCloseTo(100, 0); // no garbage timestamps
    expect(a.durationNs / 1e9).toBeCloseTo(5.99, 1);
  });
  it("not an MCAP file: clear error naming the real format", async () => {
    await expect(analyze("not_mcap.db3")).rejects.toThrow(/rosbag2 SQLite/);
  });
});
