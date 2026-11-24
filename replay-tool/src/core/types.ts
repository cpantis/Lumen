/**
 * Shared data model of a recording analysis. Produced once per file by
 * `analyzeRecording` (in a Web Worker in the app, in Node for the CLI) and consumed
 * by every view. Per-message data is stored in typed arrays (structured-clone friendly).
 */
import type { Gap, RateStats, Summary } from "./stats";

export type Role = "input" | "output" | "unknown";

export interface ClockStats {
  /** log_time − header.stamp per message (ns); NaN when the topic has no header */
  offsetSummary: Summary;
  nonMonotonic: number[]; // indices i where stamp[i] < stamp[i-1]
  duplicates: number[]; // indices i where stamp[i] == stamp[i-1]
  future: number[]; // indices where stamp > log_time (stamp from the future)
}

export interface ContentArrays {
  empty: Uint8Array;
  invalid: Uint8Array;
  decodeError: Uint8Array;
  elements: Float32Array;
  nanRatio: Float32Array;
  zeroRatio: Float32Array;
  outOfRangeRatio: Float32Array;
  min: Float32Array;
  max: Float32Array;
  mean: Float32Array;
  hash: Uint32Array;
}

export interface TopicData {
  topic: string;
  channelId: number;
  schemaName: string;
  /** short type, e.g. sensor_msgs/Image */
  type: string;
  messageEncoding: string;
  schemaEncoding: string;
  hasHeader: boolean;
  count: number;
  /** log time, relative ns, sorted */
  log: Float64Array;
  /** header.stamp, relative ns (NaN without header) */
  stamp: Float64Array;
  /** serialized size in bytes */
  size: Uint32Array;
  frameIds: string[];
  /** format details of the first decodable message (encoding, resolution, fields, units…) */
  details: Record<string, string>;
  content: ContentArrays;
  rate: RateStats;
  gaps: Gap[];
  clock?: ClockStats;
  /** automatic classification + human-readable evidence */
  autoRole: Role;
  roleReason: string;
  /** field of view (group) this topic belongs to, inferred from causality */
  autoFov?: string;
  firstError?: string;
}

/** Evidence that output `output` is produced from input `input`. */
export interface CausalEdge {
  input: string;
  output: string;
  /** exact: header.stamp equality, temporal: nearest previous input only */
  kind: "exact" | "temporal";
  /** fraction of output messages matched to an input message */
  matchRate: number;
  matched: number;
  outputs: number;
  /** per output message: index of the matched input (-1 if none) */
  inputIndex: Int32Array;
  /** per output message: log(O) − stamp(I) in ns (NaN if unmatched) = end-to-end latency */
  latency: Float64Array;
  /** per output message: log(O) − log(I) in ns = latency after the input was recorded */
  latencyFromLog: Float64Array;
  latencySummary: Summary;
  /** input frames whose stamp never appears in this output (dropped / skipped) */
  droppedInputs: Int32Array;
  dropRatio: number;
  /** consecutive dropped runs as [startNs, endNs, length] */
  dropRuns: Array<[number, number, number]>;
}

/** Same-moment grouping of the outputs of one FOV (2.3). */
export interface FovGroup {
  fov: string;
  primaryInput: string;
  outputs: string[];
  /** per primary-input stamp that produced ≥ 1 output */
  stamps: Float64Array;
  /** bitmask per stamp: bit k set when outputs[k] has a message with that stamp */
  presence: Uint32Array;
  /** max − min log time of the outputs present for that stamp (ns) */
  spreadNs: Float64Array;
  /** fraction of stamps where every output is present */
  completeRatio: number;
}

export interface MotionEstimate {
  method: "imu-steps" | "assumed";
  imuTopic?: string;
  stepTimes: number[];
  cadenceHz: number;
  stepLengthM: number;
  speedMps: number;
  confidence: "high" | "medium" | "low";
  note: string;
}

export interface Analysis {
  fileName: string;
  fileSize: number;
  sha256: string;
  /** absolute start/end (ns) as decimal strings to stay JSON-friendly */
  startNs: string;
  endNs: string;
  durationNs: number;
  indexed: boolean;
  profile: string;
  library: string;
  topics: TopicData[];
  edges: CausalEdge[];
  fovGroups: FovGroup[];
  motion: MotionEstimate;
  metadata: Array<{ name: string; data: Record<string, string> }>;
  warnings: string[];
  analyzedAt: string;
}
