/**
 * sensor_msgs/PointCloud2 parsing into flat Float32Arrays.
 */

export interface PointField {
  name: string;
  offset: number;
  datatype: number; // 1 INT8 2 UINT8 3 INT16 4 UINT16 5 INT32 6 UINT32 7 FLOAT32 8 FLOAT64
  count: number;
}

export interface RosPointCloud2 {
  header?: { frame_id?: string };
  height: number;
  width: number;
  fields: PointField[];
  is_bigendian: boolean;
  point_step: number;
  row_step: number;
  data: Uint8Array;
  is_dense?: boolean;
}

export interface ParsedCloud {
  count: number;
  /** xyz interleaved, NaN for invalid points */
  positions: Float32Array;
  /** every scalar field by name (x, y, z, intensity, rgb, …) */
  fields: Record<string, Float32Array>;
  fieldNames: string[];
}

function readField(dv: DataView, off: number, type: number, le: boolean): number {
  switch (type) {
    case 1:
      return dv.getInt8(off);
    case 2:
      return dv.getUint8(off);
    case 3:
      return dv.getInt16(off, le);
    case 4:
      return dv.getUint16(off, le);
    case 5:
      return dv.getInt32(off, le);
    case 6:
      return dv.getUint32(off, le);
    case 7:
      return dv.getFloat32(off, le);
    case 8:
      return dv.getFloat64(off, le);
    default:
      return NaN;
  }
}

const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 4, 8: 8 };

/** Parses all points. Returns NaN positions when x/y/z fields are absent. */
export function parsePointCloud(pc: RosPointCloud2): ParsedCloud {
  const count = pc.width * pc.height;
  const dv = new DataView(pc.data.buffer, pc.data.byteOffset, pc.data.byteLength);
  const le = !pc.is_bigendian;
  const fields: Record<string, Float32Array> = {};
  const usable = pc.fields.filter((f) => SIZE[f.datatype] !== undefined);
  for (const f of usable) fields[f.name] = new Float32Array(count);
  const maxPoints = Math.min(count, Math.floor(pc.data.byteLength / Math.max(1, pc.point_step)));
  for (let r = 0; r < pc.height; r++) {
    for (let c = 0; c < pc.width; c++) {
      const i = r * pc.width + c;
      if (i >= maxPoints) break;
      const base = r * pc.row_step + c * pc.point_step;
      for (const f of usable) {
        const off = base + f.offset;
        fields[f.name][i] = off + SIZE[f.datatype] <= pc.data.byteLength ? readField(dv, off, f.datatype, le) : NaN;
      }
    }
  }
  const positions = new Float32Array(count * 3);
  const x = fields.x, y = fields.y, z = fields.z;
  for (let i = 0; i < count; i++) {
    positions[i * 3] = x ? x[i] : NaN;
    positions[i * 3 + 1] = y ? y[i] : NaN;
    positions[i * 3 + 2] = z ? z[i] : NaN;
  }
  return { count, positions, fields, fieldNames: usable.map((f) => f.name) };
}

/**
 * Per-point colour from an rgb/rgba field (PCL packed 0x00RRGGBB, stored as FLOAT32 or
 * UINT32): the raw 32 bits are reinterpreted, never converted. undefined without such a field.
 */
export function cloudRgb(pc: RosPointCloud2, fieldName?: string): Uint8Array | undefined {
  const f = pc.fields.find((x) => (fieldName ? x.name === fieldName : /^rgba?$/i.test(x.name)));
  if (!f || (SIZE[f.datatype] ?? 0) !== 4) return undefined;
  const count = pc.width * pc.height;
  const dv = new DataView(pc.data.buffer, pc.data.byteOffset, pc.data.byteLength);
  const le = !pc.is_bigendian;
  const out = new Uint8Array(count * 3);
  for (let r = 0; r < pc.height; r++) {
    for (let c = 0; c < pc.width; c++) {
      const i = r * pc.width + c;
      const off = r * pc.row_step + c * pc.point_step + f.offset;
      if (off + 4 > pc.data.byteLength) continue;
      const v = dv.getUint32(off, le);
      out[i * 3] = (v >>> 16) & 255;
      out[i * 3 + 1] = (v >>> 8) & 255;
      out[i * 3 + 2] = v & 255;
    }
  }
  return out;
}
