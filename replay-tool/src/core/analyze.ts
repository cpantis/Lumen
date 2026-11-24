/**
 * Recording analysis orchestrator — the single source of every number shown in the
 * app and written by the CLI (`npm run metrics`). Runs in a Web Worker in the browser
 * and directly in Node; it only depends on an `IReadable` and a `readSlice` function.
 *
 * One full pass over all messages (log-time order) collects per message: log time,
 * header.stamp, size, content metrics. Then rates, gaps, clock analysis, causality,
 * FOV groups and the motion estimate are derived. Deterministic: no sampling of
 * messages (only per-pixel sub-sampling inside a message, documented in content.ts).
 */
import { McapIndexedReader, McapStreamReader, type McapTypes } from "@mcap/core";
import { inferCausality } from "./causality";
import { contentMetrics, DEFAULT_RANGES, type PlausibleRanges } from "./content";
import { decompressHandlers, hasHeader, makeDecoder, rootDefinition, shortType, type ChannelInfo, type Decoder, type SchemaInfo } from "./decode";
import { estimateMotion } from "./motion";
import { sha256Of } from "./sha256";
import { detectGaps, rateStats, summarize } from "./stats";
import { rosTimeToNs } from "./time";
import type { Analysis, ClockStats, ContentArrays, TopicData } from "./types";

export const LIBRARY = "@mcap/core 2.4.0 + @foxglove/rosmsg2-serialization 3.1.2";

export interface RecordingSource {
  name: string;
  size: number;
  readable: McapTypes.IReadable;
  readSlice: (start: number, end: number) => Promise<Uint8Array>;
}

export interface RawMessage {
  channelId: number;
  logTime: bigint;
  data: Uint8Array;
}

export interface OpenedRecording {
  indexed: boolean;
  reader?: McapIndexedReader;
  channels: Map<number, ChannelInfo>;
  schemas: Map<number, SchemaInfo>;
  /** only for un-indexed files: every message kept in memory (log-time sorted) */
  messages?: RawMessage[];
  startNs: bigint;
  endNs: bigint;
  warnings: string[];
}

export type Progress = (phase: string, fraction: number) => void;

/** Opens a recording: indexed reader when possible, sequential fallback otherwise. */
export async function openRecording(src: RecordingSource, onProgress?: Progress): Promise<OpenedRecording> {
  const warnings: string[] = [];
  try {
    const reader = await McapIndexedReader.Initialize({ readable: src.readable, decompressHandlers });
    const channels = new Map<number, ChannelInfo>();
    for (const [id, c] of reader.channelsById) channels.set(id, { id, topic: c.topic, messageEncoding: c.messageEncoding, schemaId: c.schemaId, metadata: c.metadata });
    const schemas = new Map<number, SchemaInfo>();
    for (const [id, s] of reader.schemasById) schemas.set(id, { id, name: s.name, encoding: s.encoding, data: s.data });
    let start = reader.statistics?.messageStartTime;
    let end = reader.statistics?.messageEndTime;
    if (start === undefined || end === undefined || reader.statistics?.messageCount === 0n) {
      for (const ci of reader.chunkIndexes) {
        if (start === undefined || ci.messageStartTime < start) start = ci.messageStartTime;
        if (end === undefined || ci.messageEndTime > end) end = ci.messageEndTime;
      }
    }
    if (reader.chunkIndexes.length === 0) throw new Error("fără chunk index");
    return { indexed: true, reader, channels, schemas, startNs: start ?? 0n, endNs: end ?? 0n, warnings };
  } catch (err) {
    warnings.push(
      `Fișierul nu are index utilizabil (${err instanceof Error ? err.message : String(err)}). Se citește secvențial (McapStreamReader); fișierul poate fi trunchiat.`,
    );
  }
  // Sequential fallback
  const stream = new McapStreamReader({ decompressHandlers, validateCrcs: false });
  const channels = new Map<number, ChannelInfo>();
  const schemas = new Map<number, SchemaInfo>();
  const messages: RawMessage[] = [];
  const CH = 4 << 20;
  try {
    for (let s = 0; s < src.size; s += CH) {
      stream.append(await src.readSlice(s, Math.min(src.size, s + CH)));
      for (let rec; (rec = stream.nextRecord()); ) {
        if (rec.type === "Schema") schemas.set(rec.id, { id: rec.id, name: rec.name, encoding: rec.encoding, data: rec.data });
        else if (rec.type === "Channel") channels.set(rec.id, { id: rec.id, topic: rec.topic, messageEncoding: rec.messageEncoding, schemaId: rec.schemaId, metadata: rec.metadata });
        else if (rec.type === "Message") messages.push({ channelId: rec.channelId, logTime: rec.logTime, data: rec.data.slice() });
      }
      onProgress?.("citire secvențială", Math.min(1, (s + CH) / src.size));
    }
  } catch (err) {
    warnings.push(`Citirea secvențială s-a oprit: ${err instanceof Error ? err.message : String(err)}. Se folosesc ${messages.length} mesaje citite până acolo.`);
  }
  messages.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : 0));
  const startNs = messages.length ? messages[0].logTime : 0n;
  const endNs = messages.length ? messages[messages.length - 1].logTime : 0n;
  return { indexed: false, channels, schemas, messages, startNs, endNs, warnings };
}

