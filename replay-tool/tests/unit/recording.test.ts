/**
 * Integration tests on the synthetic recording (generated deterministically): the
 * analysis must find exactly the defects that the generator injects.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeRecording } from "../../src/core/analyze";
import { buildMetrics, crossCheck } from "../../src/core/metrics";
import { compareReports, evaluate, parseReport, parseThresholds, regenerateDerived, toReport } from "../../src/core/requirements";
import type { Analysis } from "../../src/core/types";
import { nodeSource } from "../../scripts/node-source";

const FILE = "fixtures/test-synthetic.mcap";
const UNIDX = "fixtures/test-unindexed.mcap";
let a: Analysis;
const cfg = parseThresholds(readFileSync("config/thresholds.yaml", "utf8"));

beforeAll(async () => {
  execFileSync("npx", ["tsx", "scripts/gen-synthetic.ts", FILE, "--seconds", "20"], { stdio: "ignore" });
  execFileSync("npx", ["tsx", "scripts/gen-synthetic.ts", UNIDX, "--seconds", "4", "--unindexed"], { stdio: "ignore" });
  a = (await analyzeRecording(nodeSource(FILE))).analysis;
}, 60_000);

const T = (name: string) => a.topics.find((t) => t.topic === name)!;

describe("synthetic recording", () => {
  it("is indexed and has every topic", () => {
    expect(a.indexed).toBe(true);
    expect(a.topics.map((t) => t.topic)).toEqual(
      expect.arrayContaining(["/cam_front/image_raw", "/cam_front/depth", "/cam_front/points", "/cam_down/image_raw", "/imu/data", "/tf_static", "/component/status"]),
    );
    expect(T("/imu/data").rate.meanHz).toBeCloseTo(200, 0);
  });
  it("classifies inputs and outputs from evidence", () => {
    expect(T("/cam_front/image_raw").autoRole).toBe("input");
    expect(T("/cam_front/depth").autoRole).toBe("output"); // an Image, but derived
    expect(T("/cam_front/depth").roleReason).toContain("/cam_front/image_raw");
    expect(T("/cam_down/points").autoFov).toBe("cam_down");
    expect(a.fovGroups.map((g) => g.fov)).toEqual(["cam_down", "cam_front"]);
  });
  it("finds the injected latency spike and drops", () => {
    const e = a.edges.find((x) => x.input === "/cam_front/image_raw" && x.output === "/cam_front/depth")!;
    expect(e.latencySummary.p50 / 1e6).toBeGreaterThan(50);
    expect(e.latencySummary.max / 1e6).toBeGreaterThan(280);
    expect(e.dropRuns.some(([, , len]) => len >= 9)).toBe(true);
  });
  it("finds the input gap, frozen frames, empty cloud, non-monotonic stamp", () => {
    expect(T("/cam_front/image_raw").rate.maxGapNs / 1e6).toBeGreaterThan(600);
    const res = evaluate(a, cfg, "strict");
    const r = (id: string) => res.find((x) => x.id === id)!;
    expect(r("REQ-CONT-06").violations.some((v) => v.topic === "/cam_down/depth")).toBe(true);
    expect(r("REQ-CONT-01").violations.some((v) => v.topic === "/cam_down/points")).toBe(true);
    expect(r("REQ-CLK-01").violations.some((v) => v.topic === "/cam_down/image_raw")).toBe(true);
    expect(r("REQ-CONT-05").violations.some((v) => v.topic === "/imu/data")).toBe(true);
    expect(r("REQ-CONT-02").verdict).toBe("PASS");
  });
  it("estimates walking speed from the IMU", () => {
    expect(a.motion.method).toBe("imu-steps");
    expect(a.motion.cadenceHz).toBeCloseTo(1.8, 1);
  });
  it("is deterministic: identical metrics on a second run; cross-check passes", async () => {
    const b = (await analyzeRecording(nodeSource(FILE))).analysis;
    expect(b.sha256).toBe(a.sha256);
    const rows = crossCheck(buildMetrics(a, "x"), buildMetrics(b, "y"));
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.every((r) => r.ok)).toBe(true);
  });
  it("report round trip (export → import) keeps locations", () => {
    const res = evaluate(a, cfg, "derived");
    const rep = toReport(a, res, "derived", "test");
    const back = parseReport(JSON.parse(JSON.stringify(rep)), a.startNs);
    expect(back.failures.length).toBe(rep.failures.length);
    const v = res.flatMap((r) => r.violations)[0];
    expect(Math.abs(back.failures[0].startNs - v.startNs)).toBeLessThan(1);
    const diff = compareReports(rep, toReport(a, evaluate(a, cfg, "strict"), "strict", "test"));
    expect(diff.some((d) => d.changed)).toBe(true);
  });
  it("regenerated derived profile passes the latency requirement on this recording", () => {
    const d = regenerateDerived(a, cfg);
    const lat = evaluate(a, d, "derived").find((r) => r.id === "REQ-LAT-01")!;
    expect(lat.verdict).toBe("PASS");
  });
  it("falls back to sequential reading for un-indexed files", async () => {
    const u = (await analyzeRecording(nodeSource(UNIDX), { hash: false })).analysis;
    expect(u.indexed).toBe(false);
    expect(u.warnings[0]).toContain("secvențial");
    expect(u.topics.find((t) => t.topic === "/imu/data")!.count).toBeGreaterThan(700);
  });
});
