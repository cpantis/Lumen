/** /styleguide — the .lumen design system on one page, for visual review before use. */
import { useState } from "react";
import { BrailleLoader, Logo, StatusBadge } from "../ui/primitives";
import { Plot } from "../ui/Plot";
import { tr } from "../i18n";

const TOKENS = ["--bg", "--surface", "--surface-2", "--border", "--text", "--text-muted", "--dot", "--accent", "--accent-2", "--ok", "--warn", "--error"];

export function StyleguideView() {
  const [x] = useState(() => Array.from({ length: 50 }, (_, i) => i * 1e8));
  const [series] = useState(() => [
    { label: "FOV 1", color: "var(--role-fov1)", values: x.map((_, i) => 60 + 10 * Math.sin(i / 5)) },
    { label: "FOV 2", color: "var(--role-fov2)", values: x.map((_, i) => 80 + 8 * Math.cos(i / 4)) },
  ]);
  return (
    <div className="view" id="main-content">
      <div className="view-title">
        <h2>{tr("Design system .lumen")}</h2>
        <span className="sub">{tr("Tokenuri, tipografie, componente — derivate din dotlumen.com și din logo")}</span>
      </div>
      <section className="card" style={{ marginBottom: 16 }}>
        <h3>Logo</h3>
        <div className="row wrap" style={{ gap: 32 }}>
          <div style={{ color: "var(--text)" }}><Logo height={40} /></div>
          <div style={{ background: "#fff", color: "#161619", padding: 16, borderRadius: 8 }}><Logo height={40} /></div>
          <div style={{ background: "#000", color: "#fff", padding: 16, borderRadius: 8 }}><Logo height={40} /></div>
          <BrailleLoader />
        </div>
      </section>
      <section className="card" style={{ marginBottom: 16 }}>
        <h3>{tr("Culori (tema curentă)")}</h3>
        <div className="grid-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
          {TOKENS.map((t) => (
            <div key={t}>
              <div className="swatch" style={{ background: `var(${t})` }} />
              <code className="xs">{t}</code>
            </div>
          ))}
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>{tr("Intrări = gri puncte · FOV 1 = mentă · FOV 2 = albastru. Culorile de stare se folosesc doar pentru stare, mereu cu iconiță + text.")}</p>
      </section>
      <section className="card" style={{ marginBottom: 16 }}>
        <h3>{tr("Tipografie")}</h3>
        <h1 style={{ fontSize: "3rem" }}>Pedestrian AI — Poppins 200</h1>
        <h2>{tr("Titlu secțiune — Poppins 300")}</h2>
        <h3>{tr("Subtitlu — Poppins 400")}</h3>
        <p>{tr("Text curent Poppins 400.")} <b>{tr("Etichete și butoane Poppins 500–600.")}</b></p>
        <p className="mono">JetBrains Mono · 12.345 s · 1763000000123456789 ns · /cam_front/depth</p>
      </section>
      <section className="card" style={{ marginBottom: 16 }}>
        <h3>{tr("Butoane, câmpuri, badge-uri")}</h3>
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <button className="btn primary">{tr("Principal")}</button>
          <button className="btn">{tr("Secundar")}</button>
          <button className="btn ghost">Ghost</button>
          <button className="btn danger">{tr("Pericol")}</button>
          <button className="btn" disabled>{tr("Dezactivat")}</button>
          <button className="btn sm">{tr("Mic")}</button>
          <div className="btn-group"><button className="btn sm" aria-pressed="true">{tr("Derivat")}</button><button className="btn sm" aria-pressed="false">{tr("Strict")}</button></div>
        </div>
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <input className="input" placeholder={tr("Câmp text")} aria-label={tr("exemplu câmp")} />
          <select className="input" aria-label={tr("exemplu select")}><option>{tr("Opțiune")}</option></select>
          <label className="row small"><input type="checkbox" defaultChecked /> {tr("bifă")}</label>
        </div>
        <div className="row wrap">
          {(["ok", "warn", "stale", "none", "empty", "invalid", "pass", "fail", "na"] as const).map((k) => <StatusBadge key={k} kind={k} />)}
        </div>
      </section>
      <section className="grid-2" style={{ marginBottom: 16 }}>
        <div className="panel" style={{ height: 220 }}>
          <div className="panel-head">
            <span className="role-bar" style={{ background: "var(--role-fov1)" }} />
            <div style={{ flex: 1 }}><div className="title">/cam_front/depth</div><div className="meta">sensor_msgs/Image · 13.43 Hz · ieșire cam_front</div></div>
            <StatusBadge kind="ok" />
          </div>
          <div className="panel-body"><div className="panel-empty">{tr("Corpul panoului")}</div></div>
          <div className="panel-foot"><span>160×120 16UC1</span><span>(80, 60) 4.213 m</span></div>
        </div>
        <div className="card">
          <h4>{tr("Grafic (uPlot) cu prag și zonă de încălcare")}</h4>
          <Plot x={x} series={series} time height={150} thresholds={[{ value: 85, label: "p95 limită" }]} shade={[[1.5e9, 2.2e9]]} />
        </div>
      </section>
      <div className="callout">{tr("Callout informativ")}</div>
      <div className="callout warn">{tr("Callout de avertizare")}</div>
      <div className="callout error">{tr("Callout de eroare")}</div>
    </div>
  );
}
