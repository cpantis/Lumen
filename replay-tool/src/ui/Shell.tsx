/**
 * App shell pieces: top bar, navigation, inspector, command palette (Ctrl/⌘+K),
 * help & shortcuts (?), settings, guided tour, keyboard shortcuts, aria-live region.
 */
import { Camera, Contrast, Film, HelpCircle, Moon, PanelRight, Search, Settings, Sun, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parseTimeInput } from "../core/time";
import { setLang, useT, type Lang } from "../i18n";
import { closeFile, defaultPanels, jumpTo, prefs, results, seek, setPlaying, setSpeed, step, togglePlay } from "../state/actions";
import { app, clock, useApp, type ViewName } from "../state/store";
import { downloadSnapshot, exportVideo } from "../export/snapshot";
import { JsonTree } from "../panels/DataPanels";
import { useDecoded } from "../panels/useMessage";
import { AUTHOR, fmt, Kv, Logo, Modal } from "./primitives";
import { APP_VERSION, GIT_COMMIT } from "../state/trace";
import { openBugDraft, openNoteDraft } from "../views/bugs";
import { features, visibleViews } from "../state/features";
import { tr } from "../i18n";

export function applyTheme(theme: "dark" | "light", highContrast: boolean): void {
  document.documentElement.dataset.theme = theme;
  if (highContrast) document.documentElement.dataset.contrast = "high";
  else delete document.documentElement.dataset.contrast;
  prefs.set({ theme, highContrast });
}

export function TopBar() {
  const T = useT();
  const a = useApp((s) => s.analysis);
  const inspectorOpen = useApp((s) => s.inspectorOpen);
  const [theme, setTheme] = useState<"dark" | "light">((document.documentElement.dataset.theme as "dark" | "light") ?? "dark");
  return (
    <header className="topbar">
      <a href="#main-content" className="skip-link">{tr("Sari la conținut")}</a>
      <button className="btn ghost" style={{ padding: 0, border: 0 }} onClick={() => app.set({ view: "replay" })} aria-label={tr("StampTrace — acasă")}>
        <Logo height={30} />
      </button>
      <div className="file" data-tour="file">
        {a && (
          <>
            <b className="mono">{a.fileName}</b> <span style={{ opacity: 0.7 }}>· {fmt.s(a.durationNs, 2)} · {a.topics.length} {tr("topicuri")} · SHA-256 {a.sha256.slice(0, 12)}…</span>
          </>
        )}
      </div>
      <button className="btn sm ghost" onClick={() => app.set({ paletteOpen: true })} aria-label={T.commandPalette} data-tip={`${T.commandPalette} (Ctrl/⌘ + K)`}>
        <Search size={16} /> <kbd style={{ background: "transparent", color: "inherit" }}>⌘K</kbd>
      </button>
      <button className="btn icon ghost hide-narrow" onClick={downloadSnapshot} aria-label={T.exportPng} data-tip={T.exportPng}><Camera size={18} /></button>
      <button className="btn icon ghost hide-narrow" onClick={() => exportVideo()} aria-label={T.exportVideo} data-tip={`${T.exportVideo} — WebM`}><Film size={18} /></button>
      <button className="btn icon ghost hide-narrow" aria-pressed={inspectorOpen} onClick={() => app.set({ inspectorOpen: !inspectorOpen })} aria-label={T.inspector} data-tip={`${T.inspector} (I)`}><PanelRight size={18} /></button>
      <button
        className="btn icon ghost"
        onClick={() => {
          const t = theme === "dark" ? "light" : "dark";
          setTheme(t);
          applyTheme(t, document.documentElement.dataset.contrast === "high");
        }}
        aria-label={T.theme}
        data-tip={T.theme}
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <button className="btn icon ghost" onClick={() => app.set({ helpOpen: true })} aria-label={T.help} data-tip={`${T.help} (?)`}><HelpCircle size={18} /></button>
      <button className="btn icon ghost" onClick={() => app.set({ settingsOpen: true })} aria-label={T.settings} data-tip={T.settings}><Settings size={18} /></button>
      <button className="btn icon ghost" onClick={closeFile} aria-label={T.closeFile} data-tip={T.closeFile}><X size={18} /></button>
    </header>
  );
}

