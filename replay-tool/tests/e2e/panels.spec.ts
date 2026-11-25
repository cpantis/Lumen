/**
 * Panel output verification: what every panel draws is compared with the same message
 * decoded independently in Node (tests/e2e/node-data.ts), at the same moment.
 *
 *  - index n/N shown by each panel = last message ≤ cursor (log time and header.stamp)
 *  - RGB image: canvas pixels = raw image bytes (rgb8, bgr8 channel order, Foxglove RawImage)
 *  - JPEG: canvas ≈ the raw frame with the same stamp (JPEG tolerance)
 *  - depth: hover read-out = raw 16UC1 value in mm
 *  - point cloud: point count and NaN ratio; IMU: |a| of the shown message
 *  - CameraInfo / TF / generic JSON: displayed values = message values
 *  - "follow output": input frame = the one matched by stamp to the current output
 *  - status: a panel inside an input gap is flagged "Stale"
 *  - projection overlay: consistent frames < 5 % depth error, the injected +0.8 m frames > 5 %
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { lastAtOrBefore } from "../../src/core/sync";
import { pixelValue, type RosImage } from "../../src/core/image";
import { analysisOf, messageAt } from "./node-data";

const DEMO = "public/demo.mcap";
const RW = "fixtures/realworld";

async function open(page: Page, file?: string) {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  if (file) await page.setInputFiles("[data-testid=file-input]", path.resolve(file));
  else await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
}

async function seekTo(page: Page, s: number) {
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill(`${s}s`);
  await expect(page.locator(".palette li").first()).toContainText(`Jump to ${s.toFixed(3)} s`);
  await page.keyboard.press("Enter");
}

async function jump(page: Page, s: number) {
  await seekTo(page, s);
  await expect(page.locator(".time-display .num")).toContainText(s.toFixed(3));
  // every panel has drawn the requested message (no "Loading" status left)
  await expect(page.locator(".panel .head-status .badge", { hasText: "Loading" })).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(150);
}

const panel = (page: Page, title: string) => page.locator(".panel").filter({ has: page.locator(".title", { hasText: new RegExp(`^${title.replace(/[/.]/g, "\\$&")}$`) }) }).first();

/** Displayed index (0-based) from the "n/N · age" header. */
async function shownIndex(p: Locator): Promise<number> {
  const t = await p.locator(".head-status .meta").innerText();
  const m = /(\d+|—)\/(\d+)/.exec(t)!;
  return m[1] === "—" ? -1 : +m[1] - 1;
}

/** Reads RGB of image pixels (x, y) from a letter-boxed panel canvas. */
async function canvasRgb(p: Locator, iw: number, ih: number, pts: Array<[number, number]>) {
  return p.locator("canvas").first().evaluate(
    (c: HTMLCanvasElement, { iw, ih, pts }) => {
      const dpr = c.width / c.clientWidth;
      const W = c.clientWidth, H = c.clientHeight;
      const scale = Math.min(W / iw, H / ih);
      const ox = (W - iw * scale) / 2, oy = (H - ih * scale) / 2;
      const ctx = c.getContext("2d")!;
      return pts.map(([x, y]) => {
        const d = ctx.getImageData(Math.floor((ox + (x + 0.5) * scale) * dpr), Math.floor((oy + (y + 0.5) * scale) * dpr), 1, 1).data;
        return [d[0], d[1], d[2]];
      });
    },
    { iw, ih, pts },
  );
}

async function hoverPixel(page: Page, p: Locator, iw: number, ih: number, x: number, y: number) {
  const c = p.locator("canvas").first();
  await c.scrollIntoViewIfNeeded();
  const box = (await c.boundingBox())!;
  const scale = Math.min(box.width / iw, box.height / ih);
  const ox = (box.width - iw * scale) / 2, oy = (box.height - ih * scale) / 2;
  await page.mouse.move(box.x + ox + (x + 0.5) * scale, box.y + oy + (y + 0.5) * scale);
  await page.waitForTimeout(150);
}

const PTS: Array<[number, number]> = [[10, 10], [80, 30], [80, 60], [120, 90], [150, 115], [5, 110]];

