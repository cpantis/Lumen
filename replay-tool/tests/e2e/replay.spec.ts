/**
 * End-to-end tests on the synthetic recording: load, play, scrub, panels update,
 * views, overlay + calibration, bug creation, report import, command palette, and an
 * accessibility audit (axe-core, WCAG 2.x AA) in both themes.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

async function openDemo(page: Page, theme: "dark" | "light" = "dark") {
  await page.goto("/?features=all"); // exercise the views hidden in the first delivery too
  await page.evaluate((t) => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true, theme: t })), theme);
  await page.reload();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".panel").first()).toBeVisible();
}

const cursorText = (page: Page) => page.locator(".time-display .num").innerText();

test("loads the recording, plays and scrubs; panels update", async ({ page }) => {
  await openDemo(page);
  await expect(page.locator(".topbar .file")).toContainText("demo-synthetic.mcap");
  const t0 = await cursorText(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Space");
  const t1 = await cursorText(page);
  expect(parseFloat(t1)).toBeGreaterThan(parseFloat(t0));

  // scrub on the timeline canvas → time display + panel index change
  const panel = page.locator(".panel", { hasText: "/cam_front/depth" }).first();
  const idxBefore = await panel.locator(".head-status .meta").innerText();
  const tl = page.locator(".timeline canvas");
  const box = (await tl.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + 30);
  await page.waitForTimeout(800);
  expect(parseFloat(await cursorText(page))).toBeGreaterThan(10);
  await expect(panel.locator(".head-status .meta")).not.toHaveText(idxBefore);

  // frame stepping on a chosen topic
  await page.getByLabel("Step on topic").selectOption("/cam_front/depth");
  const before = parseFloat(await cursorText(page));
  await page.keyboard.press("ArrowRight");
  expect(parseFloat(await cursorText(page))).toBeGreaterThan(before);
});

test("analysis views render the injected defects", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("tab", { name: /Inventory/ }).click();
  await expect(page.getByText("100% of its header.stamps copy /cam_front/image_raw").first()).toBeVisible();
  await page.getByRole("tab", { name: /Causality/ }).click();
  await expect(page.locator("svg.diagram")).toBeVisible();
  await page.getByRole("tab", { name: /Requirements/ }).click();
  await expect(page.locator("tr", { hasText: "REQ-CONT-06" }).first().getByText("FAIL").first()).toBeVisible();
  // expand a requirement and jump to a violation
  await page.locator("tr", { hasText: "REQ-OUT-02" }).first().click();
  await page.locator("tr.clickable", { hasText: "gap of" }).first().click();
  await expect(page.locator(".replay")).toBeVisible();
  await page.getByRole("tab", { name: /Safety/ }).click();
  await expect(page.getByText("speed estimated from the IMU")).toBeVisible();
});

test("overlay projection, consistency over time and parameter estimation", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("tab", { name: /FOV consistency/ }).click();
  const fov = page.locator("section", { hasText: "FOV cam_front" });
  await expect(fov.getByText("Calibration source: camera_info+tf")).toBeVisible({ timeout: 20_000 });
  await fov.getByRole("button", { name: "Compute consistency over time" }).click();
  await expect(fov.getByText(/of \d+ sampled frames above 5 %/)).toBeVisible({ timeout: 60_000 });
  await fov.getByRole("button", { name: "Estimate the checked parameters" }).click();
  await expect(fov.getByText(/Estimation on \d+ frames/)).toBeVisible({ timeout: 60_000 });
  await fov.getByRole("button", { name: "Open the projection in the replay" }).click();
  await expect(page.locator(".panel", { hasText: "Projection /cam_front/points" })).toBeVisible();
});

test("bug report, notes, command palette, report import", async ({ page }) => {
  mkdirSync("out", { recursive: true });
  try {
    execFileSync("npx", ["tsx", "scripts/metrics-cli.ts", "public/demo.mcap", "--out", "out/e2e"], { stdio: "ignore" });
  } catch {
    /* exit code 1 = the derived profile has failures (expected on the synthetic recording) */
  }
  await openDemo(page);
  // bug from the transport bar
  await page.getByRole("button", { name: "Bug", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Create bug/ })).toBeVisible();
  await page.getByLabel("Short, specific title").fill("670 ms gap in the cam_front output");
  await page.getByRole("button", { name: "Save bug" }).click();
  await page.getByRole("tab", { name: /Bugs/ }).click();
  await expect(page.getByText("670 ms gap in the cam_front output")).toBeVisible();

  // command palette: jump to a timestamp
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill("7.5s");
  await page.keyboard.press("Enter");
  await expect(page.locator(".time-display .num")).toContainText("7.500");

  // import the CLI report → markers + list
  await page.getByRole("tab", { name: /Requirements/ }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import report" }).click();
  await (await chooser).setFiles("out/e2e/report-strict.json");
  await expect(page.getByText("report-strict.json").first()).toBeVisible();
});

test("styleguide is reachable without a file", async ({ page }) => {
  await page.goto("/#/styleguide");
  await expect(page.getByRole("heading", { name: "StampTrace design system" })).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  test(`accessibility audit (axe, WCAG AA) — ${theme} theme`, async ({ page }) => {
    await openDemo(page, theme);
    await page.waitForTimeout(1500);
    const views = ["Replay", "Inventory", "Requirements"];
    for (const v of views) {
      await page.getByRole("tab", { name: new RegExp(v) }).click();
      await page.waitForTimeout(800);
      const res = await new AxeBuilder({ page: page as never })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .exclude("canvas") // WebGL/canvas content is described via aria-label
        .exclude(".uplot")
        .analyze();
      const serious = res.violations.filter((x) => x.impact === "serious" || x.impact === "critical");
      expect(serious.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `${v} (${theme})`).toEqual([]);
    }
    await page.screenshot({ path: `out/screenshot-${theme}.png` });
  });
}
