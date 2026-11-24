/**
 * Non-3D panels: IMU (time series of acceleration / angular velocity / orientation),
 * CameraInfo (text), OccupancyGrid & LaserScan (2D canvas), the generic fallback
 * (JSON tree + plot any numeric field) and plot panels for a chosen field path.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TopicData } from "../core/types";
import { worker } from "../worker/client";
import { app, uid, type PanelConfig } from "../state/store";
import { Plot } from "../ui/Plot";
import { Kv } from "../ui/primitives";
import { PanelFrame } from "./PanelFrame";
import { useDecoded, usePanelIndex } from "./useMessage";
import { quatToRpy } from "../core/projection";
import { tr } from "../i18n";

/** Fetches a numeric series for (topic, path) once and caches it module-wide. */
const seriesCache = new Map<string, Promise<{ t: Float64Array; v: Float64Array; truncated: boolean }>>();
export function useSeries(topic: string, paths: string[]) {
  const [data, setData] = useState<Array<{ t: Float64Array; v: Float64Array; truncated: boolean }> | undefined>();
  const key = paths.join("|");
  useEffect(() => {
    let alive = true;
    Promise.all(
      paths.map((p) => {
        const k = `${topic}::${p}`;
        if (!seriesCache.has(k)) seriesCache.set(k, worker.series(topic, p, 30000));
        return seriesCache.get(k)!;
      }),
    ).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, key]);
  return data;
}
export function clearSeriesCache(): void {
  seriesCache.clear();
}

export function ImuPanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const { index } = usePanelIndex(topic);
  const [mode, setMode] = useState<"acc" | "gyro" | "rpy">("acc");
  const paths =
    mode === "acc"
      ? ["linear_acceleration.x", "linear_acceleration.y", "linear_acceleration.z"]
      : mode === "gyro"
        ? ["angular_velocity.x", "angular_velocity.y", "angular_velocity.z"]
        : ["orientation.x", "orientation.y", "orientation.z", "orientation.w"];
  const data = useSeries(topic.topic, paths);
  const series = useMemo(() => {
    if (!data) return undefined;
    const colors = ["#ff5a60", "#77e8ca", "#7f8cff"];
    if (mode === "rpy") {
      const n = data[0].t.length;
      const r = new Float64Array(n), p = new Float64Array(n), y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const e = quatToRpy({ x: data[0].v[i], y: data[1].v[i], z: data[2].v[i], w: data[3].v[i] });
        r[i] = e.roll;
        p[i] = e.pitch;
        y[i] = e.yaw;
      }
      return { x: data[0].t, s: [r, p, y].map((v, i) => ({ label: ["roll", "pitch", "yaw"][i] + " (rad)", color: colors[i], values: v })) };
    }
    return { x: data[0].t, s: data.map((d, i) => ({ label: `${"xyz"[i]} (${mode === "acc" ? "m/s²" : "rad/s"})`, color: colors[i], values: d.v })) };
  }, [data, mode]);
  return (
    <PanelFrame
      cfg={cfg}
      topic={topic}
      index={index}
      toolbar={
        <div className="btn-group" role="group" aria-label={tr("Mărime IMU")}>
          {(["acc", "gyro", "rpy"] as const).map((m) => (
            <button key={m} className="btn sm" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "acc" ? "accel" : m === "gyro" ? "gyro" : "rpy"}
            </button>
          ))}
        </div>
      }
      footer={<span>current |a| {index >= 0 ? `${topic.content.min[index].toFixed(2)} m/s²` : "—"}</span>}
    >
      <div className="panel-body scroll" tabIndex={0} style={{ position: "absolute", inset: 0, padding: 4 }}>
        {series ? <Plot x={series.x} series={series.s} time height={170} csvName={`${topic.topic.replace(/\W/g, "_")}_${mode}`} /> : <div className="skeleton" style={{ height: 160 }} />}
      </div>
    </PanelFrame>
  );
}

export function CameraInfoPanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const { index } = usePanelIndex(topic);
  const { msg } = useDecoded(topic.topic, index);
  const m = msg?.msg as { width: number; height: number; distortion_model: string; d: number[]; k: number[]; p: number[]; header: { frame_id: string } } | undefined;
  const arr = (a?: ArrayLike<number>) => (a ? `[${Array.from(a).map((v) => (+v).toFixed(2)).join(", ")}]` : "—");
  return (
    <PanelFrame cfg={cfg} topic={topic} index={index} shown={msg ? msg.index : -1} error={msg?.error}>
      <div className="panel-body scroll" tabIndex={0} style={{ position: "absolute", inset: 0, padding: 12 }}>
        {m && (
          <Kv
            items={[
              ["frame_id", m.header.frame_id],
              ["resolution", `${m.width}×${m.height}`],
              ["distortion", m.distortion_model],
              ["D", arr(m.d)],
              ["K", arr(m.k)],
              ["P", arr(m.p)],
            ]}
          />
        )}
      </div>
    </PanelFrame>
  );
}

