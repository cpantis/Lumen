/**
 * Which message of a topic is shown at a replay time, on either time base.
 *
 * Log base: the last message whose log time ≤ t.
 * Stamp base: messages are buffered and ordered by header.stamp, so a message that was
 * logged late appears at its stamp (not at its log time), and stamps that go backwards
 * still give the message with the latest stamp ≤ t.
 */
import { lastAtOrBefore } from "./sync";
import type { TopicData } from "./types";

export type TimeBase = "log" | "header";

const byStamp = new WeakMap<TopicData, { sorted: Float64Array; order: Int32Array }>();

/** Sorted stamps with the original message indices (stable for equal stamps). */
export function stampOrder(t: TopicData): { sorted: Float64Array; order: Int32Array } {
  let e = byStamp.get(t);
  if (!e) {
    const order = Int32Array.from({ length: t.count }, (_, i) => i).sort((a, b) => t.stamp[a] - t.stamp[b] || a - b);
    e = { sorted: Float64Array.from(order, (i) => t.stamp[i]), order };
    byStamp.set(t, e);
  }
  return e;
}

/** Index of the message shown at `time` (-1 before the first one). */
export function messageAt(t: TopicData, time: number, base: TimeBase): number {
  if (base === "header" && t.hasHeader) {
    const { sorted, order } = stampOrder(t);
    const k = lastAtOrBefore(sorted, time);
    return k < 0 ? -1 : order[k];
  }
  return lastAtOrBefore(t.log, time);
}

/** Time of message i on the base. */
export function timeOnBase(t: TopicData, i: number, base: TimeBase): number {
  return base === "header" && t.hasHeader ? t.stamp[i] : t.log[i];
}
