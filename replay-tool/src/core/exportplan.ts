/**
 * Deterministic export plan (parity with the Python replay script):
 *  - video frames at a fixed step of *recording* time: frame k shows exactly the state at
 *    t = start + k / fps (default 30 frames per second of recording time), independent
 *    of how fast the machine renders;
 *  - the video plays at fps × speed frames per second (speed 2 → twice as fast);
 *  - snapshots are named replay_<t with 2 decimals, zero-padded to 6 chars>s.png;
 *  - suggested snapshot moments: the largest output gap and the largest latency.
 */
import type { ParityReport } from "./parity";
import type { Analysis } from "./types";

export interface VideoPlan {
  startNs: number;
  endNs: number;
  /** frames per second of recording time */
  fps: number;
  speed: number;
  /** frame rate of the encoded video = fps × speed */
  videoFps: number;
  /** recording time of every frame (ns, relative to the first log time) */
  times: number[];
}

export function planVideo(startNs: number, endNs: number, fps = 30, speed = 1): VideoPlan {
  if (!(fps > 0) || !(speed > 0)) throw new Error("fps and speed must be positive");
  const lo = Math.min(startNs, endNs), hi = Math.max(startNs, endNs);
  // integer frame index → exact times, no accumulated floating-point drift
  const n = Math.floor(((hi - lo) * fps) / 1e9 + 1e-9);
  const times = Array.from({ length: n + 1 }, (_, k) => lo + (k * 1e9) / fps);
  return { startNs: lo, endNs: hi, fps, speed, videoFps: fps * speed, times };
}

/** Presentation timestamp of frame k in the encoded video (µs). */
export const frameTimestampUs = (k: number, videoFps: number) => Math.round((k * 1e6) / videoFps);

/** replay_<t>s.png, t in seconds with 2 decimals, zero-padded to 6 characters. */
export function snapshotName(tNs: number): string {
  return `replay_${(tNs / 1e9).toFixed(2).padStart(6, "0")}s.png`;
}

/** Parses "1.5, 12, 30.25s" into ns times (invalid entries reported). */
export function parseTimeList(text: string): { times: number[]; invalid: string[] } {
  const times: number[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(-?\d+(?:\.\d+)?)(ms|s)?$/i.exec(raw);
    if (!m) invalid.push(raw);
    else times.push(Number(m[1]) * (m[2]?.toLowerCase() === "ms" ? 1e6 : 1e9));
  }
  return { times, invalid };
}

export interface Suggestion {
  tNs: number;
  label: string;
}

/** Suggested snapshot moments: inside the largest output gap, and at the largest end-to-end latency. */
export function suggestSnapshots(a: Analysis, parity: ParityReport | undefined): Suggestion[] {
  const out: Suggestion[] = [];
  let gap: { topic: string; at: number; d: number } | undefined;
  for (const o of parity?.outputs ?? []) {
    const iv = o.intervals;
    if (Number.isFinite(iv.maxNs) && (!gap || iv.maxNs > gap.d)) gap = { topic: o.output, at: iv.maxAtNs, d: iv.maxNs };
  }
  if (gap) out.push({ tNs: gap.at + gap.d / 2, label: `largest output gap: ${(gap.d / 1e6).toFixed(1)} ms on ${gap.topic} (middle of the gap)` });
  let lat: { topic: string; at: number; v: number } | undefined;
  for (const o of parity?.outputs ?? []) {
    const t = a.topics.find((x) => x.topic === o.output);
    if (!t?.hasHeader) continue;
    for (let j = 0; j < t.count; j++) {
      const v = t.log[j] - t.stamp[j];
      if (Number.isFinite(v) && (!lat || v > lat.v)) lat = { topic: t.topic, at: t.log[j], v };
    }
  }
  if (lat) out.push({ tNs: lat.at, label: `largest end-to-end latency: ${(lat.v / 1e6).toFixed(1)} ms on ${lat.topic} (when it is logged)` });
  return out;
}

/** Metadata carried by every export (video, snapshots, reports). */
export interface ExportMeta {
  tool: string;
  app_version: string;
  commit: string;
  files: Array<{ name: string; size: number; sha256: string }>;
  sha256: string;
  time_base: "log" | "header";
  fps?: number;
  interval_s?: [number, number];
  speed?: number;
  layout: unknown;
  overrides: unknown;
  generated_at: string;
}

/** summary.json of a video export (field names as in the Python tool). */
export interface VideoSummary extends ExportMeta {
  video: string;
  frames: number;
  fps: number;
  base: "log" | "header";
  render_s: number;
  video_fps: number;
  codec: string;
  container: "mp4" | "webm";
  note?: string;
}

/**
 * Inserts a tEXt chunk (keyword + text, Latin-1) right after the IHDR chunk of a PNG,
 * so the metadata travels inside the image itself.
 */
export function pngWithText(png: Uint8Array, keyword: string, text: string): Uint8Array {
  const sig = 8;
  const ihdrLen = new DataView(png.buffer, png.byteOffset + sig, 4).getUint32(0);
  const insertAt = sig + 12 + ihdrLen;
  const enc = (s: string) => Uint8Array.from(s, (c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63));
  const data = new Uint8Array([...enc(keyword), 0, ...enc(text)]);
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(enc("tEXt"), 4);
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(png.subarray(insertAt), insertAt + chunk.length);
  return out;
}

/** Reads the tEXt chunks of a PNG (keyword → text). */
export function pngTextChunks(png: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let off = 8; off + 12 <= png.length; ) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    if (type === "tEXt") {
      const d = png.subarray(off + 8, off + 8 + len);
      const z = d.indexOf(0);
      out[String.fromCharCode(...d.subarray(0, z))] = Array.from(d.subarray(z + 1), (b) => String.fromCharCode(b)).join("");
    }
    if (type === "IEND") break;
    off += 12 + len;
  }
  return out;
}

let CRC: Uint32Array | undefined;
function crc32(b: Uint8Array): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