export function GridPanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const { index } = usePanelIndex(topic);
  const { msg } = useDecoded(topic.topic, index);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const m = msg?.msg as { info: { width: number; height: number; resolution: number }; data: ArrayLike<number> } | undefined;
    const c = canvas.current;
    if (!c || !m) return;
    const { width: w, height: h } = m.info;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = m.data[i];
      const y = h - 1 - Math.floor(i / w), x = i % w; // ROS grid origin bottom-left
      const o = (y * w + x) * 4;
      const g = v < 0 ? 90 : 255 - Math.round((v / 100) * 255);
      img.data[o] = v < 0 ? 60 : g;
      img.data[o + 1] = v < 0 ? 60 : g;
      img.data[o + 2] = v < 0 ? 80 : g;
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [msg]);
  return (
    <PanelFrame cfg={cfg} topic={topic} index={index} shown={msg ? msg.index : -1} error={msg?.error} footer={<span>{tr("gri = necunoscut, negru = ocupat")}</span>}>
      <canvas ref={canvas} style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated" }} role="img" aria-label={tr("Grilă de ocupare")} />
    </PanelFrame>
  );
}

export function ScanPanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const { index } = usePanelIndex(topic);
  const { msg } = useDecoded(topic.topic, index);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const m = msg?.msg as { angle_min: number; angle_increment: number; range_max: number; ranges: ArrayLike<number> } | undefined;
    const c = canvas.current;
    if (!c || !m) return;
    const W = c.parentElement!.clientWidth, H = c.parentElement!.clientHeight;
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    const s = Math.min(W, H) / 2 / (m.range_max || 10);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    for (let i = 0; i < m.ranges.length; i++) {
      const r = m.ranges[i];
      if (!Number.isFinite(r)) continue;
      const a = m.angle_min + i * m.angle_increment;
      ctx.fillRect(W / 2 + Math.sin(-a) * r * s, H / 2 - Math.cos(a) * r * s, 2, 2);
    }
  }, [msg]);
  return (
    <PanelFrame cfg={cfg} topic={topic} index={index} shown={msg ? msg.index : -1} error={msg?.error}>
      <canvas ref={canvas} role="img" aria-label={tr("Scanare laser")} />
    </PanelFrame>
  );
}

/** Collapsible JSON tree; numeric leaves get a "plot" button that opens a plot panel. */
export function JsonTree({ value, topic, path = "", depth = 0 }: { value: unknown; topic?: string; path?: string; depth?: number }) {
  if (value === null || value === undefined) return <span className="v">{String(value)}</span>;
  if (ArrayBuffer.isView(value)) {
    const arr = value as unknown as ArrayLike<number>;
    return (
      <span className="v">
        {(value as object).constructor.name}[{arr.length}] {Array.from(arr.length > 16 ? Array.prototype.slice.call(arr, 0, 16) : arr).join(", ")}
        {arr.length > 16 ? "…" : ""}
      </span>
    );
  }
  if (typeof value !== "object") {
    const plottable = typeof value === "number" || typeof value === "bigint";
    return (
      <span className="v">
        {typeof value === "string" ? `"${value}"` : String(value)}
        {plottable && topic && (
          <button
            className="path-btn"
            aria-label={`Plot ${path}`}
            data-tip={`Plot ${path} over time`}
            onClick={() => {
              const id = uid();
              app.set((s) => ({ panels: [...s.panels, { id, topic, kind: "plot", path }], layout: [...s.layout, { i: id, x: 0, y: 999, w: 6, h: 5, minW: 2, minH: 3 }], view: "replay" }));
            }}
          >
            ⌁
          </button>
        )}
      </span>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const shown = entries.slice(0, 200);
  return (
    <details open={depth < 2}>
      <summary>
        <span className="k">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </summary>
      {shown.map(([k, v]) => (
        <div key={k} style={{ marginLeft: 12 }}>
          <span className="k">{k}: </span>
          <JsonTree value={v} topic={topic} path={Array.isArray(value) ? `${path}[${k}]` : path ? `${path}.${k}` : k} depth={depth + 1} />
        </div>
      ))}
      {entries.length > shown.length && <div className="muted">… {entries.length - shown.length} more</div>}
    </details>
  );
}

export function GenericPanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const { index } = usePanelIndex(topic);
  const { msg } = useDecoded(topic.topic, index);
  return (
    <PanelFrame cfg={cfg} topic={topic} index={index} shown={msg ? msg.index : -1} error={msg?.error} footer={<span>{tr("apasă ⌁ lângă un câmp numeric pentru grafic în timp")}</span>}>
      <div className="panel-body scroll json" tabIndex={0} style={{ position: "absolute", inset: 0, padding: 8 }}>
        {msg?.msg !== undefined ? <JsonTree value={msg.msg} topic={topic.topic} /> : index < 0 ? <div className="panel-empty">{tr("Niciun mesaj până la acest moment")}</div> : null}
      </div>
    </PanelFrame>
  );
}

export function PlotPanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const { index } = usePanelIndex(topic);
  const data = useSeries(topic.topic, [cfg.path ?? ""]);
  const series = useMemo(() => (data ? [{ label: cfg.path ?? "", color: "var(--accent)", values: data[0].v }] : undefined), [data, cfg.path]);
  return (
    <PanelFrame cfg={cfg} topic={topic} index={index} title={`${cfg.topic} · ${cfg.path}`} footer={data?.[0].truncated ? <span>{tr("eșantionat pentru afișare (metricile folosesc datele complete)")}</span> : null}>
      <div className="panel-body scroll" tabIndex={0} style={{ position: "absolute", inset: 0, padding: 4 }}>
        {data && series ? <Plot x={data[0].t} series={series} time height={180} csvName={`${topic.topic.replace(/\W/g, "_")}_${(cfg.path ?? "").replace(/\W/g, "_")}`} /> : <div className="skeleton" style={{ height: 160 }} />}
      </div>
    </PanelFrame>
  );
}
