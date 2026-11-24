/**
 * Hooks connecting panels to the replay cursor.
 *
 * `usePanelIndex` returns the index of the message to display for a topic at the
 * current cursor (respecting the time source and the optional "follow output" mode,
 * in which an input panel shows the exact input frame used by the current output).
 * `useDecoded` fetches that message from the worker with at most one request in
 * flight per panel (latest-wins), so fast scrubbing never floods the worker.
 */
import { useEffect, useRef, useState } from "react";
import type { TopicData } from "../core/types";
import type { DecodedMessage, RenderOptions } from "../worker/protocol";
import { worker } from "../worker/client";
import { indexAt, timeOf } from "../state/actions";
import { app, clock, useApp, useClock } from "../state/store";

export function usePanelIndex(t: TopicData | undefined, followOutput?: string): { index: number; matchedFrom?: string } {
  const cursor = useClock();
  const source = useApp((s) => s.timeSource);
  const a = useApp((s) => s.analysis);
  if (!t || !a) return { index: -1 };
  if (followOutput) {
    const e = a.edges.find((x) => x.input === t.topic && x.output === followOutput);
    const ot = a.topics.find((x) => x.topic === followOutput);
    if (e && ot) {
      const j = indexAt(ot, cursor, source);
      if (j >= 0 && e.inputIndex[j] >= 0) return { index: e.inputIndex[j], matchedFrom: followOutput };
      return { index: -1, matchedFrom: followOutput };
    }
  }
  return { index: indexAt(t, cursor, source) };
}

export function useDecoded(topic: string | undefined, index: number, render?: RenderOptions): { msg?: DecodedMessage; loading: boolean } {
  const [msg, setMsg] = useState<DecodedMessage | undefined>();
  const [loading, setLoading] = useState(false);
  const inflight = useRef(false);
  const wanted = useRef<{ index: number; key: string }>({ index: -1, key: "" });
  const renderKey = JSON.stringify(render ?? {});
  const phase = useApp((s) => s.phase);

  useEffect(() => {
    if (!topic || index < 0 || phase !== "ready") {
      setMsg(undefined);
      return;
    }
    const key = `${topic}#${index}#${renderKey}`;
    wanted.current = { index, key };
    let cancelled = false;
    const run = async () => {
      if (inflight.current) return;
      inflight.current = true;
      setLoading(true);
      while (!cancelled) {
        const w = wanted.current;
        try {
          const m = await worker.get(topic, w.index, render, app.get().playing ? 4 : 2);
          if (cancelled) break;
          setMsg(m);
        } catch {
          /* worker reset */
        }
        if (wanted.current.key === w.key) break;
      }
      inflight.current = false;
      setLoading(false);
    };
    run();
    return () => {
      cancelled = true;
      inflight.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, index, renderKey, phase]);

  return { msg, loading };
}

/** Age of message i at the current cursor (ns). */
export function useAge(t: TopicData | undefined, index: number): number {
  const cursor = useClock();
  const source = useApp((s) => s.timeSource);
  if (!t || index < 0) return NaN;
  return cursor - timeOf(t, index, source);
}

/** Returns a callback reading the current cursor without subscribing. */
export const cursorNow = () => clock.get().t;
