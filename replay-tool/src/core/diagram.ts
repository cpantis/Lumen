/**
 * Component I/O diagram generated from the causal edges (2.2): Mermaid text (for the
 * document) and a positioned layout used by the in-app SVG renderer.
 */
import type { Analysis, CausalEdge, Role, TopicData } from "./types";

export function mermaidDiagram(a: Analysis, role: (t: TopicData) => Role, fov: (t: TopicData) => string | undefined): string {
  const id = (s: string) => "n" + s.replace(/[^a-zA-Z0-9]/g, "_");
  const lines = ["flowchart LR"];
  const inputs = a.topics.filter((t) => role(t) === "input");
  const outputs = a.topics.filter((t) => role(t) === "output");
  lines.push('  subgraph IN["Intrări (senzori)"]');
  for (const t of inputs) lines.push(`    ${id(t.topic)}["${t.topic}<br/><small>${t.type} · ${t.rate.meanHz.toFixed(1)} Hz</small>"]`);
  lines.push("  end");
  lines.push('  C(["Componentă<br/>(nedocumentată)"])');
  const fovs = [...new Set(outputs.map((t) => fov(t) ?? "fără FOV"))];
  for (const f of fovs) {
    lines.push(`  subgraph ${id("fov_" + f)}["Ieșiri FOV ${f}"]`);
    for (const t of outputs.filter((o) => (fov(o) ?? "fără FOV") === f)) lines.push(`    ${id(t.topic)}["${t.topic}<br/><small>${t.type} · ${t.rate.meanHz.toFixed(1)} Hz</small>"]`);
    lines.push("  end");
  }
  const usedInputs = new Set(a.edges.map((e) => e.input));
  for (const t of inputs.filter((i) => usedInputs.has(i.topic))) {
    const es = a.edges.filter((e) => e.input === t.topic);
    const exact = es.some((e) => e.kind === "exact");
    lines.push(`  ${id(t.topic)} ${exact ? "-->" : "-.->"} C`);
  }
  for (const e of a.edges) {
    const label = `${e.kind === "exact" ? "stamp exact" : "temporal"} ${(e.matchRate * 100).toFixed(0)}% · p50 ${(e.latencySummary.p50 / 1e6).toFixed(0)} ms`;
    lines.push(`  C ${e.kind === "exact" ? "-->" : "-.->"}|"${e.input.split("/").filter(Boolean)[0]}: ${label}"| ${id(e.output)}`);
  }
  return lines.join("\n");
}

export interface DiagramNode {
  topic: string;
  x: number;
  y: number;
  role: Role;
  fov?: string;
  label: string;
  sub: string;
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: DiagramNode[];
  component: { x: number; y: number; w: number; h: number };
  edges: Array<{ from: DiagramNode; to: DiagramNode; edge: CausalEdge }>;
}

/** Simple 3-column layout: inputs | component | outputs grouped by FOV. */
export function layoutDiagram(a: Analysis, role: (t: TopicData) => Role, fov: (t: TopicData) => string | undefined): DiagramLayout {
  const inputs = a.topics.filter((t) => role(t) === "input");
  const outputs = [...a.topics.filter((t) => role(t) === "output")].sort((x, y) => (fov(x) ?? "~").localeCompare(fov(y) ?? "~") || x.topic.localeCompare(y.topic));
  const rowH = 64;
  const height = Math.max(inputs.length, outputs.length + 1) * rowH + 60;
  const width = 1000;
  const mk = (t: TopicData, x: number, y: number): DiagramNode => ({
    topic: t.topic,
    x,
    y,
    role: role(t),
    fov: fov(t),
    label: t.topic,
    sub: `${t.type} · ${Number.isFinite(t.rate.meanHz) ? t.rate.meanHz.toFixed(1) : "—"} Hz`,
  });
  const inNodes = inputs.map((t, i) => mk(t, 20, 40 + i * rowH + (height - 60 - inputs.length * rowH) / 2));
  let y = 40;
  let lastFov: string | undefined = "__";
  const outNodes = outputs.map((t) => {
    if (fov(t) !== lastFov && lastFov !== "__") y += 16;
    lastFov = fov(t);
    const n = mk(t, width - 300, y);
    y += rowH;
    return n;
  });
  const component = { x: width / 2 - 90, y: height / 2 - 50, w: 180, h: 100 };
  const byTopic = new Map([...inNodes, ...outNodes].map((n) => [n.topic, n]));
  const edges = a.edges
    .map((e) => ({ from: byTopic.get(e.input)!, to: byTopic.get(e.output)!, edge: e }))
    .filter((e) => e.from && e.to);
  return { width, height: Math.max(height, y + 20), nodes: [...inNodes, ...outNodes], component, edges };
}
