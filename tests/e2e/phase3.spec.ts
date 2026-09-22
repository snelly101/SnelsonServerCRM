import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 3 (demo adapter): create a proposal from an opportunity, see it on
 * the opportunity and Proposals pages, and confirm the Integrations page
 * labels the provider as demo and records the sync run.
 */
const ADMIN = { email: "admin@example.com", password: "Admin12345!" };

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("integrations page shows Better Proposals as demo, sync runs are recorded", async ({ page }) => {
  await login(page);
  await page.goto("/integrations");
  await expect(page.getByText("Demo (not connected)").first()).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).first().click();
  await expect(page.getByText(/Checked \d+/)).toBeVisible();
  await expect(page.getByRole("cell", { name: "proposals.poll" }).first()).toBeVisible();
});

test("create a proposal from an opportunity (demo) and see its progress", async ({ page }) => {
  await login(page);
  await page.goto("/pipeline");
  await page.getByRole("link", { name: "Managed IT for 40 users + EDR" }).click();
  await expect(page).toHaveURL(/\/pipeline\//);
  const card = page.getByRole("heading", { name: "Proposal" }).locator("..").locator("..");
  await card.getByRole("button", { name: /Create proposal|Create another version/ }).click();
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText(/Open in Better Proposals/).first()).toBeVisible();
  await expect(page.getByText("Demo adapter: proposals created here are synthetic")).toBeVisible();
  await page.goto("/proposals");
  await expect(page.getByText("Demo data")).toBeVisible();
  await expect(page.getByRole("cell", { name: /Proposal from template/ }).first()).toBeVisible();
});

test("read-only users cannot manage integrations", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("readonly@example.com");
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto("/integrations");
  await expect(page.getByRole("button", { name: "Test" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(0);
});
