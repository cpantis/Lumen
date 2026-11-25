/**
 * Per-topic settings inferred from the recording itself, each with its evidence.
 * Nothing here knows a topic name, a rate or a number of fields of view.
 *
 *  - field of view key: the topic namespace, or the header.frame_id prefix for
 *    topics at the root (e.g. "/rgb" with frame "front_rgb_optical_frame" → "front");
 *  - nominal period: median interval of the sorted unique stamps;
 *    frame period (images): median of the intervals < 1.5 × the overall median;
 *  - depth: unit from the encoding (16UC1 → mm, 32FC1 → m), display range = observed
 *    valid maximum (p99.9 of the valid pixels) rounded up;
 *  - point cloud colouring: an rgb/rgba field when present, otherwise distance.
 */
import { framePeriod, intervalStats, timesOf } from "./parity";
import type { TopicData } from "./types";

export interface Inferred<T> {
  value: T;
  evidence: string;
}

export interface TopicInference {
  nominalPeriodNs: Inferred<number>;
  framePeriodNs?: Inferred<number>;
  depthUnit?: Inferred<"mm" | "m">;
  depthMaxM?: Inferred<number>;
  cloudColour?: Inferred<string>;
}

/** Trailing frame_id words that name a sensor's sub-frame, not the sensor itself. */
const FRAME_SUFFIX = /^(optical|frame|link|base|color|colour|rgb|depth|aligned|ir|infra\d*|left|right|camera|cam|points|cloud|sensor)$/i;

/** Prefix of a frame_id once its sub-frame words are removed ("" when nothing remains). */
export function framePrefix(frameId: string): string {
  const tokens = frameId.replace(/^\/+/, "").split(/[_/.\-]/).filter(Boolean);
  while (tokens.length > 1 && FRAME_SUFFIX.test(tokens[tokens.length - 1])) tokens.pop();
  return tokens.length && !(tokens.length === 1 && FRAME_SUFFIX.test(tokens[0])) ? tokens.join("_") : "";
}

/** Namespace of a topic ("/a/b/c" → "a"); "" for a root topic. */
export function namespaceOf(topic: string): string {
  const seg = topic.split("/").filter(Boolean);
  return seg.length >= 2 ? seg[0] : "";
}

/** Grouping key of a topic: namespace first, then header.frame_id prefix. */
export function fovKey(t: TopicData): Inferred<string> | undefined {
  const ns = namespaceOf(t.topic);
  if (ns) return { value: ns, evidence: `namespace /${ns}` };
  const f = t.frameIds.find((x) => framePrefix(x));
  if (f) return { value: framePrefix(f), evidence: `header.frame_id prefix "${framePrefix(f)}" (frame ${f})` };
  return undefined;
}

/** Rounds a positive value up to a readable bound: 0.1 below 1, 1 below 20, 5 above. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return NaN;
  const step = v < 1 ? 0.1 : v < 20 ? 1 : 5;
  return +(Math.ceil(v / step - 1e-9) * step).toFixed(3);
}

/** Depth histogram bin width (m) and range used to estimate p99.9 over the recording. */
export const DEPTH_BIN_M = 0.01;
export const DEPTH_BINS = 20000; // 0–200 m

/** q-quantile from a fixed-bin histogram (upper edge of the bin reaching q). */
export function histQuantile(hist: ArrayLike<number>, q: number, binWidth: number): number {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (!total) return NaN;
  const target = q * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return (i + 1) * binWidth;
  }
  return hist.length * binWidth;
}

const isDepthEncoding = (enc: string) => /^(16uc1|32fc1|mono16)$/i.test(enc);

/** Settings inferred for one topic. `depthHist` = valid depth values (m) binned by DEPTH_BIN_M. */
export function inferTopic(t: TopicData, depthHist?: ArrayLike<number>): TopicInference {
  const times = timesOf(t);
  const base = t.hasHeader ? "header.stamp" : "log time";
  const iv = intervalStats(times);
  const out: TopicInference = {
    nominalPeriodNs: { value: iv.medianNs, evidence: `median interval of ${iv.n} unique ${base}s` },
  };
  if (/Image|PointCloud2/.test(t.type) && iv.n > 2) {
    const fp = framePeriod(times);
    out.framePeriodNs = { value: fp, evidence: `median of the ${base} intervals shorter than 1.5 × their median (${(iv.medianNs / 1e6).toFixed(1)} ms); dropped frames excluded` };
  }
  const enc = t.details["encoding"] ?? "";
  if (t.type === "sensor_msgs/Image" && isDepthEncoding(enc)) {
    const unit = /32fc1/i.test(enc) ? "m" : "mm";
    out.depthUnit = { value: unit, evidence: `encoding ${enc} (REP-118: ${unit === "mm" ? "16-bit unsigned millimetres" : "32-bit float metres"})` };
    const p = depthHist ? histQuantile(depthHist, 0.999, DEPTH_BIN_M) : NaN;
    if (Number.isFinite(p)) out.depthMaxM = { value: niceCeil(p), evidence: `p99.9 of the valid (non-zero, finite) pixels over the recording = ${p.toFixed(2)} m, rounded up` };
  }
  if (t.type === "sensor_msgs/PointCloud2") {
    const fields = (t.details["fields"] ?? "").split(",").map((f) => f.trim().split(":")[0]).filter(Boolean);
    const rgb = fields.find((f) => /^rgba?$/i.test(f));
    out.cloudColour = rgb
      ? { value: rgb, evidence: `field "${rgb}" present (PCL packed float 0x00RRGGBB)` }
      : { value: "distance", evidence: `no rgb/rgba field (fields: ${fields.join(", ") || "—"}): coloured by distance` };
  }
  return out;
}
