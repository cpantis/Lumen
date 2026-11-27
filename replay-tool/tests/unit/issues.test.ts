import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIssues } from "../../src/core/issues";

describe("issue markers from JSON", () => {
  it("reads the demo file: windows, clocks, jump times, topics", () => {
    const { issues, warnings } = parseIssues(readFileSync("docs/demo/lumen-issues.json", "utf8"), 0n);
    expect(warnings).toEqual([]);
    expect(issues.map((i) => i.id)).toEqual(["ISSUE-1", "ISSUE-2", "ISSUE-3"]);
    expect(issues[0]).toMatchObject({ startNs: 29.9e9, endNs: 33.714e9, jumpNs: 33.7e9, clock: "log" });
    expect(issues[1].jumpNs).toBeCloseTo(28.53e9, -1);
    expect(issues[2]).toMatchObject({ startNs: 14.836e9, endNs: 14.836e9, clock: "header" });
  });
  it("accepts other shapes and absolute ns; reports entries without a time", () => {
    const start = 1_700_000_000_000_000_000n;
    const r = parseIssues(JSON.stringify([{ name: "A", window_s: [2, 3] }, { id: "B", t_start_ns: String(start + 5_000_000_000n) }, { id: "C" }]), start);
    expect(r.issues.map((i) => [i.id, i.startNs, i.endNs])).toEqual([["A", 2e9, 3e9], ["B", 5e9, 5e9]]);
    expect(r.warnings[0]).toMatch(/^C: skipped/);
    expect(() => parseIssues("{}", 0n)).toThrow(/issues/);
  });
});
