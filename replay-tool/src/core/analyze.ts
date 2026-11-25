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
import { McapIndexedReader, McapRecordBuilder, McapStreamReader, type McapTypes } from "@mcap/core";
import { inferCausality } from "./causality";
import { contentMetrics, DEFAULT_RANGES, type PlausibleRanges } from "./content";
import { decompressHandlers, makeDecoder, rootDefinition, shortType, type ChannelInfo, type Decoder, type SchemaInfo } from "./decode";
import { estimateMotion } from "./motion";
import { sha256OfParts } from "./sha256";
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

/** One file of a multi-part recording, with its channel ids mapped to the unified ids. */
export interface PartRef {
  name: string;
  rec: OpenedRecording;
  /** part channel id → unified channel id */
  chan: Map<number, number>;
}

export interface OpenedRecording {
  /** several consecutive files of one recording, merged by log time */
  parts?: PartRef[];
  indexed: boolean;
  reader?: McapIndexedReader;
  channels: Map<number, ChannelInfo>;
  schemas: Map<number, SchemaInfo>;
  /**
   * Un-indexed (or damaged) files: a lightweight index of the message blocks (offsets and
   * time spans only). Message bytes are read and decompressed on demand, never kept for
   * the whole file.
   */
  lazy?: LazyStore;
  startNs: bigint;
  endNs: bigint;
  warnings: string[];
}

export type Progress = (phase: string, fraction: number) => void;

/** A block of messages: one Chunk record, or a run of top-level Message records (≤ 4 MiB). */
export interface LazyBlock {
  kind: "chunk" | "loose";
  /** byte range in the file: the whole Chunk record, or the span of the loose messages' data */
  offset: number;
  length: number;
  start: bigint;
  end: bigint;
  count: number;
  /** loose blocks: each message's channel, log time and data range in the file */
  items?: Array<{ channelId: number; logTime: bigint; offset: number; length: number }>;
}

export interface LazyStore {
  blocks: LazyBlock[];
  readSlice: (start: number, end: number) => Promise<Uint8Array>;
}

const LOOSE_BLOCK = 4 << 20;

/** Decodes the messages of one block (log-time order, file order for ties). */
export async function readBlock(rec: OpenedRecording, b: LazyBlock): Promise<RawMessage[]> {
  const bytes = await rec.lazy!.readSlice(b.offset, b.offset + b.length);
  if (b.kind === "loose") return b.items!.map((it) => ({ channelId: it.channelId, logTime: it.logTime, data: bytes.slice(it.offset - b.offset, it.offset - b.offset + it.length) }));
  const out: RawMessage[] = [];
  const stream = new McapStreamReader({ decompressHandlers, validateCrcs: true, noMagicPrefix: true });
  stream.append(seedRecords(rec.schemas, rec.channels));
  stream.append(bytes);
  for (let r; (r = stream.nextRecord()); ) if (r.type === "Message") out.push({ channelId: r.channelId, logTime: r.logTime, data: r.data.slice() });
  return out.map((m, i) => [m, i] as const).sort((x, y) => (x[0].logTime < y[0].logTime ? -1 : x[0].logTime > y[0].logTime ? 1 : x[1] - y[1])).map((x) => x[0]);
}

/** Schema + Channel records re-serialised, to decode a chunk on its own. */
function seedRecords(schemas: Map<number, SchemaInfo>, channels: Map<number, ChannelInfo>): Uint8Array {
  const seed = new McapRecordBuilder();
  for (const sc of schemas.values()) seed.writeSchema(sc);
  for (const c of channels.values()) if (c.schemaId === 0 || schemas.has(c.schemaId)) seed.writeChannel({ id: c.id, topic: c.topic, messageEncoding: c.messageEncoding, schemaId: c.schemaId, metadata: c.metadata ?? new Map() });
  return seed.buffer;
}

