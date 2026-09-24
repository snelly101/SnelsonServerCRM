import { test, expect } from "@playwright/test";

const PASSWORD = "Admin12345!";

test("desktop sidebar stays pinned while the page scrolls, and only its nav scrolls when the viewport is short", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);

  // Force a tall page so the document scrolls.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "3000px";
    document.querySelector("main")?.appendChild(spacer);
  });
  const aside = page.locator("aside").first();
  await expect(aside).toBeVisible();
  const before = await aside.boundingBox();
  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(1000);
  const after = await aside.boundingBox();
  expect(before?.y).toBe(0);
  expect(after?.y).toBe(0);
  expect(after?.height).toBe(800);
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" }),
  ).toBeInViewport();

  // Short viewport: the nav becomes its own scroll region so every item stays reachable.
  await page.setViewportSize({ width: 1280, height: 360 });
  const nav = page.getByRole("navigation", { name: "Main" });
  const overflow = await nav.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
    css: getComputedStyle(el).overflowY,
  }));
  expect(overflow.css).toBe("auto");
  expect(overflow.scroll).toBeGreaterThan(overflow.client);
  await nav.getByRole("link", { name: "Settings" }).scrollIntoViewIfNeeded();
  await expect(nav.getByRole("link", { name: "Settings" })).toBeInViewport();
  await expect(page.getByText("Alex Admin").first()).toBeInViewport();
});
