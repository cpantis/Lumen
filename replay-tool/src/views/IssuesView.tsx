/**
 * Bugs & notes (2.6 / 2.7): bug reports in bug-tracker format created from the
 * current moment or A–B interval (with snapshots, measured vs expected, steps to
 * reproduce = deep link + CLI command), time-anchored notes/questions with tags and
 * priority, and the assumptions register (automatic + manual). Exports: Markdown, ZIP.
 */
import { Download, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import JSZip from "jszip";
import { download } from "../core/inventory";
import { deepLink, jumpTo } from "../state/actions";
import { app, useApp, type Note } from "../state/store";
import { traceLine } from "../state/trace";
import { fmt, Section } from "../ui/primitives";
import { bugMarkdown, openBugDraft, openNoteDraft } from "./bugs";
import { tr } from "../i18n";

export { BugEditor, openBugDraft, openNoteDraft } from "./bugs";

function autoAssumptions(): string[] {
  const s = app.get();
  const a = s.analysis!;
  const out = [
    `Walking speed: ${(s.speedOverride ?? a.motion.speedMps).toFixed(2)} m/s (${s.speedOverride ? "set manually" : a.motion.method === "imu-steps" ? `estimated from the IMU, assumed step length ${s.stepLengthM} m` : "assumed — IMU inconclusive"}).`,
    `A "gap" = interval > ${s.gapFactor} × the topic's median period.`,
    "Causality is proven by an identical header.stamp + publication > 2 ms after the input; temporal proximity (e.g. IMU) is not considered evidence, nor are hardware-synchronised non-visual sensors.",
    "End-to-end latency = log_time(output) − header.stamp(input); assumes log_time is the recorder clock and the stamp is the acquisition time.",
    "16UC1 depth is in millimetres, 32FC1 in metres (REP-118); 0 / NaN = no data.",
    `Plausible ranges: ${JSON.stringify(s.thresholds?.plausible_ranges)}.`,
    "\"Identical\" frames = same FNV-1a hash over ≤ 4096 sampled bytes + length (collisions possible, unlikely).",
  ];
  for (const [fov, c] of Object.entries(s.calibrations)) out.push(`Calibration ${fov}: source ${c.source}. ${c.note ?? ""}`);
  for (const t of a.topics) if (s.roleOverrides[t.topic] && s.roleOverrides[t.topic] !== t.autoRole) out.push(`${t.topic} manually classified as ${s.roleOverrides[t.topic]} (automatic: ${t.autoRole}).`);
  return out;
}

export function IssuesView() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const [newAssumption, setNewAssumption] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const notes = [...s.notes].filter((n) => !tagFilter || n.tag === tagFilter).sort((x, y) => x.priority - y.priority || x.t - y.t);
  const setNote = (id: string, p: Partial<Note>) => app.set((st) => ({ notes: st.notes.map((n) => (n.id === id ? { ...n, ...p } : n)) }));

  const exportZip = async () => {
    const zip = new JSZip();
    const index: string[] = [`# Bugs — ${a.fileName}`, ""];
    for (const b of s.bugs) {
      const dir = zip.folder(b.id)!;
      dir.file("bug.md", bugMarkdown(b));
      for (const im of b.images) dir.file(im.name, im.dataUrl.split(",")[1], { base64: true });
      index.push(`- [${b.severity}] [${b.title}](${b.id}/bug.md)`);
    }
    index.push("", `<sub>${traceLine()}</sub>`);
    zip.file("README.md", index.join("\n"));
    download(`bugs-${a.fileName}.zip`, await zip.generateAsync({ type: "blob" }), "application/zip");
  };
  const exportNotes = () =>
    download(
      "questions-notes.md",
      [`# Questions and notes — ${a.fileName}`, "", ...[...s.notes].sort((x, y) => x.priority - y.priority || x.t - y.t).map((n, i) => `${i + 1}. **[P${n.priority} · ${n.tag}]** ${n.text || "(no text)"} — [${fmt.s(n.t)}](${deepLink(n.t)})`), "", "## Assumptions register", "", ...[...autoAssumptions(), ...s.manualAssumptions].map((x) => `- ${x}`), "", `<sub>${traceLine()}</sub>`].join("\n"),
      "text/markdown",
    );

  return (
    <div className="view" id="main-content">
      <div className="view-title">
        <h2>{tr("Bug-uri, note & presupuneri")}</h2>
        <span className="sub">{tr("2.6 · raportare în format de bug tracker · 2.7 · întrebări pentru dezvoltator · „State your assumptions explicitly”")}</span>
      </div>
      <Section
        title={`${tr("Bug-uri")} (${s.bugs.length})`}
        actions={
          <div className="row">
            <button className="btn sm primary" onClick={() => openBugDraft()}><Plus size={14} /> {tr("Bug la momentul curent")}</button>
            <button className="btn sm" onClick={exportZip} disabled={!s.bugs.length}><Download size={14} /> {tr("ZIP (Markdown + imagini)")}</button>
          </div>
        }
      >
        {s.bugs.length === 0 && <p className="muted small">{tr("Niciun bug. Creează unul din bara de redare (buton „Bug”), dintr-o încălcare sau de aici.")}</p>}
        <div className="table-wrap" tabIndex={0}>
          <table className="t">
            <thead><tr><th>{tr("Severitate")}</th><th>{tr("Titlu")}</th><th>{tr("Cerință")}</th><th className="num">{tr("Când")}</th><th /></tr></thead>
            <tbody>
              {s.bugs.map((b) => (
                <tr key={b.id}>
                  <td><span className={`badge ${b.severity === "Blocker" || b.severity === "Critical" ? "error" : b.severity === "Major" ? "warn" : "neutral"}`}>{b.severity}</span></td>
                  <td>{b.title}</td>
                  <td className="mono">{b.requirement}</td>
                  <td className="num"><button className="btn sm ghost" onClick={() => jumpTo(b.startNs, b.topics)}>{fmt.s(b.startNs)}</button></td>
                  <td>
                    <div className="row">
                      <button className="btn sm" onClick={() => app.set({ bugDraft: b })}>{tr("editează")}</button>
                      <button className="btn sm" onClick={() => download(`${b.id}.md`, bugMarkdown(b), "text/markdown")}>.md</button>
                      <button className="btn sm icon ghost" aria-label={tr("Șterge bug")} onClick={() => confirm("Delete this bug?") && app.set((st) => ({ bugs: st.bugs.filter((x) => x.id !== b.id) }))}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title={`${tr("Note și întrebări")} (${s.notes.length})`}
        sub={tr("Ancorate în timp; prioritate 1 = cea mai mare. Exportul produce lista ordonată pentru discuția cu dezvoltatorul.")}
        actions={
          <div className="row">
            <select className="input" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label={tr("Filtru tag")}><option value="">{tr("toate")}</option><option value="question">question</option><option value="assumption">assumption</option><option value="anomaly">anomaly</option><option value="bookmark">bookmark</option></select>
            <button className="btn sm" onClick={openNoteDraft}><Plus size={14} /> {tr("Notă la momentul curent")}</button>
            <button className="btn sm" onClick={exportNotes}><Download size={14} /> Markdown</button>
          </div>
        }
      >
        <div className="table-wrap" tabIndex={0}>
          <table className="t">
            <thead><tr><th className="num">{tr("Când")}</th><th>{tr("Tag")}</th><th>{tr("Prioritate")}</th><th>{tr("Text")}</th><th /></tr></thead>
            <tbody>
              {notes.map((n) => (
                <tr key={n.id}>
                  <td className="num"><button className="btn sm ghost" onClick={() => jumpTo(n.t)}>{fmt.s(n.t)}</button></td>
                  <td><select className="input" value={n.tag} onChange={(e) => setNote(n.id, { tag: e.target.value as Note["tag"] })} aria-label={tr("Tag")}><option value="question">question</option><option value="assumption">assumption</option><option value="anomaly">anomaly</option><option value="bookmark">bookmark</option></select></td>
                  <td><select className="input" value={n.priority} onChange={(e) => setNote(n.id, { priority: +e.target.value as Note["priority"] })} aria-label={tr("Prioritate")}><option value={1}>P1</option><option value={2}>P2</option><option value={3}>P3</option></select></td>
                  <td style={{ width: "60%" }}><input className="input" style={{ width: "100%" }} value={n.text} onChange={(e) => setNote(n.id, { text: e.target.value })} aria-label={tr("Text notă")} placeholder={tr("De ce contează și ce ai face diferit în funcție de răspuns…")} /></td>
                  <td><button className="btn sm icon ghost" aria-label={tr("Șterge nota")} onClick={() => app.set((st) => ({ notes: st.notes.filter((x) => x.id !== n.id) }))}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={tr("Registrul de presupuneri")} sub={tr("Actualizat automat cu tot ce a presupus aplicația; adaugă și presupunerile tale.")}>
        <ul className="small">
          {autoAssumptions().map((x) => <li key={x}>{x} <span className="badge neutral">{tr("automat")}</span></li>)}
          {s.manualAssumptions.map((x, i) => (
            <li key={i}>{x} <button className="btn sm ghost" onClick={() => app.set((st) => ({ manualAssumptions: st.manualAssumptions.filter((_, k) => k !== i) }))}>{tr("elimină")}</button></li>
          ))}
        </ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (newAssumption.trim()) { app.set((st) => ({ manualAssumptions: [...st.manualAssumptions, newAssumption.trim()] })); setNewAssumption(""); } }}>
          <input className="input" style={{ flex: 1 }} value={newAssumption} onChange={(e) => setNewAssumption(e.target.value)} placeholder={tr("ex. Camerele nu sunt sincronizate hardware")} aria-label={tr("Presupunere nouă")} />
          <button className="btn sm">{tr("Adaugă")}</button>
        </form>
      </Section>
    </div>
  );
}
