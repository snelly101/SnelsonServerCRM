import { test, expect, type Page } from "@playwright/test";

const PASSWORD = "Admin12345!";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("reports page shows pipeline, MRR with its formula, renewals, tasks, invoices, devices and health; CSV export works", async ({ page }) => {
  await login(page, "finance@example.com");
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByText("Weighted pipeline")).toBeVisible();
  await expect(page.getByText("Open pipeline by stage")).toBeVisible();
  await page.getByRole("tab", { name: "Recurring revenue" }).click();
  await expect(page.getByText(/MRR = Σ over active contracts/)).toBeVisible();
  await expect(page.getByText("MRR by customer")).toBeVisible();
  await page.getByRole("tab", { name: "Renewals" }).click();
  await expect(page.getByText("Contracts renewing within 90 days")).toBeVisible();
  await page.getByRole("tab", { name: "Outstanding invoices" }).click();
  await expect(page.getByText("Outstanding by customer")).toBeVisible();
  await expect(page.getByText("Demo data: no Xero organisation is connected.")).toBeVisible();
  await page.getByRole("tab", { name: "Devices" }).click();
  await expect(page.getByText("Open count discrepancies")).toBeVisible();
  await page.getByRole("tab", { name: "Integration health" }).click();
  await expect(page.getByText("Background worker")).toBeVisible();
  await expect(page.getByText("Demo (not connected)")).toHaveCount(4);

  const res = await page.request.get("/api/export/report-mrr");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  const body = await res.text();
  expect(body.split(/\r?\n/)[0]).toContain("company,activeContracts,mrr");
  expect(body).toContain("Northern Freight Solutions Ltd");
});

test("sales user sees reports without the finance tab and cannot export the invoice report; health endpoint answers", async ({ page }) => {
  await login(page, "sales@example.com");
  await page.goto("/reports");
  await expect(page.getByRole("tab", { name: "Recurring revenue" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Outstanding invoices" })).toHaveCount(0);
  expect((await page.request.get("/api/export/report-outstanding-invoices")).status()).toBe(403);
  expect((await page.request.get("/api/export/report-pipeline")).status()).toBe(200);
  const health = await page.request.get("/api/health");
  expect([200, 503]).toContain(health.status());
  const json = await health.json();
  expect(json.database).toBe("ok");
  expect(["alive", "stale", "never"]).toContain(json.worker);
});
