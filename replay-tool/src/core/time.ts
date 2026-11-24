/**
 * Time helpers.
 *
 * MCAP timestamps are uint64 nanoseconds (bigint). Inside the app every per-message
 * time is stored as a float64 number of nanoseconds **relative to the recording start**
 * (`startNs`). A float64 represents integers exactly up to 2^53 ns ≈ 104 days, so the
 * relative values are exact for any realistic recording while staying fast to process
 * in typed arrays.
 */

export const NS_PER_MS = 1e6;
export const NS_PER_S = 1e9;

/** ROS 2 builtin_interfaces/Time as decoded by rosmsg2-serialization. */
export interface RosTime {
  sec: number;
  nanosec?: number;
  nsec?: number;
}

/** Converts a ROS time to absolute bigint nanoseconds. */
export function rosTimeToNs(t: RosTime): bigint {
  const ns = t.nanosec ?? t.nsec ?? 0;
  return BigInt(Math.trunc(t.sec)) * 1_000_000_000n + BigInt(Math.trunc(ns));
}

/** Absolute bigint → relative float ns. */
export function toRel(abs: bigint, startNs: bigint): number {
  return Number(abs - startNs);
}

/** Relative float ns → absolute bigint. */
export function toAbs(rel: number, startNs: bigint): bigint {
  return startNs + BigInt(Math.round(rel));
}

/** Formats relative ns as seconds, e.g. `12.345 s`. */
export function fmtRelS(rel: number, digits = 3): string {
  return `${(rel / NS_PER_S).toFixed(digits)} s`;
}

/** Formats a duration in ns with the most readable unit. */
export function fmtDuration(ns: number): string {
  if (!Number.isFinite(ns)) return "—";
  const a = Math.abs(ns);
  if (a >= NS_PER_S) return `${(ns / NS_PER_S).toFixed(3)} s`;
  if (a >= NS_PER_MS) return `${(ns / NS_PER_MS).toFixed(1)} ms`;
  if (a >= 1e3) return `${(ns / 1e3).toFixed(1)} µs`;
  return `${ns.toFixed(0)} ns`;
}

/** ISO-8601 UTC string with nanosecond precision. */
export function fmtUtcNs(abs: bigint): string {
  const ms = Number(abs / 1_000_000n);
  const sub = (abs % 1_000_000_000n).toString().padStart(9, "0");
  const iso = new Date(ms).toISOString(); // 2026-11-13T10:00:00.123Z
  return `${iso.slice(0, 19)}.${sub}Z`;
}

/** Parses "12.5", "12.5s", "1500ms" or a raw ns integer string into relative ns. */
export function parseTimeInput(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  const m = /^(-?\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s)?$/.exec(t);
  if (!m) return undefined;
  const v = parseFloat(m[1]);
  switch (m[2]) {
    case "ns":
      return v;
    case "us":
    case "µs":
      return v * 1e3;
    case "ms":
      return v * NS_PER_MS;
    default:
      return v * NS_PER_S;
  }
}
