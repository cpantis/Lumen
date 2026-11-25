/**
 * Causality & latency (2.2): I/O diagram inferred from stamp evidence (SVG + Mermaid),
 * latency distribution per input→output pair (p50/p90/p95/p99/max, histogram, over
 * time), dropped input frames, A/B measurement tool, and the requirements draft.
 */
import { features } from "../state/features";
import { Copy, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { layoutDiagram, mermaidDiagram } from "../core/diagram";
import { download, toMarkdownTable } from "../core/inventory";
import { dumpThresholds, regenerateDerived } from "../core/requirements";
import { histogram, summarize } from "../core/stats";
import { lastAtOrBefore } from "../core/sync";
import { effectiveFov, effectiveRole, jumpTo, roles, setThresholdsText, topicColor } from "../state/actions";
import { app, toast, useApp } from "../state/store";
import { traceLine } from "../state/trace";
import { Plot } from "../ui/Plot";
import { fmt, Kv, Section, Stat } from "../ui/primitives";
import { tr } from "../i18n";
import { ParitySection } from "./ParitySection";

function Diagram() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const L = useMemo(() => layoutDiagram(a, (t) => effectiveRole(t, s), (t) => effectiveFov(t, s)), [a, s.roleOverrides, s.fovOverrides]); // eslint-disable-line react-hooks/exhaustive-deps
  const nodeW = 280, nodeH = 46;
  const color = (topic: string) => {
    const t = a.topics.find((x) => x.topic === topic)!;
    return topicColor(t, s);
  };
  return (
    <svg className="diagram" viewBox={`0 0 ${L.width} ${L.height}`} width="100%" role="img" aria-label={tr("Diagrama I/O a componentei, dedusă din potrivirea header.stamp")} style={{ maxHeight: 640 }}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--text-muted)" />
        </marker>
      </defs>
      {L.edges.map(({ from, to, edge }, i) => {
        const x1 = from.x + nodeW, y1 = from.y + nodeH / 2;
        const cx = L.component.x, cy = L.component.y + L.component.h / 2;
        const x2 = to.x, y2 = to.y + nodeH / 2;
        return (
          <g key={i}>
            <path d={`M${x1},${y1} C${x1 + 60},${y1} ${cx - 60},${cy} ${cx},${cy}`} fill="none" stroke="var(--border-strong)" strokeWidth={1.2} strokeDasharray={edge.kind === "exact" ? undefined : "5 4"} />
            <path d={`M${cx + L.component.w},${cy} C${cx + L.component.w + 60},${cy} ${x2 - 60},${y2} ${x2},${y2}`} fill="none" stroke={color(to.topic)} strokeWidth={1.6} markerEnd="url(#arrow)" />
            <text x={x2 - 8} y={y2 - 6} fontSize={10} textAnchor="end" fill="var(--text-muted)">
              {(edge.matchRate * 100).toFixed(0)}% · p50 {(edge.latencySummary.p50 / 1e6).toFixed(0)} ms
            </text>
          </g>
        );
      })}
      <rect x={L.component.x} y={L.component.y} width={L.component.w} height={L.component.h} rx={50} fill="var(--surface-2)" stroke="var(--accent)" strokeWidth={1.5} />
      <text x={L.component.x + L.component.w / 2} y={L.component.y + 44} textAnchor="middle" fontSize={14}>{tr("Componentă")}</text>
      <text x={L.component.x + L.component.w / 2} y={L.component.y + 64} textAnchor="middle" fontSize={11} fill="var(--text-muted)">{tr("(nedocumentată)")}</text>
      {L.nodes.map((n) => (
        <g key={n.topic} transform={`translate(${n.x},${n.y})`} style={{ cursor: "pointer" }} onClick={() => app.set({ view: "inventory" })}>
          <rect width={nodeW} height={nodeH} rx={8} fill="var(--surface)" stroke="var(--border-strong)" />
          <rect width={4} height={nodeH} rx={2} fill={color(n.topic)} />
          <text x={12} y={19} fontSize={12}>{n.label}</text>
          <text x={12} y={35} fontSize={10} fill="var(--text-muted)">{n.sub}{n.fov ? ` · FOV ${n.fov}` : ""}</text>
        </g>
      ))}
      <text x={20} y={20} fontSize={11} fill="var(--text-muted)">{tr("INTRĂRI")}</text>
      <text x={L.width - 300} y={20} fontSize={11} fill="var(--text-muted)">{tr("IEȘIRI (grupate pe FOV)")}</text>
    </svg>
  );
}