/** Buffered random reads over a source (few large reads instead of many small ones). */
function windowed(src: RecordingSource, size = 4 << 20) {
  let wStart = 0, wBuf = new Uint8Array(0);
  return async (start: number, end: number): Promise<Uint8Array> => {
    if (start >= wStart && end <= wStart + wBuf.length) return wBuf.subarray(start - wStart, end - wStart);
    wStart = start;
    wBuf = await src.readSlice(start, Math.min(src.size, Math.max(end, start + size)));
    return wBuf.subarray(0, end - start);
  };
}

/**
 * Sequential scan of an MCAP file without a usable index. Walks the top-level records
 * (opcode + length) and keeps only offsets and time spans: Schema/Channel records are
 * parsed, each Chunk is decompressed once to learn its channels and time span (and to
 * check its CRC), top-level Messages are grouped in blocks. Stops at the Footer, at a
 * truncated record or at unreadable data (the blocks read so far are kept).
 */
async function scanSequential(src: RecordingSource, warnings: string[], onProgress?: Progress): Promise<OpenedRecording> {
  const channels = new Map<number, ChannelInfo>();
  const schemas = new Map<number, SchemaInfo>();
  const blocks: LazyBlock[] = [];
  const read = windowed(src);
  let loose: LazyBlock | undefined;
  let messages = 0;
  const flush = () => {
    if (loose) blocks.push(loose);
    loose = undefined;
  };
  const learn = (r: McapTypes.TypedMcapRecord) => {
    if (r.type === "Schema") schemas.set(r.id, { id: r.id, name: r.name, encoding: r.encoding, data: r.data.slice() });
    else if (r.type === "Channel") channels.set(r.id, { id: r.id, topic: r.topic, messageEncoding: r.messageEncoding, schemaId: r.schemaId, metadata: r.metadata });
  };
  let off = 8;
  let lastPct = 0;
  try {
    while (off + 9 <= src.size) {
      const h = await read(off, off + 9);
      const op = h[0];
      const len = Number(new DataView(h.buffer, h.byteOffset, 9).getBigUint64(1, true));
      const end = off + 9 + len;
      if (end > src.size) {
        warnings.push(`The file ends inside a record at byte ${off} (truncated recording): the messages before it are used.`);
        break;
      }
      if (op === 0x02) break; // Footer
      if (op === 0x03 || op === 0x04) {
        const st = new McapStreamReader({ decompressHandlers, validateCrcs: true, noMagicPrefix: true });
        st.append((await read(off, end)).slice());
        for (let r; (r = st.nextRecord()); ) learn(r);
      } else if (op === 0x05 && len >= 22) {
        const b = await read(off + 9, off + 9 + 22);
        const dv = new DataView(b.buffer, b.byteOffset, 22);
        const item = { channelId: dv.getUint16(0, true), logTime: dv.getBigUint64(6, true), offset: off + 9 + 22, length: len - 22 };
        if (loose && item.offset + item.length - loose.offset > LOOSE_BLOCK) flush();
        if (!loose) loose = { kind: "loose", offset: item.offset, length: 0, start: item.logTime, end: item.logTime, count: 0, items: [] };
        loose.items!.push(item);
        loose.count++;
        loose.length = item.offset + item.length - loose.offset;
        if (item.logTime < loose.start) loose.start = item.logTime;
        if (item.logTime > loose.end) loose.end = item.logTime;
        messages++;
      } else if (op === 0x06) {
        const bytes = (await read(off, end)).slice();
        const st = new McapStreamReader({ decompressHandlers, validateCrcs: true, noMagicPrefix: true });
        st.append(seedRecords(schemas, channels));
        st.append(bytes);
        let lo: bigint | undefined, hi: bigint | undefined, n = 0;
        try {
          for (let r; (r = st.nextRecord()); ) {
            if (r.type === "Message") {
              n++;
              if (lo === undefined || r.logTime < lo) lo = r.logTime;
              if (hi === undefined || r.logTime > hi) hi = r.logTime;
            } else learn(r);
          }
          if (n) blocks.push({ kind: "chunk", offset: off, length: end - off, start: lo!, end: hi!, count: n });
          messages += n;
        } catch (err) {
          warnings.push(`The chunk at byte ${off} is damaged and was skipped (${err instanceof Error ? err.message : String(err)}).`);
        }
      }
      off = end;
      const pct = off / src.size;
      if (pct - lastPct > 0.01) {
        lastPct = pct;
        onProgress?.("sequential read", pct);
      }
    }
  } catch (err) {
    warnings.push(`Sequential reading stopped at byte ${off}: ${err instanceof Error ? err.message : String(err)}. Using the ${messages} messages read up to that point.`);
  }
  flush();
  return lazyRecording(src, channels, schemas, blocks, warnings);
}

