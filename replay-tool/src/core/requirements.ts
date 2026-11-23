/**
 * Requirement evaluation against an analysis, for a given threshold profile.
 *
 * Produces a PASS / FAIL / N/A verdict per requirement with the evidence (measured
 * value, limit, per-topic breakdown) and every violation located in time. The output
 * format of violations is exactly the one the app imports as a "test report", so the
 * CLI, the app and external test scripts can exchange reports.
 */
import yaml from "js-yaml";
import { mergeIntervals, summarize, windowRate } from "./stats";
import { NS_PER_MS, NS_PER_S } from "./time";
import type { Analysis, Role, TopicData } from "./types";

export type ProfileName = "derived" | "strict";
export type Verdict = "PASS" | "FAIL" | "N/A";

export interface Selector {
  role?: Role;
  fov?: string;
  type?: string;
  topic?: string;
}

export interface RequirementDef {
  id: string;
  title: string;
  kind: string;
  select: Selector;
  safety: boolean;
  verification: string;
  rationale: string;
  derived: Record<string, number | boolean>;
  strict: Record<string, number | boolean>;
}

export interface ThresholdsConfig {
  version: number;
  gap_factor: number;
  plausible_ranges: { depthMin: number; depthMax: number; accMax: number; gyroMax: number };
  assumptions: { walking_speed_mps: number; step_length_m: number };
  requirements: RequirementDef[];
}

export interface Violation {
  requirement: string;
  topic: string;
  /** relative ns (internal); exported with absolute ns strings as well */
  startNs: number;
  endNs: number;
  measured: number;
  limit: number;
  unit: string;
  message: string;
}

export interface TopicVerdict {
  topic: string;
  verdict: Verdict;
  measured: number;
  limit: number;
  unit: string;
  note?: string;
}

export interface RequirementResult {
  id: string;
  title: string;
  kind: string;
  safety: boolean;
  verification: string;
  rationale: string;
  params: Record<string, number | boolean>;
  verdict: Verdict;
  summary: string;
  perTopic: TopicVerdict[];
  violations: Violation[];
}

export function parseThresholds(text: string): ThresholdsConfig {
  const cfg = yaml.load(text) as ThresholdsConfig;
  if (!cfg || !Array.isArray(cfg.requirements)) throw new Error("Fișier de praguri invalid: lipsește lista `requirements`.");
  for (const r of cfg.requirements) r.select ??= {};
  return cfg;
}

export function dumpThresholds(cfg: ThresholdsConfig): string {
  return yaml.dump(cfg, { lineWidth: 140, noRefs: true });
}

export interface EffectiveRoles {
  role: (t: TopicData) => Role;
  fov: (t: TopicData) => string | undefined;
}

export const autoRoles: EffectiveRoles = { role: (t) => t.autoRole, fov: (t) => t.autoFov };

export function selectTopics(a: Analysis, sel: Selector, roles: EffectiveRoles): TopicData[] {
  return a.topics.filter((t) => {
    if (t.count === 0) return false;
    if (sel.role && roles.role(t) !== sel.role) return false;
    if (sel.fov && roles.fov(t) !== sel.fov) return false;
    if (sel.type && !new RegExp(sel.type).test(t.type)) return false;
    if (sel.topic && !new RegExp(sel.topic).test(t.topic)) return false;
    return true;
  });
}

const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);

/** Groups indices where `bad[i]` is true into time intervals of topic t. */
function runs(t: TopicData, bad: (i: number) => boolean): Array<{ s: number; e: number; i0: number; i1: number }> {
  const out: Array<{ s: number; e: number; i0: number; i1: number }> = [];
  for (let i = 0; i < t.count; i++) {
    if (!bad(i)) continue;
    let j = i;
    while (j + 1 < t.count && bad(j + 1)) j++;
    out.push({ s: t.log[i], e: t.log[j], i0: i, i1: j });
    i = j;
  }
  return out;
}

