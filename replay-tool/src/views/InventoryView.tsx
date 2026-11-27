/**
 * Inventory (2.1): every stream with type, format, frame, rate statistics, jitter,
 * gaps, input/output classification with evidence (editable), per-topic regularity
 * plots, representative thumbnail, clock analysis, exports (Markdown / CSV / JSON).
 */
import { Download, FileCode2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { download, inventoryCsv, inventoryMarkdown, inventoryRows } from "../core/inventory";
import { histogram, instantRate, intervals } from "../core/stats";
import type { Role, TopicData } from "../core/types";
import { classificationJson, effectiveFov, effectiveRole, importClassification, jumpTo } from "../state/actions";
import { app, useApp } from "../state/store";
import { traceLine } from "../state/trace";
import { Plot } from "../ui/Plot";
import { FileButton, fmt, Kv, Modal, Section, Stat } from "../ui/primitives";
import { worker } from "../worker/client";
import { drawImageFit } from "../panels/ImagePanel";
import { parsePointCloud, type RosPointCloud2 } from "../core/pointcloud";
import { tr } from "../i18n";
import { InferencePanel } from "./InferencePanel";

function Thumbnail({ t }: { t: TopicData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!t.count) return;
    const mid = Math.floor(t.count / 2);
    worker.get(t.topic, mid, undefined, 0).then((m) => {
      const c = ref.current;
      if (!c) return;
      if (m.rgba || m.bitmap) drawImageFit(c, m);
      else if (t.type === "sensor_msgs/PointCloud2" && m.msg) {
        // top-down projection (x forward, y left)
        const p = parsePointCloud(m.msg as RosPointCloud2);
        const W = c.parentElement!.clientWidth, H = 160;
        c.width = W;
        c.height = H;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
        for (let i = 0; i < p.count; i++) {
          const x = p.positions[i * 3], y = p.positions[i * 3 + 1];
          if (Number.isFinite(x)) ctx.fillRect(W / 2 - y * 12, H - x * 12, 2, 2);
        }
        setText("top view (x forward, y left), 12 px/m");
      } else setText(JSON.stringify(m.msg, (_k, v) => (ArrayBuffer.isView(v) ? `[${(v as Uint8Array).length} values]` : typeof v === "bigint" ? v.toString() : v)).slice(0, 400));
    });
  }, [t]);
  return (
    <figure style={{ margin: 0 }}>
      <div style={{ position: "relative", height: 160, background: "var(--surface-2)", borderRadius: 8, overflow: "hidden" }}>
        <canvas ref={ref} role="img" aria-label={`Representative thumbnail ${t.topic}`} />
        {text && <pre className="xs mono" style={{ position: "absolute", inset: 0, margin: 0, padding: 8, whiteSpace: "pre-wrap", overflow: "auto" }}>{text}</pre>}
      </div>
      <figcaption className="xs muted">Message from the middle of the recording (#{Math.floor(t.count / 2) + 1})</figcaption>
    </figure>
  );
}

