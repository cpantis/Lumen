/**
 * E2E for every export and for the compact (tablet / phone) mode:
 * PNG snapshot, deterministic MP4 video, timed PNG snapshots, inventory CSV + Markdown, test report JSON,
 * bug ZIP, layout save dialog.
 */
import { devices, expect, test, type Download, type Page } from "@playwright/test";
import JSZip from "jszip";
import { readFileSync } from "node:fs";

async function openDemo(page: Page) {
  await page.goto("/?features=all"); // exercise the views hidden in the first delivery too
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".panel").first()).toBeVisible();
}

async function bytes(d: Download): Promise<Buffer> {
  return readFileSync((await d.path())!);
}

test("PNG snapshot of the layout", async ({ page }) => {
  await openDemo(page);
  await page.waitForTimeout(1500);
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "PNG snapshot" }).click()]);
  expect(d.suggestedFilename()).toMatch(/^stamptrace-.*\.png$/);
  const b = await bytes(d);
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  expect(b.length).toBeGreaterThan(20_000);
});

/** Duration of an MP4 (mvhd box) in seconds. */
function mp4Duration(b: Buffer): number {
  const i = b.indexOf("mvhd");
  const version = b[i + 4];
  return version === 1 ? Number(b.readBigUInt64BE(i + 4 + 4 + 16 + 4)) / b.readUInt32BE(i + 4 + 4 + 16) : b.readUInt32BE(i + 4 + 4 + 8 + 4) / b.readUInt32BE(i + 4 + 4 + 8);
}

test("deterministic MP4 video: frame count, fps x speed, summary.json with metadata", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: /Export video/ }).click();
  const dlg = page.getByRole("dialog", { name: "Export" });
  await dlg.getByLabel("Start (s)").fill("1");
  await dlg.getByLabel("End (s)").fill("2");
  await dlg.getByLabel("Frames per second").fill("10");
  await dlg.getByLabel("Speed factor").fill("2");
  await dlg.getByLabel("Time base").selectOption("header");
  await expect(dlg).toContainText("11 frames · video 20.00 fps");
  const downloads: Download[] = [];
  page.on("download", (d) => downloads.push(d));
  await dlg.getByRole("button", { name: "Render video" }).click();
  await expect(dlg.getByTestId("export-result")).toContainText("Saved replay_1.00-2.00s_header_10fps_x2.mp4", { timeout: 120_000 });
  await expect.poll(() => downloads.length).toBe(2);
  const mp4 = downloads.find((d) => d.suggestedFilename().endsWith(".mp4"))!;
  const sum = downloads.find((d) => d.suggestedFilename().endsWith(".summary.json"))!;
  const b = await bytes(mp4);
  expect(b.subarray(4, 8).toString()).toBe("ftyp");
  expect(mp4Duration(b)).toBeCloseTo(11 / 20, 2);
  const s = JSON.parse((await bytes(sum)).toString("utf8"));
  expect(s).toMatchObject({ video: "replay_1.00-2.00s_header_10fps_x2.mp4", frames: 11, fps: 10, base: "header", video_fps: 20, speed: 2, interval_s: [1, 2], container: "mp4", time_base: "header" });
  expect(s.codec).toMatch(/^avc1\./);
  expect(s.render_s).toBeGreaterThan(0);
  expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(s.files[0]).toMatchObject({ name: "demo-synthetic.mcap" });
  expect(s.layout.panels.length).toBeGreaterThan(3);
  expect(s.overrides).toBeDefined();
  expect(s.commit).toBeTruthy();
});

