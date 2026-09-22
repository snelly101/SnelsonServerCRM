import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { activities, auditLog, companies } from "@/db/schema";
import { archiveCompany, createCompany, findDuplicateCompanies, getCompany, listCompanies, updateCompany } from "@/services/companies";
import { createContact, findDuplicateContacts } from "@/services/contacts";
import { companySchema, contactSchema } from "@/lib/validation";
import { ActionError } from "@/lib/action-result";
import { extractDomain, normalizeCompanyName } from "@/lib/utils";
import { makeUser } from "./helpers";

let actor: { id: string };

beforeAll(async () => {
  actor = await makeUser("sales");
});

const base = (over: Partial<Parameters<typeof companySchema.parse>[0]> = {}) =>
  companySchema.parse({ name: "Acme Widgets Ltd", website: "https://www.acmewidgets.co.uk/about", ...over });

describe("normalisation", () => {
  it("normalises company names for duplicate detection", () => {
    expect(normalizeCompanyName("Acme Widgets Ltd.")).toBe("acme widgets");
    expect(normalizeCompanyName("ACME WIDGETS LIMITED")).toBe("acme widgets");
    expect(normalizeCompanyName("The Acme & Widgets Co")).toBe("acme and widgets");
  });

  it("extracts a domain from websites and emails, ignoring free mail providers", () => {
    expect(extractDomain("https://www.acmewidgets.co.uk/about")).toBe("acmewidgets.co.uk");
    expect(extractDomain("jane@acmewidgets.co.uk")).toBe("acmewidgets.co.uk");
    expect(extractDomain("bob@gmail.com")).toBeNull();
    expect(extractDomain("not a domain")).toBeNull();
  });
});

describe("companies", () => {
  it("creates a company with audit and timeline entries", async () => {
    const id = await createCompany(base(), actor.id);
    const c = await getCompany(id);
    expect(c?.name).toBe("Acme Widgets Ltd");
    expect(c?.domain).toBe("acmewidgets.co.uk");
    expect(c?.ownerUserId).toBe(actor.id);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audits.some((a) => a.action === "company.create")).toBe(true);
    const timeline = await db.select().from(activities).where(eq(activities.companyId, id));
    expect(timeline).toHaveLength(1);
  });

  it("blocks a high-confidence duplicate (same domain) unless explicitly confirmed", async () => {
    await expect(createCompany(base({ name: "Acme Widgets (North)" }), actor.id)).rejects.toThrow(ActionError);
    const id = await createCompany(base({ name: "Acme Widgets (North)" }), actor.id, { skipDuplicateCheck: true });
    expect(id).toBeTruthy();
  });

  it("reports duplicate candidates with reason and confidence, never merging", async () => {
    const dupes = await findDuplicateCompanies({ name: "ACME Widgets Limited", website: null });
    expect(dupes.some((d) => d.reason === "exact_name" && d.confidence === "medium")).toBe(true);
    const byDomain = await findDuplicateCompanies({ name: "Totally Different", website: "acmewidgets.co.uk" });
    expect(byDomain.some((d) => d.reason === "domain" && d.confidence === "high")).toBe(true);
    const fuzzy = await findDuplicateCompanies({ name: "Acme Widgetz" });
    expect(fuzzy.some((d) => d.reason === "similar_name" && d.confidence === "low")).toBe(true);
    const total = await db.select().from(companies);
    expect(total.length).toBe(2); // nothing merged or created by detection
  });

  it("updates, records a field diff, and logs status changes to the timeline", async () => {
    const id = await createCompany(base({ name: "Beta Systems", website: "betasystems.io" }), actor.id);
    await updateCompany(id, base({ name: "Beta Systems", website: "betasystems.io", status: "customer", city: "Leeds" }), actor.id);
    const c = await getCompany(id);
    expect(c?.status).toBe("customer");
    expect(c?.city).toBe("Leeds");
    const [a] = await db.select().from(auditLog).where(eq(auditLog.action, "company.update"));
    const changes = (a.details as { changes: Record<string, unknown> }).changes;
    expect(Object.keys(changes)).toEqual(expect.arrayContaining(["status", "city"]));
    expect(changes).not.toHaveProperty("name");
    const tl = await db.select().from(activities).where(eq(activities.companyId, id));
    expect(tl.some((t) => t.title.includes("Status changed"))).toBe(true);
  });

  it("archives rather than deletes, and hides archived rows from lists by default", async () => {
    const id = await createCompany(base({ name: "Gamma Ltd", website: "gamma.example" }), actor.id);
    await archiveCompany(id, actor.id);
    const list = await listCompanies({ q: "Gamma" });
    expect(list.total).toBe(0);
    const withArchived = await listCompanies({ q: "Gamma", includeArchived: true });
    expect(withArchived.total).toBe(1);
    expect(await getCompany(id)).not.toBeNull();
  });

  it("filters and paginates", async () => {
    const all = await listCompanies({ pageSize: 2 });
    expect(all.rows.length).toBe(2);
    expect(all.pageCount).toBeGreaterThanOrEqual(2);
    const customers = await listCompanies({ status: "customer" });
    expect(customers.rows.every((r) => r.status === "customer")).toBe(true);
  });
});

describe("contacts", () => {
  it("rejects a second contact with the same email", async () => {
    const companyId = await createCompany(base({ name: "Delta Co", website: "delta.example" }), actor.id);
    const input = contactSchema.parse({ companyId, firstName: "Jane", lastName: "Doe", email: "Jane.Doe@Delta.example", roles: ["billing"], isPrimary: "true" });
    await createContact(input, actor.id);
    expect(await findDuplicateContacts("jane.doe@delta.example")).toHaveLength(1);
    await expect(createContact({ ...input, firstName: "Janet" }, actor.id)).rejects.toThrow(/already exists/);
  });

  it("keeps only one primary contact per company", async () => {
    const companyId = await createCompany(base({ name: "Epsilon", website: "epsilon.example" }), actor.id);
    await createContact(contactSchema.parse({ companyId, firstName: "A", isPrimary: "true" }), actor.id);
    await createContact(contactSchema.parse({ companyId, firstName: "B", isPrimary: "true" }), actor.id);
    const c = await getCompany(companyId);
    expect(c?.contacts.filter((x) => x.isPrimary)).toHaveLength(1);
    expect(c?.contacts.find((x) => x.isPrimary)?.firstName).toBe("B");
  });
});
