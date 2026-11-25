/**
 * sensor_msgs/Image & CompressedImage panel. Draws the worker-converted RGBA (or the
 * decoded bitmap), shows the real pixel value under the cursor (in units), supports
 * depth colormaps with auto/manual range, and tells whether the displayed input frame
 * is the one used by the current output (causal highlight).
 */
import { useEffect, useRef, useState } from "react";
import { pixelReadout, pixelValue, type Colormap, type RosImage } from "../core/image";
import type { TopicData } from "../core/types";
import { effectiveDepth, indexAt } from "../state/actions";
import { useApp, useClock, type PanelConfig } from "../state/store";
import { PanelFrame } from "./PanelFrame";
import { useDecoded, usePanelIndex } from "./useMessage";
import { tr } from "../i18n";

/**
 * Draws an RGBA buffer or bitmap into a canvas, letter-boxed to the container.
 * Class maps (`classes`) are always resampled nearest-neighbour so labels never blend.
 */
export function drawImageFit(canvas: HTMLCanvasElement, src: { rgba?: Uint8ClampedArray; bitmap?: ImageBitmap; width?: number; height?: number; classes?: number }): { scale: number; ox: number; oy: number } | undefined {
  const parent = canvas.parentElement!;
  const W = parent.clientWidth, H = parent.clientHeight;
  const dpr = devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const iw = src.width ?? 0, ih = src.height ?? 0;
  if (!iw || !ih) return undefined;
  const scale = Math.min(W / iw, H / ih);
  const ox = (W - iw * scale) / 2, oy = (H - ih * scale) / 2;
  ctx.imageSmoothingEnabled = !src.classes && scale < 1;
  if (src.bitmap) ctx.drawImage(src.bitmap, ox, oy, iw * scale, ih * scale);
  else if (src.rgba) {
    const off = new OffscreenCanvas(iw, ih);
    off.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(src.rgba), iw, ih), 0, 0);
    ctx.drawImage(off, ox, oy, iw * scale, ih * scale);
  }
  return { scale, ox, oy };
}

/** "Used by output X" footer for input panels (causal highlight). */
export function UsageInfo({ topic, index }: { topic: TopicData; index: number }) {
  const a = useApp((s) => s.analysis);
  const cursor = useClock();
  const source = useApp((s) => s.timeSource);
  if (!a || index < 0) return null;
  const edges = a.edges.filter((e) => e.input === topic.topic && e.kind === "exact");
  if (!edges.length) return null;
  return (
    <>
      {edges.slice(0, 2).map((e) => {
        const ot = a.topics.find((t) => t.topic === e.output)!;
        const j = indexAt(ot, cursor, source);
        const used = j >= 0 ? e.inputIndex[j] : -1;
        const lag = used >= 0 ? index - used : NaN;
        return (
          <span key={e.output} data-tip={`The current output ${e.output} was produced from frame #${used + 1} of this topic`}>
            {used === index ? `✓ used by ${e.output}` : used >= 0 ? `${e.output} ← #${used + 1} (${lag} frames behind)` : `${e.output}: —`}
          </span>
        );
      })}
    </>
  );
}