test("PNG snapshots at chosen times: names, ZIP, metadata in each PNG, suggestions", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill("PNG snapshots");
  await expect(page.locator(".palette li").first()).toContainText("PNG snapshots");
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: "Export" });
  await expect(dlg.getByRole("button", { name: /largest output gap/ })).toBeVisible();
  await expect(dlg.getByRole("button", { name: /largest end-to-end latency/ })).toBeVisible();
  await dlg.getByLabel("Snapshot times (s)").fill("4.2, 12.5");
  await expect(dlg).toContainText("replay_004.20s.png  replay_012.50s.png");
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dlg.getByRole("button", { name: "Save snapshots" }).click()]);
  expect(d.suggestedFilename()).toBe("replay_snapshots.zip");
  const zip = await JSZip.loadAsync(await bytes(d));
  expect(Object.keys(zip.files).sort()).toEqual(["replay_004.20s.png", "replay_012.50s.png", "summary.json"]);
  const png = await zip.file("replay_012.50s.png")!.async("uint8array");
  const txt = Buffer.from(png).toString("latin1");
  expect(txt).toContain("StampTrace");
  expect(txt).toMatch(/"t_s":12\.5/);
  const sum = JSON.parse(await zip.file("summary.json")!.async("string"));
  expect(sum.snapshots.map((x: { file: string }) => x.file)).toEqual(["replay_004.20s.png", "replay_012.50s.png"]);
  expect(sum.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("inventory CSV and Markdown", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("tab", { name: /Inventory/ }).click();
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV", exact: true }).first().click()]);
  const text = (await bytes(csv)).toString("utf8");
  expect(text.split("\n")[0]).toContain("Topic");
  expect(text).toContain("/cam_front/depth");
  expect(text.trim().split("\n")).toHaveLength(12); // header + 11 topics
  const [md] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Markdown", exact: true }).click()]);
  const m = (await bytes(md)).toString("utf8");
  expect(m).toContain("| Topic |");
  expect(m).toMatch(/SHA-256 [0-9a-f]{64}/);
  // CSV of a plot (instant rate of the selected topic)
  const [pc] = await Promise.all([page.waitForEvent("download"), page.locator("figure", { hasText: "Instantaneous rate" }).getByRole("button", { name: "CSV" }).click()]);
  const rows = (await bytes(pc)).toString("utf8").trim().split("\n");
  expect(rows[0]).toContain("t_rel_s");
  expect(rows.length).toBeGreaterThan(100);
});

test("test report JSON (derived) has failures with absolute ns times", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("tab", { name: /Requirements/ }).click();
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "report-derived.json" }).click()]);
  const rep = JSON.parse((await bytes(d)).toString("utf8"));
  expect(rep.profile).toBe("derived");
  expect(rep.results.length).toBeGreaterThan(10);
  expect(rep.failures.length).toBeGreaterThan(0);
  expect(rep.failures[0].t_start_ns).toMatch(/^\d{19}$/);
  expect(rep.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("bug ZIP contains Markdown and the snapshot", async ({ page }) => {
  await openDemo(page);
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Bug", exact: true }).click();
  await page.getByLabel("Short, specific title").fill("Test ZIP");
  await page.getByRole("button", { name: "Save bug" }).click();
  await page.getByRole("tab", { name: /Bugs/ }).click();
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /ZIP/ }).click()]);
  const zip = await JSZip.loadAsync(await bytes(d));
  const names = Object.keys(zip.files);
  expect(names).toContain("README.md");
  const md = names.find((n) => n.endsWith("bug.md"))!;
  const text = await zip.file(md)!.async("string");
  expect(text).toContain("## Test ZIP");
  expect(text).toContain("Steps to reproduce");
  expect(names.some((n) => n.endsWith(".png"))).toBe(true);
});

test("layout save dialog (no browser prompt)", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Save layout" }).click();
  await page.getByLabel("Layout name").fill("demo e2e");
  await page.getByLabel("Layout name").press("Enter");
  await expect(page.getByLabel("Load layout")).toContainText("demo e2e");
});

test.describe("compact mode on a phone", () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices["iPhone 13"];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });
  test("one panel at a time, no horizontal overflow", async ({ page }) => {
    await openDemo(page);
    await expect(page.locator(".replay.narrow")).toBeVisible();
    await expect(page.locator(".panel")).toHaveCount(1);
    const before = await page.locator(".panel .title").innerText();
    await page.getByRole("button", { name: "Next panel" }).click();
    await expect(page.locator(".panel .title")).not.toHaveText(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });
});

