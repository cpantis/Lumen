/**
 * Per-message content metrics — "do not stop at checking when data arrives".
 *
 * For every message we compute a small, fixed record (`ContentSample`) that the
 * analysis stores in typed arrays. The metrics depend on the message type but are
 * always expressed in the same normalised fields so they can be plotted, aggregated
 * and checked against thresholds uniformly.
 */
import { shortType } from "./decode";
import { encodingInfo, isDepthLike, pixelValue, type RosImage } from "./image";
import { parsePointCloud, type RosPointCloud2 } from "./pointcloud";

export interface ContentSample {
  /** message carries no payload (0 points, 0 pixels, empty data) */
  empty: boolean;
  /** structurally invalid (data length ≠ step·height, NaN in IMU, …) */
  invalid: boolean;
  /** number of "elements" (pixels, points, ranges, cells, numeric leaves) */
  elements: number;
  /** fraction of NaN/Inf elements in [0,1] */
  nanRatio: number;
  /** fraction of zero / no-return elements in [0,1] (depth=0, range=0) */
  zeroRatio: number;
  /** fraction of finite elements outside the plausible range */
  outOfRangeRatio: number;
  /** min / max / mean of valid values (metres for depth & clouds, m/s² for IMU acc) */
  min: number;
  max: number;
  mean: number;
  /** 32-bit content hash, used to detect identical repeated frames */
  hash: number;
}

export interface PlausibleRanges {
  /** metres */
  depthMin: number;
  depthMax: number;
  /** m/s² (norm of linear acceleration) */
  accMax: number;
  /** rad/s */
  gyroMax: number;
}

export const DEFAULT_RANGES: PlausibleRanges = { depthMin: 0.1, depthMax: 40, accMax: 50, gyroMax: 20 };

const EMPTY: ContentSample = {
  empty: false,
  invalid: false,
  elements: 0,
  nanRatio: 0,
  zeroRatio: 0,
  outOfRangeRatio: 0,
  min: NaN,
  max: NaN,
  mean: NaN,
  hash: 0,
};

/** FNV-1a over up to ~4096 evenly spaced bytes + the length (fast, deterministic). */
export function sampleHash(data: Uint8Array): number {
  let h = 0x811c9dc5 ^ data.length;
  const step = Math.max(1, Math.floor(data.length / 4096));
  for (let i = 0; i < data.length; i += step) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class Acc {
  n = 0;
  valid = 0;
  nan = 0;
  zero = 0;
  oor = 0;
  min = Infinity;
  max = -Infinity;
  sum = 0;
  push(v: number, lo: number, hi: number, zeroIsNoData = true) {
    this.n++;
    if (!Number.isFinite(v)) {
      this.nan++;
      return;
    }
    if (zeroIsNoData && v === 0) {
      this.zero++;
      return;
    }
    this.valid++;
    if (v < lo || v > hi) this.oor++;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    this.sum += v;
  }
  result(base: Partial<ContentSample>): ContentSample {
    const n = this.n || 1;
    return {
      ...EMPTY,
      ...base,
      elements: this.n,
      nanRatio: this.nan / n,
      zeroRatio: this.zero / n,
      outOfRangeRatio: this.valid ? this.oor / this.valid : 0,
      min: this.valid ? this.min : NaN,
      max: this.valid ? this.max : NaN,
      mean: this.valid ? this.sum / this.valid : NaN,
    };
  }
}

function imageMetrics(img: RosImage, r: PlausibleRanges): ContentSample {
  const info = encodingInfo(img.encoding);
  const pixels = img.width * img.height;
  const hash = sampleHash(img.data);
  if (pixels === 0 || img.data.length === 0) return { ...EMPTY, empty: true, hash };
  if (!info || img.data.length < img.step * img.height) return { ...EMPTY, invalid: true, elements: pixels, hash };
  const acc = new Acc();
  const stepPx = Math.max(1, Math.floor(pixels / 50000)); // deterministic sub-grid for speed
  if (isDepthLike(img.encoding)) {
    const scale = img.encoding.toLowerCase() === "32fc1" ? 1 : 0.001; // 16UC1 = mm (REP-118)
    for (let i = 0; i < pixels; i += stepPx) {
      const v = pixelValue(img, i % img.width, Math.floor(i / img.width));
      acc.push(v * scale, r.depthMin, r.depthMax);
    }
  } else {
    // intensity statistics on channel 0; "zero" = fully black pixel, oor = saturated (255)
    for (let i = 0; i < pixels; i += stepPx) {
      const v = pixelValue(img, i % img.width, Math.floor(i / img.width));
      acc.push(v, 0, 254, true);
    }
  }
  const res = acc.result({ hash });
  return { ...res, elements: pixels };
}

function cloudMetrics(pc: RosPointCloud2, r: PlausibleRanges): ContentSample {
  const hash = sampleHash(pc.data);
  const count = pc.width * pc.height;
  if (count === 0 || pc.data.length === 0) return { ...EMPTY, empty: true, hash };
  const invalid = pc.data.length < pc.point_step * count;
  const parsed = parsePointCloud(pc);
  const acc = new Acc();
  const p = parsed.positions;
  for (let i = 0; i < parsed.count; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const d = Math.sqrt(x * x + y * y + z * z);
    acc.push(d, r.depthMin, r.depthMax);
  }
  return acc.result({ hash, invalid });
}

function imuMetrics(m: Record<string, any>, r: PlausibleRanges): ContentSample {
  const a = m.linear_acceleration ?? {};
  const g = m.angular_velocity ?? {};
  const vals = [a.x, a.y, a.z, g.x, g.y, g.z];
  const nan = vals.filter((v) => !Number.isFinite(v)).length;
  const an = Math.hypot(a.x, a.y, a.z);
  const gn = Math.hypot(g.x, g.y, g.z);
  const oor = (an > r.accMax ? 1 : 0) + (gn > r.gyroMax ? 1 : 0);
  return {
    ...EMPTY,
    invalid: nan > 0,
    elements: 6,
    nanRatio: nan / 6,
    outOfRangeRatio: oor / 2,
    min: an,
    max: an,
    mean: an,
    hash: (Math.round(an * 1e4) ^ Math.round(gn * 1e4)) >>> 0,
  };
}

function scanMetrics(m: Record<string, any>, r: PlausibleRanges): ContentSample {
  const ranges: ArrayLike<number> = m.ranges ?? [];
  if (ranges.length === 0) return { ...EMPTY, empty: true };
  const acc = new Acc();
  for (let i = 0; i < ranges.length; i++) acc.push(ranges[i], Math.max(r.depthMin, m.range_min ?? 0), Math.min(r.depthMax, m.range_max ?? Infinity));
  return acc.result({ hash: sampleHash(new Uint8Array(Float32Array.from(ranges).buffer)) });
}

function gridMetrics(m: Record<string, any>): ContentSample {
  const data: ArrayLike<number> = m.data ?? [];
  if (data.length === 0) return { ...EMPTY, empty: true };
  let unknown = 0, occ = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < 0) unknown++;
    else if (data[i] >= 50) occ++;
  }
  const invalid = (m.info?.width ?? 0) * (m.info?.height ?? 0) !== data.length;
  return {
    ...EMPTY,
    invalid,
    elements: data.length,
    zeroRatio: unknown / data.length,
    mean: occ / data.length,
    min: 0,
    max: 100,
    hash: sampleHash(new Uint8Array(Int8Array.from(data).buffer)),
  };
}