function evalOne(a: Analysis, def: RequirementDef, p: Record<string, number | boolean>, roles: EffectiveRoles, gapFactor: number): Omit<RequirementResult, keyof RequirementDef | "params"> & { verdict: Verdict } {
  const topics = selectTopics(a, def.select, roles);
  const perTopic: TopicVerdict[] = [];
  const violations: Violation[] = [];
  const V = (topic: string, s: number, e: number, measured: number, limit: number, unit: string, message: string) =>
    violations.push({ requirement: def.id, topic, startNs: s, endNs: e, measured, limit, unit, message });

  switch (def.kind) {
    case "rate_min": {
      const min = num(p.min_hz);
      const win = num(p.window_s, 1) * NS_PER_S;
      for (const t of topics) {
        const r = windowRate(t.log, win);
        // ignore the first window (rate ramps up from 0)
        const startOk = t.log[0] + win;
        let worst = Infinity;
        const bad = (i: number) => r.t[i] >= startOk && r.hz[i] < min;
        for (let i = 0; i < r.t.length; i++) if (r.t[i] >= startOk) worst = Math.min(worst, r.hz[i]);
        // also detect gaps longer than the window (no message → no evaluation point)
        for (let i = 1; i < t.count; i++) if (t.log[i] - t.log[i - 1] > win) worst = Math.min(worst, NS_PER_S / (t.log[i] - t.log[i - 1]));
        for (const g of runs(t, bad)) V(t.topic, g.s - win, g.e, Math.min(...Array.from(r.hz.subarray(g.i0, g.i1 + 1))), min, "Hz", `rata pe ${win / NS_PER_S} s a scăzut sub ${min} Hz`);
        for (let i = 1; i < t.count; i++) {
          const d = t.log[i] - t.log[i - 1];
          if (d > win) V(t.topic, t.log[i - 1], t.log[i], NS_PER_S / d, min, "Hz", `niciun mesaj timp de ${(d / NS_PER_MS).toFixed(0)} ms`);
        }
        if (!Number.isFinite(worst)) worst = t.rate.meanHz;
        perTopic.push({ topic: t.topic, verdict: worst >= min ? "PASS" : "FAIL", measured: worst, limit: min, unit: "Hz", note: `medie ${t.rate.meanHz.toFixed(2)} Hz` });
      }
      break;
    }
    case "gap_max": {
      const max = num(p.max_ms) * NS_PER_MS;
      for (const t of topics) {
        for (let i = 1; i < t.count; i++) {
          const d = t.log[i] - t.log[i - 1];
          if (d > max) V(t.topic, t.log[i - 1], t.log[i], d / NS_PER_MS, max / NS_PER_MS, "ms", `gol de ${(d / NS_PER_MS).toFixed(1)} ms (+${((d - max) / NS_PER_MS).toFixed(1)} ms peste limită)`);
        }
        perTopic.push({ topic: t.topic, verdict: t.rate.maxGapNs <= max ? "PASS" : "FAIL", measured: t.rate.maxGapNs / NS_PER_MS, limit: max / NS_PER_MS, unit: "ms" });
      }
      break;
    }
    case "latency": {
      const p95 = num(p.p95_ms) * NS_PER_MS;
      const maxL = num(p.max_ms, Infinity) * NS_PER_MS;
      const names = new Set(topics.map((t) => t.topic));
      for (const e of a.edges.filter((x) => x.kind === "exact" && names.has(x.output))) {
        const t = a.topics.find((x) => x.topic === e.output)!;
        const s = e.latencySummary;
        const bad = (i: number) => e.latency[i] > maxL;
        for (const g of runs(t, bad)) {
          const worst = Math.max(...Array.from(e.latency.subarray(g.i0, g.i1 + 1)));
          V(t.topic, g.s, g.e, worst / NS_PER_MS, maxL / NS_PER_MS, "ms", `latență ${(worst / NS_PER_MS).toFixed(1)} ms față de ${e.input} (+${((worst - maxL) / NS_PER_MS).toFixed(1)} ms)`);
        }
        const ok = s.p95 <= p95 && s.max <= maxL;
        perTopic.push({ topic: `${e.input} → ${e.output}`, verdict: ok ? "PASS" : "FAIL", measured: s.p95 / NS_PER_MS, limit: p95 / NS_PER_MS, unit: "ms (p95)", note: `max ${(s.max / NS_PER_MS).toFixed(1)} ms (limită ${maxL / NS_PER_MS} ms), p50 ${(s.p50 / NS_PER_MS).toFixed(1)} ms` });
      }
      break;
    }
    case "match_min": {
      const min = num(p.min_ratio);
      for (const t of topics) {
        if (!t.hasHeader) {
          perTopic.push({ topic: t.topic, verdict: "N/A", measured: NaN, limit: min, unit: "raport", note: "fără std_msgs/Header — trasabilitatea nu poate fi verificată" });
          continue;
        }
        const best = a.edges.filter((e) => e.output === t.topic && e.kind === "exact").sort((x, y) => y.matchRate - x.matchRate)[0];
        const rate = best?.matchRate ?? 0;
        if (best) for (const g of runs(t, (i) => best.inputIndex[i] < 0)) V(t.topic, g.s, g.e, g.i1 - g.i0 + 1, 0, "mesaje", `${g.i1 - g.i0 + 1} ieșiri fără stamp de intrare corespunzător`);
        perTopic.push({ topic: t.topic, verdict: rate >= min ? "PASS" : "FAIL", measured: rate, limit: min, unit: "raport", note: best ? `față de ${best.input}` : "nicio intrare cu stamp identic" });
      }
      break;
    }
    case "drop_max": {
      const maxR = num(p.max_ratio);
      const maxRun = num(p.max_run, Infinity);
      const names = new Set(topics.map((t) => t.topic));
      for (const e of a.edges.filter((x) => x.kind === "exact" && names.has(x.output))) {
        let longest = 0;
        for (const [s, en, len] of e.dropRuns) {
          longest = Math.max(longest, len);
          if (len > maxRun) V(e.output, s, en, len, maxRun, "cadre", `${len} cadre consecutive din ${e.input} fără ieșire (+${len - maxRun})`);
        }
        const ok = e.dropRatio <= maxR && longest <= maxRun;
        perTopic.push({ topic: `${e.input} → ${e.output}`, verdict: ok ? "PASS" : "FAIL", measured: e.dropRatio, limit: maxR, unit: "raport", note: `cea mai lungă secvență: ${longest} (limită ${maxRun})` });
      }
      break;
    }
    case "empty_max":
    case "invalid_max": {
      const maxR = num(p.max_ratio);
      for (const t of topics) {
        const bad = def.kind === "empty_max" ? (i: number) => t.content.empty[i] === 1 : (i: number) => t.content.invalid[i] === 1 || t.content.decodeError[i] === 1;
        let n = 0;
        for (let i = 0; i < t.count; i++) if (bad(i)) n++;
        const ratio = n / t.count;
        if (ratio > maxR) for (const g of runs(t, bad)) V(t.topic, g.s, g.e, g.i1 - g.i0 + 1, 0, "mesaje", `${g.i1 - g.i0 + 1} mesaje ${def.kind === "empty_max" ? "goale" : "invalide/nedecodabile"}`);
        perTopic.push({ topic: t.topic, verdict: ratio <= maxR ? "PASS" : "FAIL", measured: ratio, limit: maxR, unit: "raport", note: `${n} din ${t.count}` });
      }
      break;
    }
    case "nan_max":
    case "valid_min":
    case "out_of_range_max": {
      const lim = num(p.max_ratio ?? p.min_ratio);
      for (const t of topics) {
        const val = (i: number) =>
          def.kind === "nan_max" ? t.content.nanRatio[i] : def.kind === "valid_min" ? 1 - t.content.nanRatio[i] - t.content.zeroRatio[i] : t.content.outOfRangeRatio[i];
        const bad = (i: number) => t.content.empty[i] === 0 && (def.kind === "valid_min" ? val(i) < lim : val(i) > lim);
        let worst = def.kind === "valid_min" ? Infinity : -Infinity;
        let nBad = 0;
        for (let i = 0; i < t.count; i++) {
          if (t.content.empty[i]) continue;
          worst = def.kind === "valid_min" ? Math.min(worst, val(i)) : Math.max(worst, val(i));
          if (bad(i)) nBad++;
        }
        for (const g of runs(t, bad)) {
          const vals = Array.from({ length: g.i1 - g.i0 + 1 }, (_, k) => val(g.i0 + k));
          const w = def.kind === "valid_min" ? Math.min(...vals) : Math.max(...vals);
          V(t.topic, g.s, g.e, w, lim, "raport", `${vals.length} mesaje, cel mai rău ${(w * 100).toFixed(1)}% (limită ${(lim * 100).toFixed(1)}%)`);
        }
        if (!Number.isFinite(worst)) worst = NaN;
        perTopic.push({ topic: t.topic, verdict: nBad === 0 ? "PASS" : "FAIL", measured: worst, limit: lim, unit: "raport", note: `${nBad} mesaje în afara limitei` });
      }
      break;
    }
    case "duplicate_max": {
      const maxR = num(p.max_ratio);
      const maxRun = num(p.max_run, Infinity);
      for (const t of topics) {
        const dup = (i: number) => i > 0 && t.content.hash[i] === t.content.hash[i - 1] && t.content.empty[i] === 0;
        let n = 0;
        let longest = 0;
        for (const g of runs(t, dup)) {
          const len = g.i1 - g.i0 + 1;
          n += len;
          longest = Math.max(longest, len);
          if (len >= maxRun) V(t.topic, g.s, g.e, len + 1, maxRun, "cadre", `${len + 1} cadre identice consecutive (ieșire înghețată)`);
        }
        const ratio = n / t.count;
        perTopic.push({ topic: t.topic, verdict: ratio <= maxR && longest < maxRun ? "PASS" : "FAIL", measured: ratio, limit: maxR, unit: "raport", note: `cea mai lungă repetare: ${longest + (longest ? 1 : 0)} cadre` });
      }
      break;
    }
    case "stamp_monotonic": {
      const allowDup = p.allow_duplicates !== false;
      for (const t of topics.filter((x) => x.clock)) {
        const c = t.clock!;
        const bad = [...c.nonMonotonic, ...(allowDup ? [] : c.duplicates), ...c.future].sort((x, y) => x - y);
        for (const i of c.nonMonotonic) V(t.topic, t.log[i - 1], t.log[i], (t.stamp[i] - t.stamp[i - 1]) / NS_PER_MS, 0, "ms", `stamp-ul scade cu ${((t.stamp[i - 1] - t.stamp[i]) / NS_PER_MS).toFixed(2)} ms`);
        if (!allowDup) for (const i of c.duplicates) V(t.topic, t.log[i], t.log[i], 0, 0, "ms", "stamp duplicat");
        for (const i of c.future) V(t.topic, t.log[i], t.log[i], (t.stamp[i] - t.log[i]) / NS_PER_MS, 0, "ms", `stamp cu ${((t.stamp[i] - t.log[i]) / NS_PER_MS).toFixed(2)} ms în viitor față de log_time`);
        perTopic.push({ topic: t.topic, verdict: bad.length === 0 ? "PASS" : "FAIL", measured: bad.length, limit: 0, unit: "anomalii", note: `${c.nonMonotonic.length} nemonotone, ${c.duplicates.length} duplicate, ${c.future.length} din viitor` });
      }
      break;
    }
    case "clock_offset_max": {
      const lim = num(p.p95_ms) * NS_PER_MS;
      for (const t of topics.filter((x) => x.clock)) {
        const s = t.clock!.offsetSummary;
        const bad = (i: number) => t.log[i] - t.stamp[i] > lim * 2;
        for (const g of runs(t, bad)) V(t.topic, g.s, g.e, (t.log[g.i0] - t.stamp[g.i0]) / NS_PER_MS, (lim * 2) / NS_PER_MS, "ms", "întârziere de transport de peste 2× limita p95");
        perTopic.push({ topic: t.topic, verdict: s.p95 <= lim ? "PASS" : "FAIL", measured: s.p95 / NS_PER_MS, limit: lim / NS_PER_MS, unit: "ms (p95)", note: `mediană ${(s.p50 / NS_PER_MS).toFixed(2)} ms, max ${(s.max / NS_PER_MS).toFixed(2)} ms` });
      }
      break;
    }
    case "fov_sync": {
      const minC = num(p.min_complete_ratio);
      const maxS = num(p.max_spread_ms) * NS_PER_MS;
      for (const g of a.fovGroups) {
        if (g.outputs.length < 2) {
          perTopic.push({ topic: g.fov, verdict: "N/A", measured: NaN, limit: minC, unit: "raport", note: "un singur tip de ieșire în acest FOV" });
          continue;
        }
        const full = (1 << g.outputs.length) - 1;
        const intervals: Array<[number, number]> = [];
        let worstSpread = 0;
        for (let i = 0; i < g.stamps.length; i++) {
          worstSpread = Math.max(worstSpread, g.spreadNs[i]);
          if (g.presence[i] !== full) {
            const missing = g.outputs.filter((_, k) => !(g.presence[i] & (1 << k)));
            V(g.fov, g.stamps[i], g.stamps[i], missing.length, 0, "ieșiri lipsă", `pentru stamp-ul ${(g.stamps[i] / NS_PER_S).toFixed(3)} s lipsește: ${missing.join(", ")}`);
          } else if (g.spreadNs[i] > maxS) intervals.push([g.stamps[i], g.stamps[i]]);
        }
        for (const [s, e] of mergeIntervals(intervals, 0)) V(g.fov, s, e, worstSpread / NS_PER_MS, maxS / NS_PER_MS, "ms", "decalaj de publicare între ieșirile aceluiași moment peste limită");
        const ok = g.completeRatio >= minC && worstSpread <= maxS;
        perTopic.push({ topic: g.fov, verdict: ok ? "PASS" : "FAIL", measured: g.completeRatio, limit: minC, unit: "raport complet", note: `decalaj max ${(worstSpread / NS_PER_MS).toFixed(1)} ms (limită ${maxS / NS_PER_MS} ms)` });
      }
      break;
    }
    default:
      return { verdict: "N/A", summary: `Tip de cerință necunoscut: ${def.kind}`, perTopic, violations };
  }
  const evaluated = perTopic.filter((t) => t.verdict !== "N/A");
  const verdict: Verdict = evaluated.length === 0 ? "N/A" : evaluated.every((t) => t.verdict === "PASS") ? "PASS" : "FAIL";
  const failed = evaluated.filter((t) => t.verdict === "FAIL").length;
  const summary =
    verdict === "N/A"
      ? "Niciun topic nu corespunde selectorului — cerința nu poate fi verificată din înregistrare."
      : `${evaluated.length - failed}/${evaluated.length} PASS, ${violations.length} încălcări localizate în timp`;
  void gapFactor;
  return { verdict, summary, perTopic, violations };
}

