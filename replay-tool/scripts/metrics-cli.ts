/**
 * Headless metrics + requirement evaluation, using exactly the same core as the app.
 *
 *   npm run metrics -- recording.mcap [--out out/] [--thresholds config/thresholds.yaml]
 *
 * Writes: metrics.json, report-derived.json, report-strict.json (and prints a summary).
 * The app can import these files (Requirements → import report / cross-check).
 * Exit code 1 when the derived profile has failures (useful in CI).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeRecording } from "../src/core/analyze";
import { buildMetrics } from "../src/core/metrics";
import { evaluate, parseThresholds, toReport } from "../src/core/requirements";
import { nodeSource } from "./node-source";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!file) {
  console.error("Utilizare: npm run metrics -- fișier.mcap [--out out/] [--thresholds config/thresholds.yaml]");
  process.exit(2);
}
const outDir = opt("--out", "out");
const cfg = parseThresholds(readFileSync(opt("--thresholds", "config/thresholds.yaml"), "utf8"));
const TOOL = `lumen-replay-cli ${process.env.npm_package_version ?? "1.0.0"}`;

const { analysis } = await analyzeRecording(nodeSource(file), { ranges: cfg.plausible_ranges });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "metrics.json"), JSON.stringify(buildMetrics(analysis, TOOL), null, 2));
let failed = 0;
for (const profile of ["derived", "strict"] as const) {
  const res = evaluate(analysis, cfg, profile);
  writeFileSync(join(outDir, `report-${profile}.json`), JSON.stringify(toReport(analysis, res, profile, TOOL), null, 2));
  console.log(`\n== Profil ${profile} ==`);
  for (const r of res) console.log(`${r.verdict.padEnd(4)} ${r.id.padEnd(13)} ${r.safety ? "[siguranță] " : ""}${r.title} — ${r.summary}`);
  if (profile === "derived") failed = res.filter((r) => r.verdict === "FAIL").length;
}
console.log(`\nsha256 ${analysis.sha256}\nRezultate scrise în ${outDir}/`);
process.exit(failed ? 1 : 0);
