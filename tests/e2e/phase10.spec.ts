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

test("account manager adds a formatted, pinned note; it renders on the Notes section and Overview; edit, unpin and archive work; read-only sees it without controls", async ({ page }) => {
  await login(page, "am@example.com");
  await page.goto("/companies");
  await page.getByRole("link", { name: "Ridgeway Architects LLP" }).click();
  await openSection(page, "Notes");
  const title = `Site access ${Date.now()}`;
  await page.getByRole("button", { name: "Add note" }).first().click();
  await page.getByLabel("Title").fill(title);
  const body = page.locator("#note-body");
  // Toolbar: heading prefixes the current line; bold and link wrap or insert at the cursor
  await body.fill("Ring the bell and ask for Sam.");
  await page.getByRole("button", { name: "Heading" }).click();
  await expect(body).toHaveValue("## Ring the bell and ask for Sam.");
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(body).toHaveValue(/\*\*text\*\*/);
  await page.getByRole("button", { name: "Link" }).click();
  await expect(body).toHaveValue(/\[link text\]\(https:\/\/\)/);
  await page.getByRole("button", { name: "Bullet list" }).click();
  await expect(body).toHaveValue(/^- /);
  // Final content, including a raw script tag that must stay plain text
  await body.fill("## Ring the bell and ask for Sam.\n- Key safe 4321\nAlarm code is **secret**\nPortal: [portal](https://portal.example.com)\n<script>alert(1)</script>");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "portal" })).toHaveAttribute("href", "https://portal.example.com");
  await expect(page.getByRole("dialog").getByText("<script>alert(1)</script>")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Pin to Overview").check();
  await page.getByRole("button", { name: "Add note", exact: true }).last().click();

  const card = page.locator("li", { hasText: title }).first();
  await expect(card.getByText("pinned")).toBeVisible();
  await expect(card.getByRole("heading", { name: "Ring the bell and ask for Sam." })).toBeVisible();
  await expect(card.getByRole("listitem").filter({ hasText: "Key safe 4321" })).toBeVisible();
  await expect(card.locator("strong", { hasText: "secret" })).toBeVisible();
  await expect(card.getByText(/Edited .* by Amira Manager/)).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain("<script>alert(1)</script>");

  // Pinned note shows on Overview
  await openSection(page, "Overview");
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("Key safe 4321")).toBeVisible();

  // Edit, unpin, archive
  await openSection(page, "Notes");
  await card.getByRole("button", { name: `Edit ${title}` }).click();
  await page.getByLabel("Title").fill(`${title} (updated)`);
  await page.getByRole("button", { name: "Save note" }).click();
  const updated = page.locator("li", { hasText: `${title} (updated)` }).first();
  await expect(updated).toBeVisible();
  await updated.getByRole("button", { name: `Unpin ${title} (updated)` }).click();
  await expect(updated.getByText("pinned")).toHaveCount(0);
  await updated.getByRole("button", { name: `Archive ${title} (updated)` }).click();
  await expect(page.locator("li", { hasText: `${title} (updated)` })).toHaveCount(0);
  await page.getByRole("link", { name: /Show archived/ }).click();
  await expect(page.locator("li", { hasText: `${title} (updated)` }).first().getByText("archived")).toBeVisible();
  await page.locator("li", { hasText: `${title} (updated)` }).first().getByRole("button", { name: /Restore/ }).click();
  await expect(page.locator("li", { hasText: `${title} (updated)` }).first().getByText("archived")).toHaveCount(0);

  // Read-only user: can read, cannot edit
  await page.context().clearCookies();
  await login(page, "readonly@example.com");
  await page.goto("/companies");
  await page.getByRole("link", { name: "Ridgeway Architects LLP" }).click();
  await openSection(page, "Notes");
  await expect(page.getByText(`${title} (updated)`).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add note" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
});