/** Iterates every message in log-time order (both modes). */
export async function* iterateAll(rec: OpenedRecording, topics?: string[]): AsyncGenerator<RawMessage> {
  if (rec.indexed && rec.reader) {
    for await (const m of rec.reader.readMessages({ topics })) yield { channelId: m.channelId, logTime: m.logTime, data: m.data };
  } else if (rec.messages) {
    const set = topics ? new Set(topics) : undefined;
    for (const m of rec.messages) if (!set || set.has(rec.channels.get(m.channelId)?.topic ?? "")) yield m;
  }
}

/** Format details for the inventory (2.1): encoding, size, units, frame… */
export function formatDetails(type: string, msg: any): Record<string, string> {
  const d: Record<string, string> = {};
  if (msg?.header?.frame_id !== undefined) d["frame_id"] = msg.header.frame_id || "(gol)";
  switch (type) {
    case "sensor_msgs/Image": {
      d["rezoluție"] = `${msg.width}×${msg.height}`;
      d["encoding"] = msg.encoding;
      d["step"] = `${msg.step} B`;
      d["endianness"] = msg.is_bigendian ? "big" : "little";
      const e = String(msg.encoding).toLowerCase();
      d["unități"] = e === "16uc1" ? "adâncime în mm (REP-118)" : e === "32fc1" ? "adâncime în m (REP-118)" : "intensitate 0–255 per canal";
      break;
    }
    case "sensor_msgs/CompressedImage":
      d["format"] = msg.format;
      d["unități"] = "imagine comprimată (octeți)";
      break;
    case "sensor_msgs/CameraInfo": {
      const k = Array.from(msg.k ?? []) as number[];
      d["rezoluție"] = `${msg.width}×${msg.height}`;
      d["model distorsiune"] = msg.distortion_model || "(nespecificat)";
      if (k.length === 9) d["intrinseci"] = `fx=${k[0].toFixed(1)} fy=${k[4].toFixed(1)} cx=${k[2].toFixed(1)} cy=${k[5].toFixed(1)} px`;
      d["D"] = `[${Array.from(msg.d ?? []).map((v) => Number(v).toFixed(4)).join(", ")}]`;
      break;
    }
    case "sensor_msgs/PointCloud2": {
      const names: Record<number, string> = { 1: "i8", 2: "u8", 3: "i16", 4: "u16", 5: "i32", 6: "u32", 7: "f32", 8: "f64" };
      d["câmpuri"] = (msg.fields ?? []).map((f: any) => `${f.name}:${names[f.datatype] ?? f.datatype}`).join(", ");
      d["point_step"] = `${msg.point_step} B`;
      d["puncte (primul mesaj)"] = `${msg.width * msg.height} (${msg.width}×${msg.height})`;
      d["is_dense"] = String(msg.is_dense);
      d["unități"] = "metri, în frame-ul din header";
      break;
    }
    case "sensor_msgs/Imu":
      d["unități"] = "accelerație m/s², viteză unghiulară rad/s, orientare cuaternion";
      d["orientare furnizată"] = msg.orientation_covariance?.[0] === -1 ? "nu (covarianță −1)" : "da";
      break;
    case "tf2_msgs/TFMessage":
      d["transformări"] = (msg.transforms ?? []).map((t: any) => `${t.header.frame_id}→${t.child_frame_id}`).join(", ");
      d["unități"] = "translație m, rotație cuaternion";
      break;
    case "sensor_msgs/LaserScan":
      d["unghiuri"] = `${msg.angle_min?.toFixed(3)}…${msg.angle_max?.toFixed(3)} rad, pas ${msg.angle_increment?.toFixed(4)}`;
      d["interval"] = `${msg.range_min}…${msg.range_max} m`;
      break;
    case "nav_msgs/OccupancyGrid":
      d["grilă"] = `${msg.info?.width}×${msg.info?.height} @ ${msg.info?.resolution} m/celulă`;
      d["unități"] = "probabilitate ocupare 0–100, −1 necunoscut";
      break;
  }
  return d;
}

