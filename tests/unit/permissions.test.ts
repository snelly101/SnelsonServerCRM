import { describe, expect, it } from "vitest";
import { ACTIONS, ROLES, assertCan, can, ForbiddenError } from "@/lib/permissions";

describe("permissions", () => {
  it("admin can do everything", () => {
    for (const a of ACTIONS) expect(can("admin", a)).toBe(true);
  });

  it("read-only users cannot write anything", () => {
    const writes = ACTIONS.filter((a) => /\.(write|delete|import|create|prepare|approve|manage|sync|review)$/.test(a));
    expect(writes.length).toBeGreaterThan(5);
    for (const a of writes) expect(can("read_only", a)).toBe(false);
  });

  it("only finance and admin can see finance data or approve invoices", () => {
    for (const r of ROLES) {
      const allowed = r === "admin" || r === "finance";
      expect(can(r, "finance.read")).toBe(allowed);
      expect(can(r, "invoice.approve")).toBe(allowed);
      expect(can(r, "report.finance.read")).toBe(allowed);
    }
  });

  it("only admin can manage integrations, users and settings", () => {
    for (const r of ROLES) {
      const allowed = r === "admin";
      expect(can(r, "integration.manage")).toBe(allowed);
      expect(can(r, "user.manage")).toBe(allowed);
      expect(can(r, "settings.write")).toBe(allowed);
      expect(can(r, "audit.read")).toBe(allowed);
    }
  });

  it("sales can create companies but not approve invoices", () => {
    expect(can("sales", "company.write")).toBe(true);
    expect(can("sales", "invoice.approve")).toBe(false);
    expect(can("sales", "invoice.prepare")).toBe(false);
  });

  it("technicians can read devices and write tasks only", () => {
    expect(can("technician", "device.read")).toBe(true);
    expect(can("technician", "task.write")).toBe(true);
    expect(can("technician", "company.write")).toBe(false);
    expect(can("technician", "opportunity.write")).toBe(false);
  });

  it("assertCan throws a ForbiddenError with the action name", () => {
    expect(() => assertCan("read_only", "company.write")).toThrow(ForbiddenError);
    expect(() => assertCan(null, "company.read")).toThrow(ForbiddenError);
    expect(() => assertCan("admin", "company.write")).not.toThrow();
  });
});
