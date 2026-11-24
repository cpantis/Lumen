/**
 * Exports of the replay layout: PNG snapshot of all panels + timeline at the current
 * moment (with the traceability line burnt in), and WebM video of the A–B interval
 * rendered frame by frame (MediaRecorder on a composite canvas).
 */
import { toCanvas } from "html-to-image";
import { download } from "../core/inventory";
import { seek, setPlaying } from "../state/actions";
import { app, clock, toast } from "../state/store";
import { traceLine } from "../state/trace";

async function renderLayout(): Promise<HTMLCanvasElement | undefined> {
  const el = document.querySelector(".replay") as HTMLElement | null;
  if (!el) return undefined;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#000";
  const c = await toCanvas(el, { backgroundColor: bg, pixelRatio: 1, cacheBust: true, skipFonts: true, filter: (n) => !(n instanceof HTMLElement && n.classList.contains("tooltip")) });
  const out = document.createElement("canvas");
  out.width = c.width;
  out.height = c.height + 28;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() || "#999";
  ctx.font = "12px JetBrains Mono, monospace";
  ctx.fillText(`t = ${(clock.get().t / 1e9).toFixed(3)} s · ${traceLine()}`.slice(0, 260), 10, c.height + 18);
  return out;
}

/** PNG data URL of the replay layout (undefined when not in the replay view). */
export async function snapshotPng(): Promise<string | undefined> {
  const c = await renderLayout();
  return c?.toDataURL("image/png");
}

export async function downloadSnapshot(): Promise<void> {
  if (app.get().view !== "replay") app.set({ view: "replay" });
  await new Promise((r) => setTimeout(r, 300));
  const png = await snapshotPng();
  if (!png) return;
  const blob = await (await fetch(png)).blob();
  download(`stamptrace-${(clock.get().t / 1e9).toFixed(3)}s.png`, blob, "image/png");
  toast("PNG snapshot saved");
}

/** Renders the A–B interval to WebM at `fps` frames per (recording) second. */
export async function exportVideo(fps = 10): Promise<void> {
  const s = app.get();
  if (s.markA === undefined || s.markB === undefined) {
    toast("Set cursors A and B first (the interval to export)");
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    toast("This browser does not support MediaRecorder");
    return;
  }
  app.set({ view: "replay" });
  setPlaying(false);
  const lo = Math.min(s.markA, s.markB), hi = Math.max(s.markA, s.markB);
  const first = await renderLayout();
  if (!first) return;
  const rec = document.createElement("canvas");
  rec.width = first.width;
  rec.height = first.height;
  const ctx = rec.getContext("2d")!;
  const stream = rec.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
  const chunks: Blob[] = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((r) => (mr.onstop = () => r()));
  mr.start();
  const frames = Math.max(1, Math.ceil(((hi - lo) / 1e9) * fps));
  toast(`Video export: ${frames} frames…`);
  for (let k = 0; k <= frames; k++) {
    seek(lo + (k / frames) * (hi - lo));
    await new Promise((r) => setTimeout(r, 120)); // let panels fetch & draw
    const c = await renderLayout();
    if (c) ctx.drawImage(c, 0, 0, rec.width, rec.height);
    track.requestFrame?.();
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  mr.stop();
  await done;
  download(`stamptrace-${(lo / 1e9).toFixed(2)}-${(hi / 1e9).toFixed(2)}s.webm`, new Blob(chunks, { type: "video/webm" }), "video/webm");
  toast("Video exported");
}
