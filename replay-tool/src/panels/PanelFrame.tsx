/**
 * Common frame of every replay panel: header with role colour, topic, type, rate,
 * message age, index n/N and status (OK / late / stale / empty / invalid), plus
 * actions (inspect, follow output, options, remove). Status is always icon + text.
 */
import { Info, Link2, Settings2, X } from "lucide-react";
import type { ReactNode } from "react";
import { staleness } from "../core/sync";
import type { TopicData } from "../core/types";
import { effectiveFov, effectiveRole, topicColor } from "../state/actions";
import { app, useApp, type PanelConfig } from "../state/store";
import { fmt, StatusBadge, type StatusKind } from "../ui/primitives";
import { useAge } from "./useMessage";
import { tr } from "../i18n";

export function PanelFrame({
  cfg,
  topic,
  index: wanted,
  shown,
  title,
  matchedFrom,
  children,
  footer,
  toolbar,
  error,
}: {
  cfg: PanelConfig;
  topic?: TopicData;
  /** message the cursor asks for */
  index: number;
  /** message actually drawn (when the panel decodes asynchronously); defaults to `index` */
  shown?: number;
  title?: string;
  matchedFrom?: string;
  children: ReactNode;
  footer?: ReactNode;
  toolbar?: ReactNode;
  error?: string;
}) {
  // The header always describes what is DRAWN, never just what was requested: while the
  // requested message is still being decoded, index/age refer to the displayed one and the
  // status says "Loading", so a stale frame can never be mistaken for the current one.
  const index = shown ?? wanted;
  const pending = shown !== undefined && wanted >= 0 && shown !== wanted;
  const age = useAge(topic, index);
  const highlight = useApp((s) => s.highlightTopics.includes(cfg.topic) || (!!cfg.topic2 && s.highlightTopics.includes(cfg.topic2)));
  const a = useApp((s) => s.analysis);
  const s = useApp((st) => st);
  let status: StatusKind = "none";
  if (topic && index >= 0) {
    if (topic.content.decodeError[index] || topic.content.invalid[index] || error) status = "invalid";
    else if (topic.content.empty[index]) status = "empty";
    else status = matchedFrom ? "ok" : (staleness(age, topic.rate.medianPeriodNs) as StatusKind);
  }
  if (pending) status = "loading";
  const role = topic ? effectiveRole(topic, s) : "unknown";
  const fov = topic ? effectiveFov(topic, s) : undefined;
  const outputsOfInput = topic && a ? a.edges.filter((e) => e.input === topic.topic).map((e) => e.output) : [];
  const follow = cfg.options?.followOutput as string | undefined;

  const setOpt = (patch: Record<string, unknown>) =>
    app.set((st) => ({ panels: st.panels.map((p) => (p.id === cfg.id ? { ...p, options: { ...p.options, ...patch } } : p)) }));

  return (
    <div className={`panel${highlight ? " highlight" : ""}`} data-topic={cfg.topic} aria-label={`Panel ${title ?? cfg.topic}`}>
      <div className="panel-head drag-handle">
        <span className="role-bar" style={{ background: topic ? topicColor(topic, s) : "var(--role-unknown)" }} aria-hidden />
        <div className="head-text">
          <div className="title" title={title ?? cfg.topic}>
            {title ?? cfg.topic}
          </div>
          <div className="meta">
            {topic ? `${topic.type} · ${fmt.hz(topic.rate.meanHz)} · ${role === "input" ? "input" : role === "output" ? `output${fov ? ` ${fov}` : ""}` : "unknown"}` : ""}
          </div>
        </div>
        <div className="head-status">
          <StatusBadge kind={status} />
          <span className="meta" data-tip={tr("Indexul mesajului afișat / total · vârsta lui față de cursor")}>
            {topic ? `${index >= 0 ? index + 1 : "—"}/${topic.count}` : ""} {Number.isFinite(age) && index >= 0 ? `· ${fmt.ms(age, 0)}` : ""}
          </span>
        </div>
        <div className="row" style={{ gap: 0 }} onMouseDown={(e) => e.stopPropagation()}>
          {toolbar}
          {outputsOfInput.length > 0 && (
            <select
              className="input"
              style={{ minHeight: 26, padding: "0 4px", maxWidth: 120, fontSize: 11 }}
              aria-label={tr("Arată cadrul de intrare folosit de o ieșire")}
              data-tip={tr("Urmărește ieșirea: panoul arată exact cadrul de intrare din care a fost produsă ieșirea curentă")}
              value={follow ?? ""}
              onChange={(e) => setOpt({ followOutput: e.target.value || undefined })}
            >
              <option value="">{tr("cel mai recent")}</option>
              {outputsOfInput.map((o) => (
                <option key={o} value={o}>
                  ↔ {o}
                </option>
              ))}
            </select>
          )}
          <button className="btn icon sm ghost" aria-label={tr("Inspectează mesajul")} data-tip={tr("Inspectează mesajul în panoul lateral")} onClick={() => topic && index >= 0 && app.set({ inspector: { topic: topic.topic, index }, inspectorOpen: true })}>
            <Info size={15} />
          </button>
          {cfg.options && "settings" in (cfg.options ?? {}) ? (
            <button className="btn icon sm ghost" aria-label={tr("Opțiuni panou")} onClick={() => setOpt({ settings: !cfg.options?.settings })}>
              <Settings2 size={15} />
            </button>
          ) : null}
          <button className="btn icon sm ghost" aria-label={`Remove panel ${cfg.topic}`} data-tip={tr("Elimină panoul")} onClick={() => app.set((st) => ({ panels: st.panels.filter((p) => p.id !== cfg.id), layout: st.layout.filter((l) => l.i !== cfg.id) }))}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="panel-body">
        {children}
        {error && (
          <div className="panel-empty">
            <StatusBadge kind="invalid" label={tr("Nu pot decoda")} />
            <span>{error}</span>
          </div>
        )}
      </div>
      <div className="panel-foot">
        {matchedFrom && (
          <span className="row" style={{ gap: 4, color: "var(--accent)" }}>
            <Link2 size={12} /> frame used by {matchedFrom}
          </span>
        )}
        {footer}
      </div>
    </div>
  );
}
