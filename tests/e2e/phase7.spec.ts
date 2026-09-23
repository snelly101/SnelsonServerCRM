import { test, expect, type Page } from "@playwright/test";
import { openSection, sectionAvailable } from "./helpers";

const PASSWORD = "Admin12345!";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("admin adds a vault item, must confirm their password to reveal, secret never appears in the page until revealed, history records it", async ({ page }) => {
  await login(page, "admin@example.com");
  await page.goto("/companies");
  await page.getByRole("link", { name: "Harrowgate Dental Practice" }).click();
  await openSection(page, /Secure Vault/);
  await page.getByRole("button", { name: "Add item" }).click();
  const secret = "Vault-E2E-Secret-7731!";
  const name = `Practice firewall ${Date.now()}`;
  await page.locator("#v-name").fill(name);
  await page.locator("#v-cat").selectOption("firewall");
  await page.locator("#v-user").fill("fwadmin");
  await page.locator("#v-url").fill("https://10.0.0.1");
  await page.locator("#v-pw").fill(secret);
  await page.locator("#v-tags").fill("core");
  await page.getByRole("button", { name: "Add to vault" }).click();
  await expect(page.getByText(name).first()).toBeVisible();
  await expect(page.getByText("fwadmin").first()).toBeVisible();
  let html = await page.content();
  expect(html).not.toContain(secret);

  // Reveal → step-up dialog → wrong password refused → correct password → secret shown with countdown
  const row = page.locator("li", { hasText: name }).first();
  await row.getByRole("button", { name: "Reveal Password" }).click();
  // The password re-confirmation window (30 min) may still be open from an earlier run; handle both paths.
  const dialog = page.getByText("Confirm it's you");
  await expect(dialog.or(page.getByText(secret))).toBeVisible();
  if (await dialog.isVisible()) {
    await page.locator("#stepup-pw").fill("wrong-password");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Password not recognised.")).toBeVisible();
    await page.locator("#stepup-pw").fill(PASSWORD);
    await page.getByRole("button", { name: "Confirm" }).click();
  }
  await expect(page.getByText(secret)).toBeVisible();
  await row.getByRole("button", { name: "Hide Password" }).click();
  await expect(page.getByText(secret)).toHaveCount(0);
  html = await page.content();
  expect(html).not.toContain(secret);

  // History shows created, step-up failure/success and the reveal with a field name, never the value
  await row.getByRole("button", { name: "History" }).click();
  await expect(page.getByText(`History: ${name}`)).toBeVisible();
  await expect(page.getByRole("cell", { name: "revealed" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "created" })).toBeVisible();
  expect(await page.content()).not.toContain(secret);
});

test("technician without a grant has no vault tab; sales never does; admin audit page lists the reveal", async ({ page }) => {
  await login(page, "tech@example.com");
  await page.goto("/companies");
  await page.getByRole("link", { name: "Harrowgate Dental Practice" }).click();
  expect(await sectionAvailable(page, /Secure Vault/)).toBe(false);
  await page.context().clearCookies();
  await login(page, "sales@example.com");
  await page.goto("/settings/vault");
  await expect(page).toHaveURL(/forbidden|\/settings/);
  await expect(page.getByText("Access grants")).toHaveCount(0);
  await page.context().clearCookies();
  await login(page, "admin@example.com");
  await page.goto("/settings/vault");
  await expect(page.getByText(/Access grants/)).toBeVisible();
  await expect(page.getByText(/present · version 1/)).toBeVisible();
  await page.goto("/settings/vault/audit?action=revealed");
  await expect(page.getByRole("cell", { name: "revealed" }).first()).toBeVisible();
  await expect(page.getByText(/Practice firewall/).first()).toBeVisible();
});
