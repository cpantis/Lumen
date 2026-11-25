import { describe, expect, it } from "vitest";
import { BEV_PAD, bevPixel, bevView, ringStep } from "../../src/core/bev";
import { classColour, classMapClasses, imageToRgba, type RosImage } from "../../src/core/image";
import { cloudRgb, type RosPointCloud2 } from "../../src/core/pointcloud";
import { staleness } from "../../src/core/sync";
import { messageAt } from "../../src/core/timebase";
import { topic } from "./helpers";

const MS = 1e6;

describe("time bases", () => {
  // message 1 has stamp 100 ms but is logged late, at 500 ms (after message 2)
  const t = topic("/a/out", [50, 500, 300].map((v) => v * MS).sort((x, y) => x - y), [0, 200, 100].map((v) => v * MS));
  // log-sorted: [50 → stamp 0], [300 → stamp 200], [500 → stamp 100]
  it("log base: last message logged at or before t", () => {
    expect(messageAt(t, 40 * MS, "log")).toBe(-1);
    expect(messageAt(t, 320 * MS, "log")).toBe(1);
    expect(messageAt(t, 600 * MS, "log")).toBe(2);
  });
  it("stamp base: a late-logged message appears at its stamp, ordered by stamp", () => {
    expect(messageAt(t, 99 * MS, "header")).toBe(0);
    expect(messageAt(t, 100 * MS, "header")).toBe(2); // logged at 500 ms, shown at its stamp 100 ms
    expect(messageAt(t, 150 * MS, "header")).toBe(2);
    expect(messageAt(t, 200 * MS, "header")).toBe(1);
    expect(messageAt(t, -1, "header")).toBe(-1);
  });
  it("falls back to log time for topics without header", () => {
    const n = { ...t, hasHeader: false };
    expect(messageAt(n, 320 * MS, "header")).toBe(1);
  });
});

describe("stale flag", () => {
  const P = 100 * MS;
  it("red (stale) only beyond k × nominal period, k = 3 by default", () => {
    expect(staleness(1.0 * P, P)).toBe("ok");
    expect(staleness(2.5 * P, P)).toBe("warn");
    expect(staleness(3.0 * P, P)).toBe("warn");
    expect(staleness(3.01 * P, P)).toBe("stale");
  });
  it("k is configurable", () => {
    expect(staleness(2.5 * P, P, 2)).toBe("stale");
    expect(staleness(4 * P, P, 5)).toBe("warn");
    expect(staleness(1.2 * P, P, 1)).toBe("stale");
  });
});

describe("renderers", () => {
  it("depth: 0 = no data, drawn opaque black; valid values through turbo", () => {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint16(0, 0, true);
    new DataView(data.buffer).setUint16(2, 2000, true);
    const img: RosImage = { width: 2, height: 1, encoding: "16UC1", is_bigendian: 0, step: 4, data };
    const out = imageToRgba(img, { range: { min: 0, max: 4000 } });
    expect(Array.from(out.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(out[4] + out[5] + out[6]).toBeGreaterThan(100);
  });
  it("class maps: few distinct 8-bit values → categorical colours", () => {
    const data = Uint8Array.from([0, 1, 2, 1, 0, 2]);
    const img: RosImage = { width: 3, height: 2, encoding: "mono8", is_bigendian: 0, step: 3, data };
    expect(classMapClasses(img)).toBe(3);
    const out = imageToRgba(img, { classMap: true });
    expect(Array.from(out.slice(4, 7))).toEqual(classColour(1));
    const photo: RosImage = { width: 64, height: 1, encoding: "mono8", is_bigendian: 0, step: 64, data: Uint8Array.from({ length: 64 }, (_, i) => i * 4) };
    expect(classMapClasses(photo)).toBe(0);
    expect(classMapClasses({ ...img, encoding: "rgb8" })).toBe(0);
  });
  it("bird's-eye view: a point at 1 m on the optical axis lands on the expected pixel", () => {
    const v = bevView(400, 300, 4, true);
    const scale = Math.min((300 - 2 * BEV_PAD) / 4, (400 - 2 * BEV_PAD) / 8);
    expect(v.scale).toBe(scale);
    expect(bevPixel(v, 0, 0, 1)).toEqual([200, 300 - BEV_PAD - scale]);
    expect(bevPixel(v, 1, 0, 0)).toEqual([200 + scale, 300 - BEV_PAD]); // x to the right
    expect(bevPixel(v, 0, 5, 1)).toEqual([200, 300 - BEV_PAD - scale]); // y (down) does not move the point
    // body frame (x forward, y left): 1 m forward goes up, 1 m left goes left
    const b = bevView(400, 300, 4, false);
    expect(bevPixel(b, 1, 0, 0)).toEqual([200, 300 - BEV_PAD - scale]);
    expect(bevPixel(b, 0, 1, 0)).toEqual([200 - scale, 300 - BEV_PAD]);
    expect(bevPixel(v, NaN, 0, 1).every(Number.isNaN)).toBe(true);
  });
  it("distance ring step from the range", () => {
    expect(ringStep(4)).toBe(1);
    expect(ringStep(10)).toBe(2);
    expect(ringStep(25)).toBe(5);
    expect(ringStep(2)).toBe(0.5);
  });
  it("PCL packed rgb (FLOAT32 or UINT32) is reinterpreted bit-exactly", () => {
    for (const datatype of [7, 6]) {
      const data = new Uint8Array(16);
      const dv = new DataView(data.buffer);
      dv.setFloat32(0, 1, true);
      dv.setUint32(4, 0x00ff8001, true); // r=255 g=128 b=1
      dv.setFloat32(8, 2, true);
      dv.setUint32(12, 0x00010203, true);
      const pc: RosPointCloud2 = { height: 1, width: 2, fields: [{ name: "x", offset: 0, datatype: 7, count: 1 }, { name: "rgb", offset: 4, datatype, count: 1 }], is_bigendian: false, point_step: 8, row_step: 16, data };
      expect(Array.from(cloudRgb(pc)!)).toEqual([255, 128, 1, 1, 2, 3]);
    }
  });
});
