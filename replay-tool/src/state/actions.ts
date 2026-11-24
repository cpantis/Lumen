/**
 * App actions: opening files, playback loop, seeking/stepping, effective
 * classification, requirement evaluation (memoised), persistence and URL state.
 */
import defaultThresholds from "../../config/thresholds.yaml?raw";
import { evaluate, parseThresholds, type EffectiveRoles, type RequirementResult } from "../core/requirements";
import { firstAfter, lastAtOrBefore } from "../core/sync";
import type { Analysis, Role, TopicData } from "../core/types";
import { worker } from "../worker/client";
import { viewEnabled } from "./features";
import { announce, app, clock, toast, type AppState, type Note, type PanelConfig, uid } from "./store";
import type { Layout } from "react-grid-layout";

// ---------------------------------------------------------------- classification
export function effectiveRole(t: TopicData, s: AppState = app.get()): Role {
  return s.roleOverrides[t.topic] ?? t.autoRole;
}
export function effectiveFov(t: TopicData, s: AppState = app.get()): string | undefined {
  return s.fovOverrides[t.topic] ?? t.autoFov;
}
export function roles(s: AppState = app.get()): EffectiveRoles {
  return { role: (t) => effectiveRole(t, s), fov: (t) => effectiveFov(t, s) };
}
export function fovList(a: Analysis, s: AppState = app.get()): string[] {
  return [...new Set(a.topics.map((t) => effectiveFov(t, s)).filter((x): x is string => !!x))].sort();
}
/** Colour token for a topic (consistent everywhere: timeline, panel head, plots). */
export function topicColor(t: TopicData, s: AppState = app.get()): string {
  const role = effectiveRole(t, s);
  if (role === "input") return "var(--role-input)";
  if (role === "unknown") return "var(--role-unknown)";
  const fovs = s.analysis ? fovList(s.analysis, s) : [];
  const i = fovs.indexOf(effectiveFov(t, s) ?? "");
  return i === 1 ? "var(--role-fov2)" : i === 0 ? "var(--role-fov1)" : "var(--role-unknown)";
}

// ---------------------------------------------------------------- time indexing
const stampIndex = new WeakMap<TopicData, { sorted: Float64Array; order: Int32Array }>();
/** Sorted header stamps (for header.stamp time source) with the original indices. */
export function stampOrder(t: TopicData) {
  let e = stampIndex.get(t);
  if (!e) {
    const order = Int32Array.from({ length: t.count }, (_, i) => i).sort((a, b) => t.stamp[a] - t.stamp[b]);
    e = { sorted: Float64Array.from(order, (i) => t.stamp[i]), order };
    stampIndex.set(t, e);
  }
  return e;
}

/** Index of the message shown at time `time` for a topic, under the chosen time source. */
export function indexAt(t: TopicData, time: number, source: AppState["timeSource"] = app.get().timeSource): number {
  if (source === "header" && t.hasHeader) {
    const { sorted, order } = stampOrder(t);
    const k = lastAtOrBefore(sorted, time);
    return k < 0 ? -1 : order[k];
  }
  return lastAtOrBefore(t.log, time);
}

/** Time of message i under the chosen time source. */
export function timeOf(t: TopicData, i: number, source: AppState["timeSource"] = app.get().timeSource): number {
  return source === "header" && t.hasHeader ? t.stamp[i] : t.log[i];
}

// ---------------------------------------------------------------- evaluation memo
let evalKey = "";
let evalCache: { derived?: RequirementResult[]; strict?: RequirementResult[] } = {};
export function results(profile: "derived" | "strict", s: AppState = app.get()): RequirementResult[] {
  if (!s.analysis || !s.thresholds) return [];
  const key = `${s.analysis.sha256}|${s.analysis.analyzedAt}|${s.thresholdsText}|${JSON.stringify(s.roleOverrides)}|${JSON.stringify(s.fovOverrides)}`;
  if (key !== evalKey) {
    evalKey = key;
    evalCache = {};
  }
  return (evalCache[profile] ??= evaluate(s.analysis, s.thresholds, profile, roles(s)));
}

// ---------------------------------------------------------------- thresholds
export function setThresholdsText(text: string): void {
  try {
    app.set({ thresholdsText: text, thresholds: parseThresholds(text), thresholdsError: undefined });
  } catch (e) {
    app.set({ thresholdsText: text, thresholdsError: e instanceof Error ? e.message : String(e) });
  }
}
setThresholdsText(defaultThresholds);
export const DEFAULT_THRESHOLDS_TEXT = defaultThresholds;

