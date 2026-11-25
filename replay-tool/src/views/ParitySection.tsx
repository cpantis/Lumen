/**
 * Python test-suite metrics: per output its trigger, end-to-end and processing latency,
 * mean rate, largest interval and longest stall — with the definitions of the Python
 * suite (src/core/parity.ts) — and the import of the suite's requirement YAML files,
 * showing per requirement id the threshold next to the value measured here.
 * StampTrace issues no PASS/FAIL of record.
 */
import { Download, Upload } from "lucide-react";
import { useMemo } from "react";
import { download, toMarkdownTable } from "../core/inventory";
import { evaluatePyRequirements, parsePyRequirements } from "../core/pyreq";
import { jumpTo, parity } from "../state/actions";
import { app, toast, useApp } from "../state/store";
import { FileButton, Section } from "../ui/primitives";

const ms = (ns: number, d = 1) => (Number.isFinite(ns) ? (ns / 1e6).toFixed(d) : "—");

export function ParitySection() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const par = parity(s);
  const req = s.pyRequirements;
  const parsed = useMemo(() => {
    if (!req) return undefined;
    try {
      return parsePyRequirements(req.text);
    } catch (e) {
      return { requirements: [], warnings: [e instanceof Error ? e.message : String(e)] };
    }
  }, [req]);
  const rows = useMemo(() => (parsed ? evaluatePyRequirements(parsed.requirements, a.topics, par) : []), [parsed, a, par]);
  if (!par) return null;
  const metricsRows = par.outputs.map((o) => ({
    output: o.output,
    trigger: o.trigger ?? "—",
    e2e_p50_ms: ms(o.e2e.p50),
    e2e_p95_ms: ms(o.e2e.p95),
    e2e_max_ms: ms(o.e2e.max),
    proc_p95_ms: ms(o.processing.p95),
    rate_hz: Number.isFinite(o.intervals.meanHz) ? o.intervals.meanHz.toFixed(2) : "—",
    max_interval_ms: ms(o.intervals.maxNs),
    stall_s: o.stall?.missedFrames ? (o.stall.durationNs / 1e9).toFixed(2) : "—",
  }));

  return (
    <Section
      title="Python test-suite metrics"
      sub="Same definitions as the Python suite: e2e = log_time(output) − header.stamp(output); processing = log_time(output) − log_time(trigger, same stamp); percentiles with linear interpolation (numpy); rate = (n − 1) / (last − first unique stamp); longest stall on the trigger's frame grid, incl. recording start and end. Times from the first log time."
      actions={
        <div className="row wrap">
          <button className="btn sm" onClick={() => download(`python-metrics-${a.fileName}.md`, `${toMarkdownTable(metricsRows, Object.keys(metricsRows[0] ?? {}).map((k) => [k, k] as [string, string]))}\n\n${a.fileName} · SHA-256 ${a.sha256}\n`, "text/markdown")}>
            <Download size={14} /> Markdown
          </button>
          <FileButton accept=".yaml,.yml" onText={(text, name) => app.set({ pyRequirements: { name, text } })} tip="Import a requirement YAML file of the Python project (id, metric, statistic, operator, threshold per topic, unit)">
            <Upload size={14} /> Import requirement YAML
          </FileButton>
        </div>
      }
    >
      <div className="table-wrap" tabIndex={0}>
        <table className="t" data-testid="parity-table">
          <thead>
            <tr>
              <th>Output</th>
              <th>Trigger</th>
              <th className="num">e2e p50 ms</th>
              <th className="num">e2e p95 ms</th>
              <th className="num">e2e max ms</th>
              <th className="num">proc p95 ms</th>
              <th className="num">mean rate Hz</th>
              <th className="num">max interval ms</th>
              <th className="num">longest stall s</th>
            </tr>
          </thead>
          <tbody>
            {par.outputs.map((o, i) => (
              <tr key={o.output} data-output={o.output}>
                <td className="mono">{o.output}</td>
                <td className="mono small" data-tip={o.inference.reason}>
                  {o.trigger ?? "—"} <span className={`badge ${o.triggerSource === "override" ? "warn" : "neutral"}`}>{o.triggerSource === "override" ? "override" : o.trigger ? "inferred" : "none"}</span>
                </td>
                <td className="num">{metricsRows[i].e2e_p50_ms}</td>
                <td className="num">{metricsRows[i].e2e_p95_ms}</td>
                <td className="num">{metricsRows[i].e2e_max_ms}</td>
                <td className="num">{metricsRows[i].proc_p95_ms}</td>
                <td className="num">{metricsRows[i].rate_hz}</td>
                <td className="num">
                  {Number.isFinite(o.intervals.maxAtNs) ? (
                    <button className="btn sm ghost" onClick={() => jumpTo(o.intervals.maxAtNs + o.intervals.maxNs / 2, [o.output])} data-tip="Jump into this gap">{metricsRows[i].max_interval_ms}</button>
                  ) : "—"}
                </td>
                <td className="num">
                  {o.stall?.missedFrames ? (
                    <button className="btn sm ghost" onClick={() => jumpTo(o.stall!.startNs + o.stall!.durationNs / 2, [o.output, o.trigger!])} data-tip={`${o.stall.missedFrames} trigger frames without output, ${(o.stall.startNs / 1e9).toFixed(2)} – ${(o.stall.endNs / 1e9).toFixed(2)} s`}>{metricsRows[i].stall_s}</button>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {par.longestStall && (
        <p className="small" data-testid="longest-stall">
          Longest stall on the frame grid: <b>{(par.longestStall.durationNs / 1e9).toFixed(2)} s</b> ({par.longestStall.output}, {par.longestStall.missedFrames} trigger frames without output, {(par.longestStall.startNs / 1e9).toFixed(2)} – {(par.longestStall.endNs / 1e9).toFixed(2)} s).
        </p>
      )}
      <p className="xs muted">Triggers are inferred (drop propagation); change them in Inventory → Inferred settings.</p>

      {req && parsed && (
        <div style={{ marginTop: 16 }}>
          <h4 className="row">
            Requirements from {req.name}
            <span className="spacer" />
            <button className="btn sm ghost" onClick={() => app.set({ pyRequirements: undefined })}>remove</button>
          </h4>
          <div className="callout" role="note">
            Threshold of the Python project next to the value StampTrace measures with the same definition. This comparison is <b>informational</b>: StampTrace issues no PASS/FAIL of record — the verdict belongs to the Python test suite. Metrics StampTrace cannot compute are shown as “not computed here”, never estimated.
          </div>
          {parsed.warnings.map((w) => <div key={w} className="callout warn">{w}</div>)}
          <div className="table-wrap" tabIndex={0}>
            <table className="t" data-testid="pyreq-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Topic</th>
                  <th>Metric · statistic</th>
                  <th className="num">Threshold</th>
                  <th className="num">Measured here</th>
                  <th>Operator holds? (informational)</th>
                  <th>Definition</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.id}|${r.topic}`} data-id={r.id}>
                    <td className="mono">{r.id}</td>
                    <td className="mono small">{r.topic}</td>
                    <td className="small">{r.metric} · {r.statistic}</td>
                    <td className="num mono">{r.operator} {r.threshold} {r.unit}</td>
                    <td className="num mono">{r.measured !== undefined ? `${+r.measured.toFixed(4)} ${r.unit}` : <span className="muted">not computed here</span>}</td>
                    <td className="small">{r.satisfies === undefined ? <span className="muted">{r.notComputed}</span> : r.satisfies ? "yes" : "no"}</td>
                    <td className="xs muted">{r.definition ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => { download(`requirements-vs-stamptrace-${a.fileName}.json`, JSON.stringify({ file: a.fileName, sha256: a.sha256, files: a.files, requirements_file: req.name, note: "informational comparison; no PASS/FAIL of record", rows }, null, 2), "application/json"); toast("Comparison exported"); }}>
            <Download size={14} /> JSON
          </button>
        </div>
      )}
    </Section>
  );
}
