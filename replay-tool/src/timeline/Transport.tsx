/** Playback controls: play/pause, frame stepping, speed, A/B loop, time source, jump to time. */
import { ChevronLeft, ChevronRight, Flag, Pause, Play, Repeat, StickyNote, Bug as BugIcon } from "lucide-react";
import { useState } from "react";
import { fmtUtcNs, parseTimeInput } from "../core/time";
import { useT } from "../i18n";
import { seek, setPlaying, step, togglePlay } from "../state/actions";
import { app, clock, useApp, useClock } from "../state/store";
import { openBugDraft, openNoteDraft } from "../views/bugs";
import { features } from "../state/features";
import { tr } from "../i18n";

export function Transport() {
  const T = useT();
  const s = useApp((st) => st);
  const a = s.analysis!;
  const cursor = useClock();
  const [jump, setJump] = useState("");
  const abs = BigInt(a.startNs) + BigInt(Math.round(cursor));
  return (
    <div className="transport" role="toolbar" aria-label={tr("Controale de redare")} data-tour="transport">
      <button className="btn icon" onClick={() => step(-1)} aria-label={T.stepBack} data-tip={`${T.stepBack} (←)`}>
        <ChevronLeft size={18} />
      </button>
      <button className="btn icon primary" onClick={togglePlay} aria-label={s.playing ? T.pause : T.play} data-tip={`${s.playing ? T.pause : T.play} (Space)`}>
        {s.playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <button className="btn icon" onClick={() => step(1)} aria-label={T.stepFwd} data-tip={`${T.stepFwd} (→)`}>
        <ChevronRight size={18} />
      </button>
      <div className="time-display" aria-live="off">
        <span className="num">
          {(cursor / 1e9).toFixed(3)} s <span className="muted">/ {(a.durationNs / 1e9).toFixed(3)} s</span>
        </span>
        <span className="abs" data-tip={tr("Timp absolut UTC, cu precizie de nanosecundă")}>
          {fmtUtcNs(abs)} · {abs.toString()} ns
        </span>
      </div>
      <label className="row small">
        <span className="sr-only">{T.speed}</span>
        <select className="input" value={s.speed} onChange={(e) => app.set({ speed: +e.target.value })} aria-label={T.speed} data-tip={`${T.speed} ([ / ])`}>
          {[0.1, 0.25, 0.5, 1, 2, 4].map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
      </label>
      <select className="input" value={s.stepTopic ?? ""} onChange={(e) => app.set({ stepTopic: e.target.value || undefined })} aria-label={T.stepTopic} data-tip={tr("Pas cadru cu cadru pe un anumit topic (ex. următorul mesaj al ieșirii X)")} style={{ maxWidth: 200 }}>
        <option value="">{tr("pas: orice panou")}</option>
        {a.topics.map((t) => (
          <option key={t.topic} value={t.topic}>
            step: {t.topic}
          </option>
        ))}
      </select>
      <div className="btn-group" role="group" aria-label={T.timeSource} data-testid="clock-switch">
        <button className="btn sm" aria-pressed={s.timeSource === "log"} onClick={() => app.set({ timeSource: "log" })} data-tip="Log time: a message appears when it was received and recorded — what a consumer of the topic saw, and when. Output panels lag their inputs by the latency.">
          {T.logTime}
        </button>
        <button className="btn sm" aria-pressed={s.timeSource === "header"} onClick={() => app.set({ timeSource: "header" })} data-tip="header.stamp: a message appears at its stamp — for an output, the stamp of the input frame it was computed from. Inputs and their outputs line up on the same frame; latency disappears from the view.">
          {T.headerStamp}
        </button>
      </div>
      <span className="spacer" />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const v = parseTimeInput(jump);
          if (v !== undefined) {
            setPlaying(false);
            seek(v);
          }
        }}
      >
        <input className="input mono" style={{ width: 110 }} placeholder={tr("salt: 12.5s")} value={jump} onChange={(e) => setJump(e.target.value)} aria-label={tr("Salt la timp (ex. 12.5s sau 1500ms)")} />
      </form>
      <button className="btn sm" onClick={() => app.set({ markA: clock.get().t })} data-tip={tr("Setează cursorul A la momentul curent (tasta A)")}>
        <Flag size={14} /> A
      </button>
      <button className="btn sm" onClick={() => app.set({ markB: clock.get().t })} data-tip={tr("Setează cursorul B (tasta B)")}>
        <Flag size={14} /> B
      </button>
      <button className="btn sm icon" aria-pressed={s.loop} onClick={() => app.set({ loop: !s.loop })} aria-label={T.loop} data-tip={T.loop}>
        <Repeat size={14} />
      </button>
      {features.issues && (<>
      <button className="btn sm" onClick={() => openBugDraft()} data-tip={tr("Creează un raport de bug pentru momentul curent sau intervalul A–B")}>
        <BugIcon size={14} /> Bug
      </button>
      <button
        className="btn sm icon"
        aria-label={T.addNote}
        data-tip={`${T.addNote} (N)`}
        onClick={openNoteDraft}
      >
        <StickyNote size={14} />
      </button>
      </>)}
    </div>
  );
}
