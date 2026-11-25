import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildFovGroup, matchTopics, nsAffinity } from "../../src/core/causality";
import { contentMetrics } from "../../src/core/content";
import { imageToRgba, pixelReadout, pixelValue } from "../../src/core/image";
import { distanceM, estimateMotion, fmtDistance } from "../../src/core/motion";
import { parsePointCloud } from "../../src/core/pointcloud";
import { consistency, lookupTf, nelderMead, projectPoints, quatToRpy, rpyToMat, type Calibration } from "../../src/core/projection";
import { Sha256 } from "../../src/core/sha256";
import { detectGaps, histogram, intervals, percentileSorted, rateStats, summarize, windowRate } from "../../src/core/stats";
import { firstAtOrAfter, lastAtOrBefore, nearest, staleness } from "../../src/core/sync";
import { fmtDuration, parseTimeInput, rosTimeToNs } from "../../src/core/time";
import { topic } from "./helpers";

describe("sync — binary search", () => {
  const t = [0, 10, 20, 30];
  it("lastAtOrBefore", () => {
    expect(lastAtOrBefore(t, -1)).toBe(-1);
    expect(lastAtOrBefore(t, 0)).toBe(0);
    expect(lastAtOrBefore(t, 15)).toBe(1);
    expect(lastAtOrBefore(t, 30)).toBe(3);
    expect(lastAtOrBefore(t, 99)).toBe(3);
    expect(lastAtOrBefore([], 5)).toBe(-1);
  });
  it("firstAtOrAfter / nearest", () => {
    expect(firstAtOrAfter(t, 15)).toBe(2);
    expect(firstAtOrAfter(t, 20)).toBe(2);
    expect(nearest(t, 14)).toBe(1);
    expect(nearest(t, 16)).toBe(2);
  });
  it("matches a brute-force search on random data", () => {
    const arr = Array.from({ length: 500 }, (_, i) => i * 7 + (i % 7));
    for (let q = -5; q < 1600; q += 7) {
      let bf = -1;
      for (let i = 0; i < arr.length; i++) if (arr[i] <= q) bf = i;
      expect(lastAtOrBefore(arr, q)).toBe(bf);
    }
  });
  it("staleness levels", () => {
    expect(staleness(10, 10)).toBe("ok");
    expect(staleness(20, 10)).toBe("warn");
    expect(staleness(40, 10)).toBe("stale");
    expect(staleness(NaN, 10)).toBe("none");
  });
});

describe("stats", () => {
  const times = Array.from({ length: 101 }, (_, i) => i * 1e8); // 10 Hz, 10 s
  it("rate & jitter of a perfect 10 Hz stream", () => {
    const r = rateStats(times);
    expect(r.meanHz).toBeCloseTo(10, 6);
    expect(r.medianHz).toBeCloseTo(10, 6);
    expect(r.jitterNs).toBeCloseTo(0, 6);
    expect(r.maxGapNs).toBe(1e8);
  });
  it("detects gaps > k × median period", () => {
    const g = [...times.slice(0, 50), ...times.slice(55)];
    const gaps = detectGaps(g, 2);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].durationNs).toBe(6e8);
    expect(gaps[0].startNs).toBe(49e8);
  });
  it("percentiles, summary, histogram, intervals", () => {
    expect(percentileSorted([1, 2, 3, 4], 50)).toBe(2.5);
    const s = summarize([3, 1, 2, NaN, 4]);
    expect(s.n).toBe(4);
    expect(s.p50).toBe(2.5);
    expect(s.max).toBe(4);
    expect(histogram([0, 1, 2, 3], 2).counts).toEqual([2, 2]);
    expect(Array.from(intervals([0, 5, 15]))).toEqual([5, 10]);
  });
  it("window rate", () => {
    const w = windowRate(times, 1e9);
    expect(w.hz[50]).toBeCloseTo(10, 6);
  });
});

describe("time", () => {
  it("converts and formats", () => {
    expect(rosTimeToNs({ sec: 1, nanosec: 5 })).toBe(1_000_000_005n);
    expect(fmtDuration(1.5e6)).toBe("1.5 ms");
    expect(parseTimeInput("1500ms")).toBe(1.5e9);
    expect(parseTimeInput("2.5")).toBe(2.5e9);
    expect(parseTimeInput("abc")).toBeUndefined();
  });
});


