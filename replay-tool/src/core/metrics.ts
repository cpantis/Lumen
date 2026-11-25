/**
 * Machine-readable metrics (metrics.json) and cross-validation.
 *
 * The CLI writes this file; external test scripts (2.4) are expected to write the
 * same shape. The app compares its own metrics with an imported file within a
 * tolerance, so "the app and the tests measure the same thing" is itself verified.
 */
import { NS_PER_MS } from "./time";
import { computeParity } from "./parity";
import type { Analysis } from "./types";

export interface MetricsFile {
  tool: string;
  file: string;
  sha256: string;
  duration_s: number;
  topics: Record<
    string,
    {
      type: string;
      count: number;
      mean_hz: number;
      median_hz: number;
      jitter_ms: number;
      max_gap_ms: number;
      gaps: number;
      empty_ratio: number;
      invalid_ratio: number;
      nan_ratio_mean: number;
      duplicate_ratio: number;
    }
  >;
  edges: Record<
    string,
    { kind: string; match_rate: number; latency_p50_ms: number; latency_p95_ms: number; latency_max_ms: number; drop_ratio: number }
  >;
  /** Python-suite definitions (src/core/parity.ts), per output, with the inferred trigger */
  outputs?: Record<
    string,
    { trigger: string | null; e2e_p50_ms: number; e2e_p95_ms: number; e2e_max_ms: number; proc_p50_ms: number; proc_p95_ms: number; rate_hz: number; max_interval_ms: number; longest_stall_s: number | null }
  >;
  longest_stall_s?: number | null;
}

const r6 = (v: number) => (Number.isFinite(v) ? +v.toFixed(6) : null) as number;

export function buildMetrics(a: Analysis, tool: string, triggerOverrides: Record<string, string> = {}): MetricsFile {
  const topics: MetricsFile["topics"] = {};
  for (const t of a.topics) {
    let empty = 0, invalid = 0, nan = 0, dup = 0;
    for (let i = 0; i < t.count; i++) {
      empty += t.content.empty[i];
      invalid += t.content.invalid[i] | t.content.decodeError[i];
      nan += t.content.nanRatio[i];
      if (i > 0 && t.content.hash[i] === t.content.hash[i - 1] && !t.content.empty[i]) dup++;
    }
    const n = Math.max(1, t.count);
    topics[t.topic] = {
      type: t.type,
      count: t.count,
      mean_hz: r6(t.rate.meanHz),
      median_hz: r6(t.rate.medianHz),
      jitter_ms: r6(t.rate.jitterNs / NS_PER_MS),
      max_gap_ms: r6(t.rate.maxGapNs / NS_PER_MS),
      gaps: t.gaps.length,
      empty_ratio: r6(empty / n),
      invalid_ratio: r6(invalid / n),
      nan_ratio_mean: r6(nan / n),
      duplicate_ratio: r6(dup / n),
    };
  }
  const edges: MetricsFile["edges"] = {};
  for (const e of a.edges) {
    edges[`${e.input} -> ${e.output}`] = {
      kind: e.kind,
      match_rate: r6(e.matchRate),
      latency_p50_ms: r6(e.latencySummary.p50 / NS_PER_MS),
      latency_p95_ms: r6(e.latencySummary.p95 / NS_PER_MS),
      latency_max_ms: r6(e.latencySummary.max / NS_PER_MS),
      drop_ratio: r6(e.dropRatio),
    };
  }
  const par = computeParity(a.topics, (t) => t.autoRole === "output", (t) => t.autoRole === "input", a.durationNs, triggerOverrides);
  const outputs: NonNullable<MetricsFile["outputs"]> = {};
  for (const o of par.outputs) {
    outputs[o.output] = {
      trigger: o.trigger ?? null,
      e2e_p50_ms: r6(o.e2e.p50 / NS_PER_MS),
      e2e_p95_ms: r6(o.e2e.p95 / NS_PER_MS),
      e2e_max_ms: r6(o.e2e.max / NS_PER_MS),
      proc_p50_ms: r6(o.processing.p50 / NS_PER_MS),
      proc_p95_ms: r6(o.processing.p95 / NS_PER_MS),
      rate_hz: r6(o.intervals.meanHz),
      max_interval_ms: r6(o.intervals.maxNs / NS_PER_MS),
      longest_stall_s: o.stall?.missedFrames ? r6(o.stall.durationNs / 1e9) : null,
    };
  }
  return { tool, file: a.fileName, sha256: a.sha256, duration_s: r6(a.durationNs / 1e9), topics, edges, outputs, longest_stall_s: par.longestStall ? r6(par.longestStall.durationNs / 1e9) : null };
}

export interface CrossCheckRow {
  key: string;
  metric: string;
  app: number | null;
  other: number | null;
  diff: number;
  ok: boolean;
}

/** Compares every numeric metric present in both files; relative tolerance (default 1 %). */
export function crossCheck(mine: MetricsFile, other: MetricsFile, relTol = 0.01, absTol = 1e-3): CrossCheckRow[] {
  const rows: CrossCheckRow[] = [];
  const cmp = (key: string, a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) => {
    const metrics = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const m of metrics) {
      const va = a?.[m], vb = b?.[m];
      if (typeof va === "string" || typeof vb === "string") continue;
      const x = typeof va === "number" ? va : null;
      const y = typeof vb === "number" ? vb : null;
      const diff = x !== null && y !== null ? Math.abs(x - y) : NaN;
      const ok = (x === null && y === null) || (x !== null && y !== null && (diff <= absTol || diff <= relTol * Math.max(Math.abs(x), Math.abs(y))));
      rows.push({ key, metric: m, app: x, other: y, diff, ok });
    }
  };
  for (const k of new Set([...Object.keys(mine.topics), ...Object.keys(other.topics ?? {})])) cmp(k, mine.topics[k], other.topics?.[k]);
  for (const k of new Set([...Object.keys(mine.edges), ...Object.keys(other.edges ?? {})])) cmp(k, mine.edges[k], other.edges?.[k]);
  return rows;
}