export function Nav() {
  const T = useT();
  const view = useApp((s) => s.view);
  const s = useApp((st) => st);
  const fails = features.requirements ? results(s.profile, s).filter((r) => r.verdict === "FAIL").length : 0;
  const views = visibleViews();
  return (
    <nav className="nav" role="tablist" aria-label={tr("Vederi")} data-tour="nav">
      {views.map((v) => (
        <button key={v} role="tab" aria-selected={view === v} onClick={() => app.set({ view: v })}>
          {T.views[v as keyof typeof T.views]}
          {v === "requirements" && fails > 0 && <span className="count" aria-label={`${fails} failed requirements`}>{fails} FAIL</span>}
          {v === "issues" && s.bugs.length > 0 && <span className="count" style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>{s.bugs.length}</span>}
        </button>
      ))}
    </nav>
  );
}

export function Inspector() {
  const open = useApp((s) => s.inspectorOpen);
  const sel = useApp((s) => s.inspector);
  const a = useApp((s) => s.analysis);
  const t = a?.topics.find((x) => x.topic === sel?.topic);
  const { msg } = useDecoded(sel?.topic, sel?.index ?? -1);
  if (!open) return null;
  return (
    <aside className="inspector" aria-label={tr("Inspector mesaj")}>
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{tr("Inspector")}</h3>
        <span className="spacer" />
        <button className="btn icon sm ghost" onClick={() => app.set({ inspectorOpen: false })} aria-label={tr("Închide inspectorul")}><X size={16} /></button>
      </div>
      {!t || !sel ? (
        <p className="muted small">{tr("Apasă ⓘ pe un panou pentru a inspecta mesajul afișat.")}</p>
      ) : (
        <>
          <Kv
            items={[
              ["topic", t.topic],
              ["tip", t.type],
              ["index", `${sel.index + 1} / ${t.count}`],
              ["log time", fmt.s(t.log[sel.index], 6)],
              ["header.stamp", t.hasHeader ? fmt.s(t.stamp[sel.index], 6) : "—"],
              ["log − stamp", t.hasHeader ? fmt.ms(t.log[sel.index] - t.stamp[sel.index], 3) : "—"],
              ["dimensiune", `${t.size[sel.index]} B`],
              ["elemente", `${t.content.elements[sel.index]}`],
              ["NaN / zero", `${fmt.pct(t.content.nanRatio[sel.index])} / ${fmt.pct(t.content.zeroRatio[sel.index])}`],
              ["status", t.content.decodeError[sel.index] ? "undecodable" : t.content.invalid[sel.index] ? "invalid" : t.content.empty[sel.index] ? "empty" : "OK"],
            ]}
          />
          <div className="row" style={{ margin: "8px 0" }}>
            <button className="btn sm" onClick={() => app.set({ inspector: { topic: t.topic, index: Math.max(0, sel.index - 1) } })}>{tr("← anterior")}</button>
            <button className="btn sm" onClick={() => app.set({ inspector: { topic: t.topic, index: Math.min(t.count - 1, sel.index + 1) } })}>{tr("următor →")}</button>
            <button className="btn sm" onClick={() => seek(t.log[sel.index])}>{tr("salt aici")}</button>
          </div>
          <div className="json">{msg?.msg !== undefined ? <JsonTree value={msg.msg} topic={t.topic} /> : msg?.error}</div>
        </>
      )}
    </aside>
  );
}

interface Cmd {
  group: string;
  label: string;
  run: () => void;
}

