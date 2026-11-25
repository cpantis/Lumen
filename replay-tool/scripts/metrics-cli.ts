/**
 * Headless metrics + requirement evaluation, using exactly the same core as the app.
 *
 *   npm run metrics -- recording.mcap [part2.mcap …] [--out out/] [--thresholds config/thresholds.yaml]
 *                      [--requirements python_project/requirements.yaml]
 *
 * Several files = consecutive parts of one recording (merged by log time).
 * Writes: metrics.json (incl. the Python-suite metrics per output), report-derived.json,
 * report-strict.json, and with --requirements requirements-vs-stamptrace.json (threshold
 * vs measured per requirement id; informational, no PASS/FAIL of record).
 * The app can import these files (Requirements → import report / cross-check).
 * Exit code 1 when the derived profile has failures (useful in CI).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeRecording } from "../src/core/analyze";
import { buildMetrics } from "../src/core/metrics";
import { computeParity } from "../src/core/parity";
import { evaluatePyRequirements, parsePyRequirements } from "../src/core/pyreq";
import { evaluate, parseThresholds, toReport } from "../src/core/requirements";
import { nodeSource } from "./node-source";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const files = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const file = files[0];
if (!file) {
  console.error("Usage: npm run metrics -- file.mcap [--out out/] [--thresholds config/thresholds.yaml]");
  process.exit(2);
}
const outDir = opt("--out", "out");
const cfg = parseThresholds(readFileSync(opt("--thresholds", "config/thresholds.yaml"), "utf8"));
const TOOL = `StampTrace CLI ${process.env.npm_package_version ?? "1.0.0"} by Calin Pantis`;

const { analysis } = await analyzeRecording(files.map(nodeSource), { ranges: cfg.plausible_ranges });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "metrics.json"), JSON.stringify(buildMetrics(analysis, TOOL), null, 2));
let failed = 0;
for (const profile of ["derived", "strict"] as const) {
  const res = evaluate(analysis, cfg, profile);
  writeFileSync(join(outDir, `report-${profile}.json`), JSON.stringify(toReport(analysis, res, profile, TOOL), null, 2));
  console.log(`\n== Profile ${profile} ==`);
  for (const r of res) console.log(`${r.verdict.padEnd(4)} ${r.id.padEnd(13)} ${r.safety ? "[safety] " : ""}${r.title} — ${r.summary}`);
  if (profile === "derived") failed = res.filter((r) => r.verdict === "FAIL").length;
}
const reqFile = opt("--requirements", "");
if (reqFile) {
  const { requirements, warnings } = parsePyRequirements(readFileSync(reqFile, "utf8"));
  const par = computeParity(analysis.topics, (t) => t.autoRole === "output", (t) => t.autoRole === "input", analysis.durationNs);
  const rows = evaluatePyRequirements(requirements, analysis.topics, par);
  writeFileSync(join(outDir, "requirements-vs-stamptrace.json"), JSON.stringify({ file: analysis.fileName, sha256: analysis.sha256, files: analysis.files, requirements_file: reqFile, note: "informational comparison; no PASS/FAIL of record", warnings, rows }, null, 2));
  console.log(`\n== ${reqFile}: threshold vs StampTrace ==`);
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const r of rows) console.log(`${r.id.padEnd(16)} ${r.topic.padEnd(34)} ${r.operator} ${r.threshold} ${r.unit}`.padEnd(70) + ` measured: ${r.measured !== undefined ? `${+r.measured.toFixed(4)} ${r.unit}` : `not computed here (${r.notComputed})`}`);
}
console.log(`\nsha256 ${analysis.sha256}\nResults written to ${outDir}/`);
process.exit(failed ? 1 : 0);