function lazyRecording(src: RecordingSource, channels: Map<number, ChannelInfo>, schemas: Map<number, SchemaInfo>, blocks: LazyBlock[], warnings: string[], span?: { start: bigint; end: bigint }): OpenedRecording {
  blocks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.offset - b.offset));
  let start = span?.start, end = span?.end;
  if (!span) {
    for (const b of blocks) {
      if (start === undefined || b.start < start) start = b.start;
      if (end === undefined || b.end > end) end = b.end;
    }
  }
  return { indexed: false, channels, schemas, lazy: { blocks, readSlice: src.readSlice }, startNs: start ?? 0n, endNs: end ?? 0n, warnings };
}

const MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]; // "\x89MCAP0\r\n"

/** Clear error for files that are not MCAP (ROS 1 bag, rosbag2 SQLite, LFS pointer…). */
async function assertMcap(src: RecordingSource): Promise<void> {
  if (src.size < 8) throw new Error("The file is too small to be MCAP (under 8 bytes).");
  const head = await src.readSlice(0, Math.min(src.size, 64));
  if (MAGIC.every((b, i) => head[i] === b)) return;
  const text = new TextDecoder().decode(head);
  if (text.startsWith("#ROSBAG")) throw new Error("This is a ROS 1 rosbag (.bag), not MCAP. Convert it with: mcap convert file.bag file.mcap");
  if (text.startsWith("SQLite format 3")) throw new Error("This is a rosbag2 SQLite file (.db3), not MCAP. Convert it with: ros2 bag convert (storage_id: mcap) or mcap convert file.db3 file.mcap");
  if (text.startsWith("version https://git-lfs")) throw new Error("This is a Git LFS pointer, not the recording itself. Download the real file (git lfs pull).");
  throw new Error("The file does not start with the MCAP magic (\\x89MCAP0\\r\\n): it is not a valid MCAP file.");
}

/** Opens a recording: indexed reader when possible, sequential fallback otherwise. */
export async function openRecording(src: RecordingSource, onProgress?: Progress, forceSequential = false): Promise<OpenedRecording> {
  await assertMcap(src);
  const warnings: string[] = [];
  if (!forceSequential) try {
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
    if (reader.chunkIndexes.length === 0) throw new Error("no chunk index");
    // Index usable only if every non-empty chunk has message indexes (Message Index records are
    // optional in MCAP) and the summary repeats the Channel records (otherwise channels live only
    // inside chunks, which the indexed reader does not see).
    if (reader.chunkIndexes.some((ci) => ci.messageIndexOffsets.size === 0 && ci.messageEndTime !== 0n)) throw new Error("chunks without Message Index");
    if (channels.size === 0) throw new Error("the summary does not contain the Channel records");
    return { indexed: true, reader, channels, schemas, startNs: start ?? 0n, endNs: end ?? 0n, warnings };
  } catch (err) {
    warnings.push(
      `MCAP index unusable (${err instanceof Error ? err.message : String(err)}): the file is read sequentially (block offsets are indexed on the way; messages are decoded on demand).`,
    );
  }
  return scanSequential(src, warnings, onProgress);
}

/**
 * Salvage mode for an indexed file with damaged chunks: every chunk is read and
 * CRC-checked on its own; damaged chunks are skipped (and reported), the rest is kept.
 */
