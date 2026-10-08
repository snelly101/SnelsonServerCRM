import { describe, expect, it } from "vitest";
import { extractProposalItems, itemTotals, frequencyOf } from "@/lib/proposal-items";

describe("proposal line item extraction", () => {
  it("reads sections of priced rows with a billing type from the section, the row or the key", () => {
    const quote = {
      ID: "q1",
      Sections: [
        { Title: "Monthly services", Type: "Monthly", Items: [{ Name: "Managed user", Quantity: "40", Price: "45.00", Total: "1800.00" }, { Name: "Microsoft 365 Business Standard", Description: "Per user", Qty: 40, UnitPrice: 12 }] },
        { Title: "Setup", Items: [{ Name: "Onboarding", Quantity: "1", Price: "1500.00", Recurring: "0" }] },
        { Title: "Yearly", Items: [{ Name: "Domain renewal", Price: "15.00", Frequency: "Annual" }] },
      ],
    };
    const items = extractProposalItems({ ID: "p1" }, quote);
    expect(items.map((i) => [i.description, i.quantity, i.unitPrice, i.billingFrequency, i.section])).toEqual([
      ["Managed user", 40, 45, "monthly", "Monthly services"],
      ["Microsoft 365 Business Standard · Per user", 40, 12, "monthly", "Monthly services"],
      ["Onboarding", 1, 1500, "one_off", "Setup"],
      ["Domain renewal", 1, 15, "annual", "Yearly"],
    ]);
    expect(items[0].total).toBe(1800);
    expect(items[1].total).toBe(480);
    expect(itemTotals(items)).toEqual({ oneOff: 1500, monthly: 2280, quarterly: 0, annual: 15 });
  });

  it("reads flat tables keyed by billing type, derives a unit price from a total, and falls back to the proposal when the quote is empty", () => {
    const quote = { Monthly: [{ Item: "Backup", Qty: "3", Total: "30.00" }], OneOff: [{ Item: "Install", Total: "200" }] };
    const items = extractProposalItems(null, quote);
    expect(items).toEqual([
      expect.objectContaining({ description: "Backup", quantity: 3, unitPrice: 10, total: 30, billingFrequency: "monthly" }),
      expect.objectContaining({ description: "Install", quantity: 1, unitPrice: 200, billingFrequency: "one_off" }),
    ]);
    const fromProposal = extractProposalItems({ ID: "p", Pricing: { Rows: [{ Label: "Support", Amount: "99", Period: "per month" }] } }, null);
    expect(fromProposal).toHaveLength(1);
    expect(fromProposal[0]).toMatchObject({ description: "Support", unitPrice: 99, billingFrequency: "monthly", path: "proposal.Pricing.Rows[0]" });
  });

  it("ignores arrays that are not pricing tables and never invents a row", () => {
    expect(extractProposalItems({ ID: "p", Contacts: [{ Email: "a@b.c", FirstName: "A" }], MonthlyTotal: "100.00" }, { Notes: ["x", "y"], Meta: { Tags: [{ Name: "vip" }] } })).toEqual([]);
    expect(frequencyOf("Quarterly")).toBe("quarterly");
    expect(frequencyOf("One-off")).toBe("one_off");
    expect(frequencyOf("whatever")).toBeNull();
  });
});
