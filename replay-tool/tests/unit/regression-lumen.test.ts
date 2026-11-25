/**
 * Regression on the .lumen challenge recording — runs only when the file is present:
 *   LUMEN_MCAP=/path/to/recording.mcap npm test        (or a directory of consecutive parts)
 * or the file placed in fixtures/lumen/. Skipped otherwise.
 *
 * These numbers are the values measured by the Python test suite (lumen_sw_test). They
 * live ONLY here, never as defaults in the app. If a value differs, the definition in
 * src/core/parity.ts is wrong, not the expected number.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRecording } from "../../src/core/analyze";
import { computeParity, type ParityReport } from "../../src/core/parity";
import type { Analysis } from "../../src/core/types";
import { nodeSource } from "../../scripts/node-source";

function findRecording(): string[] {
  const cands = [process.env.LUMEN_MCAP, "fixtures/lumen", "../fixtures/lumen"].filter(Boolean) as string[];
  for (const c of cands) {
    if (!existsSync(c)) continue;
    if (statSync(c).isDirectory()) {
      const parts = readdirSync(c).filter((f) => f.endsWith(".mcap")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((f) => join(c, f));
      if (parts.length) return parts;
    } else return [c];
  }
  return [];
}

const FILES = findRecording();
const MS = 1e6;

describe.skipIf(!FILES.length)(".lumen challenge recording (regression vs the Python suite)", () => {
  let a: Analysis;
  let par: ParityReport;
  const O = (topic: string) => {
    const o = par.outputs.find((x) => x.output === topic);
    if (!o) throw new Error(`${topic} is not an inferred output (outputs: ${par.outputs.map((x) => x.output).join(", ")})`);
    return o;
  };
  const close = (got: number, want: number, tol: number, what: string) => expect(Math.abs(got - want), `${what}: got ${got}, expected ${want} ± ${tol}`).toBeLessThanOrEqual(tol + 1e-9);

  it("loads and infers the outputs", async () => {
    a = (await analyzeRecording(FILES.map(nodeSource), { hash: false })).analysis;
    par = computeParity(a.topics, (t) => t.autoRole === "output", (t) => t.autoRole === "input", a.durationNs);
    for (const t of ["/farfield/Semantic", "/farfield/ColorizedPointCloud", "/nearfield/Semantic", "/nearfield/ColorizedPointCloud"]) expect(O(t)).toBeDefined();
  }, 600_000);

  it("infers trigger = RGB for Semantic and depth for ColorizedPointCloud", () => {
    for (const fov of ["farfield", "nearfield"]) {
      expect(O(`/${fov}/Semantic`).trigger, O(`/${fov}/Semantic`).inference.reason).toMatch(/rgb|color|colour/i);
      expect(O(`/${fov}/ColorizedPointCloud`).trigger, O(`/${fov}/ColorizedPointCloud`).inference.reason).toMatch(/depth/i);
    }
  });

  it("/farfield/Semantic", () => {
    const o = O("/farfield/Semantic");
    close(o.e2e.p50 / MS, 108.7, 0.1, "e2e p50 ms");
    close(o.e2e.p95 / MS, 342.6, 0.1, "e2e p95 ms");
    close(o.e2e.max / MS, 1897.5, 0.1, "e2e max ms");
    close(o.processing.p95 / MS, 249.0, 0.1, "proc p95 ms");
    close(o.intervals.meanHz, 4.66, 0.01, "rate Hz");
    close(o.intervals.maxNs / MS, 1866.9, 0.1, "max interval ms");
  });

  it("/farfield/ColorizedPointCloud", () => {
    const o = O("/farfield/ColorizedPointCloud");
    close(o.e2e.p95 / MS, 215.6, 0.1, "e2e p95 ms");
    close(o.e2e.max / MS, 341.2, 0.1, "e2e max ms");
    close(o.intervals.meanHz, 4.2, 0.01, "rate Hz");
    close(o.intervals.maxNs / MS, 2067.0, 0.1, "max interval ms");
  });

  it("/nearfield/Semantic", () => {
    const o = O("/nearfield/Semantic");
    close(o.e2e.p95 / MS, 164.5, 0.1, "e2e p95 ms");
    close(o.processing.p95 / MS, 115.1, 0.1, "proc p95 ms");
    close(o.intervals.meanHz, 14.2, 0.01, "rate Hz");
  });

  it("/nearfield/ColorizedPointCloud", () => {
    const o = O("/nearfield/ColorizedPointCloud");
    close(o.e2e.p95 / MS, 113.3, 0.1, "e2e p95 ms");
    close(o.e2e.max / MS, 201.6, 0.1, "e2e max ms");
    close(o.intervals.meanHz, 13.66, 0.01, "rate Hz");
  });

  it("longest stall on the frame grid = 3.77 s", () => {
    expect(par.longestStall).toBeDefined();
    close(par.longestStall!.durationNs / 1e9, 3.77, 0.005, `longest stall s (${par.longestStall!.output})`);
  });
});

describe.runIf(!FILES.length)(".lumen challenge recording", () => {
  it.skip("skipped: recording not found (set LUMEN_MCAP or put it in fixtures/lumen/)", () => undefined);
});
