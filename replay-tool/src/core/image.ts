/**
 * sensor_msgs/Image conversion to RGBA for display, plus true per-pixel value access
 * (for the hover read-out, in the image's own units).
 *
 * Supported encodings: rgb8, rgba8, bgr8, bgra8, mono8, mono16, 8UC1, 8UC3, 16UC1,
 * 16SC1, 32FC1, bayer_*8 (raw luminance) and yuv422/uyvy/yuyv (luma only). Depth-like encodings are
 * colour-mapped between a configurable min/max.
 */

export interface RosImage {
  width: number;
  height: number;
  encoding: string;
  is_bigendian?: number;
  step: number;
  data: Uint8Array;
}

export type Colormap = "turbo" | "gray" | "viridis" | "inferno";

export interface DepthRange {
  min: number;
  max: number;
}

/** Number of channels and bytes per channel of an encoding, or undefined if unknown. */
export function encodingInfo(enc: string): { channels: number; bytes: number; float?: boolean; signed?: boolean } | undefined {
  const e = enc.toLowerCase();
  switch (e) {
    case "rgb8":
    case "bgr8":
    case "8uc3":
      return { channels: 3, bytes: 1 };
    case "rgba8":
    case "bgra8":
    case "8uc4":
      return { channels: 4, bytes: 1 };
    case "mono8":
    case "8uc1":
    case "bayer_rggb8":
    case "bayer_bggr8":
    case "bayer_gbrg8":
    case "bayer_grbg8":
      return { channels: 1, bytes: 1 };
    case "mono16":
    case "16uc1":
      return { channels: 1, bytes: 2 };
    case "16sc1":
      return { channels: 1, bytes: 2, signed: true };
    case "32fc1":
      return { channels: 1, bytes: 4, float: true };
    case "yuv422":
    case "uyvy":
    case "yuv422_yuy2":
    case "yuyv":
      return { channels: 2, bytes: 1 };
    default:
      return undefined;
  }
}

/** True for single-channel encodings carrying metric values (depth, disparity…). */
export function isDepthLike(enc: string): boolean {
  const e = enc.toLowerCase();
  return e === "16uc1" || e === "32fc1" || e === "mono16" || e === "16sc1";
}

