/**
 * FOV consistency (2.3): do the outputs describing the same moment agree with each
 * other and with their inputs? Same-moment grouping, cloud ↔ depth consistency over
 * time, calibration (from CameraInfo/TF, manual or estimated) with confidence.
 */
import { Download, Play, Upload, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { download } from "../core/inventory";
import type { Calibration, ParamKey } from "../core/projection";
import { autoCalibration, consistencyOverTime, estimate, fovTopics, type ConsistencySample } from "../state/calibration";
import { fovList, jumpTo } from "../state/actions";
import { app, toast, uid, useApp } from "../state/store";
import { traceLine } from "../state/trace";
import { Plot } from "../ui/Plot";
import { BrailleLoader, FileButton, fmt, Kv, Section, StatusBadge } from "../ui/primitives";
import { tr } from "../i18n";

const PARAMS: Array<{ key: ParamKey; label: string; unit: string; deg?: boolean }> = [
  { key: "fx", label: "fx", unit: "px" },
  { key: "fy", label: "fy", unit: "px" },
  { key: "cx", label: "cx", unit: "px" },
  { key: "cy", label: "cy", unit: "px" },
  { key: "tx", label: "tx", unit: "m" },
  { key: "ty", label: "ty", unit: "m" },
  { key: "tz", label: "tz", unit: "m" },
  { key: "roll", label: "roll", unit: "°", deg: true },
  { key: "pitch", label: "pitch", unit: "°", deg: true },
  { key: "yaw", label: "yaw", unit: "°", deg: true },
];

function getP(c: Calibration, k: ParamKey): number {
  return (k in c.intrinsics ? (c.intrinsics as unknown as Record<string, number>)[k] : (c.extrinsics as unknown as Record<string, number>)[k]) ?? 0;
}
function setP(c: Calibration, k: ParamKey, v: number): Calibration {
  const n: Calibration = { ...c, intrinsics: { ...c.intrinsics }, extrinsics: { ...c.extrinsics }, source: "manual" };
  if (k in n.intrinsics) (n.intrinsics as unknown as Record<string, number>)[k] = v;
  else (n.extrinsics as unknown as Record<string, number>)[k] = v;
  return n;
}

function FovGroupCard({ fov }: { fov: string }) {
  const a = useApp((s) => s.analysis)!;
  const g = a.fovGroups.find((x) => x.fov === fov);
  const series = useMemo(() => (g ? [{ label: "publication spread between outputs (ms)", color: "var(--accent-2)", values: Array.from(g.spreadNs, (v) => v / 1e6), points: true, width: 1 }] : []), [g]);
  if (!g) return <p className="muted small">{tr("FOV fără grup de ieșiri detectat automat.")}</p>;
  const full = (1 << g.outputs.length) - 1;
  const incomplete = Array.from(g.presence).map((m, i) => [m, i] as const).filter(([m]) => m !== full);
  return (
    <>
      <Kv items={[["primary input", g.primaryInput], ["outputs", g.outputs.join(", ")], ["moments with every output present", fmt.pct(g.completeRatio)], ["incomplete moments", `${incomplete.length}`]]} />
      <Plot x={g.stamps} series={series} time height={150} title={tr("Pentru fiecare moment (stamp): diferența dintre publicarea primei și ultimei ieșiri")} csvName={`${fov}_sincron`} />
      {incomplete.slice(0, 20).map(([m, i]) => (
        <button key={i} className="btn sm ghost" onClick={() => jumpTo(g.stamps[i], g.outputs)}>
          {fmt.s(g.stamps[i])}: missing {g.outputs.filter((_, k) => !(m & (1 << k))).join(", ")}
        </button>
      ))}
    </>
  );
}

function CalibrationCard({ fov }: { fov: string }) {
  const a = useApp((s) => s.analysis)!;
  const stored = useApp((s) => s.calibrations[fov]);
  const ft = useMemo(() => fovTopics(a, fov), [a, fov]);
  const [auto, setAuto] = useState<Calibration>();
  const cal = stored ?? auto;
  const [samples, setSamples] = useState<ConsistencySample[]>();
  const [busy, setBusy] = useState<string>();
  const [keys, setKeys] = useState<ParamKey[]>(["roll", "pitch", "yaw"]);
  const [est, setEst] = useState<Awaited<ReturnType<typeof estimate>>>();

  useEffect(() => {
    autoCalibration(a, ft).then(setAuto).catch(() => undefined);
  }, [a, ft]);

  const set = (c: Calibration) => app.set((s) => ({ calibrations: { ...s.calibrations, [fov]: c } }));
  const run = async () => {
    if (!cal) return;
    setBusy("computing consistency");
    try {
      setSamples(await consistencyOverTime(ft, cal, 80));
    } finally {
      setBusy(undefined);
    }
  };
  const runEstimate = async () => {
    if (!cal) return;
    setBusy("estimating parameters (Nelder–Mead)");
    try {
      const r = await estimate(ft, cal, keys, 8);
      setEst(r);
      set({ ...r.calibration, note: `Estimated from ${r.frames} frames; parameters: ${keys.join(", ")}; cost ${r.startCost.toFixed(4)} → ${r.cost.toFixed(4)}.` });
      toast("Estimated parameters applied");
    } finally {
      setBusy(undefined);
    }
  };
  const errS = useMemo(() => (samples ? [
    { label: "median relative error", color: "var(--accent)", values: samples.map((x) => x.medianRelError), points: true },
    { label: "p90", color: "var(--warn)", values: samples.map((x) => x.p90RelError), width: 1 },
    { label: "points in image", color: "var(--accent-2)", values: samples.map((x) => x.inImageRatio), width: 1 },
  ] : []), [samples]);
  const errX = useMemo(() => (samples ? samples.map((x) => x.t) : []), [samples]);
  const errShade = useMemo(() => (samples ? samples.filter((x) => x.medianRelError > 0.05).map((x) => [x.t - 3e7, x.t + 3e7] as [number, number]) : []), [samples]);
  const th = useMemo(() => [{ value: 0.05, label: "5 %", color: "var(--error)" }], []);

  if (!ft.cloud || !ft.depth)
    return <p className="muted small">For the cloud ↔ depth comparison, the FOV needs a PointCloud2 output and a depth Image output (16UC1/32FC1). Found: cloud {ft.cloud?.topic ?? "—"}, depth {ft.depth?.topic ?? "—"}.</p>;

  return (
    <>
      <p className="small">
        {tr("Compară")} <code>{ft.cloud.topic}</code> with <code>{ft.depth.topic}</code> {tr("pentru același stamp: fiecare punct 3D e proiectat în imaginea de adâncime; eroarea = |Z")}<sub>cloud</sub> − Z<sub>depth</sub>| / Z<sub>depth</sub>{tr(". Imaginea camerei:")} <code>{ft.image?.topic ?? "—"}</code>.
      </p>
      {cal && (
        <div className="callout">
          <b>Calibration source: {cal.source}</b>. {cal.note}
        </div>
      )}
      {cal && (
        <div className="table-wrap" tabIndex={0} style={{ marginBottom: 12 }}>
          <table className="t">
            <thead><tr><th>{tr("Parametru")}</th><th>{tr("Valoare")}</th><th>{tr("Estimează")}</th>{est && <th>{tr("Încredere")}</th>}{est && <th className="num">{tr("Creștere cost la ±δ")}</th>}</tr></thead>
            <tbody>
              {PARAMS.map((p) => {
                const v = getP(cal, p.key);
                const sens = est?.sensitivity.find((x) => x.key === p.key);
                return (
                  <tr key={p.key}>
                    <td className="mono">{p.label} ({p.unit})</td>
                    <td><input className="input mono" style={{ width: 120 }} type="number" step={p.deg ? 0.5 : p.unit === "m" ? 0.01 : 1} value={+(p.deg ? (v * 180) / Math.PI : v).toFixed(4)} onChange={(e) => set(setP(cal, p.key, p.deg ? (+e.target.value * Math.PI) / 180 : +e.target.value))} aria-label={`${p.label} in ${p.unit}`} /></td>
                    <td><input type="checkbox" checked={keys.includes(p.key)} onChange={(e) => setKeys(e.target.checked ? [...keys, p.key] : keys.filter((k) => k !== p.key))} aria-label={`Estimate ${p.label}`} /></td>
                    {est && <td>{sens ? <span className={`badge ${sens.confidence === "high" ? "ok" : sens.confidence === "medium" ? "warn" : "error"}`}>{sens.confidence}</span> : "—"}</td>}
                    {est && <td className="num">{sens ? fmt.pct(sens.relativeRise) : "—"}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row wrap">
        <button className="btn sm primary" onClick={run} disabled={!cal || !!busy}><Play size={14} /> {tr("Calculează consistența în timp")}</button>
        <button className="btn sm" onClick={runEstimate} disabled={!cal || !!busy || !keys.length} data-tip={tr("Minimizează eroarea nor↔adâncime pe 8 cadre eșantionate, doar pentru parametrii bifați")}><Wand2 size={14} /> {tr("Estimează parametrii bifați")}</button>
        <button className="btn sm ghost" onClick={() => auto && set(auto)} disabled={!auto}>{tr("Revino la automat")}</button>
        <button className="btn sm" onClick={() => cal && download(`calibration-${fov}.json`, JSON.stringify({ fov, calibration: cal, estimate: est && { cost: est.cost, startCost: est.startCost, frames: est.frames, sensitivity: est.sensitivity }, trace: traceLine() }, null, 2), "application/json")}><Download size={14} /> JSON</button>
        <FileButton accept=".json" onText={(t) => { const o = JSON.parse(t); if (o.calibration) set(o.calibration); }}><Upload size={14} /> {tr("Importă")}</FileButton>
        <button className="btn sm" onClick={() => { const id = uid(); app.set((s) => ({ panels: [...s.panels, { id, topic: ft.image?.topic ?? ft.depth!.topic, kind: "overlay", topic2: ft.cloud!.topic }], layout: [...s.layout, { i: id, x: 0, y: 999, w: 6, h: 8, minW: 2, minH: 3 }], view: "replay" })); }} disabled={!ft.image}>
          {tr("Deschide proiecția în replay")}
        </button>
        {busy && <span className="row small"><BrailleLoader label={busy} /> {busy}…</span>}
      </div>
      {est && (
        <p className="small muted" style={{ marginTop: 8 }}>
          Estimation on {est.frames} frames, {est.iterations} iterations: cost {est.startCost.toFixed(4)} → {est.cost.toFixed(4)}. Confidence = how much the cost rises for a ±δ perturbation of the parameter: a flat cost means the data does not constrain the parameter (low confidence).
        </p>
      )}
      {samples && (
        <>
          <Plot x={errX} series={errS} time height={200} thresholds={th} shade={errShade} title={tr("Consistența nor ↔ adâncime în timp (click → salt)")} csvName={`${fov}_consistenta`} />
          <div className="row wrap">
            <StatusBadge kind={samples.every((x) => !(x.medianRelError > 0.05)) ? "pass" : "fail"} label={`${samples.filter((x) => x.medianRelError > 0.05).length} of ${samples.length} sampled frames above 5 %`} />
            {samples.filter((x) => x.medianRelError > 0.05).slice(0, 10).map((x) => (
              <button key={x.t} className="btn sm ghost" onClick={() => jumpTo(x.t, [ft.cloud!.topic, ft.depth!.topic])}>{fmt.s(x.t)}: {fmt.pct(x.medianRelError)}</button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function ConsistencyView() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const fovs = fovList(a, s);
  return (
    <div className="view" id="main-content">
      <div className="view-title">
        <h2>{tr("Consistența ieșirilor pe FOV")}</h2>
        <span className="sub">{tr("2.3 · ieșirile care descriu același moment concordă între ele și cu intrările?")}</span>
      </div>
      {fovs.length === 0 && <div className="callout warn">{tr("Niciun FOV detectat. Atribuie FOV-uri topicurilor în Inventar.")}</div>}
      {fovs.map((f) => (
        <Section key={f} title={`FOV ${f}`}>
          <h4>{tr("Același moment: toate ieșirile prezente și publicate împreună?")}</h4>
          <FovGroupCard fov={f} />
          <hr />
          <h4>{tr("Concordanță geometrică nor 3D ↔ imagine de adâncime")}</h4>
          <CalibrationCard fov={f} />
        </Section>
      ))}
    </div>
  );
}
