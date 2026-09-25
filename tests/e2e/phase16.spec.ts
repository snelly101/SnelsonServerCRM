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

test("knowledge base: technician writes an article from a ticket, manager publishes it, it is suggested and inserted into a note, a device is linked; admin sees operations and anonymises a ticket", async ({
  page,
}) => {
  const stamp = Date.now();
  await login(page, "tech@example.com");
  await page.goto("/helpdesk/kb");
  await expect(page.getByRole("heading", { name: "Knowledge base" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Outlook keeps asking for a password" })).toBeVisible();

  // Create a ticket, then write an article from it.
  await page.goto("/helpdesk/tickets/new");
  await page.getByLabel("Subject").fill(`Scanner e2e-${stamp} not scanning to email`);
  await page.getByLabel("Company").selectOption({ label: "Greenfield Primary Academy" });
  await page.getByLabel("Requester (contact)").selectOption({ index: 1 });
  await page.getByLabel("Category", { exact: true }).selectOption({ label: "Hardware" });
  await page.getByLabel("Description").fill("Scan to e-mail fails with SMTP error.");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page).toHaveURL(/\/helpdesk\/tickets\/[0-9a-f-]+$/);
  const ticketUrl = page.url();
  await page.getByLabel("Knowledge").getByRole("link", { name: "Write article" }).click();
  await expect(page).toHaveURL(/\/helpdesk\/kb\/new\?ticket=/);
  await page.locator("#kb-title").fill(`Scanner e2e-${stamp} SMTP fix`);
  await page.locator("#kb-summary").fill("Scan to e-mail after the tenant moved to modern auth");
  await page.locator("#kb-body").fill("## Fix\n\nUse the SMTP relay connector and an app password.");
  await page.locator("#kb-tags").fill(`scanner, e2e-${stamp}`);
  await page.getByRole("button", { name: "Create article" }).click();
  await expect(page).toHaveURL(/\/helpdesk\/kb\/[^/]+$/);
  await expect(page.getByText("draft", { exact: true }).first()).toBeVisible();
  const articleUrl = page.url();

  // Technician cannot publish; manager can.
  await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(0);
  await login(page, "am@example.com");
  await page.goto(articleUrl);
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("published", { exact: true }).first()).toBeVisible();

  // Back on the ticket: linked as source, and the printer article appears among suggestions for a printer ticket.
  await page.goto(ticketUrl);
  const knowledge = page.getByLabel("Knowledge");
  await expect(knowledge.getByRole("link", { name: `Scanner e2e-${stamp} SMTP fix` })).toBeVisible();
  await expect(knowledge.getByText("from this ticket")).toBeVisible();

  // Insert the (internal) article into a note; it is not offered for customer replies.
  await page.getByRole("button", { name: "Internal note" }).click();
  await page.getByLabel("Insert article").selectOption({ label: `Scanner e2e-${stamp} SMTP fix` });
  await expect(page.getByLabel("Note")).toHaveValue(/SMTP relay connector/);
  await page.getByRole("button", { name: "Reply to customer" }).click();
  const options = await page.getByLabel("Insert article").locator("option").allTextContents();
  expect(options.some((o) => o.includes(`Scanner e2e-${stamp}`))).toBe(false);
  expect(options.some((o) => o.includes("Outlook keeps asking"))).toBe(true);

  // Link a device from the customer's RMM mirror.
  const devices = page.getByLabel("Devices");
  await devices.getByLabel("Link a device").selectOption({ index: 1 });
  await expect(devices.getByText(/online|offline/).first()).toBeVisible();
  await expect(devices.getByRole("button", { name: /Unlink/ })).toHaveCount(1);

  // Admin: operations page and anonymisation.
  await login(page, "admin@example.com");
  await page.goto("/settings/helpdesk/operations");
  await expect(page.getByRole("heading", { name: "Helpdesk operations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Retention policy" })).toBeVisible();
  await page.goto(ticketUrl);
  await page.getByRole("button", { name: "Anonymise" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Anonymise" }).click();
  await expect(page.getByText("Anonymised", { exact: true })).toBeVisible();
  await expect(page.getByText("Anonymised requester")).toBeVisible();
});
