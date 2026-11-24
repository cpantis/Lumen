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
import { deepLink, jumpTo, results } from "../state/actions";
import { app, clock, toast, uid, useApp, type Bug, type Note } from "../state/store";
import { traceLine } from "../state/trace";
import { snapshotPng } from "../export/snapshot";
import { fmt, Modal, Section } from "../ui/primitives";

const SEVERITIES: Bug["severity"][] = ["Blocker", "Critical", "Major", "Minor", "Trivial"];

/** Opens the bug editor pre-filled from the current moment / A–B interval. */
export async function openBugDraft(prefill: Partial<Bug> = {}): Promise<void> {
  const s = app.get();
  const a = s.analysis;
  if (!a) return;
  const hasAB = s.markA !== undefined && s.markB !== undefined;
  const startNs = prefill.startNs ?? (hasAB ? Math.min(s.markA!, s.markB!) : clock.get().t);
  const endNs = prefill.endNs ?? (hasAB ? Math.max(s.markA!, s.markB!) : startNs);
  // suggest the requirement violated closest to this moment (strict profile)
  const viol = results("strict", s).flatMap((r) => r.violations).filter((v) => v.endNs >= startNs - 2e8 && v.startNs <= endNs + 2e8);
  const v = viol[0];
  let images: Bug["images"] = [];
  if (s.view === "replay") {
    try {
      const png = await snapshotPng();
      if (png) images = [{ name: `replay-${(startNs / 1e9).toFixed(3)}s.png`, dataUrl: png }];
    } catch {
      /* snapshot optional */
    }
  }
  app.set({
    bugDraft: {
      title: v ? `${v.topic}: ${v.message}` : "",
      severity: "Major",
      severityWhy: "",
      requirement: v?.requirement ?? "",
      startNs,
      endNs,
      topics: v ? [v.topic] : [...new Set(s.panels.map((p) => p.topic))].slice(0, 4),
      measured: v ? `${fmt.n(v.measured, 3)} ${v.unit}` : "",
      expected: v ? `limită ${v.limit} ${v.unit}` : "",
      actual: v?.message ?? "",
      steps: "",
      images,
      ...prefill,
    },
  });
}

export function openNoteDraft(): void {
  const t = clock.get().t;
  app.set((s) => ({ notes: [...s.notes, { id: uid(), t, text: "", tag: "întrebare", priority: 2 }], view: "issues" }));
  toast(`Notă adăugată la ${(t / 1e9).toFixed(3)} s — completeaz-o în „Bug-uri & note”`);
}

export function bugMarkdown(b: Bug): string {
  const a = app.get().analysis!;
  const steps = b.steps || defaultSteps(b);
  return [
    `## ${b.title}`,
    "",
    `**Severitate:** ${b.severity} — ${b.severityWhy || "(justificare)"}  `,
    `**Cerință afectată:** ${b.requirement || "—"}  `,
    `**Unde:** ${fmt.s(b.startNs)} → ${fmt.s(b.endNs)} relativ (absolut ${(BigInt(a.startNs) + BigInt(Math.round(b.startNs))).toString()} → ${(BigInt(a.startNs) + BigInt(Math.round(b.endNs))).toString()} ns)  `,
    `**Topicuri:** ${b.topics.join(", ")}`,
    "",
    "### Dovezi",
    `- Valoare măsurată: ${b.measured || "—"}`,
    ...b.images.map((im) => `- ![${im.name}](${im.name})`),
    "",
    "### Pași de reproducere",
    steps,
    "",
    "### Așteptat vs. actual",
    `- **Așteptat:** ${b.expected || "—"}`,
    `- **Actual:** ${b.actual || "—"}`,
    "",
    `<sub>${traceLine()}</sub>`,
  ].join("\n");
}

