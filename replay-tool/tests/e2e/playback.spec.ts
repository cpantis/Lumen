import { test, expect } from "@playwright/test";

/**
 * Real-time replay must keep drawing frames even when decoding a frame takes longer
 * than the gap between frames (large real recordings, slow laptops). Every decoded
 * frame is delivered 120 ms late, slower than the 15 Hz camera rate (67 ms).
 */
test("playback keeps drawing new frames when decoding is slower than the frame rate", async ({ page }) => {
  await page.addInitScript(() => {
    const W = window.Worker;
    (window as any).__slow = false;
    window.Worker = class extends W {
      override set onmessage(h: ((ev: MessageEvent) => void) | null) {
        super.onmessage = h && ((ev: MessageEvent) => ((window as any).__slow && ev.data?.op === "message" ? setTimeout(() => h.call(this, ev), 120) : h.call(this, ev)));
      }
      override get onmessage() {
        return super.onmessage;
      }
    } as typeof Worker;
  });
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => ((window as any).__slow = true));
  await page.keyboard.press("Space");
  const shown = new Set<string>();
  const pixels = new Set<string>();
  for (let k = 0; k < 16; k++) {
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const p = [...document.querySelectorAll(".panel")].find((x) => x.querySelector(".title")?.textContent === "/cam_front/depth")!;
      const c = p.querySelector("canvas") as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0;
      return { idx: p.querySelector(".head-status .mono, .head-status")?.textContent ?? "", h: String(h) };
    });
    shown.add(r.idx.match(/(\d+)\/\d+/)?.[1] ?? "");
    pixels.add(r.h);
  }
  console.log(`distinct frames drawn in 4 s of playback: header ${shown.size}, canvas ${pixels.size}`);
  expect(shown.size).toBeGreaterThanOrEqual(6);
  expect(pixels.size).toBeGreaterThanOrEqual(6);
});
