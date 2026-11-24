/**
 * Causality inference: which inputs produce which outputs, the latency between them,
 * dropped input frames, and same-moment grouping of the outputs of each FOV.
 *
 * Principle (evidence, not assumption): a component that processes a sensor frame
 * normally copies the frame's `header.stamp` into its outputs. If ≥ 50 % of the
 * stamps of topic O are found *exactly* among the stamps of topic I, and O is
 * published after I, we have proof that O is derived from I.
 */
import { summarize } from "./stats";
import { lastAtOrBefore } from "./sync";
import type { CausalEdge, FovGroup, Role, TopicData } from "./types";

const SENSOR_TYPES = new Set([
  "sensor_msgs/Image",
  "sensor_msgs/CompressedImage",
  "sensor_msgs/Imu",
  "sensor_msgs/CameraInfo",
  "sensor_msgs/MagneticField",
  "sensor_msgs/NavSatFix",
  "sensor_msgs/FluidPressure",
  "sensor_msgs/Temperature",
]);

const IMAGE_TYPES = new Set(["sensor_msgs/Image", "sensor_msgs/CompressedImage"]);

/** Minimum median delay for a topic to count as *processed* from another (ns). */
export const MIN_PROCESSING_NS = 2e6;

/** Number of leading namespace segments two topics share (tie-breaker for synced cameras). */
export function nsAffinity(a: string, b: string): number {
  const x = a.split("/").filter(Boolean), y = b.split("/").filter(Boolean);
  let k = 0;
  while (k < x.length && k < y.length && x[k] === y[k]) k++;
  return k;
}

/** Exact-stamp matching between two topics. */
export function matchTopics(input: TopicData, output: TopicData): CausalEdge | undefined {
  if (!input.hasHeader || !output.hasHeader || input.topic === output.topic) return undefined;
  const idxByStamp = new Map<number, number>();
  for (let i = 0; i < input.count; i++) if (!idxByStamp.has(input.stamp[i])) idxByStamp.set(input.stamp[i], i);
  const inputIndex = new Int32Array(output.count).fill(-1);
  let matched = 0;
  for (let j = 0; j < output.count; j++) {
    const i = idxByStamp.get(output.stamp[j]);
    if (i !== undefined) {
      inputIndex[j] = i;
      matched++;
    }
  }
  let kind: CausalEdge["kind"] = "exact";
  if (matched / Math.max(1, output.count) < 0.5) {
    // temporal fallback: nearest previous input stamp within 1.5 × its period
    const period = input.rate.medianPeriodNs;
    if (!(period > 0)) return undefined;
    matched = 0;
    inputIndex.fill(-1);
    for (let j = 0; j < output.count; j++) {
      const i = lastAtOrBefore(input.stamp, output.stamp[j]);
      if (i >= 0 && output.stamp[j] - input.stamp[i] <= 1.5 * period) {
        inputIndex[j] = i;
        matched++;
      }
    }
    kind = "temporal";
    if (matched / Math.max(1, output.count) < 0.9) return undefined;
  }
  const latency = new Float64Array(output.count).fill(NaN);
  const latencyFromLog = new Float64Array(output.count).fill(NaN);
  for (let j = 0; j < output.count; j++) {
    const i = inputIndex[j];
    if (i < 0) continue;
    latency[j] = output.log[j] - input.stamp[i];
    latencyFromLog[j] = output.log[j] - input.log[i];
  }
  const latencySummary = summarize(latency);
  // Outputs must be published after their input: a negative median delay between the
  // two log times (or a negative stamp latency) disproves causality.
  if (!(latencySummary.p50 >= 0) || !(summarize(latencyFromLog).p50 >= 0)) return undefined;
  const used = new Uint8Array(input.count);
  for (let j = 0; j < output.count; j++) if (inputIndex[j] >= 0) used[inputIndex[j]] = 1;
  // Only inputs inside the output's active span count as dropped (warm-up is not a drop).
  const first = output.count ? output.stamp[0] : Infinity;
  const last = output.count ? output.stamp[output.count - 1] : -Infinity;
  const dropped: number[] = [];
  let inSpan = 0;
  for (let i = 0; i < input.count; i++) {
    if (input.stamp[i] < first || input.stamp[i] > last) continue;
    inSpan++;
    if (!used[i]) dropped.push(i);
  }
  const dropRuns: Array<[number, number, number]> = [];
  for (let k = 0; k < dropped.length; ) {
    let e = k;
    while (e + 1 < dropped.length && dropped[e + 1] === dropped[e] + 1) e++;
    dropRuns.push([input.log[dropped[k]], input.log[dropped[e]], e - k + 1]);
    k = e + 1;
  }
  return {
    input: input.topic,
    output: output.topic,
    kind,
    matchRate: matched / Math.max(1, output.count),
    matched,
    outputs: output.count,
    inputIndex,
    latency,
    latencyFromLog,
    latencySummary,
    droppedInputs: Int32Array.from(dropped),
    dropRatio: kind === "exact" && inSpan ? dropped.length / inSpan : 0,
    dropRuns: kind === "exact" ? dropRuns : [],
  };
}