export async function openSalvage(src: RecordingSource, reader: McapIndexedReader, onProgress?: Progress): Promise<OpenedRecording> {
  const channels = new Map<number, ChannelInfo>();
  const schemas = new Map<number, SchemaInfo>();
  for (const [id, c] of reader.channelsById) channels.set(id, { id, topic: c.topic, messageEncoding: c.messageEncoding, schemaId: c.schemaId, metadata: c.metadata });
  for (const [id, sc] of reader.schemasById) schemas.set(id, { id, name: sc.name, encoding: sc.encoding, data: sc.data });
  const blocks: LazyBlock[] = [];
  const bad: string[] = [];
  const cis = [...reader.chunkIndexes].sort((a, b) => (a.chunkStartOffset < b.chunkStartOffset ? -1 : 1));
  const t0 = cis.reduce((m, c) => (c.messageStartTime < m ? c.messageStartTime : m), cis[0]?.messageStartTime ?? 0n);
  for (let k = 0; k < cis.length; k++) {
    const ci = cis[k];
    const start = Number(ci.chunkStartOffset);
    try {
      // a channel may be defined only inside a chunk: learn it while checking the CRC
      const stream = new McapStreamReader({ decompressHandlers, validateCrcs: true, noMagicPrefix: true });
      stream.append(seedRecords(schemas, channels));
      stream.append(await src.readSlice(start, start + Number(ci.chunkLength)));
      let n = 0, lo: bigint | undefined, hi: bigint | undefined;
      for (let rec; (rec = stream.nextRecord()); ) {
        if (rec.type === "Schema") schemas.set(rec.id, { id: rec.id, name: rec.name, encoding: rec.encoding, data: rec.data.slice() });
        else if (rec.type === "Channel") channels.set(rec.id, { id: rec.id, topic: rec.topic, messageEncoding: rec.messageEncoding, schemaId: rec.schemaId, metadata: rec.metadata });
        else if (rec.type === "Message") {
          n++;
          if (lo === undefined || rec.logTime < lo) lo = rec.logTime;
          if (hi === undefined || rec.logTime > hi) hi = rec.logTime;
        }
      }
      if (n) blocks.push({ kind: "chunk", offset: start, length: Number(ci.chunkLength), start: lo!, end: hi!, count: n });
    } catch (err) {
      bad.push(`chunk #${k + 1} @${start} (${(Number(ci.messageStartTime - t0) / 1e9).toFixed(2)} s – ${(Number(ci.messageEndTime - t0) / 1e9).toFixed(2)} s): ${err instanceof Error ? err.message : String(err)}`);
    }
    onProgress?.("recovering chunks", (k + 1) / cis.length);
  }
  const warnings = bad.length ? [`${bad.length} of ${cis.length} chunks are damaged and were skipped (data missing in their intervals): ${bad.join("; ")}`] : [];
  // keep the recording's real time span (from the index) so times stay comparable with other tools
  const st = reader.statistics;
  const startNs = st && st.messageCount > 0n ? st.messageStartTime : t0;
  const endNs = st && st.messageCount > 0n ? st.messageEndTime : cis.reduce((m, c) => (c.messageEndTime > m ? c.messageEndTime : m), 0n);
  return lazyRecording(src, channels, schemas, blocks, warnings, { start: startNs, end: endNs });
}

/**
 * Combines consecutive parts of one recording. Channels are unified by
 * (topic, schema name, message encoding); each unified channel keeps the schema of the
 * first part that defines it. Messages are merged by log time in `iterateAll`.
 */
