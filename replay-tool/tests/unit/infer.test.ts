import { describe, expect, it } from "vitest";
import { DEPTH_BIN_M, fovKey, framePrefix, histQuantile, inferTopic, namespaceOf, niceCeil } from "../../src/core/infer";
import { topic } from "./helpers";

describe("field-of-view keys", () => {
  it("namespace first", () => {
    expect(namespaceOf("/farfield/Semantic")).toBe("farfield");
    expect(namespaceOf("/rgb")).toBe("");
    expect(fovKey({ ...topic("/left_cam/image", [], []), frameIds: ["whatever"] })!.value).toBe("left_cam");
  });
  it("header.frame_id prefix for root topics", () => {
    expect(framePrefix("front_rgb_optical_frame")).toBe("front");
    expect(framePrefix("cam_down_optical")).toBe("cam_down");
    expect(framePrefix("camera_link")).toBe("");
    const t = { ...topic("/rgb", [], []), frameIds: ["rear_color_optical_frame"] };
    expect(fovKey(t)).toEqual({ value: "rear", evidence: expect.stringContaining("frame_id prefix") });
    expect(fovKey({ ...topic("/rgb", [], []), frameIds: ["camera_link"] })).toBeUndefined();
  });
});

describe("depth display range", () => {
  it("p99.9 of the valid pixels, rounded up", () => {
    const h = new Uint32Array(2000);
    h[Math.floor(3.4 / DEPTH_BIN_M)] = 9990; // 99.9 % at 3.4 m
    h[Math.floor(37 / DEPTH_BIN_M)] = 10; // 0.1 % outliers
    expect(histQuantile(h, 0.999, DEPTH_BIN_M)).toBeCloseTo(3.41, 6);
    expect(niceCeil(3.41)).toBe(4);
    expect(niceCeil(0.83)).toBe(0.9);
    expect(niceCeil(23.2)).toBe(25);
    expect(niceCeil(4)).toBe(4);
  });
  it("unit from the encoding and cloud colouring from the fields", () => {
    const d16 = { ...topic("/a/depth", [0, 1e8, 2e8], [0, 1e8, 2e8]), details: { encoding: "16UC1" } };
    const d32 = { ...topic("/a/depth", [0, 1e8, 2e8], [0, 1e8, 2e8]), details: { encoding: "32FC1" } };
    expect(inferTopic(d16).depthUnit!.value).toBe("mm");
    expect(inferTopic(d32).depthUnit!.value).toBe("m");
    const rgb = { ...topic("/a/cloud", [0, 1e8], [0, 1e8], "sensor_msgs/PointCloud2"), details: { fields: "x:f32, y:f32, z:f32, rgb:f32" } };
    const plain = { ...topic("/a/cloud", [0, 1e8], [0, 1e8], "sensor_msgs/PointCloud2"), details: { fields: "x:f32, y:f32, z:f32, intensity:f32" } };
    expect(inferTopic(rgb).cloudColour!.value).toBe("rgb");
    expect(inferTopic(plain).cloudColour!.value).toBe("distance");
  });
  it("nominal period = median stamp interval", () => {
    const t = topic("/a/x", [0, 1, 2, 3].map((k) => k * 1e8 + 5e6), [0, 1, 2, 5].map((k) => k * 1e8));
    expect(inferTopic(t).nominalPeriodNs.value).toBe(1e8);
  });
});
