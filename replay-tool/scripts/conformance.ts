/**
 * MCAP conformance check: runs the app's reader + full analysis on the official MCAP
 * conformance files (github.com/foxglove/mcap, tests/conformance/data, MIT) and
 * compares every message (topic, log_time) with the expected records in <Name>.json.
 *
 * Usage: npm run conformance -- [dir]   (default fixtures/conformance)
 * Exit code 1 if any file fails.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyzeRecording, iterateAll, openRecording } from "../src/core/analyze";
import { nodeSource } from "./node-source";

type Rec = { type: string; fields: Array<[string, unknown]> };

export interface ConformanceResult {
  file: string;
  ok: boolean;
  indexed: boolean;
  expected: number;
  found: number;
  error?: string;
}

function expectedMessages(json: { records: Rec[] }) {
  const ch = new Map<string, string>();
  const msgs: Array<{ topic: string; log: bigint }> = [];
  let metadata = 0;
  for (const r of json.records) {
    const f = Object.fromEntries(r.fields);
    if (r.type === "Channel") ch.set(String(f.id), String(f.topic));
    if (r.type === "Message") msgs.push({ topic: ch.get(String(f.channel_id)) ?? "?", log: BigInt(String(f.log_time)) });
    if (r.type === "Metadata") metadata++;
  }
  return { msgs, metadata };
}

export async function checkFile(path: string, expected: { records: Rec[] }): Promise<ConformanceResult> {
  const exp = expectedMessages(expected);
  try {
    const src = nodeSource(path);
    const opened = await openRecording(src);
    const got: Array<{ topic: string; log: bigint }> = [];
    for await (const m of iterateAll(opened)) got.push({ topic: opened.channels.get(m.channelId)?.topic ?? "?", log: m.logTime });
    // the full analysis must not throw either (unknown encodings → decode errors, not crashes)
    const { analysis } = await analyzeRecording(src, { hash: false, opened });
    const key = (x: { topic: string; log: bigint }) => `${x.topic}@${x.log}`;
    const a = exp.msgs.map(key).sort().join("|");
    const b = got.map(key).sort().join("|");
    const counted = analysis.topics.reduce((s, t) => s + t.count, 0);
    const ok = a === b && counted === exp.msgs.length && (exp.metadata === 0 || !opened.indexed || analysis.metadata.length === exp.metadata);
    return { file: path, ok, indexed: opened.indexed, expected: exp.msgs.length, found: got.length, error: ok ? undefined : `expected ${a || "∅"} / found ${b || "∅"} / analysis ${counted}` };
  } catch (e) {
    return { file: path, ok: false, indexed: false, expected: exp.msgs.length, found: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runConformance(dir: string): Promise<ConformanceResult[]> {
  const out: ConformanceResult[] = [];
  for (const name of readdirSync(dir).sort()) {
    const sub = join(dir, name);
    if (!statSync(sub).isDirectory()) continue;
    const expected = JSON.parse(readFileSync(join(sub, `${name}.json`), "utf8"));
    for (const f of readdirSync(sub).filter((x) => x.endsWith(".mcap")).sort()) out.push(await checkFile(join(sub, f), expected));
  }
  return out;
}

if (process.argv[1]?.endsWith("conformance.ts")) {
  const dir = process.argv[2] ?? "fixtures/conformance";
  const res = await runConformance(dir);
  const bad = res.filter((r) => !r.ok);
  for (const r of bad) console.log(`FAIL ${r.file}: ${r.error}`);
  const idx = res.filter((r) => r.indexed).length;
  console.log(`\n${res.length - bad.length}/${res.length} files conform (${idx} read indexed, ${res.length - idx} sequentially)`);
  process.exit(bad.length ? 1 : 0);
}
