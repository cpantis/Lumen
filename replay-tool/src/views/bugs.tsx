/**
 * Bug reports (2.6): editor + creation from the current moment / A–B interval,
 * Markdown in bug-tracker format. Kept separate from IssuesView so the view can be
 * code-split while the transport bar and command palette can still create bugs.
 */
import { snapshotPng } from "../export/snapshot";
import { deepLink, results } from "../state/actions";
import { app, clock, toast, uid, useApp, type Bug } from "../state/store";
import { traceLine } from "../state/trace";
import { fmt, Modal } from "../ui/primitives";
import { tr } from "../i18n";

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
      expected: v ? `limit ${v.limit} ${v.unit}` : "",
      actual: v?.message ?? "",
      steps: "",
      images,
      ...prefill,
    },
  });
}

export function openNoteDraft(): void {
  const t = clock.get().t;
  app.set((s) => ({ notes: [...s.notes, { id: uid(), t, text: "", tag: "question", priority: 2 }], view: "issues" }));
  toast(`Note added at ${(t / 1e9).toFixed(3)} s — fill it in under "Bugs & notes"`);
}

export function bugMarkdown(b: Bug): string {
  const a = app.get().analysis!;
  const steps = b.steps || defaultSteps(b);
  return [
    `## ${b.title}`,
    "",
    `**Severity:** ${b.severity} — ${b.severityWhy || "(rationale)"}  `,
    `**Affected requirement:** ${b.requirement || "—"}  `,
    `**Where:** ${fmt.s(b.startNs)} → ${fmt.s(b.endNs)} relative (absolute ${(BigInt(a.startNs) + BigInt(Math.round(b.startNs))).toString()} → ${(BigInt(a.startNs) + BigInt(Math.round(b.endNs))).toString()} ns)  `,
    `**Topics:** ${b.topics.join(", ")}`,
    "",
    "### Evidence",
    `- Measured value: ${b.measured || "—"}`,
    ...b.images.map((im) => `- ![${im.name}](${im.name})`),
    "",
    "### Steps to reproduce",
    steps,
    "",
    "### Expected vs. actual",
    `- **Expected:** ${b.expected || "—"}`,
    `- **Actual:** ${b.actual || "—"}`,
    "",
    `<sub>${traceLine()}</sub>`,
  ].join("\n");
}

export function defaultSteps(b: Bug): string {
  const a = app.get().analysis!;
  return [
    `1. Open the recording \`${a.fileName}\` (SHA-256 \`${a.sha256.slice(0, 16)}…\`) in .lumen Replay.`,
    `2. Direct link to the moment: ${deepLink(b.startNs)}`,
    `3. Or from the command line: \`npm run metrics -- ${a.fileName} --out out/\` and look for \`${b.requirement || "the requirement"}\` in \`out/report-strict.json\` at t ≈ ${(b.startNs / 1e9).toFixed(3)} s.`,
    `4. Observe the topics ${b.topics.join(", ")} in the interval ${fmt.s(b.startNs)} – ${fmt.s(b.endNs)}.`,
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
      title: draft.title || "(untitled)",
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
    toast("Bug saved");
  };
  return (
    <Modal title={draft.id ? "Edit bug" : "Create bug"} onClose={() => app.set({ bugDraft: undefined })} wide>
      <div className="grid-2">
        <label className="field" style={{ gridColumn: "1 / -1" }}>{tr("Titlu scurt și specific")}<input className="input" value={draft.title ?? ""} onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="field">{tr("Severitate")}<select className="input" value={draft.severity} onChange={(e) => set({ severity: e.target.value as Bug["severity"] })}>{SEVERITIES.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field">{tr("Cerința afectată")}<select className="input" value={draft.requirement} onChange={(e) => set({ requirement: e.target.value })}><option value="">—</option>{reqs.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.title}</option>)}</select></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>{tr("De ce această severitate")}<input className="input" value={draft.severityWhy ?? ""} onChange={(e) => set({ severityWhy: e.target.value })} placeholder={tr("ex. utilizatorul parcurge 84 cm fără percepție nouă")} /></label>
        <label className="field">{tr("Început (s, relativ)")}<input className="input mono" type="number" step={0.001} value={((draft.startNs ?? 0) / 1e9).toFixed(3)} onChange={(e) => set({ startNs: +e.target.value * 1e9 })} /></label>
        <label className="field">{tr("Sfârșit (s, relativ)")}<input className="input mono" type="number" step={0.001} value={((draft.endNs ?? 0) / 1e9).toFixed(3)} onChange={(e) => set({ endNs: +e.target.value * 1e9 })} /></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>{tr("Topicuri (separate prin virgulă)")}<input className="input mono" value={(draft.topics ?? []).join(", ")} onChange={(e) => set({ topics: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>
        <label className="field">{tr("Valoare măsurată")}<input className="input" value={draft.measured ?? ""} onChange={(e) => set({ measured: e.target.value })} /></label>
        <label className="field">{tr("Așteptat")}<input className="input" value={draft.expected ?? ""} onChange={(e) => set({ expected: e.target.value })} /></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>{tr("Actual")}<input className="input" value={draft.actual ?? ""} onChange={(e) => set({ actual: e.target.value })} /></label>
        <label className="field" style={{ gridColumn: "1 / -1" }}>{tr("Pași de reproducere (gol = generați automat: deep-link + comandă CLI)")}<textarea className="input mono" value={draft.steps ?? ""} onChange={(e) => set({ steps: e.target.value })} placeholder={defaultSteps(draft as Bug)} /></label>
      </div>
      {(draft.images ?? []).length > 0 && (
        <div className="row wrap" style={{ marginTop: 12 }}>
          {draft.images!.map((im) => <img key={im.name} src={im.dataUrl} alt={`Snapshot ${im.name}`} style={{ maxWidth: 320, borderRadius: 8, border: "1px solid var(--border)" }} />)}
        </div>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn sm" onClick={async () => { const png = await snapshotPng(); if (png) set({ images: [...(draft.images ?? []), { name: `captura-${Date.now()}.png`, dataUrl: png }] }); }}>{tr("+ captură replay")}</button>
        <span className="spacer" />
        <button className="btn" onClick={() => app.set({ bugDraft: undefined })}>{tr("Renunță")}</button>
        <button className="btn primary" onClick={save}>{tr("Salvează bug")}</button>
      </div>
    </Modal>
  );
}