// ---------------------------------------------------------------- persistence
const PREFS = "lumen.prefs";
const RECENT = "lumen.recent";
const perFile = (sha: string) => `lumen.file.${sha.slice(0, 16)}`;
const LAYOUTS = "lumen.layouts";

function safeGet<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function safeSet(k: string, v: unknown): void {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full / blocked: non-critical */
  }
}
export const prefs = {
  get: () => safeGet<{ theme?: "dark" | "light"; highContrast?: boolean; lang?: "ro" | "en"; tourDone?: boolean; gapFactor?: number }>(PREFS, {}),
  set: (p: Record<string, unknown>) => safeSet(PREFS, { ...prefs.get(), ...p }),
};
export function recentFiles(): Array<{ name: string; size: number; at: string }> {
  return safeGet(RECENT, []);
}
function pushRecent(f: File) {
  const list = recentFiles().filter((r) => r.name !== f.name);
  safeSet(RECENT, [{ name: f.name, size: f.size, at: new Date().toISOString() }, ...list].slice(0, 8));
}
export function savedLayouts(): Record<string, { panels: PanelConfig[]; layout: Layout[] }> {
  return safeGet(LAYOUTS, {});
}
export function saveLayout(name: string): void {
  const s = app.get();
  safeSet(LAYOUTS, { ...savedLayouts(), [name]: { panels: s.panels, layout: s.layout } });
  toast(`Layout "${name}" saved`);
}
export function loadLayout(name: string): void {
  const l = savedLayouts()[name];
  if (l) app.set({ panels: l.panels, layout: l.layout });
}

/** Per-file state (classification edits, notes, bugs, calibration, layout) keyed by SHA-256. */
function persistFileState() {
  const s = app.get();
  if (!s.analysis) return;
  safeSet(perFile(s.analysis.sha256), {
    roleOverrides: s.roleOverrides,
    fovOverrides: s.fovOverrides,
    notes: s.notes,
    bugs: s.bugs,
    calibrations: s.calibrations,
    manualAssumptions: s.manualAssumptions,
    panels: s.panels,
    layout: s.layout,
    speedOverride: s.speedOverride,
    stepLengthM: s.stepLengthM,
  });
}
let persistTimer: ReturnType<typeof setTimeout> | undefined;
app.subscribe(() => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistFileState, 400);
});

/** Export of the classification (roles + FOV) as JSON, importable on another machine. */
export function classificationJson(): string {
  const s = app.get();
  const a = s.analysis!;
  return JSON.stringify(
    {
      file: a.fileName,
      sha256: a.sha256,
      topics: Object.fromEntries(a.topics.map((t) => [t.topic, { role: effectiveRole(t, s), fov: effectiveFov(t, s) ?? null, auto: { role: t.autoRole, fov: t.autoFov ?? null, reason: t.roleReason } }])),
    },
    null,
    2,
  );
}
export function importClassification(json: string): void {
  const obj = JSON.parse(json) as { topics: Record<string, { role: Role; fov: string | null }> };
  const roleOverrides: Record<string, Role> = {};
  const fovOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj.topics ?? {})) {
    roleOverrides[k] = v.role;
    if (v.fov) fovOverrides[k] = v.fov;
  }
  app.set({ roleOverrides, fovOverrides });
  toast("Classification imported");
}

// ---------------------------------------------------------------- default layout
export function defaultPanels(a: Analysis, s: AppState = app.get()): { panels: PanelConfig[]; layout: Layout[] } {
  const panels: PanelConfig[] = [];
  const layout: Layout[] = [];
  const visualTypes = /Image|PointCloud2|Imu|OccupancyGrid|LaserScan|Marker|TFMessage|Pose/;
  const ins = a.topics.filter((t) => effectiveRole(t, s) === "input" && visualTypes.test(t.type) && t.count > 0);
  const fovs = fovList(a, s);
  const columns: TopicData[][] = [ins];
  for (const f of fovs.slice(0, 2)) columns.push(a.topics.filter((t) => effectiveRole(t, s) === "output" && effectiveFov(t, s) === f));
  const rest = a.topics.filter((t) => effectiveRole(t, s) === "output" && !fovs.slice(0, 2).includes(effectiveFov(t, s) ?? "") && t.count > 0);
  if (columns.length < 3) columns.push(rest);
  else columns[2].push(...rest.slice(0, 2));
  columns.forEach((col, c) => {
    let y = 0;
    for (const t of col) {
      const id = uid();
      const h = /Imu|TFMessage/.test(t.type) ? 5 : 7;
      panels.push({ id, topic: t.topic, kind: "auto" });
      layout.push({ i: id, x: c * 4, y, w: 4, h, minW: 2, minH: 3 });
      y += h;
    }
  });
  return { panels, layout };
}

