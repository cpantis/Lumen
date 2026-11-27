/**
 * Every UI text is English (default language): visible text, tooltips (data-tip),
 * aria-labels, titles and placeholders of every visible view, scanned for Romanian.
 */
import { expect, test, type Page } from "@playwright/test";

const RO_WORDS = /\b(și|sau|pentru|intrare|ieșire|ieşire|ieșiri|timp|pas|goluri|cadre|mesaje|salt|latență|latenta|potrivire|setează|momentul|înregistr|cursorul|topicuri|nicio|niciun|orice|panou|imagine|adâncime|vârst|frecvenț|medie|intervale|praguri|cerinț)\b/i;
const DIACRITICS = /[ăâîșşțţĂÂÎȘŞȚŢ]/;

async function romanian(page: Page): Promise<string[]> {
  return page.evaluate(([w, d]) => {
    const words = new RegExp(w, "i"), dia = new RegExp(d);
    const out = new Set<string>();
    const check = (s: string | null | undefined, where: string) => {
      if (!s) return;
      for (const line of s.split("\n")) if (dia.test(line) || words.test(line)) out.add(`${where}: ${line.trim().slice(0, 140)}`);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest("option[value='ro'], script, style")) continue;
      check(n.textContent, "text");
    }
    for (const el of document.querySelectorAll("[data-tip],[aria-label],[title],[placeholder]")) {
      check(el.getAttribute("data-tip"), "tip");
      check(el.getAttribute("aria-label"), "aria");
      check(el.getAttribute("title"), "title");
      check(el.getAttribute("placeholder"), "placeholder");
    }
    return [...out];
  }, [RO_WORDS.source, DIACRITICS.source]);
}

test("no Romanian text anywhere in the English UI, and no console error in any view", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lumen.prefs", JSON.stringify({ tourDone: true })));
  await page.reload();
  const found: string[] = [];
  found.push(...(await romanian(page)).map((x) => `[start] ${x}`));
  await page.getByTestId("demo").click();
  await expect(page.locator(".replay")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  found.push(...(await romanian(page)).map((x) => `[replay] ${x}`));
  for (const tab of ["Inventory", "Causality", "Content quality", "FOV consistency"]) {
    await page.getByRole("tab", { name: new RegExp(tab) }).click();
    await page.waitForTimeout(1200);
    found.push(...(await romanian(page)).map((x) => `[${tab}] ${x}`));
  }
  for (const [btn, name] of [["Settings", "settings"], ["Help", "help"]]) {
    const b = page.getByRole("button", { name: new RegExp(btn, "i") }).first();
    if (await b.count()) {
      await b.click();
      await page.waitForTimeout(300);
      found.push(...(await romanian(page)).map((x) => `[${name}] ${x}`));
      await page.keyboard.press("Escape");
    }
  }
  console.log(found.join("\n"));
  expect(found).toEqual([]);
  expect(errors).toEqual([]);
});
