/**
 * Application state: a tiny external store (useSyncExternalStore) — no extra deps.
 *
 * Two stores:
 *  - `app`: everything except the playback cursor (re-renders views on change)
 *  - `clock`: the cursor time; updated at display rate during playback, subscribed to
 *    only by the components that need it (panels, timeline), to keep the UI fluid.
 */
import { useSyncExternalStore } from "react";
import type { Analysis, Role } from "../core/types";
import type { ProfileName, ThresholdsConfig, TestReport, Violation } from "../core/requirements";
import type { Calibration } from "../core/projection";
import type { Layout } from "react-grid-layout";

export class Store<T extends object> {
  #state: T;
  #subs = new Set<() => void>();
  constructor(init: T) {
    this.#state = init;
  }
  get = (): T => this.#state;
  set = (patch: Partial<T> | ((s: T) => Partial<T>)): void => {
    const p = typeof patch === "function" ? patch(this.#state) : patch;
    this.#state = { ...this.#state, ...p };
    this.#subs.forEach((f) => f());
  };
  subscribe = (f: () => void): (() => void) => {
    this.#subs.add(f);
    return () => this.#subs.delete(f);
  };
}

export function useStore<T extends object, S>(store: Store<T>, sel: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}

export type ViewName = "replay" | "inventory" | "causality" | "quality" | "consistency" | "requirements" | "safety" | "issues" | "styleguide";

export type PanelKind = "auto" | "overlay" | "diff" | "plot";

export interface PanelConfig {
  id: string;
  topic: string;
  kind: PanelKind;
  /** second topic for overlay (cloud) / diff (image B) */
  topic2?: string;
  /** field path for plot panels */
  path?: string;
  options?: Record<string, unknown>;
}

export interface Bug {
  id: string;
  title: string;
  severity: "Blocker" | "Critical" | "Major" | "Minor" | "Trivial";
  severityWhy: string;
  requirement: string;
  startNs: number;
  endNs: number;
  topics: string[];
  measured: string;
  expected: string;
  actual: string;
  steps: string;
  images: Array<{ name: string; dataUrl: string }>;
  createdAt: string;
}

export interface Note {
  id: string;
  t: number;
  endT?: number;
  text: string;
  tag: "question" | "assumption" | "anomaly" | "bookmark";
  priority: 1 | 2 | 3;
}

export interface ImportedReport {
  name: string;
  report: Partial<TestReport>;
  failures: Violation[];
  raw: unknown;
}

export interface AppState {
  phase: "start" | "loading" | "ready" | "error";
  progress: { phase: string; fraction: number };
  error?: string;
  file?: File;
  /** every part of the recording (several consecutive MCAP files merged by log time) */
  files?: File[];
  analysis?: Analysis;
  view: ViewName;
  roleOverrides: Record<string, Role>;
  fovOverrides: Record<string, string>;
  /** output topic → trigger input chosen by the user */
  triggerOverrides: Record<string, string>;
  /** topic → nominal period (ns) chosen by the user */
  periodOverrides: Record<string, number>;
  /** depth topic → display unit / range chosen by the user */
  depthOverrides: Record<string, { unit?: "mm" | "m"; maxM?: number }>;
  /** point-cloud topic → colouring field ("distance" or a field name) */
  cloudColourOverrides: Record<string, string>;
  /** a panel is red when its message is older than k × the topic's nominal period */
  staleK: number;
  panels: PanelConfig[];
  layout: Layout[];
  playing: boolean;
  speed: number;
  loop: boolean;
  markA?: number;
  markB?: number;
  timeSource: "log" | "header";
  stepTopic?: string;
  highlightTopics: string[];
  inspector?: { topic: string; index: number };
  inspectorOpen: boolean;
  profile: ProfileName;
  thresholdsText: string;
  thresholds?: ThresholdsConfig;
  thresholdsError?: string;
  reports: ImportedReport[];
  showReportMarkers: boolean;
  bugs: Bug[];
  notes: Note[];
  manualAssumptions: string[];
  calibrations: Record<string, Calibration>;
  speedOverride?: number;
  stepLengthM: number;
  gapFactor: number;
  paletteOpen: boolean;
  /** export dialog (video / snapshots) */
  exportOpen?: "video" | "snapshots";
  helpOpen: boolean;
  settingsOpen: boolean;
  bugDraft?: Partial<Bug>;
  tourStep?: number;
  toast?: string;
  announce: string;
}

export const app = new Store<AppState>({
  phase: "start",
  progress: { phase: "", fraction: 0 },
  view: "replay",
  roleOverrides: {},
  fovOverrides: {},
  triggerOverrides: {},
  periodOverrides: {},
  depthOverrides: {},
  cloudColourOverrides: {},
  staleK: 3,
  panels: [],
  layout: [],
  playing: false,
  speed: 1,
  loop: false,
  timeSource: "log",
  highlightTopics: [],
  inspectorOpen: false,
  profile: "derived",
  thresholdsText: "",
  reports: [],
  showReportMarkers: true,
  bugs: [],
  notes: [],
  manualAssumptions: [],
  calibrations: {},
  stepLengthM: 0.7,
  gapFactor: 2,
  paletteOpen: false,
  helpOpen: false,
  settingsOpen: false,
  announce: "",
});

export const clock = new Store<{ t: number }>({ t: 0 });

export const useApp = <S,>(sel: (s: AppState) => S) => useStore(app, sel);
export const useClock = () => useStore(clock, (s) => s.t);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string): void {
  app.set({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => app.set({ toast: undefined }), 2600);
}

/** Screen-reader announcement (aria-live region). */
export function announce(msg: string): void {
  app.set({ announce: msg });
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