/** Generic fallback: walks numeric leaves (bounded) and counts NaN/Inf. */
function genericMetrics(m: unknown): ContentSample {
  const acc = new Acc();
  let budget = 20000;
  let h = 0x811c9dc5;
  const walk = (v: unknown) => {
    if (budget <= 0) return;
    if (typeof v === "number") {
      budget--;
      acc.push(v, -Infinity, Infinity, false);
      h = Math.imul(h ^ (Number.isFinite(v) ? Math.round(v * 1000) : 0), 0x01000193);
    } else if (ArrayBuffer.isView(v)) {
      const arr = v as unknown as ArrayLike<number>;
      for (let i = 0; i < arr.length && budget > 0; i++, budget--) acc.push(Number(arr[i]), -Infinity, Infinity, false);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(m);
  return acc.result({ hash: h >>> 0 });
}

/** Computes the content sample for a decoded message of the given schema type. */
export function contentMetrics(schemaName: string, msg: unknown, ranges: PlausibleRanges = DEFAULT_RANGES): ContentSample {
  const t = shortType(schemaName);
  const m = msg as Record<string, any>;
  try {
    switch (t) {
      case "sensor_msgs/Image":
        return imageMetrics(m as RosImage, ranges);
      case "sensor_msgs/CompressedImage": {
        const data: Uint8Array = m.data ?? new Uint8Array();
        return { ...EMPTY, empty: data.length === 0, elements: data.length, hash: sampleHash(data) };
      }
      case "sensor_msgs/PointCloud2":
        return cloudMetrics(m as RosPointCloud2, ranges);
      case "sensor_msgs/Imu":
        return imuMetrics(m, ranges);
      case "sensor_msgs/LaserScan":
        return scanMetrics(m, ranges);
      case "nav_msgs/OccupancyGrid":
        return gridMetrics(m);
      case "sensor_msgs/CameraInfo":
        return { ...EMPTY, empty: !m.width || !m.height, invalid: !Array.isArray(m.k) && !ArrayBuffer.isView(m.k), elements: 1 };
      default:
        return genericMetrics(m);
    }
  } catch {
    return { ...EMPTY, invalid: true };
  }
}
