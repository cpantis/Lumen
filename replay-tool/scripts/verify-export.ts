/**
 * Writes StampTrace's verification.json for a recording (same code as the app):
 *   npx tsx scripts/verify-export.ts recording.mcap [part2.mcap …] [--out verification.json] [--trigger OUT=IN …]
 */
import { writeFileSync } from "node:fs";
import { analyzeRecording } from "../src/core/analyze";
import { computeParity } from "../src/core/parity";
import { buildVerification } from "../src/core/verification";
import { nodeSource } from "./node-source";

const args = process.argv.slice(2);
const files: string[] = [];
const triggers: Record<string, string> = {};
let out = "verification.json";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i];
  else if (args[i] === "--trigger") {
    const [o, inp] = args[++i].split("=");
    triggers[o] = inp;
  } else files.push(args[i]);
}
if (!files.length) {
  console.error("Usage: npx tsx scripts/verify-export.ts file.mcap [--out verification.json] [--trigger /out=/in]");
  process.exit(2);
}
const { analysis: a } = await analyzeRecording(files.map(nodeSource));
const par = computeParity(a.topics, (t) => t.autoRole === "output", (t) => t.autoRole === "input", a.durationNs, triggers);
const period = (t: (typeof a.topics)[number]) => t.inference?.framePeriodNs?.value ?? t.inference?.nominalPeriodNs.value ?? NaN;
writeFileSync(out, JSON.stringify(buildVerification(a, par, "StampTrace CLI", period), null, 2));
console.log(`wrote ${out} (${a.topics.length} topics, ${par.outputs.length} outputs, sha256 ${a.sha256})`);
