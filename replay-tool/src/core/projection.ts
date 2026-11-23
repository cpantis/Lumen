/**
 * Geometry for output-vs-input consistency (2.3): projecting a 3D output of a FOV
 * (point cloud) onto the image of the corresponding camera, a consistency metric,
 * and estimation of missing intrinsics/extrinsics with a confidence measure.
 *
 * Conventions: camera optical frame (z forward, x right, y down, REP-103 "_optical").
 * Extrinsics = pose of the camera optical frame expressed in the cloud frame, exactly
 * like a TF transform with parent = cloud frame and child = camera frame:
 *   p_cloud = R · p_cam + t   ⇒   p_cam = Rᵀ · (p_cloud − t)
 * R from roll/pitch/yaw (rad, R = Rz·Ry·Rx). Typical link→optical: roll −90°, yaw −90°.
 */

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface Extrinsics {
  tx: number;
  ty: number;
  tz: number;
  roll: number;
  pitch: number;
  yaw: number;
}

export interface Calibration {
  intrinsics: Intrinsics;
  extrinsics: Extrinsics;
  source: "camera_info+tf" | "camera_info" | "manual" | "estimated" | "assumed";
  note?: string;
}

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function rpyToMat(roll: number, pitch: number, yaw: number): Mat3 {
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  // R = Rz(yaw) · Ry(pitch) · Rx(roll)
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
    -sp, cp * sr, cp * cr,
  ];
}

export function quatToRpy(q: { x: number; y: number; z: number; w: number }): { roll: number; pitch: number; yaw: number } {
  const { x, y, z, w } = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const s = 2 * (w * y - z * x);
  const pitch = Math.abs(s) >= 1 ? Math.sign(s) * (Math.PI / 2) : Math.asin(s);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { roll, pitch, yaw };
}

export interface TfTransform {
  translation: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
}

/** Composes two transforms: (a ∘ b) = pose of b's child in a's parent. */
export function composeTf(a: TfTransform, b: TfTransform): TfTransform {
  const qa = a.rotation, qb = b.rotation;
  const rot = {
    w: qa.w * qb.w - qa.x * qb.x - qa.y * qb.y - qa.z * qb.z,
    x: qa.w * qb.x + qa.x * qb.w + qa.y * qb.z - qa.z * qb.y,
    y: qa.w * qb.y - qa.x * qb.z + qa.y * qb.w + qa.z * qb.x,
    z: qa.w * qb.z + qa.x * qb.y - qa.y * qb.x + qa.z * qb.w,
  };
  const r = quatToRpy(qa);
  const R = rpyToMat(r.roll, r.pitch, r.yaw);
  const t = b.translation;
  return {
    translation: {
      x: a.translation.x + R[0] * t.x + R[1] * t.y + R[2] * t.z,
      y: a.translation.y + R[3] * t.x + R[4] * t.y + R[5] * t.z,
      z: a.translation.z + R[6] * t.x + R[7] * t.y + R[8] * t.z,
    },
    rotation: rot,
  };
}

/** Inverse of a transform. */
export function invertTf(a: TfTransform): TfTransform {
  const q = { x: -a.rotation.x, y: -a.rotation.y, z: -a.rotation.z, w: a.rotation.w };
  const r = quatToRpy(q);
  const R = rpyToMat(r.roll, r.pitch, r.yaw);
  const t = a.translation;
  return { translation: { x: -(R[0] * t.x + R[1] * t.y + R[2] * t.z), y: -(R[3] * t.x + R[4] * t.y + R[5] * t.z), z: -(R[6] * t.x + R[7] * t.y + R[8] * t.z) }, rotation: q };
}

export interface TfEdge {
  parent: string;
  child: string;
  transform: TfTransform;
}

/**
 * Looks up the pose of `child` in `parent` through a TF tree (BFS over edges in both
 * directions). Returns undefined when the frames are not connected.
 */