test("demo: every panel shows the right message and the right content", async ({ page }) => {
  const a = await analysisOf(DEMO);
  const T = (n: string) => a.topics.find((t) => t.topic === n)!;
  await open(page);
  const t = 10;
  await jump(page, t);

  // 1) index shown by every panel = last message ≤ cursor
  const titles = await page.locator(".panel .title").allInnerTexts();
  expect(titles.length).toBeGreaterThan(5);
  for (const title of titles) {
    const td = a.topics.find((x) => x.topic === title);
    if (!td) continue;
    expect(await shownIndex(panel(page, title)), title).toBe(lastAtOrBefore(td.log, t * 1e9));
  }

  // 2) RGB image pixels = raw bytes
  for (const topic of ["/cam_front/image_raw", "/cam_down/image_raw"]) {
    const p = panel(page, topic);
    const i = await shownIndex(p);
    const img = (await messageAt(DEMO, topic, i)) as RosImage;
    const got = await canvasRgb(p, img.width, img.height, PTS);
    PTS.forEach(([x, y], k) => {
      const o = y * img.step + x * 3;
      expect(got[k], `${topic} (${x},${y})`).toEqual([img.data[o], img.data[o + 1], img.data[o + 2]]);
    });
  }

  // 3) depth read-out under the mouse = raw 16UC1 value (mm)
  {
    const p = panel(page, "/cam_front/depth");
    const i = await shownIndex(p);
    const d = (await messageAt(DEMO, "/cam_front/depth", i)) as RosImage;
    for (const [x, y] of [[80, 100], [20, 90], [140, 70]]) {
      await hoverPixel(page, p, d.width, d.height, x, y);
      const v = pixelValue(d, x, y);
      await expect(p.locator(".panel-foot")).toContainText(`(${x}, ${y}) ${v} mm`);
    }
    await page.mouse.move(0, 0);
  }

  // 4) point cloud: count and NaN ratio
  for (const topic of ["/cam_front/points", "/cam_down/points"]) {
    const p = panel(page, topic);
    const i = await shownIndex(p);
    const pc = await messageAt(DEMO, topic, i);
    const n = pc.width * pc.height;
    const dv = new DataView(pc.data.buffer, pc.data.byteOffset, pc.data.byteLength);
    let nan = 0;
    for (let k = 0; k < n; k++) if (!Number.isFinite(dv.getFloat32(k * pc.point_step, true))) nan++;
    await expect(p.locator(".panel-foot")).toContainText(`${n} points`);
    await expect(p.locator(".panel-foot")).toContainText(`NaN/invalid ${((nan / n) * 100).toFixed(1)} %`);
  }

  // 5) IMU: |a| of the displayed message
  {
    const p = panel(page, "/imu/data");
    const i = await shownIndex(p);
    await expect(p.locator(".panel-foot")).toContainText(`${T("/imu/data").content.min[i].toFixed(2)} m/s²`);
  }

  // 6) TF tree lists every transform
  {
    const tf = await messageAt(DEMO, "/tf_static", 0);
    const p = panel(page, "/tf_static");
    for (const x of tf.transforms) await expect(p).toContainText(x.child_frame_id);
    await expect(p.locator(".panel-foot")).toContainText(`${tf.transforms.length} transforms`);
  }

  // 7) CameraInfo text and generic JSON panels (added from the menu)
  for (const topic of ["/cam_front/camera_info", "/component/status"]) {
    await page.getByRole("button", { name: /Add panel/ }).first().click();
    await page.locator(".card button", { hasText: topic }).click();
  }
  await page.waitForTimeout(1500);
  {
    const p = panel(page, "/cam_front/camera_info");
    const ci = await messageAt(DEMO, "/cam_front/camera_info", await shownIndex(p));
    await expect(p).toContainText(`${ci.width}×${ci.height}`);
    await expect(p).toContainText(Array.from(ci.k as number[]).map((v) => v.toFixed(2)).join(", "));
  }
  {
    const p = panel(page, "/component/status");
    const st = await messageAt(DEMO, "/component/status", await shownIndex(p));
    await expect(p).toContainText(`"${st.state}"`);
    await expect(p).toContainText(String(st.fps));
  }

  // 8) follow output: the input panel shows the exact frame the current output came from
  {
    const p = panel(page, "/cam_front/image_raw");
    await p.getByLabel("Show the input frame used by an output").selectOption("/cam_front/depth");
    await page.waitForTimeout(800);
    const e = a.edges.find((x) => x.input === "/cam_front/image_raw" && x.output === "/cam_front/depth")!;
    const j = lastAtOrBefore(T("/cam_front/depth").log, t * 1e9);
    expect(await shownIndex(p)).toBe(e.inputIndex[j]);
    await expect(p.locator(".panel-foot")).toContainText("frame used by /cam_front/depth");
    await p.getByLabel("Show the input frame used by an output").selectOption("");
  }

  // 9) header.stamp time source
  {
    await page.getByRole("button", { name: "header.stamp" }).click();
    await page.waitForTimeout(800);
    const td = T("/cam_front/depth");
    const sorted = Float64Array.from(td.stamp).sort();
    const k = lastAtOrBefore(sorted, t * 1e9);
    const expected = Array.from(td.stamp).indexOf(sorted[k]);
    expect(await shownIndex(panel(page, "/cam_front/depth"))).toBe(expected);
    await page.getByRole("button", { name: "log time" }).click();
  }

  // 10) inside the injected input gap (frames 240–248 ≈ 16.0–16.6 s) the camera panel is stale
  await jump(page, 16.5);
  await expect(panel(page, "/cam_front/image_raw").locator(".head-status .badge")).toHaveText(/Stale/);
});