function TopicDetail({ t }: { t: TopicData }) {
  const iv = useMemo(() => Array.from(intervals(t.log), (v) => v / 1e6), [t]);
  const hist = useMemo(() => histogram(iv, 50), [iv]);
  const rate = useMemo(() => instantRate(t.log), [t]);
  const offset = useMemo(() => (t.clock ? Float64Array.from(t.log, (l, i) => (l - t.stamp[i]) / 1e6) : undefined), [t]);
  const histX = useMemo(() => hist.edges.slice(0, -1).map((e, i) => (e + hist.edges[i + 1]) / 2), [hist]);
  const histS = useMemo(() => [{ label: "intervals", color: "var(--accent-2)", values: hist.counts }], [hist]);
  const rateS = useMemo(() => [{ label: "instantaneous Hz (log)", color: "var(--accent)", values: rate.hz, width: 1 }], [rate]);
  const offS = useMemo(() => (offset ? [{ label: "log − stamp (ms)", color: "var(--accent-2)", values: offset, width: 1 }] : []), [offset]);
  const ths = useMemo(() => [{ value: t.rate.medianHz, label: `median ${fmt.hz(t.rate.medianHz)}`, color: "var(--text-muted)" }], [t]);
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="stats">
        <Stat value={t.count} label={tr("mesaje")} />
        <Stat value={fmt.hz(t.rate.meanHz)} label={tr("frecvență medie")} tip="(n−1) / duration" />
        <Stat value={fmt.hz(t.rate.medianHz)} label={tr("frecvență nominală")} tip="1 / median interval" />
        <Stat value={fmt.ms(t.rate.jitterNs, 2)} label={tr("jitter (σ interval)")} />
        <Stat value={fmt.ms(t.rate.maxGapNs)} label={tr("cel mai mare gol")} />
        <Stat value={t.gaps.length} label={tr("goluri")} />
      </div>
      <div className="grid-2">
        <Kv items={[["type", t.type], ["encoding", `${t.messageEncoding} / ${t.schemaEncoding}`], ["frame_id", t.frameIds.join(", ") || "—"], ["header", t.hasHeader ? "yes (std_msgs/Header)" : "no"], ...Object.entries(t.details).filter(([k]) => k !== "frame_id").map(([k, v]) => [k, v] as [string, string])]} />
        <Thumbnail t={t} />
      </div>
      {t.firstError && <div className="callout error">Decoding error: {t.firstError}</div>}
      <div className="grid-2">
        <Plot x={histX} series={histS} bars height={180} xLabel={tr("interval între mesaje (ms)")} title={tr("Histograma intervalelor")} csvName={`${t.topic}_intervals`} />
        <Plot x={rate.t} series={rateS} time height={180} title={tr("Frecvența instantanee în timp (click → salt)")} thresholds={ths} csvName={`${t.topic}_rate`} />
      </div>
      {t.clock && (
        <div className="grid-2">
          <div>
            <h4>{tr("Analiza ceasurilor")}</h4>
            <Kv
              items={[
                ["log − stamp median", fmt.ms(t.clock.offsetSummary.p50, 2)],
                ["log − stamp p95 / max", `${fmt.ms(t.clock.offsetSummary.p95, 2)} / ${fmt.ms(t.clock.offsetSummary.max, 2)}`],
                ["non-monotonic stamps", `${t.clock.nonMonotonic.length}`],
                ["duplicate stamps", `${t.clock.duplicates.length}`],
                ["stamps from the future", `${t.clock.future.length}`],
              ]}
            />
            {t.clock.nonMonotonic.slice(0, 5).map((i) => (
              <button key={i} className="btn sm ghost" onClick={() => jumpTo(t.log[i], [t.topic])}>
                non-monotonic at {fmt.s(t.log[i])} →
              </button>
            ))}
          </div>
          <Plot x={t.log} series={offS} time height={180} title={tr("log_time − header.stamp în timp")} csvName={`${t.topic}_offset`} />
        </div>
      )}
      {!t.clock && <p className="muted small">{tr("Topicul nu are std_msgs/Header: analiza ceasurilor nu se aplică.")}</p>}
    </div>
  );
}

