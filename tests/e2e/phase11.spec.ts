import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "Admin12345!";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** Picks a theme from the header menu and waits until the server has stored it (cookie updated). */
async function pickTheme(page: Page, label: "System" | "Light" | "Dark") {
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitem", { name: label }).click();
  await expect.poll(async () => (await page.context().cookies()).find((c) => c.name === "crm-theme")?.value).toBe(label.toLowerCase());
}

test("theme follows the system by default, the header toggle switches to dark and persists via cookie and account, the sidebar stays dark, print stays light", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await login(page, "sales@example.com");
  // Undo a previous run
  await pickTheme(page, "System");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightBg = await bg(page);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkBg = await bg(page);
  expect(darkBg).not.toBe(lightBg);

  // Explicit light overrides the OS
  await pickTheme(page, "Light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // Explicit dark, persisted across reload (cookie) and across a fresh browser context (account)
  await pickTheme(page, "Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bg(page)).toBe(darkBg);
  // Cards are lighter than the page and the text is light
  const card = page.locator("section.rounded-lg").first();
  const cardBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(cardBg).not.toBe(darkBg);
  const fg = await page.evaluate(() => getComputedStyle(document.body).color);
  expect(fg).toMatch(/rgb\(2\d\d, 2\d\d, 2\d\d\)/);
  // The sidebar keeps its own dark styling and white text
  const aside = page.locator("aside").first();
  expect(await aside.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)");

  await page.context().clearCookies();
  await page.emulateMedia({ colorScheme: "light" });
  await login(page, "sales@example.com");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Print media forces light colours
  await page.emulateMedia({ media: "print" });
  expect(await bg(page)).toBe("rgb(255, 255, 255)");
  await page.emulateMedia({ media: "screen" });

  // Clean up for other tests
  await pickTheme(page, "System");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
