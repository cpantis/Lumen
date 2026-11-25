/**
 * Metric definitions shared with the Python test suite (lumen_sw_test).
 *
 * Every number here uses the same definition as the Python tool, so a value read in
 * StampTrace can be compared with the test report one-to-one:
 *  - times are relative to the first log time of the recording;
 *  - percentiles use linear interpolation (numpy's default, `percentileSorted`);
 *  - interval statistics use the sorted *unique* header.stamps of a topic;
 *    mean rate = (n − 1) / (last − first stamp);
 *  - end-to-end latency = log_time(output) − header.stamp(output)
 *    (the stamp is the one copied from the input frame);
 *  - processing latency = log_time(output) − log_time(trigger input with the same stamp);
 *  - longest stall = longest interval on the trigger input's frame grid where input
 *    frames are present and no output is produced, including the start and the end of
 *    the recording.
 *
 * Nothing here knows a topic name, a rate or a number of fields of view: everything is
 * derived from the arrays passed in.
 */
import { percentileSorted, summarize, type Summary } from "./stats";
import type { TopicData } from "./types";

/** Sorted unique finite values. */
export function sortedUnique(values: ArrayLike<number>): Float64Array {
  const a: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) a.push(values[i]);
  a.sort((x, y) => x - y);
  const out: number[] = [];
  for (const v of a) if (!out.length || out[out.length - 1] !== v) out.push(v);
  return Float64Array.from(out);
}

/** numpy.percentile(values, q) with the default linear interpolation; NaN when empty. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const a: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) a.push(values[i]);
  a.sort((x, y) => x - y);
  return percentileSorted(a, q);
}

export interface IntervalStats {
  /** number of unique stamps */
  n: number;
  firstNs: number;
  lastNs: number;
  /** (n − 1) / (last − first) */
  meanHz: number;
  medianNs: number;
  p95Ns: number;
  maxNs: number;
  /** stamp at the start of the largest interval */
  maxAtNs: number;
}

/** Interval statistics on the sorted unique header.stamps (or any time array). */
export function intervalStats(times: ArrayLike<number>): IntervalStats {
  const u = sortedUnique(times);
  const n = u.length;
  const iv: number[] = [];
  let maxNs = NaN, maxAtNs = NaN;
  for (let i = 1; i < n; i++) {
    const d = u[i] - u[i - 1];
    iv.push(d);
    if (!(d <= maxNs)) {
      maxNs = d;
      maxAtNs = u[i - 1];
    }
  }
  iv.sort((x, y) => x - y);
  const span = n > 1 ? u[n - 1] - u[0] : 0;
  return {
    n,
    firstNs: n ? u[0] : NaN,
    lastNs: n ? u[n - 1] : NaN,
    meanHz: span > 0 ? ((n - 1) * 1e9) / span : NaN,
    medianNs: percentileSorted(iv, 50),
    p95Ns: percentileSorted(iv, 95),
    maxNs,
    maxAtNs,
  };
}

/** The time array a topic is measured on: header.stamps when it has them, else log times. */
export const timesOf = (t: TopicData): Float64Array => (t.hasHeader ? t.stamp : t.log);

/** Nominal period = median interval of the sorted unique stamps (ns). */
export function nominalPeriod(times: ArrayLike<number>): number {
  return intervalStats(times).medianNs;
}

/**
 * Camera frame period without an assumed rate: the median of the intervals shorter than
 * 1.5 × their overall median. Dropped frames create intervals of 2×, 3×… the period,
 * which pull a plain median (and the mean) up; they are excluded by the 1.5× cut.
 */
export function framePeriod(times: ArrayLike<number>): number {
  const u = sortedUnique(times);
  const iv: number[] = [];
  for (let i = 1; i < u.length; i++) iv.push(u[i] - u[i - 1]);
  if (!iv.length) return NaN;
  iv.sort((x, y) => x - y);
  const med = percentileSorted(iv, 50);
  const short = iv.filter((d) => d < 1.5 * med);
  return percentileSorted(short.length ? short : iv, 50);
}

/** End-to-end latency per output message: log_time − header.stamp (ns). */
export function e2eLatency(out: TopicData): Float64Array {
  const r = new Float64Array(out.count);
  for (let j = 0; j < out.count; j++) r[j] = out.log[j] - out.stamp[j];
  return r;
}

/** First message index per stamp. */
function firstByStamp(t: TopicData): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < t.count; i++) if (Number.isFinite(t.stamp[i]) && !m.has(t.stamp[i])) m.set(t.stamp[i], i);
  return m;
}

