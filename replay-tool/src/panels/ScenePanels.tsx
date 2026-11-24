/**
 * 3D panels: PointCloud2 (colour by any field, point size, NaN %), TF tree,
 * Marker/MarkerArray and Pose messages.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { Colormap } from "../core/image";
import { parsePointCloud, type RosPointCloud2 } from "../core/pointcloud";
import type { TopicData } from "../core/types";
import type { PanelConfig } from "../state/store";
import { fmt } from "../ui/primitives";
import { PanelFrame } from "./PanelFrame";
import { axesAt, clearGroup, makePoints, useScene3D, type SceneApi } from "./Scene3D";
import { useDecoded, usePanelIndex } from "./useMessage";
import { tr } from "../i18n";

export function CloudPanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const { index } = usePanelIndex(topic);
  const { msg } = useDecoded(topic.topic, index);
  const api = useRef<SceneApi>();
  const fitted = useRef(false);
  const [field, setField] = useState("x");
  const [size, setSize] = useState(0.05);
  const [cmap] = useState<Colormap>("turbo");
  const [info, setInfo] = useState({ n: 0, nan: 0, fields: [] as string[] });
  const ref = useScene3D((a) => (api.current = a));

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    clearGroup(a.group);
    if (!msg?.msg) return a.render();
    try {
      const parsed = parsePointCloud(msg.msg as RosPointCloud2);
      let nan = 0;
      for (let i = 0; i < parsed.count; i++) if (!Number.isFinite(parsed.positions[i * 3])) nan++;
      const scalar = field === "distance" ? Float32Array.from({ length: parsed.count }, (_, i) => Math.hypot(parsed.positions[i * 3], parsed.positions[i * 3 + 1], parsed.positions[i * 3 + 2])) : parsed.fields[field];
      const { points } = makePoints(parsed.positions, scalar, size, cmap);
      a.group.add(points);
      setInfo({ n: parsed.count, nan, fields: parsed.fieldNames });
      if (!fitted.current && parsed.count) {
        fitted.current = true;
        a.fit(8);
      }
    } catch {
      setInfo({ n: 0, nan: 0, fields: [] });
    }
    a.render();
  }, [msg, field, size, cmap]);

  return (
    <PanelFrame
      cfg={cfg}
      topic={topic}
      index={index}
      error={msg?.error}
      toolbar={
        <>
          <select className="input" style={{ minHeight: 26, padding: "0 4px", fontSize: 11 }} aria-label={tr("Colorare după câmp")} value={field} onChange={(e) => setField(e.target.value)}>
            {[...info.fields, "distance"].map((f) => (
              <option key={f} value={f}>
                colour: {f}
              </option>
            ))}
          </select>
          <input type="range" min={0.01} max={0.3} step={0.01} value={size} onChange={(e) => setSize(+e.target.value)} aria-label={tr("Dimensiunea punctelor")} data-tip={tr("Dimensiunea punctelor")} style={{ width: 60 }} />
        </>
      }
      footer={
        <>
          <span>{info.n} points</span>
          <span style={{ color: info.nan / Math.max(1, info.n) > 0.3 ? "var(--warn)" : undefined }}>NaN/invalid {fmt.pct(info.nan / Math.max(1, info.n))}</span>
          <span>frame {(msg?.msg as RosPointCloud2 | undefined)?.header?.frame_id ?? "—"}</span>
        </>
      }
    >
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      {index < 0 && <div className="panel-empty">{tr("Niciun mesaj până la acest moment")}</div>}
    </PanelFrame>
  );
}

interface TfMsg {
  transforms: Array<{ header: { frame_id: string }; child_frame_id: string; transform: { translation: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } } }>;
}

export function TfPanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  // static TF: aggregate every message up to the cursor (usually 1)
  const { index } = usePanelIndex(topic);
  const { msg } = useDecoded(topic.topic, index >= 0 ? index : topic.count ? 0 : -1);
  const api = useRef<SceneApi>();
  const ref = useScene3D((a) => (api.current = a));
  const tfs = (msg?.msg as TfMsg | undefined)?.transforms ?? [];

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    clearGroup(a.group);
    // place each child relative to its parent, roots at origin
    const world = new Map<string, THREE.Matrix4>();
    const pending = [...tfs];
    const children = new Set(tfs.map((t) => t.child_frame_id));
    for (const t of tfs) if (!children.has(t.header.frame_id)) world.set(t.header.frame_id, new THREE.Matrix4());
    for (let guard = 0; pending.length && guard < 50; guard++) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const t = pending[i];
        const parent = world.get(t.header.frame_id);
        if (!parent) continue;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(t.transform.translation.x, t.transform.translation.y, t.transform.translation.z),
          new THREE.Quaternion(t.transform.rotation.x, t.transform.rotation.y, t.transform.rotation.z, t.transform.rotation.w),
          new THREE.Vector3(1, 1, 1),
        );
        world.set(t.child_frame_id, parent.clone().multiply(m));
        pending.splice(i, 1);
      }
    }
    for (const [, m] of world) {
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(p, q, s);
      a.group.add(axesAt(p, q, 0.25));
    }
    a.fit(3);
  }, [msg]);

  return (
    <PanelFrame cfg={cfg} topic={topic} index={index} error={msg?.error} footer={<span>{tfs.length} transforms</span>}>
      <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <div ref={ref} style={{ position: "relative" }} />
        <div className="panel-body scroll" tabIndex={0} style={{ padding: 8, fontSize: 11 }}>
          <ul className="mono" style={{ margin: 0, paddingLeft: 14 }}>
            {tfs.map((t, i) => (
              <li key={i}>
                {t.header.frame_id} → <b>{t.child_frame_id}</b>
                <div className="muted">
                  t=({t.transform.translation.x.toFixed(2)}, {t.transform.translation.y.toFixed(2)}, {t.transform.translation.z.toFixed(2)}) m
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </PanelFrame>
  );
}

interface Marker {
  type: number;
  action?: number;
  pose: { position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } };
  scale: { x: number; y: number; z: number };
  color: { r: number; g: number; b: number; a: number };
  points?: Array<{ x: number; y: number; z: number }>;
}

export function MarkerPanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const { index } = usePanelIndex(topic);
  const { msg } = useDecoded(topic.topic, index);
  const api = useRef<SceneApi>();
  const ref = useScene3D((a) => (api.current = a));
  const markers: Marker[] = ((msg?.msg as { markers?: Marker[] })?.markers ?? (msg?.msg ? [msg.msg as Marker] : [])).filter(Boolean);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    clearGroup(a.group);
    for (const m of markers) {
      if (m.action === 2 || m.action === 3) continue;
      const color = new THREE.Color(m.color.r, m.color.g, m.color.b);
      const mat = new THREE.MeshStandardMaterial({ color, transparent: m.color.a < 1, opacity: m.color.a || 1 });
      let obj: THREE.Object3D | undefined;
      switch (m.type) {
        case 1:
          obj = new THREE.Mesh(new THREE.BoxGeometry(m.scale.x, m.scale.y, m.scale.z), mat);
          break;
        case 2:
          obj = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), mat);
          obj.scale.set(m.scale.x, m.scale.y, m.scale.z);
          break;
        case 3:
          obj = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 16), mat);
          obj.rotation.x = Math.PI / 2;
          obj.scale.set(m.scale.x, m.scale.z, m.scale.y);
          break;
        case 0:
          obj = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), m.scale.x || 1, color);
          break;
        case 4:
        case 5:
        case 8: {
          const g = new THREE.BufferGeometry().setFromPoints((m.points ?? []).map((p) => new THREE.Vector3(p.x, p.y, p.z)));
          obj = m.type === 8 ? new THREE.Points(g, new THREE.PointsMaterial({ color, size: m.scale.x || 0.05 })) : m.type === 4 ? new THREE.Line(g, new THREE.LineBasicMaterial({ color })) : new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
          break;
        }
      }
      if (!obj) continue;
      const wrapper = new THREE.Group();
      wrapper.add(obj);
      wrapper.position.set(m.pose.position.x, m.pose.position.y, m.pose.position.z);
      wrapper.quaternion.set(m.pose.orientation.x, m.pose.orientation.y, m.pose.orientation.z, m.pose.orientation.w || 1);
      a.group.add(wrapper);
    }
    a.render();
  }, [msg]);

  return (
    <PanelFrame cfg={cfg} topic={topic} index={index} error={msg?.error} footer={<span>{markers.length} markers</span>}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
    </PanelFrame>
  );
}

export function PosePanel({ cfg, topic }: { cfg: PanelConfig; topic: TopicData }) {
  const { index } = usePanelIndex(topic);
  const { msg } = useDecoded(topic.topic, index);
  const api = useRef<SceneApi>();
  const ref = useScene3D((a) => (api.current = a));
  const m = msg?.msg as { pose?: { position?: { x: number; y: number; z: number }; orientation?: { x: number; y: number; z: number; w: number }; pose?: { position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } } } } | undefined;
  const pose = m?.pose?.pose ?? (m?.pose as { position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } } | undefined);
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    clearGroup(a.group);
    if (pose?.position && pose.orientation) a.group.add(axesAt(pose.position, pose.orientation, 0.5));
    a.render();
  }, [msg]);
  return (
    <PanelFrame cfg={cfg} topic={topic} index={index} error={msg?.error} footer={pose?.position ? <span>p=({pose.position.x.toFixed(2)}, {pose.position.y.toFixed(2)}, {pose.position.z.toFixed(2)}) m</span> : null}>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
    </PanelFrame>
  );
}