export function CommandPalette() {
  const T = useT();
  const open = useApp((s) => s.paletteOpen);
  const s = useApp((st) => st);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const cmds = useMemo<Cmd[]>(() => {
    const a = s.analysis;
    const list: Cmd[] = [];
    const views: ViewName[] = [...visibleViews(), "styleguide"];
    for (const v of views) list.push({ group: "view", label: v === "styleguide" ? "Styleguide (design system)" : T.views[v as keyof typeof T.views], run: () => app.set({ view: v }) });
    list.push(
      { group: "action", label: "Play / pause", run: togglePlay },
      { group: "action", label: T.exportPng, run: downloadSnapshot },
      { group: "action", label: T.exportVideo, run: () => exportVideo() },
      ...(features.issues
        ? [
            { group: "action", label: T.createBug, run: () => openBugDraft() },
            { group: "action", label: T.addNote, run: openNoteDraft },
          ]
        : []),
      { group: "action", label: "Derived profile", run: () => app.set({ profile: "derived" }) },
      { group: "action", label: "Strict profile", run: () => app.set({ profile: "strict" }) },
      { group: "action", label: T.tour, run: () => app.set({ tourStep: 0 }) },
      { group: "layout", label: T.layoutReset, run: () => app.set(defaultPanels(app.get().analysis!)) },
    );
    if (a) {
      for (const t of a.topics) list.push({ group: "topic", label: `${t.topic} · ${t.type}`, run: () => { app.set({ view: "inventory" }); } });
      if (features.requirements) for (const r of results(s.profile, s)) for (const v of r.violations.slice(0, 20)) list.push({ group: "failure", label: `${r.id} @ ${fmt.s(v.startNs)} · ${v.topic} · ${v.message}`, run: () => jumpTo(v.startNs, [v.topic]) });
      for (const rep of s.reports) for (const f of rep.failures.slice(0, 50)) list.push({ group: "report", label: `${f.requirement} @ ${fmt.s(f.startNs)} · ${f.message}`, run: () => jumpTo(f.startNs, [f.topic]) });
      for (const b of s.bugs) list.push({ group: "bug", label: b.title, run: () => jumpTo(b.startNs, b.topics) });
    }
    return list;
  }, [s.analysis, s.profile, s.reports, s.bugs, T]); // eslint-disable-line react-hooks/exhaustive-deps
  const tq = parseTimeInput(q);
  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    const out = cmds.filter((c) => !ql || c.label.toLowerCase().includes(ql) || c.group.includes(ql)).slice(0, 60);
    if (tq !== undefined && s.analysis) out.unshift({ group: "time", label: `Jump to ${(tq / 1e9).toFixed(3)} s`, run: () => { setPlaying(false); seek(tq); app.set({ view: "replay" }); } });
    return out;
  }, [cmds, q, tq, s.analysis]);
  useEffect(() => setSel(0), [q]);
  if (!open) return null;
  const close = () => {
    app.set({ paletteOpen: false });
    setQ("");
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label={T.commandPalette}>
        <input
          autoFocus
          value={q}
          placeholder={T.searchCommands}
          aria-label={T.searchCommands}
          onChange={(e) => setQ(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={`cmd-${sel}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            if (e.key === "ArrowDown") (e.preventDefault(), setSel(Math.min(filtered.length - 1, sel + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setSel(Math.max(0, sel - 1)));
            if (e.key === "Enter" && filtered[sel]) {
              filtered[sel].run();
              close();
            }
          }}
        />
        <ul id="palette-list" role="listbox">
          {filtered.map((c, i) => (
            <li key={i} id={`cmd-${i}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => (c.run(), close())}>
              <span className="group">{c.group}</span>
              <span>{c.label}</span>
            </li>
          ))}
          {filtered.length === 0 && <li className="muted">{tr("Niciun rezultat")}</li>}
        </ul>
      </div>
    </div>
  );
}

