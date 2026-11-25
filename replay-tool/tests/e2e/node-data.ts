/**
 * Ground truth for the panel checks: the same recording decoded independently in Node
 * (core library, no browser, no worker), to compare against what the panels draw.
 */
import { analyzeRecording, iterateAll, openRecording } from "../../src/core/analyze";
import { makeDecoder } from "../../src/core/decode";
import type { Analysis } from "../../src/core/types";
import { nodeSource } from "../../scripts/node-source";

const cache = new Map<string, Analysis>();

export async function analysisOf(file: string): Promise<Analysis> {
  if (!cache.has(file)) cache.set(file, (await analyzeRecording(nodeSource(file), { hash: false })).analysis);
  return cache.get(file)!;
}

/** Decoded message #index of a topic (log-time order, same as the app). */
export async function messageAt(file: string, topic: string, index: number): Promise<any> {
  const rec = await openRecording(nodeSource(file));
  const ch = [...rec.channels.values()].find((c) => c.topic === topic)!;
  const dec = makeDecoder(ch, rec.schemas.get(ch.schemaId));
  let i = 0;
  for await (const m of iterateAll(rec, [topic])) if (i++ === index) return dec(m.data);
  throw new Error(`no message #${index} on ${topic}`);
}
