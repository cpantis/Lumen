/**
 * Random-access readers for MCAP files.
 *
 * `BlobReadable` reads slices of a browser `File`/`Blob` on demand, so a multi-GB
 * recording is never loaded into memory. A small block cache avoids re-reading the
 * same region (index records, neighbouring chunks).
 */
import type { McapTypes } from "@mcap/core";

export class BlobReadable implements McapTypes.IReadable {
  #blob: Blob;
  #cache = new Map<number, Uint8Array>();
  #order: number[] = [];
  static readonly BLOCK = 1 << 20; // 1 MiB
  static readonly MAX_BLOCKS = 64;

  constructor(blob: Blob) {
    this.#blob = blob;
  }

  async size(): Promise<bigint> {
    return BigInt(this.#blob.size);
  }

  async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    const start = Number(offset);
    const len = Number(size);
    if (start + len > this.#blob.size) throw new Error("Citire dincolo de sfârșitul fișierului");
    // Large reads (big chunks) bypass the cache.
    if (len > BlobReadable.BLOCK) {
      return new Uint8Array(await this.#blob.slice(start, start + len).arrayBuffer());
    }
    const out = new Uint8Array(len);
    let pos = start;
    while (pos < start + len) {
      const b = Math.floor(pos / BlobReadable.BLOCK);
      const block = await this.#block(b);
      const inBlock = pos - b * BlobReadable.BLOCK;
      const n = Math.min(block.length - inBlock, start + len - pos);
      out.set(block.subarray(inBlock, inBlock + n), pos - start);
      pos += n;
    }
    return out;
  }

  async #block(b: number): Promise<Uint8Array> {
    const hit = this.#cache.get(b);
    if (hit) return hit;
    const s = b * BlobReadable.BLOCK;
    const e = Math.min(this.#blob.size, s + BlobReadable.BLOCK);
    const data = new Uint8Array(await this.#blob.slice(s, e).arrayBuffer());
    this.#cache.set(b, data);
    this.#order.push(b);
    if (this.#order.length > BlobReadable.MAX_BLOCKS) this.#cache.delete(this.#order.shift()!);
    return data;
  }
}

/** Readable over an in-memory buffer (tests, small files). */
export class BufferReadable implements McapTypes.IReadable {
  constructor(private readonly buf: Uint8Array) {}
  async size(): Promise<bigint> {
    return BigInt(this.buf.length);
  }
  async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    return this.buf.subarray(Number(offset), Number(offset + size));
  }
}
