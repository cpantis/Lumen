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
import { fovKey } from "./infer";
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

/** Raw sensor types that are acquired, never computed from another topic's frames. */
const ACQUIRED_TYPES = new Set(["sensor_msgs/Image", "sensor_msgs/CompressedImage", "sensor_msgs/Imu", "sensor_msgs/MagneticField", "sensor_msgs/NavSatFix"]);
/** High-rate non-visual sensors: stamp coincidence with them proves nothing (hardware sync). */
const NON_VISUAL = new Set(["sensor_msgs/Imu", "sensor_msgs/MagneticField", "sensor_msgs/NavSatFix", "sensor_msgs/FluidPressure", "sensor_msgs/Temperature", "tf2_msgs/TFMessage"]);
/** An output must consume at least this fraction of its source's frames (rate ratio ≥ 1/5). */
export const MAX_SOURCE_DROP = 0.8;

/**
 * Plausibility of "output is computed from input", beyond identical stamps:
 * hardware-synchronised sensors share stamps (a 100 Hz IMU and a 10 Hz camera stamped on
 * the same clock), so identical stamps alone are not proof. Rejected:
 *  - sources that are high-rate non-visual sensors (IMU, GNSS, TF…) for acquired types;
 *  - pairs where the output uses < 20 % of the source's frames (rate ratio < 1/5).
 */
export function plausibleSource(e: CausalEdge, inputType: string, outputType: string): boolean {
  if (e.dropRatio > MAX_SOURCE_DROP) return false;
  if (NON_VISUAL.has(inputType) && (ACQUIRED_TYPES.has(outputType) || IMAGE_TYPES.has(outputType))) return false;
  return true;
}

/**
 * Independence evidence: a topic computed from another can never exist in a frame slot
 * where its source is missing. When ≥ 2 messages (and ≥ 1 %) of O carry a stamp that the
 * candidate source I does not have, inside I's active span, O is not derived from I —
 * e.g. a hardware-synchronised depth camera logged a few ms after the rgb camera.
 */
export function producedWithoutSource(e: CausalEdge, topics: TopicData[]): boolean {
  const i = topics.find((t) => t.topic === e.input);
  const o = topics.find((t) => t.topic === e.output);
  if (!i || !o || !i.count) return false;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < i.count; k++) {
    if (i.stamp[k] < lo) lo = i.stamp[k];
    if (i.stamp[k] > hi) hi = i.stamp[k];
  }
  let n = 0;
  for (let j = 0; j < o.count; j++) if (e.inputIndex[j] < 0 && o.stamp[j] >= lo && o.stamp[j] <= hi) n++;
  return n >= 2 && n / Math.max(1, o.count) >= 0.01;
}

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
    if (SENSOR_TYPES.has(t.type)) prior.set(t.topic, { role: "input", reason: `sensor message type (${t.type})` });
    else if (t.type === "tf2_msgs/TFMessage") prior.set(t.topic, { role: "input", reason: "coordinate transforms (infrastructure, not a component output)" });
    else prior.set(t.topic, { role: "output", reason: `derived type (${t.type}), not a raw sensor type` });
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
  const typeOf = (n: string) => topics.find((t) => t.topic === n)?.type ?? "";
  const processed = raw.filter(
    (e) => summarize(e.latencyFromLog).p50 > MIN_PROCESSING_NS && typeOf(e.output) !== "sensor_msgs/CameraInfo" && plausibleSource(e, typeOf(e.input), typeOf(e.output)) && !producedWithoutSource(e, topics),
  );
  const derived = new Set(processed.map((e) => e.output));
  for (const t of topics) {
    const srcs = processed.filter((e) => e.output === t.topic && !derived.has(e.input));
    if (srcs.length) {
      const isImg = (n: string) => (IMAGE_TYPES.has(topics.find((x) => x.topic === n)?.type ?? "") ? 1 : 0);
      // prefer: highest match rate, then image sources (the data the component processes), then namespace
      const lead = (e: CausalEdge) => summarize(e.latencyFromLog).p50; // larger = source published earlier
      const best = srcs.sort((a, b) => b.matchRate - a.matchRate || isImg(b.input) - isImg(a.input) || Math.round((lead(b) - lead(a)) / 1e5) || nsAffinity(b.input, t.topic) - nsAffinity(a.input, t.topic))[0];
      prior.set(t.topic, {
        role: "output",
        reason: `${(best.matchRate * 100).toFixed(0)}% of its header.stamps copy ${best.input}; published a median ${(summarize(best.latencyFromLog).p50 / 1e6).toFixed(1)} ms after the input`,
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
      if (e && plausibleSource(e, i.type, o.type)) edges.push(e);
    }
  }

  // Hardware-synchronised cameras of different FOVs share stamps, so an output "matches"
  // every camera. When an output has a source in its own group (namespace / frame prefix),
  // edges from other groups are dropped.
  {
    const key = (n: string) => {
      const t = topics.find((x) => x.topic === n);
      return t ? fovKey(t)?.value : undefined;
    };
    for (const o of outputs) {
      const k = key(o.topic);
      if (!k || !edges.some((e) => e.output === o.topic && key(e.input) === k)) continue;
      for (let i = edges.length - 1; i >= 0; i--) if (edges[i].output === o.topic && key(edges[i].input) !== k) edges.splice(i, 1);
    }
  }

  // 4) FOV: topics are grouped by namespace or header.frame_id prefix (fovKey). A key is a
  // field of view when it contains at least one image or point-cloud input; an output
  // without a key of its own (root topic, no frame) takes the FOV of its primary image input.
  const keyOf = new Map(topics.map((t) => [t.topic, fovKey(t)] as const));
  const fovKeys = new Set<string>();
  for (const t of inputs) {
    const k = keyOf.get(t.topic);
    if (k && (IMAGE_TYPES.has(t.type) || t.type === "sensor_msgs/PointCloud2")) fovKeys.add(k.value);
  }
  const primaryOf = (o: TopicData) =>
    edges
      .filter((e) => e.output === o.topic && e.kind === "exact" && IMAGE_TYPES.has(topics.find((t) => t.topic === e.input)!.type))
      .sort((a, b) => b.matchRate - a.matchRate || nsAffinity(b.input, o.topic) - nsAffinity(a.input, o.topic))[0];
  for (const t of topics) {
    const k = keyOf.get(t.topic);
    if (k && fovKeys.has(k.value)) {
      t.autoFov = k.value;
      t.fovReason = k.evidence;
    }
  }
  for (const o of outputs) {
    if (o.autoFov) continue;
    const best = primaryOf(o);
    const fov = best && topics.find((t) => t.topic === best.input)?.autoFov;
    if (fov) {
      o.autoFov = fov;
      o.fovReason = `copies the stamps of ${best.input} (FOV ${fov})`;
    }
  }
  const groups = new Map<string, { primary: string; outputs: string[] }>();
  for (const o of outputs) {
    if (!o.autoFov) continue;
    const g = groups.get(o.autoFov) ?? { primary: "", outputs: [] };
    g.outputs.push(o.topic);
    if (!g.primary) {
      const best = primaryOf(o);
      const inFov = best && topics.find((t) => t.topic === best.input)?.autoFov === o.autoFov;
      if (inFov) g.primary = best.input;
    }
    groups.set(o.autoFov, g);
  }
  for (const [fov, g] of groups) {
    if (!g.primary) g.primary = inputs.find((t) => t.autoFov === fov && IMAGE_TYPES.has(t.type))?.topic ?? "";
    if (!g.primary) groups.delete(fov);
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
