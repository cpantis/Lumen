/** Promise-based client for the analysis worker. */
import type { PlausibleRanges } from "../core/content";
import type { Analysis } from "../core/types";
import type { DecodedMessage, RenderOptions, Request, Response } from "./protocol";

type Pending = { resolve: (r: Response) => void; reject: (e: Error) => void; onProgress?: (phase: string, f: number) => void };

class WorkerClient {
  #worker: Worker | undefined;
  #id = 1;
  #pending = new Map<number, Pending>();

  #ensure(): Worker {
    if (!this.#worker) {
      this.#worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
      this.#worker.onmessage = (ev: MessageEvent<Response>) => {
        const r = ev.data;
        const p = this.#pending.get(r.id);
        if (!p) return;
        if (r.op === "progress") return p.onProgress?.(r.phase, r.fraction);
        this.#pending.delete(r.id);
        if (r.op === "error") p.reject(new Error(r.error));
        else p.resolve(r);
      };
      this.#worker.onerror = (e) => {
        for (const p of this.#pending.values()) p.reject(new Error(e.message || "Eroare în worker"));
        this.#pending.clear();
      };
    }
    return this.#worker;
  }

  #call(req: Omit<Request, "id">, onProgress?: Pending["onProgress"]): Promise<Response> {
    const id = this.#id++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onProgress });
      this.#ensure().postMessage({ ...req, id });
    });
  }

  /** Terminates the worker (cancel / close file). */
  reset(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    for (const p of this.#pending.values()) p.reject(new Error("anulat"));
    this.#pending.clear();
  }

  async open(file: File, onProgress: (phase: string, f: number) => void, ranges?: PlausibleRanges): Promise<Analysis> {
    const r = await this.#call({ op: "open", file, ranges } as Omit<Request, "id">, onProgress);
    if (r.op !== "opened") throw new Error("răspuns neașteptat");
    return r.analysis;
  }

  async get(topic: string, index: number, render?: RenderOptions, prefetch = 3): Promise<DecodedMessage> {
    const r = await this.#call({ op: "get", topic, index, render, prefetch } as Omit<Request, "id">);
    if (r.op !== "message") throw new Error("răspuns neașteptat");
    return r.message;
  }

  async series(topic: string, path: string, maxPoints?: number): Promise<{ t: Float64Array; v: Float64Array; truncated: boolean }> {
    const r = await this.#call({ op: "series", topic, path, maxPoints } as Omit<Request, "id">);
    if (r.op !== "series") throw new Error("răspuns neașteptat");
    return r;
  }

  async schemas(): Promise<Array<{ name: string; encoding: string; text: string }>> {
    const r = await this.#call({ op: "schemas" } as Omit<Request, "id">);
    if (r.op !== "schemas") throw new Error("răspuns neașteptat");
    return r.schemas;
  }
}

export const worker = new WorkerClient();