function makeContentArrays(n: number): ContentArrays {
  return {
    empty: new Uint8Array(n),
    invalid: new Uint8Array(n),
    decodeError: new Uint8Array(n),
    elements: new Float32Array(n),
    nanRatio: new Float32Array(n),
    zeroRatio: new Float32Array(n),
    outOfRangeRatio: new Float32Array(n),
    min: new Float32Array(n),
    max: new Float32Array(n),
    mean: new Float32Array(n),
    hash: new Uint32Array(n),
  };
}

function clockStats(log: Float64Array, stamp: Float64Array): ClockStats {
  const off = new Float64Array(log.length);
  const nonMonotonic: number[] = [];
  const duplicates: number[] = [];
  const future: number[] = [];
  for (let i = 0; i < log.length; i++) {
    off[i] = log[i] - stamp[i];
    if (off[i] < 0) future.push(i);
    if (i > 0) {
      if (stamp[i] < stamp[i - 1]) nonMonotonic.push(i);
      else if (stamp[i] === stamp[i - 1]) duplicates.push(i);
    }
  }
  return { offsetSummary: summarize(off), nonMonotonic, duplicates, future };
}

interface Acc {
  ch: ChannelInfo;
  schema?: SchemaInfo;
  decoder: Decoder;
  header: boolean;
  log: number[];
  stamp: number[];
  size: number[];
  samples: ReturnType<typeof contentMetrics>[];
  decErr: number[];
  frameIds: Set<string>;
  details?: Record<string, string>;
  firstError?: string;
}

/**
 * Full analysis of a recording.
 * @param opts.hash compute SHA-256 of the file (default true)
 */
