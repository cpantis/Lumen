/**
 * Replay view: transport, live latency strip, 3-column component-oriented layout
 * (Inputs | Outputs FOV 1 | Outputs FOV 2) of resizable/rearrangeable panels,
 * timeline, and the side inspector.
 */
import { LayoutGrid, Plus, Save, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { distanceM, fmtDistance } from "../core/motion";
import { useT } from "../i18n";
import { PanelFor } from "../panels/registry";
import { panelKindLabel } from "../panels/registry";
import { columnPanels, defaultPanels, effectiveRole, fovColor, fovList, fovRowsPanels, indexAt, loadLayout, saveLayout, savedLayouts } from "../state/actions";
import { app, uid, useApp, useClock } from "../state/store";
import { Timeline } from "../timeline/Timeline";
import { Transport } from "../timeline/Transport";
import { Plot } from "../ui/Plot";
import { fmt } from "../ui/primitives";
import { tr } from "../i18n";

const RGL = WidthProvider(GridLayout);

function LatencyStrip() {
  const a = useApp((s) => s.analysis)!;
  const speed = useApp((s) => s.speedOverride ?? s.analysis!.motion.speedMps);
  const source = useApp((s) => s.timeSource);
  const exact = a.edges.filter((e) => e.kind === "exact" && /Image|CompressedImage/.test(a.topics.find((t) => t.topic === e.input)?.type ?? ""));
  const [sel, setSel] = useState(0);
  const narrow = useNarrow();
  const [open, setOpen] = useState(!narrow);
  const cursor = useClock();
  const e = exact[Math.min(sel, exact.length - 1)];
  const ot = e && a.topics.find((t) => t.topic === e.output)!;
  const x = useMemo(() => (ot ? ot.log : new Float64Array()), [ot]);
  const series = useMemo(() => (e ? [{ label: "latency (ms)", color: "var(--accent)", values: Array.from(e.latency, (v) => v / 1e6), points: true, width: 1 }] : []), [e]);
  if (!e || !ot) return null;
  const j = indexAt(ot, cursor, source);
  const lat = j >= 0 ? e.latency[j] : NaN;
  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "4px 12px", background: "var(--surface)" }} data-tour="latency">
      <div className="row small wrap">
        <button className="btn sm ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "▾" : "▸"} Live latency
        </button>
        <select className="input" style={{ minHeight: 26 }} value={sel} onChange={(ev) => setSel(+ev.target.value)} aria-label={tr("Pereche intrare → ieșire")}>
          {exact.map((x2, i) => (
            <option key={i} value={i}>
              {x2.input} → {x2.output}
            </option>
          ))}
        </select>
        <span className="num" style={{ fontSize: "var(--text-lg)", color: lat > e.latencySummary.p95 ? "var(--warn)" : "var(--text)" }} aria-live="off">
          {fmt.ms(lat)}
        </span>
        <span className="muted" data-tip={tr("Distanța parcursă de utilizator în timpul latenței, la viteza estimată")}>
          ≈ {fmtDistance(distanceM(lat, speed))} walked
        </span>
        <span className="muted xs">
          p50 {fmt.ms(e.latencySummary.p50)} · p95 {fmt.ms(e.latencySummary.p95)} · max {fmt.ms(e.latencySummary.max)} · latency = log_time(output) − header.stamp(input)
        </span>
      </div>
      {open && <Plot x={x} series={series} time height={90} />}
    </div>
  );
}

