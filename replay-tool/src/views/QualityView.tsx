/**
 * Content quality (2.4 content checks): per-message metrics over time — NaN, zero /
 * no-return, valid coverage, out-of-range, empty, identical repeated frames — with the
 * active profile's thresholds drawn as lines and violations shaded; aggregate table.
 */
import { useMemo, useState } from "react";
import type { TopicData } from "../core/types";
import { results, effectiveRole } from "../state/actions";
import { app, useApp } from "../state/store";
import { Plot } from "../ui/Plot";
import { fmt, Section } from "../ui/primitives";
import { tr } from "../i18n";

function aggregates(t: TopicData) {
  let empty = 0, invalid = 0, nan = 0, zero = 0, oor = 0, dup = 0, longestDup = 0, run = 0;
  for (let i = 0; i < t.count; i++) {
    empty += t.content.empty[i];
    invalid += t.content.invalid[i] | t.content.decodeError[i];
    nan += t.content.nanRatio[i];
    zero += t.content.zeroRatio[i];
    oor += t.content.outOfRangeRatio[i];
    if (i > 0 && t.content.hash[i] === t.content.hash[i - 1] && !t.content.empty[i]) {
      dup++;
      run++;
      longestDup = Math.max(longestDup, run + 1);
    } else run = 0;
  }
  const n = Math.max(1, t.count);
  return { empty: empty / n, invalid: invalid / n, nan: nan / n, zero: zero / n, oor: oor / n, dup: dup / n, longestDup, emptyN: empty, invalidN: invalid };
}