describe("causality", () => {
  const P = 66e6;
  const inStamps = Array.from({ length: 30 }, (_, i) => i * P);
  const input = topic("/cam/image", inStamps.map((s) => s + 8e6), inStamps);
  const outIdx = inStamps.map((_, i) => i).filter((i) => i % 10 !== 3); // drop every 10th+3
  const output = topic("/cam/depth", outIdx.map((i) => inStamps[i] + 60e6), outIdx.map((i) => inStamps[i]));
  it("matches exact stamps, measures latency and drops", () => {
    const e = matchTopics(input, output)!;
    expect(e.kind).toBe("exact");
    expect(e.matchRate).toBe(1);
    expect(e.latencySummary.p50).toBeCloseTo(60e6, 0);
    expect(Array.from(e.droppedInputs)).toEqual([3, 13, 23]);
    expect(e.dropRuns).toHaveLength(3);
  });
  it("rejects outputs published before their input (negative latency)", () => {
    expect(matchTopics(output, input)).toBeUndefined();
  });
  it("groups FOV outputs by stamp", () => {
    const pts = topic("/cam/points", outIdx.slice(1).map((i) => inStamps[i] + 65e6), outIdx.slice(1).map((i) => inStamps[i]), "sensor_msgs/PointCloud2");
    const g = buildFovGroup("cam", "/cam/image", ["/cam/depth", "/cam/points"], [input, output, pts]);
    expect(g.stamps.length).toBe(outIdx.length);
    expect(g.completeRatio).toBeCloseTo((outIdx.length - 1) / outIdx.length, 6);
    expect(g.spreadNs[5]).toBeCloseTo(5e6, 0);
  });
  it("namespace affinity", () => {
    expect(nsAffinity("/cam_front/image", "/cam_front/depth")).toBe(1);
    expect(nsAffinity("/cam_down/image", "/cam_front/depth")).toBe(0);
  });
});

describe("image decoding", () => {
  it("rgb8 / bgr8 / mono8", () => {
    const rgb = { width: 1, height: 1, encoding: "rgb8", step: 3, data: Uint8Array.from([10, 20, 30]) };
    expect(Array.from(imageToRgba(rgb))).toEqual([10, 20, 30, 255]);
    const bgr = { ...rgb, encoding: "bgr8" };
    expect(Array.from(imageToRgba(bgr))).toEqual([30, 20, 10, 255]);
    const mono = { width: 2, height: 1, encoding: "mono8", step: 2, data: Uint8Array.from([7, 9]) };
    expect(Array.from(imageToRgba(mono)).slice(4)).toEqual([9, 9, 9, 255]);
  });
  it("16UC1 depth values, readout in mm, invalid = black", () => {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint16(0, 1500, true);
    const img = { width: 2, height: 1, encoding: "16UC1", step: 4, data };
    expect(pixelValue(img, 0, 0)).toBe(1500);
    expect(pixelReadout(img, 0, 0)).toContain("1.500 m");
    const rgba = imageToRgba(img, { range: { min: 0, max: 3000 } });
    expect(Array.from(rgba.slice(4))).toEqual([0, 0, 0, 255]);
  });
  it("32FC1 big endian", () => {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setFloat32(0, 2.25, false);
    expect(pixelValue({ width: 1, height: 1, encoding: "32FC1", is_bigendian: 1, step: 4, data }, 0, 0)).toBe(2.25);
  });
});

describe("content metrics", () => {
  it("point cloud NaN ratio, empty clouds", () => {
    const data = new Uint8Array(32);
    const dv = new DataView(data.buffer);
    [1, 0, 0, 0].forEach((v, i) => dv.setFloat32(i * 4, v, true));
    [NaN, NaN, NaN, 0].forEach((v, i) => dv.setFloat32(16 + i * 4, v, true));
    const fields = ["x", "y", "z", "intensity"].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 }));
    const pc = { height: 1, width: 2, fields, is_bigendian: false, point_step: 16, row_step: 32, data };
    expect(parsePointCloud(pc).positions[0]).toBe(1);
    const m = contentMetrics("sensor_msgs/msg/PointCloud2", pc);
    expect(m.nanRatio).toBe(0.5);
    expect(m.min).toBe(1);
    expect(contentMetrics("sensor_msgs/msg/PointCloud2", { ...pc, width: 0, data: new Uint8Array() }).empty).toBe(true);
  });
  it("identical frames produce identical hashes", () => {
    const img = { width: 2, height: 1, encoding: "mono8", step: 2, data: Uint8Array.from([1, 2]) };
    expect(contentMetrics("sensor_msgs/Image", img).hash).toBe(contentMetrics("sensor_msgs/Image", { ...img, data: Uint8Array.from([1, 2]) }).hash);
    expect(contentMetrics("sensor_msgs/Image", img).hash).not.toBe(contentMetrics("sensor_msgs/Image", { ...img, data: Uint8Array.from([1, 3]) }).hash);
  });
  it("IMU plausibility", () => {
    const m = contentMetrics("sensor_msgs/Imu", { linear_acceleration: { x: 0, y: 0, z: 120 }, angular_velocity: { x: 0, y: 0, z: 0 } });
    expect(m.outOfRangeRatio).toBe(0.5);
  });
});

