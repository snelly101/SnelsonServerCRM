import { describe, expect, it } from "vitest";
import { confident, suggestLines } from "@/lib/service-suggest";
import { billedPerYear, fmtBilled } from "@/lib/format";

const lines = [
  { id: "a", description: "Managed user", contractStatus: "active", productSku: null, productName: null },
  { id: "b", description: "Microsoft 365 Business Premium", contractStatus: "draft", productSku: "CFQ7TTC0LCHC:0002", productName: "Microsoft 365 Business Premium" },
  { id: "c", description: "Microsoft 365 Business Premium (sales team)", contractStatus: "active", productSku: null, productName: null },
  { id: "d", description: "Domain renewals", contractStatus: "active", productSku: null, productName: null },
  { id: "e", description: "Web hosting for example.co.uk", contractStatus: "active", productSku: null, productName: null },
];

describe("line suggestions for an integration service", () => {
  it("ranks a SKU or exact name above a similar name, and an active agreement above a draft at the same strength", () => {
    const s = suggestLines({ name: "Microsoft 365 Business Premium", kind: "Microsoft subscription", supplierProduct: "CFQ7TTC0LCHC:0002", matchKeys: ["CFQ7TTC0LCHC:0002"] }, lines);
    expect(s.map((x) => x.lineId)).toEqual(["b", "c"]);
    expect(s[0].reason).toBe("same catalogue SKU");
    expect(s[1].reason).toBe("similar name");
  });
  it("falls back to the kind of service when the names share nothing", () => {
    // A line that names the domain beats the generic domain line; both are offered.
    expect(suggestLines({ name: "example.co.uk", kind: "Domain", supplierProduct: "co.uk" }, lines).map((s) => [s.lineId, s.reason])).toEqual([["e", "similar name"], ["d", "a domain line"]]);
    expect(suggestLines({ name: "another.org", kind: "Domain", supplierProduct: "org" }, lines)[0]).toMatchObject({ lineId: "d", reason: "a domain line" });
    const hosting = suggestLines({ name: "example.co.uk", kind: "Hosting package", supplierProduct: "Linux Unlimited" }, lines);
    expect(hosting[0]).toMatchObject({ lineId: "e", reason: "similar name" });
    expect(suggestLines({ name: "Acronis Cyber Protect", kind: "Acronis subscription", supplierProduct: "ACR-1" }, lines)).toEqual([]);
    // Sharing only generic words (Microsoft, 365) with a licence line is no reason to charge a backup seat on it.
    const acronis = suggestLines({ name: "Acronis Cyber Protect Cloud - Microsoft 365 seat", kind: "Acronis subscription", supplierProduct: "ACR-M365-SEAT" }, lines);
    expect(acronis.filter(confident)).toEqual([]);
    expect(confident(suggestLines({ name: "Microsoft 365 Business Premium", kind: "Microsoft subscription", supplierProduct: "x" }, lines)[0])).toBe(true);
  });
});

describe("billed amounts are shown at their own frequency", () => {
  it("never divides an annual price down to a month", () => {
    expect(fmtBilled({ monthlyBilled: 566.75, quarterlyBilled: 0, annualBilled: 1200 }, "GBP")).toBe("£566.75 monthly · £1,200.00 annual");
    expect(fmtBilled({ monthlyBilled: 0, quarterlyBilled: 0, annualBilled: 0 }, "GBP")).toBe("—");
    expect(billedPerYear({ monthlyBilled: 100, quarterlyBilled: 30, annualBilled: 50 })).toBe(1370);
  });
});