test("the panel header never claims a frame that is not drawn (checked right after a jump)", async ({ page }) => {
  await open(page);
  const topic = "/cam_down/image_raw";
  const p = panel(page, topic);
  for (const s of [10, 4.2, 15.7, 1.3]) {
    await seekTo(page, s);
    await expect(page.locator(".time-display .num")).toContainText(s.toFixed(3));
    // sample immediately, while the new frame may still be loading
    const started = Date.now();
    let checked = 0;
    while (Date.now() - started < 1500) {
      const meta = await p.locator(".head-status .meta").innerText();
      const i = +/(\d+)\//.exec(meta)![1] - 1;
      const img = (await messageAt(DEMO, topic, i)) as RosImage;
      const got = await canvasRgb(p, img.width, img.height, PTS);
      const meta2 = await p.locator(".head-status .meta").innerText();
      if (meta2 !== meta) continue; // header changed while sampling: retry
      PTS.forEach(([x, y], k) => {
        const o = y * img.step + x * 3;
        expect(got[k], `t=${s}s header ${meta}`).toEqual([img.data[o], img.data[o + 1], img.data[o + 2]]);
      });
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }
});

test("seek latency: panels show the new moment quickly", async ({ page }) => {
  await open(page);
  const times: number[] = [];
  for (const s of [10, 4.2, 15.7, 1.3, 18.1]) {
    await page.keyboard.press("Control+k");
    await page.locator(".palette input").fill(`${s}s`);
    await expect(page.locator(".palette li").first()).toContainText(`Jump to ${s.toFixed(3)} s`);
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    await expect(page.locator(".time-display .num")).toContainText(s.toFixed(3));
    await expect(page.locator(".panel .head-status .badge", { hasText: "Loading" })).toHaveCount(0, { timeout: 10_000 });
    times.push(Date.now() - t0);
  }
  console.log(`seek → all panels drawn (ms): ${times.join(", ")}`);
  expect(Math.max(...times)).toBeLessThan(1500);
});

test("demo: projection overlay agrees on good frames and flags the injected +0.8 m offset", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: /FOV consistency/ }).click();
  const fov = page.locator("section", { hasText: "FOV cam_front" });
  await expect(fov.getByText("Calibration source: camera_info+tf")).toBeVisible({ timeout: 20_000 });
  await fov.getByRole("button", { name: "Open the projection in the replay" }).click();
  const ov = page.locator(".panel", { hasText: "Projection /cam_front/points" });
  const err = async () => parseFloat(/median depth error ([\d.]+) %/.exec(await ov.locator(".panel-foot").innerText())![1]);
  await jump(page, 8);
  await expect(ov.locator(".panel-foot")).toContainText("median depth error", { timeout: 10_000 });
  expect(await err()).toBeLessThan(5);
  await jump(page, 13.9);
  await expect.poll(err, { timeout: 10_000 }).toBeGreaterThan(5);
});

test("other recordings: Foxglove RawImage exact, JPEG close to the raw frame, ROS 1 bgr8 channel order", async ({ page }) => {
  // Foxglove protobuf RawImage + CompressedImage (JPEG) of the same frame
  const fx = `${RW}/foxglove_protobuf.mcap`;
  await open(page, fx);
  await jump(page, 3);
  const raw = panel(page, "/camera/image");
  const iRaw = await shownIndex(raw);
  const img = await messageAt(fx, "/camera/image", iRaw);
  const pts: Array<[number, number]> = [[5, 5], [32, 10], [32, 40], [50, 30], [10, 45]];
  const gotRaw = await canvasRgb(raw, img.width, img.height, pts);
  pts.forEach(([x, y], k) => {
    const o = y * img.step + x * 3;
    expect(gotRaw[k]).toEqual([img.data[o], img.data[o + 1], img.data[o + 2]]);
  });
  const jpg = panel(page, "/camera/compressed");
  expect(await shownIndex(jpg)).toBe(iRaw); // same frame index at the same moment
  const gotJpg = await canvasRgb(jpg, img.width, img.height, pts);
  const mae = gotJpg.flat().reduce((s, v, k) => s + Math.abs(v - gotRaw.flat()[k]), 0) / (pts.length * 3);
  expect(mae).toBeLessThan(20); // JPEG quality 80

  // ROS 1 bgr8: the canvas must show R = byte 2, B = byte 0
  const r1 = `${RW}/ros1.mcap`;
  await open(page, r1);
  await jump(page, 3);
  const p1 = panel(page, "/camera/image_raw");
  const m1 = await messageAt(r1, "/camera/image_raw", await shownIndex(p1));
  expect(m1.encoding).toBe("bgr8");
  const g1 = await canvasRgb(p1, m1.width, m1.height, pts);
  pts.forEach(([x, y], k) => {
    const o = y * m1.step + x * 3;
    expect(g1[k]).toEqual([m1.data[o + 2], m1.data[o + 1], m1.data[o]]);
  });
});
