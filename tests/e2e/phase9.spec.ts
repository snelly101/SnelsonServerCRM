import { test, expect, type Page } from "@playwright/test";
import { totp } from "../../src/lib/totp";

const PASSWORD = "Admin12345!";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Puts the technician back to password-only sign-in and clears any policy, so each run starts clean. */
async function resetTechnician(page: Page) {
  await login(page, "admin@example.com");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/settings/users");
  const row = page.getByRole("row", { name: /Terry Tech/ });
  if (await row.getByRole("button", { name: "Reset 2FA" }).count()) {
    await row.getByRole("button", { name: "Reset 2FA" }).click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(row.getByText("off", { exact: true })).toBeVisible();
  }
  await page.goto("/settings/security");
  await page.getByLabel("Technician").uncheck();
  await page.getByLabel("Grace period ends").fill("");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.context().clearCookies();
}

test("technician enrols an authenticator app, is asked for a code at sign-in, can use a recovery code and trust the browser; admin resets it", async ({ page }) => {
  await resetTechnician(page);
  await login(page, "tech@example.com");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/account/security");

  // Enrol
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  await page.getByLabel("Confirm your CRM password").fill("wrong-password");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Password not recognised.")).toBeVisible();
  await page.getByLabel("Confirm your CRM password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByAltText("QR code for your authenticator app")).toBeVisible();
  const secret = (await page.getByTestId("totp-secret").textContent())!.replace(/\s+/g, "");
  expect(secret.length).toBeGreaterThan(15);
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Verify and turn on" }).click();
  await expect(page.getByText(/That code is not valid/)).toBeVisible();
  await page.getByLabel("Authenticator code").fill(totp(secret).code);
  await page.getByRole("button", { name: "Verify and turn on" }).click();
  await expect(page.getByText("Save your recovery codes")).toBeVisible();
  const codes = (await page.getByTestId("backup-codes").locator("li").allTextContents()).map((c) => c.trim());
  expect(codes).toHaveLength(10);
  await page.getByRole("button", { name: "I have saved them" }).click();
  await expect(page.getByText("on", { exact: true })).toBeVisible();

  // Sign in now needs a code
  await signOut(page);
  await login(page, "tech@example.com");
  await expect(page).toHaveURL(/\/login\/verify/);
  await page.getByLabel("Authenticator code").fill("111111");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/That code is not valid/)).toBeVisible();
  await page.getByLabel("Authenticator code").fill(totp(secret).code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Terry Tech").first()).toBeVisible();

  // Recovery code works once, and trusting the browser skips the prompt next time
  await signOut(page);
  await login(page, "tech@example.com");
  await expect(page).toHaveURL(/\/login\/verify/);
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await page.getByLabel("Recovery code").fill(codes[0]);
  await page.getByLabel("Trust this browser for 30 days").check();
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/$/);
  await signOut(page);
  await login(page, "tech@example.com");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/account/security");
  await page.getByRole("button", { name: "Forget trusted browsers" }).click();
  await expect(page.getByText(/Forgot 1 trusted browser/)).toBeVisible();
  await signOut(page);
  await login(page, "tech@example.com");
  await expect(page).toHaveURL(/\/login\/verify/);
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await page.getByLabel("Recovery code").fill(codes[0]);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/not valid/)).toBeVisible();

  // Admin sees it on, resets it, and the technician signs in with a password alone again
  await page.context().clearCookies();
  await login(page, "admin@example.com");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/settings/users");
  const row = page.getByRole("row", { name: /Terry Tech/ });
  await expect(row.getByText("on", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Reset 2FA" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(row.getByText("off", { exact: true })).toBeVisible();
  await page.context().clearCookies();
  await login(page, "tech@example.com");
  await expect(page).toHaveURL(/\/$/);
});

test("policy: requiring 2FA for technicians sends an un-enrolled technician to the security page; admin sees the enrolment table; clearing the policy restores access", async ({ page }) => {
  await resetTechnician(page);
  await login(page, "admin@example.com");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/settings/security");
  await page.getByLabel("Technician").check();
  await page.getByLabel("Grace period ends").fill("");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Terry Tech/ }).getByText("required, not set up")).toBeVisible();

  await page.context().clearCookies();
  await login(page, "tech@example.com");
  await expect(page).toHaveURL(/\/account\/security\?required=1/);
  await expect(page.getByText("Two-factor authentication is required for your role")).toBeVisible();
  await page.goto("/companies");
  await expect(page).toHaveURL(/\/account\/security/);

  // A grace period turns the block into a banner
  await page.context().clearCookies();
  await login(page, "admin@example.com");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/settings/security");
  await page.getByLabel("Grace period ends").fill("2099-12-31");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Grace period ends")).toBeVisible();
  await page.context().clearCookies();
  await login(page, "tech@example.com");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(/Two-factor authentication is required for your role from 2099-12-31/)).toBeVisible();

  // Clean up
  await page.context().clearCookies();
  await login(page, "admin@example.com");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/settings/security");
  await page.getByLabel("Technician").uncheck();
  await page.getByLabel("Grace period ends").fill("");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Grace period ends")).toBeVisible();
});
