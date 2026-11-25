/**
 * Capture of the replay layout: all panels + timeline (with its cursor) and the
 * traceability line burnt in. Used by the PNG snapshot and by the video export
 * (src/export/video.ts).
 */
import { toCanvas } from "html-to-image";
import { download } from "../core/inventory";
import { app, clock, toast } from "../state/store";
import { traceLine } from "../state/trace";

export async function renderLayout(): Promise<HTMLCanvasElement | undefined> {
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
  ctx.fillText(`t = ${(clock.get().t / 1e9).toFixed(3)} s (${app.get().timeSource === "header" ? "header.stamp" : "log time"} base) · ${traceLine()}`.slice(0, 280), 10, c.height + 18);
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