export function lookupTf(edges: TfEdge[], parent: string, child: string): TfTransform | undefined {
  const identity: TfTransform = { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
  if (parent === child) return identity;
  const adj = new Map<string, Array<{ to: string; tf: TfTransform }>>();
  const add = (a: string, b: string, tf: TfTransform) => adj.set(a, [...(adj.get(a) ?? []), { to: b, tf }]);
  for (const e of edges) {
    add(e.parent, e.child, e.transform);
    add(e.child, e.parent, invertTf(e.transform));
  }
  const seen = new Map<string, TfTransform>([[parent, identity]]);
  const queue = [parent];
  while (queue.length) {
    const f = queue.shift()!;
    for (const { to, tf } of adj.get(f) ?? []) {
      if (seen.has(to)) continue;
      const c = composeTf(seen.get(f)!, tf);
      if (to === child) return c;
      seen.set(to, c);
      queue.push(to);
    }
  }
  return undefined;
}

export function extrinsicsFromTf(tf: TfTransform): Extrinsics {
  const r = quatToRpy(tf.rotation);
  return { tx: tf.translation.x, ty: tf.translation.y, tz: tf.translation.z, ...r };
}

/** Intrinsics from a sensor_msgs/CameraInfo message. */
export function intrinsicsFromCameraInfo(ci: { width: number; height: number; k: ArrayLike<number> }): Intrinsics {
  return { fx: ci.k[0], fy: ci.k[4], cx: ci.k[2], cy: ci.k[5], width: ci.width, height: ci.height };
}

/** Assumed intrinsics from resolution + horizontal FOV (when no CameraInfo exists). */
export function assumedIntrinsics(width: number, height: number, hfovDeg = 90): Intrinsics {
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height };
}

export const IDENTITY_EXTRINSICS: Extrinsics = { tx: 0, ty: 0, tz: 0, roll: 0, pitch: 0, yaw: 0 };

export interface Projected {
  /** pixel coordinates (NaN when behind the camera or invalid) */
  u: Float32Array;
  v: Float32Array;
  depth: Float32Array;
  inImage: number;
  inFront: number;
  valid: number;
}

/** Projects interleaved xyz points. Optional `stride` for speed (deterministic). */
export function projectPoints(positions: Float32Array, cal: Calibration, stride = 1): Projected {
  const n = Math.floor(positions.length / 3 / stride);
  const R = rpyToMat(cal.extrinsics.roll, cal.extrinsics.pitch, cal.extrinsics.yaw);
  const { tx, ty, tz } = cal.extrinsics;
  const { fx, fy, cx, cy, width, height } = cal.intrinsics;
  const u = new Float32Array(n), v = new Float32Array(n), depth = new Float32Array(n);
  let inImage = 0, inFront = 0, valid = 0;
  for (let k = 0; k < n; k++) {
    const i = k * stride;
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      u[k] = v[k] = depth[k] = NaN;
      continue;
    }
    valid++;
    const dx = x - tx, dy = y - ty, dz = z - tz;
    const X = R[0] * dx + R[3] * dy + R[6] * dz;
    const Y = R[1] * dx + R[4] * dy + R[7] * dz;
    const Z = R[2] * dx + R[5] * dy + R[8] * dz;
    if (Z <= 1e-3) {
      u[k] = v[k] = depth[k] = NaN;
      continue;
    }
    inFront++;
    u[k] = (fx * X) / Z + cx;
    v[k] = (fy * Y) / Z + cy;
    depth[k] = Z;
    if (u[k] >= 0 && u[k] < width && v[k] >= 0 && v[k] < height) inImage++;
  }
  return { u, v, depth, inImage, inFront, valid };
}

/**
 * Consistency metric between a projected cloud and a reference depth image of the
 * same FOV and moment: median |Z_cloud − Z_image| / Z_image over pixels where both
 * are valid, plus the fraction of points falling inside the image.
 * Without a reference depth image only `inImageRatio` is meaningful.
 */
export interface ConsistencyResult {
  inImageRatio: number;
  compared: number;
  medianRelError: number;
  p90RelError: number;
  /** cost minimised by the estimator (lower is better) */
  cost: number;
}

export function consistency(
  positions: Float32Array,
  cal: Calibration,
  depthAt?: (u: number, v: number) => number,
  stride = 1,
): ConsistencyResult {
  const p = projectPoints(positions, cal, stride);
  const errs: number[] = [];
  if (depthAt) {
    for (let k = 0; k < p.u.length; k++) {
      if (!Number.isFinite(p.u[k])) continue;
      const uu = Math.round(p.u[k]), vv = Math.round(p.v[k]);
      if (uu < 0 || vv < 0 || uu >= cal.intrinsics.width || vv >= cal.intrinsics.height) continue;
      const d = depthAt(uu, vv);
      if (!(d > 0) || !Number.isFinite(d)) continue;
      errs.push(Math.abs(p.depth[k] - d) / d);
    }
  }
  errs.sort((a, b) => a - b);
  const inImageRatio = p.valid ? p.inImage / p.valid : 0;
  const med = errs.length ? errs[Math.floor(errs.length / 2)] : NaN;
  const p90 = errs.length ? errs[Math.floor(errs.length * 0.9)] : NaN;
  // cost: depth error when a reference exists, otherwise push points into the image
  const cost = errs.length > 20 ? med + 0.5 * (1 - inImageRatio) : 1 - inImageRatio + 1;
  return { inImageRatio, compared: errs.length, medianRelError: med, p90RelError: p90, cost };
}