/** Processing latency per output message: log(output) − log(trigger message with the same stamp); NaN when absent. */
export function processingLatency(out: TopicData, trigger: TopicData): Float64Array {
  const by = firstByStamp(trigger);
  const r = new Float64Array(out.count).fill(NaN);
  for (let j = 0; j < out.count; j++) {
    const i = by.get(out.stamp[j]);
    if (i !== undefined) r[j] = out.log[j] - trigger.log[i];
  }
  return r;
}

export interface TriggerCandidate {
  input: string;
  /** fraction of the output's messages whose stamp exists in this input */
  matchRatio: number;
  /** median log(output) − log(input) over matched stamps (ns) */
  medianDelayNs: number;
  /** median log(input) − stamp(input) over matched stamps: when the input is logged (ns) */
  medianLogOffsetNs: number;
  /** frame slots (stamps of any candidate inside the output's span) where this input is absent */
  absentSlots: number;
  /** of those, slots where the output was produced anyway */
  producedWithout: number;
  /** absence suppresses the output (drop propagation), or no absent slot to refute it */
  qualifies: boolean;
}

export interface TriggerInference {
  output: string;
  trigger?: string;
  candidates: TriggerCandidate[];
  reason: string;
}

/** An input is a stamp source of an output when ≥ 50 % of the output stamps exist in it and the output is logged after it. */
export const MIN_MATCH = 0.5;
/** Fraction of "output present while input absent" slots tolerated before the input stops counting as required. */
export const MAX_PRODUCED_WITHOUT = 0.1;

/**
 * Trigger of an output: among the inputs whose stamps it copies, the one whose absence in
 * a frame slot suppresses the output (drop propagation). When several qualify (the output
 * needs all of them), the one logged last triggers the computation.
 */
/**
 * Inputs that can never be a trigger: calibration / transform metadata and non-visual
 * sensors share a frame's stamps without being the data a component processes.
 */
export const NON_TRIGGER_TYPES = new Set(["sensor_msgs/CameraInfo", "tf2_msgs/TFMessage", "sensor_msgs/Imu", "sensor_msgs/MagneticField", "sensor_msgs/NavSatFix", "sensor_msgs/FluidPressure", "sensor_msgs/Temperature"]);

