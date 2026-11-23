/**
 * Inspection script (first step of the prompt's workflow): lists topics, types,
 * schemas and statistics of a real recording, to confirm what the app must support.
 *
 * Usage: npm run inspect -- path/to/recording.mcap [--schemas]
 */
import { analyzeRecording } from "../src/core/analyze";
import { NS_PER_MS } from "../src/core/time";
import { nodeSource } from "./node-source";

const path = process.argv[2];
if (!path) {
  console.error("Utilizare: npm run inspect -- fișier.mcap [--schemas]");
  process.exit(2);
}
const showSchemas = process.argv.includes("--schemas");

const src = nodeSource(path);
const { analysis: a, opened } = await analyzeRecording(src, { hash: true });
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
console.log(`\n${a.fileName}  ${(a.fileSize / 1e6).toFixed(1)} MB  sha256=${a.sha256}`);
console.log(`durată ${(a.durationNs / 1e9).toFixed(3)} s · ${a.indexed ? "indexat" : "NEINDEXAT"} · ${a.topics.length} topicuri`);
for (const w of a.warnings) console.log(`⚠ ${w}`);
console.log("\n" + [pad("topic", 28), pad("tip", 30), pad("msg", 6), pad("Hz", 7), pad("jitter", 9), pad("gol max", 9), pad("rol", 8), "motiv"].join(" "));
for (const t of a.topics) {
  console.log(
    [
      pad(t.topic, 28),
      pad(t.type, 30),
      pad(String(t.count), 6),
      pad(t.rate.meanHz.toFixed(2), 7),
      pad(`${(t.rate.jitterNs / NS_PER_MS).toFixed(2)}ms`, 9),
      pad(`${(t.rate.maxGapNs / NS_PER_MS).toFixed(0)}ms`, 9),
      pad(t.autoRole, 8),
      t.roleReason,
    ].join(" "),
  );
  for (const [k, v] of Object.entries(t.details)) console.log(`      ${k}: ${v}`);
  if (t.firstError) console.log(`      ⚠ decodare: ${t.firstError}`);
}
console.log("\nCauzalitate:");
for (const e of a.edges)
  console.log(`  ${e.input} → ${e.output}  [${e.kind}] potrivire ${(e.matchRate * 100).toFixed(1)}%  latență p50 ${(e.latencySummary.p50 / NS_PER_MS).toFixed(1)} ms p95 ${(e.latencySummary.p95 / NS_PER_MS).toFixed(1)} ms  cadre sărite ${(e.dropRatio * 100).toFixed(1)}%`);
console.log("\nFOV:");
for (const g of a.fovGroups) console.log(`  ${g.fov}: intrare ${g.primaryInput} → ${g.outputs.join(", ")}  complet ${(g.completeRatio * 100).toFixed(1)}%`);
console.log(`\nMișcare: ${a.motion.note} → ${a.motion.speedMps.toFixed(2)} m/s`);
if (showSchemas) for (const s of opened.schemas.values()) console.log(`\n--- ${s.name} (${s.encoding})\n${new TextDecoder().decode(s.data)}`);
