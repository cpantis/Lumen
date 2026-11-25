import { describe, expect, it } from "vitest";
import { computeParity, e2eLatency, framePeriod, inferTrigger, intervalStats, longestStall, percentile, processingLatency } from "../../src/core/parity";
import { topic } from "./helpers";

const MS = 1e6;

describe("percentiles = numpy default (linear interpolation)", () => {
  it("matches numpy.percentile values", () => {
    // numpy.percentile([1,2,3,4], 95) == 3.85 ; ([15,20,35,40,50], 40) == 29.0
    expect(percentile([4, 1, 3, 2], 95)).toBeCloseTo(3.85, 12);
    expect(percentile([15, 20, 35, 40, 50], 40)).toBeCloseTo(29, 12);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([1, NaN, 3], 50)).toBe(2); // NaN ignored (nanpercentile)
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("interval statistics on sorted unique stamps", () => {
  it("dedups, sorts and uses (n-1)/(last-first)", () => {
    const s = intervalStats([0, 100 * MS, 100 * MS, 300 * MS, 200 * MS, 1000 * MS]);
    expect(s.n).toBe(5);
    expect(s.meanHz).toBeCloseTo(4 / 1, 12);
    expect(s.maxNs).toBe(700 * MS);
    expect(s.maxAtNs).toBe(300 * MS);
    expect(s.medianNs).toBe(100 * MS);
  });
});

describe("frame period estimate without an assumed rate", () => {
  for (const hz of [5, 10, 15, 30]) {
    it(`${hz} Hz with dropped frames`, () => {
      const p = 1e9 / hz;
      const stamps: number[] = [];
      for (let i = 0; i < hz * 20; i++) {
        if (i % 7 === 3) continue; // single drops
        if (i > 40 && i < 46) continue; // a run of drops
        if (i % 11 === 5) continue; // more single drops (≈ 25 % of intervals are ≥ 2 periods)
        stamps.push(i * p + ((i * 7919) % 13) * 1e4); // ≤ 0.12 ms jitter
      }
      expect(Math.abs(framePeriod(stamps) - p)).toBeLessThan(0.2 * MS);
    });
  }
  it("a plain median would be biased when more than half the intervals are drops", () => {
    const p = 100 * MS;
    const stamps = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13].map((k) => k * p); // intervals 1,2,1,2,1,2,…
    expect(framePeriod(stamps)).toBe(p);
  });
});

describe("latency definitions", () => {
  const rgb = topic("/a/rgb", [10, 110, 210].map((v) => v * MS), [0, 100, 200].map((v) => v * MS));
  const out = topic("/a/seg", [60, 270].map((v) => v * MS), [0, 200].map((v) => v * MS));
  it("end-to-end = log(output) − stamp(output)", () => {
    expect(Array.from(e2eLatency(out))).toEqual([60 * MS, 70 * MS]);
  });
  it("processing = log(output) − log(trigger with the same stamp)", () => {
    expect(Array.from(processingLatency(out, rgb))).toEqual([50 * MS, 60 * MS]);
  });
});

/**
 * One FOV: rgb and depth share stamps (depth logged 5 ms later). /seg uses rgb only,
 * /cloud needs rgb and depth. Some depth frames and some rgb frames are missing.
 */
function scene() {
  const P = 100 * MS;
  const rgbS: number[] = [], depthS: number[] = [], segS: number[] = [], cloudS: number[] = [];
  for (let k = 0; k < 60; k++) {
    const s = k * P;
    const hasRgb = k % 9 !== 4;
    const hasDepth = k % 7 !== 2;
    if (hasRgb) rgbS.push(s);
    if (hasDepth) depthS.push(s);
    if (hasRgb) segS.push(s);
    if (hasRgb && hasDepth) cloudS.push(s);
  }
  const rgb = topic("/cam/rgb", rgbS.map((s) => s + 8 * MS), rgbS);
  const depth = topic("/cam/depth", depthS.map((s) => s + 13 * MS), depthS);
  const seg = topic("/cam/seg", segS.map((s) => s + 60 * MS), segS, "sensor_msgs/Image");
  const cloud = topic("/cam/cloud", cloudS.map((s) => s + 40 * MS), cloudS, "sensor_msgs/PointCloud2");
  return { rgb, depth, seg, cloud };
}

describe("trigger inference (drop propagation)", () => {
  it("an output that depends on one input only → that input", () => {
    const { rgb, depth, seg } = scene();
    const r = inferTrigger(seg, [rgb, depth]);
    expect(r.trigger).toBe("/cam/rgb");
    const d = r.candidates.find((c) => c.input === "/cam/depth")!;
    expect(d.qualifies).toBe(false);
    expect(d.producedWithout).toBeGreaterThan(0);
  });
  it("an output that needs two inputs → the one logged last", () => {
    const { rgb, depth, cloud } = scene();
    const r = inferTrigger(cloud, [rgb, depth]);
    expect(r.candidates.every((c) => c.qualifies)).toBe(true);
    expect(r.trigger).toBe("/cam/depth");
  });
  it("no stamp source → no trigger, with a reason", () => {
    const { rgb } = scene();
    const lonely = topic("/x/out", [5 * MS], [123 * MS]);
    const r = inferTrigger(lonely, [rgb]);
    expect(r.trigger).toBeUndefined();
    expect(r.reason).toMatch(/no input/);
  });
  it("computeParity honours a trigger override", () => {
    const { rgb, depth, seg, cloud } = scene();
    const all = [rgb, depth, seg, cloud];
    const isIn = (t: { topic: string }) => t.topic === rgb.topic || t.topic === depth.topic;
    const r = computeParity(all, (t) => !isIn(t), isIn, 6e9, { "/cam/seg": "/cam/depth" });
    const seg2 = r.outputs.find((o) => o.output === "/cam/seg")!;
    expect(seg2.trigger).toBe("/cam/depth");
    expect(seg2.triggerSource).toBe("override");
    expect(r.outputs.find((o) => o.output === "/cam/cloud")!.triggerSource).toBe("inferred");
  });
});

describe("longest stall on the trigger frame grid", () => {
  const P = 100 * MS;
  const trig = topic("/t", [], Array.from({ length: 20 }, (_, k) => k * P));
  trig.count = 20;
  trig.log = Float64Array.from(trig.stamp, (s) => s + MS);
  it("interior stall: from the previous productive frame to the next", () => {
    const outS = [0, 1, 2, 3, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((k) => k * P);
    const out = topic("/o", outS.map((s) => s + 50 * MS), outS);
    const s = longestStall(out, trig, 0, 2e9);
    expect(s.durationNs).toBe(6 * P);
    expect(s.missedFrames).toBe(5);
    expect(s.startNs).toBe(3 * P);
  });
  it("includes the start and the end of the recording", () => {
    const outS = [5, 6, 7, 8, 9, 10].map((k) => k * P);
    const out = topic("/o", outS.map((s) => s + 50 * MS), outS);
    const s = longestStall(out, trig, 0, 2.5e9);
    expect(s.endNs).toBe(2.5e9); // end: from frame 10 to the recording end = 1.5 s
    expect(s.durationNs).toBe(1.5e9);
    const head = longestStall(out, trig, 0, 1.2e9);
    expect(head.durationNs).toBe(5 * P); // start: recording start → frame 5
  });
  it("no missed frame → no stall", () => {
    const out = topic("/o", Array.from(trig.log), Array.from(trig.stamp));
    expect(longestStall(out, trig, 0, 2e9).missedFrames).toBe(0);
  });
});
