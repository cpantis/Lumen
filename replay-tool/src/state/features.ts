/**
 * Feature flags for staged delivery.
 *
 * First delivery: replay + analysis views (Inventory, Causality & latency, Content
 * quality, FOV consistency). The Requirements & tests, Safety and Bugs & notes views
 * are fully implemented and tested, but hidden until a later delivery.
 *
 * To ship them: set them to `true` in DEFAULT_FEATURES.
 * To preview them internally without a release: open the app with `?features=all`
 * (remembered in this browser), or `?features=default` to go back.
 */
export interface Features {
  /** "Requirements & tests" view, requirement-violation shading on the timeline, FAIL badge */
  requirements: boolean;
  /** "Safety" view */
  safety: boolean;
  /** "Bugs & notes" view, Bug / note buttons and shortcuts, bug editor */
  issues: boolean;
}

const DEFAULT_FEATURES: Features = { requirements: false, safety: false, issues: false };
const ALL: Features = { requirements: true, safety: true, issues: true };
const KEY = "stamptrace.features";

function resolve(): Features {
  try {
    const q = new URLSearchParams(location.search).get("features");
    if (q === "all") localStorage.setItem(KEY, "all");
    if (q === "default") localStorage.removeItem(KEY);
    if (localStorage.getItem(KEY) === "all") return ALL;
  } catch {
    /* storage blocked: defaults */
  }
  return DEFAULT_FEATURES;
}

export const features: Features = typeof window === "undefined" ? DEFAULT_FEATURES : resolve();

import type { ViewName } from "./store";

const ALL_VIEWS: ViewName[] = ["replay", "inventory", "causality", "quality", "consistency", "requirements", "safety", "issues"];

/** Views shown in the navigation (in order), given the enabled features. */
export function visibleViews(): ViewName[] {
  return ALL_VIEWS.filter((v) => (v === "requirements" ? features.requirements : v === "safety" ? features.safety : v === "issues" ? features.issues : true));
}

/** True when a view can be opened (hidden views fall back to the replay). */
export function viewEnabled(v: ViewName): boolean {
  return v === "styleguide" || visibleViews().includes(v);
}
