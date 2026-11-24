/**
 * UI primitives of the .lumen design system: logo, buttons, status badges, modal,
 * global tooltips (data-tip), braille loader, key/value lists, file pickers.
 */
import { AlertTriangle, CheckCircle2, CircleSlash, Clock3, HelpCircle, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { tr } from "../i18n";

/**
 * `.lumen` logo: 4×3 braille-style dot grid + wordmark (recreated as inline SVG).
 * The wordmark is drawn with thin rounded strokes; colours follow the theme.
 */
export function Logo({ height = 22, title = ".lumen" }: { height?: number; title?: string }) {
  const dark = [
    [2, 0],
    [2, 1],
    [2, 2],
    [1, 2],
  ];
  const isDark = (c: number, r: number) => dark.some(([x, y]) => x === c && y === r);
  return (
    <svg height={height} viewBox="0 0 330 64" role="img" aria-label={title} style={{ display: "block" }}>
      <title>{title}</title>
      {Array.from({ length: 12 }, (_, k) => {
        const c = k % 4, r = Math.floor(k / 4);
        return <circle key={k} cx={10 + c * 20} cy={12 + r * 20} r={7.5} fill={isDark(c, r) ? "currentColor" : "#B2B2B2"} />;
      })}
      <g fill="none" stroke="currentColor" strokeWidth={5} strokeLinecap="butt">
        <rect x={92} y={56} width={6} height={6} fill="currentColor" stroke="none" />
        <path d="M110 2 V62" />
        <path d="M126 22 V46 a14 14 0 0 0 28 0 V22" />
        <path d="M168 62 V36 a12 12 0 0 1 24 0 V62 M192 36 a12 12 0 0 1 24 0 V62" />
        <path d="M232 44 H262 a15 15 0 1 0 -4 11" />
        <path d="M278 62 V36 a13 13 0 0 1 26 0 V62" />
      </g>
    </svg>
  );
}

export type StatusKind = "ok" | "warn" | "stale" | "none" | "empty" | "invalid" | "pass" | "fail" | "na";

/** Status badge — colour + icon + text (never colour alone, WCAG 1.4.1). */
export function StatusBadge({ kind, label }: { kind: StatusKind; label?: string }) {
  const map: Record<StatusKind, { cls: string; icon: ReactNode; text: string }> = {
    ok: { cls: "ok", icon: <CheckCircle2 aria-hidden />, text: "OK" },
    pass: { cls: "ok", icon: <CheckCircle2 aria-hidden />, text: "PASS" },
    warn: { cls: "warn", icon: <Clock3 aria-hidden />, text: "Late" },
    stale: { cls: "error", icon: <AlertTriangle aria-hidden />, text: "Stale" },
    fail: { cls: "error", icon: <XCircle aria-hidden />, text: "FAIL" },
    none: { cls: "neutral", icon: <CircleSlash aria-hidden />, text: "No data" },
    empty: { cls: "warn", icon: <CircleSlash aria-hidden />, text: "Empty" },
    invalid: { cls: "error", icon: <XCircle aria-hidden />, text: "Invalid" },
    na: { cls: "neutral", icon: <HelpCircle aria-hidden />, text: "N/A" },
  };
  const m = map[kind];
  return (
    <span className={`badge ${m.cls}`}>
      {m.icon}
      {label ?? m.text}
    </span>
  );
}

export function verdictKind(v: string): StatusKind {
  return v === "PASS" ? "pass" : v === "FAIL" ? "fail" : "na";
}

export function BrailleLoader({ label = "Loading" }: { label?: string }) {
  return (
    <span className="braille-loader" role="status" aria-label={label}>
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} style={{ animationDelay: `${(i % 4) * 0.12 + Math.floor(i / 4) * 0.05}s` }} />
      ))}
    </span>
  );
}

export function Modal({ title, onClose, children, wide, labelledBy }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>("input, button, select, textarea, [tabindex]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && el) {
        // focus trap
        const f = [...el.querySelectorAll<HTMLElement>("a, button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.hasAttribute("disabled"));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  const id = labelledBy ?? `m-${title.replace(/\W/g, "")}`;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} style={wide ? { width: "min(1100px, calc(100vw - 32px))" } : undefined}>
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button className="btn icon ghost" onClick={onClose} aria-label={tr("Închide")} data-tip={tr("Închide (Esc)")}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Global tooltip for every element with `data-tip` (mouse hover and keyboard focus). */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const show = (e: Event) => {
      const el = (e.target as HTMLElement)?.closest?.("[data-tip]") as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const text = el.dataset.tip!;
      const x = Math.min(window.innerWidth - 330, Math.max(8, r.left + r.width / 2 - 80));
      const y = r.bottom + 8 > window.innerHeight - 60 ? r.top - 40 : r.bottom + 8;
      setTip({ text, x, y });
    };
    const hide = (e: Event) => {
      const el = (e.target as HTMLElement)?.closest?.("[data-tip]");
      if (el) setTip(null);
    };
    document.addEventListener("mouseover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("mouseout", hide);
    document.addEventListener("focusout", hide);
    document.addEventListener("mousedown", () => setTip(null));
    return () => {
      document.removeEventListener("mouseover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("mouseout", hide);
      document.removeEventListener("focusout", hide);
    };
  }, []);
  if (!tip) return null;
  return (
    <div className="tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>
  );
}

export function Kv({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <FragmentKv key={k} k={k} v={v} />
      ))}
    </dl>
  );
}
function FragmentKv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export function Stat({ value, label, tip }: { value: ReactNode; label: string; tip?: string }) {
  return (
    <div className="stat" data-tip={tip}>
      <span className="v">{value}</span>
      <span className="l">{label}</span>
    </div>
  );
}

/** Button that opens a file picker and returns the file's text. */
export function FileButton({ accept, onText, onFile, children, className = "btn sm", tip }: { accept: string; onText?: (text: string, name: string) => void; onFile?: (f: File) => void; children: ReactNode; className?: string; tip?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={className} onClick={() => ref.current?.click()} data-tip={tip}>
        {children}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        aria-hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          onFile?.(f);
          if (onText) onText(await f.text(), f.name);
          e.target.value = "";
        }}
      />
    </>
  );
}

export function Section({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card" aria-label={title} style={{ marginBottom: "var(--space-4)" }}>
      <div className="row wrap" style={{ marginBottom: "var(--space-3)" }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <div className="spacer" />
        {actions}
      </div>
      {sub && <p className="muted small">{sub}</p>}
      {children}
    </section>
  );
}

export const fmt = {
  ms: (ns: number, d = 1) => (Number.isFinite(ns) ? `${(ns / 1e6).toFixed(d)} ms` : "—"),
  hz: (v: number) => (Number.isFinite(v) ? `${v.toFixed(2)} Hz` : "—"),
  pct: (v: number, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)} %` : "—"),
  s: (ns: number, d = 3) => (Number.isFinite(ns) ? `${(ns / 1e9).toFixed(d)} s` : "—"),
  n: (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—"),
  bytes: (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(1)} KB`),
};
