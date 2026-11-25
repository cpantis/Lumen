/**
 * Offline, deterministic video export and timed snapshots (parity with the Python
 * replay script). Frame k is rendered for recording time t = start + k / fps: the
 * cursor is moved there, every panel is awaited until it has drawn exactly the message
 * of that moment, then the layout (panels + timeline with its cursor + trace line) is
 * captured and encoded. The result does not depend on the machine's speed.
 *
 * Encoding: H.264 through WebCodecs into MP4 (mp4-muxer). If H.264 is not available
 * the video is VP9 in WebM through WebCodecs (still deterministic); if WebCodecs is
 * missing, MediaRecorder WebM is used and the summary says frame timing is approximate.
 */
import JSZip from "jszip";
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from "webm-muxer";
import { download } from "../core/inventory";
import { frameTimestampUs, planVideo, pngWithText, snapshotName, type ExportMeta, type VideoSummary } from "../core/exportplan";
import { currentOverrides, seek, setPlaying } from "../state/actions";
import { app, clock } from "../state/store";
import { APP_VERSION, GIT_COMMIT, TOOL_ID } from "../state/trace";
import { renderLayout } from "./snapshot";

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Resolves when no panel is still decoding/drawing the message of the current moment. */
export async function settled(timeoutMs = 20_000): Promise<void> {
  const t0 = performance.now();
  await raf();
  for (;;) {
    const pending = document.querySelectorAll(".replay .panel[data-pending]").length;
    if (!pending) break;
    if (performance.now() - t0 > timeoutMs) throw new Error(`${pending} panel(s) did not finish drawing within ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 15));
  }
  // panel effects draw after the commit: two frames let canvases and 3D views paint
  await raf();
  await raf();
}

/** Metadata carried by every export. */
export function exportMeta(extra: Partial<ExportMeta> = {}): ExportMeta {
  const s = app.get();
  const a = s.analysis!;
  return {
    tool: TOOL_ID,
    app_version: APP_VERSION,
    commit: GIT_COMMIT,
    files: a.files ?? [{ name: a.fileName, size: a.fileSize, sha256: a.sha256 }],
    sha256: a.sha256,
    time_base: s.timeSource,
    layout: { panels: s.panels, grid: s.layout },
    overrides: currentOverrides(s),
    generated_at: new Date().toISOString(),
    ...extra,
  };
}

export interface VideoOptions {
  startNs: number;
  endNs: number;
  fps: number;
  speed: number;
  base: "log" | "header";
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

async function pickCodec(w: number, h: number, fps: number): Promise<{ codec: string; container: "mp4" | "webm"; note?: string } | undefined> {
  if (typeof VideoEncoder === "undefined") return undefined;
  for (const codec of ["avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42001f"]) {
    try {
      if ((await VideoEncoder.isConfigSupported({ codec, width: w, height: h, framerate: fps, bitrate: 8e6 })).supported) return { codec, container: "mp4" };
    } catch {
      /* try the next profile */
    }
  }
  for (const codec of ["vp09.00.40.08", "vp8"]) {
    try {
      if ((await VideoEncoder.isConfigSupported({ codec, width: w, height: h, framerate: fps, bitrate: 8e6 })).supported) return { codec, container: "webm", note: "H.264 is not available in this browser: the video is WebM (" + codec + "), frame times are still exact." };
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Renders and encodes the interval; returns the video and its summary.json. */
export async function renderVideo(o: VideoOptions): Promise<{ blob: Blob; name: string; summary: VideoSummary }> {
  const plan = planVideo(o.startNs, o.endNs, o.fps, o.speed);
  const prevBase = app.get().timeSource;
  const prevT = clock.get().t;
  setPlaying(false);
  app.set({ view: "replay", timeSource: o.base });
  const t0 = performance.now();
  try {
    seek(plan.times[0]);
    await settled();
    const first = await renderLayout();
    if (!first) throw new Error("The replay layout is not visible");
    const W = first.width - (first.width % 2), H = first.height - (first.height % 2);
    const choice = await pickCodec(W, H, plan.videoFps);
    const base = `replay_${(plan.startNs / 1e9).toFixed(2)}-${(plan.endNs / 1e9).toFixed(2)}s_${o.base}_${o.fps}fps_x${o.speed}`;
    const meta = exportMeta({ fps: o.fps, interval_s: [plan.startNs / 1e9, plan.endNs / 1e9], speed: o.speed, time_base: o.base });
    const frame = document.createElement("canvas");
    frame.width = W;
    frame.height = H;
    const fctx = frame.getContext("2d")!;
    const draw = (c: HTMLCanvasElement) => {
      fctx.fillStyle = "#000";
      fctx.fillRect(0, 0, W, H);
      fctx.drawImage(c, 0, 0);
    };

    if (choice) {
      const mp4 = choice.container === "mp4";
      const target = mp4 ? new Mp4Target() : new WebmTarget();
      const muxer = mp4
        ? new Mp4Muxer({ target: target as Mp4Target, video: { codec: "avc", width: W, height: H, frameRate: plan.videoFps }, fastStart: "in-memory" })
        : new WebmMuxer({ target: target as WebmTarget, video: { codec: choice.codec.startsWith("vp09") ? "V_VP9" : "V_VP8", width: W, height: H, frameRate: plan.videoFps } });
      let failure: Error | undefined;
      const enc = new VideoEncoder({ output: (chunk, m) => (muxer as Mp4Muxer<Mp4Target>).addVideoChunk(chunk, m), error: (e) => (failure = e as Error) });
      enc.configure({ codec: choice.codec, width: W, height: H, framerate: plan.videoFps, bitrate: 8e6, latencyMode: "quality", ...(mp4 ? { avc: { format: "avc" } } : {}) } as VideoEncoderConfig);
      for (let k = 0; k < plan.times.length; k++) {
        if (o.signal?.aborted) throw new Error("cancelled");
        if (failure) throw failure;
        if (k > 0) {
          seek(plan.times[k]);
          await settled();
          const c = await renderLayout();
          if (c) draw(c);
        } else draw(first);
        const vf = new VideoFrame(frame, { timestamp: frameTimestampUs(k, plan.videoFps), duration: frameTimestampUs(1, plan.videoFps) });
        enc.encode(vf, { keyFrame: k % Math.max(1, Math.round(plan.videoFps * 2)) === 0 });
        vf.close();
        while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
        o.onProgress?.(k + 1, plan.times.length);
      }
      await enc.flush();
      if (failure) throw failure;
      enc.close();
      muxer.finalize();
      const name = `${base}.${choice.container}`;
      const blob = new Blob([(target as Mp4Target).buffer], { type: mp4 ? "video/mp4" : "video/webm" });
      const summary: VideoSummary = { ...meta, video: name, frames: plan.times.length, fps: o.fps, base: o.base, render_s: +((performance.now() - t0) / 1000).toFixed(3), video_fps: plan.videoFps, codec: choice.codec, container: choice.container, note: choice.note };
      return { blob, name, summary };
    }

    // No WebCodecs: MediaRecorder fallback (frame timing follows the wall clock, approximate)
    if (typeof MediaRecorder === "undefined") throw new Error("This browser can encode neither with WebCodecs nor with MediaRecorder");
    const stream = frame.captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((r) => (mr.onstop = () => r()));
    mr.start();
    for (let k = 0; k < plan.times.length; k++) {
      if (o.signal?.aborted) {
        mr.stop();
        throw new Error("cancelled");
      }
      if (k > 0) {
        seek(plan.times[k]);
        await settled();
        const c = await renderLayout();
        if (c) draw(c);
      } else draw(first);
      track.requestFrame?.();
      await new Promise((r) => setTimeout(r, 1000 / plan.videoFps));
      o.onProgress?.(k + 1, plan.times.length);
    }
    mr.stop();
    await done;
    const name = `${base}.webm`;
    const summary: VideoSummary = { ...meta, video: name, frames: plan.times.length, fps: o.fps, base: o.base, render_s: +((performance.now() - t0) / 1000).toFixed(3), video_fps: plan.videoFps, codec: mime, container: "webm", note: "WebCodecs is not available in this browser: WebM via MediaRecorder, frame durations follow the wall clock (approximate). Use a Chromium-based browser for an exact MP4." };
    return { blob: new Blob(chunks, { type: "video/webm" }), name, summary };
  } finally {
    app.set({ timeSource: prevBase });
    seek(prevT);
  }
}

/** Renders the video and downloads it with its summary.json. */
export async function exportVideoFile(o: VideoOptions): Promise<VideoSummary> {
  const { blob, name, summary } = await renderVideo(o);
  download(name, blob, blob.type);
  download(name.replace(/\.(mp4|webm)$/, ".summary.json"), JSON.stringify(summary, null, 2), "application/json");
  return summary;
}

/**
 * PNG snapshots at the given recording times. Each PNG is named replay_<t>s.png and
 * carries the export metadata in a tEXt chunk; several snapshots come as one ZIP with
 * summary.json.
 */
export async function exportSnapshots(timesNs: number[], base: "log" | "header", onProgress?: (d: number, n: number) => void, signal?: AbortSignal): Promise<string[]> {
  const prevBase = app.get().timeSource;
  const prevT = clock.get().t;
  setPlaying(false);
  app.set({ view: "replay", timeSource: base });
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const meta = exportMeta({ time_base: base });
  try {
    for (let k = 0; k < timesNs.length; k++) {
      if (signal?.aborted) throw new Error("cancelled");
      seek(timesNs[k]);
      await settled();
      const c = await renderLayout();
      if (!c) throw new Error("The replay layout is not visible");
      const png = new Uint8Array(await (await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"))).arrayBuffer());
      files.push({ name: snapshotName(timesNs[k]), data: pngWithText(png, "StampTrace", JSON.stringify({ ...meta, t_s: timesNs[k] / 1e9 })) });
      onProgress?.(k + 1, timesNs.length);
    }
  } finally {
    app.set({ timeSource: prevBase });
    seek(prevT);
  }
  if (files.length === 1) download(files[0].name, new Blob([files[0].data], { type: "image/png" }), "image/png");
  else {
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, f.data);
    zip.file("summary.json", JSON.stringify({ ...meta, snapshots: files.map((f, i) => ({ file: f.name, t_s: timesNs[i] / 1e9 })) }, null, 2));
    download("replay_snapshots.zip", await zip.generateAsync({ type: "blob" }), "application/zip");
  }
  return files.map((f) => f.name);
}
