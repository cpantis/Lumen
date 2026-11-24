/** Chooses the panel component for a topic from its message type (nothing hard-coded). */
import type { TopicData } from "../core/types";
import type { PanelConfig } from "../state/store";
import { DiffPanel, OverlayPanel } from "./CompositePanels";
import { CameraInfoPanel, GenericPanel, GridPanel, ImuPanel, PlotPanel, ScanPanel } from "./DataPanels";
import { ImagePanel } from "./ImagePanel";
import { CloudPanel, MarkerPanel, PosePanel, TfPanel } from "./ScenePanels";

export function panelKindLabel(type: string): string {
  if (/Image/.test(type)) return "image";
  if (/PointCloud2/.test(type)) return "3D cloud";
  if (/Imu/.test(type)) return "IMU plot";
  if (/TFMessage/.test(type)) return "TF tree";
  if (/Marker/.test(type)) return "3D markers";
  if (/CameraInfo/.test(type)) return "text";
  if (/OccupancyGrid/.test(type)) return "2D grid";
  if (/LaserScan/.test(type)) return "2D scan";
  if (/Pose/.test(type)) return "3D pose";
  return "JSON + plots";
}

export function PanelFor({ cfg, topics }: { cfg: PanelConfig; topics: TopicData[] }) {
  const t = topics.find((x) => x.topic === cfg.topic);
  if (!t) return <div className="panel"><div className="panel-empty">Topic {cfg.topic} does not exist in this recording</div></div>;
  const t2 = cfg.topic2 ? topics.find((x) => x.topic === cfg.topic2) : undefined;
  if (cfg.kind === "overlay") return <OverlayPanel cfg={cfg} topic={t} cloud={t2} />;
  if (cfg.kind === "diff") return <DiffPanel cfg={cfg} a={t} b={t2} />;
  if (cfg.kind === "plot") return <PlotPanel cfg={cfg} topic={t} />;
  const type = t.type;
  if (type === "sensor_msgs/Image" || type === "sensor_msgs/CompressedImage") return <ImagePanel cfg={cfg} topic={t} />;
  if (type === "sensor_msgs/PointCloud2") return <CloudPanel cfg={cfg} topic={t} />;
  if (type === "sensor_msgs/Imu") return <ImuPanel cfg={cfg} topic={t} />;
  if (type === "tf2_msgs/TFMessage") return <TfPanel cfg={cfg} topic={t} />;
  if (type === "sensor_msgs/CameraInfo") return <CameraInfoPanel cfg={cfg} topic={t} />;
  if (type === "nav_msgs/OccupancyGrid") return <GridPanel cfg={cfg} topic={t} />;
  if (type === "sensor_msgs/LaserScan") return <ScanPanel cfg={cfg} topic={t} />;
  if (/visualization_msgs\/(Marker|MarkerArray)/.test(type)) return <MarkerPanel cfg={cfg} topic={t} />;
  if (/geometry_msgs\/Pose(WithCovariance)?Stamped/.test(type)) return <PosePanel cfg={cfg} topic={t} />;
  return <GenericPanel cfg={cfg} topic={t} />;
}
