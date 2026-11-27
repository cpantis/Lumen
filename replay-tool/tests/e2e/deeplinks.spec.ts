/** Deep links: links made by older versions keep working; new links carry the time base and every override. */
import { expect, test, type Page } from "@playwright/test";

async function demoAt(page: Page, hash: string) {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.goto(`/${hash}`);
  await page.reload();
  await page.getByTestId("demo").click();
}

test("an old deep link (t, view, p with 6-field panels) still opens the right moment, view and layout", async ({ page }) => {
  // format written by earlier versions: [id, topic, x, y, w, h]
  const p = Buffer.from(JSON.stringify([["a1", "/cam_front/image_raw", 0, 0, 6, 7], ["b2", "/cam_front/points", 6, 0, 6, 7]])).toString("base64");
  await demoAt(page, `#?t=12.500&view=replay&p=${encodeURIComponent(p)}`);
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".time-display .num")).toContainText("12.500");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.getByLabel("Panel /cam_front/points", { exact: true })).toBeVisible();
  // and a link to another view
  await demoAt(page, "#?t=3.000&view=inventory");
  await expect(page.getByTestId("inference-table")).toBeVisible({ timeout: 60_000 });
});

test("a new deep link restores the time base and every override", async ({ page, context }) => {
  await demoAt(page, "");
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "header.stamp" }).click();
  await page.getByRole("tab", { name: /Inventory/ }).click();
  const tbl = page.getByTestId("inference-table");
  await tbl.getByLabel("Trigger of /cam_front/points").selectOption("/cam_front/camera_info");
  await tbl.getByLabel("Nominal period of /cam_front/depth (ms)").fill("80");
  await page.getByLabel("Stale factor k").fill("5");
  await tbl.getByLabel("Colouring of /cam_down/points").selectOption("z");
  await page.waitForTimeout(500); // URL is written debounced
  const hash = new URL(page.url()).hash;
  expect(hash).toContain("base=header");
  expect(hash).toContain("o=");
  const p2 = await context.newPage();
  await p2.goto("/");
  await p2.goto(`/${hash}`);
  await p2.reload();
  await p2.getByTestId("demo").click();
  await expect(p2.getByTestId("inference-table")).toBeVisible({ timeout: 60_000 });
  const t2 = p2.getByTestId("inference-table");
  await expect(t2.getByLabel("Trigger of /cam_front/points")).toHaveValue("/cam_front/camera_info");
  await expect(t2.locator('tr[data-topic="/cam_front/points"]')).toContainText("override");
  await expect(t2.getByLabel("Nominal period of /cam_front/depth (ms)")).toHaveValue("80");
  await expect(p2.getByLabel("Stale factor k")).toHaveValue("5");
  await expect(t2.getByLabel("Colouring of /cam_down/points")).toHaveValue("z");
  await p2.getByRole("tab", { name: /Replay/ }).click();
  await expect(p2.getByRole("button", { name: "header.stamp" })).toHaveAttribute("aria-pressed", "true");
  // time, clock and layout identical after the round trip (layout = panel id, topic, x, y, w, h)
  const decode = (h: string) => {
    const q = new URLSearchParams(h.replace(/^#\/?[^?]*\?/, ""));
    return { t: q.get("t"), base: q.get("base"), p: JSON.parse(Buffer.from(q.get("p")!, "base64").toString("utf8")) };
  };
  await p2.waitForTimeout(500);
  const before = decode(hash), after = decode(new URL(p2.url()).hash);
  expect(after.t).toBe(before.t);
  expect(after.base).toBe("header");
  expect(after.p).toEqual(before.p);
});
