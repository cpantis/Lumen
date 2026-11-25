import { rateStats } from "../../src/core/stats";
import type { TopicData } from "../../src/core/types";

/** Minimal TopicData for pure-function tests (times in ns). */
export function topic(name: string, log: number[], stamp: number[], type = "sensor_msgs/Image"): TopicData {
  const l = Float64Array.from(log);
  return {
    topic: name,
    channelId: 0,
    schemaName: type,
    type,
    messageEncoding: "cdr",
    schemaEncoding: "ros2msg",
    hasHeader: true,
    count: log.length,
    log: l,
    stamp: Float64Array.from(stamp),
    size: new Uint32Array(log.length),
    frameIds: [],
    details: {},
    content: {} as never,
    rate: rateStats(l),
    gaps: [],
    autoRole: "unknown",
    roleReason: "",
  };
}
