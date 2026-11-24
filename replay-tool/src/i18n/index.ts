/**
 * Minimal i18n: Romanian (default) and English dictionaries for the interface chrome.
 * Analysis evidence strings produced by the core are in Romanian (documented).
 */
import { useSyncExternalStore } from "react";
import { EN } from "./en";

const ro = {
  appTitle: "Replay — Ochelari .lumen",
  tagline: "Pedestrian AI · replay sincronizat al intrărilor și ieșirilor componentei",
  startLead: "Încarcă o înregistrare ROS 2 (MCAP) și vezi, în orice moment, ce a intrat în componentă și ce a ieșit din ea — cu dovezi măsurate.",
  dropTitle: "Trage aici fișierul .mcap",
  dropSub: "sau apasă pentru a-l alege. Fișierul nu părăsește calculatorul tău: totul rulează local, în browser.",
  chooseFile: "Alege fișierul",
  loadDemo: "Deschide înregistrarea demo",
  recent: "Fișiere deschise recent",
  recentNote: "Doar numele sunt reținute; din motive de securitate, browserul cere re-selectarea fișierului.",
  noRecent: "Niciun fișier deschis încă.",
  analyzing: "Se analizează înregistrarea",
  cancel: "Anulează",
  error: "Eroare",
  retry: "Încearcă alt fișier",
  views: {
    replay: "Replay",
    inventory: "Inventar",
    causality: "Cauzalitate & latență",
    quality: "Calitate conținut",
    consistency: "Consistență FOV",
    requirements: "Cerințe & teste",
    safety: "Siguranță",
    issues: "Bug-uri & note",
  },
  play: "Redă",
  pause: "Pauză",
  stepBack: "Cadrul anterior",
  stepFwd: "Cadrul următor",
  speed: "Viteză",
  loop: "Buclă pe intervalul A–B",
  stepTopic: "Pas pe topicul",
  timeSource: "Sursa timpului",
  logTime: "log time",
  headerStamp: "header.stamp",
  inputs: "Intrări",
  outputs: "Ieșiri",
  noFov: "Ieșiri fără FOV",
  theme: "Comută tema",
  help: "Ajutor și scurtături",
  settings: "Setări",
  closeFile: "Închide fișierul",
  inspector: "Inspector",
  commandPalette: "Paletă de comenzi",
  searchCommands: "Caută topic, timestamp (ex. 12.5s), eșec, comandă…",
  tour: "Tur ghidat",
  skip: "Sari peste",
  next: "Înainte",
  done: "Gata",
  exportPng: "Captură PNG",
  exportVideo: "Export video (A–B)",
  createBug: "Creează bug",
  addNote: "Notă la momentul curent",
  markA: "Setează A",
  markB: "Setează B",
  clearAB: "Șterge A/B",
  status: { ok: "OK", warn: "Întârziat", stale: "Expirat", none: "Fără date", empty: "Gol", invalid: "Invalid" },
  language: "Limbă",
  highContrast: "Contrast ridicat",
  gapFactor: "Factor gol (k × perioada mediană)",
  layoutSave: "Salvează layout",
  layoutLoad: "Încarcă layout",
  layoutReset: "Layout implicit",
  addPanel: "Adaugă panou",
};

type Dict = typeof ro;

