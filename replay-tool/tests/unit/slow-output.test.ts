/**
 * A slow component (semantic segmentation at ~4.7 Hz on a 30 Hz camera, i.e. using < 20 %
 * of the frames) is still an output of its camera — not an input because it is an Image.
 */
import { describe, expect, it } from "vitest";
import { inferCausality } from "../../src/core/causality";
import { computeParity } from "../../src/core/parity";
import { topic } from "./helpers";

const MS = 1e6;
function scene() {
  const rgbS: number[] = [], depthS: number[] = [];
  for (let k = 0; k < 600; k++) {
    rgbS.push(k * 33.333 * MS);
    if (k % 2 === 0) depthS.push(k * 33.333 * MS); // depth at 15 Hz, stamps shared with rgb
  }
  const segS = rgbS.filter((_, k) => k % 7 === 0); // ≈ 4.3 Hz → uses 14 % of the rgb frames
  const cloudS = depthS.filter((_, k) => k % 3 === 0); // ≈ 5 Hz on depth
  return [
    { ...topic("/farfield/CameraRGB", rgbS.map((s) => s + 6 * MS), rgbS), frameIds: ["farfield_rgb_optical_frame"] },
    { ...topic("/farfield/CameraDepth", depthS.map((s) => s + 7 * MS), depthS), frameIds: ["farfield_depth_optical_frame"] },
    { ...topic("/farfield/Semantic", segS.map((s, i) => s + (110 + (i % 5) * 20) * MS), segS), frameIds: ["farfield_rgb_optical_frame"] },
    { ...topic("/farfield/ColorizedPointCloud", cloudS.map((s) => s + 160 * MS), cloudS, "sensor_msgs/PointCloud2"), frameIds: ["farfield_depth_optical_frame"] },
  ];
}

describe("slow outputs (rate ratio < 1/5)", () => {
  it("are outputs of their camera, and the camera is not their trigger's competitor", () => {
    const ts = scene();
    inferCausality(ts);
    const T = (n: string) => ts.find((t) => t.topic === n)!;
    expect(T("/farfield/Semantic").autoRole, T("/farfield/Semantic").roleReason).toBe("output");
    expect(T("/farfield/CameraRGB").autoRole).toBe("input");
    expect(T("/farfield/CameraDepth").autoRole).toBe("input");
    const par = computeParity(ts, (t) => t.autoRole === "output", (t) => t.autoRole === "input", 20e9);
    expect(par.outputs.find((o) => o.output === "/farfield/Semantic")!.trigger).toBe("/farfield/CameraRGB");
    expect(par.outputs.find((o) => o.output === "/farfield/ColorizedPointCloud")!.trigger).toBe("/farfield/CameraDepth");
  });
});
