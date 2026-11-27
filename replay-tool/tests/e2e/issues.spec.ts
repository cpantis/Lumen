/** Issue markers from JSON: shown on the timeline, one jump button each (clock + time + topics). */
import { expect, test } from "@playwright/test";

test("issue markers load from a JSON file and jump to their moment on their clock", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  const json = JSON.stringify({ issues: [
    { id: "GAP-A", title: "front camera gap", start_s: 16.0, end_s: 16.6, jump_s: 16.3, clock: "log", topics: ["/cam_front/image_raw"] },
    { id: "WORST-B", title: "worst cloud", stamp_s: 13.9, jump_s: 13.9, clock: "header", topics: ["/cam_front/points"] },
  ] });
  await page.getByTestId("issue-legend").locator("input[type=file]").setInputFiles({ name: "issues.json", mimeType: "application/json", buffer: Buffer.from(json) });
  const jumps = page.getByTestId("issue-jump");
  await expect(jumps).toHaveCount(2);
  await expect(jumps.first()).toHaveAttribute("data-tip", /front camera gap .*16\.000 s–16\.600 s \(log time\)/);
  await jumps.nth(1).click();
  await expect(page.locator(".time-display .num")).toContainText("13.900");
  await expect(page.getByTestId("clock-switch").getByRole("button", { name: "header.stamp" })).toHaveAttribute("aria-pressed", "true");
  await jumps.first().click();
  await expect(page.locator(".time-display .num")).toContainText("16.300");
  await expect(page.getByTestId("clock-switch").getByRole("button", { name: "log time" })).toHaveAttribute("aria-pressed", "true");
  // the deep link carries time and clock
  await page.waitForTimeout(500);
  expect(new URL(page.url()).hash).toContain("t=16.300");
  await page.getByLabel("Show issue markers").uncheck();
  await expect(jumps).toHaveCount(0);
});

test("the .lumen challenge issue file served with the app parses (palette command)", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Control+k");
  await page.locator(".palette input").fill("issue markers");
  await expect(page.locator(".palette li").first()).toContainText("lumen-issues.json");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("issue-jump")).toHaveText(["ISSUE-1 ↗", "ISSUE-2 ↗", "ISSUE-3 ↗"]);
});
