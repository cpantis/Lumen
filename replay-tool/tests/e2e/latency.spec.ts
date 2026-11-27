/**
 * The replay latency strip shows, per chain, exactly the statistic of its definition over
 * every output message. Ground truth is computed here from the decoded log/stamp arrays
 * with an independent numpy-style percentile (not the app's code).
 */
import { expect, test } from "@playwright/test";
import { analysisOf } from "./node-data";

const DEMO = "public/demo.mcap";
function np(values: number[], q: number): number {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  const pos = (q / 100) * (a.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
const ms = (ns: number) => `${(ns / 1e6).toFixed(1)} ms`;

test("latency strip: chain names, n / p50 / p95 / p99 / max and definitions match an independent computation", async ({ page }) => {
  const a = await analysisOf(DEMO);
  const out = a.topics.find((t) => t.topic === "/cam_front/depth")!;
  const inp = a.topics.find((t) => t.topic === "/cam_front/image_raw")!;
  const e2e = Array.from(out.log, (l, j) => l - out.stamp[j]);
  const byStamp = new Map<number, number>();
  inp.stamp.forEach((s, i) => !byStamp.has(s) && byStamp.set(s, inp.log[i]));
  const proc = Array.from(out.log, (l, j) => (byStamp.has(out.stamp[j]) ? l - byStamp.get(out.stamp[j])! : NaN)).filter(Number.isFinite);

  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  const strip = page.getByTestId("latency-strip");
  const sel = strip.getByLabel("Latency chain");
  const labels = await sel.locator("option").allInnerTexts();
  expect(labels).toContain("/cam_front/image_raw → /cam_front/depth (e2e)");
  expect(labels).toContain("/cam_front/image_raw → /cam_front/depth (processing)");
  expect(labels.length).toBe(2 * a.topics.filter((t) => t.autoRole === "output" && t.hasHeader).length);

  await sel.selectOption({ label: "/cam_front/image_raw → /cam_front/depth (e2e)" });
  await expect(strip.getByTestId("latency-stats")).toHaveText(`n ${e2e.length} · p50 ${ms(np(e2e, 50))} · p95 ${ms(np(e2e, 95))} · p99 ${ms(np(e2e, 99))} · max ${ms(Math.max(...e2e))}`);
  await expect(strip.getByTestId("latency-definition")).toContainText("log_time(output) − header.stamp(output)");

  await sel.selectOption({ label: "/cam_front/image_raw → /cam_front/depth (processing)" });
  await expect(strip.getByTestId("latency-stats")).toHaveText(`n ${proc.length} · p50 ${ms(np(proc, 50))} · p95 ${ms(np(proc, 95))} · p99 ${ms(np(proc, 99))} · max ${ms(Math.max(...proc))}`);
  await expect(strip.getByTestId("latency-definition")).toContainText("log_time(output) − log_time(/cam_front/image_raw message with the same header.stamp)");
  // the speed used is always stated: estimated from the IMU here, 1.4 m/s (assumed) without one
  await expect(strip).toContainText(`walked at ${a.motion.speedMps.toFixed(1)} m/s${a.motion.method === "assumed" ? " (assumed)" : ""}`);
});
