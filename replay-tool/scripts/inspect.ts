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
  console.error("Usage: npm run inspect -- file.mcap [--schemas]");
  process.exit(2);
}
const showSchemas = process.argv.includes("--schemas");

const src = nodeSource(path);
const { analysis: a, opened } = await analyzeRecording(src, { hash: true });
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
console.log(`\n${a.fileName}  ${(a.fileSize / 1e6).toFixed(1)} MB  sha256=${a.sha256}`);
console.log(`duration ${(a.durationNs / 1e9).toFixed(3)} s · ${a.indexed ? "indexed" : "NOT INDEXED"} · ${a.topics.length} topics`);
for (const w of a.warnings) console.log(`⚠ ${w}`);
console.log("\n" + [pad("topic", 28), pad("type", 30), pad("msgs", 6), pad("Hz", 7), pad("jitter", 9), pad("max gap", 9), pad("role", 8), "evidence"].join(" "));
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
  if (t.firstError) console.log(`      ⚠ decoding: ${t.firstError}`);
}
console.log("\nCausality:");
for (const e of a.edges)
  console.log(`  ${e.input} → ${e.output}  [${e.kind}] match ${(e.matchRate * 100).toFixed(1)}%  latency p50 ${(e.latencySummary.p50 / NS_PER_MS).toFixed(1)} ms p95 ${(e.latencySummary.p95 / NS_PER_MS).toFixed(1)} ms  skipped frames ${(e.dropRatio * 100).toFixed(1)}%`);
console.log("\nFOV:");
for (const g of a.fovGroups) console.log(`  ${g.fov}: input ${g.primaryInput} → ${g.outputs.join(", ")}  complete ${(g.completeRatio * 100).toFixed(1)}%`);
console.log(`\nMotion: ${a.motion.note} → ${a.motion.speedMps.toFixed(2)} m/s`);
if (showSchemas) for (const s of opened.schemas.values()) console.log(`\n--- ${s.name} (${s.encoding})\n${new TextDecoder().decode(s.data)}`);