const en: Dict = {
  appTitle: "Replay — .lumen Glasses",
  tagline: "Pedestrian AI · synchronised replay of the component's inputs and outputs",
  startLead: "Load a ROS 2 recording (MCAP) and see, at any moment, what went into the component and what came out — backed by measurements.",
  dropTitle: "Drop the .mcap file here",
  dropSub: "or click to choose it. The file never leaves your computer: everything runs locally, in the browser.",
  chooseFile: "Choose file",
  loadDemo: "Open the demo recording",
  recent: "Recently opened",
  recentNote: "Only names are kept; for security the browser requires re-selecting the file.",
  noRecent: "No file opened yet.",
  analyzing: "Analysing the recording",
  cancel: "Cancel",
  error: "Error",
  retry: "Try another file",
  views: {
    replay: "Replay",
    inventory: "Inventory",
    causality: "Causality & latency",
    quality: "Content quality",
    consistency: "FOV consistency",
    requirements: "Requirements & tests",
    safety: "Safety",
    issues: "Bugs & notes",
  },
  play: "Play",
  pause: "Pause",
  stepBack: "Previous frame",
  stepFwd: "Next frame",
  speed: "Speed",
  loop: "Loop over A–B",
  stepTopic: "Step on topic",
  timeSource: "Time source",
  logTime: "log time",
  headerStamp: "header.stamp",
  inputs: "Inputs",
  outputs: "Outputs",
  noFov: "Outputs without FOV",
  theme: "Toggle theme",
  help: "Help & shortcuts",
  settings: "Settings",
  closeFile: "Close file",
  inspector: "Inspector",
  commandPalette: "Command palette",
  searchCommands: "Search topic, timestamp (e.g. 12.5s), failure, command…",
  tour: "Guided tour",
  skip: "Skip",
  next: "Next",
  done: "Done",
  exportPng: "PNG snapshot",
  exportVideo: "Export video (A–B)",
  createBug: "Create bug",
  addNote: "Note at current time",
  markA: "Set A",
  markB: "Set B",
  clearAB: "Clear A/B",
  status: { ok: "OK", warn: "Late", stale: "Stale", none: "No data", empty: "Empty", invalid: "Invalid" },
  language: "Language",
  highContrast: "High contrast",
  gapFactor: "Gap factor (k × median period)",
  layoutSave: "Save layout",
  layoutLoad: "Load layout",
  layoutReset: "Default layout",
  addPanel: "Add panel",
};

export type Lang = "ro" | "en";
const dicts: Record<Lang, Dict> = { ro, en };
let lang: Lang = ((): Lang => {
  try {
    const p = JSON.parse(localStorage.getItem("lumen.prefs") || "{}");
    return p.lang === "ro" ? "ro" : "en"; // English by default
  } catch {
    return "en";
  }
})();
const subs = new Set<() => void>();

export function setLang(l: Lang): void {
  lang = l;
  document.documentElement.lang = l;
  subs.forEach((f) => f());
}
export function getLang(): Lang {
  return lang;
}
/** React hook returning the active dictionary (re-renders on language change). */
export function useT(): Dict {
  const l = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => lang,
  );
  return dicts[l];
}

/**
 * Translates a Romanian interface text (the source text in the components) to the
 * active language. Texts missing from the English dictionary stay Romanian.
 */
export function tr(ro: string): string {
  return lang === "en" ? (EN[ro] ?? ro) : ro;
}

/** Re-renders on language change (used at the root to re-render every `tr()` text). */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => lang,
  );
}

/** Picks the English variant of a bilingual field when the UI is in English. */
export function trField(ro: string, en?: string): string {
  return lang === "en" && en ? en : ro;
}

/** Translates the recurring phrases of texts generated by the analysis core. */
const CORE_PATTERNS: Array<[RegExp, string]> = [
  [/încălcări localizate în timp/g, "violations located in time"],
  [/Niciun topic nu corespunde selectorului — cerința nu poate fi verificată din înregistrare\./g, "No topic matches the selector — the requirement cannot be verified from the recording."],
  [/mesaje în afara limitei/g, "messages outside the limit"],
  [/cea mai lungă secvență/g, "longest run"],
  [/cea mai lungă repetare/g, "longest repeat"],
  [/limită/g, "limit"],
  [/mediană/g, "median"],
  [/nemonotone/g, "non-monotonic"],
  [/duplicate/g, "duplicates"],
  [/din viitor/g, "from the future"],
  [/medie/g, "mean"],
  [/față de/g, "vs"],
  [/ din /g, " of "],
];
export function trCore(text: string): string {
  if (lang !== "en" || !text) return text;
  return CORE_PATTERNS.reduce((t, [re, rep]) => t.replace(re, rep), text);
}