export function InventoryView() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const [sel, setSel] = useState<string | undefined>(a.topics.find((t) => /Image/.test(t.type))?.topic ?? a.topics[0]?.topic);
  const [schemas, setSchemas] = useState<Array<{ name: string; encoding: string; text: string }>>();
  const rows = inventoryRows(a, (t) => effectiveRole(t, s), (t) => effectiveFov(t, s), (t) => (s.roleOverrides[t.topic] ? `edited manually (auto: ${t.autoRole} — ${t.roleReason})` : t.roleReason));
  const selected = a.topics.find((t) => t.topic === sel);
  const totalMsgs = a.topics.reduce((x, t) => x + t.count, 0);

  return (
    <div className="view" id="main-content">
      <div className="view-title">
        <h2>{tr("Inventarul înregistrării")}</h2>
        <span className="sub">{tr("2.1 · ce conține fișierul, cum e publicat fiecare flux, ce e intrare și ce e ieșire — și de ce")}</span>
      </div>
      {a.warnings.map((w) => <div key={w} className="callout warn">{w}</div>)}
      <Section
        title={a.fileName}
        sub={`SHA-256 ${a.sha256} · ${fmt.bytes(a.fileSize)} · ${a.indexed ? "indexed" : "not indexed"} · ${a.library}`}
        actions={
          <div className="row wrap">
            <button className="btn sm" onClick={() => download(`inventory-${a.fileName}.md`, inventoryMarkdown(a, rows, traceLine()), "text/markdown")}>
              <Download size={14} /> Markdown
            </button>
            <button className="btn sm" onClick={() => download(`inventory-${a.fileName}.csv`, inventoryCsv(rows), "text/csv")}>
              <Download size={14} /> CSV
            </button>
            <button className="btn sm" onClick={() => download(`classification-${a.fileName}.json`, classificationJson(), "application/json")} data-tip={tr("Exportă clasificarea I/O și FOV (inclusiv editările manuale)")}>
              <Download size={14} /> {tr("Clasificare JSON")}
            </button>
            <FileButton accept=".json" onText={(t) => importClassification(t)} tip="Import a previously saved classification">
              <Upload size={14} /> {tr("Importă clasificare")}
            </FileButton>
            <button className="btn sm" onClick={async () => setSchemas(await worker.schemas())}>
              <FileCode2 size={14} /> {tr("Scheme")}
            </button>
          </div>
        }
      >
        <div className="stats" style={{ marginBottom: 12 }}>
          <Stat value={fmt.s(a.durationNs, 2)} label={tr("durată")} />
          <Stat value={a.topics.length} label={tr("topicuri")} />
          <Stat value={totalMsgs.toLocaleString("ro-RO")} label={tr("mesaje")} />
          <Stat value={a.topics.filter((t) => effectiveRole(t, s) === "input").length} label={tr("intrări")} />
          <Stat value={a.topics.filter((t) => effectiveRole(t, s) === "output").length} label={tr("ieșiri")} />
          <Stat value={a.fovGroups.length} label={tr("câmpuri vizuale (FOV)")} />
        </div>
        <div className="table-wrap" tabIndex={0} style={{ maxHeight: 420 }}>
          <table className="t">
            <thead>
              <tr>
                <th>{tr("Topic")}</th>
                <th>{tr("Tip")}</th>
                <th className="num">{tr("Mesaje")}</th>
                <th className="num" data-tip="(n − 1) / (last − first log time)">Mean Hz (log)</th>
                <th className="num" data-tip="1 / max and 1 / min log interval">Hz min–max (log)</th>
                <th className="num" data-tip="Standard deviation of the log intervals">Jitter ms (log)</th>
                <th className="num" data-tip="Largest interval between consecutive log times">Max interval ms (log)</th>
                <th className="num" data-tip="Log intervals > 1.5 × the median log interval">Gaps (log)</th>
                <th className="num" data-tip="(n − 1) / (last − first) over the sorted unique header.stamps">Mean Hz (stamp)</th>
                <th className="num" data-tip="Largest interval between sorted unique header.stamps">Max interval ms (stamp)</th>
                <th className="num" data-tip="Stamp intervals > 1.5 × the median stamp interval">Gaps (stamp)</th>
                <th>{tr("Rol")}</th>
                <th>FOV</th>
                <th>{tr("Motivul clasificării")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.topic} className="clickable" aria-selected={sel === r.topic} onClick={() => setSel(r.topic)}>
                  <td className="mono">{r.topic}</td>
                  <td className="mono small">{r.type}</td>
                  <td className="num">{r.count}</td>
                  <td className="num">{r.meanHz}</td>
                  <td className="num">{r.minHz}–{r.maxHz}</td>
                  <td className="num">{r.jitterMs}</td>
                  <td className="num">{r.maxGapMs}</td>
                  <td className="num">{r.gaps}</td>
                  <td className="num">{r.stampMeanHz}</td>
                  <td className="num">{r.stampMaxIntervalMs}</td>
                  <td className="num">{r.gapsStamp}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select className="input" aria-label={`Role of ${r.topic}`} value={r.role} onChange={(e) => app.set((st) => ({ roleOverrides: { ...st.roleOverrides, [r.topic]: e.target.value as Role } }))}>
                      <option value="input">{tr("Intrare")}</option>
                      <option value="output">{tr("Ieșire")}</option>
                      <option value="unknown">{tr("Necunoscut")}</option>
                    </select>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input className="input mono" style={{ width: 110 }} aria-label={`FOV of ${r.topic}`} value={s.fovOverrides[r.topic] ?? (r.fov === "—" ? "" : r.fov)} placeholder="—" onChange={(e) => app.set((st) => ({ fovOverrides: { ...st.fovOverrides, [r.topic]: e.target.value } }))} />
                  </td>
                  <td className="small" style={{ minWidth: 280 }}>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="xs muted" style={{ marginTop: 8 }}>
          Rule: raw sensor types (Image, CompressedImage, Imu, CameraInfo) are inputs; a topic is an <b>output</b> when ≥ 50 % of its header.stamps exactly match an input's and it is logged a median &gt; 2 ms after it, and it never has a frame in a slot where that input is missing. Roles and FOVs can be edited (Inferred settings below); edits are saved locally for this file (by SHA-256), in the deep link and in exports.
        </p>
      </Section>
      <InferencePanel />
      {selected && (
        <Section title={`${tr("Detalii:")} ${selected.topic}`} sub={tr("Regularitatea pe toată înregistrarea, formatul și ceasurile")}>
          <TopicDetail t={selected} />
        </Section>
      )}
      {a.metadata.length > 0 && (
        <Section title={tr("Metadate din fișier")}>
          {a.metadata.map((m) => <Kv key={m.name} items={[[m.name, JSON.stringify(m.data)]]} />)}
        </Section>
      )}
      <p className="xs muted">{traceLine()}</p>
      {schemas && (
        <Modal title={tr("Schemele mesajelor (din fișier)")} onClose={() => setSchemas(undefined)} wide>
          {schemas.map((sc) => (
            <details key={sc.name} style={{ marginBottom: 8 }}>
              <summary className="mono">{sc.name} <span className="muted">({sc.encoding})</span></summary>
              <pre className="xs mono" style={{ whiteSpace: "pre-wrap", background: "var(--surface-2)", padding: 12, borderRadius: 8 }}>{sc.text}</pre>
            </details>
          ))}
        </Modal>
      )}
    </div>
  );
}