export function inferTrigger(out: TopicData, inputs: TopicData[]): TriggerInference {
  const cands: Array<TriggerCandidate & { stamps: Set<number> }> = [];
  const outStamps = new Set<number>();
  for (let j = 0; j < out.count; j++) if (Number.isFinite(out.stamp[j])) outStamps.add(out.stamp[j]);
  if (!out.hasHeader || !outStamps.size) return { output: out.topic, candidates: [], reason: "the output has no header.stamp" };
  for (const inp of inputs) {
    if (!inp.hasHeader || inp.topic === out.topic || !inp.count || NON_TRIGGER_TYPES.has(inp.type)) continue;
    const by = firstByStamp(inp);
    let matched = 0;
    const delay: number[] = [];
    const logOff: number[] = [];
    for (let j = 0; j < out.count; j++) {
      const i = by.get(out.stamp[j]);
      if (i === undefined) continue;
      matched++;
      delay.push(out.log[j] - inp.log[i]);
      logOff.push(inp.log[i] - inp.stamp[i]);
    }
    const matchRatio = matched / Math.max(1, out.count);
    const medianDelayNs = percentile(delay, 50);
    if (matchRatio < MIN_MATCH || !(medianDelayNs > 0)) continue;
    cands.push({ input: inp.topic, matchRatio, medianDelayNs, medianLogOffsetNs: percentile(logOff, 50), absentSlots: 0, producedWithout: 0, qualifies: true, stamps: new Set(by.keys()) });
  }
  if (!cands.length) return { output: out.topic, candidates: [], reason: `no input shares ≥ ${MIN_MATCH * 100}% of its header.stamps and is logged before it` };

  // frame slots = stamps of any candidate inside the output's active span
  let lo = Infinity, hi = -Infinity;
  for (const s of outStamps) {
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  const slots = new Set<number>();
  for (const c of cands) for (const s of c.stamps) if (s >= lo && s <= hi) slots.add(s);
  for (const s of outStamps) slots.add(s);
  for (const c of cands) {
    for (const s of slots) {
      if (c.stamps.has(s)) continue;
      c.absentSlots++;
      if (outStamps.has(s)) c.producedWithout++;
    }
    c.qualifies = c.absentSlots === 0 || c.producedWithout / c.absentSlots <= MAX_PRODUCED_WITHOUT;
  }
  const strip = cands.map(({ stamps: _s, ...rest }) => rest);
  const q = strip.filter((c) => c.qualifies);
  const pool = q.length ? q : strip;
  const pick = [...pool].sort((a, b) => b.medianLogOffsetNs - a.medianLogOffsetNs || b.matchRatio - a.matchRatio)[0];
  const ms = (v: number) => `${(v / 1e6).toFixed(1)} ms`;
  let reason: string;
  if (strip.length === 1) reason = `only stamp source (${(pick.matchRatio * 100).toFixed(0)}% of stamps copied, logged ${ms(pick.medianDelayNs)} before the output)`;
  else if (q.length === 1) reason = `the only input whose missing frames suppress the output (${strip.filter((c) => !c.qualifies).map((c) => `${c.input}: output produced in ${c.producedWithout}/${c.absentSlots} of its missing slots`).join("; ")})`;
  else if (q.length > 1) reason = `${q.length} inputs are required (missing frames suppress the output); ${pick.input} is logged last (median ${ms(pick.medianLogOffsetNs)} after its stamp)`;
  else reason = `no input's absence suppresses the output; picked the one logged last`;
  return { output: out.topic, trigger: pick.input, candidates: strip, reason };
}

export interface Stall {
  durationNs: number;
  startNs: number;
  endNs: number;
  /** trigger frames without output inside the stall */
  missedFrames: number;
}

/**
 * Longest stall of an output on its trigger's frame grid: consecutive trigger frames
 * (input present) that produced no output. Its duration runs from the previous frame
 * that produced an output (or the recording start) to the next one (or the recording end).
 */
export function longestStall(out: TopicData, trigger: TopicData, recordingStartNs: number, recordingEndNs: number): Stall {
  const grid = sortedUnique(trigger.stamp);
  const produced = new Set<number>();
  for (let j = 0; j < out.count; j++) produced.add(out.stamp[j]);
  let best: Stall = { durationNs: 0, startNs: NaN, endNs: NaN, missedFrames: 0 };
  let prev = recordingStartNs;
  let missed = 0;
  const close = (end: number) => {
    if (missed > 0 && end - prev > best.durationNs) best = { durationNs: end - prev, startNs: prev, endNs: end, missedFrames: missed };
  };
  for (const s of grid) {
    if (produced.has(s)) {
      close(s);
      prev = s;
      missed = 0;
    } else missed++;
  }
  close(recordingEndNs);
  return best;
}

export interface OutputParity {
  output: string;
  trigger?: string;
  /** "inferred" or "override" */
  triggerSource: "inferred" | "override" | "none";
  inference: TriggerInference;
  e2e: Summary;
  processing: Summary;
  intervals: IntervalStats;
  stall?: Stall;
}

export interface ParityReport {
  outputs: OutputParity[];
  /** longest stall over every output */
  longestStall?: Stall & { output: string };
}

/**
 * Every Python-suite metric for the outputs of a recording.
 * @param triggerOverrides output topic → trigger topic chosen by the user
 */
export function computeParity(
  topics: TopicData[],
  isOutput: (t: TopicData) => boolean,
  isInput: (t: TopicData) => boolean,
  durationNs: number,
  triggerOverrides: Record<string, string> = {},
): ParityReport {
  const inputs = topics.filter(isInput);
  const outputs: OutputParity[] = [];
  let longest: ParityReport["longestStall"];
  for (const o of topics.filter((t) => isOutput(t) && t.count > 0)) {
    const inference = inferTrigger(o, inputs);
    const ov = triggerOverrides[o.topic];
    const trigName = ov ?? inference.trigger;
    const trig = topics.find((t) => t.topic === trigName);
    const stall = trig ? longestStall(o, trig, 0, durationNs) : undefined;
    const p: OutputParity = {
      output: o.topic,
      trigger: trigName,
      triggerSource: ov ? "override" : inference.trigger ? "inferred" : "none",
      inference,
      e2e: o.hasHeader ? summarize(e2eLatency(o)) : summarize([]),
      processing: trig ? summarize(processingLatency(o, trig)) : summarize([]),
      intervals: intervalStats(timesOf(o)),
      stall,
    };
    outputs.push(p);
    if (stall && stall.missedFrames > 0 && (!longest || stall.durationNs > longest.durationNs)) longest = { ...stall, output: o.topic };
  }
  return { outputs, longestStall: longest };
}
