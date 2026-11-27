/**
 * Timeline: one row per topic (grouped inputs / outputs per FOV), every message as a
 * tick (density-binned per pixel), gaps in red, empty/invalid messages marked,
 * requirement violations shaded, imported test-report failures, bugs and notes as
 * markers, A/B interval, replay cursor. Click/drag to scrub, Ctrl+wheel to zoom,
 * Shift+wheel to pan, double-click to reset zoom. Accessible as an ARIA slider.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TopicData } from "../core/types";
import { effectiveFov, effectiveRole, fovList, results, seek, setPlaying, topicColor } from "../state/actions";
import { app, clock, useApp, useClock } from "../state/store";
import { fmtRelS } from "../core/time";
import { features } from "../state/features";
import { lastAtOrBefore } from "../core/sync";
import { detectGaps } from "../core/stats";
import { tr } from "../i18n";

const LABEL_W = 210;
const ROW_H = 16;
const AXIS_H = 22;
const MARK_H = 14;

function cssVar(n: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}
function resolve(c: string) {
  const m = /^var\((--[^)]+)\)$/.exec(c);
  return m ? cssVar(m[1]) : c;
}

export function Timeline() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const cursor = useClock();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState<[number, number]>([0, a.durationNs]);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const dragging = useRef(false);

  useEffect(() => setView([0, a.durationNs]), [a]);

  // ordered rows: inputs, then outputs per FOV, then the rest
  const rows = useMemo(() => {
    const fovs = fovList(a, s);
    const group = (t: TopicData) => (effectiveRole(t, s) === "input" ? 0 : effectiveRole(t, s) === "output" ? 1 + Math.max(0, fovs.indexOf(effectiveFov(t, s) ?? "")) + (effectiveFov(t, s) ? 0 : fovs.length) : 99);
    return [...a.topics].sort((x, y) => group(x) - group(y) || x.topic.localeCompare(y.topic));
  }, [a, s.roleOverrides, s.fovOverrides]); // eslint-disable-line react-hooks/exhaustive-deps

  const gapsByTopic = useMemo(() => new Map(a.topics.map((t) => [t.topic, detectGaps(t.log, s.gapFactor, t.rate.medianPeriodNs)])), [a, s.gapFactor]);
  const violations = useMemo(() => (features.requirements ? results(s.profile, s).flatMap((r) => r.violations) : []), [s.profile, s.analysis, s.thresholdsText, s.roleOverrides, s.fovOverrides]); // eslint-disable-line react-hooks/exhaustive-deps
  const reportFailures = useMemo(() => (s.showReportMarkers ? s.reports.flatMap((r) => r.failures.map((f) => ({ ...f, report: r.name }))) : []), [s.reports, s.showReportMarkers]);

  const height = AXIS_H + MARK_H + rows.length * ROW_H + 4;
  const plotW = Math.max(50, width - LABEL_W - 8);
  const xOf = useCallback((t: number) => LABEL_W + ((t - view[0]) / (view[1] - view[0])) * plotW, [view, plotW]);
  const tOf = useCallback((x: number) => view[0] + ((x - LABEL_W) / plotW) * (view[1] - view[0]), [view, plotW]);

  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // static layer (everything except the cursor) — redrawn only when inputs change
  const staticLayer = useMemo(() => {
    const dpr = devicePixelRatio || 1;
    const off = document.createElement("canvas");
    off.width = width * dpr;
    off.height = height * dpr;
    const ctx = off.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const text = cssVar("--text"), muted = cssVar("--text-muted"), border = cssVar("--border"), err = cssVar("--error"), warn = cssVar("--warn"), surface2 = cssVar("--surface-2");
    ctx.font = "11px JetBrains Mono, monospace";
    // axis
    ctx.fillStyle = muted;
    ctx.strokeStyle = border;
    const span = view[1] - view[0];
    const stepS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300].find((st) => (st * 1e9 * plotW) / span > 70) ?? 600;
    for (let t = Math.ceil(view[0] / (stepS * 1e9)) * stepS * 1e9; t <= view[1]; t += stepS * 1e9) {
      const x = xOf(t);
      ctx.fillText(`${(t / 1e9).toFixed(stepS < 1 ? 1 : 0)}s`, x + 2, 14);
      ctx.beginPath();
      ctx.moveTo(x, AXIS_H - 4);
      ctx.lineTo(x, height);
      ctx.globalAlpha = 0.35;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // marker row: report failures, bugs, notes
    const my = AXIS_H;
    ctx.fillStyle = muted;
    if (features.requirements || features.issues) ctx.fillText(features.issues ? "reports · bugs · notes" : "reports", 8, my + 11);
    for (const f of reportFailures) {
      const x = xOf(f.startNs);
      if (x < LABEL_W || x > LABEL_W + plotW) continue;
      ctx.fillStyle = err;
      ctx.beginPath();
      ctx.moveTo(x, my + 2);
      ctx.lineTo(x + 4, my + 12);
      ctx.lineTo(x - 4, my + 12);
      ctx.fill();
    }
    for (const b of s.bugs) {
      const x = xOf(b.startNs);
      ctx.fillStyle = warn;
      ctx.fillRect(x - 3, my + 3, 7, 7);
    }
    for (const n of s.notes) {
      const x = xOf(n.t);
      ctx.fillStyle = cssVar("--accent-2");
      ctx.beginPath();
      ctx.arc(x, my + 7, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // rows
    rows.forEach((t, r) => {
      const y = AXIS_H + MARK_H + r * ROW_H;
      if (r % 2 === 0) {
        ctx.fillStyle = surface2;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(0, y, width, ROW_H);
        ctx.globalAlpha = 1;
      }
      const color = resolve(topicColor(t, s));
      ctx.fillStyle = color;
      ctx.fillRect(4, y + 3, 3, ROW_H - 6);
      ctx.fillStyle = text;
      const label = t.topic.length > 26 ? "…" + t.topic.slice(-25) : t.topic;
      ctx.fillText(label, 12, y + 12);
      // violation shading for this topic
      ctx.fillStyle = err;
      ctx.globalAlpha = 0.22;
      for (const v of violations) {
        if (v.topic !== t.topic && !v.topic.endsWith(` → ${t.topic}`)) continue;
        const xa = Math.max(LABEL_W, xOf(v.startNs)), xb = Math.min(LABEL_W + plotW, xOf(v.endNs));
        if (xb < LABEL_W || xa > LABEL_W + plotW) continue;
        ctx.fillRect(xa, y + 1, Math.max(2, xb - xa), ROW_H - 2);
      }
      ctx.globalAlpha = 1;
      // density-binned ticks
      const i0 = Math.max(0, lastAtOrBefore(t.log, view[0]));
      const i1 = lastAtOrBefore(t.log, view[1]);
      const bins = new Uint8Array(Math.ceil(plotW) + 1); // 1 normal, 2 empty, 3 invalid
      for (let i = i0; i <= i1; i++) {
        const px = Math.floor(xOf(t.log[i]) - LABEL_W);
        if (px < 0 || px >= bins.length) continue;
        const f = t.content.invalid[i] || t.content.decodeError[i] ? 3 : t.content.empty[i] ? 2 : 1;
        if (f > bins[px]) bins[px] = f;
      }
      for (let px = 0; px < bins.length; px++) {
        if (!bins[px]) continue;
        ctx.fillStyle = bins[px] === 3 ? err : bins[px] === 2 ? warn : color;
        const hh = bins[px] > 1 ? ROW_H - 2 : ROW_H - 8;
        ctx.fillRect(LABEL_W + px, y + (ROW_H - hh) / 2, 1, hh);
      }
      // gaps
      ctx.strokeStyle = err;
      ctx.lineWidth = 2;
      for (const g of gapsByTopic.get(t.topic) ?? []) {
        const xa = Math.max(LABEL_W, xOf(g.startNs)), xb = Math.min(LABEL_W + plotW, xOf(g.endNs));
        if (xb <= xa) continue;
        ctx.beginPath();
        ctx.moveTo(xa, y + ROW_H / 2);
        ctx.lineTo(xb, y + ROW_H / 2);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    });
    return off;
  }, [rows, width, height, view, violations, reportFailures, s.bugs, s.notes, gapsByTopic, xOf, plotW, s.roleOverrides, s.fovOverrides]); // eslint-disable-line react-hooks/exhaustive-deps

  // composite: static layer + A/B + cursor (cheap, every clock tick)
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    c.style.height = `${height}px`;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(staticLayer, 0, 0);
    ctx.scale(dpr, dpr);
    if (s.markA !== undefined || s.markB !== undefined) {
      const xa = s.markA !== undefined ? xOf(s.markA) : undefined;
      const xb = s.markB !== undefined ? xOf(s.markB) : undefined;
      ctx.fillStyle = cssVar("--accent-2");
      if (xa !== undefined && xb !== undefined) {
        ctx.globalAlpha = 0.14;
        ctx.fillRect(Math.min(xa, xb), AXIS_H, Math.abs(xb - xa), height);
        ctx.globalAlpha = 1;
      }
      ctx.font = "600 11px Poppins, sans-serif";
      for (const [x, l] of [[xa, "A"], [xb, "B"]] as const) {
        if (x === undefined) continue;
        ctx.fillRect(x - 1, AXIS_H, 2, height);
        ctx.fillText(l, x + 3, AXIS_H - 6);
      }
    }
    const x = xOf(cursor);
    ctx.fillStyle = cssVar("--accent");
    ctx.fillRect(x - 1, 0, 2, height);
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 8);
    ctx.fill();
  }, [staticLayer, cursor, s.markA, s.markB, width, height, xOf]);

  const describe = (mx: number, my: number): string => {
    const t = tOf(mx);
    if (my < AXIS_H) return fmtRelS(t);
    if (my < AXIS_H + MARK_H) {
      const near = (v: number) => Math.abs(xOf(v) - mx) < 5;
      const f = reportFailures.find((r) => near(r.startNs));
      if (f) return `[${f.report}] ${f.requirement} · ${f.topic}: ${f.message}`;
      const b = s.bugs.find((x) => near(x.startNs));
      if (b) return `Bug: ${b.title}`;
      const n = s.notes.find((x) => near(x.t));
      if (n) return `${n.tag}: ${n.text}`;
      return fmtRelS(t);
    }
    const r = Math.floor((my - AXIS_H - MARK_H) / ROW_H);
    const topic = rows[r];
    if (!topic) return "";
    const g = (gapsByTopic.get(topic.topic) ?? []).find((x) => t >= x.startNs && t <= x.endNs);
    if (g) return `${topic.topic}: gap of ${(g.durationNs / 1e6).toFixed(0)} ms (${fmtRelS(g.startNs)} → ${fmtRelS(g.endNs)})`;
    const v = violations.find((x) => (x.topic === topic.topic || x.topic.endsWith(` → ${topic.topic}`)) && t >= x.startNs - 2e7 && t <= x.endNs + 2e7);
    if (v) return `${v.requirement}: ${v.message}`;
    const i = lastAtOrBefore(topic.log, t);
    return `${topic.topic} · ${fmtRelS(t)} · message ${i + 1}/${topic.count}${i >= 0 && topic.content.empty[i] ? " · EMPTY" : ""}`;
  };

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>, kind: "down" | "move" | "up") => {
    const r = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (kind === "down" && mx > LABEL_W) {
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setPlaying(false);
      // clicking a marker jumps exactly to it
      if (my >= AXIS_H && my < AXIS_H + MARK_H) {
        const hit = [...reportFailures.map((f) => f.startNs), ...s.bugs.map((b) => b.startNs), ...s.notes.map((n) => n.t)].find((v) => Math.abs(xOf(v) - mx) < 5);
        if (hit !== undefined) return seek(hit);
      }
      seek(tOf(mx));
    } else if (kind === "move") {
      if (dragging.current) seek(tOf(mx));
      setHover(mx > 0 ? { x: e.clientX, y: e.clientY, text: describe(mx, my) } : null);
    } else if (kind === "up") dragging.current = false;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.shiftKey && !e.metaKey) return;
    e.preventDefault();
    const span = view[1] - view[0];
    if (e.shiftKey) {
      const d = (e.deltaY / 500) * span;
      const lo = Math.max(0, Math.min(a.durationNs - span, view[0] + d));
      setView([lo, lo + span]);
    } else {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const center = tOf(e.clientX - r.left);
      const k = e.deltaY > 0 ? 1.25 : 0.8;
      const ns = Math.max(5e7, Math.min(a.durationNs, span * k));
      const lo = Math.max(0, Math.min(a.durationNs - ns, center - ((center - view[0]) / span) * ns));
      setView([lo, lo + ns]);
    }
  };

  return (
    <div className="timeline" data-tour="timeline">
      <div className="timeline-scroll" onWheel={onWheel}>
        <canvas
          ref={canvas}
          role="slider"
          tabIndex={0}
          aria-label={tr("Timeline: poziția de redare")}
          aria-valuemin={0}
          aria-valuemax={Math.round(a.durationNs / 1e6)}
          aria-valuenow={Math.round(cursor / 1e6)}
          aria-valuetext={`${(cursor / 1e9).toFixed(1)} seconds of ${(a.durationNs / 1e9).toFixed(0)}`}
          onPointerDown={(e) => onPointer(e, "down")}
          onPointerMove={(e) => onPointer(e, "move")}
          onPointerUp={(e) => onPointer(e, "up")}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={() => setView([0, a.durationNs])}
          onKeyDown={(e) => {
            if (e.key === "Home") seek(0);
            if (e.key === "End") seek(a.durationNs);
          }}
        />
      </div>
      <div className="legend" aria-label={tr("Legendă timeline")}>
        <span><i className="chip-dot" style={{ background: "var(--role-input)" }} /> {tr("intrări")}</span>
        <span><i className="chip-dot" style={{ background: "var(--role-fov1)" }} /> {tr("ieșiri FOV 1")}</span>
        <span><i className="chip-dot" style={{ background: "var(--role-fov2)" }} /> {tr("ieșiri FOV 2")}</span>
        <span data-tip={`Gap: log-time interval between consecutive messages > ${s.gapFactor} × the topic's median log interval`} data-testid="gap-legend"><i style={{ display: "inline-block", width: 14, height: 2, background: "var(--error)" }} /> gap (log interval &gt; {s.gapFactor} × median)</span>
        <span><i className="chip-dot" style={{ background: "var(--warn)", borderRadius: 2 }} /> {features.issues ? tr("mesaj gol / bug") : "empty message"}</span>
        {features.requirements && <span><i style={{ display: "inline-block", width: 14, height: 10, background: "var(--error)", opacity: 0.3 }} /> requirement violation ({s.profile === "strict" ? "Strict" : "Derived"})</span>}
        {features.requirements && <span>{tr("▲ eșec din raport importat")}</span>}
        <span className="spacer" />
        <span>
          {view[0] > 0 || view[1] < a.durationNs ? `zoom ${fmtRelS(view[0], 1)}–${fmtRelS(view[1], 1)} · ` : ""}Ctrl+wheel zoom · Shift+wheel pan · double-click reset
        </span>
      </div>
      {hover?.text && (
        <div className="tooltip" style={{ left: Math.min(window.innerWidth - 340, hover.x + 12), top: hover.y - 36 }}>
          {hover.text}
        </div>
      )}
    </div>
  );
}

/** Current cursor time without subscribing (for event handlers). */
export const now = () => clock.get().t;
export { app };
