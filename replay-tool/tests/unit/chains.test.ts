/**
 * Latency chains of the replay strip. Reproduces the "p95 218.7 vs 215.6 ms" mechanism:
 * the old strip measured an edge (output vs another topic with the same stamps), i.e. only
 * the output messages whose stamp also exists in that topic — a subset — while the
 * reference measures every output message.
 */
import { describe, expect, it } from "vitest";
import { matchTopics } from "../../src/core/causality";
import { computeParity, latencyChains, percentile } from "../../src/core/parity";
import { topic } from "./helpers";

const MS = 1e6;
// 40 frames at 10 Hz; cloud uses all depth frames, semantic only every other one;
// the cloud messages WITHOUT a semantic twin are the slow ones.
const stamps = Array.from({ length: 40 }, (_, k) => k * 100 * MS);
const rgb = topic("/f/CameraRGB", stamps.map((s) => s + 5 * MS), stamps);
// depth misses frames 4 and 13 (Semantic is produced there anyway: it does not need depth)
const depthS = stamps.filter((_, k) => k !== 4 && k !== 13);
const depth = topic("/f/CameraDepth", depthS.map((s) => s + 6 * MS), depthS);
const semS = stamps.filter((_, k) => k % 2 === 0);
const sem = topic("/f/Semantic", semS.map((s) => s + 90 * MS), semS);
const cloudK = stamps.map((_, k) => k).filter((k) => k !== 4 && k !== 13); // needs depth
const cloudLat = cloudK.map((k) => (k % 2 === 0 ? 100 : 160 + k) * MS);
const cloud = topic("/f/ColorizedPointCloud", cloudK.map((k, i) => stamps[k] + cloudLat[i]), cloudK.map((k) => stamps[k]), "sensor_msgs/PointCloud2");
const all = [rgb, depth, sem, cloud];
const par = computeParity(all, (t) => t === sem || t === cloud, (t) => t === rgb || t === depth, 4e9);
const chains = latencyChains(all, par);

describe("latency chains", () => {
  it("are named after what is measured, e2e and processing for every output", () => {
    expect(chains.map((c) => c.label)).toEqual([
      "/f/CameraRGB → /f/Semantic (e2e)",
      "/f/CameraRGB → /f/Semantic (processing)",
      "/f/CameraDepth → /f/ColorizedPointCloud (e2e)",
      "/f/CameraDepth → /f/ColorizedPointCloud (processing)",
    ]);
  });
  it("e2e covers all n output messages: log(output) − stamp(output)", () => {
    const c = chains.find((x) => x.id === "/f/ColorizedPointCloud|e2e")!;
    expect(c.summary.n).toBe(38);
    expect(c.summary.p95).toBeCloseTo(percentile(cloudLat, 95), 6);
  });
  it("the old edge-based value is a subset statistic and differs", () => {
    const edge = matchTopics(sem, cloud)!; // what the old strip showed for "Semantic → ColorizedPointCloud"
    expect(edge.matched).toBe(19);
    expect(edge.latencySummary.p95).not.toBeCloseTo(chains.find((x) => x.id === "/f/ColorizedPointCloud|e2e")!.summary.p95, 0);
  });
  it("processing = log(output) − log(trigger, same stamp)", () => {
    const c = chains.find((x) => x.id === "/f/ColorizedPointCloud|processing")!;
    expect(c.values[1]).toBeCloseTo(cloudLat[1] - 6 * MS, 6);
    expect(c.summary.n).toBe(38);
    const s = chains.find((x) => x.id === "/f/Semantic|processing")!;
    expect(s.values[0]).toBeCloseTo(85 * MS, 6);
    expect(s.summary.n).toBe(20);
  });
});

describe("trigger evidence", () => {
  it("is confirmed when a candidate's missing frames show the output does not need it", () => {
    const s = par.outputs.find((o) => o.output === "/f/Semantic")!;
    expect(s.trigger).toBe("/f/CameraRGB");
    expect(s.inference.confidence).toBe("evidence");
  });
  it("is flagged as a tie-break when no frame is ever missing (no data to tell inputs apart)", () => {
    const d2 = topic("/f/CameraDepth", stamps.map((x) => x + 6 * MS), stamps);
    const p2 = computeParity([rgb, d2, sem], (t) => t === sem, (t) => t === rgb || t === d2, 4e9);
    const s = p2.outputs[0];
    expect(s.inference.confidence).toBe("tie-break");
    expect(s.inference.reason).toMatch(/cannot tell|no missing frame/i);
  });
});
