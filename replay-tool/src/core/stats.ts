/**
 * Descriptive statistics used throughout the analysis: rates, jitter, gaps,
 * percentiles and histograms. Pure functions, deterministic, no sampling.
 */
import { NS_PER_S } from "./time";
import type { NumArray } from "./sync";

export interface Summary {
  n: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

/** Linear-interpolated percentile (q in [0,100]) of an already **sorted** array. */
export function percentileSorted(sorted: NumArray, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (q / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Full summary of the finite values in `values`. */
export function summarize(values: NumArray): Summary {
  const finite: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) finite.push(values[i]);
  const n = finite.length;
  if (n === 0) return { n: 0, min: NaN, max: NaN, mean: NaN, std: NaN, p50: NaN, p90: NaN, p95: NaN, p99: NaN };
  finite.sort((a, b) => a - b);
  let sum = 0;
  for (const v of finite) sum += v;
  const mean = sum / n;
  let sq = 0;
  for (const v of finite) sq += (v - mean) * (v - mean);
  return {
    n,
    min: finite[0],
    max: finite[n - 1],
    mean,
    std: Math.sqrt(sq / n),
    p50: percentileSorted(finite, 50),
    p90: percentileSorted(finite, 90),
    p95: percentileSorted(finite, 95),
    p99: percentileSorted(finite, 99),
  };
}

/** Inter-arrival intervals (ns) of a sorted time array: out[i] = t[i+1] - t[i]. */
export function intervals(times: NumArray): Float64Array {
  const out = new Float64Array(Math.max(0, times.length - 1));
  for (let i = 1; i < times.length; i++) out[i - 1] = times[i] - times[i - 1];
  return out;
}

export interface RateStats {
  count: number;
  durationNs: number;
  /** count-1 / duration: the average rate over the whole span. */
  meanHz: number;
  /** 1 / median interval: robust nominal rate. */
  medianHz: number;
  /** Lowest / highest instantaneous rate (1 / max interval, 1 / min interval). */
  minHz: number;
  maxHz: number;
  /** Standard deviation of the intervals (ns). */
  jitterNs: number;
  medianPeriodNs: number;
  maxGapNs: number;
  maxGapAtNs: number;
}

export function rateStats(times: NumArray): RateStats {
  const n = times.length;
  const iv = intervals(times);
  const s = summarize(iv);
  const durationNs = n > 1 ? times[n - 1] - times[0] : 0;
  let maxGap = 0;
  let maxGapAt = n > 0 ? times[0] : 0;
  for (let i = 0; i < iv.length; i++) {
    if (iv[i] > maxGap) {
      maxGap = iv[i];
      maxGapAt = times[i];
    }
  }
  return {
    count: n,
    durationNs,
    meanHz: durationNs > 0 ? ((n - 1) * NS_PER_S) / durationNs : NaN,
    medianHz: s.p50 > 0 ? NS_PER_S / s.p50 : NaN,
    minHz: s.max > 0 ? NS_PER_S / s.max : NaN,
    maxHz: s.min > 0 ? NS_PER_S / s.min : NaN,
    jitterNs: s.std,
    medianPeriodNs: s.p50,
    maxGapNs: maxGap,
    maxGapAtNs: maxGapAt,
  };
}

export interface Gap {
  /** time of the message before the gap (relative ns) */
  startNs: number;
  /** time of the message after the gap */
  endNs: number;
  durationNs: number;
  /** index of the message before the gap */
  index: number;
}

/** Gaps = intervals larger than `k` × the median period (default k = 2). */
export function detectGaps(times: NumArray, k = 2, medianPeriodNs?: number): Gap[] {
  const period = medianPeriodNs ?? summarize(intervals(times)).p50;
  if (!Number.isFinite(period) || period <= 0) return [];
  const out: Gap[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > k * period) out.push({ startNs: times[i - 1], endNs: times[i], durationNs: d, index: i - 1 });
  }
  return out;
}

/**
 * Instantaneous rate per message: 1/interval, assigned to the later message.
 * Returns {t, hz} with length n-1.
 */
export function instantRate(times: NumArray): { t: Float64Array; hz: Float64Array } {
  const n = Math.max(0, times.length - 1);
  const t = new Float64Array(n);
  const hz = new Float64Array(n);
  for (let i = 1; i < times.length; i++) {
    t[i - 1] = times[i];
    const d = times[i] - times[i - 1];
    hz[i - 1] = d > 0 ? NS_PER_S / d : NaN;
  }
  return { t, hz };
}

/**
 * Sliding-window rate: number of messages in (t - window, t] divided by the window,
 * evaluated at every message. Used by the rate_min requirement.
 */
export function windowRate(times: NumArray, windowNs = NS_PER_S): { t: Float64Array; hz: Float64Array } {
  const n = times.length;
  const t = new Float64Array(n);
  const hz = new Float64Array(n);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (times[lo] <= times[i] - windowNs) lo++;
    t[i] = times[i];
    hz[i] = ((i - lo + 1) * NS_PER_S) / windowNs;
  }
  return { t, hz };
}

export interface Histogram {
  edges: number[];
  counts: number[];
}

/** Fixed-bin histogram over finite values. */
export function histogram(values: NumArray, bins = 40, min?: number, max?: number): Histogram {
  let lo = min ?? Infinity;
  let hi = max ?? -Infinity;
  if (min === undefined || max === undefined) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (min === undefined && v < lo) lo = v;
      if (max === undefined && v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { edges: [], counts: [] };
  if (hi === lo) hi = lo + 1;
  const w = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let b = Math.floor((v - lo) / w);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + i * w);
  return { edges, counts };
}

/** Merges sorted [start,end] intervals that overlap or touch within `joinNs`. */
export function mergeIntervals(iv: Array<[number, number]>, joinNs = 0): Array<[number, number]> {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + joinNs) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