test("English interface (language switch)", async ({ page }) => {
  await page.goto("/?features=all");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true, lang: "en" })));
  await page.reload();
  await expect(page.getByText("Project for the dotLumen SW Test Challenge")).toBeVisible();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Inventory" }).click();
  await expect(page.getByRole("heading", { name: "Recording inventory" })).toBeVisible();
  await page.getByRole("tab", { name: /Requirements/ }).click();
  await expect(page.getByRole("heading", { name: "Requirements & tests" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Results — profile Derived" }).getByRole("columnheader", { name: "Requirement" })).toBeVisible();
  await page.getByRole("tab", { name: "Safety" }).click();
  await expect(page.getByRole("heading", { name: "What it means for the user" })).toBeVisible();
  // switch back to Romanian from the settings dialog
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Language").selectOption("ro");
  await expect(page.getByRole("heading", { name: "Ce înseamnă pentru utilizator" })).toBeVisible();
});

test("English is the default language", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("lumen.prefs"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "StampTrace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open the demo recording" })).toBeVisible();
});

test("first delivery: Requirements, Safety and Bugs & notes are hidden", async ({ page }) => {
  await page.goto("/?features=default");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  const tabs = await page.getByRole("tab").allInnerTexts();
  expect(tabs.map((t) => t.trim())).toEqual(["Replay", "Inventory", "Causality & latency", "Content quality", "FOV consistency"]);
  await expect(page.getByRole("button", { name: "Bug", exact: true })).toHaveCount(0);
  await expect(page.getByText("requirement violation")).toHaveCount(0);
  // a deep link to a hidden view falls back to the replay
  await page.goto("/?features=default#?view=requirements");
  await page.reload();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
});

test("snapshots do not depend on machine speed: identical pixels with a 150 ms decode delay", async ({ browser }) => {
  async function snap(slow: boolean): Promise<Buffer> {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
    const page = await ctx.newPage();
    if (slow)
      await page.addInitScript(() => {
        const W = window.Worker;
        window.Worker = class extends W {
          override set onmessage(h: ((ev: MessageEvent) => void) | null) {
            super.onmessage = h && ((ev: MessageEvent) => (ev.data?.op === "message" ? setTimeout(() => h.call(this, ev), 150) : h.call(this, ev)));
          }
          override get onmessage() {
            return super.onmessage;
          }
        } as typeof Worker;
      });
    await openDemo(page);
    await page.keyboard.press("Control+k");
    await page.locator(".palette input").fill("PNG snapshots");
    await expect(page.locator(".palette li").first()).toContainText("PNG snapshots");
    await page.keyboard.press("Enter");
    const dlg = page.getByRole("dialog", { name: "Export" });
    await dlg.getByLabel("Snapshot times (s)").fill("13.9");
    const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dlg.getByRole("button", { name: "Save snapshots" }).click()]);
    expect(d.suggestedFilename()).toBe("replay_013.90s.png");
    const b = await bytes(d);
    await ctx.close();
    return b;
  }
  const fast = await snap(false);
  const slow = await snap(true);
  const page = await browser.newPage();
  await page.goto("/");
  const diff = await page.evaluate(async ([a, b]) => {
    const load = async (s: string) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
    const [x, y] = await Promise.all([load(a), load(b)]);
    if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}x${x.height} vs ${y.width}x${y.height}`, px: -1 };
    const c = new OffscreenCanvas(x.width, x.height).getContext("2d")!;
    c.drawImage(x, 0, 0);
    const A = c.getImageData(0, 0, x.width, x.height - 28).data; // the last 28 px hold the trace line (generated_at)
    c.drawImage(y, 0, 0);
    const B = c.getImageData(0, 0, x.width, x.height - 28).data;
    let px = 0;
    for (let i = 0; i < A.length; i += 4) if (A[i] !== B[i] || A[i + 1] !== B[i + 1] || A[i + 2] !== B[i + 2]) px++;
    return { size: "", px };
  }, [fast.toString("base64"), slow.toString("base64")]);
  expect(diff.size).toBe("");
  expect(diff.px).toBe(0);
});
