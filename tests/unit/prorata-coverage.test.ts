import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invoiceDrafts } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { addContractLine, createContract, getContract, listContractLineChanges, updateContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { previewBillingRun, runBillingRun } from "@/services/billing-run";
import { makeUser } from "./helpers";

let admin: { id: string };
let companyId: string;
const line = (description: string, over: Record<string, unknown> = {}) => ({ id: null, productId: null, siteId: null, description, revenueType: "recurring" as const, pricingModel: "per_user" as const, billingFrequency: "monthly" as const, quantity: 10, unitPrice: 30, unitCost: null, countsAsManagedDevice: false, ...over });
const input = (name: string) => contractSchema.parse({ companyId, name, startDate: "2026-01-01", status: "active", billingFrequency: "monthly" });

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "prorata admin");
  companyId = await createCompany(companySchema.parse({ name: "Prorata Coverage Ltd", status: "customer" }), admin.id);
});

describe("a line that starts mid-period", () => {
  it("is invoiced once as an 'added from' line, covers its period, and is not proposed again as just the pro rata", async () => {
    const id = await createContract(input("Mid-period MSA"), [line("Users")], admin.id);
    // October is invoiced on the 1st.
    const oct = await runBillingRun("2026-10-01", [id], admin.id);
    expect(oct.created).toHaveLength(1);
    // On the 12th a new line starts (added through the matching dialog / addContractLine with its start date).
    const added = await addContractLine(id, { ...line("Extra licences", { quantity: 4 }), id: null }, admin.id, "new starters", "2026-10-12");
    const mid = (await previewBillingRun("2026-10-20")).find((r) => r.contractId === id)!;
    expect(mid.skipReason).toBeNull();
    expect(mid.items.map((i) => i.lineId)).toEqual([added.lineId]); // Users is already covered for October
    expect(mid.lines).toHaveLength(1);
    expect(mid.lines[0].calc).toMatchObject({ kind: "increase", from: "2026-10-12", quantity: 4 });
    expect(mid.net).toBeCloseTo(Math.round(((4 * 30 * 20) / 31) * 100) / 100, 2);
    const run = await runBillingRun("2026-10-20", [id], admin.id);
    expect(run.created).toHaveLength(1);

    // The bug: this used to come back every run as "just the pro rata". Now the period is covered.
    const again = (await previewBillingRun("2026-10-25")).find((r) => r.contractId === id)!;
    expect(again.items).toEqual([]);
    expect(again.skipReason).toMatch(/^already drafted/);
    expect((await runBillingRun("2026-10-25", [id], admin.id)).created).toHaveLength(0);
    expect(await db.select().from(invoiceDrafts).where(eq(invoiceDrafts.contractId, id))).toHaveLength(2);

    // November bills the whole period for both lines, nothing doubled.
    const nov = (await previewBillingRun("2026-11-01")).find((r) => r.contractId === id)!;
    expect(nov.lines.map((l) => [l.contractLineId, l.calc?.kind, l.quantity])).toEqual([
      [(await getContract(id))!.lines.find((l) => l.description === "Users")!.id, "period", 10],
      [added.lineId, "period", 4],
    ]);
    expect(nov.net).toBe(10 * 30 + 4 * 30);
  });

  it("a line that starts in a later period is not due yet and never makes an empty draft", async () => {
    const id = await createContract(input("Future line MSA"), [line("Users")], admin.id);
    await runBillingRun("2026-10-01", [id], admin.id);
    await addContractLine(id, { ...line("Starts in November", { quantity: 2 }), id: null }, admin.id, null, "2026-11-01");
    const r = (await previewBillingRun("2026-10-15")).find((r) => r.contractId === id)!;
    expect(r.items).toEqual([]);
    expect(r.skipReason).toMatch(/^already drafted/); // October's draft covers the only line that is live in October
    expect((await runBillingRun("2026-10-15", [id], admin.id)).created).toHaveLength(0);
    const nov = (await previewBillingRun("2026-11-02")).find((r) => r.contractId === id)!;
    expect(nov.lines.map((l) => l.calc?.kind)).toEqual(["period", "period"]);
    // A contract whose only line starts later says so, and prepares nothing.
    const later = await createContract(input("Starts later MSA"), [], admin.id);
    await addContractLine(later, { ...line("From December"), id: null }, admin.id, null, "2026-12-01");
    const lr = (await previewBillingRun("2026-11-10")).find((r) => r.contractId === later)!;
    expect(lr).toMatchObject({ items: [], skipReason: "nothing due yet: the lines start later" });
    expect((await runBillingRun("2026-11-10", [later], admin.id)).created).toHaveLength(0);
  });
});

describe("per-line effective dates on an edit", () => {
  it("each changed line can carry its own date; the form's date applies to the rest, and a change can be recorded after the day", async () => {
    const id = await createContract(input("Two starters MSA"), [line("Users"), line("Mailboxes", { quantity: 5, unitPrice: 4 })], admin.id);
    const c = (await getContract(id))!;
    const users = c.lines.find((l) => l.description === "Users")!;
    const mail = c.lines.find((l) => l.description === "Mailboxes")!;
    await updateContract(
      id,
      input("Two starters MSA"),
      [
        { ...line("Users", { quantity: 12 }), id: users.id, effectiveFrom: "2026-10-05" },
        { ...line("Mailboxes", { quantity: 7, unitPrice: 4 }), id: mail.id, effectiveFrom: "" },
      ],
      admin.id,
      { quantityEffectiveFrom: "2026-10-19", changeReason: "recorded on the 25th" },
    );
    const history = await listContractLineChanges(id);
    expect(history.map((h) => [h.contractLineId, h.previousValue, h.newValue, h.effectiveFrom, h.reason]).sort()).toEqual(
      [
        [users.id, "10.00", "12.00", "2026-10-05", "recorded on the 25th"],
        [mail.id, "5.00", "7.00", "2026-10-19", "recorded on the 25th"],
      ].sort(),
    );
    // The run bills each increase from its own day.
    const r = (await previewBillingRun("2026-10-25")).find((x) => x.contractId === id)!;
    const inc = r.lines.filter((l) => l.calc?.kind === "increase").map((l) => [l.contractLineId, l.calc?.from, l.calc?.quantity]);
    expect(inc.sort()).toEqual([[users.id, "2026-10-05", 2], [mail.id, "2026-10-19", 2]].sort());
  });
});
