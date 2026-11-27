/** Root component: routes between start / loading / error and the analysis shell. */
import { Fragment, lazy, Suspense, useEffect } from "react";
import { useLang } from "./i18n";
import { viewEnabled } from "./state/features";
import { app, useApp } from "./state/store";
import { BugEditor } from "./views/bugs";
import { ErrorScreen, LoadingScreen, StartScreen } from "./views/StartScreen";
import { CommandPalette, HelpModal, Inspector, LiveRegion, Nav, SettingsModal, Toast, TopBar, Tour, useShortcuts } from "./ui/Shell";
import { TooltipLayer, Logo } from "./ui/primitives";

// Views are code-split: the start screen loads fast, three.js / uPlot / analysis views on demand.
const named = <K extends string>(p: Promise<Record<K, React.ComponentType>>, k: K) => p.then((m) => ({ default: m[k] }));
const ReplayView = lazy(() => named(import("./views/ReplayView"), "ReplayView"));
const InventoryView = lazy(() => named(import("./views/InventoryView"), "InventoryView"));
const CausalityView = lazy(() => named(import("./views/CausalityView"), "CausalityView"));
const QualityView = lazy(() => named(import("./views/QualityView"), "QualityView"));
const ConsistencyView = lazy(() => named(import("./views/ConsistencyView"), "ConsistencyView"));
const RequirementsView = lazy(() => named(import("./views/RequirementsView"), "RequirementsView"));
const SafetyView = lazy(() => named(import("./views/SafetyView"), "SafetyView"));
const IssuesView = lazy(() => named(import("./views/IssuesView"), "IssuesView"));
const StyleguideView = lazy(() => named(import("./views/StyleguideView"), "StyleguideView"));
const ExportDialog = lazy(() => named(import("./views/ExportDialog"), "ExportDialog"));

function ViewFallback() {
  return (
    <div className="view" aria-busy="true">
      <div className="skeleton" style={{ height: 40, width: 320, marginBottom: 16 }} />
      <div className="skeleton" style={{ height: 240 }} />
    </div>
  );
}

function Views() {
  const requested = useApp((s) => s.view);
  // views hidden in this delivery (see state/features.ts) fall back to the replay
  const view = viewEnabled(requested) ? requested : "replay";
  switch (view) {
    case "inventory":
      return <InventoryView />;
    case "causality":
      return <CausalityView />;
    case "quality":
      return <QualityView />;
    case "consistency":
      return <ConsistencyView />;
    case "requirements":
      return <RequirementsView />;
    case "safety":
      return <SafetyView />;
    case "issues":
      return <IssuesView />;
    case "styleguide":
      return <StyleguideView />;
    default:
      return <ReplayView />;
  }
}

function LazyViews() {
  return (
    <Suspense fallback={<ViewFallback />}>
      <Views />
    </Suspense>
  );
}

export function App() {
  const phase = useApp((s) => s.phase);
  const view = useApp((s) => s.view);
  const lang = useLang(); // keyed fragment below: re-render every tr() text on language change
  useShortcuts();
  useEffect(() => {
    if (location.hash.startsWith("#/styleguide")) app.set({ view: "styleguide" });
  }, []);

  // the styleguide is reachable without a file (design review)
  if (phase !== "ready" && view === "styleguide")
    return (
      <div className="app" style={{ gridTemplateRows: "56px 1fr" }}>
        <header className="topbar"><Logo height={30} /><span className="spacer" /><button className="btn sm" onClick={() => { app.set({ view: "replay" }); history.replaceState(null, "", location.pathname); }}>Back</button></header>
        <main className="main"><Suspense fallback={<ViewFallback />}><StyleguideView /></Suspense></main>
        <TooltipLayer />
      </div>
    );

  return (
    <Fragment key={lang}>
      {phase === "start" && <StartScreen />}
      {phase === "loading" && <LoadingScreen />}
      {phase === "error" && <ErrorScreen />}
      {phase === "ready" && (
        <div className="app">
          <TopBar />
          <Nav />
          <main className="main">
            <LazyViews />
            <Inspector />
          </main>
        </div>
      )}
      <CommandPalette />
      <HelpModal />
      <SettingsModal />
      <BugEditor />
      <ExportGate />
      <Tour />
      <Toast />
      <LiveRegion />
      <TooltipLayer />
    </Fragment>
  );
}

/** The export dialog (and its encoders) load only when opened. */
function ExportGate() {
  const open = useApp((s) => !!s.exportOpen && s.phase === "ready");
  return open ? (
    <Suspense fallback={null}>
      <ExportDialog />
    </Suspense>
  ) : null;
}
