import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "Admin12345!";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("20i page shows the demo mirror, auto-linked packages, an expiring domain, and lets an admin link an unmatched package", async ({ page }) => {
  await login(page, "admin@example.com");
  await page.goto("/integrations/twentyi");
  await expect(page.getByText("Demo (not connected)").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /Packages and domains · \d+ of 15 linked/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify and connect" })).toBeVisible();
  // Auto-linked by domain to the seed company
  const dental = page.getByRole("row", { name: /harrowgatedental\.co\.uk/ }).first();
  await expect(dental.getByRole("link", { name: "Harrowgate Dental Practice" })).toBeVisible();
  await expect(dental.getByText("auto")).toBeVisible();
  // Unmatched package gets a manual link (undo a link left by an earlier run first)
  const beer = page.getByRole("row", { name: /yorkshirecraftbeer\.co\.uk/ }).filter({ has: page.getByText("package") }).first();
  if (await beer.getByRole("button", { name: "Unlink" }).count()) {
    await beer.getByRole("button", { name: "Unlink" }).click();
    await expect(beer.getByLabel("Company for yorkshirecraftbeer.co.uk")).toBeVisible();
  }
  await beer.getByLabel("Company for yorkshirecraftbeer.co.uk").selectOption({ label: "The Old Mill Hotel" });
  await beer.getByRole("button", { name: "Link" }).click();
  await expect(page.getByRole("row", { name: /yorkshirecraftbeer\.co\.uk/ }).first().getByRole("link", { name: "The Old Mill Hotel" })).toBeVisible();
  // Expiring filter shows the domain due in 12 days
  await page.getByRole("button", { name: "expiring", exact: true }).click();
  await expect(page.getByRole("row", { name: /northernfreight\.com/ }).first()).toBeVisible();
  await expect(page.getByRole("row", { name: /bramleyaccountants\.co\.uk/ }).first().getByText(/expired/)).toBeVisible();
});

test("company Hosting tab nests mailboxes under the package and a finance user can pick the contract line that bills it", async ({ page }) => {
  await login(page, "admin@example.com");
  await page.goto("/companies");
  await page.getByRole("link", { name: "Northern Freight Solutions Ltd" }).click();
  await page.getByRole("tab", { name: /Hosting/ }).click();
  await expect(page.getByText(/Hosting at 20i · 1 package/)).toBeVisible();
  await expect(page.getByRole("cell", { name: /info@northernfreight\.co\.uk/ })).toBeVisible();
  const row = page.getByRole("row", { name: /northernfreight\.co\.uk/ }).filter({ has: page.getByText("package") }).first();
  await row.getByLabel("Billed by contract line").selectOption({ index: 1 });
  await expect(row.getByLabel("Billed by contract line")).not.toHaveValue("");
  await page.reload();
  await page.getByRole("tab", { name: /Hosting/ }).click();
  await expect(page.getByRole("row", { name: /northernfreight\.co\.uk/ }).filter({ has: page.getByText("package") }).first().getByLabel("Billed by contract line")).not.toHaveValue("");
  await expect(page.getByText("Invoices mentioning this hosting")).toBeVisible();

  // Read-only user sees the tab but cannot change billing, and cannot manage the integration
  await page.context().clearCookies();
  await login(page, "readonly@example.com");
  await page.goto("/companies");
  await page.getByRole("link", { name: "Northern Freight Solutions Ltd" }).click();
  await page.getByRole("tab", { name: /Hosting/ }).click();
  await expect(page.getByLabel("Billed by contract line")).toHaveCount(0);
  await page.goto("/integrations/twentyi");
  await expect(page.getByRole("button", { name: "Verify and connect" })).toHaveCount(0);
});
