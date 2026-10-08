import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bpProposals, contracts, contractLines, opportunities } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { contractFromProposal, listProposals, syncProposals } from "@/services/proposals";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "proposal contract admin");
});

describe("a signed proposal becomes a contract on request", () => {
  it("drafts a contract from the proposal totals when only a company is linked, refuses unsigned or unlinked proposals, and is idempotent", async () => {
    await syncProposals("manual", admin.id);
    const signed = (await db.select().from(bpProposals).where(eq(bpProposals.status, "signed")))[0];
    expect(signed).toBeTruthy();
    const unsigned = (await db.select().from(bpProposals).where(eq(bpProposals.status, "sent")))[0];
    await expect(contractFromProposal(unsigned.externalId, admin.id)).rejects.toThrow(/signed/);
    // Not linked to anything yet.
    await db.update(bpProposals).set({ companyId: null, opportunityId: null }).where(eq(bpProposals.id, signed.id));
    await expect(contractFromProposal(signed.externalId, admin.id)).rejects.toBeInstanceOf(ActionError);
    // Linked to a company only: a draft from the totals, stamped with the proposal id.
    const school = await createCompany(companySchema.parse({ name: "Greenfield Primary Academy", status: "customer" }), admin.id);
    await db.update(bpProposals).set({ companyId: school, monthlyTotal: "180.00", oneOffTotal: "450.00" }).where(eq(bpProposals.id, signed.id));
    const r = await contractFromProposal(signed.externalId, admin.id);
    expect(r.created).toBe(true);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, r.contractId));
    expect(c).toMatchObject({ companyId: school, status: "draft", externalProposalId: signed.externalId });
    // The demo quote carries four priced rows: they become the lines, not the totals.
    const lines = await db.select().from(contractLines).where(eq(contractLines.contractId, c.id));
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => [l.description, Number(l.quantity), Number(l.unitPrice), l.revenueType, l.billingFrequency])).toEqual(
      expect.arrayContaining([
        ["Security awareness training · Per user, monthly", 60, 2.5, "recurring", "monthly"],
        ["Managed phishing simulation · Per user, monthly", 60, 1.5, "recurring", "monthly"],
        ["Managed firewall", 1, 2100, "recurring", "monthly"],
        ["Onboarding and baseline assessment", 1, 1500, "one_off_project", "one_off"],
      ]),
    );
    expect(lines.find((l) => l.description.startsWith("Security awareness"))!.pricingModel).toBe("per_user");
    const stored = (await db.select({ lineItems: bpProposals.lineItems, quoteRaw: bpProposals.quoteRaw }).from(bpProposals).where(eq(bpProposals.id, signed.id)))[0];
    expect(stored.lineItems).toHaveLength(4);
    expect(stored.quoteRaw).toMatchObject({ ID: "demo-quote-1" });
    // A proposal whose quote carried nothing falls back to the totals.
    const other = (await db.select().from(bpProposals).where(eq(bpProposals.status, "opened")))[0];
    await db.update(bpProposals).set({ status: "signed", signedAt: new Date(), companyId: school, opportunityId: null, monthlyTotal: "180.00", oneOffTotal: "450.00", lineItems: [] }).where(eq(bpProposals.id, other.id));
    const r2 = await contractFromProposal(other.externalId, admin.id);
    const lines2 = await db.select().from(contractLines).where(eq(contractLines.contractId, r2.contractId));
    expect(lines2.map((l) => [l.revenueType, Number(l.unitPrice)])).toEqual(expect.arrayContaining([["recurring", 180], ["one_off_project", 450]]));
    // Asking again returns the same contract; the list shows it.
    expect(await contractFromProposal(signed.externalId, admin.id)).toEqual({ contractId: c.id, created: false });
    const listed = (await listProposals({ companyId: school })).rows.find((p) => p.externalId === signed.externalId)!;
    expect(listed.contractId).toBe(c.id);
    expect((await db.select().from(opportunities).where(eq(opportunities.companyId, school))).length).toBe(0);
  });
});