export function QualityView() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const [sel, setSel] = useState(a.topics.find((t) => effectiveRole(t, s) === "output")?.topic ?? a.topics[0]?.topic);
  const t = a.topics.find((x) => x.topic === sel);
  const res = results(s.profile, s);
  const req = (kind: string) => s.thresholds?.requirements.find((r) => r.kind === kind);
  const lim = (kind: string, key: string) => {
    const r = req(kind);
    const v = r?.[s.profile]?.[key];
    return typeof v === "number" ? v : undefined;
  };
  const shadeFor = (kind: string) => res.filter((r) => r.kind === kind).flatMap((r) => r.violations).filter((v) => v.topic === sel).map((v) => [v.startNs, v.endNs] as [number, number]);
  const valid = useMemo(() => (t ? Float32Array.from({ length: t.count }, (_, i) => (t.content.empty[i] ? NaN : 1 - t.content.nanRatio[i] - t.content.zeroRatio[i])) : new Float32Array()), [t]);
  const dup = useMemo(() => (t ? Float32Array.from({ length: t.count }, (_, i) => (i > 0 && t.content.hash[i] === t.content.hash[i - 1] && !t.content.empty[i] ? 1 : 0)) : new Float32Array()), [t]);
  const flags = useMemo(() => (t ? Float32Array.from({ length: t.count }, (_, i) => (t.content.decodeError[i] || t.content.invalid[i] ? 2 : t.content.empty[i] ? 1 : 0)) : new Float32Array()), [t]);

  const s1 = useMemo(() => (t ? [
    { label: "NaN/Inf", color: "var(--error)", values: t.content.nanRatio, width: 1 },
    { label: "zero / no return", color: "var(--warn)", values: t.content.zeroRatio, width: 1 },
    { label: "valid", color: "var(--accent)", values: valid, width: 1.5 },
  ] : []), [t, valid]);
  const s2 = useMemo(() => (t ? [{ label: "outside the plausible range", color: "var(--error)", values: t.content.outOfRangeRatio, width: 1 }] : []), [t]);
  const s3 = useMemo(() => (t ? [
    { label: "min", color: "var(--accent-2)", values: t.content.min, width: 1 },
    { label: "mean", color: "var(--accent)", values: t.content.mean, width: 1.5 },
    { label: "max", color: "var(--warn)", values: t.content.max, width: 1 },
  ] : []), [t]);
  const s4 = useMemo(() => (t ? [
    { label: "frame identical to the previous one", color: "var(--warn)", values: dup, points: true, width: 0 },
    { label: "empty(1) / invalid(2)", color: "var(--error)", values: flags, points: true, width: 0 },
    { label: "elements (points/pixels) / max", color: "var(--accent-2)", values: (() => { let m = 0; for (const v of t.content.elements) m = Math.max(m, v); return Float32Array.from(t.content.elements, (v) => v / (m || 1)); })(), width: 1 },
  ] : []), [t, dup, flags]);
  const th1 = useMemo(() => {
    const out: Array<{ value: number; label: string; color?: string }> = [];
    const n = lim("nan_max", "max_ratio");
    if (n !== undefined) out.push({ value: n, label: `NaN max ${fmt.pct(n, 0)}`, color: "var(--error)" });
    const v = lim("valid_min", "min_ratio");
    if (v !== undefined) out.push({ value: v, label: `valid min ${fmt.pct(v, 0)}`, color: "var(--accent)" });
    return out;
  }, [s.profile, s.thresholdsText]); // eslint-disable-line react-hooks/exhaustive-deps
  const th2 = useMemo(() => {
    const o = lim("out_of_range_max", "max_ratio");
    return o !== undefined ? [{ value: o, label: `max ${fmt.pct(o, 0)}`, color: "var(--error)" }] : [];
  }, [s.profile, s.thresholdsText]); // eslint-disable-line react-hooks/exhaustive-deps
  const unit = t && /Imu/.test(t.type) ? "|a| m/s²" : t && /Image/.test(t.type) && !/16UC1|32FC1/i.test(t.details["encoding"] ?? "") ? "intensity" : "m";

  return (
    <div className="view" id="main-content">
      <div className="view-title">
        <h2>{tr("Calitatea conținutului")}</h2>
        <span className="sub">{tr("Nu doar „a sosit mesajul?”, ci „ce conține?” — profil activ:")} <b>{s.profile === "strict" ? tr("Strict") : tr("Derivat")}</b></span>
        <span className="spacer" />
        <div className="btn-group" role="group" aria-label={tr("Profil de praguri")}>
          <button className="btn sm" aria-pressed={s.profile === "derived"} onClick={() => app.set({ profile: "derived" })}>{tr("Derivat")}</button>
          <button className="btn sm" aria-pressed={s.profile === "strict"} onClick={() => app.set({ profile: "strict" })}>{tr("Strict")}</button>
        </div>
      </div>
      <Section title={tr("Sumar pe topic")} sub={tr("Valori cumulate pe toată înregistrarea; click pe un rând pentru grafice în timp")}>
        <div className="table-wrap" tabIndex={0} style={{ maxHeight: 340 }}>
          <table className="t">
            <thead><tr><th>{tr("Topic")}</th><th className="num">{tr("Mesaje")}</th><th className="num">{tr("Goale")}</th><th className="num">{tr("Invalide")}</th><th className="num">{tr("NaN mediu")}</th><th className="num">{tr("Zero mediu")}</th><th className="num">{tr("În afara intervalului")}</th><th className="num">{tr("Cadre repetate")}</th><th className="num">{tr("Repetare max")}</th></tr></thead>
            <tbody>
              {a.topics.map((x) => {
                const g = aggregates(x);
                return (
                  <tr key={x.topic} className="clickable" aria-selected={x.topic === sel} onClick={() => setSel(x.topic)}>
                    <td className="mono">{x.topic}</td>
                    <td className="num">{x.count}</td>
                    <td className="num" style={{ color: g.emptyN ? "var(--warn)" : undefined }}>{g.emptyN} ({fmt.pct(g.empty)})</td>
                    <td className="num" style={{ color: g.invalidN ? "var(--error)" : undefined }}>{g.invalidN}</td>
                    <td className="num">{fmt.pct(g.nan)}</td>
                    <td className="num">{fmt.pct(g.zero)}</td>
                    <td className="num">{fmt.pct(g.oor, 2)}</td>
                    <td className="num">{fmt.pct(g.dup)}</td>
                    <td className="num">{g.longestDup}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
      {t && (
        <Section title={`${tr("Conținut în timp:")} ${t.topic}`} sub={tr("Liniile întrerupte = pragurile profilului activ; zonele hașurate roșu = încălcări. Click pe grafic → salt în replay.")}>
          <div className="grid-2">
            <Plot x={t.log} series={s1} time height={200} thresholds={th1} shade={[...shadeFor("nan_max"), ...shadeFor("valid_min")]} yRange={[0, 1]} title={tr("Proporții per mesaj (0–1)")} csvName={`${t.topic}_content`} />
            <Plot x={t.log} series={s2} time height={200} thresholds={th2} shade={shadeFor("out_of_range_max")} yRange={[0, 1]} title={tr("Valori în afara intervalului plauzibil (0–1)")} csvName={`${t.topic}_plausibility`} />
            <Plot x={t.log} series={s3} time height={200} title={`${tr("Min / medie / max ale valorilor valide")} (${unit})`} csvName={`${t.topic}_values`} />
            <Plot x={t.log} series={s4} time height={200} shade={[...shadeFor("duplicate_max"), ...shadeFor("empty_max"), ...shadeFor("invalid_max")]} title={tr("Cadre înghețate, goale, invalide; număr de elemente")} csvName={`${t.topic}_integrity`} />
          </div>
          <p className="xs muted">
            Method: images are evaluated on a deterministic sub-grid of ≤ 50,000 pixels; point clouds on every point (Euclidean distance in m); "identical" = FNV-1a hash over ≤ 4096 sampled bytes + length. Plausible ranges: {JSON.stringify(s.thresholds?.plausible_ranges)}.
          </p>
        </Section>
      )}
    </div>
  );
}
