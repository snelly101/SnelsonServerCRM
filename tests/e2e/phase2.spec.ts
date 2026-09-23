import { test, expect, type Page } from "@playwright/test";
import { openSection } from "./helpers";

const ADMIN = { email: "admin@example.com", password: "Admin12345!" };

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("create an opportunity with line items, mark it won, and get onboarding + draft contract once", async ({ page }) => {
  await login(page);
  const stamp = Date.now();

  // Create a prospect first
  await page.goto("/companies/new");
  await page.getByLabel("Company name").fill(`Won Co ${stamp}`);
  await page.getByLabel("Website").fill(`wonco-${stamp}.example`);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
  const companyUrl = page.url();

  // New opportunity from the company page
  await openSection(page, /Opportunities/);
  await page.getByRole("link", { name: "New opportunity" }).click();
  await expect(page).toHaveURL(/\/pipeline\/new\?companyId=/);
  await page.getByLabel("Title").fill(`Managed IT ${stamp}`);
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Description").first().fill("Managed IT per user");
  await page.getByLabel("Quantity").first().fill("10");
  await page.getByLabel("Unit price").first().fill("45");
  await page.getByLabel("Unit cost").first().fill("18");
  await expect(page.getByText("MRR £450.00")).toBeVisible();
  await page.getByRole("button", { name: "Create opportunity" }).click();
  await expect(page).toHaveURL(/\/pipeline\/[0-9a-f-]{36}$/);
  await expect(page.getByText("First year £5,400.00")).toBeVisible();

  // Board shows it
  await page.goto("/pipeline");
  await expect(page.getByRole("link", { name: `Managed IT ${stamp}` })).toBeVisible();
  await page.getByRole("link", { name: `Managed IT ${stamp}` }).click();

  // Mark won with onboarding + contract
  await page.getByRole("button", { name: "Mark won" }).click();
  await page.getByRole("button", { name: "Confirm won" }).click();
  await expect(page.getByText(/Won on/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Onboarding: Managed IT/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Contract: Managed IT/ })).toBeVisible();

  // Company is now a customer, and onboarding checklist has tasks
  await page.goto(companyUrl);
  await expect(page.getByRole("banner").or(page.locator("header")).first()).toContainText("customer");
  await openSection(page, /Tasks/);
  await expect(page.getByText("Welcome call and kick-off meeting")).toBeVisible();

  // Complete a checklist item from the onboarding page
  await page.getByRole("link", { name: /Onboarding: Managed IT/ }).click();
  await expect(page).toHaveURL(/\/tasks\/onboarding\//);
  await page.getByRole("button", { name: "Complete task" }).first().click();
  await expect(page.getByText(/1\/8 done/)).toBeVisible();
});

test("service catalogue and contracts pages render totals", async ({ page }) => {
  await login(page);
  await page.goto("/contracts/catalogue");
  await expect(page.getByText("Managed IT (per user)")).toBeVisible();
  await page.goto("/contracts");
  await expect(page.getByText("Σ recurring lines ÷ months per period")).toBeVisible();
  await expect(page.getByText("Managed IT Agreement").first()).toBeVisible();
});
