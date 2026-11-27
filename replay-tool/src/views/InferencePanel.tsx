/**
 * "Inferred settings": everything StampTrace derived from the file (FOV groups, roles,
 * output triggers, nominal periods, depth unit and range, cloud colouring), each with its
 * evidence, marked "inferred" or "override", editable and resettable. Overrides are saved
 * per file, in the deep link and in every export.
 */
import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import type { TopicData } from "../core/types";
import { effectiveCloudColour, effectiveDepth, effectiveFov, effectivePeriod, effectiveRole, parity } from "../state/actions";
import { app, useApp, type AppState } from "../state/store";
import { Section } from "../ui/primitives";

function Origin({ overridden, onReset }: { overridden: boolean; onReset: () => void }) {
  return overridden ? (
    <span className="row" style={{ gap: 4 }}>
      <span className="badge warn" data-tip="Set by you; saved in the deep link and in exports">override</span>
      <button className="btn sm ghost" aria-label="Reset to the inferred value" data-tip="Reset to the inferred value" onClick={onReset}>
        <RotateCcw size={12} />
      </button>
    </span>
  ) : (
    <span className="badge neutral" data-tip="Derived from the recording">inferred</span>
  );
}

function Cell({ children, evidence }: { children: ReactNode; evidence?: string }) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{children}</div>
      {evidence && <div className="xs muted" style={{ maxWidth: 320 }}>{evidence}</div>}
    </div>
  );
}

const omit = <T,>(o: Record<string, T>, k: string) => {
  const c = { ...o };
  delete c[k];
  return c;
};