export function ImagePanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const follow = cfg.options?.followOutput as string | undefined;
  const { index, matchedFrom } = usePanelIndex(topic, follow);
  const [cmap, setCmap] = useState<Colormap>((cfg.options?.colormap as Colormap) ?? "turbo");
  const [autoRange, setAutoRange] = useState(true);
  const depthUnit = useApp((s) => effectiveDepth(topic, s).unit);
  const depthMax = useApp((s) => effectiveDepth(topic, s).maxM);
  const depth = { unit: depthUnit, maxM: depthMax };
  const [range, setRange] = useState({ min: 0, max: 15 });
  const isDepthTopic = /16UC1|32FC1|mono16/i.test(topic.details["encoding"] ?? "");
  // raw units per metre: 16UC1 is mm unless the unit is overridden
  const scale = (depth.unit ?? (/16UC1|mono16/i.test(topic.details["encoding"] ?? "") ? "mm" : "m")) === "mm" ? 1000 : 1;
  // fixed display range for the whole recording: 0 – inferred valid maximum (or override); 0 = no data (black)
  const fixedMax = depth.maxM ?? 15;
  const render = isDepthTopic ? { colormap: cmap, range: autoRange ? { min: 0, max: fixedMax * scale } : { min: range.min * scale, max: range.max * scale } } : undefined;
  const { msg } = useDecoded(topic.topic, index, render);
  const canvas = useRef<HTMLCanvasElement>(null);
  const geom = useRef<{ scale: number; ox: number; oy: number }>();
  const [readout, setReadout] = useState("");

  useEffect(() => {
    if (!canvas.current || !msg) return;
    geom.current = drawImageFit(canvas.current, msg);
    const ro = new ResizeObserver(() => canvas.current && msg && (geom.current = drawImageFit(canvas.current, msg)));
    ro.observe(canvas.current.parentElement!);
    return () => ro.disconnect();
  }, [msg]);

  const onMove = (e: React.MouseEvent) => {
    const g = geom.current;
    if (!g || !msg?.msg) return;
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - g.ox) / g.scale);
    const y = Math.floor((e.clientY - r.top - g.oy) / g.scale);
    const img = msg.msg as RosImage;
    if (msg.rgba) setReadout(x >= 0 && y >= 0 && x < img.width && y < img.height ? `(${x}, ${y}) ${msg.classes ? `class ${pixelValue(img, x, y)}` : pixelReadout(img, x, y, isDepthTopic ? depth.unit : undefined)}` : "");
    else setReadout(x >= 0 && y >= 0 ? `(${x}, ${y})` : "");
  };

  const img = msg?.msg as RosImage | undefined;
  return (
    <PanelFrame
      cfg={cfg}
      topic={topic}
      index={index}
      shown={msg ? msg.index : -1}
      matchedFrom={matchedFrom}
      error={msg?.error}
      toolbar={
        isDepthTopic ? (
          <select className="input" style={{ minHeight: 26, padding: "0 4px", fontSize: 11 }} aria-label={tr("Colormap adâncime")} value={cmap} onChange={(e) => setCmap(e.target.value as Colormap)}>
            <option value="turbo">turbo</option>
            <option value="viridis">viridis</option>
            <option value="inferno">inferno</option>
            <option value="gray">gri</option>
          </select>
        ) : undefined
      }
      footer={
        <>
          <span>{msg?.width ? `${msg.width}×${msg.height} ${img?.encoding ?? (msg?.msg as { format?: string })?.format ?? ""}${msg.classes ? ` · class map, ${msg.classes} classes` : ""}` : ""}</span>
          <span style={{ color: "var(--text)" }}>{readout}</span>
          <UsageInfo topic={topic} index={msg ? msg.index : -1} />
        </>
      }
    >
      {index < 0 && !matchedFrom && <div className="panel-empty">{tr("Niciun mesaj până la acest moment")}</div>}
      {index < 0 && matchedFrom && <div className="panel-empty">{tr("Ieșirea curentă nu are un cadru de intrare corespunzător")}</div>}
      <canvas ref={canvas} onMouseMove={onMove} onMouseLeave={() => setReadout("")} aria-label={`Image ${topic.topic}`} role="img" />
      {isDepthTopic && (
        <div className="row xs" style={{ position: "absolute", left: 8, bottom: 6, background: "var(--surface)", padding: "2px 8px", borderRadius: 20, border: "1px solid var(--border)" }} onMouseDown={(e) => e.stopPropagation()}>
          <label className="row" style={{ gap: 4 }} data-tip="Fixed range for the whole recording: 0 – the observed valid maximum (Inventory → Inferred settings). Uncheck to set it here.">
            <input type="checkbox" checked={autoRange} onChange={(e) => setAutoRange(e.target.checked)} /> 0–{fixedMax} m
          </label>
          {!autoRange && (
            <>
              <input className="input mono" style={{ width: 54, minHeight: 22, padding: "0 4px" }} type="number" step="0.1" aria-label={tr("adâncime minimă (m)")} value={range.min} onChange={(e) => setRange({ ...range, min: +e.target.value })} />
              –
              <input className="input mono" style={{ width: 54, minHeight: 22, padding: "0 4px" }} type="number" step="0.1" aria-label={tr("adâncime maximă (m)")} value={range.max} onChange={(e) => setRange({ ...range, max: +e.target.value })} /> m
            </>
          )}
        </div>
      )}
    </PanelFrame>
  );
}
