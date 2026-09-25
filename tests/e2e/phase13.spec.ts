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

/** Creates a ticket through the form and returns its reference. */
async function createTicket(
  page: Page,
  subject: string,
  opts: {
    company: string;
    contact: string;
    description?: string;
    priority?: string;
  },
) {
  await page.goto("/helpdesk/tickets/new");
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Company").selectOption({ label: opts.company });
  await page
    .getByLabel("Requester (contact)")
    .selectOption({ label: opts.contact });
  if (opts.priority)
    await page.getByLabel("Priority").selectOption(opts.priority);
  await page
    .getByLabel("Category", { exact: true })
    .selectOption({ label: "Hardware" });
  await page.getByLabel("Subcategory").selectOption({ label: "Laptop" });
  await page
    .getByLabel("Description")
    .fill(opts.description ?? "Details of the problem.");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page).toHaveURL(/\/helpdesk\/tickets\/[0-9a-f-]+$/);
  return (await page.locator("h1 span.font-mono").textContent())!.trim();
}

test("technician sees the helpdesk dashboard and queues, creates a ticket, adds a note and a logged message, changes status, logs time; queue filters and views work", async ({
  page,
}) => {
  await login(page, "tech@example.com");
  await page.getByRole("link", { name: "Helpdesk" }).click();
  await expect(page).toHaveURL(/\/helpdesk$/);
  await expect(
    page.getByRole("heading", { name: "Helpdesk", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "My tickets" })).toBeVisible();
  await expect(
    page.getByText("Unassigned", { exact: true }).first(),
  ).toBeVisible();

  // Create a ticket (unassigned) and check it shows in the right queues
  const subject = `Keyboard not working ${Date.now()}`;
  const ref = await createTicket(page, subject, {
    company: "Ridgeway Architects LLP",
    contact: "Chloe Wang",
    priority: "high",
    description: "Keys **q** and **w** dead since coffee.",
  });
  await expect(
    page.getByRole("heading", {
      name: new RegExp(
        `${ref}\\s+${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    }),
  ).toBeVisible();
  await expect(page.locator("strong", { hasText: "q" }).first()).toBeVisible();
  await expect(page.getByText("Chloe Wang").first()).toBeVisible();

  await page.goto("/helpdesk/tickets");
  await page.getByRole("tab", { name: /Unassigned/ }).click();
  await expect(page.getByRole("row", { name: new RegExp(ref) })).toBeVisible();
  await page.getByRole("tab", { name: /Awaiting customer/ }).click();
  await expect(
    page.getByRole("row", { name: /VPN drops every 20 minutes/ }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(ref) })).toHaveCount(0);
  await page.getByRole("tab", { name: /All open/ }).click();
  await page.getByPlaceholder(/Search subject/).fill("phishing");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("No tickets match.")).toBeVisible(); // resolved tickets are not in "open"
  await page.getByRole("tab", { name: /Resolved/ }).click();
  await expect(
    page.getByRole("row", { name: /Suspicious email claiming/ }),
  ).toBeVisible();
  // Filter by priority and search by reference
  await page.goto(`/helpdesk/tickets?view=all&q=${ref}`);
  await expect(page.getByRole("row", { name: new RegExp(ref) })).toBeVisible();
  await expect(page.getByRole("row", { name: /VPN drops/ })).toHaveCount(0);
  // Technicians cannot bulk-edit
  await expect(page.getByLabel("Select all on this page")).toHaveCount(0);

  // Take it, add an internal note, then log a customer message that moves it to awaiting customer
  await page
    .getByRole("link", { name: new RegExp(subject.slice(0, 20)) })
    .first()
    .click();
  await page.getByRole("button", { name: "Take" }).click();
  await expect(page.getByRole("button", { name: "Release" })).toBeVisible();
  await page.getByRole("button", { name: "Internal note" }).click();
  await page.getByLabel("Note").fill("Spare keyboard in the van.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText("Spare keyboard in the van.")).toBeVisible();
  await expect(page.getByText("internal note").first()).toBeVisible();
  // In demo mode the mailbox is enabled, so the public reply goes out by e-mail (to the demo mailbox)
  await page.getByRole("button", { name: "Reply to customer" }).click();
  await page
    .getByLabel("Message")
    .fill("Called Chloe, bringing a keyboard tomorrow.");
  await page
    .getByLabel("Status after sending")
    .selectOption("awaiting_customer");
  await page.getByRole("button", { name: "Send e-mail" }).click();
  await expect(
    page.getByText("Called Chloe, bringing a keyboard tomorrow."),
  ).toBeVisible();
  await expect(
    page.locator("aside").getByText("Awaiting customer").first(),
  ).toBeVisible();

  // Resolve needs a summary
  await page.getByRole("button", { name: "Change" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Status", { exact: true })
    .selectOption("resolved");
  await page
    .getByRole("dialog")
    .getByLabel("Resolution summary")
    .fill("Keyboard replaced.");
  await page.getByRole("button", { name: "Update status" }).click();
  // Scope to the side panel: the dialog's textarea holds the same text until it closes.
  await expect(
    page.getByLabel("Ticket details").getByText("Keyboard replaced."),
  ).toBeVisible();
  await expect(
    page.locator("aside").getByText("Resolved").first(),
  ).toBeVisible();

  // Time
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await page.getByLabel("Minutes").fill("30");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Time · 30m/ })).toBeVisible();

  // Company page shows the ticket
  await page.goto("/companies");
  await page.getByRole("link", { name: "Ridgeway Architects LLP" }).click();
  await openSection(page, /Tickets/);
  await expect(page.getByRole("row", { name: new RegExp(ref) })).toBeVisible();
});

test("account manager bulk-assigns, merges with a preview and the merged reference stays reachable; read-only user sees tickets without controls", async ({
  page,
}) => {
  await login(page, "am@example.com");
  const stamp = Date.now();
  const sourceRef = await createTicket(page, `Merge source ${stamp}`, {
    company: "Bramley & Sons Accountants",
    contact: "Helen Bramley",
    description: "First report.",
  });
  const targetRef = await createTicket(page, `Merge target ${stamp}`, {
    company: "Harrowgate Dental Practice",
    contact: "Priya Sharma",
    description: "Original report.",
  });

  // Bulk assign both new tickets
  await page.goto(`/helpdesk/tickets?view=all&q=${stamp}`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Select all on this page").check();
  await page.getByLabel("Bulk action").selectOption("assign");
  await page.getByLabel("Bulk value").selectOption({ label: "Amira Manager" });
  await page.getByRole("button", { name: /Apply to 2/ }).click();
  await expect(page.getByText("2 updated")).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(sourceRef) }),
  ).toContainText("Amira Manager");

  // Merge source into target with a preview
  await page.getByRole("link", { name: `Merge source ${stamp}` }).click();
  await page.getByRole("button", { name: "Merge" }).click();
  await page.getByLabel("Merge into (reference)").fill(targetRef);
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText(`Surviving ticket: ${targetRef}`)).toBeVisible();
  await expect(page.getByText("different requester")).toBeVisible();
  await page.getByRole("button", { name: `Merge into ${targetRef}` }).click();
  await expect(
    page.getByRole("heading", { name: new RegExp(targetRef) }),
  ).toBeVisible();
  await expect(
    page.getByText(`${sourceRef} merged into this ticket`),
  ).toBeVisible();
  await expect(page.getByText("First report.")).toBeVisible();
  // The merged ticket leaves the queues; its own page explains where it went
  await page.goto(`/helpdesk/tickets?view=all&q=${sourceRef}`);
  await expect(page.getByText("No tickets match.")).toBeVisible();
  await page.goto(`/helpdesk/tickets?view=all&q=${targetRef}`);
  await page.getByRole("link", { name: `Merge target ${stamp}` }).click();
  await page.getByRole("link", { name: sourceRef }).first().click();
  await expect(page.getByText("This ticket was merged")).toBeVisible();

  await page.context().clearCookies();
  await login(page, "readonly@example.com");
  await page.goto("/helpdesk/tickets");
  await expect(
    page.getByRole("row", { name: /VPN drops every 20 minutes/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "New ticket" })).toHaveCount(0);
  await page.getByRole("link", { name: /VPN drops every 20 minutes/ }).click();
  await expect(page.getByRole("button", { name: "Take" })).toHaveCount(0);
  await expect(page.getByLabel("Note")).toHaveCount(0);
  await page.goto("/settings/helpdesk");
  await expect(page).toHaveURL(/forbidden/);
});
