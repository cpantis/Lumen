/** Node implementation of `RecordingSource` (random access via file handles). */
import { openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { RecordingSource } from "../src/core/analyze";

export function nodeSource(path: string): RecordingSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  const read = (start: number, end: number) => {
    const buf = new Uint8Array(end - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return buf;
  };
  return {
    name: basename(path),
    size,
    readable: {
      size: async () => BigInt(size),
      read: async (offset, len) => read(Number(offset), Number(offset + len)),
    },
    readSlice: async (s, e) => read(s, e),
  };
}
