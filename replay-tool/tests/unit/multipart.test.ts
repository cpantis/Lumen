/**
 * Multi-part loading: a recording split into consecutive MCAP files (as `ros2 bag record
 * --max-bag-size` does) must give exactly the same analysis as the single file, whatever
 * channel ids each part uses. Also: un-indexed files are read through a block index,
 * without keeping the messages in memory.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { McapWriter, TempBuffer } from "@mcap/core";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeRecording, iterateAll, openRecording } from "../../src/core/analyze";
import type { Analysis } from "../../src/core/types";
import { nodeSource } from "../../scripts/node-source";

const FILE = "fixtures/test-multipart-src.mcap";
const DIR = "fixtures/multipart";

async function writePart(path: string, msgs: Array<{ topic: string; logTime: bigint; data: Uint8Array }>, rec: Awaited<ReturnType<typeof openRecording>>, reverse: boolean, indexed = true) {
  const buf = new TempBuffer();
  const w = new McapWriter({ writable: buf, useChunks: true, chunkSize: 256 * 1024, useStatistics: indexed, useSummaryOffsets: indexed, useChunkIndex: indexed, useMessageIndex: indexed, repeatChannels: indexed, repeatSchemas: indexed });
  await w.start({ profile: "ros2", library: "test" });
  const chans = [...rec.channels.values()];
  if (reverse) chans.reverse(); // different channel ids than in part 1
  const idOf = new Map<string, number>();
  for (const c of chans) {
    const sc = rec.schemas.get(c.schemaId)!;
    const sid = await w.registerSchema({ name: sc.name, encoding: sc.encoding, data: sc.data });
    idOf.set(c.topic, await w.registerChannel({ topic: c.topic, messageEncoding: c.messageEncoding, schemaId: sid, metadata: new Map() }));
  }
  let seq = 0;
  for (const m of msgs) await w.addMessage({ channelId: idOf.get(m.topic)!, sequence: seq++, logTime: m.logTime, publishTime: m.logTime, data: m.data });
  await w.end();
  writeFileSync(path, buf.get());
}

let single: Analysis;
let merged: Analysis;

beforeAll(async () => {
  execFileSync("npx", ["tsx", "scripts/gen-synthetic.ts", FILE, "--seconds", "6"], { stdio: "ignore" });
  mkdirSync(DIR, { recursive: true });
  const rec = await openRecording(nodeSource(FILE));
  const all: Array<{ topic: string; logTime: bigint; data: Uint8Array }> = [];
  for await (const m of iterateAll(rec)) all.push({ topic: rec.channels.get(m.channelId)!.topic, logTime: m.logTime, data: m.data.slice() });
  const cut1 = Math.floor(all.length * 0.37), cut2 = Math.floor(all.length * 0.71);
  await writePart(`${DIR}/rec_0.mcap`, all.slice(0, cut1), rec, false);
  await writePart(`${DIR}/rec_1.mcap`, all.slice(cut1, cut2), rec, true);
  await writePart(`${DIR}/rec_2.mcap`, all.slice(cut2), rec, false, false); // last part un-indexed (e.g. recorder killed)
  single = (await analyzeRecording(nodeSource(FILE))).analysis;
  merged = (await analyzeRecording([0, 1, 2].map((i) => nodeSource(`${DIR}/rec_${i}.mcap`)))).analysis;
}, 120_000);

describe("multi-part recordings", () => {
  it("merges the parts by log time: identical per-topic arrays", () => {
    expect(merged.topics.map((t) => t.topic)).toEqual(single.topics.map((t) => t.topic));
    expect(merged.startNs).toBe(single.startNs);
    expect(merged.durationNs).toBe(single.durationNs);
    for (const t of single.topics) {
      const m = merged.topics.find((x) => x.topic === t.topic)!;
      expect(m.count, t.topic).toBe(t.count);
      expect(Array.from(m.log)).toEqual(Array.from(t.log));
      expect(Array.from(m.stamp)).toEqual(Array.from(t.stamp));
      expect(Array.from(m.content.hash)).toEqual(Array.from(t.content.hash));
    }
  });
  it("gives the same inference and causality", () => {
    for (const t of single.topics) expect(merged.topics.find((x) => x.topic === t.topic)!.autoRole).toBe(t.autoRole);
    expect(merged.edges.map((e) => `${e.input}->${e.output}:${e.matched}`)).toEqual(single.edges.map((e) => `${e.input}->${e.output}:${e.matched}`));
  });
  it("records every file with its SHA-256 and a combined hash", () => {
    expect(merged.files!.map((f) => f.name)).toEqual(["rec_0.mcap", "rec_1.mcap", "rec_2.mcap"]);
    expect(merged.files!.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(merged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([merged.sha256, ...merged.files!.map((f) => f.sha256)]).size).toBe(4);
    expect(merged.fileName).toBe("rec_0.mcap + rec_1.mcap + rec_2.mcap");
  });
});

describe("un-indexed files are not loaded in memory", () => {
  it("keeps only a block index (offsets), decoded on demand", async () => {
    const rec = await openRecording(nodeSource(`${DIR}/rec_2.mcap`));
    expect(rec.indexed).toBe(false);
    expect(rec.lazy!.blocks.length).toBeGreaterThan(1);
    expect(rec.lazy!.blocks.every((b) => b.kind === "chunk" && b.length > 0)).toBe(true);
    expect("messages" in rec).toBe(false);
    let n = 0, prev = -1n;
    for await (const m of iterateAll(rec)) {
      expect(m.logTime >= prev).toBe(true);
      prev = m.logTime;
      n++;
    }
    expect(n).toBe(rec.lazy!.blocks.reduce((s, b) => s + b.count, 0));
  });
});