export async function analyzeRecording(
  src: RecordingSource,
  opts: { ranges?: PlausibleRanges; onProgress?: Progress; hash?: boolean; opened?: OpenedRecording } = {},
): Promise<{ analysis: Analysis; opened: OpenedRecording }> {
  const ranges = opts.ranges ?? DEFAULT_RANGES;
  const progress = opts.onProgress ?? (() => {});
  const sha = opts.hash === false ? "" : await sha256Of(src.size, src.readSlice, (p) => progress("SHA-256", p));
  const rec = opts.opened ?? (await openRecording(src, progress));
  const start = rec.startNs;
  const span = Number(rec.endNs - rec.startNs) || 1;

  const accs = new Map<number, Acc>();
  for (const ch of rec.channels.values()) {
    const schema = rec.schemas.get(ch.schemaId);
    accs.set(ch.id, {
      ch,
      schema,
      decoder: makeDecoder(ch, schema),
      header: hasHeader(schema),
      log: [],
      stamp: [],
      size: [],
      samples: [],
      decErr: [],
      frameIds: new Set(),
    });
  }

  let k = 0;
  for await (const m of iterateAll(rec)) {
    const a = accs.get(m.channelId);
    if (!a) continue;
    a.log.push(Number(m.logTime - start));
    a.size.push(m.data.length);
    let msg: any;
    try {
      msg = a.decoder(m.data);
    } catch (err) {
      a.decErr.push(a.log.length - 1);
      a.firstError ??= err instanceof Error ? err.message : String(err);
      a.stamp.push(NaN);
      a.samples.push(contentMetrics("", undefined, ranges));
      continue;
    }
    const st = msg?.header?.stamp;
    a.stamp.push(st ? Number(rosTimeToNs(st) - start) : NaN);
    if (msg?.header?.frame_id !== undefined) a.frameIds.add(msg.header.frame_id);
    const type = shortType(a.schema?.name ?? "");
    if (!a.details) a.details = formatDetails(type, msg);
    a.samples.push(contentMetrics(a.schema?.name ?? "", msg, ranges));
    if (++k % 500 === 0) progress("analiză mesaje", Math.min(1, Number(m.logTime - start) / span));
  }
  progress("analiză mesaje", 1);

  const topics: TopicData[] = [];
  for (const a of accs.values()) {
    const n = a.log.length;
    // ensure log-time order (stream fallback is already sorted; keep stable)
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((x, y) => a.log[x] - a.log[y] || x - y);
    const log = Float64Array.from(order, (i) => a.log[i]);
    const stamp = Float64Array.from(order, (i) => a.stamp[i]);
    const size = Uint32Array.from(order, (i) => a.size[i]);
    const content = makeContentArrays(n);
    const decSet = new Set(a.decErr);
    order.forEach((src, i) => {
      const s = a.samples[src];
      content.empty[i] = s.empty ? 1 : 0;
      content.invalid[i] = s.invalid ? 1 : 0;
      content.decodeError[i] = decSet.has(src) ? 1 : 0;
      content.elements[i] = s.elements;
      content.nanRatio[i] = s.nanRatio;
      content.zeroRatio[i] = s.zeroRatio;
      content.outOfRangeRatio[i] = s.outOfRangeRatio;
      content.min[i] = s.min;
      content.max[i] = s.max;
      content.mean[i] = s.mean;
      content.hash[i] = s.hash;
    });
    const type = shortType(a.schema?.name ?? "(fără schemă)");
    const header = a.header && stamp.some((v) => Number.isFinite(v));
    const rate = rateStats(log);
    const sizeSorted = Array.from(size).sort((x, y) => x - y);
    const details = { ...(a.details ?? {}) };
    if (n) details["dimensiune mesaj"] = `mediană ${sizeSorted[n >> 1]} B (min ${sizeSorted[0]}, max ${sizeSorted[n - 1]})`;
    const root = rootDefinition(a.schema);
    if (root && Object.keys(a.details ?? {}).length <= 1) {
      details["câmpuri"] = root.definitions.filter((f) => !f.isConstant).map((f) => `${f.name}:${f.type}${f.isArray ? "[]" : ""}`).join(", ");
    }
    topics.push({
      topic: a.ch.topic,
      channelId: a.ch.id,
      schemaName: a.schema?.name ?? "",
      type,
      messageEncoding: a.ch.messageEncoding,
      schemaEncoding: a.schema?.encoding ?? "",
      hasHeader: header,
      count: n,
      log,
      stamp,
      size,
      frameIds: [...a.frameIds],
      details,
      content,
      rate,
      gaps: detectGaps(log, 2, rate.medianPeriodNs),
      clock: header ? clockStats(log, stamp) : undefined,
      autoRole: "unknown",
      roleReason: "",
      firstError: a.firstError,
    });
  }
  topics.sort((x, y) => x.topic.localeCompare(y.topic));
  progress("cauzalitate", 0.5);
  const { edges, fovGroups } = inferCausality(topics);

  const imu = topics.find((t) => t.type === "sensor_msgs/Imu" && t.count > 0);
  const motion = estimateMotion(imu ? { topic: imu.topic, t: imu.log, accNorm: Float64Array.from(imu.content.min) } : undefined);

  const metadata: Analysis["metadata"] = [];
  if (rec.reader) {
    try {
      for await (const md of rec.reader.readMetadata()) metadata.push({ name: md.name, data: Object.fromEntries(md.metadata) });
    } catch {
      /* metadata is optional */
    }
  }
  progress("gata", 1);
  return {
    opened: rec,
    analysis: {
      fileName: src.name,
      fileSize: src.size,
      sha256: sha,
      startNs: start.toString(),
      endNs: rec.endNs.toString(),
      durationNs: Number(rec.endNs - rec.startNs),
      indexed: rec.indexed,
      profile: "",
      library: LIBRARY,
      topics,
      edges,
      fovGroups,
      motion,
      metadata,
      warnings: rec.warnings,
      analyzedAt: new Date().toISOString(),
    },
  };
}
