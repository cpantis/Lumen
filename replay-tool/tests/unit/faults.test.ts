/**
 * Fault-injection tests on a small synthetic recording (real MCAP, decoded by the app's
 * pipeline). Injected: a gap (segmentation stall, frames 20–24), a late output (frame 30
 * logged +900 ms), a duplicate stamp (cloud of frame 10 published twice), a missing input
 * (rgb frames 12–13). Expected values come from the generator's exact timing model, with an
 * independent numpy-style percentile. Every check is also run on the same recording
 * WITHOUT the fault and must give a different result — so a test fails if the fault is
 * removed or if the formula is changed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeRecording, type RecordingSource } from "../../src/core/analyze";
import { BufferReadable } from "../../src/core/readable";
import { computeParity, intervalStats, type ParityReport } from "../../src/core/parity";
import { staleness } from "../../src/core/sync";
import { messageAt } from "../../src/core/timebase";
import type { Analysis, TopicData } from "../../src/core/types";
import { genGeneric, jitterS, TIMING, type GenericOptions } from "../../scripts/gen-generic";

const HZ = 10;
const stampS = (k: number) => 0.05 + k / HZ; // generator: stamp of frame k
const BASE: GenericOptions = { fovs: ["f"], hz: HZ, seconds: 6, dropDepth: [7, 41] };
const FAULTY: GenericOptions = { ...BASE, segStall: [20, 24], lateSeg: [30, 0.9], dupCloud: 10, dropRgb: [12, 13] };

async function load(o: GenericOptions): Promise<{ a: Analysis; par: ParityReport; T: (n: string) => TopicData }> {
  const [b] = await genGeneric(o);
  const src: RecordingSource = { name: "faults.mcap", size: b.length, readable: new BufferReadable(b), readSlice: async (s, e) => b.slice(s, e) };
  const a = (await analyzeRecording(src, { hash: false })).analysis;
  const par = computeParity(a.topics, (t) => t.autoRole === "output", (t) => t.autoRole === "input", a.durationNs);
  return { a, par, T: (n) => a.topics.find((t) => t.topic === n)! };
}
function np(values: number[], q: number): number {
  const v = [...values].sort((x, y) => x - y);
  const pos = (q / 100) * (v.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const SEG = "/f/labels", CLOUD = "/f/fused_points", RGB = "/f/color/image";
let F: Awaited<ReturnType<typeof load>>, C: Awaited<ReturnType<typeof load>>;
// frames the faulty segmentation exists for, and its exact e2e (s)
const segFrames = Array.from({ length: 60 }, (_, k) => k).filter((k) => k !== 12 && k !== 13 && !(k >= 20 && k <= 24));
const segE2e = segFrames.map((k) => TIMING.rgbLog + jitterS(k) + TIMING.segAfterRgb + (k === 30 ? 0.9 : 0));
// t0: the recording starts at the first log time (frame 0 rgb), stamps are relative to it
const t0 = 0.05 + TIMING.rgbLog + jitterS(0);

beforeAll(async () => {
  F = await load(FAULTY);
  C = await load(BASE);
}, 60_000);

describe("late output → end-to-end and processing latency", () => {
  it("e2e = log(output) − stamp(output), every message, exactly", () => {
    // messages are in log-time order (the late frame comes later): compare per stamp
    const seg = F.T(SEG);
    expect(seg.count).toBe(segE2e.length);
    segFrames.forEach((k, i) => {
      const j = Array.from(seg.stamp).findIndex((s) => Math.abs(s / 1e9 - (stampS(k) - t0)) < 1e-6);
      expect(j, `frame ${k}`).toBeGreaterThanOrEqual(0);
      expect((seg.log[j] - seg.stamp[j]) / 1e9).toBeCloseTo(segE2e[i], 6);
    });
    const o = F.par.outputs.find((x) => x.output === SEG)!;
    expect(o.e2e.max / 1e6).toBeCloseTo((TIMING.rgbLog + jitterS(30) + TIMING.segAfterRgb + 0.9) * 1e3, 3);
    expect(o.e2e.p95 / 1e6).toBeCloseTo(np(segE2e, 95) * 1e3, 3);
    expect(o.e2e.p50 / 1e6).toBeCloseTo(np(segE2e, 50) * 1e3, 3);
    // without the late frame the max is ~50 ms, not ~950 ms
    expect(C.par.outputs.find((x) => x.output === SEG)!.e2e.max / 1e6).toBeLessThan(51);
  });
  it("processing = log(output) − log(trigger, same stamp): 41 ms, and 941 ms for the late one", () => {
    const o = F.par.outputs.find((x) => x.output === SEG)!;
    expect(o.trigger).toBe(RGB);
    expect(o.processing.n).toBe(segFrames.length);
    expect(o.processing.p50 / 1e6).toBeCloseTo(TIMING.segAfterRgb * 1e3, 3);
    expect(o.processing.max / 1e6).toBeCloseTo((TIMING.segAfterRgb + 0.9) * 1e3, 3);
    expect(C.par.outputs.find((x) => x.output === SEG)!.processing.max / 1e6).toBeCloseTo(TIMING.segAfterRgb * 1e3, 3);
  });
});

describe("gap → gap rule (interval > 1.5 × median) on both clocks", () => {
  it("finds exactly the injected gaps on header.stamp: missing rgb frames (300 ms) and the stall (600 ms)", () => {
    expect(F.T(SEG).gapsStamp!.map((g) => Math.round(g.durationNs / 1e6))).toEqual([300, 600]);
    expect(F.T(SEG).gapsStamp![1].startNs / 1e9).toBeCloseTo(stampS(19) - t0, 6);
    expect(C.T(SEG).gapsStamp).toEqual([]);
  });
  it("and on log time", () => {
    // 300 ms (missing rgb), 600 ms (stall), 200 ms between frames 29 and 31 (frame 30 is logged 0.9 s late)
    expect(F.T(SEG).gaps.map((g) => Math.round(g.durationNs / 1e8))).toEqual([3, 6, 2]);
    expect(C.T(SEG).gaps).toEqual([]);
  });
});

describe("stale rule (age > 3 × nominal period) and both clocks", () => {
  it("during the stall the output panel is stale on log time, fresh camera is not", () => {
    const t = stampS(24) - t0 + 0.05; // log time inside the stall
    const j = messageAt(F.T(SEG), t * 1e9, "log");
    const age = t * 1e9 - F.T(SEG).log[j];
    const period = F.T(SEG).inference!.framePeriodNs!.value;
    expect(period / 1e6).toBeCloseTo(100, 1);
    expect(staleness(age, period)).toBe("stale");
    const jc = messageAt(C.T(SEG), t * 1e9, "log");
    expect(staleness(t * 1e9 - C.T(SEG).log[jc], period)).toBe("ok");
    const r = messageAt(F.T(RGB), t * 1e9, "log");
    expect(staleness(t * 1e9 - F.T(RGB).log[r], F.T(RGB).inference!.framePeriodNs!.value)).toBe("ok");
  });
  it("the late output appears at its stamp on header.stamp, 900 ms later on log time", () => {
    const k30 = F.T(SEG).stamp.findIndex((s) => Math.abs(s / 1e9 - (stampS(30) - t0)) < 1e-6);
    const t = (stampS(30) - t0 + 0.06) * 1e9;
    expect(messageAt(F.T(SEG), t, "header")).toBe(k30);
    expect(messageAt(F.T(SEG), t, "log")).not.toBe(k30);
    expect(messageAt(F.T(SEG), t + 0.95e9, "log")).toBe(k30);
  });
});

describe("duplicate stamp → counts vs unique-stamp statistics", () => {
  it("count includes both copies; interval statistics use unique stamps", () => {
    const fc = F.T(CLOUD), cc = C.T(CLOUD);
    const uniq = new Set(Array.from(fc.stamp)).size;
    expect(fc.count).toBe(uniq + 1);
    expect(intervalStats(fc.stamp).n).toBe(uniq);
    expect(fc.clock!.duplicates.length).toBe(1);
    expect(new Set(Array.from(cc.stamp)).size).toBe(cc.count);
    // mean rate = (n_unique − 1) / (last − first stamp)
    const s = [...new Set(Array.from(fc.stamp))].sort((x, y) => x - y);
    expect(intervalStats(fc.stamp).meanHz).toBeCloseTo(((s.length - 1) * 1e9) / (s[s.length - 1] - s[0]), 9);
  });
});

describe("missing input → drop propagation and trigger", () => {
  it("the missing rgb frame suppresses both outputs; triggers are inferred from evidence", () => {
    const st12 = (stampS(12) - t0) * 1e9;
    const has = (t: TopicData) => Array.from(t.stamp).some((s) => Math.abs(s - st12) < 1e3);
    expect(has(F.T(SEG))).toBe(false);
    expect(has(F.T(CLOUD))).toBe(false);
    expect(has(C.T(SEG))).toBe(true);
    const seg = F.par.outputs.find((x) => x.output === SEG)!;
    const cloud = F.par.outputs.find((x) => x.output === CLOUD)!;
    expect(seg.trigger).toBe(RGB);
    expect(cloud.trigger).toBe("/f/aligned_depth");
    expect(seg.inference.confidence).toBe("evidence");
    expect(cloud.inference.confidence).toBe("evidence");
  });
});
