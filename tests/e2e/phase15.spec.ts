import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "Admin12345!";

async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("admin sees SLA policies, automation rules and templates; a technician creates a ticket with SLA deadlines, works a checklist, inserts a template and mentions a colleague who gets a notification; reports filter and export", async ({
  page,
}) => {
  await login(page, "admin@example.com");
  await page.goto("/settings/helpdesk/sla");
  await expect(page.getByRole("heading", { name: "SLA policies and business hours" })).toBeVisible();
  await expect(page.getByText("Standard support", { exact: true })).toBeVisible();
  await expect(page.getByText("UK office hours", { exact: true }).first()).toBeVisible();
  await page.goto("/settings/helpdesk/automation");
  await expect(page.getByText("Route new e-mail tickets to the service desk")).toBeVisible();
  await page.getByRole("button", { name: "New rule" }).click();
  const stamp = Date.now();
  await page.locator("#rule-name").fill(`E2E tag rule ${stamp}`);
  await page.locator("#rule-trigger").selectOption("ticket_created");
  await page.getByRole("button", { name: "Add condition" }).click();
  await page.getByLabel("Condition field").selectOption("subject");
  await page.getByLabel("Condition operator").selectOption("contains");
  await page.getByLabel("Condition value").fill(`e2e-${stamp}`);
  await page.getByLabel("Action").first().selectOption("add_tag");
  await page.getByLabel("Action value").fill("e2e-auto");
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText(`E2E tag rule ${stamp}`)).toBeVisible();
  await page.goto("/settings/helpdesk/templates");
  await expect(page.getByText("Need more information")).toBeVisible();

  // Technician creates a ticket: the rule tags it and the SLA panel shows the customer's policy.
  await login(page, "tech@example.com");
  await page.goto("/helpdesk/tickets/new");
  await page.getByLabel("Subject").fill(`Printer jam e2e-${stamp}`);
  await page.getByLabel("Company").selectOption({ label: "Harrowgate Dental Practice" });
  await page.getByLabel("Requester (contact)").selectOption({ index: 1 });
  await page.getByLabel("Priority").selectOption("high");
  await page.getByLabel("Category", { exact: true }).selectOption({ label: "Hardware" });
  await page.getByLabel("Description").fill("Paper jam every third page.");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page).toHaveURL(/\/helpdesk\/tickets\/[0-9a-f-]+$/);
  const sla = page.getByLabel("SLA");
  await expect(sla.getByText("Priority 24×7")).toBeVisible();
  await expect(sla.getByText("First response", { exact: true })).toBeVisible();
  await expect(sla.getByText(/due in/).first()).toBeVisible();
  await expect(page.getByText("e2e-auto", { exact: true })).toBeVisible();

  // Checklist
  await page.getByLabel("Checklist").getByRole("button", { name: "Add" }).click();
  await page.getByLabel("Items (one per line)").fill("Clear rollers\nOrder new fuser");
  await page.getByRole("button", { name: "Add items" }).click();
  await expect(page.getByLabel("Checklist").getByText("Checklist 0/2")).toBeVisible();
  await page.getByRole("checkbox", { name: "Clear rollers" }).check();
  await expect(page.getByLabel("Checklist").getByText("Checklist 1/2")).toBeVisible();

  // Template insertion into a note, with an @mention
  await page.getByRole("button", { name: "Internal note" }).click();
  await page.getByLabel("Insert template").selectOption({ label: "Accounts: Leaver checklist" });
  await expect(page.getByLabel("Note")).toHaveValue(/Leaver process for Harrowgate Dental Practice/);
  await page.getByLabel("Note").fill(`@Amira can you approve the fuser order? e2e-${stamp}`);
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText(`can you approve the fuser order? e2e-${stamp}`)).toBeVisible();

  // Amira gets the mention
  await login(page, "am@example.com");
  await expect(page.getByTestId("notification-count")).toBeVisible();
  await page.getByRole("link", { name: /Notifications/ }).first().click();
  await expect(page).toHaveURL(/\/helpdesk\/notifications$/);
  await expect(page.getByRole("link", { name: new RegExp(`You were mentioned on IT-\\d+: Printer jam e2e-${stamp}`) })).toBeVisible();
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByText("Nothing unread")).toBeVisible();

  // Reports with filters and CSV export (account manager has helpdesk.manage)
  await page.goto("/helpdesk/reports");
  await expect(page.getByRole("heading", { name: "Helpdesk reports" })).toBeVisible();
  await page.getByLabel("Customer").selectOption({ label: "Harrowgate Dental Practice" });
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/companyId=/);
  await expect(page.getByText("First response SLA", { exact: true })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "sla", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^helpdesk-sla-.*\.csv$/);
});
