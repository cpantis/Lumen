import { describe, expect, it } from "vitest";
import { frameTimestampUs, parseTimeList, planVideo, pngTextChunks, pngWithText, snapshotName } from "../../src/core/exportplan";

describe("deterministic video plan", () => {
  it("frame k is at start + k / fps of recording time, exactly", () => {
    const p = planVideo(2e9, 4e9, 30, 1);
    expect(p.times).toHaveLength(61);
    expect(p.times[0]).toBe(2e9);
    expect(p.times[1]).toBeCloseTo(2e9 + 1e9 / 30, 3);
    expect(p.times[30]).toBe(3e9);
    expect(p.times[60]).toBe(4e9);
    // no accumulated drift over a long interval
    const long = planVideo(0, 600e9, 30);
    expect(long.times[17999]).toBeCloseTo((17999 * 1e9) / 30, 3);
  });
  it("the plan depends only on its inputs (same plan twice)", () => {
    expect(planVideo(0.25e9, 7.3e9, 24, 0.5)).toEqual(planVideo(0.25e9, 7.3e9, 24, 0.5));
  });
  it("speed factor changes the playback rate, not the sampled moments", () => {
    const a = planVideo(0, 1e9, 30, 1), b = planVideo(0, 1e9, 30, 2);
    expect(b.times).toEqual(a.times);
    expect(b.videoFps).toBe(60);
    expect(frameTimestampUs(30, a.videoFps)).toBe(1_000_000);
    expect(frameTimestampUs(30, b.videoFps)).toBe(500_000);
  });
  it("rejects non-positive fps / speed", () => {
    expect(() => planVideo(0, 1e9, 0)).toThrow();
    expect(() => planVideo(0, 1e9, 30, -1)).toThrow();
  });
});

describe("snapshots", () => {
  it("names: 2 decimals, zero-padded to 6 characters", () => {
    expect(snapshotName(3.5e9)).toBe("replay_003.50s.png");
    expect(snapshotName(12.345e9)).toBe("replay_012.35s.png");
    expect(snapshotName(123.4e9)).toBe("replay_123.40s.png");
    expect(snapshotName(0)).toBe("replay_000.00s.png");
  });
  it("time lists", () => {
    expect(parseTimeList("1.5, 12 250ms; 3s")).toEqual({ times: [1.5e9, 12e9, 0.25e9, 3e9], invalid: [] });
    expect(parseTimeList("4, abc").invalid).toEqual(["abc"]);
  });
  it("metadata travels inside the PNG (tEXt chunk, valid CRC)", () => {
    // 1×1 PNG
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const out = pngWithText(png, "StampTrace", JSON.stringify({ sha256: "ab", t_s: 1.5 }));
    expect(JSON.parse(pngTextChunks(out).StampTrace)).toEqual({ sha256: "ab", t_s: 1.5 });
    expect(out.length).toBe(png.length + 12 + "StampTrace".length + 1 + JSON.stringify({ sha256: "ab", t_s: 1.5 }).length);
  });
});