/**
 * Classifies every topic (input / output / unknown) with an explanation, computes
 * the causal edges and assigns each topic to a field of view.
 * Mutates `autoRole`, `roleReason` and `autoFov` of the topics.
 */
export function inferCausality(topics: TopicData[]): { edges: CausalEdge[]; fovGroups: FovGroup[] } {
  // 1) type-based prior
  const prior = new Map<string, { role: Role; reason: string }>();
  for (const t of topics) {
    if (SENSOR_TYPES.has(t.type)) prior.set(t.topic, { role: "input", reason: `tip de mesaj de senzor (${t.type})` });
    else if (t.type === "tf2_msgs/TFMessage") prior.set(t.topic, { role: "input", reason: "transformări de coordonate (infrastructură, nu ieșire a componentei)" });
    else prior.set(t.topic, { role: "output", reason: `tip derivat (${t.type}), nu e un tip brut de senzor` });
  }

  // 2) exact-stamp evidence between every pair
  const candidatesIn = topics.filter((t) => t.hasHeader && t.count > 0);
  const raw: CausalEdge[] = [];
  for (const o of candidatesIn) {
    for (const i of candidatesIn) {
      if (i === o) continue;
      const e = matchTopics(i, o);
      if (e && e.kind === "exact" && e.latencySummary.p50 > 0) raw.push(e);
    }
  }
  // A topic is an output when its stamps copy another topic's stamps and it is
  // published clearly later (> MIN_PROCESSING_NS, i.e. it was *processed*; a
  // CameraInfo published 0.2 ms after its image is a companion, not a product).
  // Pick, for each output, the earliest source in the chain.
  const processed = raw.filter((e) => summarize(e.latencyFromLog).p50 > MIN_PROCESSING_NS && topics.find((t) => t.topic === e.output)?.type !== "sensor_msgs/CameraInfo");
  const derived = new Set(processed.map((e) => e.output));
  for (const t of topics) {
    const srcs = processed.filter((e) => e.output === t.topic && !derived.has(e.input));
    if (srcs.length) {
      const isImg = (n: string) => (IMAGE_TYPES.has(topics.find((x) => x.topic === n)?.type ?? "") ? 1 : 0);
      // prefer: highest match rate, then image sources (the data the component processes), then namespace
      const best = srcs.sort((a, b) => b.matchRate - a.matchRate || isImg(b.input) - isImg(a.input) || nsAffinity(b.input, t.topic) - nsAffinity(a.input, t.topic))[0];
      prior.set(t.topic, {
        role: "output",
        reason: `${(best.matchRate * 100).toFixed(0)}% din header.stamp-uri copiază ${best.input}, publicat cu mediana ${(summarize(best.latencyFromLog).p50 / 1e6).toFixed(1)} ms după intrare`,
      });
    }
  }
  for (const t of topics) {
    const p = prior.get(t.topic)!;
    t.autoRole = p.role;
    t.roleReason = p.reason;
  }

  // 3) final edges: input → output, exact first; temporal edges for non-image inputs (IMU…)
  const inputs = topics.filter((t) => t.autoRole === "input");
  const outputs = topics.filter((t) => t.autoRole === "output");
  const edges: CausalEdge[] = [];
  for (const o of outputs) {
    for (const i of inputs) {
      // Only exact-stamp edges are proof. Temporal proximity (e.g. a 200 Hz IMU is always
      // "near" any output) proves nothing, so it is never added automatically.
      const e = raw.find((r) => r.input === i.topic && r.output === o.topic);
      if (e) edges.push(e);
    }
  }

  // 4) FOV = primary image input (highest exact match) of each output
  const fovOf = (topic: string) => topic.split("/").filter(Boolean)[0] ?? topic;
  const groups = new Map<string, { primary: string; outputs: string[] }>();
  for (const o of outputs) {
    const best = edges
      .filter((e) => e.output === o.topic && e.kind === "exact" && IMAGE_TYPES.has(topics.find((t) => t.topic === e.input)!.type))
      .sort((a, b) => b.matchRate - a.matchRate || nsAffinity(b.input, o.topic) - nsAffinity(a.input, o.topic))[0];
    if (!best) continue;
    const fov = fovOf(best.input);
    o.autoFov = fov;
    const g = groups.get(fov) ?? { primary: best.input, outputs: [] };
    g.outputs.push(o.topic);
    groups.set(fov, g);
  }
  for (const t of inputs) {
    const fov = [...groups.entries()].find(([, g]) => g.primary === t.topic)?.[0];
    if (fov) t.autoFov = fov;
    else {
      // inputs sharing a namespace with a FOV (camera_info of the same camera…)
      const ns = fovOf(t.topic);
      if (groups.has(ns)) t.autoFov = ns;
    }
  }

  const fovGroups: FovGroup[] = [];
  for (const [fov, g] of groups) fovGroups.push(buildFovGroup(fov, g.primary, g.outputs, topics));
  fovGroups.sort((a, b) => a.fov.localeCompare(b.fov));
  return { edges, fovGroups };
}