// ---------------------------------------------------------------- opening files
export async function openFile(file: File): Promise<void> {
  worker.reset();
  app.set({ phase: "loading", file, progress: { phase: "opening", fraction: 0 }, error: undefined, playing: false });
  pushRecent(file);
  try {
    const s0 = app.get();
    const analysis = await worker.open(file, (phase, fraction) => app.set({ progress: { phase, fraction } }), s0.thresholds?.plausible_ranges);
    const saved = safeGet<Partial<AppState>>(perFile(analysis.sha256), {});
    app.set({
      analysis,
      phase: "ready",
      roleOverrides: saved.roleOverrides ?? {},
      fovOverrides: saved.fovOverrides ?? {},
      // notes saved by older versions used Romanian tags
      notes: (saved.notes ?? []).map((n) => ({ ...n, tag: ({ întrebare: "question", presupunere: "assumption", anomalie: "anomaly" } as Record<string, Note["tag"]>)[n.tag] ?? n.tag })),
      bugs: saved.bugs ?? [],
      calibrations: saved.calibrations ?? {},
      manualAssumptions: saved.manualAssumptions ?? [],
      speedOverride: saved.speedOverride,
      stepLengthM: saved.stepLengthM ?? 0.7,
      reports: [],
      markA: undefined,
      markB: undefined,
      inspector: undefined,
    });
    const s = app.get();
    const url = readUrl();
    if (url.panels?.length && url.panels.every((p) => analysis.topics.some((t) => t.topic === p.topic))) app.set({ panels: url.panels, layout: url.layout ?? [] });
    else if (saved.panels?.length) app.set({ panels: saved.panels, layout: saved.layout ?? [] });
    else app.set(defaultPanels(analysis, s));
    if (url.view && viewEnabled(url.view as AppState["view"])) app.set({ view: url.view as AppState["view"] });
    // start at the first output message so the panels are not empty on open
    const firstOut = Math.min(...analysis.topics.filter((t) => effectiveRole(t, app.get()) === "output" && t.count).map((t) => t.log[0]));
    const startT = url.t !== undefined && Number.isFinite(url.t) ? url.t : Number.isFinite(firstOut) ? firstOut : 0;
    clock.set({ t: Math.max(0, Math.min(analysis.durationNs, startT)) });
    announce(`Recording loaded: ${analysis.topics.length} topics, ${(analysis.durationNs / 1e9).toFixed(1)} seconds.`);
    if (!prefs.get().tourDone) app.set({ tourStep: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "cancelled") return;
    app.set({ phase: "error", error: msg });
  }
}

export async function openDemo(): Promise<void> {
  app.set({ phase: "loading", progress: { phase: "downloading demo", fraction: 0 } });
  try {
    const res = await fetch("./demo.mcap");
    if (!res.ok) throw new Error(`demo.mcap unavailable (HTTP ${res.status}). Run "npm run gen:synthetic -- public/demo.mcap".`);
    const blob = await res.blob();
    await openFile(new File([blob], "demo-synthetic.mcap"));
  } catch (e) {
    app.set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export function cancelLoading(): void {
  worker.reset();
  app.set({ phase: "start" });
}

export function closeFile(): void {
  worker.reset();
  app.set({ phase: "start", analysis: undefined, file: undefined, playing: false, panels: [], layout: [] });
  history.replaceState(null, "", location.pathname + location.search);
}

// ---------------------------------------------------------------- playback
let raf = 0;
let lastFrame = 0;
let lastAnnounced = 0;
function tick(now: number) {
  const s = app.get();
  if (!s.playing || !s.analysis) return;
  const dt = (now - lastFrame) * 1e6 * s.speed; // ms → ns
  lastFrame = now;
  let t = clock.get().t + dt;
  const lo = s.loop && s.markA !== undefined && s.markB !== undefined ? Math.min(s.markA, s.markB) : 0;
  const hi = s.loop && s.markA !== undefined && s.markB !== undefined ? Math.max(s.markA, s.markB) : s.analysis.durationNs;
  if (t > hi) {
    if (s.loop) t = lo;
    else {
      t = hi;
      app.set({ playing: false });
    }
  }
  announceGaps(clock.get().t, t);
  clock.set({ t });
  raf = requestAnimationFrame(tick);
}

/** aria-live: announce data gaps crossed during playback. */
function announceGaps(from: number, to: number) {
  const a = app.get().analysis;
  if (!a || to - lastAnnounced < 1.5e9) return;
  for (const t of a.topics) {
    for (const g of t.gaps) {
      if (g.startNs >= from && g.startNs < to && g.durationNs > 2.5 * t.rate.medianPeriodNs) {
        announce(`Data gap on ${t.topic}: ${(g.durationNs / 1e6).toFixed(0)} ms`);
        lastAnnounced = to;
        return;
      }
    }
  }
}

export function setPlaying(p: boolean): void {
  const s = app.get();
  if (!s.analysis) return;
  if (p && clock.get().t >= s.analysis.durationNs) clock.set({ t: 0 });
  app.set({ playing: p });
  cancelAnimationFrame(raf);
  if (p) {
    lastFrame = performance.now();
    raf = requestAnimationFrame(tick);
  }
}
export const togglePlay = () => setPlaying(!app.get().playing);

export function seek(t: number): void {
  const a = app.get().analysis;
  if (!a) return;
  clock.set({ t: Math.max(0, Math.min(a.durationNs, t)) });
}

/** Steps to the next/previous message of the step topic (or of any visible panel topic). */
export function step(dir: 1 | -1): void {
  const s = app.get();
  const a = s.analysis;
  if (!a) return;
  setPlaying(false);
  const t = clock.get().t;
  const names = s.stepTopic ? [s.stepTopic] : [...new Set(s.panels.map((p) => p.topic))];
  let best = dir > 0 ? Infinity : -Infinity;
  for (const n of names) {
    const td = a.topics.find((x) => x.topic === n);
    if (!td) continue;
    const times = s.timeSource === "header" && td.hasHeader ? stampOrder(td).sorted : td.log;
    if (dir > 0) {
      const i = firstAfter(times, t);
      if (i < times.length) best = Math.min(best, times[i]);
    } else {
      const i = lastAtOrBefore(times, t - 1);
      if (i >= 0) best = Math.max(best, times[i]);
    }
  }
  if (Number.isFinite(best)) seek(best);
}

export function setSpeed(dir: 1 | -1): void {
  const speeds = [0.1, 0.25, 0.5, 1, 2, 4];
  const s = app.get().speed;
  const i = speeds.indexOf(s);
  const next = speeds[Math.max(0, Math.min(speeds.length - 1, (i < 0 ? 3 : i) + dir))];
  app.set({ speed: next });
  announce(`Speed ${next}×`);
}

// ---------------------------------------------------------------- URL state
interface UrlState {
  t?: number;
  view?: string;
  panels?: PanelConfig[];
  layout?: Layout[];
}
export function readUrl(): UrlState {
  const h = new URLSearchParams(location.hash.replace(/^#\/?/, "").replace(/^[^?]*\?/, ""));
  const out: UrlState = {};
  if (h.has("t")) out.t = Number(h.get("t")) * 1e9;
  if (h.has("view")) out.view = h.get("view")!;
  if (h.has("p")) {
    try {
      const raw = JSON.parse(decodeURIComponent(escape(atob(h.get("p")!)))) as Array<[string, string, number, number, number, number, string?, string?]>;
      out.panels = raw.map(([id, topic, , , , , kind, topic2]) => ({ id, topic, kind: (kind as PanelConfig["kind"]) ?? "auto", topic2 }));
      out.layout = raw.map(([id, , x, y, w, h]) => ({ i: id, x, y, w, h, minW: 2, minH: 3 }));
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}
export function writeUrl(): void {
  const s = app.get();
  if (s.phase !== "ready") return;
  const p = s.panels.map((pc) => {
    const l = s.layout.find((x) => x.i === pc.id) ?? { x: 0, y: 0, w: 4, h: 6 };
    return [pc.id, pc.topic, l.x, l.y, l.w, l.h, pc.kind === "auto" ? undefined : pc.kind, pc.topic2];
  });
  const params = new URLSearchParams();
  params.set("t", (clock.get().t / 1e9).toFixed(3));
  params.set("view", s.view);
  params.set("p", btoa(unescape(encodeURIComponent(JSON.stringify(p)))));
  history.replaceState(null, "", `#${s.view === "styleguide" ? "/styleguide" : ""}?${params.toString()}`);
}
let urlTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleUrl = () => {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(writeUrl, 300);
};
app.subscribe(scheduleUrl);
clock.subscribe(scheduleUrl);

/** Deep link to a moment (used in bug reports). */
export function deepLink(t: number): string {
  writeUrl();
  const u = new URL(location.href);
  const params = new URLSearchParams(u.hash.replace(/^#\/?[^?]*\?/, ""));
  params.set("t", (t / 1e9).toFixed(3));
  u.hash = `?${params.toString()}`;
  return u.toString();
}

export function jumpTo(t: number, topics: string[] = []): void {
  setPlaying(false);
  seek(t);
  app.set({ view: "replay", highlightTopics: topics });
  setTimeout(() => app.set({ highlightTopics: [] }), 2500);
}
