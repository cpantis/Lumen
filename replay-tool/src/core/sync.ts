/**
 * Synchronisation primitives: binary searches over sorted time arrays.
 *
 * All functions are O(log n) and operate on any array-like of numbers sorted ascending.
 */

export type NumArray = ArrayLike<number>;

/**
 * Index of the last element `<= t`, or -1 when every element is after `t`.
 * This is the core of the replay: each panel shows message `lastAtOrBefore(times, cursor)`.
 */
export function lastAtOrBefore(times: NumArray, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Index of the first element `> t`, or `times.length` if none. */
export function firstAfter(times: NumArray, t: number): number {
  return lastAtOrBefore(times, t) + 1;
}

/** Index of the first element `>= t`, or `times.length` if none. */
export function firstAtOrAfter(times: NumArray, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the element nearest to `t` (ties → earlier). -1 for empty arrays. */
export function nearest(times: NumArray, t: number): number {
  if (times.length === 0) return -1;
  const i = lastAtOrBefore(times, t);
  if (i < 0) return 0;
  if (i >= times.length - 1) return i;
  return t - times[i] <= times[i + 1] - t ? i : i + 1;
}

/**
 * Staleness level of a panel given the age of its message and the topic's nominal period.
 * ok: age ≤ 1.5·period, warn: ≤ 3·period, stale: older, none: no message yet.
 */
export type Staleness = "ok" | "warn" | "stale" | "none";
export function staleness(ageNs: number, periodNs: number): Staleness {
  if (!Number.isFinite(ageNs) || ageNs < 0) return "none";
  if (!Number.isFinite(periodNs) || periodNs <= 0) return "ok";
  if (ageNs <= 1.5 * periodNs) return "ok";
  if (ageNs <= 3 * periodNs) return "warn";
  return "stale";
}
