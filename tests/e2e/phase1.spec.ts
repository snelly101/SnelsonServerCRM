import { test, expect, type Page } from "@playwright/test";
import { openSection } from "./helpers";

/**
 * Phase 1 acceptance: sign in, create a prospect, add a contact, see them
 * on the customer overview, and confirm a read-only user is blocked.
 * Requires a seeded database (npm run db:seed) and a running server.
 */
const ADMIN = { email: "admin@example.com", password: "Admin12345!" };
const READONLY = { email: "readonly@example.com", password: "Admin12345!" };

async function login(page: Page, creds: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("signed-out visitors are redirected to login", async ({ page }) => {
  await page.goto("/companies");
  await expect(page).toHaveURL(/\/login\?next=%2Fcompanies/);
});

test("admin can create a prospect and a contact, and see them on the overview", async ({ page }) => {
  await login(page, ADMIN);
  const stamp = Date.now();
  const name = `E2E Prospect ${stamp}`;

  await page.goto("/companies/new");
  await page.getByLabel("Company name").fill(name);
  await page.getByLabel("Website").fill(`e2e-${stamp}.example`);
  await page.getByLabel("Industry").fill("Testing");
  await page.getByLabel("Town / city").fill("Leeds");
  await page.getByRole("button", { name: "Create company" }).click();

  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
  // Overview carries no timeline; the creation event lives under Activity
  await expect(page.getByText("Company created as prospect")).toHaveCount(0);
  await openSection(page, "Activity");
  await expect(page.getByText("Company created as prospect")).toBeVisible();

  // Add a contact from the company page
  await openSection(page, /Contacts/);
  await page.getByRole("link", { name: "Add contact" }).click();
  await page.getByLabel("First name").fill("Test");
  await page.getByLabel("Last name").fill("Person");
  await page.getByLabel("Email", { exact: true }).fill(`test.person@e2e-${stamp}.example`);
  await page.getByLabel("Decision maker").check();
  await page.getByRole("button", { name: "Create contact" }).click();

  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
  await openSection(page, /Contacts/);
  await expect(page.getByRole("link", { name: "Test Person" })).toBeVisible();

  // Duplicate detection warns when creating the same domain again
  await page.goto("/companies/new");
  await page.getByLabel("Company name").fill(`${name} Copy`);
  await page.getByLabel("Website").fill(`e2e-${stamp}.example`);
  await expect(page.getByText("Possible duplicates")).toBeVisible();
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByText(/looks like a duplicate/)).toBeVisible();

  // Global search finds the company
  await page.goto("/");
  await page.getByRole("combobox", { name: "Search companies and contacts" }).fill(`E2E Prospect ${stamp}`);
  await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
});

test("read-only users cannot reach write pages or admin settings", async ({ page }) => {
  await login(page, READONLY);
  await page.goto("/companies");
  await expect(page.getByRole("link", { name: "New company" })).toHaveCount(0);
  await page.goto("/companies/new");
  await expect(page).toHaveURL(/\/forbidden/);
  await page.goto("/settings/users");
  await expect(page).toHaveURL(/\/forbidden/);
  const res = await page.request.get("/api/export/companies");
  expect(res.status()).toBe(403);
});