export function combineParts(parts: Array<{ name: string; rec: OpenedRecording }>): OpenedRecording {
  if (parts.length === 1) return parts[0].rec;
  const channels = new Map<number, ChannelInfo>();
  const schemas = new Map<number, SchemaInfo>();
  const byKey = new Map<string, number>();
  const refs: PartRef[] = [];
  const warnings: string[] = [];
  let start: bigint | undefined, end: bigint | undefined;
  for (const p of parts) {
    const chan = new Map<number, number>();
    for (const c of p.rec.channels.values()) {
      const sc = p.rec.schemas.get(c.schemaId);
      const key = `${c.topic}|${sc?.name ?? ""}|${c.messageEncoding}`;
      let id = byKey.get(key);
      if (id === undefined) {
        id = byKey.size + 1;
        byKey.set(key, id);
        if (sc) schemas.set(id, { ...sc, id });
        channels.set(id, { ...c, id, schemaId: sc ? id : 0 });
      }
      chan.set(c.id, id);
    }
    refs.push({ name: p.name, rec: p.rec, chan });
    for (const w of p.rec.warnings) warnings.push(`${p.name}: ${w}`);
    if (start === undefined || p.rec.startNs < start) start = p.rec.startNs;
    if (end === undefined || p.rec.endNs > end) end = p.rec.endNs;
  }
  const sorted = [...refs].sort((a, b) => (a.rec.startNs < b.rec.startNs ? -1 : a.rec.startNs > b.rec.startNs ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].rec.startNs < sorted[i - 1].rec.endNs) warnings.push(`${sorted[i].name} overlaps ${sorted[i - 1].name} in log time: the parts are merged message by message, in log-time order.`);
  }
  const topics = (r: PartRef) => new Set([...r.rec.channels.values()].map((c) => c.topic));
  for (let i = 1; i < sorted.length; i++) {
    const a = topics(sorted[i - 1]), b = topics(sorted[i]);
    const missing = [...a].filter((t) => !b.has(t));
    if (missing.length) warnings.push(`${sorted[i].name} has no ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""} (present in ${sorted[i - 1].name}).`);
  }
  return { parts: sorted, indexed: sorted.every((r) => r.rec.indexed), channels, schemas, startNs: start ?? 0n, endNs: end ?? 0n, warnings };
}

/** Iterates every message in log-time order (both modes, single file or merged parts). */
export async function* iterateAll(rec: OpenedRecording, topics?: string[], counts?: number[]): AsyncGenerator<RawMessage> {
  if (rec.parts) {
    // k-way merge by log time (ties: part order, then file order)
    const its = rec.parts.map((p) => iterateAll(p.rec, topics));
    const heads: Array<RawMessage | undefined> = [];
    for (let k = 0; k < its.length; k++) heads[k] = (await its[k].next()).value ?? undefined;
    for (;;) {
      let best = -1;
      for (let k = 0; k < heads.length; k++) if (heads[k] && (best < 0 || heads[k]!.logTime < heads[best]!.logTime)) best = k;
      if (best < 0) return;
      const m = heads[best]!;
      if (counts) counts[best] = (counts[best] ?? 0) + 1;
      heads[best] = (await its[best].next()).value ?? undefined;
      const id = rec.parts[best].chan.get(m.channelId);
      // unknown channel ids stay unknown (negative) so the caller can count them
      yield { channelId: id ?? -1 - m.channelId, logTime: m.logTime, data: m.data };
    }
  }
  if (rec.indexed && rec.reader) {
    for await (const m of rec.reader.readMessages({ topics })) yield { channelId: m.channelId, logTime: m.logTime, data: m.data };
  } else if (rec.lazy) {
    // blocks are sorted by start time; a block's messages are released once no later
    // block can contain an earlier message (blocks may overlap in time)
    const set = topics ? new Set(topics) : undefined;
    const want = (m: RawMessage) => !set || set.has(rec.channels.get(m.channelId)?.topic ?? "");
    const blocks = rec.lazy.blocks;
    let pending: RawMessage[] = [];
    for (let k = 0; k < blocks.length; k++) {
      const msgs = await readBlock(rec, blocks[k]);
      pending = pending.length ? mergeSorted(pending, msgs.filter(want)) : msgs.filter(want);
      const limit = k + 1 < blocks.length ? blocks[k + 1].start : undefined;
      let cut = pending.length;
      if (limit !== undefined) {
        cut = 0;
        while (cut < pending.length && pending[cut].logTime < limit) cut++;
      }
      for (let i = 0; i < cut; i++) yield pending[i];
      pending = pending.slice(cut);
    }
  }
}