export function InferencePanel() {
  const s = useApp((st) => st);
  const a = s.analysis!;
  const par = parity(s);
  const fovs = [...new Set(a.topics.map((t) => effectiveFov(t, s)).filter(Boolean))].sort() as string[];
  const inputs = a.topics.filter((t) => effectiveRole(t, s) === "input");
  const set = (p: Partial<AppState>) => app.set(p);

  return (
    <Section
      title="Inferred settings"
      sub="Derived from this file only (no topic name, rate or FOV count is assumed). Change any value; your overrides are saved for this file, in the deep link and in every export."
      actions={
        <label className="row small" style={{ gap: 6 }} data-tip="A panel turns red when its message is older than k × the topic's nominal period">
          stale when age &gt; k × period, k =
          <input className="input mono" type="number" min={1} max={20} step={0.5} style={{ width: 64 }} aria-label="Stale factor k" value={s.staleK} onChange={(e) => set({ staleK: Math.max(1, +e.target.value || 3) })} />
        </label>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        {fovs.length} field{fovs.length === 1 ? "" : "s"} of view inferred{fovs.length ? `: ${fovs.join(", ")}` : ""}. A topic is an <b>output</b> when ≥ 50 % of its header.stamps exactly match an input's and it is logged after it; its <b>trigger</b> is the input whose missing frames suppress it (if several do, the one logged last).
      </p>
      <div className="table-wrap" tabIndex={0} style={{ maxHeight: 520 }}>
        <table className="t" data-testid="inference-table">
          <thead>
            <tr>
              <th>Topic</th>
              <th>Role</th>
              <th>Field of view</th>
              <th>Trigger (outputs)</th>
              <th>Nominal period</th>
              <th>Depth / colouring</th>
            </tr>
          </thead>
          <tbody>
            {a.topics.map((t) => (
              <Row key={t.topic} t={t} s={s} fovs={fovs} inputs={inputs} par={par} />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Row({ t, s, fovs, inputs, par }: { t: TopicData; s: AppState; fovs: string[]; inputs: TopicData[]; par: ReturnType<typeof parity> }) {
  const role = effectiveRole(t, s);
  const fov = effectiveFov(t, s);
  const out = par?.outputs.find((o) => o.output === t.topic);
  const inf = t.inference;
  const period = effectivePeriod(t, s);
  const depth = effectiveDepth(t, s);
  const periodEv = s.periodOverrides[t.topic] !== undefined ? undefined : (inf?.framePeriodNs ?? inf?.nominalPeriodNs)?.evidence;
  const cand = out?.inference.candidates ?? [];
  const triggerEv = out
    ? out.triggerSource === "override"
      ? `inferred: ${out.inference.trigger ?? "none"} — ${out.inference.reason}`
      : `${out.inference.reason}${cand.length > 1 ? ` · candidates: ${cand.map((c) => `${c.input} (${(c.matchRatio * 100).toFixed(0)}% stamps, missing in ${c.absentSlots} slots, output anyway in ${c.producedWithout})`).join("; ")}` : ""}`
    : undefined;
  return (
    <tr data-topic={t.topic}>
      <td className="mono small">{t.topic}<div className="xs muted">{t.type}</div></td>
      <td>
        <Cell evidence={s.roleOverrides[t.topic] ? `inferred: ${t.autoRole} — ${t.roleReason}` : t.roleReason}>
          <select className="input" aria-label={`Role of ${t.topic}`} value={role} onChange={(e) => app.set((st) => ({ roleOverrides: { ...st.roleOverrides, [t.topic]: e.target.value as TopicData["autoRole"] } }))}>
            <option value="input">input</option>
            <option value="output">output</option>
            <option value="unknown">unknown</option>
          </select>
          <Origin overridden={s.roleOverrides[t.topic] !== undefined} onReset={() => app.set((st) => ({ roleOverrides: omit(st.roleOverrides, t.topic) }))} />
        </Cell>
      </td>
      <td>
        <Cell evidence={s.fovOverrides[t.topic] !== undefined ? `inferred: ${t.autoFov ?? "none"}${t.fovReason ? ` — ${t.fovReason}` : ""}` : t.fovReason}>
          <input className="input mono" list="fov-list" style={{ width: 110 }} aria-label={`FOV of ${t.topic}`} value={fov ?? ""} placeholder="—" onChange={(e) => app.set((st) => ({ fovOverrides: { ...st.fovOverrides, [t.topic]: e.target.value } }))} />
          <datalist id="fov-list">{fovs.map((f) => <option key={f} value={f} />)}</datalist>
          <Origin overridden={s.fovOverrides[t.topic] !== undefined} onReset={() => app.set((st) => ({ fovOverrides: omit(st.fovOverrides, t.topic) }))} />
        </Cell>
      </td>
      <td>
        {role === "output" ? (
          <Cell evidence={triggerEv}>
            <select className="input mono" aria-label={`Trigger of ${t.topic}`} value={out?.trigger ?? ""} onChange={(e) => app.set((st) => ({ triggerOverrides: e.target.value ? { ...st.triggerOverrides, [t.topic]: e.target.value } : omit(st.triggerOverrides, t.topic) }))}>
              <option value="">— none —</option>
              {inputs.filter((i) => i.hasHeader).map((i) => (
                <option key={i.topic} value={i.topic}>{i.topic}</option>
              ))}
            </select>
            <Origin overridden={s.triggerOverrides[t.topic] !== undefined} onReset={() => app.set((st) => ({ triggerOverrides: omit(st.triggerOverrides, t.topic) }))} />
            {out?.triggerSource === "inferred" && out.inference.confidence === "tie-break" && (
              <span className="badge warn" data-testid="trigger-check" data-tip="No missing frame tells the candidate inputs apart: the choice is a tie-break. Confirm it or pick the right input.">check</span>
            )}
          </Cell>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <Cell evidence={periodEv}>
          <input
            className="input mono"
            type="number"
            min={0.1}
            step={0.1}
            style={{ width: 84 }}
            aria-label={`Nominal period of ${t.topic} (ms)`}
            value={Number.isFinite(period) ? +(period / 1e6).toFixed(3) : ""}
            onChange={(e) => {
              const v = +e.target.value;
              if (v > 0) app.set((st) => ({ periodOverrides: { ...st.periodOverrides, [t.topic]: v * 1e6 } }));
            }}
          />
          <span className="small muted">ms{Number.isFinite(period) && period > 0 ? ` (${(1e9 / period).toFixed(2)} Hz)` : ""}</span>
          <Origin overridden={s.periodOverrides[t.topic] !== undefined} onReset={() => app.set((st) => ({ periodOverrides: omit(st.periodOverrides, t.topic) }))} />
        </Cell>
      </td>
      <td>
        {inf?.depthUnit ? (
          <Cell evidence={[s.depthOverrides[t.topic]?.unit ? undefined : inf.depthUnit.evidence, s.depthOverrides[t.topic]?.maxM ? undefined : inf.depthMaxM?.evidence].filter(Boolean).join(" · ")}>
            <select className="input" aria-label={`Depth unit of ${t.topic}`} value={depth.unit} onChange={(e) => app.set((st) => ({ depthOverrides: { ...st.depthOverrides, [t.topic]: { ...st.depthOverrides[t.topic], unit: e.target.value as "mm" | "m" } } }))}>
              <option value="mm">mm</option>
              <option value="m">m</option>
            </select>
            <span className="small">0 –</span>
            <input className="input mono" type="number" min={0.1} step={0.5} style={{ width: 70 }} aria-label={`Depth display range of ${t.topic} (m)`} value={depth.maxM ?? ""} onChange={(e) => +e.target.value > 0 && app.set((st) => ({ depthOverrides: { ...st.depthOverrides, [t.topic]: { ...st.depthOverrides[t.topic], maxM: +e.target.value } } }))} />
            <span className="small">m</span>
            <Origin overridden={s.depthOverrides[t.topic] !== undefined} onReset={() => app.set((st) => ({ depthOverrides: omit(st.depthOverrides, t.topic) }))} />
          </Cell>
        ) : inf?.cloudColour ? (
          <Cell evidence={s.cloudColourOverrides[t.topic] ? undefined : inf.cloudColour.evidence}>
            <select className="input mono" aria-label={`Colouring of ${t.topic}`} value={effectiveCloudColour(t, s)} onChange={(e) => app.set((st) => ({ cloudColourOverrides: { ...st.cloudColourOverrides, [t.topic]: e.target.value } }))}>
              {["distance", ...(t.details["fields"] ?? "").split(",").map((f) => f.trim().split(":")[0]).filter(Boolean)].map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <Origin overridden={s.cloudColourOverrides[t.topic] !== undefined} onReset={() => app.set((st) => ({ cloudColourOverrides: omit(st.cloudColourOverrides, t.topic) }))} />
          </Cell>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}