describe("sha256", () => {
  it("matches node:crypto incrementally", () => {
    const data = new Uint8Array(200_003).map((_, i) => (i * 31) & 255);
    const h = new Sha256();
    h.update(data.subarray(0, 7)).update(data.subarray(7, 100_000)).update(data.subarray(100_000));
    expect(h.digestHex()).toBe(createHash("sha256").update(data).digest("hex"));
    expect(new Sha256().digestHex()).toBe(createHash("sha256").digest("hex"));
  });
});

describe("projection & estimation", () => {
  const cal: Calibration = {
    intrinsics: { fx: 100, fy: 100, cx: 50, cy: 50, width: 100, height: 100 },
    extrinsics: { tx: 0, ty: 0, tz: 0, roll: -Math.PI / 2, pitch: 0, yaw: -Math.PI / 2 },
    source: "manual",
  };
  it("link frame point straight ahead projects to the principal point", () => {
    const p = projectPoints(Float32Array.from([5, 0, 0]), cal);
    expect(p.u[0]).toBeCloseTo(50, 4);
    expect(p.v[0]).toBeCloseTo(50, 4);
    expect(p.depth[0]).toBeCloseTo(5, 4);
  });
  it("rpy/quaternion round trip and TF lookup", () => {
    const R = rpyToMat(0.1, 0.2, 0.3);
    expect(R[8]).toBeCloseTo(Math.cos(0.2) * Math.cos(0.1), 6);
    const tf = lookupTf([{ parent: "a", child: "b", transform: { translation: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: Math.sin(0.25), w: Math.cos(0.25) } } }], "b", "a")!;
    expect(quatToRpy(tf.rotation).yaw).toBeCloseTo(-0.5, 6);
    expect(tf.translation.x).toBeCloseTo(-Math.cos(0.5), 6);
  });
  it("Nelder–Mead finds a quadratic minimum", () => {
    const r = nelderMead((x) => (x[0] - 3) ** 2 + (x[1] + 1) ** 2, [0, 0], [1, 1], 500, 1e-12);
    expect(r.x[0]).toBeCloseTo(3, 3);
    expect(r.x[1]).toBeCloseTo(-1, 3);
  });
  it("consistency metric is ~0 for a perfectly consistent cloud", () => {
    const pts: number[] = [];
    for (let i = 0; i < 100; i++) pts.push(4 + (i % 5) * 0.1, ((i % 10) - 5) * 0.2, ((i % 7) - 3) * 0.2);
    const c = consistency(Float32Array.from(pts), cal, (u, v) => {
      // reference depth for the same synthetic geometry (row-major lookup)
      for (let i = 0; i < 100; i++) {
        const p = projectPoints(Float32Array.from(pts.slice(i * 3, i * 3 + 3)), cal);
        if (Math.round(p.u[0]) === u && Math.round(p.v[0]) === v) return p.depth[0];
      }
      return NaN;
    });
    expect(c.medianRelError).toBeCloseTo(0, 6);
    expect(c.inImageRatio).toBe(1);
  });
});

describe("motion", () => {
  it("detects steps from a synthetic walking IMU", () => {
    const n = 200 * 20;
    const t = Float64Array.from({ length: n }, (_, i) => i * 5e6);
    const acc = Float64Array.from(t, (ti) => 9.81 + 2.2 * Math.max(0, Math.sin(2 * Math.PI * 1.8 * (ti / 1e9))) ** 3);
    const m = estimateMotion({ topic: "/imu", t, accNorm: acc });
    expect(m.method).toBe("imu-steps");
    expect(m.cadenceHz).toBeCloseTo(1.8, 1);
  });
  it("falls back to 1.4 m/s and converts time to distance", () => {
    expect(estimateMotion(undefined).speedMps).toBe(1.4);
    expect(distanceM(150e6, 1.4)).toBeCloseTo(0.21, 6);
    expect(fmtDistance(0.21)).toBe("21 cm");
  });
});