function mergeSorted(a: RawMessage[], b: RawMessage[]): RawMessage[] {
  const out: RawMessage[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].logTime <= b[j].logTime)) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

/** Format details for the inventory (2.1): encoding, size, units, frame… */
export function formatDetails(type: string, msg: any): Record<string, string> {
  const d: Record<string, string> = {};
  if (msg?.header?.frame_id !== undefined) d["frame_id"] = msg.header.frame_id || "(gol)";
  switch (type) {
    case "sensor_msgs/Image": {
      d["resolution"] = `${msg.width}×${msg.height}`;
      d["encoding"] = msg.encoding;
      d["step"] = `${msg.step} B`;
      d["endianness"] = msg.is_bigendian ? "big" : "little";
      const e = String(msg.encoding).toLowerCase();
      d["units"] = e === "16uc1" ? "depth in mm (REP-118)" : e === "32fc1" ? "depth in m (REP-118)" : "intensity 0–255 per channel";
      break;
    }
    case "sensor_msgs/CompressedImage":
      d["format"] = msg.format;
      d["units"] = "compressed image (bytes)";
      break;
    case "sensor_msgs/CameraInfo": {
      const k = Array.from(msg.k ?? []) as number[];
      d["resolution"] = `${msg.width}×${msg.height}`;
      d["distortion model"] = msg.distortion_model || "(unspecified)";
      if (k.length === 9) d["intrinsics"] = `fx=${k[0].toFixed(1)} fy=${k[4].toFixed(1)} cx=${k[2].toFixed(1)} cy=${k[5].toFixed(1)} px`;
      d["D"] = `[${Array.from(msg.d ?? []).map((v) => Number(v).toFixed(4)).join(", ")}]`;
      break;
    }
    case "sensor_msgs/PointCloud2": {
      const names: Record<number, string> = { 1: "i8", 2: "u8", 3: "i16", 4: "u16", 5: "i32", 6: "u32", 7: "f32", 8: "f64" };
      d["fields"] = (msg.fields ?? []).map((f: any) => `${f.name}:${names[f.datatype] ?? f.datatype}`).join(", ");
      d["point_step"] = `${msg.point_step} B`;
      d["points (first message)"] = `${msg.width * msg.height} (${msg.width}×${msg.height})`;
      d["is_dense"] = String(msg.is_dense);
      d["units"] = "metres, in the header frame";
      break;
    }
    case "sensor_msgs/Imu":
      d["units"] = "acceleration m/s², angular velocity rad/s, orientation quaternion";
      d["orientation provided"] = msg.orientation_covariance?.[0] === -1 ? "no (covariance −1)" : "yes";
      break;
    case "tf2_msgs/TFMessage":
      d["transforms"] = (msg.transforms ?? []).map((t: any) => `${t.header.frame_id}→${t.child_frame_id}`).join(", ");
      d["units"] = "translation m, rotation quaternion";
      break;
    case "sensor_msgs/LaserScan":
      d["angles"] = `${msg.angle_min?.toFixed(3)}…${msg.angle_max?.toFixed(3)} rad, step ${msg.angle_increment?.toFixed(4)}`;
      d["range"] = `${msg.range_min}…${msg.range_max} m`;
      break;
    case "nav_msgs/OccupancyGrid":
      d["grid"] = `${msg.info?.width}×${msg.info?.height} @ ${msg.info?.resolution} m/cell`;
      d["units"] = "occupancy probability 0–100, −1 unknown";
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
  input: RecordingSource | RecordingSource[],
  opts: { ranges?: PlausibleRanges; onProgress?: Progress; hash?: boolean; opened?: OpenedRecording } = {},
): Promise<{ analysis: Analysis; opened: OpenedRecording }> {
  const srcs = Array.isArray(input) ? input : [input];
  if (!srcs.length) throw new Error("No file to analyse");
  const multi = srcs.length > 1;
  const src: RecordingSource = multi ? { name: srcs.map((s) => s.name).join(" + "), size: srcs.reduce((n, s) => n + s.size, 0), readable: srcs[0].readable, readSlice: srcs[0].readSlice } : srcs[0];
  const ranges = opts.ranges ?? DEFAULT_RANGES;
  const progress = opts.onProgress ?? (() => {});
  const hashes = opts.hash === false ? { parts: srcs.map(() => ""), combined: "" } : await sha256OfParts(srcs, (p) => progress("SHA-256", p));
  const sha = hashes.combined;
  const files = srcs.map((s, i) => ({ name: s.name, size: s.size, sha256: hashes.parts[i] }));
  let rec = opts.opened;
  if (!rec) {
    if (multi) {
      const parts: Array<{ name: string; rec: OpenedRecording }> = [];
      for (const s of srcs) parts.push({ name: s.name, rec: await openRecording(s, progress) });
      rec = combineParts(parts);
    } else rec = await openRecording(src, progress);
  }
  if (multi) return analyzeOpened(src, rec, ranges, progress, sha, files, srcs);
  try {
    return await analyzeOpened(src, rec, ranges, progress, sha, files, srcs);
  } catch (err) {
    if (!(err instanceof RetryRead)) throw err;
    return analyzeRecording(src, { ...opts, hash: false, opened: err.opened }).then((r) => ({ ...r, analysis: { ...r.analysis, sha256: sha, files } }));
  }
}

/** Thrown inside the pass when the file must be re-read another way (salvage / sequential). */
class RetryRead extends Error {
  constructor(readonly opened: OpenedRecording) {
    super("retry");
  }
}

async function analyzeOpened(
  src: RecordingSource,
  rec: OpenedRecording,
  ranges: PlausibleRanges,
  progress: Progress,
  sha: string,
  files: NonNullable<Analysis["files"]>,
  srcs: RecordingSource[],
): Promise<{ analysis: Analysis; opened: OpenedRecording }> {
  const start = rec.startNs;
  const span = Number(rec.endNs - rec.startNs) || 1;

  const accs = new Map<number, Acc>();
  for (const ch of rec.channels.values()) {
    const schema = rec.schemas.get(ch.schemaId);
    accs.set(ch.id, {
      ch,
      schema,
      decoder: makeDecoder(ch, schema),
      header: false,
      log: [],
      stamp: [],
      size: [],
      samples: [],
      decErr: [],
      frameIds: new Set(),
    });
  }

  let k = 0;
  let total = 0;
  let unknownChannel = 0;
  const partCounts: number[] = [];
  try {
  for await (const m of iterateAll(rec, undefined, partCounts)) {
    const a = accs.get(m.channelId);
    if (!a) {
      unknownChannel++;
      continue;
    }
    total++;
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
    if (++k % 500 === 0) progress("analysing messages", Math.min(1, Number(m.logTime - start) / span));
  }
  } catch (err) {
    // A corrupt chunk / inconsistent index during indexed reading: redo everything sequentially.
    if (rec.indexed && rec.reader) {
      const again = await openSalvage(src, rec.reader, progress);
      again.warnings.unshift(`Indexed reading failed (${err instanceof Error ? err.message : String(err)}); every chunk was checked separately (CRC).`);
      throw new RetryRead(again);
    }
    if (rec.parts) {
      // a damaged part: salvage that part and redo the merged pass
      const msg = err instanceof Error ? err.message : String(err);
      const parts = [];
      for (let i = 0; i < rec.parts.length; i++) {
        const p = rec.parts[i];
        const s = srcs.find((x) => x.name === p.name)!;
        parts.push({ name: p.name, rec: p.rec.indexed && p.rec.reader && !p.rec.warnings.length ? await openSalvage(s, p.rec.reader, progress) : p.rec });
      }
      const again = combineParts(parts);
      again.warnings.unshift(`Indexed reading of the merged parts failed (${msg}); every chunk was checked separately (CRC).`);
      if (!rec.warnings.some((w) => w.startsWith("Indexed reading of the merged parts failed"))) return analyzeOpened(src, again, ranges, progress, sha, files, srcs);
    }
    rec.warnings.push(`Reading stopped: ${err instanceof Error ? err.message : String(err)}.`);
  }
  // Messages outside chunks or channels missing from the summary are invisible to the index:
  // compare with the Statistics record and fall back to a sequential pass when they disagree.
  const statCount = rec.reader?.statistics?.messageCount;
  if (!rec.parts && rec.indexed && (unknownChannel > 0 || (statCount !== undefined && statCount > 0n && BigInt(total + unknownChannel) !== statCount))) {
    const again = await openRecording(src, progress, true);
    again.warnings.unshift(`The index does not cover every message (statistics: ${statCount ?? "?"}, found through the index: ${total}, unknown channel: ${unknownChannel}); the file was read sequentially.`);
    throw new RetryRead(again);
  }
  if (rec.parts) {
    // same check per part: re-read sequentially the parts whose index misses messages
    const redo = rec.parts.map((p, i) => {
      const sc = p.rec.reader?.statistics?.messageCount;
      return p.rec.indexed && sc !== undefined && sc > 0n && BigInt(partCounts[i] ?? 0) !== sc;
    });
    if (redo.some(Boolean)) {
      const parts = [];
      for (let i = 0; i < rec.parts.length; i++) {
        const p = rec.parts[i];
        if (!redo[i]) parts.push({ name: p.name, rec: p.rec });
        else {
          const again = await openRecording(srcs.find((x) => x.name === p.name)!, progress, true);
          again.warnings.unshift(`the index does not cover every message (statistics: ${p.rec.reader?.statistics?.messageCount}, through the index: ${partCounts[i] ?? 0}); the part was read sequentially.`);
          parts.push({ name: p.name, rec: again });
        }
      }
      return analyzeOpened(src, combineParts(parts), ranges, progress, sha, files, srcs);
    }
  }
  if (unknownChannel) rec.warnings.push(`${unknownChannel} messages reference a channel without a Channel record and were ignored.`);
  progress("analysing messages", 1);

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
    const type = shortType(a.schema?.name ?? "(no schema)");
    // header detected from the data (works for every encoding, incl. Foxglove "timestamp")
    const header = stamp.some((v) => Number.isFinite(v));
    const rate = rateStats(log);
    const sizeSorted = Array.from(size).sort((x, y) => x - y);
    const details = { ...(a.details ?? {}) };
    if (n) details["message size"] = `median ${sizeSorted[n >> 1]} B (min ${sizeSorted[0]}, max ${sizeSorted[n - 1]})`;
    const root = rootDefinition(a.schema);
    if (root && Object.keys(a.details ?? {}).length <= 1) {
      details["fields"] = root.definitions.filter((f) => !f.isConstant).map((f) => `${f.name}:${f.type}${f.isArray ? "[]" : ""}`).join(", ");
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
  progress("causality", 0.5);
  const { edges, fovGroups } = inferCausality(topics);

  const imu = topics.find((t) => t.type === "sensor_msgs/Imu" && t.count > 0);
  const motion = estimateMotion(imu ? { topic: imu.topic, t: imu.log, accNorm: Float64Array.from(imu.content.min) } : undefined);

  const metadata: Analysis["metadata"] = [];
  for (const p of rec.parts ?? [{ name: "", rec }]) {
    if (!p.rec.reader) continue;
    try {
      for await (const md of p.rec.reader.readMetadata()) metadata.push({ name: rec.parts ? `${p.name}: ${md.name}` : md.name, data: Object.fromEntries(md.metadata) });
    } catch {
      /* metadata is optional */
    }
  }
  progress("done", 1);
  return {
    opened: rec,
    analysis: {
      fileName: src.name,
      fileSize: src.size,
      sha256: sha,
      files,
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