/** Reads the scalar value of pixel (x, y), channel c, honouring endianness. */
export function pixelValue(img: RosImage, x: number, y: number, c = 0): number {
  const info = encodingInfo(img.encoding);
  if (!info) return NaN;
  const off = y * img.step + x * info.channels * info.bytes + c * info.bytes;
  const dv = new DataView(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  if (off + info.bytes > img.data.byteLength) return NaN;
  const le = !img.is_bigendian;
  if (info.bytes === 1) return img.data[off];
  if (info.bytes === 2) return info.signed ? dv.getInt16(off, le) : dv.getUint16(off, le);
  if (info.float) return dv.getFloat32(off, le);
  return NaN;
}

/**
 * Human-readable read-out for the hover tooltip. Depth unit from the encoding (REP-118:
 * 16UC1 = mm, 32FC1 = m) unless `unit` overrides it.
 */
export function pixelReadout(img: RosImage, x: number, y: number, unit?: "mm" | "m"): string {
  const info = encodingInfo(img.encoding);
  if (!info || x < 0 || y < 0 || x >= img.width || y >= img.height) return "";
  const e = img.encoding.toLowerCase();
  if (e === "16uc1" || e === "mono16" || e === "32fc1") {
    const v = pixelValue(img, x, y);
    const u = unit ?? (e === "16uc1" ? "mm" : e === "32fc1" ? "m" : undefined);
    if (!Number.isFinite(v)) return `${v}`;
    if (u === "mm") return `${v} mm (${(v / 1000).toFixed(3)} m)`;
    if (u === "m") return `${v.toFixed(3)} m`;
    return `${v}`;
  }
  const vals: number[] = [];
  for (let c = 0; c < info.channels; c++) vals.push(pixelValue(img, x, y, c));
  const names = e.startsWith("bgr") ? "BGRA" : e.startsWith("rgb") ? "RGBA" : "";
  return vals.map((v, i) => (names ? `${names[i]}=${v}` : `${v}`)).join(" ");
}

// --- colormaps (polynomial approximations, deterministic) -------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Google Turbo colormap (polynomial fit by A. Mikhailov). */
function turbo(t: number): [number, number, number] {
  const x = clamp01(t);
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [clamp01(r) * 255, clamp01(g) * 255, clamp01(b) * 255];
}
function viridis(t: number): [number, number, number] {
  const x = clamp01(t);
  const r = 0.277727 + x * (0.105093 + x * (-0.330861 + x * (-4.634230 + x * (6.228270 + x * (4.776384 - 5.435455 * x)))));
  const g = 0.005407 + x * (1.404613 + x * (0.214847 + x * (-5.799100 + x * (14.179934 + x * (-13.745145 + 4.645852 * x)))));
  const b = 0.334099 + x * (1.384590 + x * (0.095095 + x * (-19.332441 + x * (56.690553 + x * (-65.353033 + 26.312435 * x)))));
  return [clamp01(r) * 255, clamp01(g) * 255, clamp01(b) * 255];
}
function inferno(t: number): [number, number, number] {
  const x = clamp01(t);
  const r = 0.000218 + x * (0.106513 + x * (11.602493 + x * (-41.703996 + x * (77.162935 + x * (-71.319428 + 25.131126 * x)))));
  const g = 0.001651 + x * (0.563956 + x * (-3.972854 + x * (17.436398 + x * (-33.402359 + x * (32.626064 - 12.242669 * x)))));
  const b = -0.019480 + x * (3.932712 + x * (-15.942394 + x * (44.354145 + x * (-81.807309 + x * (73.209519 - 23.070328 * x)))));
  return [clamp01(r) * 255, clamp01(g) * 255, clamp01(b) * 255];
}

export function colormap(name: Colormap, t: number): [number, number, number] {
  switch (name) {
    case "gray":
      return [clamp01(t) * 255, clamp01(t) * 255, clamp01(t) * 255];
    case "viridis":
      return viridis(t);
    case "inferno":
      return inferno(t);
    default:
      return turbo(t);
  }
}

/** Automatic depth range: robust 2nd–98th percentile of valid (finite, > 0) samples. */
export function autoDepthRange(img: RosImage): DepthRange {
  const vals: number[] = [];
  const stepPx = Math.max(1, Math.floor((img.width * img.height) / 20000));
  for (let i = 0; i < img.width * img.height; i += stepPx) {
    const v = pixelValue(img, i % img.width, Math.floor(i / img.width));
    if (Number.isFinite(v) && v > 0) vals.push(v);
  }
  if (vals.length === 0) return { min: 0, max: 1 };
  vals.sort((a, b) => a - b);
  return { min: vals[Math.floor(vals.length * 0.02)], max: vals[Math.floor(vals.length * 0.98)] || vals[vals.length - 1] };
}

/** Max distinct values for an 8-bit single-channel image to be treated as a class (label) map. */
export const CLASS_MAP_MAX = 32;

/**
 * Class map detection: an 8-bit single-channel image with at most CLASS_MAP_MAX distinct
 * values is a label image (semantic segmentation), not a camera frame. Returns the
 * number of distinct values, or 0 when it is not a class map.
 */
export function classMapClasses(img: RosImage): number {
  const e = img.encoding.toLowerCase();
  if (!(e === "mono8" || e === "8uc1") || !img.width || !img.height || img.data.length < img.step * img.height) return 0;
  const seen = new Uint8Array(256);
  let n = 0;
  for (let y = 0; y < img.height; y++) {
    const row = y * img.step;
    for (let x = 0; x < img.width; x++) {
      const v = img.data[row + x];
      if (!seen[v]) {
        seen[v] = 1;
        if (++n > CLASS_MAP_MAX) return 0;
      }
    }
  }
  return n;
}

/** Deterministic categorical palette for class ids (id 0 dark grey). */
export function classColour(id: number): [number, number, number] {
  if (id === 0) return [40, 40, 40];
  const P: Array<[number, number, number]> = [
    [230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200], [245, 130, 48], [145, 30, 180], [70, 240, 240], [240, 50, 230],
    [210, 245, 60], [250, 190, 212], [0, 128, 128], [220, 190, 255], [170, 110, 40], [255, 250, 200], [128, 0, 0], [170, 255, 195],
    [128, 128, 0], [255, 215, 180], [0, 0, 128], [128, 128, 128],
  ];
  return P[(id - 1) % P.length];
}

/**
 * Converts a ROS image to RGBA bytes. Invalid depth (0, NaN) is rendered transparent
 * black so that "no data" is never confused with "near".
 */
export function imageToRgba(img: RosImage, opts: { colormap?: Colormap; range?: DepthRange; classMap?: boolean } = {}): Uint8ClampedArray {
  const { width: w, height: h } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  const e = img.encoding.toLowerCase();
  const info = encodingInfo(e);
  if (!info || w === 0 || h === 0 || img.data.length < img.step * h) return out;
  const d = img.data;
  if (opts.classMap) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = classColour(d[y * img.step + x]);
        const o = (y * w + x) * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 255;
      }
    }
    return out;
  }
  if (isDepthLike(e)) {
    const range = opts.range ?? autoDepthRange(img);
    const span = range.max - range.min || 1;
    const cm = opts.colormap ?? "turbo";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = pixelValue(img, x, y);
        const o = (y * w + x) * 4;
        if (!Number.isFinite(v) || v <= 0) {
          out[o + 3] = 255;
          continue;
        }
        const [r, g, b] = colormap(cm, (v - range.min) / span);
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 255;
      }
    }
    return out;
  }
  for (let y = 0; y < h; y++) {
    const row = y * img.step;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (e === "rgb8" || e === "8uc3") {
        const i = row + x * 3;
        out[o] = d[i];
        out[o + 1] = d[i + 1];
        out[o + 2] = d[i + 2];
      } else if (e === "bgr8") {
        const i = row + x * 3;
        out[o] = d[i + 2];
        out[o + 1] = d[i + 1];
        out[o + 2] = d[i];
      } else if (e === "rgba8" || e === "8uc4") {
        const i = row + x * 4;
        out[o] = d[i];
        out[o + 1] = d[i + 1];
        out[o + 2] = d[i + 2];
      } else if (e === "bgra8") {
        const i = row + x * 4;
        out[o] = d[i + 2];
        out[o + 1] = d[i + 1];
        out[o + 2] = d[i];
      } else if (e === "mono8" || e === "8uc1" || e.startsWith("bayer_")) {
        // Bayer mosaics are shown as raw luminance (no demosaicing — documented limitation)
        const v = d[row + x];
        out[o] = out[o + 1] = out[o + 2] = v;
      } else {
        // YUV 4:2:2 → luma only (best effort, documented limitation)
        const i = row + x * 2;
        const v = e === "uyvy" ? d[i + 1] : d[i];
        out[o] = out[o + 1] = out[o + 2] = v;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
