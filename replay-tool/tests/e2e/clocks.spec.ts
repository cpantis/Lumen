/** Switching log time / header.stamp changes when messages appear, exactly as defined, and is explained. */
import { expect, test } from "@playwright/test";
import { analysisOf } from "./node-data";

const DEMO = "public/demo.mcap";
const lastAtOrBefore = (a: number[], t: number) => {
  let k = -1;
  a.forEach((v, i) => v <= t && (k = i));
  return k;
};

test("same moment, two clocks: the output panel shows the frame defined by each clock", async ({ page }) => {
  const a = await analysisOf(DEMO);
  const out = a.topics.find((t) => t.topic === "/cam_front/depth")!;
  const t = 10.0e9;
  // log: last output logged ≤ t ; stamp: output whose stamp is the latest ≤ t (stamps sorted)
  const logIdx = lastAtOrBefore(Array.from(out.log), t);
  const order = Array.from(out.stamp.keys()).sort((x, y) => out.stamp[x] - out.stamp[y]);
  const k = lastAtOrBefore(order.map((i) => out.stamp[i]), t);
  const stampIdx = order[k];
  expect(stampIdx).toBeGreaterThan(logIdx); // on the stamp clock the output appears earlier (no latency)

  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill("10s");
  await expect(page.locator(".palette li").first()).toContainText("Jump to 10.000 s");
  await page.keyboard.press("Enter");
  const panel = page.getByLabel("Panel /cam_front/depth", { exact: true });
  await expect(panel.locator(".panel[data-pending]")).toHaveCount(0);
  await expect(panel.getByTestId("panel-age")).toContainText(`${logIdx + 1}/${out.count}`);
  const ageLog = ((t - out.log[logIdx]) / 1e6).toFixed(0);
  await expect(panel.getByTestId("panel-age")).toContainText(`age ${ageLog} ms`);
  await page.getByTestId("clock-switch").getByRole("button", { name: "header.stamp" }).click();
  await expect(panel.getByTestId("panel-age")).toContainText(`${stampIdx + 1}/${out.count}`);
  await expect(panel.getByTestId("panel-age")).toContainText(`age ${((t - out.stamp[stampIdx]) / 1e6).toFixed(0)} ms`);
  // explained
  await expect(page.getByTestId("clock-switch").getByRole("button", { name: "log time" })).toHaveAttribute("data-tip", /what a consumer of the topic saw/);
  await expect(page.getByTestId("clock-switch").getByRole("button", { name: "header.stamp" })).toHaveAttribute("data-tip", /input frame it was computed from/);
});
