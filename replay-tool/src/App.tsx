/** Root component: routes between start / loading / error and the analysis shell. */
import { useEffect } from "react";
import { prefs } from "./state/actions";
import { app, useApp } from "./state/store";
import { BugEditor } from "./views/IssuesView";
import { CausalityView } from "./views/CausalityView";
import { ConsistencyView } from "./views/ConsistencyView";
import { InventoryView } from "./views/InventoryView";
import { IssuesView } from "./views/IssuesView";
import { QualityView } from "./views/QualityView";
import { ReplayView } from "./views/ReplayView";
import { RequirementsView } from "./views/RequirementsView";
import { SafetyView } from "./views/SafetyView";
import { ErrorScreen, LoadingScreen, StartScreen } from "./views/StartScreen";
import { StyleguideView } from "./views/StyleguideView";
import { CommandPalette, HelpModal, Inspector, LiveRegion, Nav, SettingsModal, Toast, TopBar, Tour, useShortcuts } from "./ui/Shell";
import { TooltipLayer, Logo } from "./ui/primitives";

function Views() {
  const view = useApp((s) => s.view);
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

export function App() {
  const phase = useApp((s) => s.phase);
  const view = useApp((s) => s.view);
  useShortcuts();
  useEffect(() => {
    const g = prefs.get().gapFactor;
    if (g) app.set({ gapFactor: g });
    if (location.hash.startsWith("#/styleguide")) app.set({ view: "styleguide" });
  }, []);

  // the styleguide is reachable without a file (design review)
  if (phase !== "ready" && view === "styleguide")
    return (
      <div className="app" style={{ gridTemplateRows: "56px 1fr" }}>
        <header className="topbar"><Logo height={22} /><span className="spacer" /><button className="btn sm" onClick={() => { app.set({ view: "replay" }); history.replaceState(null, "", location.pathname); }}>Înapoi</button></header>
        <main className="main"><StyleguideView /></main>
        <TooltipLayer />
      </div>
    );

  return (
    <>
      {phase === "start" && <StartScreen />}
      {phase === "loading" && <LoadingScreen />}
      {phase === "error" && <ErrorScreen />}
      {phase === "ready" && (
        <div className="app">
          <TopBar />
          <Nav />
          <main className="main">
            <Views />
            <Inspector />
          </main>
        </div>
      )}
      <CommandPalette />
      <HelpModal />
      <SettingsModal />
      <BugEditor />
      <Tour />
      <Toast />
      <LiveRegion />
      <TooltipLayer />
    </>
  );
}
