/**
 * uPlot wrapper with the features every analysis plot needs:
 * - synchronised time cursor (vertical line at the replay time, click to seek)
 * - threshold lines (dashed, labelled) and shaded violation intervals
 * - theme-aware colours, resize to container, CSV export of the plotted data
 */
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { toCsv, download } from "../core/inventory";
import { clock } from "../state/store";
import { seek } from "../state/actions";
import { tr } from "../i18n";

export interface PlotSeries {
  label: string;
  color: string;
  values: ArrayLike<number>;
  points?: boolean;
  width?: number;
  dash?: number[];
}

export interface PlotProps {
  /** x values: relative ns (time plots) or arbitrary numbers (histograms) */
  x: ArrayLike<number>;
  series: PlotSeries[];
  height?: number;
  /** x is time in ns (axis in seconds, cursor & click-to-seek enabled) */
  time?: boolean;
  xLabel?: string;
  yLabel?: string;
  thresholds?: Array<{ value: number; label: string; color?: string }>;
  shade?: Array<[number, number]>;
  bars?: boolean;
  title?: string;
  csvName?: string;
  yRange?: [number, number];
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
function resolveColor(c: string): string {
  const m = /^var\((--[^)]+)\)$/.exec(c);
  return m ? cssVar(m[1]) : c;
}

export function Plot(props: PlotProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const { x, series, time, thresholds = [], shade = [], bars } = props;
    const xs = time ? Array.from(x, (v) => v / 1e9) : Array.from(x);
    const data: uPlot.AlignedData = [xs, ...series.map((s) => Array.from(s.values, (v) => (Number.isFinite(v) ? v : null)))] as uPlot.AlignedData;
    const text = cssVar("--text-muted");
    const grid = cssVar("--border");
    const opts: uPlot.Options = {
      width: Math.max(200, el.clientWidth),
      height: props.height ?? 200,
      legend: { show: true },
      cursor: { drag: { x: true, y: false, setScale: true } },
      scales: { x: { time: false }, y: props.yRange ? { range: props.yRange } : {} },
      axes: [
        { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, label: props.xLabel ?? (time ? "time (s)" : undefined), labelSize: 18, size: 36 },
        { stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, label: props.yLabel, labelSize: 18, size: 56 },
      ],
      series: [
        { label: time ? "t (s)" : (props.xLabel ?? "x"), value: (_u, v) => (v == null ? "—" : v.toFixed(3)) },
        ...series.map((s) => ({
          label: s.label,
          stroke: resolveColor(s.color),
          width: s.width ?? 1.5,
          dash: s.dash,
          fill: bars ? resolveColor(s.color) + "55" : undefined,
          paths: bars ? uPlot.paths.bars!({ size: [0.9, 100] }) : undefined,
          points: { show: s.points ?? false, size: 4 },
          value: (_u: uPlot, v: number | null) => (v == null ? "—" : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)),
        })),
      ],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            const { left, top, width, height } = u.bbox;
            ctx.save();
            // shaded violations
            ctx.fillStyle = cssVar("--error") + "33";
            for (const [a, b] of shade) {
              const xa = u.valToPos(time ? a / 1e9 : a, "x", true);
              const xb = u.valToPos(time ? b / 1e9 : b, "x", true);
              ctx.fillRect(Math.max(left, xa), top, Math.max(2, Math.min(left + width, xb) - Math.max(left, xa)), height);
            }
            // thresholds
            for (const th of thresholds) {
              const y = u.valToPos(th.value, "y", true);
              if (y < top || y > top + height) continue;
              ctx.strokeStyle = resolveColor(th.color ?? "var(--warn)");
              ctx.setLineDash([6, 4]);
              ctx.lineWidth = 1.5 * devicePixelRatio;
              ctx.beginPath();
              ctx.moveTo(left, y);
              ctx.lineTo(left + width, y);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.fillStyle = ctx.strokeStyle;
              ctx.font = `${11 * devicePixelRatio}px JetBrains Mono, monospace`;
              const tw = ctx.measureText(th.label).width;
              ctx.fillText(th.label, left + width - tw - 6 * devicePixelRatio, y - 4 * devicePixelRatio);
            }
            // replay cursor
            if (time) {
              const xc = u.valToPos(clock.get().t / 1e9, "x", true);
              if (xc >= left && xc <= left + width) {
                ctx.strokeStyle = cssVar("--accent");
                ctx.lineWidth = 2 * devicePixelRatio;
                ctx.beginPath();
                ctx.moveTo(xc, top);
                ctx.lineTo(xc, top + height);
                ctx.stroke();
              }
            }
            ctx.restore();
          },
        ],
      },
    };
    plot.current?.destroy();
    plot.current = new uPlot(opts, data, el);
    if (time) {
      const over = plot.current.over;
      const onClick = () => {
        const u = plot.current;
        if (!u || u.select.width > 2) return;
        const v = u.posToVal(u.cursor.left ?? 0, "x");
        if (Number.isFinite(v)) seek(v * 1e9);
      };
      over.addEventListener("click", onClick);
    }
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: Math.max(200, el.clientWidth), height: propsRef.current.height ?? 200 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // re-create when data identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.x, props.series, props.thresholds, props.shade, props.height, props.bars, props.time]);

  // redraw cursor on clock change (cheap: only the draw hook)
  useEffect(() => {
    if (!props.time) return;
    let last = 0;
    return clock.subscribe(() => {
      const now = performance.now();
      if (now - last < 50) return;
      last = now;
      plot.current?.redraw(false, false);
    });
  }, [props.time]);

  return (
    <figure style={{ margin: 0 }}>
      {(props.title || props.csvName) && (
        <figcaption className="row small" style={{ marginBottom: 4 }}>
          <span className="muted">{props.title}</span>
          <span className="spacer" />
          {props.csvName && (
            <button
              className="btn sm ghost"
              data-tip={tr("Export CSV al seriilor din grafic")}
              onClick={() => {
                const rows = Array.from(props.x, (xv, i) => {
                  const r: Record<string, unknown> = { [props.time ? "t_rel_s" : "x"]: props.time ? xv / 1e9 : xv };
                  props.series.forEach((s) => (r[s.label] = s.values[i]));
                  return r;
                });
                download(`${props.csvName}.csv`, toCsv(rows), "text/csv");
              }}
            >
              CSV
            </button>
          )}
        </figcaption>
      )}
      <div ref={wrap} role="img" aria-label={`${props.title ?? "plot"}: ${props.series.map((s) => s.label).join(", ")}`} />
    </figure>
  );
}
