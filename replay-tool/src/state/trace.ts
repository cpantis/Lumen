/**
 * Traceability: every export carries the MCAP SHA-256, the app version (git commit),
 * the threshold profile and the estimated parameters in use, so anyone can reproduce
 * exactly the same image or report.
 */
import { app } from "./store";

declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;

export const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
export const GIT_COMMIT = typeof __GIT_COMMIT__ !== "undefined" ? __GIT_COMMIT__ : "dev";
export const TOOL_ID = `lumen-replay ${APP_VERSION} (${GIT_COMMIT})`;

export interface Trace {
  tool: string;
  file: string;
  sha256: string;
  profile: string;
  thresholds_hash: string;
  calibrations: Record<string, unknown>;
  speed_mps: number;
  generated_at: string;
}

function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function trace(): Trace {
  const s = app.get();
  return {
    tool: TOOL_ID,
    file: s.analysis?.fileName ?? "",
    sha256: s.analysis?.sha256 ?? "",
    profile: s.profile,
    thresholds_hash: hashText(s.thresholdsText),
    calibrations: s.calibrations,
    speed_mps: s.speedOverride ?? s.analysis?.motion.speedMps ?? NaN,
    generated_at: new Date().toISOString(),
  };
}

export function traceLine(): string {
  const t = trace();
  const cal = Object.keys(t.calibrations).length ? ` · calibrări: ${Object.entries(t.calibrations).map(([k, v]) => `${k}=${(v as { source: string }).source}`).join(", ")}` : "";
  return `${t.tool} · ${t.file} · SHA-256 ${t.sha256} · profil ${t.profile} (praguri #${t.thresholds_hash})${cal} · viteză ${t.speed_mps.toFixed(2)} m/s · ${t.generated_at}`;
}
