/**
 * Inventory export (2.1) and generic CSV / Markdown helpers. The tables produced here
 * are meant to be pasted directly into the challenge document.
 */
import { NS_PER_MS } from "./time";
import type { Analysis, Role, TopicData } from "./types";

export interface InventoryRow {
  topic: string;
  type: string;
  encoding: string;
  details: string;
  frame: string;
  count: number;
  meanHz: string;
  medianHz: string;
  minHz: string;
  maxHz: string;
  jitterMs: string;
  maxGapMs: string;
  gaps: number;
  role: Role;
  reason: string;
  fov: string;
}

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

export function inventoryRows(a: Analysis, role: (t: TopicData) => Role, fov: (t: TopicData) => string | undefined, reason: (t: TopicData) => string): InventoryRow[] {
  return a.topics.map((t) => ({
    topic: t.topic,
    type: t.type,
    encoding: `${t.messageEncoding}/${t.schemaEncoding || "—"}`,
    details: Object.entries(t.details)
      .filter(([k]) => k !== "frame_id")
      .map(([k, v]) => `${k}: ${v}`)
      .join("; "),
    frame: t.frameIds.join(", ") || "—",
    count: t.count,
    meanHz: f(t.rate.meanHz),
    medianHz: f(t.rate.medianHz),
    minHz: f(t.rate.minHz),
    maxHz: f(t.rate.maxHz),
    jitterMs: f(t.rate.jitterNs / NS_PER_MS),
    maxGapMs: f(t.rate.maxGapNs / NS_PER_MS, 1),
    gaps: t.gaps.length,
    role: role(t),
    reason: reason(t),
    fov: fov(t) ?? "—",
  }));
}

const HEADERS: Array<[keyof InventoryRow, string]> = [
  ["topic", "Topic"],
  ["type", "Type"],
  ["encoding", "Encoding"],
  ["details", "Format"],
  ["frame", "frame_id"],
  ["count", "Messages"],
  ["meanHz", "Mean Hz"],
  ["medianHz", "Median Hz"],
  ["minHz", "Hz min"],
  ["maxHz", "Hz max"],
  ["jitterMs", "Jitter (ms)"],
  ["maxGapMs", "Max gap (ms)"],
  ["gaps", "Gaps"],
  ["role", "Role"],
  ["fov", "FOV"],
  ["reason", "Classification evidence"],
];

export function toCsv(rows: Array<Record<string, unknown>>, headers?: Array<[string, string]>): string {
  if (!rows.length) return "";
  const hs = headers ?? Object.keys(rows[0]).map((k) => [k, k] as [string, string]);
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [hs.map(([, h]) => esc(h)).join(","), ...rows.map((r) => hs.map(([k]) => esc(r[k])).join(","))].join("\n");
}

export function toMarkdownTable(rows: Array<Record<string, unknown>>, headers: Array<[string, string]>): string {
  const esc = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(([, h]) => h).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${headers.map(([k]) => esc(r[k])).join(" | ")} |`),
  ].join("\n");
}

export function inventoryCsv(rows: InventoryRow[]): string {
  return toCsv(rows as unknown as Array<Record<string, unknown>>, HEADERS as Array<[string, string]>);
}

export function inventoryMarkdown(a: Analysis, rows: InventoryRow[], trace: string): string {
  return [
    `### Recording inventory \`${a.fileName}\``,
    "",
    `Duration ${(a.durationNs / 1e9).toFixed(2)} s · ${a.topics.length} topics · ${a.topics.reduce((s, t) => s + t.count, 0)} messages · ${a.indexed ? "indexed" : "not indexed (sequential read)"}`,
    "",
    toMarkdownTable(rows as unknown as Array<Record<string, unknown>>, HEADERS as Array<[string, string]>),
    "",
    `<sub>${trace}</sub>`,
  ].join("\n");
}

/** Triggers a browser download (no-op outside the browser). */
export function download(name: string, data: BlobPart, mime = "text/plain;charset=utf-8"): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