/** Nelder–Mead simplex minimiser (deterministic). */
export function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], maxIter = 200, tol = 1e-6): { x: number[]; fx: number; iterations: number } {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += step[i];
    simplex.push(x);
  }
  let values = simplex.map(f);
  let it = 0;
  for (; it < maxIter; it++) {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);
    if (Math.abs(values[n] - values[0]) < tol) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const at = (c: number) => centroid.map((v, j) => v + c * (worst[j] - v));
    const xr = at(-1);
    const fr = f(xr);
    if (fr < values[0]) {
      const xe = at(-2);
      const fe = f(xe);
      if (fe < fr) [simplex[n], values[n]] = [xe, fe];
      else [simplex[n], values[n]] = [xr, fr];
    } else if (fr < values[n - 1]) {
      [simplex[n], values[n]] = [xr, fr];
    } else {
      const xc = at(0.5);
      const fc = f(xc);
      if (fc < values[n]) [simplex[n], values[n]] = [xc, fc];
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return { x: simplex[best], fx: values[best], iterations: it };
}

export type ParamKey = keyof Intrinsics | keyof Extrinsics;

function getParam(cal: Calibration, k: ParamKey): number {
  return k in cal.intrinsics ? (cal.intrinsics as never)[k] : (cal.extrinsics as never)[k];
}
function withParam(cal: Calibration, k: ParamKey, v: number): Calibration {
  const c: Calibration = { ...cal, intrinsics: { ...cal.intrinsics }, extrinsics: { ...cal.extrinsics } };
  if (k in c.intrinsics) (c.intrinsics as unknown as Record<string, number>)[k] = v;
  else (c.extrinsics as unknown as Record<string, number>)[k] = v;
  return c;
}

/** Estimates the selected unknown parameters by minimising the consistency cost. */
export function estimateCalibration(
  cost: (cal: Calibration) => number,
  start: Calibration,
  keys: ParamKey[],
  steps: Partial<Record<ParamKey, number>> = {},
): { calibration: Calibration; cost: number; iterations: number } {
  const def: Record<string, number> = { fx: 20, fy: 20, cx: 10, cy: 10, tx: 0.05, ty: 0.05, tz: 0.05, roll: 0.05, pitch: 0.05, yaw: 0.05 };
  const x0 = keys.map((k) => getParam(start, k));
  const apply = (x: number[]) => keys.reduce((c, k, i) => withParam(c, k, x[i]), start);
  const res = nelderMead((x) => cost(apply(x)), x0, keys.map((k) => steps[k] ?? def[k] ?? 0.1), 150);
  return { calibration: { ...apply(res.x), source: "estimated" }, cost: res.fx, iterations: res.iterations };
}

/**
 * Confidence of an estimate: for each parameter, the relative cost increase for a
 * ±δ perturbation. A flat cost (small increase) means the data does not constrain
 * the parameter → low confidence.
 */
export function sensitivity(cost: (cal: Calibration) => number, cal: Calibration, keys: ParamKey[], deltas: Partial<Record<ParamKey, number>> = {}) {
  const def: Record<string, number> = { fx: 10, fy: 10, cx: 5, cy: 5, tx: 0.02, ty: 0.02, tz: 0.02, roll: 0.02, pitch: 0.02, yaw: 0.02 };
  const c0 = cost(cal);
  return keys.map((k) => {
    const d = deltas[k] ?? def[k] ?? 0.01;
    const v = getParam(cal, k);
    const up = cost(withParam(cal, k, v + d));
    const dn = cost(withParam(cal, k, v - d));
    const rise = (up + dn) / 2 - c0;
    const rel = c0 > 1e-9 ? rise / c0 : rise;
    const confidence = rel > 0.1 ? "ridicată" : rel > 0.01 ? "medie" : "scăzută";
    return { key: k, value: v, delta: d, costMinus: dn, cost0: c0, costPlus: up, relativeRise: rel, confidence };
  });
}
