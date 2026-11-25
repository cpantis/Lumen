/**
 * Generality in the app: recordings with other topic names, 1 and 3 FOVs, 10 Hz cameras,
 * no CameraInfo / TF / IMU, 32FC1 depth, a cloud without rgb, and a recording split in
 * parts (several files picked together). Everything loads, every panel draws, the
 * per-FOV layout has one row per FOV, nothing crashes.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { genGeneric, type GenericOptions } from "../../scripts/gen-generic";

const DIR = "test-results/generic";
async function write(name: string, o: GenericOptions): Promise<string[]> {
  mkdirSync(DIR, { recursive: true });
  const parts = await genGeneric(o);
  return parts.map((b, i) => {
    const p = `${DIR}/${name}${parts.length > 1 ? `_${i}` : ""}.mcap`;
    writeFileSync(p, b);
    return p;
  });
}

async function openFiles(page: Page, files: string[]) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  await page.setInputFiles("[data-testid=file-input]", files);
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  return errors;
}

/** Every panel has drawn its message (no Loading), shows a stamp line, and none reports a decode error. */
async function allPanelsDrawn(page: Page) {
  await expect(page.locator(".panel[data-pending]")).toHaveCount(0, { timeout: 20_000 });
  const n = await page.locator(".panel").count();
  expect(n).toBeGreaterThan(0);
  await expect(page.locator(".panel .head-status .badge", { hasText: /Invalid|Undecodable/ })).toHaveCount(0);
  return n;
}

const rowsOf = (page: Page) => page.evaluate(() => new Set([...document.querySelectorAll(".replay-grid .react-grid-item")].map((e) => (e as HTMLElement).style.transform.match(/,\s*([\d.]+)px/)?.[1])).size);

test("3 FOVs, other topic names: one row per FOV, triggers inferred, every panel draws", async ({ page }) => {
  const files = await write("three_fovs", { fovs: ["left", "centre", "right"], hz: 10, cameraInfo: true, tf: true, imu: true, dropRgb: [12, 13, 30], dropDepth: [5, 21, 22, 40], segStall: [44, 50] });
  const errors = await openFiles(page, files);
  await expect(page.locator(".fov-legend")).toContainText("FOV 3 · right");
  // jump to 3 s so every panel has a message
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill("3s");
  await expect(page.locator(".palette li").first()).toContainText("Jump to 3.000 s");
  await page.keyboard.press("Enter");
  const n = await allPanelsDrawn(page);
  expect(n).toBe(3 * 4 + 2); // rgb, depth, labels, cloud per FOV + IMU and TF (row of topics without FOV)
  expect(await rowsOf(page)).toBe(4);
  await expect(page.getByLabel("Panel /left/labels", { exact: true }).locator(".panel-foot")).toContainText("class map, 5 classes");
  await expect(page.getByTestId("bev")).toHaveCount(3);
  // no cross-FOV causality with shared hardware stamps
  await expect(page.getByLabel("Panel /left/color/image", { exact: true }).locator(".panel-foot")).not.toContainText("/centre/");
  await page.getByRole("tab", { name: /Causality/ }).click();
  const row = page.getByTestId("parity-table").locator('tr[data-output="/centre/fused_points"]');
  await expect(row).toContainText("/centre/aligned_depth");
  await expect(page.getByTestId("parity-table").locator('tr[data-output="/centre/labels"]')).toContainText("/centre/color/image");
  expect(errors).toEqual([]);
});

test("1 FOV with root topics, no CameraInfo/TF/IMU, 32FC1 depth, cloud without rgb", async ({ page }) => {
  const files = await write("root_minimal", { fovs: ["front"], naming: "root", hz: 10, depthEncoding: "32FC1", cloudRgb: false, dropRgb: [7, 8], dropDepth: [15, 16, 33] });
  const errors = await openFiles(page, files);
  await expect(page.locator(".fov-legend")).toContainText("FOV 1 · front");
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill("2s");
  await expect(page.locator(".palette li").first()).toContainText("Jump to 2.000 s");
  await page.keyboard.press("Enter");
  expect(await allPanelsDrawn(page)).toBe(4);
  const depth = page.getByLabel("Panel /depth", { exact: true });
  await expect(depth.getByTestId("panel-stamp")).toContainText("% valid depth");
  await expect(depth).toContainText("0–5 m");
  await expect(page.getByLabel("Panel /fused_points", { exact: true }).getByLabel("Colour by field")).toHaveValue("distance");
  await page.getByRole("tab", { name: /Inventory/ }).click();
  await expect(page.getByTestId("inference-table").locator('tr[data-topic="/rgb"]')).toContainText('header.frame_id prefix "front"');
  expect(errors).toEqual([]);
});

test("a recording in 3 parts, picked together, replays as one", async ({ page }) => {
  const files = await write("parts", { fovs: ["near", "far"], hz: 15, cameraInfo: true, dropRgb: [20, 21], dropDepth: [9, 40, 41], parts: 3 });
  const errors = await openFiles(page, files);
  await expect(page.locator(".topbar")).toContainText("parts_0.mcap + parts_1.mcap + parts_2.mcap");
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill("5s");
  await expect(page.locator(".palette li").first()).toContainText("Jump to 5.000 s");
  await page.keyboard.press("Enter");
  expect(await allPanelsDrawn(page)).toBe(8);
  await page.getByRole("tab", { name: /Inventory/ }).click();
  await expect(page.locator(".view")).toContainText("parts_2.mcap");
  expect(errors).toEqual([]);
});
