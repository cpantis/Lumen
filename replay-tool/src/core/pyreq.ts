/**
 * Requirement files of the Python test suite (YAML): per requirement an id, a metric,
 * a statistic, an operator, a threshold per topic and a unit. StampTrace shows, per id
 * and topic, the threshold next to the value StampTrace measures with the same
 * definition (src/core/parity.ts). It never issues a PASS/FAIL of record: the
 * comparison is informational, and a metric StampTrace cannot compute is shown as
 * "not computed here", never estimated.
 *
 * Accepted shapes (keys are case-insensitive):
 *   requirements: [ { id, metric, statistic, operator, unit, thresholds: { /topic: value } } ]
 *   [ { id, …, threshold: value, topic: /x } ]            (one topic)
 *   { REQ-1: { metric, …, thresholds: { … } } }           (map keyed by id)
 *   thresholds may also be a list: [ { topic, value } ]
 */
import yaml from "js-yaml";
import type { ParityReport } from "./parity";
import type { TopicData } from "./types";

export type Operator = "<" | "<=" | ">" | ">=" | "==" | "!=";

export interface PyRequirement {
  id: string;
  metric: string;
  statistic: string;
  operator: Operator;
  unit: string;
  thresholds: Array<{ topic: string; value: number }>;
  description?: string;
}

export interface PyReqRow {
  id: string;
  topic: string;
  metric: string;
  statistic: string;
  operator: Operator;
  unit: string;
  threshold: number;
  /** value measured by StampTrace in `unit`, or undefined when not computed here */
  measured?: number;
  /** why the value is not computed (metric unknown, topic absent, no trigger…) */
  notComputed?: string;
  /** definition used for the measured value */
  definition?: string;
  /** informational only: does the measured value satisfy the operator? */
  satisfies?: boolean;
}

const OPS: Record<string, Operator> = { "<": "<", "<=": "<=", "≤": "<=", ">": ">", ">=": ">=", "≥": ">=", "==": "==", "=": "==", "!=": "!=", lt: "<", le: "<=", lte: "<=", gt: ">", ge: ">=", gte: ">=", eq: "==", ne: "!=", max: "<=", min: ">=" };

function lowerKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
}

function thresholdsOf(r: Record<string, unknown>): Array<{ topic: string; value: number }> {
  const t = r.thresholds ?? r.threshold ?? r.per_topic ?? r.topics ?? r.limits ?? r.limit ?? r.value;
  const out: Array<{ topic: string; value: number }> = [];
  if (t && typeof t === "object" && !Array.isArray(t)) {
    for (const [topic, v] of Object.entries(t as Record<string, unknown>)) {
      const n = typeof v === "object" && v ? Number(lowerKeys(v as Record<string, unknown>).value ?? lowerKeys(v as Record<string, unknown>).threshold) : Number(v);
      out.push({ topic, value: n });
    }
  } else if (Array.isArray(t)) {
    for (const e of t) {
      if (e && typeof e === "object") {
        const l = lowerKeys(e as Record<string, unknown>);
        out.push({ topic: String(l.topic ?? ""), value: Number(l.value ?? l.threshold) });
      }
    }
  } else if (t !== undefined) {
    const topics = r.topic !== undefined ? [r.topic] : Array.isArray(r.topics) ? r.topics : [];
    for (const topic of topics) out.push({ topic: String(topic), value: Number(t) });
  }
  return out;
}

/** Parses a requirement YAML file; unreadable entries are reported in `warnings`. */
export function parsePyRequirements(text: string): { requirements: PyRequirement[]; warnings: string[] } {
  const doc = yaml.load(text) as unknown;
  const warnings: string[] = [];
  let list: Array<Record<string, unknown>> = [];
  if (Array.isArray(doc)) list = doc as Array<Record<string, unknown>>;
  else if (doc && typeof doc === "object") {
    const d = lowerKeys(doc as Record<string, unknown>);
    const r = d.requirements ?? d.reqs ?? d.checks;
    if (Array.isArray(r)) list = r as Array<Record<string, unknown>>;
    else if (r && typeof r === "object") list = Object.entries(r as Record<string, unknown>).map(([id, v]) => ({ id, ...(v as object) }));
    else list = Object.entries(doc as Record<string, unknown>).filter(([, v]) => v && typeof v === "object").map(([id, v]) => ({ id, ...(v as object) }));
  } else throw new Error("The file is not a YAML list or map of requirements.");
  const requirements: PyRequirement[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = lowerKeys(raw);
    const id = String(r.id ?? r.name ?? r.req ?? "");
    const metric = String(r.metric ?? r.measure ?? "").trim();
    const op = OPS[String(r.operator ?? r.op ?? r.comparison ?? "").trim().toLowerCase()];
    const thresholds = thresholdsOf(r).filter((t) => t.topic && Number.isFinite(t.value));
    if (!id || !metric || !op || !thresholds.length) {
      warnings.push(`${id || "(no id)"}: skipped — needs id, metric, operator and at least one numeric threshold per topic`);
      continue;
    }
    requirements.push({ id, metric, statistic: String(r.statistic ?? r.stat ?? r.aggregate ?? "value").trim(), operator: op, unit: String(r.unit ?? r.units ?? "").trim(), thresholds, description: r.description ? String(r.description) : undefined });
  }
  return { requirements, warnings };
}

type Kind = "time" | "rate" | "count";
const TIME_UNITS: Record<string, number> = { ns: 1, us: 1e3, µs: 1e3, ms: 1e6, s: 1e9, sec: 1e9 };

