/**
 * Composite panels for 2.3:
 *  - OverlayPanel: projects a FOV's 3D output (point cloud) onto its camera image
 *    using CameraInfo/TF or manual/estimated calibration; live consistency metric.
 *  - DiffPanel: compares two images of the same FOV at the same moment — overlay
 *    with adjustable opacity, or a difference map when geometries match.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { colormap, type RosImage, pixelValue } from "../core/image";
import { parsePointCloud, type RosPointCloud2 } from "../core/pointcloud";
import { consistency, projectPoints, type Calibration } from "../core/projection";
import type { TopicData } from "../core/types";
import { autoCalibration, fovTopics } from "../state/calibration";
import { effectiveFov } from "../state/actions";
import { app, useApp, type PanelConfig } from "../state/store";
import { fmt } from "../ui/primitives";
import { drawImageFit } from "./ImagePanel";
import { PanelFrame } from "./PanelFrame";
import { useDecoded, usePanelIndex } from "./useMessage";
import { tr } from "../i18n";

export function OverlayPanel({ cfg, topic, cloud }: { cfg: PanelConfig; topic: TopicData; cloud?: TopicData }) {
  const a = useApp((s) => s.analysis)!;
  const fov = (cloud && effectiveFov(cloud)) ?? effectiveFov(topic) ?? "";
  const stored = useApp((s) => s.calibrations[fov]);
  const [auto, setAuto] = useState<Calibration>();
  const cal = stored ?? auto;
  const { index: ci } = usePanelIndex(cloud);
  // show the camera frame with the same stamp as the cloud (exact pairing)
  const imgIndex = useMemo(() => {
    if (!cloud || ci < 0) return -1;
    const s = cloud.stamp[ci];
    for (let i = 0; i < topic.count; i++) if (topic.stamp[i] === s) return i;
    return -1;
  }, [cloud, ci, topic]);
  const { msg: img } = useDecoded(topic.topic, imgIndex);
  const { msg: pc } = useDecoded(cloud?.topic, ci);
  const ft = useMemo(() => fovTopics(a, fov), [a, fov]);
  const { msg: depthMsg } = useDecoded(ft.depth?.topic, useMemo(() => {
    if (!ft.depth || !cloud || ci < 0) return -1;
    const s = cloud.stamp[ci];
    for (let i = 0; i < ft.depth.count; i++) if (ft.depth.stamp[i] === s) return i;
    return -1;
  }, [ft, cloud, ci]));
  const canvas = useRef<HTMLCanvasElement>(null);
  const [metric, setMetric] = useState<ReturnType<typeof consistency>>();
  const [alpha, setAlpha] = useState(0.9);

  useEffect(() => {
    if (!stored && fov) autoCalibration(a, ft).then(setAuto).catch(() => undefined);
  }, [a, fov, ft, stored]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const g = drawImageFit(c, img);
    if (!g || !pc?.msg || !cal) return;
    const parsed = parsePointCloud(pc.msg as RosPointCloud2);
    const p = projectPoints(parsed.positions, cal);
    const ctx = c.getContext("2d")!;
    ctx.globalAlpha = alpha;
    for (let k = 0; k < p.u.length; k++) {
      if (!Number.isFinite(p.u[k])) continue;
      const [r, gg, b] = colormap("turbo", Math.min(1, p.depth[k] / 15));
      ctx.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
      ctx.fillRect(g.ox + p.u[k] * g.scale - 1.5, g.oy + p.v[k] * g.scale - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
    const d = depthMsg?.msg as RosImage | undefined;
    const sc = d && /16UC1/i.test(d.encoding) ? 0.001 : 1;
    setMetric(consistency(parsed.positions, cal, d ? (u, v) => pixelValue(d, u, v) * sc : undefined));
  }, [img, pc, cal, alpha, depthMsg]);

  return (
    <PanelFrame
      cfg={cfg}
      topic={cloud ?? topic}
      index={ci}
      title={`Projection ${cloud?.topic ?? "?"} → ${topic.topic}`}
      toolbar={<input type="range" min={0.1} max={1} step={0.05} value={alpha} onChange={(e) => setAlpha(+e.target.value)} aria-label={tr("Opacitate puncte")} data-tip={tr("Opacitatea punctelor proiectate")} style={{ width: 60 }} />}
      footer={
        <>
          <span data-tip={cal?.note}>calibration: {cal?.source ?? "…"}</span>
          {metric && <span>in image {fmt.pct(metric.inImageRatio)}</span>}
          {metric && Number.isFinite(metric.medianRelError) && (
            <span style={{ color: metric.medianRelError > 0.05 ? "var(--error)" : "var(--ok)" }} data-tip={`Median relative error |Z_cloud − Z_depth| / Z_depth over ${metric.compared} common pixels`}>
              median depth error {fmt.pct(metric.medianRelError)} (p90 {fmt.pct(metric.p90RelError)})
            </span>
          )}
          <button className="btn sm ghost" onClick={() => app.set({ view: "consistency" })}>
            {tr("calibrare…")}
          </button>
        </>
      }
    >
      <canvas ref={canvas} role="img" aria-label={tr("Proiecția norului de puncte peste imagine")} />
      {imgIndex < 0 && <div className="panel-empty">{tr("Niciun cadru de cameră cu același stamp ca norul curent")}</div>}
    </PanelFrame>
  );
}

export function DiffPanel({ cfg, a: ta, b: tb }: { cfg: PanelConfig; a: TopicData; b?: TopicData }) {
  const { index: ia } = usePanelIndex(ta);
  const ib = useMemo(() => {
    if (!tb || ia < 0) return -1;
    const s = ta.stamp[ia];
    for (let i = 0; i < tb.count; i++) if (tb.stamp[i] === s) return i;
    return -1;
  }, [ta, tb, ia]);
  const { msg: ma } = useDecoded(ta.topic, ia);
  const { msg: mb } = useDecoded(tb?.topic, ib);
  const [mode, setMode] = useState<"overlay" | "diff">("overlay");
  const [opacity, setOpacity] = useState(0.5);
  const [stat, setStat] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !ma) return;
    const sameGeom = mb && ma.width === mb.width && ma.height === mb.height && ma.rgba && mb.rgba;
    if (mode === "diff" && sameGeom) {
      const w = ma.width!, h = ma.height!;
      const out = new Uint8ClampedArray(w * h * 4);
      const A = ma.msg as RosImage, B = mb!.msg as RosImage;
      let sum = 0, n = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const va = pixelValue(A, x, y), vb = pixelValue(B, x, y);
          const o = (y * w + x) * 4;
          out[o + 3] = 255;
          if (!Number.isFinite(va) || !Number.isFinite(vb) || va === 0 || vb === 0) continue;
          const d = Math.abs(va - vb) / Math.max(Math.abs(va), 1e-9);
          sum += d;
          n++;
          const [r, g, b] = colormap("inferno", Math.min(1, d * 5));
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
        }
      drawImageFit(c, { rgba: out, width: w, height: h });
      setStat(`mean relative difference ${fmt.pct(n ? sum / n : NaN)} over ${n} pixels`);
    } else {
      const g = drawImageFit(c, ma);
      if (g && mb && (mb.rgba || mb.bitmap)) {
        const ctx = c.getContext("2d")!;
        ctx.globalAlpha = opacity;
        const off = new OffscreenCanvas(mb.width!, mb.height!);
        if (mb.rgba) off.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(mb.rgba), mb.width!, mb.height!), 0, 0);
        ctx.drawImage(mb.bitmap ?? off, g.ox, g.oy, ma.width! * g.scale, ma.height! * g.scale);
        ctx.globalAlpha = 1;
      }
      setStat(mode === "diff" ? "different geometries: difference map not available" : "");
    }
  }, [ma, mb, mode, opacity]);

  return (
    <PanelFrame
      cfg={cfg}
      topic={ta}
      index={ia}
      title={`Comparison ${ta.topic} ⇄ ${tb?.topic ?? "?"}`}
      toolbar={
        <>
          <div className="btn-group">
            <button className="btn sm" aria-pressed={mode === "overlay"} onClick={() => setMode("overlay")}>
              {tr("suprapunere")}
            </button>
            <button className="btn sm" aria-pressed={mode === "diff"} onClick={() => setMode("diff")}>
              {tr("diferență")}
            </button>
          </div>
          {mode === "overlay" && <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} aria-label={tr("Transparență imagine B")} style={{ width: 60 }} />}
        </>
      }
      footer={<span>{ib < 0 ? "B: no message with the same stamp" : stat}</span>}
    >
      <canvas ref={canvas} role="img" aria-label={tr("Comparație între două ieșiri")} />
    </PanelFrame>
  );
}
