/**
 * Calibration for the 2.3 consistency check: automatic intrinsics/extrinsics from
 * CameraInfo + TF when present, documented assumptions otherwise; consistency over
 * time between a FOV's point cloud and its depth image (same stamp); estimation of
 * unknown parameters with confidence.
 */
import { lookupTf, assumedIntrinsics, consistency, estimateCalibration, extrinsicsFromTf, intrinsicsFromCameraInfo, sensitivity, type Calibration, type ParamKey, type TfEdge } from "../core/projection";
import { parsePointCloud, type RosPointCloud2 } from "../core/pointcloud";
import { pixelValue, type RosImage } from "../core/image";
import type { Analysis, TopicData } from "../core/types";
import { worker } from "../worker/client";
import { effectiveFov, effectiveRole } from "./actions";
import { app } from "./store";

export interface FovTopics {
  fov: string;
  image?: TopicData; // input camera image
  cameraInfo?: TopicData;
  cloud?: TopicData; // output point cloud
  depth?: TopicData; // output depth image (reference)
}

export function fovTopics(a: Analysis, fov: string): FovTopics {
  const s = app.get();
  const inFov = a.topics.filter((t) => effectiveFov(t, s) === fov);
  const ns = fov;
  return {
    fov,
    image: inFov.find((t) => effectiveRole(t, s) === "input" && /Image/.test(t.type)) ?? a.topics.find((t) => t.topic.includes(ns) && effectiveRole(t, s) === "input" && /Image/.test(t.type)),
    cameraInfo: a.topics.find((t) => t.type === "sensor_msgs/CameraInfo" && (effectiveFov(t, s) === fov || t.topic.includes(ns))),
    cloud: inFov.find((t) => effectiveRole(t, s) === "output" && t.type === "sensor_msgs/PointCloud2"),
    depth: inFov.find((t) => effectiveRole(t, s) === "output" && t.type === "sensor_msgs/Image" && /16UC1|32FC1/i.test(t.details["encoding"] ?? "")),
  };
}

async function tfEdges(a: Analysis): Promise<TfEdge[]> {
  const edges: TfEdge[] = [];
  for (const t of a.topics.filter((x) => x.type === "tf2_msgs/TFMessage")) {
    const n = Math.min(t.count, t.topic.includes("static") ? t.count : 50);
    for (let i = 0; i < n; i++) {
      const m = (await worker.get(t.topic, i)).msg as { transforms: Array<{ header: { frame_id: string }; child_frame_id: string; transform: TfEdge["transform"] }> };
      for (const tr of m?.transforms ?? []) if (!edges.some((e) => e.child === tr.child_frame_id)) edges.push({ parent: tr.header.frame_id, child: tr.child_frame_id, transform: tr.transform });
    }
  }
  return edges;
}

/** Calibration from the recording when possible, assumptions otherwise (always labelled). */
export async function autoCalibration(a: Analysis, ft: FovTopics): Promise<Calibration> {
  let intr;
  let note = "";
  if (ft.cameraInfo && ft.cameraInfo.count) {
    const ci = (await worker.get(ft.cameraInfo.topic, 0)).msg as { width: number; height: number; k: ArrayLike<number> };
    intr = intrinsicsFromCameraInfo(ci);
    note += `Intrinsics from ${ft.cameraInfo.topic}. `;
  } else {
    const [w, h] = (ft.image?.details["resolution"] ?? "640×480").split("×").map(Number);
    intr = assumedIntrinsics(w, h, 90);
    note += "No CameraInfo: assumed intrinsics (HFOV 90°, principal point at the centre). ";
  }
  const camFrame = ft.image?.frameIds[0] ?? ft.depth?.frameIds[0];
  const cloudFrame = ft.cloud?.frameIds[0];
  let ext = { tx: 0, ty: 0, tz: 0, roll: 0, pitch: 0, yaw: 0 };
  let source: Calibration["source"] = ft.cameraInfo ? "camera_info" : "assumed";
  if (camFrame && cloudFrame) {
    const edges = await tfEdges(a);
    const tf = lookupTf(edges, cloudFrame, camFrame);
    if (tf) {
      ext = extrinsicsFromTf(tf);
      source = ft.cameraInfo ? "camera_info+tf" : "assumed";
      note += `Extrinsics from TF: pose of ${camFrame} in ${cloudFrame}.`;
    } else if (!/optical/.test(cloudFrame)) {
      ext = { ...ext, roll: -Math.PI / 2, yaw: -Math.PI / 2 };
      note += `No TF between ${cloudFrame} and ${camFrame}: link→optical convention assumed (roll −90°, yaw −90°), zero translation.`;
    } else note += "The cloud is already in an optical frame: identity extrinsics.";
  }
  return { intrinsics: intr, extrinsics: ext, source, note: note.trim() };
}