/** Evaluates every requirement of a profile. */
export function evaluate(a: Analysis, cfg: ThresholdsConfig, profile: ProfileName, roles: EffectiveRoles = autoRoles): RequirementResult[] {
  return cfg.requirements.map((def) => {
    const params = def[profile] ?? {};
    const r = evalOne(a, def, params, roles, cfg.gap_factor);
    return { id: def.id, title: def.title, kind: def.kind, safety: !!def.safety, verification: def.verification, rationale: def.rationale, params, ...r };
  });
}

// --- report exchange format ---------------------------------------------------------

export interface ReportEntry {
  requirement: string;
  topic: string;
  t_start_ns: string | number;
  t_end_ns: string | number;
  measured: number;
  limit: number;
  message: string;
  unit?: string;
  t_start_rel_s?: number;
}

export interface TestReport {
  tool: string;
  file: string;
  sha256: string;
  profile: ProfileName | string;
  generated_at: string;
  results: Array<{ requirement: string; title: string; verdict: Verdict; summary: string; safety: boolean }>;
  failures: ReportEntry[];
}

export function toReport(a: Analysis, results: RequirementResult[], profile: string, tool: string): TestReport {
  const start = BigInt(a.startNs);
  const abs = (rel: number) => (start + BigInt(Math.round(rel))).toString();
  return {
    tool,
    file: a.fileName,
    sha256: a.sha256,
    profile,
    generated_at: new Date().toISOString(),
    results: results.map((r) => ({ requirement: r.id, title: r.title, verdict: r.verdict, summary: r.summary, safety: r.safety })),
    failures: results.flatMap((r) =>
      r.violations.map((v) => ({
        requirement: v.requirement,
        topic: v.topic,
        t_start_ns: abs(v.startNs),
        t_end_ns: abs(v.endNs),
        t_start_rel_s: +(v.startNs / NS_PER_S).toFixed(6),
        measured: +v.measured.toFixed(6),
        limit: v.limit,
        unit: v.unit,
        message: v.message,
      })),
    ),
  };
}

