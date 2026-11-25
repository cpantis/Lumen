import { describe, expect, it } from "vitest";
import { computeParity } from "../../src/core/parity";
import { canonicalMetric, evaluatePyRequirements, parsePyRequirements } from "../../src/core/pyreq";
import { topic } from "./helpers";

const MS = 1e6;
const rgbS = Array.from({ length: 21 }, (_, k) => k * 100 * MS);
const outS = rgbS.filter((_, k) => k !== 7 && k !== 8);
const rgb = topic("/cam/rgb", rgbS.map((s) => s + 5 * MS), rgbS);
const seg = topic("/cam/seg", outS.map((s, i) => s + (i === 3 ? 90 : 40) * MS), outS);
const par = computeParity([rgb, seg], (t) => t.topic === "/cam/seg", (t) => t.topic === "/cam/rgb", 2.1e9);

const YAML = `
requirements:
  - id: REQ-LAT-01
    metric: e2e_latency
    statistic: p95
    operator: "<="
    unit: ms
    thresholds:
      /cam/seg: 100
      /cam/missing: 50
  - id: REQ-RATE-01
    metric: rate
    statistic: mean
    operator: ">="
    unit: Hz
    threshold: 9.5
    topic: /cam/seg
  - id: REQ-STALL
    metric: stall
    statistic: max
    operator: "<"
    unit: s
    thresholds: [{ topic: /cam/seg, value: 0.2 }]
  - id: REQ-MEM
    metric: memory_usage
    statistic: max
    operator: "<="
    unit: MB
    thresholds: { /cam/seg: 512 }
  - id: BROKEN
    metric: e2e_latency
`;

describe("Python requirement YAML", () => {
  it("parses the accepted shapes and reports unreadable entries", () => {
    const { requirements, warnings } = parsePyRequirements(YAML);
    expect(requirements.map((r) => r.id)).toEqual(["REQ-LAT-01", "REQ-RATE-01", "REQ-STALL", "REQ-MEM"]);
    expect(requirements[1].thresholds).toEqual([{ topic: "/cam/seg", value: 9.5 }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/BROKEN/);
    const byId = parsePyRequirements("R1: { metric: rate, statistic: mean, operator: '>=', unit: Hz, thresholds: { /a: 5 } }");
    expect(byId.requirements[0]).toMatchObject({ id: "R1", operator: ">=" });
  });
  it("shows threshold vs measured with the same definitions; never guesses", () => {
    const rows = evaluatePyRequirements(parsePyRequirements(YAML).requirements, [rgb, seg], par);
    const r = (id: string, t = "/cam/seg") => rows.find((x) => x.id === id && x.topic === t)!;
    expect(r("REQ-LAT-01").measured).toBeCloseTo(par.outputs[0].e2e.p95 / MS, 9);
    expect(r("REQ-LAT-01").satisfies).toBe(true);
    expect(r("REQ-LAT-01", "/cam/missing").notComputed).toMatch(/not in this recording/);
    expect(r("REQ-RATE-01").measured).toBeCloseTo(18 / 2.0, 9); // 19 unique stamps over 2.0 s
    expect(r("REQ-RATE-01").satisfies).toBe(false);
    expect(r("REQ-STALL").measured).toBeCloseTo(0.3, 9); // frames 7–8 missing: 0.6 s → 0.9 s
    expect(r("REQ-MEM").measured).toBeUndefined();
    expect(r("REQ-MEM").notComputed).toMatch(/not computed here/);
  });
  it("metric aliases", () => {
    expect(canonicalMetric("end-to-end latency")).toBe("e2e_latency");
    expect(canonicalMetric("processing_latency")).toBe("processing_latency");
    expect(canonicalMetric("frequency")).toBe("rate");
    expect(canonicalMetric("max_interval")).toBe("interval");
    expect(canonicalMetric("cpu_load")).toBeUndefined();
  });
});
