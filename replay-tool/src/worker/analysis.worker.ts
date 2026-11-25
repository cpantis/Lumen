/// <reference lib="webworker" />
/**
 * Worker: owns the opened recording. Runs the full analysis once, then serves
 * individual decoded messages on demand (LRU cache + prefetch of the next frames),
 * and numeric field series for the generic plot panel. The UI thread never decodes.
 */
import { analyzeRecording, iterateAll, readBlock, type OpenedRecording, type PartRef } from "../core/analyze";
import { makeDecoder, shortType, type Decoder } from "../core/decode";
import { classMapClasses, imageToRgba, type RosImage } from "../core/image";
import { BlobReadable } from "../core/readable";
import type { Analysis } from "../core/types";
import type { DecodedMessage, RenderOptions, Request, Response } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

let opened: OpenedRecording | undefined;
let analysis: Analysis | undefined;
const decoders = new Map<string, { decoder: Decoder; schemaName: string; channelId: number }>();

/** LRU of decoded messages, bounded by an approximate byte budget. */
class Lru {
  #map = new Map<string, { value: DecodedMessage; bytes: number }>();
  #bytes = 0;
  constructor(private readonly budget: number) {}
  get(k: string) {
    const e = this.#map.get(k);
    if (!e) return undefined;
    this.#map.delete(k);
    this.#map.set(k, e);
    return e.value;
  }
  set(k: string, value: DecodedMessage, bytes: number) {
    if (this.#map.has(k)) return;
    this.#map.set(k, { value, bytes });
    this.#bytes += bytes;
    while (this.#bytes > this.budget && this.#map.size > 1) {
      const [key, e] = this.#map.entries().next().value as [string, { bytes: number }];
      this.#map.delete(key);
      this.#bytes -= e.bytes;
    }
  }
  clear() {
    this.#map.clear();
    this.#bytes = 0;
  }
}
const cache = new Lru(400 << 20);

const post = (r: Response, transfer: Transferable[] = []) => self.postMessage(r, transfer);

function topicData(topic: string) {
  const t = analysis?.topics.find((x) => x.topic === topic);
  if (!t) throw new Error(`Unknown topic: ${topic}`);
  return t;
}

/**
 * Raw-message cache. McapIndexedReader decompresses a whole chunk for every
 * readMessages() call, so serving each panel (and each prefetch) separately would
 * decompress the same chunk many times. Instead, the first request for a moment loads
 * every message of the chunk(s) covering it, for all channels, into this map:
 * key "channelId:logTime" → messages with that log time (in file order).
 * Overwriting a key with a freshly loaded range is always complete, because a key lies
 * entirely inside any time range that contains its log time.
 */
const rawByKey = new Map<string, Uint8Array[]>();
const loadedRanges: Array<{ keys: string[]; bytes: number }> = [];
const inflightRanges = new Map<string, Promise<void>>();
let rawBytes = 0;
const RAW_BUDGET = 300 << 20;

/** The parts of the opened recording (a single file is one part with identity channel ids). */
function partsOf(rec: OpenedRecording): PartRef[] {
  return rec.parts ?? [{ name: "", rec, chan: new Map([...rec.channels.keys()].map((id) => [id, id])) }];
}

async function loadRangeAround(part: PartRef, abs: bigint): Promise<void> {
  const reader = part.rec.reader!;
  const cis = reader.chunkIndexes.filter((c) => c.messageStartTime <= abs && abs <= c.messageEndTime);
  if (!cis.length) return;
  let lo = cis[0].messageStartTime, hi = cis[0].messageEndTime;
  for (const c of cis) {
    if (c.messageStartTime < lo) lo = c.messageStartTime;
    if (c.messageEndTime > hi) hi = c.messageEndTime;
  }
  const rk = `${part.name}|${lo}-${hi}`;
  const pending = inflightRanges.get(rk);
  if (pending) return pending;
  const job = (async () => {
    const fresh = new Map<string, Uint8Array[]>();
    let bytes = 0;
    for await (const m of reader.readMessages({ startTime: lo, endTime: hi })) {
      const id = part.chan.get(m.channelId);
      if (id === undefined) continue;
      const key = `${id}:${m.logTime}`;
      const arr = fresh.get(key);
      if (arr) arr.push(m.data);
      else fresh.set(key, [m.data]);
      bytes += m.data.length;
    }
    for (const [k, v] of fresh) rawByKey.set(k, v);
    loadedRanges.push({ keys: [...fresh.keys()], bytes });
    rawBytes += bytes;
    while (rawBytes > RAW_BUDGET && loadedRanges.length > 1) {
      const old = loadedRanges.shift()!;
      for (const k of old.keys) rawByKey.delete(k);
      rawBytes -= old.bytes;
    }
  })();
  inflightRanges.set(rk, job);
  try {
    await job;
  } finally {
    inflightRanges.delete(rk);
  }
}


/** Reads the raw bytes of message #index of a topic. */
async function readRaw(topic: string, index: number): Promise<Uint8Array | undefined> {
  if (!opened || !analysis) return undefined;
  const t = topicData(topic);
  const rel = t.log[index];
  const abs = BigInt(analysis.startNs) + BigInt(Math.round(rel));
  // several messages can share one log time: take the right occurrence
  let occurrence = 0;
  for (let j = index - 1; j >= 0 && t.log[j] === rel; j--) occurrence++;
  const key = `${t.channelId}:${abs}`;
  let hit = rawByKey.get(key);
  if (hit && hit.length > occurrence) return hit[occurrence];
  const parts = partsOf(opened).filter((p) => [...p.chan.values()].includes(t.channelId));
  for (const p of parts) {
    if (p.rec.indexed && p.rec.reader) await loadRangeAround(p, abs);
    else if (p.rec.lazy) await loadLazyAround(p, abs);
  }
  return rawByKey.get(key)?.[occurrence];
}

/** Un-indexed / salvaged parts: decode the blocks whose time span contains `abs`. */
async function loadLazyAround(part: PartRef, abs: bigint): Promise<void> {
  const blocks = part.rec.lazy!.blocks.filter((b) => b.start <= abs && abs <= b.end);
  if (!blocks.length) return;
  const rk = `${part.name}|lazy|${blocks.map((b) => b.offset).join(",")}`;
  const pending = inflightRanges.get(rk);
  if (pending) return pending;
  const job = (async () => {
    const fresh = new Map<string, Uint8Array[]>();
    let bytes = 0;
    for (const b of blocks) {
      for (const m of await readBlock(part.rec, b)) {
        const id = part.chan.get(m.channelId);
        if (id === undefined) continue;
        const key = `${id}:${m.logTime}`;
        const arr = fresh.get(key);
        if (arr) arr.push(m.data);
        else fresh.set(key, [m.data]);
        bytes += m.data.length;
      }
    }
    // a key can span two blocks (same log time at a block border): merge, never drop
    for (const [k, v] of fresh) rawByKey.set(k, v);
    loadedRanges.push({ keys: [...fresh.keys()], bytes });
    rawBytes += bytes;
    while (rawBytes > RAW_BUDGET && loadedRanges.length > 1) {
      const old = loadedRanges.shift()!;
      for (const k of old.keys) rawByKey.delete(k);
      rawBytes -= old.bytes;
    }
  })();
  inflightRanges.set(rk, job);
  try {
    await job;
  } finally {
    inflightRanges.delete(rk);
  }
}

function decoderFor(topic: string) {
  let d = decoders.get(topic);
  if (!d && opened) {
    const ch = [...opened.channels.values()].find((c) => c.topic === topic)!;
    const schema = opened.schemas.get(ch.schemaId);
    d = { decoder: makeDecoder(ch, schema), schemaName: schema?.name ?? "", channelId: ch.id };
    decoders.set(topic, d);
  }
  return d!;
}

const renderKey = (r?: RenderOptions) => (r ? `${r.colormap ?? ""}:${r.range?.min ?? ""}:${r.range?.max ?? ""}:${r.classMap ?? ""}` : "");

async function getMessage(topic: string, index: number, render?: RenderOptions): Promise<DecodedMessage> {
  const key = `${topic}#${index}#${renderKey(render)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const t = topicData(topic);
  const d = decoderFor(topic);
  const out: DecodedMessage = { topic, index, logRel: t.log[index], schemaName: d.schemaName, msg: undefined };
  let bytes = 1024;
  try {
    const raw = await readRaw(topic, index);
    if (!raw) throw new Error("The message could not be read from the file");
    bytes += raw.length;
    out.msg = d.decoder(raw);
    const type = shortType(d.schemaName);
    if (type === "sensor_msgs/Image") {
      const img = out.msg as RosImage;
      const classes = render?.classMap === false ? 0 : classMapClasses(img);
      if (classes) out.classes = classes;
      out.rgba = imageToRgba(img, { ...render, classMap: classes > 0 });
      out.width = img.width;
      out.height = img.height;
      bytes += out.rgba.length;
    } else if (type === "sensor_msgs/CompressedImage") {
      const m = out.msg as { format: string; data: Uint8Array };
      const mime = /png/i.test(m.format) ? "image/png" : "image/jpeg";
      try {
        const bmp = await createImageBitmap(new Blob([m.data], { type: mime }));
        out.width = bmp.width;
        out.height = bmp.height;
        // a bitmap can only be transferred once → keep raw bytes in cache, re-create on demand
        out.bitmap = bmp;
      } catch {
        out.error = `Undecodable compressed image (format "${m.format}")`;
      }
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  if (!out.bitmap) cache.set(key, out, bytes);
  return out;
}

/** Extracts a numeric value at a dotted/indexed path, e.g. "linear_acceleration.z" or "data[3]". */
function pick(obj: unknown, path: string): number {
  let cur: any = obj;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === undefined || cur === null) return NaN;
    cur = cur[part];
  }
  if (typeof cur === "bigint") return Number(cur);
  if (typeof cur === "boolean") return cur ? 1 : 0;
  return typeof cur === "number" ? cur : NaN;
}

/** Interactive "get" requests in flight; background work (series, prefetch) yields to them. */
let activeGets = 0;
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));
async function yieldToInteractive() {
  await nextTask(); // let queued onmessage events start
  while (activeGets > 0) await new Promise<void>((r) => setTimeout(r, 4));
}

async function series(topic: string, path: string, maxPoints = 20000) {
  const t = topicData(topic);
  const d = decoderFor(topic);
  const n = t.count;
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const outT: number[] = [];
  const outV: number[] = [];
  if (opened && step === 1) {
    let i = 0;
    for await (const m of iterateAll(opened, [topic])) {
      try {
        outV.push(pick(d.decoder(m.data), path));
      } catch {
        outV.push(NaN);
      }
      outT.push(t.log[i++]);
      if (i % 64 === 0) await yieldToInteractive();
    }
  } else {
    for (let i = 0; i < n; i += step) {
      await yieldToInteractive();
      const m = await getMessage(topic, i);
      outT.push(t.log[i]);
      outV.push(pick(m.msg, path));
    }
  }
  return { t: Float64Array.from(outT), v: Float64Array.from(outV), truncated: step > 1 };
}

let prefetchQueue: Array<{ topic: string; index: number; render?: RenderOptions }> = [];
let prefetching = false;
async function runPrefetch() {
  if (prefetching) return;
  prefetching = true;
  while (prefetchQueue.length) {
    await yieldToInteractive();
    const p = prefetchQueue.shift();
    if (!p) break;
    try {
      await getMessage(p.topic, p.index, p.render);
    } catch {
      /* ignore */
    }
  }
  prefetching = false;
}

self.onmessage = async (ev: MessageEvent<Request>) => {
  const req = ev.data;
  try {
    switch (req.op) {
      case "open": {
        cache.clear();
        decoders.clear();
        rawByKey.clear();
        loadedRanges.length = 0;
        rawBytes = 0;
        const files = req.files?.length ? req.files : [req.file!];
        const res = await analyzeRecording(
          files.map((file) => ({
            name: file.name,
            size: file.size,
            readable: new BlobReadable(file),
            readSlice: async (s: number, e: number) => new Uint8Array(await file.slice(s, e).arrayBuffer()),
          })),
          { ranges: req.ranges, onProgress: (phase, fraction) => post({ id: req.id, op: "progress", phase, fraction }) },
        );
        opened = res.opened;
        analysis = res.analysis;
        post({ id: req.id, op: "opened", analysis: res.analysis });
        break;
      }
      case "get": {
        activeGets++;
        let message;
        try {
          message = await getMessage(req.topic, req.index, req.render);
        } finally {
          activeGets--;
        }
        const transfer: Transferable[] = [];
        let msgOut = message;
        if (message.bitmap) {
          // transfer a fresh copy so the next request can still create one
          msgOut = { ...message };
          transfer.push(message.bitmap);
        }
        post({ id: req.id, op: "message", message: msgOut }, transfer);
        if (req.prefetch && analysis) {
          const t = topicData(req.topic);
          prefetchQueue = prefetchQueue.filter((p) => p.topic !== req.topic);
          for (let k = 1; k <= req.prefetch && req.index + k < t.count; k++) prefetchQueue.push({ topic: req.topic, index: req.index + k, render: req.render });
          setTimeout(runPrefetch, 0);
        }
        break;
      }
      case "series": {
        const s = await series(req.topic, req.path, req.maxPoints);
        post({ id: req.id, op: "series", ...s }, [s.t.buffer, s.v.buffer]);
        break;
      }
      case "schemas": {
        const dec = new TextDecoder();
        post({ id: req.id, op: "schemas", schemas: [...(opened?.schemas.values() ?? [])].map((s) => ({ name: s.name, encoding: s.encoding, text: dec.decode(s.data) })) });
        break;
      }
    }
  } catch (err) {
    post({ id: req.id, op: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