/**
 * Parses an imported report: either a bare array of failures (format from the
 * prompt) or a full TestReport. Times may be absolute ns (string/number, > 1e15) or
 * relative ns.
 */
export function parseReport(json: unknown, startNs: string): { meta: Partial<TestReport>; failures: Violation[] } {
  const start = BigInt(startNs);
  const obj = json as Partial<TestReport> & Record<string, unknown>;
  const list = (Array.isArray(json) ? json : (obj.failures ?? [])) as ReportEntry[];
  const rel = (v: string | number | undefined): number => {
    if (v === undefined) return NaN;
    if (typeof v === "string") {
      const b = BigInt(v.split(".")[0]);
      return b > 1_000_000_000_000_000n ? Number(b - start) : Number(b);
    }
    return v > 1e15 ? Number(BigInt(Math.round(v)) - start) : v;
  };
  return {
    meta: Array.isArray(json) ? {} : { ...obj, failures: undefined },
    failures: list.map((f) => ({
      requirement: String(f.requirement),
      topic: String(f.topic ?? ""),
      startNs: rel(f.t_start_ns),
      endNs: rel(f.t_end_ns ?? f.t_start_ns),
      measured: Number(f.measured),
      limit: Number(f.limit),
      unit: f.unit ?? "",
      message: String(f.message ?? ""),
    })),
  };
}

