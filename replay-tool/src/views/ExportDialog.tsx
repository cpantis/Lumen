/**
 * Export dialog: deterministic video (MP4 / H.264, interval, fps of recording time,
 * speed factor, time base) and PNG snapshots at a list of times, with suggested moments
 * (largest output gap, largest latency). Progress and cancel for both.
 */
import { useMemo, useRef, useState } from "react";
import { parseTimeList, planVideo, snapshotName, suggestSnapshots } from "../core/exportplan";
import { parity } from "../state/actions";
import { app, toast, useApp } from "../state/store";
import { exportSnapshots, exportVideoFile } from "../export/video";
import { Modal } from "../ui/primitives";

export function ExportDialog() {
  const mode = useApp((s) => s.exportOpen);
  if (!mode) return null;
  return <ExportDialogBody mode={mode} />;
}

function ExportDialogBody({ mode }: { mode: "video" | "snapshots" }) {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const hasAB = s.markA !== undefined && s.markB !== undefined;
  const [tab, setTab] = useState(mode);
  const [start, setStart] = useState(+((hasAB ? Math.min(s.markA!, s.markB!) : 0) / 1e9).toFixed(3));
  const [end, setEnd] = useState(+((hasAB ? Math.max(s.markA!, s.markB!) : a.durationNs) / 1e9).toFixed(3));
  const [fps, setFps] = useState(30);
  const [speed, setSpeed] = useState(1);
  const [base, setBase] = useState<"log" | "header">(s.timeSource);
  const [times, setTimes] = useState("");
  const [busy, setBusy] = useState<{ done: number; total: number; t0: number }>();
  const [result, setResult] = useState<string>();
  const abort = useRef<AbortController>();
  const close = () => {
    abort.current?.abort();
    app.set({ exportOpen: undefined });
  };
  const plan = useMemo(() => {
    try {
      return planVideo(start * 1e9, end * 1e9, fps, speed);
    } catch {
      return undefined;
    }
  }, [start, end, fps, speed]);
  const sugg = useMemo(() => suggestSnapshots(a, parity(s)), [a, s]);
  const parsed = parseTimeList(times);

  const run = async (job: (signal: AbortSignal, prog: (d: number, n: number) => void) => Promise<string>) => {
    abort.current = new AbortController();
    setResult(undefined);
    setBusy({ done: 0, total: 1, t0: performance.now() });
    try {
      const msg = await job(abort.current.signal, (d, n) => setBusy((b) => ({ done: d, total: n, t0: b?.t0 ?? performance.now() })));
      setResult(msg);
      toast(msg);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setResult(m === "cancelled" ? "Cancelled." : `Export failed: ${m}`);
    } finally {
      setBusy(undefined);
    }
  };

  const eta = busy && busy.done > 0 ? ((performance.now() - busy.t0) / busy.done) * (busy.total - busy.done) / 1000 : NaN;
  return (
    <Modal title="Export" onClose={close} wide>
      <div className="btn-group" role="tablist" style={{ marginBottom: 12 }}>
        <button className="btn sm" role="tab" aria-selected={tab === "video"} aria-pressed={tab === "video"} onClick={() => setTab("video")} disabled={!!busy}>Video (MP4)</button>
        <button className="btn sm" role="tab" aria-selected={tab === "snapshots"} aria-pressed={tab === "snapshots"} onClick={() => setTab("snapshots")} disabled={!!busy}>PNG snapshots</button>
      </div>
      <div className="row wrap" style={{ gap: 12, marginBottom: 12 }}>
        <label className="col small">time base
          <select className="input" value={base} onChange={(e) => setBase(e.target.value as "log" | "header")} disabled={!!busy} aria-label="Time base">
            <option value="log">log time</option>
            <option value="header">header.stamp</option>
          </select>
        </label>
      </div>
      {tab === "video" ? (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>
            Rendered offline: frame <i>k</i> shows exactly the state at <span className="mono">t = start + k / fps</span> of recording time, whatever the speed of this computer. The video plays at fps × speed. H.264 in MP4 (WebM only if this browser cannot encode H.264 — the summary says so).
          </p>
          <div className="row wrap" style={{ gap: 12 }}>
            <label className="col small">start (s)<input className="input mono" type="number" step="0.1" min={0} value={start} onChange={(e) => setStart(+e.target.value)} disabled={!!busy} aria-label="Start (s)" /></label>
            <label className="col small">end (s)<input className="input mono" type="number" step="0.1" min={0} value={end} onChange={(e) => setEnd(+e.target.value)} disabled={!!busy} aria-label="End (s)" /></label>
            <label className="col small">frames per second of recording<input className="input mono" type="number" step="1" min={1} max={120} value={fps} onChange={(e) => setFps(+e.target.value)} disabled={!!busy} aria-label="Frames per second" /></label>
            <label className="col small">speed factor<input className="input mono" type="number" step="0.25" min={0.05} max={16} value={speed} onChange={(e) => setSpeed(+e.target.value)} disabled={!!busy} aria-label="Speed factor" /></label>
          </div>
          <p className="small">
            {plan ? <>{plan.times.length} frames · video {plan.videoFps.toFixed(2)} fps · duration {(plan.times.length / plan.videoFps).toFixed(2)} s{hasAB ? " · interval from cursors A–B" : ""}</> : <span className="error">fps and speed must be positive</span>}
          </p>
          <div className="row">
            <button
              className="btn primary"
              disabled={!plan || !!busy}
              onClick={() =>
                run(async (signal, prog) => {
                  const sum = await exportVideoFile({ startNs: start * 1e9, endNs: end * 1e9, fps, speed, base, signal, onProgress: prog });
                  return `Saved ${sum.video} (${sum.frames} frames, ${sum.codec}) and its summary.json in ${sum.render_s.toFixed(1)} s${sum.note ? ` — ${sum.note}` : ""}`;
                })
              }
            >
              Render video
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>PNG of the whole layout at each time (s, comma separated), named <span className="mono">replay_&lt;t&gt;s.png</span>; the metadata is embedded in each PNG. Several times → one ZIP with summary.json.</p>
          <label className="col small">times (s)
            <input className="input mono" value={times} placeholder="e.g. 4.2, 12.5" onChange={(e) => setTimes(e.target.value)} disabled={!!busy} aria-label="Snapshot times (s)" />
          </label>
          {parsed.invalid.length > 0 && <p className="small error">Not a time: {parsed.invalid.join(", ")}</p>}
          {parsed.times.length > 0 && <p className="xs muted mono">{parsed.times.map(snapshotName).join("  ")}</p>}
          <div className="col" style={{ gap: 4, margin: "8px 0" }}>
            <span className="small">Suggested moments:</span>
            {sugg.length === 0 && <span className="small muted">none (no output with stamps)</span>}
            {sugg.map((g) => (
              <button key={g.label} className="btn sm ghost" style={{ justifyContent: "flex-start" }} disabled={!!busy} onClick={() => setTimes((x) => [x.trim(), (g.tNs / 1e9).toFixed(2)].filter(Boolean).join(", "))}>
                + {(g.tNs / 1e9).toFixed(2)} s — {g.label}
              </button>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={!parsed.times.length || parsed.invalid.length > 0 || !!busy}
            onClick={() =>
              run(async (signal, prog) => {
                const names = await exportSnapshots(parsed.times, base, prog, signal);
                return `Saved ${names.length === 1 ? names[0] : `replay_snapshots.zip (${names.length} PNG)`}`;
              })
            }
          >
            Save snapshots
          </button>
        </>
      )}
      {busy && (
        <div className="col" style={{ gap: 6, marginTop: 12 }} role="status" aria-live="polite">
          <progress max={busy.total} value={busy.done} style={{ width: "100%" }} aria-label="Export progress" />
          <div className="row small">
            <span>{busy.done} / {busy.total}{Number.isFinite(eta) ? ` · about ${eta.toFixed(0)} s left` : ""}</span>
            <span className="spacer" />
            <button className="btn sm" onClick={() => abort.current?.abort()}>Cancel</button>
          </div>
        </div>
      )}
      {result && <p className="small" role="status" data-testid="export-result">{result}</p>}
    </Modal>
  );
}
