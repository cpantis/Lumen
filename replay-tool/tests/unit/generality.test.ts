/**
 * Generality: nothing about one recording is hard-coded. Synthetic MCAPs with other topic
 * names, 1 / 2 / 3 FOVs, 5–15 Hz cameras, with and without CameraInfo / TF / IMU, 16UC1 or
 * 32FC1 depth, clouds with or without an rgb field, split in parts: everything loads,
 * nothing crashes, and the inference finds what the generator built.
 */
import { describe, expect, it } from "vitest";
import { analyzeRecording, type RecordingSource } from "../../src/core/analyze";
import { BufferReadable } from "../../src/core/readable";
import { buildMetrics } from "../../src/core/metrics";
import { computeParity, framePeriod } from "../../src/core/parity";
import type { Analysis } from "../../src/core/types";
import { genGeneric, TIMING, topicNames, type GenericOptions } from "../../scripts/gen-generic";

const src = (b: Uint8Array, name: string): RecordingSource => ({ name, size: b.length, readable: new BufferReadable(b), readSlice: async (s, e) => b.slice(s, e) });

async function run(o: GenericOptions): Promise<Analysis> {
  const parts = await genGeneric(o);
  return (await analyzeRecording(parts.map((b, i) => src(b, `gen_${i}.mcap`)))).analysis;
}

const CASES: Array<{ name: string; o: GenericOptions; fovKeys: string[] }> = [
  { name: "3 FOVs, 10 Hz, every optional topic", o: { fovs: ["left", "centre", "right"], hz: 10, cameraInfo: true, tf: true, imu: true, dropRgb: [12, 13, 30], dropDepth: [5, 21, 22, 40], segStall: [44, 50] }, fovKeys: ["centre", "left", "right"] },
  { name: "1 FOV, root topics (FOV from frame_id), no CameraInfo/TF/IMU, 32FC1, cloud without rgb", o: { fovs: ["front"], naming: "root", hz: 10, depthEncoding: "32FC1", cloudRgb: false, dropRgb: [7, 8], dropDepth: [15, 16, 33] }, fovKeys: ["front"] },
  { name: "2 FOVs, 15 Hz, 3 parts", o: { fovs: ["near", "far"], hz: 15, cameraInfo: true, dropRgb: [20, 21], dropDepth: [9, 40, 41], parts: 3 }, fovKeys: ["far", "near"] },
  { name: "1 FOV, 5 Hz, nothing optional", o: { fovs: ["cam0"], hz: 5, seconds: 10, dropRgb: [3, 4], dropDepth: [11, 12] }, fovKeys: ["cam0"] },
];

describe.each(CASES)("generality: $name", ({ o, fovKeys }) => {
  let a: Analysis;
  it("loads without crashing, every message decodable", async () => {
    a = await run(o);
    expect(a.topics.length).toBeGreaterThanOrEqual(4 * o.fovs.length);
    for (const t of a.topics) expect(t.content.decodeError.reduce((x, y) => x + y, 0), t.topic).toBe(0);
    if (!o.cameraInfo) expect(a.topics.some((t) => t.type === "sensor_msgs/CameraInfo")).toBe(false);
    if (!o.tf) expect(a.topics.some((t) => t.type === "tf2_msgs/TFMessage")).toBe(false);
    if (o.parts && o.parts > 1) expect(a.files).toHaveLength(o.parts);
  });
  it("infers the FOVs, the roles and the triggers", () => {
    expect([...new Set(a.topics.map((t) => t.autoFov).filter(Boolean))].sort()).toEqual(fovKeys);
    const par = computeParity(a.topics, (t) => t.autoRole === "output", (t) => t.autoRole === "input", a.durationNs);
    for (const f of o.fovs) {
      const tn = topicNames(o, f);
      const T = (n: string) => a.topics.find((t) => t.topic === n)!;
      expect(T(tn.rgb).autoRole, tn.rgb).toBe("input");
      expect(T(tn.depth).autoRole, `${tn.depth}: ${T(tn.depth).roleReason}`).toBe("input");
      expect(T(tn.seg).autoRole).toBe("output");
      expect(T(tn.cloud).autoRole).toBe("output");
      // segmentation depends on rgb only; the coloured cloud needs rgb and depth → depth (logged last)
      expect(par.outputs.find((x) => x.output === tn.seg)!.trigger).toBe(tn.rgb);
      expect(par.outputs.find((x) => x.output === tn.cloud)!.trigger).toBe(tn.depth);
    }
  });
  it("derives periods, depth unit/range and cloud colouring from the data", () => {
    const hz = o.hz ?? 10;
    for (const f of o.fovs) {
      const tn = topicNames(o, f);
      const T = (n: string) => a.topics.find((t) => t.topic === n)!;
      expect(T(tn.rgb).inference!.framePeriodNs!.value).toBeCloseTo(1e9 / hz, -5); // within 0.1 ms
      expect(Math.abs(framePeriod(T(tn.cloud).stamp) - 1e9 / hz)).toBeLessThan(2e5);
      expect(T(tn.depth).inference!.depthUnit!.value).toBe(o.depthEncoding === "32FC1" ? "m" : "mm");
      expect(T(tn.depth).inference!.depthMaxM!.value).toBe(5); // valid max 4.1 m → rounded up
      expect(T(tn.cloud).inference!.cloudColour!.value).toBe(o.cloudRgb === false ? "distance" : "rgb");
    }
  });
  it("measures latency with the Python definitions (exact generator timing)", () => {
    const par = computeParity(a.topics, (t) => t.autoRole === "output", (t) => t.autoRole === "input", a.durationNs);
    const tn = topicNames(o, o.fovs[0]);
    const seg = par.outputs.find((x) => x.output === tn.seg)!;
    // proc = seg log − rgb log = 41 ms exactly; e2e = rgb log offset (8 ms + jitter ≤ 1.2 ms) + 41 ms
    expect(seg.processing.p50 / 1e6).toBeCloseTo(TIMING.segAfterRgb * 1e3, 3);
    expect(seg.e2e.min / 1e6).toBeGreaterThanOrEqual((TIMING.rgbLog + TIMING.segAfterRgb) * 1e3 - 1e-3);
    expect(seg.e2e.max / 1e6).toBeLessThanOrEqual((TIMING.rgbLog + TIMING.segAfterRgb) * 1e3 + 1.2 + 1e-3);
    const cloud = par.outputs.find((x) => x.output === tn.cloud)!;
    expect(cloud.processing.p50 / 1e6).toBeCloseTo(TIMING.cloudAfterDepth * 1e3, 3);
    if (o.segStall) {
      // frames 44–50 missing: stall from frame 43 to frame 51 = 8 periods
      expect(seg.stall!.durationNs / 1e9).toBeCloseTo(8 / (o.hz ?? 10), 6);
      expect(seg.stall!.missedFrames).toBe(7);
    }
    const m = buildMetrics(a, "test");
    expect(m.outputs![tn.seg].trigger).toBe(tn.rgb);
  });
});
