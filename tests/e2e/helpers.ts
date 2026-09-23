import { expect, type Page } from "@playwright/test";

/** Opens a company-page section by its label, via the visible nav link or the More menu when the row has overflowed. */
export async function openSection(page: Page, name: RegExp | string) {
  const nav = page.getByRole("navigation", { name: "Company sections" });
  await expect(nav).toBeVisible();
  const link = nav.getByRole("link", { name });
  if (await link.count()) {
    await link.first().click();
    return;
  }
  await nav.getByRole("button", { name: /More sections/ }).click();
  await page.getByRole("menuitem", { name }).first().click();
}

/** True when the section is reachable from the nav row or the More menu. */
export async function sectionAvailable(page: Page, name: RegExp | string) {
  const nav = page.getByRole("navigation", { name: "Company sections" });
  await expect(nav).toBeVisible();
  if (await nav.getByRole("link", { name }).count()) return true;
  const more = nav.getByRole("button", { name: /More sections/ });
  if (!(await more.count())) return false;
  await more.click();
  const found = (await page.getByRole("menuitem", { name }).count()) > 0;
  await page.keyboard.press("Escape");
  return found;
}
