/**
 * Bird's-eye view of a point cloud (parity with the Python replay script): the sensor
 * sits at the bottom centre, x to the right and the optical axis z pointing up the
 * image. Clouds in a body frame (frame_id without "optical": x forward, y left) are
 * drawn with x up and y to the left. Distance rings at a step chosen from the range.
 */
export interface BevView {
  width: number;
  height: number;
  /** forward range shown (m) */
  rangeM: number;
  /** px per metre */
  scale: number;
  /** sensor position in px */
  cx: number;
  cy: number;
  /** ring spacing (m) */
  ringStepM: number;
  optical: boolean;
}

export const BEV_PAD = 12;

/** Ring step giving at most 6 rings over the range (0.5, 1, 2, 5, 10, 20, 50 m…). */
export function ringStep(rangeM: number): number {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  for (const s of steps) if (rangeM / s <= 6) return s;
  return steps[steps.length - 1];
}

/** A frame is optical (x right, y down, z forward) when its name says so (REP-103 suffix). */
export const isOpticalFrame = (frameId: string | undefined) => /optical/i.test(frameId ?? "");

export function bevView(width: number, height: number, rangeM: number, optical: boolean): BevView {
  const r = rangeM > 0 ? rangeM : 1;
  // the view shows ±range sideways and range forward
  const scale = Math.max(1e-6, Math.min((height - 2 * BEV_PAD) / r, (width - 2 * BEV_PAD) / (2 * r)));
  return { width, height, rangeM: r, scale, cx: width / 2, cy: height - BEV_PAD, ringStepM: ringStep(r), optical };
}

/** Pixel of a 3D point (NaN when the point is invalid). */
export function bevPixel(v: BevView, x: number, y: number, z: number): [number, number] {
  const lateral = v.optical ? x : -y;
  const forward = v.optical ? z : x;
  if (!Number.isFinite(lateral) || !Number.isFinite(forward)) return [NaN, NaN];
  return [v.cx + lateral * v.scale, v.cy - forward * v.scale];
}
