/**
 * E2E for every export and for the compact (tablet / phone) mode:
 * PNG snapshot, WebM video of A–B, inventory CSV + Markdown, test report JSON,
 * bug ZIP, layout save dialog.
 */
import { devices, expect, test, type Download, type Page } from "@playwright/test";
import JSZip from "jszip";
import { readFileSync } from "node:fs";

async function openDemo(page: Page) {
  await page.goto("/");
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
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Captură PNG" }).click()]);
  expect(d.suggestedFilename()).toMatch(/^lumen-replay-.*\.png$/);
  const b = await bytes(d);
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  expect(b.length).toBeGreaterThan(20_000);
});

test("WebM video of the A–B interval", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("a");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("b");
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: /Export video/ }).click()]);
  expect(d.suggestedFilename()).toMatch(/\.webm$/);
  const b = await bytes(d);
  expect(b.readUInt32BE(0)).toBe(0x1a45dfa3); // EBML (WebM) signature
  expect(b.length).toBeGreaterThan(5_000);
});

test("inventory CSV and Markdown", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("tab", { name: /Inventar/ }).click();
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
  const [pc] = await Promise.all([page.waitForEvent("download"), page.locator("figure", { hasText: "Frecvența instantanee" }).getByRole("button", { name: "CSV" }).click()]);
  const rows = (await bytes(pc)).toString("utf8").trim().split("\n");
  expect(rows[0]).toContain("t_rel_s");
  expect(rows.length).toBeGreaterThan(100);
});

test("test report JSON (derived) has failures with absolute ns times", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("tab", { name: /Cerințe/ }).click();
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
  await page.getByLabel("Titlu scurt și specific").fill("Test ZIP");
  await page.getByRole("button", { name: "Salvează bug" }).click();
  await page.getByRole("tab", { name: /Bug-uri/ }).click();
  const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /ZIP/ }).click()]);
  const zip = await JSZip.loadAsync(await bytes(d));
  const names = Object.keys(zip.files);
  expect(names).toContain("README.md");
  const md = names.find((n) => n.endsWith("bug.md"))!;
  const text = await zip.file(md)!.async("string");
  expect(text).toContain("## Test ZIP");
  expect(text).toContain("Pași de reproducere");
  expect(names.some((n) => n.endsWith(".png"))).toBe(true);
});

test("layout save dialog (no browser prompt)", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Salvează layout" }).click();
  await page.getByLabel("Numele layout-ului").fill("demo e2e");
  await page.getByLabel("Numele layout-ului").press("Enter");
  await expect(page.getByLabel("Încarcă layout")).toContainText("demo e2e");
});

test.describe("compact mode on a phone", () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices["iPhone 13"];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });
  test("one panel at a time, no horizontal overflow", async ({ page }) => {
    await openDemo(page);
    await expect(page.locator(".replay.narrow")).toBeVisible();
    await expect(page.locator(".panel")).toHaveCount(1);
    const before = await page.locator(".panel .title").innerText();
    await page.getByRole("button", { name: "Panoul următor" }).click();
    await expect(page.locator(".panel .title")).not.toHaveText(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });
});