/** Canonical metric name StampTrace can compute, or undefined. */
export function canonicalMetric(m: string): "e2e_latency" | "processing_latency" | "rate" | "interval" | "stall" | "count" | undefined {
  const k = m.toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(e2e|end_to_end|endtoend)(_latency)?$|^latency(_e2e)?$/.test(k)) return "e2e_latency";
  if (/^(proc|processing)(_latency)?$|^latency_proc(essing)?$/.test(k)) return "processing_latency";
  if (/^(mean_)?(rate|frequency|freq|hz|publish_rate|output_rate)$/.test(k)) return "rate";
  if (/^(stamp_)?(interval|period|inter_?arrival|gap|max_interval|max_gap)$/.test(k)) return "interval";
  if (/^(longest_)?stall$/.test(k)) return "stall";
  if (/^(message_)?count$|^messages$/.test(k)) return "count";
  return undefined;
}

function compare(v: number, op: Operator, t: number): boolean {
  switch (op) {
    case "<": return v < t;
    case "<=": return v <= t;
    case ">": return v > t;
    case ">=": return v >= t;
    case "==": return v === t;
    case "!=": return v !== t;
  }
}

/** Threshold vs measured value per requirement id and topic. */
export function evaluatePyRequirements(reqs: PyRequirement[], topics: TopicData[], parity: ParityReport | undefined): PyReqRow[] {
  const rows: PyReqRow[] = [];
  for (const r of reqs) {
    const metric = canonicalMetric(r.metric);
    const stat = r.statistic.toLowerCase().replace(/^percentile_?/, "p").replace(/^median$/, "p50");
    for (const th of r.thresholds) {
      const row: PyReqRow = { id: r.id, topic: th.topic, metric: r.metric, statistic: r.statistic, operator: r.operator, unit: r.unit, threshold: th.value };
      rows.push(row);
      const t = topics.find((x) => x.topic === th.topic);
      if (!metric) {
        row.notComputed = `metric "${r.metric}" is not computed here`;
        continue;
      }
      if (!t) {
        row.notComputed = "topic not in this recording";
        continue;
      }
      const o = parity?.outputs.find((x) => x.output === th.topic);
      const kind: Kind = metric === "rate" ? "rate" : metric === "count" ? "count" : "time";
      let ns: number | undefined; // time metrics in ns
      let value: number | undefined; // rate in Hz / count
      if (metric === "e2e_latency" || metric === "processing_latency") {
        if (!o) {
          row.notComputed = "not an output (no latency is defined for an input)";
          continue;
        }
        if (metric === "processing_latency" && !o.trigger) {
          row.notComputed = "no trigger input for this output";
          continue;
        }
        const s = metric === "e2e_latency" ? o.e2e : o.processing;
        const pick: Record<string, number> = { p50: s.p50, p90: s.p90, p95: s.p95, p99: s.p99, max: s.max, min: s.min, mean: s.mean, std: s.std };
        ns = pick[stat];
        row.definition = metric === "e2e_latency" ? "log_time(output) − header.stamp(output)" : `log_time(output) − log_time(${o.trigger}, same stamp)`;
      } else if (metric === "interval") {
        const iv = o?.intervals;
        const s = iv ?? undefined;
        if (!s) {
          row.notComputed = "interval statistics are computed for outputs only";
          continue;
        }
        const pick: Record<string, number> = { p50: s.medianNs, p95: s.p95Ns, max: s.maxNs };
        ns = pick[stat === "value" ? "max" : stat];
        row.definition = "intervals of the sorted unique header.stamps";
      } else if (metric === "stall") {
        if (!o?.stall) {
          row.notComputed = "no trigger input for this output";
          continue;
        }
        if (stat !== "max" && stat !== "value") {
          row.notComputed = `statistic "${r.statistic}" of the stall is not computed here (only max)`;
          continue;
        }
        ns = o.stall.durationNs;
        row.definition = `longest run of ${o.trigger} frames without output, incl. recording start/end`;
      } else if (metric === "rate") {
        if (stat !== "mean" && stat !== "value" && stat !== "avg" && stat !== "average") {
          row.notComputed = `statistic "${r.statistic}" of the rate is not computed here (only mean)`;
          continue;
        }
        const iv = o?.intervals;
        value = iv ? iv.meanHz : undefined;
        if (value === undefined) {
          row.notComputed = "rates are computed for outputs only";
          continue;
        }
        row.definition = "(n − 1) / (last − first unique header.stamp)";
      } else if (metric === "count") {
        value = t.count;
        row.definition = "messages in the recording";
      }
      if (kind === "time") {
        if (ns === undefined) {
          row.notComputed = `statistic "${r.statistic}" is not computed here`;
          continue;
        }
        const f = TIME_UNITS[r.unit.toLowerCase()];
        if (!f) {
          row.notComputed = `unit "${r.unit}" is not a time unit`;
          continue;
        }
        row.measured = ns / f;
      } else if (kind === "rate") {
        if (!/^(hz|1\/s|fps)$/i.test(r.unit) && r.unit !== "") {
          row.notComputed = `unit "${r.unit}" is not a rate unit (Hz)`;
          continue;
        }
        row.measured = value;
      } else row.measured = value;
      if (row.measured !== undefined && !Number.isFinite(row.measured)) {
        row.notComputed = "no data to compute it in this recording";
        row.measured = undefined;
        continue;
      }
      if (row.measured !== undefined) row.satisfies = compare(row.measured, r.operator, th.value);
    }
  }
  return rows;
}
