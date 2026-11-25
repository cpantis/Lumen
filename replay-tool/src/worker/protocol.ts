/** Messages exchanged between the UI thread and the analysis/decoding worker. */
import type { PlausibleRanges } from "../core/content";
import type { Analysis } from "../core/types";
import type { Colormap, DepthRange } from "../core/image";

export interface RenderOptions {
  colormap?: Colormap;
  range?: DepthRange;
}

export type Request =
  | { id: number; op: "open"; file?: File; files?: File[]; ranges?: PlausibleRanges }
  | { id: number; op: "get"; topic: string; index: number; render?: RenderOptions; prefetch?: number }
  | { id: number; op: "series"; topic: string; path: string; maxPoints?: number }
  | { id: number; op: "schemas" };

export interface DecodedMessage {
  topic: string;
  index: number;
  logRel: number;
  schemaName: string;
  /** decoded ROS message (typed arrays preserved) */
  msg: unknown;
  /** for sensor_msgs/Image: RGBA ready to draw */
  rgba?: Uint8ClampedArray;
  /** for sensor_msgs/CompressedImage: decoded bitmap */
  bitmap?: ImageBitmap;
  width?: number;
  height?: number;
  error?: string;
}

export type Response =
  | { id: number; op: "progress"; phase: string; fraction: number }
  | { id: number; op: "opened"; analysis: Analysis }
  | { id: number; op: "message"; message: DecodedMessage }
  | { id: number; op: "series"; t: Float64Array; v: Float64Array; truncated: boolean }
  | { id: number; op: "schemas"; schemas: Array<{ name: string; encoding: string; text: string }> }
  | { id: number; op: "error"; error: string };