export function HelpModal() {
  const open = useApp((s) => s.helpOpen);
  if (!open) return null;
  const keys: Array<[string, string]> = [
    ["Space", "play / pause"],
    ["← / →", "previous / next frame (step topic or visible panels)"],
    ["Shift + ← / →", "±1 second"],
    ["[ / ]", "slower / faster"],
    ["Home / End", "start / end"],
    ["A / B", features.issues ? "set cursors A / B (measurement, loop, video export, bug)" : "set cursors A / B (measurement, loop, video export)"],
    ["L", "loop over A–B"],
    ...(features.issues ? ([["N", "note at the current moment"]] as Array<[string, string]>) : []),
    ["I", "inspector"],
    ["Ctrl/⌘ + K", "command palette: topic, timestamp (e.g. 12.5s), failure, command"],
    [`1 … ${visibleViews().length}`, "switch views"],
    ["?", "this help"],
  ];
  return (
    <Modal title={tr("Ajutor și scurtături")} onClose={() => app.set({ helpOpen: false })}>
      <table className="t">
        <tbody>{keys.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody>
      </table>
      <hr />
      <p className="small">{tr("Timeline: click/drag pentru salt, Ctrl+rotiță zoom, Shift+rotiță deplasare, dublu-click resetare. Panourile se mută din antet și se redimensionează din colț.")}</p>
      <p className="small">{tr("Pe un panou de intrare, selectorul „↔ ieșire” arată exact cadrul de intrare folosit de ieșirea curentă.")}</p>
      <button className="btn" onClick={() => app.set({ helpOpen: false, tourStep: 0 })}>{tr("Pornește turul ghidat")}</button>
      <hr />
      <p className="small muted">
        <b>StampTrace</b> {APP_VERSION} ({GIT_COMMIT}) · {tr("creat de")} <b>{AUTHOR}</b> · {tr("Proiect pentru dotLumen SW Test Challenge — nu este un produs oficial .lumen")}
      </p>
    </Modal>
  );
}

export function SettingsModal() {
  const T = useT();
  const open = useApp((s) => s.settingsOpen);
  const gap = useApp((s) => s.gapFactor);
  const [hc, setHc] = useState(document.documentElement.dataset.contrast === "high");
  const [lang, setL] = useState<Lang>((document.documentElement.lang as Lang) === "ro" ? "ro" : "en");
  if (!open) return null;
  return (
    <Modal title={T.settings} onClose={() => app.set({ settingsOpen: false })}>
      <div className="col" style={{ gap: 16 }}>
        <label className="row">
          <input type="checkbox" checked={hc} onChange={(e) => { setHc(e.target.checked); applyTheme((document.documentElement.dataset.theme as "dark" | "light") ?? "dark", e.target.checked); }} />
          <Contrast size={16} /> {T.highContrast}
        </label>
        <label className="field">{T.language}
          <select className="input" value={lang} onChange={(e) => { const l = e.target.value as Lang; setL(l); setLang(l); prefs.set({ lang: l }); }}>
            <option value="ro">Română</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="field">{T.gapFactor}
          <input className="input mono" type="number" min={1.1} step={0.1} value={gap} onChange={(e) => { app.set({ gapFactor: +e.target.value }); prefs.set({ gapFactor: +e.target.value }); }} style={{ width: 120 }} />
        </label>
        <p className="xs muted">{tr("Preferințele se păstrează local în browser. Dimensiunea textului urmează setarea browserului (zoom până la 200 % suportat).")}</p>
      </div>
    </Modal>
  );
}

const TOUR: Array<{ sel: string; title: string; text: string }> = [
  { sel: "[data-tour=file]", title: "The analysed file", text: "Name, duration and SHA-256 fingerprint — included in every export so results can be reproduced exactly." },
  { sel: "[data-tour=nav]", title: "The views", text: features.requirements ? "Replay, then one view per sub-challenge: inventory (2.1), causality (2.2), consistency (2.3), requirements (2.4), safety (2.5), bugs and notes (2.6–2.7)." : "Replay, then the analysis views: inventory (2.1), causality & latency (2.2), content quality and FOV consistency (2.3)." },
  { sel: "[data-tour=transport]", title: "Synchronised playback", text: "Play, frame-by-frame stepping on a topic, speeds, time source (log or header.stamp), A/B cursors." },
  { sel: "[data-tour=panels]", title: "Inputs | Outputs FOV 1 | Outputs FOV 2", text: "Each panel shows the message at the current moment, its age and its status (OK / late / stale / empty / invalid)." },
  { sel: "[data-tour=timeline]", title: "Timeline", text: features.requirements ? "Every message is a tick; gaps are red, requirement violations shaded, report failures marked with ▲. Click to jump." : "Every message is a tick; gaps are red, empty or invalid messages are highlighted. Click to jump." },
];

export function Tour() {
  const T = useT();
  const stepN = useApp((s) => s.tourStep);
  const view = useApp((s) => s.view);
  const [rect, setRect] = useState<DOMRect>();
  useEffect(() => {
    if (stepN === undefined) return;
    if (view !== "replay") app.set({ view: "replay" });
    const el = document.querySelector(TOUR[stepN]?.sel ?? "");
    setRect(el?.getBoundingClientRect());
  }, [stepN, view]);
  if (stepN === undefined || !TOUR[stepN]) return null;
  const end = () => {
    app.set({ tourStep: undefined });
    prefs.set({ tourDone: true });
  };
  const st = TOUR[stepN];
  const top = rect ? Math.min(window.innerHeight - 220, rect.bottom + 12) : 120;
  const left = rect ? Math.max(12, Math.min(window.innerWidth - 360, rect.left)) : 120;
  return (
    <>
      {rect && <div className="tour-spot" style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: Math.min(rect.height + 8, window.innerHeight - rect.top) }} />}
      <div className="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tour-title" style={{ top, left }}>
        <p className="xs muted">{stepN + 1} / {TOUR.length}</p>
        <h3 id="tour-title">{st.title}</h3>
        <p className="small">{st.text}</p>
        <div className="row">
          <button className="btn sm ghost" onClick={end}>{T.skip}</button>
          <span className="spacer" />
          {stepN < TOUR.length - 1 ? <button className="btn sm primary" autoFocus onClick={() => app.set({ tourStep: stepN + 1 })}>{T.next}</button> : <button className="btn sm primary" autoFocus onClick={end}>{T.done}</button>}
        </div>
      </div>
    </>
  );
}

