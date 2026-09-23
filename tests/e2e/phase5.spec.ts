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

test("devices page shows demo NinjaOne devices, totals and open discrepancies; account manager can accept one", async ({ page }) => {
  await login(page, "am@example.com");
  await page.goto("/devices");
  await expect(page.getByText("Demo data").first()).toBeVisible();
  await expect(page.getByText("Total devices")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Device count discrepancies/ })).toBeVisible();
  // Accept the first open item (the seed opens several: Harrowgate +1, Northern Freight -2, Greenfield +7, Bramley -1)
  const openRows = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Accept" }) });
  const openBefore = await openRows.count();
  expect(openBefore).toBeGreaterThan(0);
  const row = openRows.first();
  const company = (await row.getByRole("link").first().textContent())?.trim() ?? "";
  await expect(row.getByRole("cell").filter({ hasText: /^[+-]\d+/ })).toBeVisible();
  await row.getByLabel("Review note").fill("Contract amendment in progress");
  await row.getByRole("button", { name: "Accept" }).click();
  await expect(openRows).toHaveCount(openBefore - 1);
  await page.goto("/devices?disc=accepted");
  await expect(page.getByRole("row", { name: new RegExp(company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first()).toContainText("accepted");

  // Device list filters by company and shows freshness
  await page.goto("/devices?status=online");
  await expect(page.getByRole("cell", { name: /HDP-SRV1|NFS-SRV1|RA-1|GPA-1|BRM-1/ }).first()).toBeVisible();
  await expect(page.getByText("cached").or(page.getByText("live")).first()).toBeVisible();
});

test("company page has a Devices tab with counts, and the contract shows observed vs contracted", async ({ page }) => {
  await login(page, "admin@example.com");
  await page.goto("/companies");
  await page.getByRole("link", { name: "Northern Freight Solutions Ltd" }).click();
  await openSection(page, /Devices/);
  await expect(page.getByText(/Devices · Northern Freight Solutions/)).toBeVisible();
  await expect(page.getByText("Billable class")).toBeVisible();
  await expect(page.getByRole("cell", { name: /NFS-BR-1/ }).first()).toBeVisible();

  await page.goto("/contracts");
  await page.getByRole("link", { name: "Managed IT & Security Agreement" }).click();
  await expect(page.getByText("Device count check")).toBeVisible();
  await expect(page.getByRole("cell", { name: "38" }).first()).toBeVisible();
});

test("integration page: NinjaOne is demo (not connected), mapping shows linked orgs, technician cannot manage", async ({ page }) => {
  await login(page, "admin@example.com");
  await page.goto("/integrations/ninjaone");
  await expect(page.getByText("Demo (not connected)").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /Organisation mapping · 5 of 6 linked/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify and connect" })).toBeVisible();
  await expect(page.getByText("Internal - Snelson Server")).toBeVisible();

  await page.context().clearCookies();
  await login(page, "tech@example.com");
  await page.goto("/integrations/ninjaone");
  await expect(page.getByRole("button", { name: "Verify and connect" })).toHaveCount(0);
  await page.goto("/devices");
  await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
});
