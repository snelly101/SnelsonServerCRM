import { test, expect, type Page } from "@playwright/test";
import { openSection } from "./helpers";

const PASSWORD = "Admin12345!";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("finance user sees Xero (demo) invoices, prepares a draft from a contract, approves it once", async ({ page }) => {
  await login(page, "finance@example.com");
  await page.goto("/finance");
  await expect(page.getByText("Demo data")).toBeVisible();
  await expect(page.getByText("Outstanding (authorised)")).toBeVisible();
  await expect(page.getByRole("cell", { name: /INV-01/ }).first()).toBeVisible();

  // Prepare from an active contract (Northern Freight is linked to a demo Xero contact by the seed)
  await page.goto("/contracts");
  await page.getByRole("link", { name: "Managed IT & Security Agreement" }).click();
  await page.getByRole("button", { name: "Prepare invoice" }).click();
  await page.getByRole("button", { name: "Prepare draft" }).click();
  await expect(page).toHaveURL(/\/finance\/drafts\//);
  await expect(page.getByText(/Draft invoice CRM-/)).toBeVisible();
  await page.getByRole("button", { name: "Approve and create in Xero" }).click();
  await expect(page.getByText("Draft invoice created in Xero.")).toBeVisible();
  await expect(page.getByText("Created in Xero as a DRAFT")).toBeVisible();
});

test("sales user cannot see Finance or approve, and the company page hides financial data", async ({ page }) => {
  await login(page, "sales@example.com");
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/forbidden/);
  await page.goto("/companies");
  await page.getByRole("link", { name: "Northern Freight Solutions Ltd" }).click();
  await openSection(page, /Invoices/);
  await expect(page.getByText("Finance data is restricted")).toBeVisible();
});

test("Xero integration page shows demo status and the customer mapping with suggestions", async ({ page }) => {
  await login(page, "admin@example.com");
  await page.goto("/integrations/xero");
  await expect(page.getByText("Demo (not connected)").first()).toBeVisible();
  await expect(page.getByText(/Customer mapping/)).toBeVisible();
  await expect(page.getByText("Field ownership")).toBeVisible();
  await page.getByRole("button", { name: "unlinked" }).click();
  await expect(page.getByText("not linked").first()).toBeVisible();
});