function AddPanelMenu() {
  const T = useT();
  const a = useApp((s) => s.analysis)!;
  const [open, setOpen] = useState(false);
  const [overlay, setOverlay] = useState({ img: "", cloud: "" });
  const [diff, setDiff] = useState({ a: "", b: "" });
  const add = (topic: string, kind: "auto" | "overlay" | "diff" = "auto", topic2?: string) => {
    const id = uid();
    app.set((s) => ({ panels: [...s.panels, { id, topic, kind, topic2 }], layout: [...s.layout, { i: id, x: 0, y: 999, w: kind === "auto" ? 4 : 6, h: 7, minW: 2, minH: 3 }] }));
    setOpen(false);
  };
  const images = a.topics.filter((t) => /Image/.test(t.type));
  const clouds = a.topics.filter((t) => t.type === "sensor_msgs/PointCloud2");
  return (
    <div style={{ position: "relative" }}>
      <button className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open} data-tip={tr("Adaugă un panou pentru orice topic, o proiecție sau o comparație")}>
        <Plus size={14} /> {T.addPanel}
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: 36, zIndex: 30, width: 420, maxHeight: 460, overflow: "auto", boxShadow: "var(--shadow)" }}>
          <h4>{tr("Topic")}</h4>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {a.topics.map((t) => (
              <li key={t.topic}>
                <button className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => add(t.topic)}>
                  <span className="mono">{t.topic}</span>
                  <span className="muted xs">· {panelKindLabel(t.type)}</span>
                </button>
              </li>
            ))}
          </ul>
          <hr />
          <h4>{tr("Proiecție nor 3D → imagine (2.3)")}</h4>
          <div className="row wrap">
            <select className="input" aria-label={tr("Imagine")} value={overlay.img} onChange={(e) => setOverlay({ ...overlay, img: e.target.value })}>
              <option value="">{tr("imagine…")}</option>
              {images.map((t) => <option key={t.topic}>{t.topic}</option>)}
            </select>
            <select className="input" aria-label={tr("Nor de puncte")} value={overlay.cloud} onChange={(e) => setOverlay({ ...overlay, cloud: e.target.value })}>
              <option value="">{tr("nor…")}</option>
              {clouds.map((t) => <option key={t.topic}>{t.topic}</option>)}
            </select>
            <button className="btn sm primary" disabled={!overlay.img || !overlay.cloud} onClick={() => add(overlay.img, "overlay", overlay.cloud)}>{tr("Adaugă")}</button>
          </div>
          <h4 style={{ marginTop: 12 }}>{tr("Comparație două imagini (suprapunere / diferență)")}</h4>
          <div className="row wrap">
            <select className="input" aria-label={tr("Imagine A")} value={diff.a} onChange={(e) => setDiff({ ...diff, a: e.target.value })}>
              <option value="">A…</option>
              {images.map((t) => <option key={t.topic}>{t.topic}</option>)}
            </select>
            <select className="input" aria-label={tr("Imagine B")} value={diff.b} onChange={(e) => setDiff({ ...diff, b: e.target.value })}>
              <option value="">B…</option>
              {images.map((t) => <option key={t.topic}>{t.topic}</option>)}
            </select>
            <button className="btn sm primary" disabled={!diff.a || !diff.b} onClick={() => add(diff.a, "diff", diff.b)}>{tr("Adaugă")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function LayoutMenu() {
  const T = useT();
  const [, force] = useState(0);
  const [saving, setSaving] = useState(false);
  const names = Object.keys(savedLayouts());
  const [name, setName] = useState("");
  return (
    <div className="row" style={{ position: "relative" }}>
      <button className="btn sm ghost" data-tip={T.layoutReset} aria-label={T.layoutReset} onClick={() => app.set(defaultPanels(app.get().analysis!))}>
        <RotateCcw size={14} />
      </button>
      <button className="btn sm ghost" data-tip={T.layoutSave} aria-label={T.layoutSave} aria-expanded={saving} onClick={() => { setName(`layout ${names.length + 1}`); setSaving(!saving); }}>
        <Save size={14} />
      </button>
      {saving && (
        <form
          className="card row"
          style={{ position: "absolute", right: 0, top: 34, zIndex: 30, boxShadow: "var(--shadow)", padding: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            saveLayout(name.trim());
            setSaving(false);
            force((x) => x + 1);
          }}
          onKeyDown={(e) => e.key === "Escape" && setSaving(false)}
        >
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={tr("Numele layout-ului")} style={{ width: 180 }} />
          <button className="btn sm primary">{T.layoutSave}</button>
        </form>
      )}
      {names.length > 0 && (
        <select className="input" style={{ minHeight: 28 }} aria-label={T.layoutLoad} value="" onChange={(e) => e.target.value && loadLayout(e.target.value)}>
          <option value="">{T.layoutLoad}…</option>
          {names.map((n) => <option key={n}>{n}</option>)}
        </select>
      )}
    </div>
  );
}

/** True on tablets / phones (≤ 900 px): the replay switches to one panel at a time. */
export function useNarrow(): boolean {
  const q = "(max-width: 900px)";
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== "undefined" && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** Compact mode (tablet / phone): one panel at a time + selector. */
function CompactPanels() {
  const T = useT();
  const s = useApp((st) => st);
  const a = s.analysis!;
  const [i, setI] = useState(0);
  const k = Math.min(i, Math.max(0, s.panels.length - 1));
  const p = s.panels[k];
  return (
    <div className="col" style={{ gap: 8, padding: 8 }}>
      <div className="row wrap">
        <button className="btn sm icon" aria-label={tr("Panoul anterior")} disabled={k === 0} onClick={() => setI(k - 1)}>‹</button>
        <select className="input" style={{ flex: 1, minWidth: 0 }} aria-label={tr("Panoul afișat")} value={k} onChange={(e) => setI(+e.target.value)}>
          {s.panels.map((x, j) => (
            <option key={x.id} value={j}>
              {j + 1}/{s.panels.length} · {x.kind === "auto" ? x.topic : `${x.kind}: ${x.topic}`}
            </option>
          ))}
        </select>
        <button className="btn sm icon" aria-label={tr("Panoul următor")} disabled={k >= s.panels.length - 1} onClick={() => setI(k + 1)}>›</button>
        <AddPanelMenu />
      </div>
      {p ? (
        <div style={{ height: "52vh", minHeight: 260 }}>
          <PanelFor cfg={p} topics={a.topics} />
        </div>
      ) : (
        <div className="panel-empty" style={{ position: "static", height: 200 }}>No panels. {T.addPanel}.</div>
      )}
    </div>
  );
}

export function ReplayView() {
  const T = useT();
  const s = useApp((st) => st);
  const a = s.analysis!;
  const fovs = fovList(a, s);
  const nIn = a.topics.filter((t) => effectiveRole(t, s) === "input").length;
  const narrow = useNarrow();
  if (narrow)
    return (
      <div className="replay narrow" id="main-content">
        <div>
          <Transport />
          <LatencyStrip />
        </div>
        <div className="replay-grid" data-tour="panels">
          <CompactPanels />
        </div>
        <Timeline />
      </div>
    );
  return (
    <div className="replay" id="main-content">
      <div>
        <Transport />
        <LatencyStrip />
        <div className="col-heads fov-legend" role="group" aria-label="Fields of view and layout">
          <div className="col-head" style={{ flexWrap: "wrap", gap: 12 }}>
            <span><i className="chip-dot" style={{ background: "var(--role-input)" }} /> {T.inputs} · {nIn}</span>
            {fovs.map((f, k) => (
              <span key={f} data-tip={`Outputs of field of view ${f} (inferred: Inventory → Inferred settings)`}>
                <i className="chip-dot" style={{ background: fovColor(k) }} /> FOV {k + 1} · {f}
              </span>
            ))}
            {fovs.length === 0 && <span className="muted">no field of view inferred</span>}
            <span className="spacer" />
            <select className="input" style={{ minHeight: 28 }} aria-label="Layout preset" value="" onChange={(e) => e.target.value && app.set(e.target.value === "rows" ? fovRowsPanels(a) : columnPanels(a))}>
              <option value="">Layout preset…</option>
              <option value="rows">Inputs and outputs per FOV (rows)</option>
              <option value="cols">Inputs | outputs FOV 1 | FOV 2 (columns)</option>
            </select>
            <LayoutMenu />
            <AddPanelMenu />
          </div>
        </div>
      </div>
      <div className="replay-grid" data-tour="panels">
        {s.panels.length === 0 ? (
          <div className="panel-empty" style={{ position: "static", height: 300 }}>
            <LayoutGrid size={32} />
            No panels. Add one with “{T.addPanel}” or go back to the default layout.
          </div>
        ) : (
          <RGL
            className="layout"
            layout={s.layout}
            cols={12}
            rowHeight={40}
            margin={[8, 8]}
            draggableHandle=".drag-handle"
            onLayoutChange={(l: Layout[]) => app.set({ layout: l })}
            compactType="vertical"
          >
            {s.panels.map((p) => (
              <div key={p.id} data-grid={s.layout.find((l) => l.i === p.id) ?? { x: 0, y: 999, w: 4, h: 7 }}>
                <PanelFor cfg={p} topics={a.topics} />
              </div>
            ))}
          </RGL>
        )}
      </div>
      <Timeline />
    </div>
  );
}
