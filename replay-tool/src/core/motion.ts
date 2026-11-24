/**
 * User motion context (2.5): estimates walking speed from the IMU by step detection.
 *
 * Method: |a| (m/s²) → remove the slow component (1 s moving average) → light
 * smoothing (0.1 s) → peaks above 0.6 m/s² that are ≥ 0.3 s apart are steps.
 * speed = cadence × step length (assumed 0.7 m, editable in the UI). When the IMU
 * is absent or the cadence is implausible, a speed of 1.4 m/s (typical adult
 * walking speed) is assumed and flagged as such.
 */
import type { MotionEstimate } from "./types";

export const DEFAULT_SPEED_MPS = 1.4;
export const DEFAULT_STEP_LENGTH_M = 0.7;

function movingAverage(x: Float64Array, t: Float64Array, windowNs: number): Float64Array {
  const out = new Float64Array(x.length);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    while (hi < x.length && t[hi] <= t[i] + windowNs / 2) sum += x[hi++];
    while (t[lo] < t[i] - windowNs / 2) sum -= x[lo++];
    out[i] = sum / Math.max(1, hi - lo);
  }
  return out;
}

export function estimateMotion(
  imu: { topic: string; t: Float64Array; accNorm: Float64Array } | undefined,
  stepLengthM = DEFAULT_STEP_LENGTH_M,
): MotionEstimate {
  const assumed = (note: string): MotionEstimate => ({
    method: "assumed",
    imuTopic: imu?.topic,
    stepTimes: [],
    cadenceHz: NaN,
    stepLengthM,
    speedMps: DEFAULT_SPEED_MPS,
    confidence: "low",
    note,
  });
  if (!imu || imu.t.length < 50) return assumed("IMU missing or too short: 1.4 m/s assumed (typical adult walking speed).");
  const x = imu.accNorm.map((v) => (Number.isFinite(v) ? v : 0));
  const base = movingAverage(x, imu.t, 1e9);
  const hp = x.map((v, i) => v - base[i]);
  const sm = movingAverage(hp, imu.t, 1e8);
  const steps: number[] = [];
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] > 0.6 && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) {
      if (!steps.length || imu.t[i] - steps[steps.length - 1] >= 3e8) steps.push(imu.t[i]);
    }
  }
  const dur = (imu.t[imu.t.length - 1] - imu.t[0]) / 1e9;
  const cadence = steps.length / Math.max(dur, 1e-9);
  if (steps.length < 10 || cadence < 0.8 || cadence > 3) {
    return assumed(`Step detection inconclusive (${steps.length} steps, ${cadence.toFixed(2)} steps/s): 1.4 m/s assumed.`);
  }
  const speed = cadence * stepLengthM;
  return {
    method: "imu-steps",
    imuTopic: imu.topic,
    stepTimes: steps,
    cadenceHz: cadence,
    stepLengthM,
    speedMps: speed,
    confidence: steps.length > 60 ? "high" : "medium",
    note: `${steps.length} steps detected from ${imu.topic} (cadence ${cadence.toFixed(2)} steps/s × assumed step length ${stepLengthM} m).`,
  };
}

/** Distance (m) walked during `ns` nanoseconds at `speedMps`. */
export function distanceM(ns: number, speedMps: number): number {
  return (ns / 1e9) * speedMps;
}

/** "180 ms ≈ 25 cm" style text. */
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return "—";
  return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`;
}