export interface ConsistencySample {
  t: number;
  cloudIndex: number;
  medianRelError: number;
  p90RelError: number;
  inImageRatio: number;
  compared: number;
}

/** Loads the (cloud, depth) pairs sharing a stamp, sampled evenly (deterministic). */
async function pairs(ft: FovTopics, maxPairs: number) {
  if (!ft.cloud || !ft.depth) return [];
  const depthByStamp = new Map<number, number>();
  for (let i = 0; i < ft.depth.count; i++) depthByStamp.set(ft.depth.stamp[i], i);
  const candidates: Array<[number, number]> = [];
  for (let i = 0; i < ft.cloud.count; i++) {
    const j = depthByStamp.get(ft.cloud.stamp[i]);
    if (j !== undefined) candidates.push([i, j]);
  }
  const step = Math.max(1, Math.floor(candidates.length / maxPairs));
  return candidates.filter((_, k) => k % step === 0).slice(0, maxPairs);
}

async function loadPair(ft: FovTopics, ci: number, di: number) {
  const [c, d] = await Promise.all([worker.get(ft.cloud!.topic, ci, undefined, 0), worker.get(ft.depth!.topic, di, undefined, 0)]);
  const cloud = parsePointCloud(c.msg as RosPointCloud2);
  const img = d.msg as RosImage;
  const scale = /16UC1/i.test(img.encoding) ? 0.001 : 1;
  return { positions: cloud.positions, depthAt: (u: number, v: number) => pixelValue(img, u, v) * scale };
}

export async function consistencyOverTime(ft: FovTopics, cal: Calibration, maxPairs = 80, onProgress?: (f: number) => void): Promise<ConsistencySample[]> {
  const ps = await pairs(ft, maxPairs);
  const out: ConsistencySample[] = [];
  for (let k = 0; k < ps.length; k++) {
    const [ci, di] = ps[k];
    const { positions, depthAt } = await loadPair(ft, ci, di);
    const r = consistency(positions, cal, depthAt);
    out.push({ t: ft.cloud!.log[ci], cloudIndex: ci, medianRelError: r.medianRelError, p90RelError: r.p90RelError, inImageRatio: r.inImageRatio, compared: r.compared });
    onProgress?.((k + 1) / ps.length);
  }
  return out;
}

/** Estimates the selected parameters on N sampled frames; returns confidence per parameter. */
export async function estimate(ft: FovTopics, start: Calibration, keys: ParamKey[], frames = 8) {
  const ps = await pairs(ft, frames);
  const loaded = await Promise.all(ps.map(([ci, di]) => loadPair(ft, ci, di)));
  const cost = (cal: Calibration) => loaded.reduce((s, p) => s + consistency(p.positions, cal, p.depthAt, 2).cost, 0) / Math.max(1, loaded.length);
  const res = estimateCalibration(cost, start, keys);
  const sens = sensitivity(cost, res.calibration, keys);
  return { ...res, sensitivity: sens, frames: loaded.length, startCost: cost(start) };
}
