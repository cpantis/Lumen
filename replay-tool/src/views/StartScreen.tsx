/** Start, loading and error screens. */
import { FileUp, PlayCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useT } from "../i18n";
import { cancelLoading, openDemo, openFile, recentFiles } from "../state/actions";
import { app, useApp } from "../state/store";
import { AUTHOR, BrailleLoader, Logo, fmt } from "../ui/primitives";
import { APP_VERSION, GIT_COMMIT } from "../state/trace";
import { tr } from "../i18n";

function Footer() {
  return (
    <footer className="footer">
      <span>
        <b>StampTrace</b> · {tr("creat de")} <b>{AUTHOR}</b> · © 2026
      </span>
      <span>{tr("Proiect pentru dotLumen SW Test Challenge — nu este un produs oficial .lumen")}</span>
      <span>v{APP_VERSION} ({GIT_COMMIT})</span>
      <span>{tr("Rulează 100 % local — fișierul nu e trimis nicăieri")}</span>
      <span>{tr("Accesibil: tastatură, cititor de ecran, contrast ridicat")}</span>
    </footer>
  );
}

export function StartScreen() {
  const T = useT();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const recent = recentFiles();
  const pick = () => input.current?.click();
  return (
    <div className="start">
      <header className="topbar">
        <Logo height={30} />
        <span className="spacer" />
      </header>
      <main className="start-hero" id="main-content">
        <h1>{T.appTitle}</h1>
        <p className="tagline">{T.tagline}</p>
        <p className="lead">{T.startLead}</p>
        <div
          className={`dropzone${over ? " over" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={`${T.dropTitle}. ${T.dropSub}`}
          onClick={pick}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick())}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files[0];
            if (f) openFile(f);
          }}
          data-testid="dropzone"
        >
          <BrailleLoader label="" />
          <h3 style={{ marginTop: 16 }}>{T.dropTitle}</h3>
          <p className="muted">{T.dropSub}</p>
          <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
            <button className="btn primary" onClick={(e) => (e.stopPropagation(), pick())}>
              <FileUp size={16} /> {T.chooseFile}
            </button>
            <button className="btn" onClick={(e) => (e.stopPropagation(), openDemo())} data-testid="demo">
              <PlayCircle size={16} /> {T.loadDemo}
            </button>
          </div>
          <input ref={input} type="file" accept=".mcap" hidden data-testid="file-input" onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])} />
        </div>
        <section style={{ marginTop: 40 }} aria-labelledby="recent-h">
          <h3 id="recent-h">{T.recent}</h3>
          {recent.length === 0 ? (
            <p className="muted small">{T.noRecent}</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {recent.map((r) => (
                <li key={r.name} className="row small" style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="mono">{r.name}</span>
                  <span className="muted">{fmt.bytes(r.size)}</span>
                  <span className="spacer" />
                  <span className="muted xs">{new Date(r.at).toLocaleString()}</span>
                  <button className="btn sm" onClick={pick}>{tr("redeschide…")}</button>
                </li>
              ))}
            </ul>
          )}
          <p className="xs muted">{T.recentNote}</p>
        </section>
      </main>
      <Footer />
    </div>
  );
}

export function LoadingScreen() {
  const T = useT();
  const p = useApp((s) => s.progress);
  const file = useApp((s) => s.file);
  return (
    <div className="start">
      <header className="topbar"><Logo height={30} /></header>
      <main className="col" style={{ alignItems: "center", justifyContent: "center", gap: 20, padding: 32 }} id="main-content" aria-busy="true">
        <BrailleLoader label={T.analyzing} />
        <h2 style={{ fontWeight: 200 }}>{T.analyzing}</h2>
        <p className="muted mono small">{file?.name} {file ? `· ${fmt.bytes(file.size)}` : ""}</p>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.fraction * 100)} aria-label={p.phase}>
          <div style={{ width: `${p.fraction * 100}%` }} />
        </div>
        <p className="small muted">{p.phase} · {Math.round(p.fraction * 100)} %</p>
        <div className="col" style={{ width: "min(720px, 90vw)", gap: 8 }} aria-hidden>
          <div className="skeleton" style={{ height: 18, width: "40%" }} />
          <div className="skeleton" style={{ height: 120 }} />
          <div className="skeleton" style={{ height: 60 }} />
        </div>
        <button className="btn" onClick={cancelLoading}>{T.cancel}</button>
      </main>
      <Footer />
    </div>
  );
}

export function ErrorScreen() {
  const T = useT();
  const err = useApp((s) => s.error);
  return (
    <div className="start">
      <header className="topbar"><Logo height={30} /></header>
      <main className="start-hero" id="main-content" role="alert">
        <h2>{T.error}</h2>
        <div className="callout error">{err}</div>
        <p className="muted small">{tr("Verifică faptul că fișierul este o înregistrare MCAP (ROS 2). Fișierele trunchiate sunt citite secvențial; dacă eroarea persistă, rulează")} <code>npm run inspect -- file.mcap</code> {tr("pentru detalii.")}</p>
        <button className="btn primary" onClick={() => app.set({ phase: "start" })}>{T.retry}</button>
      </main>
      <Footer />
    </div>
  );
}