/** Diff of two reports per requirement (e.g. derived vs strict). */
export function compareReports(a: TestReport, b: TestReport): Array<{ requirement: string; title: string; a: Verdict | "—"; b: Verdict | "—"; changed: boolean }> {
  const ids = [...new Set([...a.results.map((r) => r.requirement), ...b.results.map((r) => r.requirement)])];
  return ids.map((id) => {
    const ra = a.results.find((r) => r.requirement === id);
    const rb = b.results.find((r) => r.requirement === id);
    return { requirement: id, title: ra?.title ?? rb?.title ?? "", a: ra?.verdict ?? "—", b: rb?.verdict ?? "—", changed: (ra?.verdict ?? "—") !== (rb?.verdict ?? "—") };
  });
}

// --- derived-profile generation (2.2 draft requirements) ------------------------------

/**
 * Proposes "derived" thresholds from the measurements: what the component does today,
 * with a small margin, so that the derived profile passes on this recording unless
 * something is anomalous. Returns a new config (the engineer decides).
 */
export function regenerateDerived(a: Analysis, cfg: ThresholdsConfig, roles: EffectiveRoles = autoRoles): ThresholdsConfig {
  const out: ThresholdsConfig = JSON.parse(JSON.stringify(cfg));
  for (const def of out.requirements) {
    const ts = selectTopics(a, def.select, roles);
    if (!ts.length) continue;
    const names = new Set(ts.map((t) => t.topic));
    const edges = a.edges.filter((e) => e.kind === "exact" && names.has(e.output));
    const d = def.derived;
    switch (def.kind) {
      case "rate_min": {
        // 1st percentile of the 1 s window rate after the first window, minus 10 %
        const p1 = Math.min(
          ...ts.map((t) => {
            const w = windowRate(t.log, NS_PER_S);
            const after = Array.from(w.hz).filter((_, i) => w.t[i] >= t.log[0] + NS_PER_S).sort((x, y) => x - y);
            return (after.length ? after[Math.floor(after.length * 0.01)] : t.rate.meanHz) * 0.9;
          }),
        );
        if (Number.isFinite(p1)) d.min_hz = Math.max(1, Math.floor(p1));
        break;
      }
      case "gap_max":
        d.max_ms = Math.ceil(Math.max(...ts.map((t) => (t.rate.medianPeriodNs * 3) / NS_PER_MS)));
        break;
      case "latency":
        if (edges.length) {
          d.p95_ms = Math.ceil(Math.max(...edges.map((e) => e.latencySummary.p95)) / NS_PER_MS * 1.1);
          d.max_ms = Math.ceil(Math.max(...edges.map((e) => e.latencySummary.p99)) / NS_PER_MS * 1.2);
        }
        break;
      case "drop_max":
        if (edges.length) d.max_ratio = +Math.min(1, Math.max(...edges.map((e) => e.dropRatio)) * 1.2 + 0.01).toFixed(3);
        break;
      case "clock_offset_max": {
        const v = Math.max(...ts.filter((t) => t.clock).map((t) => t.clock!.offsetSummary.p95));
        if (Number.isFinite(v)) d.p95_ms = Math.ceil((v / NS_PER_MS) * 1.2);
        break;
      }
    }
  }
  return out;
}
