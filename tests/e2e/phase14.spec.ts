import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "Admin12345!";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("mailbox admin page (demo) shows state and queues and accepts a test e-mail; an agent replies by e-mail with a preview and composes a new e-mail from a contact", async ({
  page,
}) => {
  await login(page, "admin@example.com");
  await page.goto("/helpdesk/admin/mailbox");
  await expect(page.getByText("Demo (not connected)").first()).toBeVisible();
  await expect(page.getByText("support@example.com").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Verify and connect" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send test" }).click();
  await expect(page.getByText(/Outbox status: accepted/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Outbox" })).toBeVisible();
  await expect(
    page.getByText("test → admin@example.com").first(),
  ).toBeVisible();

  // Reply by e-mail from a ticket
  await page.goto("/helpdesk/tickets?view=all&q=VPN+drops");
  await page.getByRole("link", { name: /VPN drops every 20 minutes/ }).click();
  await page.getByRole("button", { name: "Reply to customer" }).click();
  await expect(page.locator("#composer-to")).toHaveValue(
    "dev.patel@northernfreight.co.uk",
  );
  await page
    .getByLabel("Message")
    .fill(
      "Thanks Dev, the **log** shows a DNS timeout; we have changed the profile.",
    );
  await page.getByRole("button", { name: "Preview" }).last().click();
  await expect(
    page.getByText("To: dev.patel@northernfreight.co.uk"),
  ).toBeVisible();
  await expect(
    page.locator("strong", { hasText: "log" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send e-mail" }).click();
  await expect(
    page.getByText("we have changed the profile").first(),
  ).toBeVisible();
  await expect(page.getByText("accepted").first()).toBeVisible();

  // Compose from a contact
  await page.goto("/contacts");
  await page.getByRole("link", { name: "Priya Sharma" }).first().click();
  await page.getByRole("link", { name: "E-mail", exact: true }).click();
  await expect(page).toHaveURL(/\/helpdesk\/compose/);
  await expect(page.locator("#cp-to")).toHaveValue(
    "priya.sharma@harrowgatedental.co.uk",
  );
  const subject = `Maintenance window ${Date.now()}`;
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Message").fill("We will restart the server at 7pm.");
  await page.getByRole("button", { name: "Send and open ticket" }).click();
  await expect(page).toHaveURL(/\/helpdesk\/tickets\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: new RegExp(subject.slice(0, 18)) }),
  ).toBeVisible();
  await expect(
    page.getByText("We will restart the server at 7pm."),
  ).toBeVisible();
  await expect(page.getByText("Priya Sharma").first()).toBeVisible();
});