function defaultSteps(b: Bug): string {
  const a = app.get().analysis!;
  return [
    `1. Deschide înregistrarea \`${a.fileName}\` (SHA-256 \`${a.sha256.slice(0, 16)}…\`) în .lumen Replay.`,
    `2. Link direct la moment: ${deepLink(b.startNs)}`,
    `3. Sau din linia de comandă: \`npm run metrics -- ${a.fileName} --out out/\` și caută \`${b.requirement || "cerința"}\` în \`out/report-strict.json\` la t ≈ ${(b.startNs / 1e9).toFixed(3)} s.`,
    `4. Observă topicurile ${b.topics.join(", ")} în intervalul ${fmt.s(b.startNs)} – ${fmt.s(b.endNs)}.`,
  ].join("\n");
}

export function BugEditor() {
  const draft = useApp((s) => s.bugDraft);
  const s = useApp((st) => st);
  if (!draft) return null;
  const set = (p: Partial<Bug>) => app.set({ bugDraft: { ...draft, ...p } });
  const reqs = s.thresholds?.requirements ?? [];
  const save = () => {
    const bug: Bug = {
      id: draft.id ?? uid(),
      title: draft.title || "(fără titlu)",
      severity: draft.severity ?? "Major",
      severityWhy: draft.severityWhy ?? "",
      requirement: draft.requirement ?? "",
      startNs: draft.startNs ?? 0,
      endNs: draft.endNs ?? draft.startNs ?? 0,
      topics: draft.topics ?? [],
      measured: draft.measured ?? "",
      expected: draft.expected ?? "",
      actual: draft.actual ?? "",
      steps: draft.steps || defaultSteps(draft as Bug),
      images: draft.images ?? [],
      createdAt: draft.createdAt ?? new Date().toISOString(),
    };
    app.set((st) => ({ bugs: [...st.bugs.filter((b) => b.id !== bug.id), bug], bugDraft: undefined }));
    toast("Bug salvat");
  };
  return (
    <Modal title={draft.id ? "Editează bug" : "Creează bug"} onClose={() => app.set({ bugDraft: undefined })} wide>
      <div className="grid-2">
        <label className="field" style={{ gridColumn: "1 / -1" }}>Titlu scurt și specific<input className="input" value={draft.title ?? ""} onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="field">Severitate<select className="input" value={draft.severity} onChange={(e) => set({ severity: e.target.value as Bug["severity"] })}>{SEVERITIES.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field">Cerința afectată<select className="input" value={draft.requirement} onChange={(e) => set({ requirement: e.target.value })}><option value="">—</option>{reqs.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.title}</option>)}</select></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>De ce această severitate<input className="input" value={draft.severityWhy ?? ""} onChange={(e) => set({ severityWhy: e.target.value })} placeholder="ex. utilizatorul parcurge 84 cm fără percepție nouă" /></label>
        <label className="field">Început (s, relativ)<input className="input mono" type="number" step={0.001} value={((draft.startNs ?? 0) / 1e9).toFixed(3)} onChange={(e) => set({ startNs: +e.target.value * 1e9 })} /></label>
        <label className="field">Sfârșit (s, relativ)<input className="input mono" type="number" step={0.001} value={((draft.endNs ?? 0) / 1e9).toFixed(3)} onChange={(e) => set({ endNs: +e.target.value * 1e9 })} /></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>Topicuri (separate prin virgulă)<input className="input mono" value={(draft.topics ?? []).join(", ")} onChange={(e) => set({ topics: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
        <label className="field">Valoare măsurată<input className="input" value={draft.measured ?? ""} onChange={(e) => set({ measured: e.target.value })} /></label>
        <label className="field">Așteptat<input className="input" value={draft.expected ?? ""} onChange={(e) => set({ expected: e.target.value })} /></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>Actual<input className="input" value={draft.actual ?? ""} onChange={(e) => set({ actual: e.target.value })} /></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>Pași de reproducere (gol = generați automat: deep-link + comandă CLI)<textarea className="input mono" value={draft.steps ?? ""} onChange={(e) => set({ steps: e.target.value })} placeholder={defaultSteps(draft as Bug)} /></label>
      </div>
      {(draft.images ?? []).length > 0 && (
        <div className="row wrap" style={{ marginTop: 12 }}>
          {draft.images!.map((im) => <img key={im.name} src={im.dataUrl} alt={`Captură ${im.name}`} style={{ maxWidth: 320, borderRadius: 8, border: "1px solid var(--border)" }} />)}
        </div>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn sm" onClick={async () => { const png = await snapshotPng(); if (png) set({ images: [...(draft.images ?? []), { name: `captura-${Date.now()}.png`, dataUrl: png }] }); }}>+ captură replay</button>
        <span className="spacer" />
        <button className="btn" onClick={() => app.set({ bugDraft: undefined })}>Renunță</button>
        <button className="btn primary" onClick={save}>Salvează bug</button>
      </div>
    </Modal>
  );
}

function autoAssumptions(): string[] {
  const s = app.get();
  const a = s.analysis!;
  const out = [
    `Viteza de mers: ${(s.speedOverride ?? a.motion.speedMps).toFixed(2)} m/s (${s.speedOverride ? "setată manual" : a.motion.method === "imu-steps" ? `estimată din IMU, lungime pas presupusă ${s.stepLengthM} m` : "presupusă — IMU neconcludent"}).`,
    `Un „gol” = interval > ${s.gapFactor} × perioada mediană a topicului.`,
    "Cauzalitatea se dovedește prin header.stamp identic + publicare cu > 2 ms după intrare; proximitatea temporală (ex. IMU) nu e considerată dovadă.",
    "Latența cap-coadă = log_time(ieșire) − header.stamp(intrare); presupune că log_time e ceasul recorderului și stamp-ul e momentul achiziției.",
    "Adâncimea 16UC1 e în milimetri, 32FC1 în metri (REP-118); valoarea 0 / NaN = fără date.",
    `Intervale plauzibile: ${JSON.stringify(s.thresholds?.plausible_ranges)}.`,
    "Cadre „identice” = același hash FNV-1a pe ≤ 4096 octeți eșantionați + lungime (coliziuni posibile, improbabile).",
  ];
  for (const [fov, c] of Object.entries(s.calibrations)) out.push(`Calibrare ${fov}: sursa ${c.source}. ${c.note ?? ""}`);
  for (const t of a.topics) if (s.roleOverrides[t.topic] && s.roleOverrides[t.topic] !== t.autoRole) out.push(`${t.topic} clasificat manual ca ${s.roleOverrides[t.topic]} (automat: ${t.autoRole}).`);
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
    const index: string[] = [`# Bug-uri — ${a.fileName}`, ""];
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
      "intrebari-note.md",
      [`# Întrebări și note — ${a.fileName}`, "", ...[...s.notes].sort((x, y) => x.priority - y.priority || x.t - y.t).map((n, i) => `${i + 1}. **[P${n.priority} · ${n.tag}]** ${n.text || "(fără text)"} — [${fmt.s(n.t)}](${deepLink(n.t)})`), "", "## Registrul de presupuneri", "", ...[...autoAssumptions(), ...s.manualAssumptions].map((x) => `- ${x}`), "", `<sub>${traceLine()}</sub>`].join("\n"),
      "text/markdown",
    );

  return (
    <div className="view" id="main-content">
      <div className="view-title">
        <h2>Bug-uri, note &amp; presupuneri</h2>
        <span className="sub">2.6 · raportare în format de bug tracker · 2.7 · întrebări pentru dezvoltator · „State your assumptions explicitly”</span>
      </div>
      <Section
        title={`Bug-uri (${s.bugs.length})`}
        actions={
          <div className="row">
            <button className="btn sm primary" onClick={() => openBugDraft()}><Plus size={14} /> Bug la momentul curent</button>
            <button className="btn sm" onClick={exportZip} disabled={!s.bugs.length}><Download size={14} /> ZIP (Markdown + imagini)</button>
          </div>
        }
      >
        {s.bugs.length === 0 && <p className="muted small">Niciun bug. Creează unul din bara de redare (buton „Bug”), dintr-o încălcare sau de aici.</p>}
        <div className="table-wrap" tabIndex={0}>
          <table className="t">
            <thead><tr><th>Severitate</th><th>Titlu</th><th>Cerință</th><th className="num">Când</th><th /></tr></thead>
            <tbody>
              {s.bugs.map((b) => (
                <tr key={b.id}>
                  <td><span className={`badge ${b.severity === "Blocker" || b.severity === "Critical" ? "error" : b.severity === "Major" ? "warn" : "neutral"}`}>{b.severity}</span></td>
                  <td>{b.title}</td>
                  <td className="mono">{b.requirement}</td>
                  <td className="num"><button className="btn sm ghost" onClick={() => jumpTo(b.startNs, b.topics)}>{fmt.s(b.startNs)}</button></td>
                  <td>
                    <div className="row">
                      <button className="btn sm" onClick={() => app.set({ bugDraft: b })}>editează</button>
                      <button className="btn sm" onClick={() => download(`${b.id}.md`, bugMarkdown(b), "text/markdown")}>.md</button>
                      <button className="btn sm icon ghost" aria-label="Șterge bug" onClick={() => confirm("Ștergi bug-ul?") && app.set((st) => ({ bugs: st.bugs.filter((x) => x.id !== b.id) }))}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title={`Note și întrebări (${s.notes.length})`}
        sub="Ancorate în timp; prioritate 1 = cea mai mare. Exportul produce lista ordonată pentru discuția cu dezvoltatorul."
        actions={
          <div className="row">
            <select className="input" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Filtru tag"><option value="">toate</option><option>întrebare</option><option>presupunere</option><option>anomalie</option><option>bookmark</option></select>
            <button className="btn sm" onClick={openNoteDraft}><Plus size={14} /> Notă la momentul curent</button>
            <button className="btn sm" onClick={exportNotes}><Download size={14} /> Markdown</button>
          </div>
        }
      >
        <div className="table-wrap" tabIndex={0}>
          <table className="t">
            <thead><tr><th className="num">Când</th><th>Tag</th><th>Prioritate</th><th>Text</th><th /></tr></thead>
            <tbody>
              {notes.map((n) => (
                <tr key={n.id}>
                  <td className="num"><button className="btn sm ghost" onClick={() => jumpTo(n.t)}>{fmt.s(n.t)}</button></td>
                  <td><select className="input" value={n.tag} onChange={(e) => setNote(n.id, { tag: e.target.value as Note["tag"] })} aria-label="Tag"><option>întrebare</option><option>presupunere</option><option>anomalie</option><option>bookmark</option></select></td>
                  <td><select className="input" value={n.priority} onChange={(e) => setNote(n.id, { priority: +e.target.value as Note["priority"] })} aria-label="Prioritate"><option value={1}>P1</option><option value={2}>P2</option><option value={3}>P3</option></select></td>
                  <td style={{ width: "60%" }}><input className="input" style={{ width: "100%" }} value={n.text} onChange={(e) => setNote(n.id, { text: e.target.value })} aria-label="Text notă" placeholder="De ce contează și ce ai face diferit în funcție de răspuns…" /></td>
                  <td><button className="btn sm icon ghost" aria-label="Șterge nota" onClick={() => app.set((st) => ({ notes: st.notes.filter((x) => x.id !== n.id) }))}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Registrul de presupuneri" sub="Actualizat automat cu tot ce a presupus aplicația; adaugă și presupunerile tale.">
        <ul className="small">
          {autoAssumptions().map((x) => <li key={x}>{x} <span className="badge neutral">automat</span></li>)}
          {s.manualAssumptions.map((x, i) => (
            <li key={i}>{x} <button className="btn sm ghost" onClick={() => app.set((st) => ({ manualAssumptions: st.manualAssumptions.filter((_, k) => k !== i) }))}>elimină</button></li>
          ))}
        </ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (newAssumption.trim()) { app.set((st) => ({ manualAssumptions: [...st.manualAssumptions, newAssumption.trim()] })); setNewAssumption(""); } }}>
          <input className="input" style={{ flex: 1 }} value={newAssumption} onChange={(e) => setNewAssumption(e.target.value)} placeholder="ex. Camerele nu sunt sincronizate hardware" aria-label="Presupunere nouă" />
          <button className="btn sm">Adaugă</button>
        </form>
      </Section>
    </div>
  );
}
