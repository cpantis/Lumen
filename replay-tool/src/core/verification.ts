/**
 * verification.json: every quantity StampTrace computes and shows, in one file, so an
 * independent implementation (scripts/crosscheck.py, or the Python test suite) can be
 * compared with it value by value. Times: ms or s from the first log time.
 */
import { GAP_FACTOR } from "./stats";
import { intervalStats, type ParityReport } from "./parity";
import { STALE_K } from "./sync";
import type { Analysis, TopicData } from "./types";

const r = (v: number, d = 6) => (Number.isFinite(v) ? +v.toFixed(d) : null);
const stat = (s: { n: number; p50: number; p95: number; p99: number; max: number }) => ({ n: s.n, p50_ms: r(s.p50 / 1e6), p95_ms: r(s.p95 / 1e6), p99_ms: r(s.p99 / 1e6), max_ms: r(s.max / 1e6) });
const gaps = (g: TopicData["gaps"] | undefined) => (g ?? []).map((x) => ({ start_s: r(x.startNs / 1e9), end_s: r(x.endNs / 1e9), dur_ms: r(x.durationNs / 1e6, 3) }));

export interface VerificationFile {
  tool: string;
  file: string;
  sha256: string;
  duration_s: number | null;
  first_log_time_ns: string;
  rules: { gap: string; gap_factor: number; stale: string; stale_k: number; percentile: string; e2e: string; processing: string; rate: string; stall: string };
  topics: Record<string, unknown>;
  outputs: Record<string, unknown>;
  longest_stall: unknown;
}

export function buildVerification(a: Analysis, par: ParityReport, tool: string, nominalPeriodNs: (t: TopicData) => number, staleK = STALE_K): VerificationFile {
  const topics: Record<string, unknown> = {};
  for (const t of a.topics) {
    const lg = intervalStats(t.log);
    const st = t.hasHeader ? intervalStats(t.stamp) : undefined;
    topics[t.topic] = {
      type: t.type,
      count: t.count,
      has_header: t.hasHeader,
      unique_stamps: st?.n ?? null,
      rate_log_hz: r(t.count > 1 ? ((t.count - 1) * 1e9) / (t.log[t.count - 1] - t.log[0]) : NaN),
      rate_stamp_hz: st ? r(st.meanHz) : null,
      max_interval_log_ms: r(lg.maxNs / 1e6, 3),
      max_interval_stamp_ms: st ? r(st.maxNs / 1e6, 3) : null,
      median_interval_log_ms: r(lg.medianNs / 1e6, 3),
      median_interval_stamp_ms: st ? r(st.medianNs / 1e6, 3) : null,
      nominal_period_ms: r(nominalPeriodNs(t) / 1e6, 3),
      first_log_s: t.count ? r(t.log[0] / 1e9) : null,
      last_log_s: t.count ? r(t.log[t.count - 1] / 1e9) : null,
      gaps_log: gaps(t.gaps),
      gaps_stamp: t.hasHeader ? gaps(t.gapsStamp) : null,
    };
  }
  const outputs: Record<string, unknown> = {};
  for (const o of par.outputs) {
    const out = a.topics.find((t) => t.topic === o.output)!;
    const trig = o.trigger ? a.topics.find((t) => t.topic === o.trigger) : undefined;
    let matched = 0;
    if (trig) {
      const s = new Set(Array.from(trig.stamp));
      for (let j = 0; j < out.count; j++) if (s.has(out.stamp[j])) matched++;
    }
    outputs[o.output] = {
      trigger: o.trigger ?? null,
      trigger_source: o.triggerSource,
      trigger_confidence: o.inference.confidence,
      match_ratio: trig ? r(matched / Math.max(1, out.count)) : null,
      e2e: stat(o.e2e),
      processing: stat(o.processing),
      longest_stall_s: o.stall?.missedFrames ? r(o.stall.durationNs / 1e9) : null,
      stall_window_s: o.stall?.missedFrames ? [r(o.stall.startNs / 1e9), r(o.stall.endNs / 1e9)] : null,
      stall_missed_trigger_frames: o.stall?.missedFrames ?? 0,
    };
  }
  return {
    tool,
    file: a.fileName,
    sha256: a.sha256,
    duration_s: r(a.durationNs / 1e9),
    first_log_time_ns: a.startNs,
    rules: {
      gap: `interval between consecutive messages > ${GAP_FACTOR} x the topic's median interval on the same clock (log: log times; stamp: sorted unique header.stamps)`,
      gap_factor: GAP_FACTOR,
      stale: `age (replay time - message time on the selected clock) > ${staleK} x nominal period`,
      stale_k: staleK,
      percentile: "linear interpolation (numpy.percentile default)",
      e2e: "log_time(output) - header.stamp(output), every output message",
      processing: "log_time(output) - log_time(trigger message with the same header.stamp), output messages that have one",
      rate: "log: (n - 1) / (last - first log time); stamp: (n_unique - 1) / (last - first unique header.stamp)",
      stall: "longest interval on the trigger's frame grid with trigger frames present and no output, including recording start and end",
    },
    topics,
    outputs,
    longest_stall: par.longestStall ? { output: par.longestStall.output, duration_s: r(par.longestStall.durationNs / 1e9), window_s: [r(par.longestStall.startNs / 1e9), r(par.longestStall.endNs / 1e9)] } : null,
  };
}
