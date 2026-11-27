/**
 * Issue markers for the timeline, read from a JSON file (never hard-coded in components).
 *
 * Format (times in seconds from the first log time; or absolute ns with *_ns):
 *   { "issues": [ { "id": "ISSUE-1", "title": "…", "description": "…",
 *                   "start_s": 29.9, "end_s": 33.714, "jump_s": 33.7,
 *                   "clock": "log" | "header", "topics": ["/x/out"], "view": "replay" } ] }
 * Also accepted: a top-level list, and the keys start/end/t_start_s/t_end_s/window_s,
 * summary/name for the title, stamp_s for a single moment on the header.stamp clock.
 */
export interface IssueMarker {
  id: string;
  title: string;
  description: string;
  startNs: number;
  endNs: number;
  jumpNs: number;
  clock: "log" | "header";
  topics: string[];
  view?: string;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Parses issue markers; `startNs` = absolute first log time (to convert *_ns keys). */
export function parseIssues(text: string, startNs: bigint): { issues: IssueMarker[]; warnings: string[] } {
  const doc = JSON.parse(text) as unknown;
  const list: unknown[] = Array.isArray(doc) ? doc : Array.isArray((doc as { issues?: unknown[] })?.issues) ? (doc as { issues: unknown[] }).issues : [];
  if (!list.length) throw new Error('No "issues" list in the file');
  const warnings: string[] = [];
  const issues: IssueMarker[] = [];
  const relS = (o: Record<string, unknown>, keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = num(o[k]);
      if (v !== undefined) return k.endsWith("_ns") ? Number(BigInt(Math.round(v)) - startNs) : Math.round(v * 1e9);
    }
    return undefined;
  };
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    const win = Array.isArray(o.window_s) ? (o.window_s as unknown[]).map(num) : undefined;
    const stamp = relS(o, ["stamp_s", "stamp_ns"]);
    const start = relS(o, ["start_s", "t_start_s", "start", "start_ns", "t_start_ns"]) ?? (win?.[0] !== undefined ? Math.round(win[0]! * 1e9) : undefined) ?? stamp;
    const end = relS(o, ["end_s", "t_end_s", "end", "end_ns", "t_end_ns"]) ?? (win?.[1] !== undefined ? Math.round(win[1]! * 1e9) : undefined) ?? start;
    const id = String(o.id ?? o.name ?? `issue ${i + 1}`);
    if (start === undefined || end === undefined) {
      warnings.push(`${id}: skipped — no start time (start_s / window_s / stamp_s)`);
      return;
    }
    const clock = o.clock === "header" || o.clock === "stamp" || (stamp !== undefined && o.clock === undefined) ? "header" : "log";
    issues.push({
      id,
      title: String(o.title ?? o.summary ?? o.name ?? id),
      description: String(o.description ?? o.detail ?? ""),
      startNs: Math.min(start, end),
      endNs: Math.max(start, end),
      jumpNs: relS(o, ["jump_s", "jump_ns"]) ?? Math.min(start, end),
      clock,
      topics: Array.isArray(o.topics) ? (o.topics as unknown[]).map(String) : typeof o.topic === "string" ? [o.topic] : [],
      view: typeof o.view === "string" ? o.view : undefined,
    });
  });
  return { issues, warnings };
}
