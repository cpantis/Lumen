/**
 * Requirements & tests (2.4): Derived / Strict profiles from one YAML source of truth,
 * PASS/FAIL per requirement with evidence and every violation (click → jump),
 * report import (markers on the timeline), report comparison, cross-validation of
 * metrics against external test scripts, exports.
 */
import { ChevronDown, ChevronRight, Download, RefreshCw, Upload } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { download, toMarkdownTable } from "../core/inventory";
import { buildMetrics, crossCheck, type CrossCheckRow, type MetricsFile } from "../core/metrics";
import { compareReports, dumpThresholds, parseReport, regenerateDerived, toReport, type TestReport } from "../core/requirements";
import { DEFAULT_THRESHOLDS_TEXT, jumpTo, results, roles, setThresholdsText } from "../state/actions";
import { app, toast, useApp } from "../state/store";
import { TOOL_ID, traceLine } from "../state/trace";
import { FileButton, fmt, Section, StatusBadge, verdictKind } from "../ui/primitives";

function ResultsTable({ profile }: { profile: "derived" | "strict" }) {
  const s = useApp((st) => st);
  const res = results(profile, s);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="table-wrap" tabIndex={0}>
      <table className="t">
        <thead>
          <tr><th /><th>ID</th><th>Cerință</th><th>Verdict</th><th>Siguranță</th><th>Parametri</th><th>Rezumat</th></tr>
        </thead>
        <tbody>
          {res.map((r) => (
            <Fragment key={r.id}>
              <tr className="clickable" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <td>
                  <button className="btn icon sm ghost" aria-expanded={open === r.id} aria-label={`Detalii ${r.id}`} onClick={(e) => (e.stopPropagation(), setOpen(open === r.id ? null : r.id))}>
                    {open === r.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                </td>
                <td className="mono">{r.id}</td>
                <td>{r.title}</td>
                <td><StatusBadge kind={verdictKind(r.verdict)} /></td>
                <td>{r.safety ? <span className="badge warn">siguranță</span> : <span className="muted small">util</span>}</td>
                <td className="mono small">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" ")}</td>
                <td className="small">{r.summary}</td>
              </tr>
              {open === r.id && (
                <tr>
                  <td />
                  <td colSpan={6}>
                    <p className="small"><b>Verificare:</b> {r.verification}<br /><b>Justificare:</b> {r.rationale}</p>
                    <table className="t" style={{ marginBottom: 12 }}>
                      <thead><tr><th>Topic / pereche</th><th>Verdict</th><th className="num">Măsurat</th><th className="num">Limită</th><th>Unitate</th><th>Notă</th></tr></thead>
                      <tbody>
                        {r.perTopic.map((p) => (
                          <tr key={p.topic}><td className="mono small">{p.topic}</td><td><StatusBadge kind={verdictKind(p.verdict)} /></td><td className="num">{fmt.n(p.measured, 3)}</td><td className="num">{fmt.n(p.limit, 3)}</td><td className="small">{p.unit}</td><td className="small">{p.note}</td></tr>
                        ))}
                      </tbody>
                    </table>
                    {r.violations.length > 0 && (
                      <>
                        <h4>Încălcări ({r.violations.length}) — click pentru salt în replay</h4>
                        <div className="table-wrap" tabIndex={0} style={{ maxHeight: 260 }}>
                          <table className="t">
                            <thead><tr><th>Unde</th><th>Topic</th><th className="num">Măsurat</th><th className="num">Limită</th><th>Cu cât / detalii</th></tr></thead>
                            <tbody>
                              {r.violations.slice(0, 500).map((v, i) => (
                                <tr key={i} className="clickable" onClick={() => jumpTo(v.startNs, [v.topic.split(" → ").pop()!])}>
                                  <td className="num">{fmt.s(v.startNs)}{v.endNs > v.startNs ? ` → ${fmt.s(v.endNs)}` : ""}</td>
                                  <td className="mono small">{v.topic}</td>
                                  <td className="num">{fmt.n(v.measured, 3)} {v.unit}</td>
                                  <td className="num">{fmt.n(v.limit, 3)}</td>
                                  <td className="small">{v.message}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareReports() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const options = useMemo(() => {
    const own: Array<{ name: string; report: TestReport }> = (["derived", "strict"] as const).map((p) => ({ name: `aplicație · ${p === "derived" ? "Derivat" : "Strict"}`, report: toReport(a, results(p, s), p, TOOL_ID) }));
    const imported = s.reports.filter((r) => Array.isArray((r.raw as TestReport)?.results)).map((r) => ({ name: `importat · ${r.name}`, report: r.raw as TestReport }));
    return [...own, ...imported];
  }, [a, s]);
  const [ia, setIa] = useState(0);
  const [ib, setIb] = useState(1);
  const diff = options[ia] && options[ib] ? compareReports(options[ia].report, options[ib].report) : [];
  return (
    <>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <select className="input" value={ia} onChange={(e) => setIa(+e.target.value)} aria-label="Raport A">{options.map((o, i) => <option key={i} value={i}>{o.name}</option>)}</select>
        <span>⇄</span>
        <select className="input" value={ib} onChange={(e) => setIb(+e.target.value)} aria-label="Raport B">{options.map((o, i) => <option key={i} value={i}>{o.name}</option>)}</select>
        <span className="muted small">{diff.filter((d) => d.changed).length} cerințe își schimbă verdictul</span>
      </div>
      <div className="table-wrap" tabIndex={0} style={{ maxHeight: 360 }}>
        <table className="t">
          <thead><tr><th>Cerință</th><th>Titlu</th><th>A</th><th>B</th><th>Schimbare</th></tr></thead>
          <tbody>
            {diff.map((d) => (
              <tr key={d.requirement} style={d.changed ? { outline: "1px solid var(--warn)" } : undefined}>
                <td className="mono">{d.requirement}</td>
                <td>{d.title}</td>
                <td>{d.a === "—" ? "—" : <StatusBadge kind={verdictKind(d.a)} />}</td>
                <td>{d.b === "—" ? "—" : <StatusBadge kind={verdictKind(d.b)} />}</td>
                <td>{d.changed ? <span className="badge warn">{d.a} → {d.b}</span> : <span className="muted small">identic</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CrossCheck() {
  const a = useApp((st) => st.analysis)!;
  const [rows, setRows] = useState<CrossCheckRow[]>();
  const [name, setName] = useState("");
  const [tol, setTol] = useState(1);
  const mine = useMemo(() => buildMetrics(a, TOOL_ID), [a]);
  return (
    <>
      <p className="muted small">
        Importă <code>metrics.json</code> produs de scripturile de test (același format ca <code>npm run metrics</code>). Aplicația compară fiecare metrică cu propriul calcul, în toleranța aleasă — dovada că aplicația și testele măsoară același lucru.
      </p>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <FileButton accept=".json" onText={(text, n) => { setRows(crossCheck(mine, JSON.parse(text) as MetricsFile, tol / 100)); setName(n); }} tip="Importă metrics.json al scripturilor de test">
          <Upload size={14} /> Importă metrics.json
        </FileButton>
        <button className="btn sm" onClick={() => download("metrics.json", JSON.stringify(mine, null, 2), "application/json")}><Download size={14} /> metrics.json (aplicație)</button>
        <label className="row small">toleranță relativă <input className="input mono" type="number" min={0} step={0.1} value={tol} onChange={(e) => setTol(+e.target.value)} style={{ width: 70 }} /> %</label>
        {rows && <span className={`badge ${rows.every((r) => r.ok) ? "ok" : "error"}`}>{rows.filter((r) => r.ok).length}/{rows.length} metrici concordă</span>}
      </div>
      {rows && (
        <div className="table-wrap" tabIndex={0} style={{ maxHeight: 360 }}>
          <table className="t">
            <thead><tr><th>Cheie</th><th>Metrică</th><th className="num">Aplicație</th><th className="num">{name}</th><th className="num">|Δ|</th><th>Stare</th></tr></thead>
            <tbody>
              {[...rows].sort((x, y) => Number(x.ok) - Number(y.ok)).map((r, i) => (
                <tr key={i}><td className="mono small">{r.key}</td><td className="mono small">{r.metric}</td><td className="num">{r.app ?? "—"}</td><td className="num">{r.other ?? "—"}</td><td className="num">{fmt.n(r.diff, 4)}</td><td><StatusBadge kind={r.ok ? "pass" : "fail"} label={r.ok ? "concordă" : "diferă"} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function RequirementsView() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const [editing, setEditing] = useState(false);
  const counts = (p: "derived" | "strict") => {
    const r = results(p, s);
    return { pass: r.filter((x) => x.verdict === "PASS").length, fail: r.filter((x) => x.verdict === "FAIL").length, na: r.filter((x) => x.verdict === "N/A").length };
  };
  const cd = counts("derived"), cs = counts("strict");
  const exportReport = (p: "derived" | "strict") => download(`report-${p}.json`, JSON.stringify({ ...toReport(a, results(p, s), p, TOOL_ID), trace: traceLine() }, null, 2), "application/json");
  const exportMd = () => {
    const lines = (["derived", "strict"] as const).flatMap((p) => [
      `### Profil ${p === "derived" ? "Derivat" : "Strict"}`,
      "",
      toMarkdownTable(results(p, s).map((r) => ({ id: r.id, title: r.title, verdict: r.verdict, safety: r.safety ? "da" : "nu", summary: r.summary })), [["id", "ID"], ["title", "Cerință"], ["verdict", "Verdict"], ["safety", "Siguranță"], ["summary", "Rezumat"]]),
      "",
    ]);
    download("rezultate-teste.md", [`## Rezultatele testelor — ${a.fileName}`, "", ...lines, `<sub>${traceLine()}</sub>`].join("\n"), "text/markdown");
  };

  return (
    <div className="view" id="main-content">
      <div className="view-title">
        <h2>Cerințe &amp; teste</h2>
        <span className="sub">2.4 · aceleași praguri ca scripturile de test (config/thresholds.yaml) — o singură sursă de adevăr</span>
      </div>
      <div className="grid-2" style={{ marginBottom: 16 }}>
        {(["derived", "strict"] as const).map((p) => {
          const c = p === "derived" ? cd : cs;
          return (
            <button key={p} className="card" style={{ textAlign: "left", cursor: "pointer", borderColor: s.profile === p ? "var(--accent)" : undefined, color: "inherit", font: "inherit" }} onClick={() => app.set({ profile: p })} aria-pressed={s.profile === p}>
              <div className="row"><h3 style={{ margin: 0 }}>Profil {p === "derived" ? "Derivat" : "Strict"}</h3><span className="spacer" />{s.profile === p && <span className="badge ok">activ</span>}</div>
              <p className="muted small">{p === "derived" ? "Ce face componenta azi (2.2)" : "Ce ar trebui să facă produsul final — justificat prin siguranța utilizatorului (2.5)"}</p>
              <div className="row"><StatusBadge kind="pass" label={`${c.pass} PASS`} /><StatusBadge kind="fail" label={`${c.fail} FAIL`} />{c.na > 0 && <StatusBadge kind="na" label={`${c.na} N/A`} />}</div>
            </button>
          );
        })}
      </div>
      <Section
        title={`Rezultate — profil ${s.profile === "derived" ? "Derivat" : "Strict"}`}
        sub="Încălcările sunt hașurate și pe timeline și pe graficele de calitate."
        actions={
          <div className="row wrap">
            <button className="btn sm" onClick={() => exportReport("derived")}><Download size={14} /> report-derived.json</button>
            <button className="btn sm" onClick={() => exportReport("strict")}><Download size={14} /> report-strict.json</button>
            <button className="btn sm" onClick={exportMd}><Download size={14} /> Markdown</button>
          </div>
        }
      >
        {s.thresholdsError && <div className="callout error">Fișier de praguri invalid: {s.thresholdsError}</div>}
        <ResultsTable profile={s.profile} />
      </Section>

      <Section
        title="Praguri (YAML)"
        sub="Editează direct; rezultatele se recalculează instantaneu. Exportă YAML-ul și pune-l înapoi în config/thresholds.yaml ca testele să folosească aceleași valori."
        actions={
          <div className="row wrap">
            <button className="btn sm" onClick={() => setEditing(!editing)}>{editing ? "Ascunde editorul" : "Editează"}</button>
            <button className="btn sm" onClick={() => { if (s.thresholds) { setThresholdsText(dumpThresholds(regenerateDerived(a, s.thresholds, roles(s)))); toast("Profil derivat regenerat din măsurători"); } }} data-tip="Recalculează pragurile derivate din ce măsoară această înregistrare">
              <RefreshCw size={14} /> Regenerează „derivat”
            </button>
            <FileButton accept=".yaml,.yml" onText={(t) => setThresholdsText(t)}><Upload size={14} /> Importă YAML</FileButton>
            <button className="btn sm" onClick={() => download("thresholds.yaml", s.thresholdsText, "text/yaml")}><Download size={14} /> Exportă YAML</button>
            <button className="btn sm ghost" onClick={() => setThresholdsText(DEFAULT_THRESHOLDS_TEXT)}>Implicit</button>
          </div>
        }
      >
        {editing && <textarea className="input mono" style={{ minHeight: 360, fontSize: 12 }} value={s.thresholdsText} onChange={(e) => setThresholdsText(e.target.value)} aria-label="Praguri YAML" spellCheck={false} />}
      </Section>

      <Section
        title="Rapoarte de test importate"
        sub='Format: listă de {"requirement","topic","t_start_ns","t_end_ns","measured","limit","message"} sau raportul complet al CLI-ului. Timpii pot fi absoluți (ns) sau relativi.'
        actions={
          <div className="row">
            <label className="row small"><input type="checkbox" checked={s.showReportMarkers} onChange={(e) => app.set({ showReportMarkers: e.target.checked })} /> markere pe timeline</label>
            <FileButton
              accept=".json"
              onText={(text, name) => {
                try {
                  const raw = JSON.parse(text);
                  const { meta, failures } = parseReport(raw, a.startNs);
                  app.set((st) => ({ reports: [...st.reports.filter((r) => r.name !== name), { name, report: meta, failures, raw }] }));
                  toast(`${failures.length} eșecuri importate din ${name}`);
                  if (meta.sha256 && meta.sha256 !== a.sha256) toast("Atenție: raportul a fost generat pentru alt fișier (SHA-256 diferit)");
                } catch (e) {
                  toast(`Raport invalid: ${e instanceof Error ? e.message : e}`);
                }
              }}
            >
              <Upload size={14} /> Importă raport
            </FileButton>
          </div>
        }
      >
        {s.reports.length === 0 && <p className="muted small">Niciun raport importat.</p>}
        {s.reports.map((r) => (
          <details key={r.name} style={{ marginBottom: 8 }}>
            <summary><b className="mono">{r.name}</b> · {r.failures.length} eșecuri {r.report.profile ? `· profil ${r.report.profile}` : ""} {r.report.sha256 && r.report.sha256 !== a.sha256 ? <span className="badge warn">alt fișier</span> : null}
              <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={(e) => { e.preventDefault(); app.set((st) => ({ reports: st.reports.filter((x) => x.name !== r.name) })); }}>elimină</button>
            </summary>
            <div className="table-wrap" tabIndex={0} style={{ maxHeight: 260, marginTop: 8 }}>
              <table className="t">
                <thead><tr><th>Unde</th><th>Cerință</th><th>Topic</th><th className="num">Măsurat</th><th className="num">Limită</th><th>Mesaj</th></tr></thead>
                <tbody>{r.failures.map((f, i) => <tr key={i} className="clickable" onClick={() => jumpTo(f.startNs, [f.topic])}><td className="num">{fmt.s(f.startNs)}</td><td className="mono">{f.requirement}</td><td className="mono small">{f.topic}</td><td className="num">{fmt.n(f.measured, 3)}</td><td className="num">{fmt.n(f.limit, 3)}</td><td className="small">{f.message}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        ))}
      </Section>

      <Section title="Comparație de rapoarte" sub="Ex. Derivat ⇄ Strict: ce cerințe trec din PASS în FAIL când pragurile devin cele ale produsului final.">
        <CompareReports />
      </Section>

      <Section title="Validare încrucișată aplicație ⇄ scripturi de test">
        <CrossCheck />
      </Section>
    </div>
  );
}
