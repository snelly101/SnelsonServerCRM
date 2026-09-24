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

test("Pax8 page shows the demo mirror, auto-linked companies, a name suggestion an admin can link, and open licence discrepancies", async ({
  page,
}) => {
  await login(page, "admin@example.com");
  await page.goto("/integrations/pax8");
  await expect(page.getByText("Demo (not connected)").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Pax8 companies · \d+ of 7 linked/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Verify and connect" }),
  ).toBeVisible();
  // Auto-linked by domain to the seed company
  const freight = page
    .getByRole("row", { name: /Northern Freight Solutions/ })
    .first();
  await expect(
    freight.getByRole("link", { name: "Northern Freight Solutions Ltd" }),
  ).toBeVisible();
  await expect(freight.getByText("auto")).toBeVisible();
  // Similar-name suggestion gets a manual link (undo a link left by an earlier run first)
  const vets = page
    .getByRole("row", { name: /Calder Valley Veterinary Group/ })
    .first();
  if (await vets.getByRole("button", { name: "Unlink" }).count()) {
    await vets.getByRole("button", { name: "Unlink" }).click();
    await expect(
      vets.getByLabel("Company for Calder Valley Veterinary Group"),
    ).toBeVisible();
  }
  await expect(vets.getByText("similar name")).toBeVisible();
  await vets.getByRole("button", { name: "Link" }).first().click();
  await expect(
    page
      .getByRole("row", { name: /Calder Valley Veterinary Group/ })
      .first()
      .getByRole("link", { name: "Calder Valley Vets" }),
  ).toBeVisible();
  // Licence discrepancies from the seed contracts
  const disc = page
    .getByRole("heading", { name: /Open licence discrepancies/ })
    .locator("..")
    .locator("..");
  await expect(
    disc
      .getByRole("row", { name: /Northern Freight Solutions Ltd/ })
      .first()
      .getByText("+2"),
  ).toBeVisible();
  await expect(
    disc
      .getByRole("row", { name: /Ridgeway Architects LLP/ })
      .first()
      .getByText("-2"),
  ).toBeVisible();
});

test("company Subscriptions tab shows licences, the matched line, an unbilled subscription that an admin links by hand, then copies the Pax8 cost onto the line", async ({
  page,
}) => {
  await login(page, "admin@example.com");
  await page.goto("/companies");
  await page.getByRole("link", { name: "Harrowgate Dental Practice" }).click();
  await openSection(page, /Subscriptions/);
  await expect(
    page.getByText(/Subscriptions at Pax8 · 2 active, 28 licences/),
  ).toBeVisible();
  const standard = page
    .getByRole("row", { name: /Microsoft 365 Business Standard/ })
    .first();
  await expect(standard.getByText("matched by product name")).toBeVisible();
  const acronis = page
    .getByRole("row", { name: /Acronis Cyber Protect Cloud/ })
    .first();
  const select = acronis.getByLabel("Billed by contract line");
  if ((await select.inputValue()) !== "") await select.selectOption("");
  await expect(
    page.getByText(/1 active subscription is not billed/),
  ).toBeVisible();
  const backupValue = await select
    .locator("option", { hasText: "Microsoft 365 backup" })
    .first()
    .getAttribute("value");
  await select.selectOption(backupValue!);
  await expect(select).not.toHaveValue("");
  await page.reload();
  await openSection(page, /Subscriptions/);
  const acronisAfter = page
    .getByRole("row", { name: /Acronis Cyber Protect Cloud/ })
    .first();
  await expect(
    acronisAfter.getByLabel("Billed by contract line"),
  ).not.toHaveValue("");
  await expect(page.getByText(/not billed by any contract line/)).toHaveCount(
    0,
  );
  // Contract cost 1.60 vs Pax8 1.55 → "differs" and the cost can be applied (already applied on a repeat run)
  if (await acronisAfter.getByText("differs").count()) {
    await acronisAfter.getByRole("button", { name: "Use as cost" }).click();
    await expect(acronisAfter.getByText("cost now 1.55")).toBeVisible();
  }
  await expect(
    page
      .getByRole("row", { name: /Acronis Cyber Protect Cloud/ })
      .first()
      .getByText("differs"),
  ).toHaveCount(0);
  await expect(
    page.getByText("What Pax8 charged for this customer"),
  ).toBeVisible();

  // Northern Freight shows the +2 licence discrepancy on its tab
  await page.goto("/companies");
  await page
    .getByRole("link", { name: "Northern Freight Solutions Ltd" })
    .click();
  await openSection(page, /Subscriptions/);
  await expect(page.getByText("Contract vs licences at Pax8")).toBeVisible();
  await expect(
    page
      .getByRole("row", { name: /Microsoft 365 Business Premium/ })
      .filter({ hasText: "+2" })
      .first(),
  ).toBeVisible();

  // Read-only user sees the tab but no controls, and cannot manage the integration
  await page.context().clearCookies();
  await login(page, "readonly@example.com");
  await page.goto("/companies");
  await page.getByRole("link", { name: "Harrowgate Dental Practice" }).click();
  await openSection(page, /Subscriptions/);
  await expect(page.getByText(/Subscriptions at Pax8/)).toBeVisible();
  await expect(page.getByLabel("Billed by contract line")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use as cost" })).toHaveCount(
    0,
  );
  await page.goto("/integrations/pax8");
  await expect(
    page.getByRole("button", { name: "Verify and connect" }),
  ).toHaveCount(0);
});