/** Same-moment presence & spread of the outputs of one FOV. */
export function buildFovGroup(fov: string, primaryInput: string, outputNames: string[], topics: TopicData[]): FovGroup {
  const outs = outputNames.map((n) => topics.find((t) => t.topic === n)!).filter(Boolean);
  const byStamp = new Map<number, { mask: number; min: number; max: number }>();
  outs.forEach((o, k) => {
    for (let j = 0; j < o.count; j++) {
      const s = o.stamp[j];
      const e = byStamp.get(s) ?? { mask: 0, min: Infinity, max: -Infinity };
      e.mask |= 1 << k;
      e.min = Math.min(e.min, o.log[j]);
      e.max = Math.max(e.max, o.log[j]);
      byStamp.set(s, e);
    }
  });
  const keys = [...byStamp.keys()].sort((a, b) => a - b);
  const presence = new Uint32Array(keys.length);
  const spreadNs = new Float64Array(keys.length);
  const full = (1 << outs.length) - 1;
  let complete = 0;
  keys.forEach((k, i) => {
    const e = byStamp.get(k)!;
    presence[i] = e.mask;
    spreadNs[i] = e.max - e.min;
    if (e.mask === full) complete++;
  });
  return {
    fov,
    primaryInput,
    outputs: outs.map((o) => o.topic),
    stamps: Float64Array.from(keys),
    presence,
    spreadNs,
    completeRatio: keys.length ? complete / keys.length : 0,
  };
}
