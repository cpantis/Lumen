/**
 * Safety (2.5): what the measurements mean for the person wearing the Glasses.
 * Walking speed from the IMU (or a stated assumption), every latency / gap translated
 * into distance walked, safety-critical requirements only, and the worst moments of
 * the recording ranked by "blind" distance.
 */
import { useMemo } from "react";
import { DEFAULT_SPEED_MPS, distanceM, estimateMotion, fmtDistance } from "../core/motion";
import { effectiveRole, jumpTo, results } from "../state/actions";
import { app, useApp } from "../state/store";
import { Plot } from "../ui/Plot";
import { fmt, Kv, Section, Stat, StatusBadge, verdictKind } from "../ui/primitives";
import { tr, trField } from "../i18n";

export function SafetyView() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const motion = useMemo(() => {
    const imu = a.topics.find((t) => t.topic === a.motion.imuTopic);
    return imu ? estimateMotion({ topic: imu.topic, t: imu.log, accNorm: Float64Array.from(imu.content.min) }, s.stepLengthM) : a.motion;
  }, [a, s.stepLengthM]);
  const speed = s.speedOverride ?? motion.speedMps;
  const outputs = a.topics.filter((t) => effectiveRole(t, s) === "output" && t.count > 1);

  const worst = useMemo(() => {
    const items: Array<{ t: number; dur: number; what: string; topics: string[] }> = [];
    for (const o of outputs) for (let i = 1; i < o.count; i++) {
      const d = o.log[i] - o.log[i - 1];
      if (d > 2 * o.rate.medianPeriodNs) items.push({ t: o.log[i - 1], dur: d, what: `fără ieșire nouă pe ${o.topic}`, topics: [o.topic] });
    }
    for (const e of a.edges.filter((x) => x.kind === "exact")) {
      const ot = a.topics.find((t) => t.topic === e.output)!;
      for (let j = 0; j < e.latency.length; j++) if (e.latency[j] > e.latencySummary.p95 * 1.5) items.push({ t: ot.log[j], dur: e.latency[j], what: `latență ${fmt.ms(e.latency[j])} ${e.input} → ${e.output}`, topics: [e.input, e.output] });
    }
    return items.sort((x, y) => y.dur - x.dur).slice(0, 25);
  }, [a, outputs]);

  const safety = results(s.profile, s).filter((r) => r.safety);
  const other = results(s.profile, s).filter((r) => !r.safety);
  const imu = a.topics.find((t) => t.topic === motion.imuTopic);
  const imuS = useMemo(() => (imu ? [{ label: "|a| (m/s²)", color: "var(--accent-2)", values: imu.content.min, width: 1 }] : []), [imu]);
  const steps = useMemo(() => motion.stepTimes.map((t) => [t - 1e7, t + 1e7] as [number, number]), [motion]);

  return (
    <div className="view" id="main-content">
      <div className="view-title">
        <h2>{tr("Ce înseamnă pentru utilizator")}</h2>
        <span className="sub">{tr("2.5 · ochelarii ghidează o persoană nevăzătoare care merge — fiecare milisecundă devine distanță parcursă fără informație")}</span>
      </div>
      <Section title={tr("Viteza de mers")}>
        <div className="stats" style={{ marginBottom: 12 }}>
          <Stat value={`${speed.toFixed(2)} m/s`} label={s.speedOverride ? "viteză (editată manual)" : motion.method === "imu-steps" ? "viteză estimată din IMU" : "viteză presupusă"} />
          <Stat value={Number.isFinite(motion.cadenceHz) ? `${motion.cadenceHz.toFixed(2)} pași/s` : "—"} label={tr("cadență")} />
          <Stat value={motion.stepTimes.length} label={tr("pași detectați")} />
          <Stat value={motion.confidence} label={tr("încredere")} />
        </div>
        <p className="small">{motion.note}</p>
        <div className="row wrap" style={{ alignItems: "flex-end", marginBottom: 12 }}>
          <label className="field">{tr("viteză folosită (m/s)")}<input className="input mono" type="number" step={0.05} min={0.1} value={speed.toFixed(2)} onChange={(e) => app.set({ speedOverride: +e.target.value })} style={{ width: 120 }} /></label>
          <label className="field">{tr("lungime pas presupusă (m)")}<input className="input mono" type="number" step={0.05} min={0.3} value={s.stepLengthM} onChange={(e) => app.set({ stepLengthM: +e.target.value, speedOverride: undefined })} style={{ width: 120 }} /></label>
          <button className="btn sm ghost" onClick={() => app.set({ speedOverride: undefined })}>{tr("folosește estimarea")}</button>
          <button className="btn sm ghost" onClick={() => app.set({ speedOverride: DEFAULT_SPEED_MPS })}>{tr("1,4 m/s (tipic)")}</button>
        </div>
        {imu && <Plot x={imu.log} series={imuS} time height={140} shade={steps} title={tr("Pași detectați (benzi) pe |a| din IMU")} />}
      </Section>

      <Section title={tr("Timp → distanță, pentru fiecare ieșire")} sub={`La ${speed.toFixed(2)} m/s. „Orb” = distanța parcursă fără o ieșire nouă.`}>
        <div className="table-wrap" tabIndex={0}>
          <table className="t">
            <thead><tr><th>{tr("Ieșire")}</th><th className="num">{tr("Între două ieșiri (mediană)")}</th><th className="num">{tr("Cel mai lung gol → distanță oarbă")}</th><th className="num">{tr("Latență p50 → distanță")}</th><th className="num">{tr("Latență p95")}</th><th className="num">{tr("Latență max")}</th></tr></thead>
            <tbody>
              {outputs.map((o) => {
                const e = a.edges.filter((x) => x.output === o.topic && x.kind === "exact").sort((x, y) => y.matchRate - x.matchRate)[0];
                const d = (ns: number) => `${fmt.ms(ns, 0)} ≈ ${fmtDistance(distanceM(ns, speed))}`;
                return (
                  <tr key={o.topic}>
                    <td className="mono">{o.topic}</td>
                    <td className="num">{d(o.rate.medianPeriodNs)}</td>
                    <td className="num" style={{ color: distanceM(o.rate.maxGapNs, speed) > 0.5 ? "var(--error)" : undefined }}>{d(o.rate.maxGapNs)}</td>
                    <td className="num">{e ? d(e.latencySummary.p50) : "—"}</td>
                    <td className="num">{e ? d(e.latencySummary.p95) : "—"}</td>
                    <td className="num">{e ? d(e.latencySummary.max) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Kv items={[["Referință", "un obstacol raportat cu latența L e la o distanță mai mică cu v·L decât arată ieșirea; un gol G înseamnă v·G metri fără percepție nouă"]]} />
      </Section>

      <Section title={`${tr("Cerințe critice pentru siguranță — profil")} ${s.profile === "strict" ? tr("Strict") : tr("Derivat")}`}>
        <div className="table-wrap" tabIndex={0}>
          <table className="t">
            <thead><tr><th>{tr("ID")}</th><th>{tr("Cerință")}</th><th>{tr("Verdict")}</th><th>{tr("De ce contează")}</th></tr></thead>
            <tbody>{safety.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td>{trField(r.title, r.title_en)}</td><td><StatusBadge kind={verdictKind(r.verdict)} /></td><td className="small">{r.rationale}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>„Utile” (nu critice): {other.map((r) => r.id).join(", ")}</p>
      </Section>

      <Section title={tr("Cele mai grave momente")} sub={tr("Ordonate după distanța parcursă „orbește” (gol de ieșire sau latență mare). Click → salt în replay.")}>
        <div className="table-wrap" tabIndex={0} style={{ maxHeight: 420 }}>
          <table className="t">
            <thead><tr><th className="num">#</th><th className="num">{tr("Când")}</th><th className="num">{tr("Durată")}</th><th className="num">{tr("Distanță")}</th><th>{tr("Ce s-a întâmplat")}</th></tr></thead>
            <tbody>
              {worst.map((w, i) => (
                <tr key={i} className="clickable" onClick={() => jumpTo(w.t, w.topics)}>
                  <td className="num">{i + 1}</td>
                  <td className="num">{fmt.s(w.t)}</td>
                  <td className="num">{fmt.ms(w.dur, 0)}</td>
                  <td className="num" style={{ color: distanceM(w.dur, speed) > 0.5 ? "var(--error)" : "var(--warn)" }}>{fmtDistance(distanceM(w.dur, speed))}</td>
                  <td className="small">{w.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