function ABTool() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  if (s.markA === undefined || s.markB === undefined)
    return <p className="muted small">{tr("Setează cursoarele A și B (butoanele A/B din bara de redare sau tastele A/B) pentru a măsura un interval.")}</p>;
  const lo = Math.min(s.markA, s.markB), hi = Math.max(s.markA, s.markB);
  const rowsAB = a.topics.map((t) => {
    const i0 = lastAtOrBefore(t.log, lo - 1) + 1;
    const i1 = lastAtOrBefore(t.log, hi);
    const n = Math.max(0, i1 - i0 + 1);
    return { topic: t.topic, count: n, hz: n > 1 ? ((n - 1) * 1e9) / (t.log[i1] - t.log[i0]) : NaN };
  });
  const text = [`A–B interval: ${fmt.s(lo)} → ${fmt.s(hi)} (Δt = ${fmt.ms(hi - lo)})`, ...rowsAB.map((r) => `${r.topic}: ${r.count} messages, ${fmt.hz(r.hz)}`), traceLine()].join("\n");
  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <Stat value={fmt.ms(hi - lo)} label={tr("Δt A–B")} />
        <span className="spacer" />
        <button className="btn sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast("Measurement copied"))}>
          <Copy size={14} /> {tr("Copiază ca text")}
        </button>
      </div>
      <div className="table-wrap" tabIndex={0} style={{ maxHeight: 260 }}>
        <table className="t">
          <thead><tr><th>{tr("Topic")}</th><th className="num">{tr("Mesaje în interval")}</th><th className="num">{tr("Frecvență în interval")}</th></tr></thead>
          <tbody>{rowsAB.map((r) => <tr key={r.topic}><td className="mono">{r.topic}</td><td className="num">{r.count}</td><td className="num">{fmt.hz(r.hz)}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function RequirementsDraft() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  if (!s.thresholds) return null;
  const proposed = regenerateDerived(a, s.thresholds, roles(s));
  const rows = proposed.requirements.map((r) => ({
    id: r.id,
    stmt: r.title,
    crit: Object.entries(r.derived).map(([k, v]) => `${k} = ${v}`).join(", "),
    strict: Object.entries(r.strict).map(([k, v]) => `${k} = ${v}`).join(", "),
    verif: r.verification,
    safety: r.safety ? "yes" : "no",
  }));
  const headers: Array<[string, string]> = [["id", "ID"], ["stmt", "Requirement"], ["crit", "Acceptance criterion (derived)"], ["strict", "Strict criterion"], ["verif", "Verification method"], ["safety", "Safety"]];
  return (
    <>
      <p className="muted small">{tr("Pragurile „derivate” sunt propuse din măsurători (ce face componenta azi, cu o marjă mică). Decizia finală aparține inginerului — aplică-le sau editează YAML-ul în „Cerințe & teste”.")}</p>
      <div className="table-wrap" tabIndex={0} style={{ maxHeight: 360 }}>
        <table className="t">
          <thead><tr>{headers.map(([, h]) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td>{r.stmt}</td><td className="mono small">{r.crit}</td><td className="mono small">{r.strict}</td><td className="small">{r.verif}</td><td>{r.safety}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => download("cerinte-ciorna.md", toMarkdownTable(rows, headers) + `\n\n<sub>${traceLine()}</sub>\n`, "text/markdown")}>
          <Download size={14} /> Markdown
        </button>
        <button className="btn sm" onClick={() => download("thresholds-propus.yaml", dumpThresholds(proposed), "text/yaml")}>
          <Download size={14} /> YAML
        </button>
        {features.requirements && (
          <button className="btn sm primary" onClick={() => { setThresholdsText(dumpThresholds(proposed)); toast("The proposed derived thresholds were applied"); }}>
            {tr("Aplică pragurile propuse")}
          </button>
        )}
      </div>
    </>
  );
}

export function CausalityView() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const exact = a.edges.filter((e) => e.kind === "exact");
  const [sel, setSel] = useState(0);
  const e = exact[Math.min(sel, Math.max(0, exact.length - 1))];
  const out = e ? a.topics.find((t) => t.topic === e.output)! : undefined;
  const inp = e ? a.topics.find((t) => t.topic === e.input)! : undefined;
  const latMs = useMemo(() => (e ? Array.from(e.latency, (v) => v / 1e6) : []), [e]);
  const logMs = useMemo(() => (e ? Array.from(e.latencyFromLog, (v) => v / 1e6) : []), [e]);
  const hist = useMemo(() => histogram(latMs, 50), [latMs]);
  const hx = useMemo(() => hist.edges.slice(0, -1).map((v, i) => (v + hist.edges[i + 1]) / 2), [hist]);
  const hs = useMemo(() => [{ label: "outputs", color: "var(--accent)", values: hist.counts }], [hist]);
  const ts = useMemo(() => [
    { label: "input stamp → output publication (ms)", color: "var(--accent)", values: latMs, points: true, width: 1 },
    { label: "input log → output log (ms)", color: "var(--accent-2)", values: logMs, width: 1 },
  ], [latMs, logMs]);
  const th = useMemo(() => (e ? [
    { value: e.latencySummary.p95 / 1e6, label: `p95 ${fmt.ms(e.latencySummary.p95)}`, color: "var(--warn)" },
    { value: e.latencySummary.p50 / 1e6, label: `p50 ${fmt.ms(e.latencySummary.p50)}`, color: "var(--text-muted)" },
  ] : []), [e]);

  return (
    <div className="view" id="main-content">
      <div className="view-title">
        <h2>{tr("Cauzalitate & latență")}</h2>
        <span className="sub">{tr("2.2 · ce intrări produc ce ieșiri — dovedit prin potrivirea exactă a header.stamp, nu presupus")}</span>
      </div>
      <Section
        title={tr("Diagrama I/O a componentei")}
        sub={tr("Săgeata înseamnă: ≥ 50 % din stamp-urile ieșirii sunt copiate exact din intrare, iar ieșirea e publicată după ea. Procentul = rata de potrivire; p50 = latența mediană.")}
        actions={
          <div className="row">
            <button className="btn sm" onClick={() => download("diagrama-io.mmd", mermaidDiagram(a, (t) => effectiveRole(t, s), (t) => effectiveFov(t, s)), "text/plain")}><Download size={14} /> Mermaid</button>
            <button className="btn sm" onClick={() => { const svg = document.querySelector(".diagram")?.outerHTML; if (svg) download("diagrama-io.svg", svg, "image/svg+xml"); }}><Download size={14} /> SVG</button>
          </div>
        }
      >
        {a.edges.length ? <Diagram /> : <div className="callout warn">{tr("Nicio ieșire nu copiază stamp-urile unei intrări: cauzalitatea nu poate fi dovedită din stamp-uri. Clasifică manual topicurile în Inventar.")}</div>}
      </Section>

      <ParitySection />
      <Section title={tr("Latență și cadre sărite, pe perechi intrare → ieșire")}>
        <div className="table-wrap" tabIndex={0} style={{ maxHeight: 300 }}>
          <table className="t">
            <thead>
              <tr><th>{tr("Intrare → ieșire")}</th><th className="num">{tr("Potrivire")}</th><th className="num">p50</th><th className="num">p90</th><th className="num">p95</th><th className="num">p99</th><th className="num">max</th><th className="num">{tr("Cadre sărite")}</th><th className="num">{tr("Secv. max")}</th><th className="num">{tr("Rată ieșire / intrare")}</th></tr>
            </thead>
            <tbody>
              {exact.map((x, i) => {
                const it = a.topics.find((t) => t.topic === x.input)!, ot = a.topics.find((t) => t.topic === x.output)!;
                return (
                  <tr key={i} className="clickable" aria-selected={i === sel} onClick={() => setSel(i)}>
                    <td className="mono small">{x.input} → {x.output}</td>
                    <td className="num">{fmt.pct(x.matchRate)}</td>
                    <td className="num">{fmt.ms(x.latencySummary.p50)}</td>
                    <td className="num">{fmt.ms(x.latencySummary.p90)}</td>
                    <td className="num">{fmt.ms(x.latencySummary.p95)}</td>
                    <td className="num">{fmt.ms(x.latencySummary.p99)}</td>
                    <td className="num">{fmt.ms(x.latencySummary.max)}</td>
                    <td className="num">{fmt.pct(x.dropRatio)}</td>
                    <td className="num">{Math.max(0, ...x.dropRuns.map((r) => r[2]))}</td>
                    <td className="num">{fmt.n(ot.rate.meanHz / it.rate.meanHz)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {e && out && inp && (
          <>
            <div className="callout" style={{ marginTop: 16 }}>
              <b>{tr("Definiția latenței afișate:")}</b> {tr("latență =")} <code>log_time(output) − header.stamp(exactly matched input)</code> {tr("— timpul de la achiziția cadrului până la publicarea rezultatului (cap-coadă). A doua curbă,")} <code>log_time(output) − log_time(input)</code>, excludes the input's transport. Measured on {e.matched} matched outputs out of {e.outputs}.
            </div>
            <div className="grid-2">
              <Plot x={hx} series={hs} bars height={200} xLabel={tr("latență (ms)")} title={tr("Distribuția latenței")} csvName="latenta_hist" />
              <Plot x={out.log} series={ts} time height={200} thresholds={th} title={tr("Latența în timp (click → salt)")} csvName="latenta_timp" />
            </div>
            <h4 style={{ marginTop: 16 }}>Runs of input frames without output ({e.droppedInputs.length} frames, {e.dropRuns.length} runs)</h4>
            <div className="row wrap">
              {[...e.dropRuns].sort((x, y) => y[2] - x[2]).slice(0, 30).map(([st, en, len], i) => (
                <button key={i} className="btn sm" onClick={() => jumpTo(st, [e.input, e.output])} data-tip={`${fmt.s(st)} → ${fmt.s(en)}`}>
                  {len} frames @ {fmt.s(st, 2)}
                </button>
              ))}
              {e.dropRuns.length === 0 && <span className="muted small">{tr("Niciun cadru sărit în intervalul activ al ieșirii.")}</span>}
            </div>
            <Kv items={[["input period (median)", fmt.ms(inp.rate.medianPeriodNs)], ["output period (median)", fmt.ms(out.rate.medianPeriodNs)], ["log→log latency (median)", fmt.ms(summarize(e.latencyFromLog).p50)]]} />
          </>
        )}
      </Section>

      <Section title={tr("Măsurare între cursoarele A și B")}>
        <ABTool />
      </Section>

      <Section title={tr("Ciornă de cerințe (din măsurători)")}>
        <RequirementsDraft />
      </Section>
    </div>
  );
}