export function LiveRegion() {
  const msg = useApp((s) => s.announce);
  return <div className="sr-only" role="status" aria-live="polite">{msg}</div>;
}

export function Toast() {
  const msg = useApp((s) => s.toast);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

/** Global keyboard shortcuts (ignored while typing in inputs). */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = app.get();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        app.set({ paletteOpen: !s.paletteOpen });
        return;
      }
      const tgt = e.target as HTMLElement;
      if (tgt.closest("input, textarea, select, [contenteditable=true], .modal")) return;
      if (s.phase !== "ready") return;
      const views = visibleViews();
      switch (e.key) {
        case " ":
          if (tgt.tagName === "BUTTON") return;
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) seek(clock.get().t + 1e9);
          else step(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) seek(clock.get().t - 1e9);
          else step(-1);
          break;
        case "[":
          setSpeed(-1);
          break;
        case "]":
          setSpeed(1);
          break;
        case "Home":
          seek(0);
          break;
        case "End":
          seek(s.analysis!.durationNs);
          break;
        case "a":
        case "A":
          app.set({ markA: clock.get().t });
          break;
        case "b":
        case "B":
          app.set({ markB: clock.get().t });
          break;
        case "l":
        case "L":
          app.set({ loop: !s.loop });
          break;
        case "n":
        case "N":
          if (features.issues) openNoteDraft();
          break;
        case "i":
        case "I":
          app.set({ inspectorOpen: !s.inspectorOpen });
          break;
        case "?":
          app.set({ helpOpen: true });
          break;
        default:
          if (/^[1-9]$/.test(e.key) && views[+e.key - 1]) app.set({ view: views[+e.key - 1] });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
