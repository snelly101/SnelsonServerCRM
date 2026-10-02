import { describe, expect, it, beforeAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  activities,
  billingDiscrepancies,
  contractLines,
  pax8Companies,
  pax8InvoiceItems,
  pax8Subscriptions,
  products,
} from "@/db/schema";
import { createCompany, updateCompany } from "@/services/companies";
import { createContact } from "@/services/contacts";
import { contactSchema } from "@/lib/validation";
import { DemoPax8Client } from "@/connectors/pax8/demo";
import { companySchema } from "@/lib/validation";
import { createContract } from "@/services/contracts";
import { contractSchema } from "@/lib/validation-sales";
import { LivePax8Client } from "@/connectors/pax8/live";
import { commitmentOf, pax8Date, termMonths } from "@/connectors/pax8/types";
import { DEMO_PAX8_COMPANY_IDS } from "@/connectors/pax8/demo";
import {
  applyPax8Cost,
  autoLinkPax8Companies,
  companySubscriptionOverview,
  createPax8CompanyForCompany,
  linkPax8Company,
  pushPax8Contacts,
  matchLine,
  monthlyUnitCost,
  pax8ConnectionSummary,
  pax8MappingOverview,
  pax8Totals,
  runLicenceCheck,
  setSubscriptionBillingLine,
  syncPax8,
  unlinkPax8Company,
  type MatchableLine,
} from "@/services/pax8";
import { listOpenConflicts, setConnectionConfig } from "@/services/integrations";
import { listDiscrepancies, reviewDiscrepancy } from "@/services/ninjaone";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let admin: { id: string };

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  admin = await makeUser("admin", "pax8 admin");
});

const line = (over: Partial<MatchableLine>): MatchableLine => ({
  id: "l",
  contractId: "c",
  contractName: "MSA",
  contractStatus: "active",
  description: "Line",
  quantity: "1",
  unitPrice: "10",
  unitCost: null,
  billingFrequency: "monthly",
  pricingModel: "per_user",
  productSku: null,
  productName: null,
  ...over,
});

describe("Pax8 helpers", () => {
  it("converts billing terms to months, parses dates and commitments, and derives a monthly unit cost", () => {
    expect(termMonths("Monthly")).toBe(1);
    expect(termMonths("Annual")).toBe(12);
    expect(termMonths("2-Year")).toBe(24);
    expect(termMonths("One-Time")).toBeNull();
    expect(pax8Date("2026-11-03T00:00:00Z")).toBe("2026-11-03");
    expect(commitmentOf({ term: "Annual", endDate: "2027-01-01" })).toEqual({
      term: "Annual",
      endsOn: "2027-01-01",
    });
    expect(commitmentOf("Monthly")).toEqual({ term: "Monthly", endsOn: null });
    expect(monthlyUnitCost("182.6", "Annual")).toBeCloseTo(15.2167, 3);
    expect(monthlyUnitCost("9.4", "Monthly")).toBe(9.4);
    expect(monthlyUnitCost("50", "One-Time")).toBeNull();
  });
  it("matches a subscription to a line by explicit choice, then SKU, then product name", () => {
    const bySku = line({ id: "sku", productSku: "cfq7ttc0ldpb:0001" });
    const byName = line({
      id: "name",
      productName: "Microsoft 365 Business Standard",
    });
    const byDesc = line({
      id: "desc",
      description: "Microsoft 365 Business Standard",
    });
    const sub = {
      contractLineId: null,
      sku: "CFQ7TTC0LDPB:0001",
      vendorSku: "CFQ7TTC0LDPB",
      productName: "Microsoft 365 Business Standard",
    };
    expect(matchLine(sub, [byName, bySku])).toMatchObject({
      line: { id: "sku" },
      by: "sku",
    });
    expect(matchLine(sub, [byDesc])).toMatchObject({
      line: { id: "desc" },
      by: "name",
    });
    expect(
      matchLine({ ...sub, contractLineId: "name" }, [bySku, byName]),
    ).toMatchObject({ line: { id: "name" }, by: "manual" });
    expect(
      matchLine(
        { ...sub, sku: null, vendorSku: null, productName: "Visio Plan 2" },
        [bySku, byName],
      ),
    ).toBeNull();
  });
});

describe("Pax8 live client", () => {
  it("exchanges the client credentials for a token with the Pax8 audience, walks pages, and only ever GETs for reads", async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      calls.push({
        method: init?.method ?? "GET",
        url: u.href,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (u.hostname === "login.pax8.com")
        return json({
          access_token: "tok-1",
          expires_in: 3600,
          token_type: "Bearer",
        });
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer tok-1",
      );
      if (u.pathname === "/v1/companies") {
        const page = Number(u.searchParams.get("page"));
        return json({
          content:
            page === 0
              ? [
                  { id: "a", name: "A" },
                  { id: "b", name: "B" },
                ]
              : [{ id: "c", name: "C" }],
          page: { size: 2, totalElements: 3, totalPages: 2, number: page },
        });
      }
      if (u.pathname === "/v1/invoices/x/items")
        return new Response("Not found", { status: 404 });
      return json({ content: [], page: { totalPages: 0 } });
    });
    const stored: unknown[] = [];
    const client = new LivePax8Client(
      { clientId: "id-1234", clientSecret: "secret" },
      null,
      async (t) => void stored.push(t),
      fetchImpl as unknown as typeof fetch,
      2,
    );
    expect(await client.testConnection()).toEqual({
      ok: true,
      companyCount: 3,
      partnerName: null,
    });
    expect((await client.listCompanies()).map((c) => c.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(await client.listInvoiceItems("x")).toEqual([]);
    const token = calls.filter((c) =>
      c.url.startsWith("https://login.pax8.com/oauth/token"),
    );
    expect(token).toHaveLength(1);
    expect(JSON.parse(token[0].body!)).toMatchObject({
      client_id: "id-1234",
      client_secret: "secret",
      audience: "api://p8p.client",
      grant_type: "client_credentials",
    });
    expect(stored).toHaveLength(1);
    expect(
      calls
        .filter((c) => !c.url.startsWith("https://login.pax8.com"))
        .every(
          (c) =>
            c.method === "GET" && c.url.startsWith("https://api.pax8.com/v1/"),
        ),
    ).toBe(true);
    // The only writes are createCompany and createContact.
    expect(
      Object.getOwnPropertyNames(LivePax8Client.prototype).filter((k) =>
        /create|update|delete|order|cancel|set|change/i.test(k),
      ).sort(),
    ).toEqual(["createCompany", "createContact"]);
  });

  it("creates a company with one POST carrying the full address, phone, website, external id and contacts, and adds a contact with a POST under the company", async () => {
    const posted: { url: string; body: unknown }[] = [];
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname === "login.pax8.com")
        return json({ access_token: "tok", expires_in: 3600 });
      expect(init?.method).toBe("POST");
      posted.push({ url: u.href, body: JSON.parse(String(init?.body)) });
      if (u.pathname.endsWith("/contacts")) return json({ id: "ct-1", firstName: "Pat", lastName: "Lee", email: "pat@newco.example", phone: "0113 000 0001", types: [{ type: "Admin", primary: true }] });
      return json({ id: "new-1", name: "New Co Ltd", status: "Active" });
    });
    const client = new LivePax8Client(
      { clientId: "id", clientSecret: "secret" },
      null,
      async () => {},
      fetchImpl as unknown as typeof fetch,
    );
    const body = {
      name: "New Co Ltd",
      address: { street: "1 High Street", city: "Leeds", stateOrProvince: "West Yorkshire", postalCode: "LS1 1AA", country: "GB" },
      phone: "0113 000 0000",
      website: "https://newco.example",
      externalId: "crm-1",
      billOnBehalfOfEnabled: false,
      selfServiceAllowed: false,
      orderApprovalRequired: false,
      contacts: [{ firstName: "Pat", lastName: "Lee", email: "pat@newco.example", phone: "0113 000 0001", types: [{ type: "Admin" as const, primary: true }, { type: "Billing" as const, primary: true }, { type: "Technical" as const, primary: true }] }],
    };
    const created = await client.createCompany(body);
    expect(created.id).toBe("new-1");
    expect(posted).toEqual([{ url: "https://api.pax8.com/v1/companies", body }]);
    const contact = { firstName: "Pat", lastName: "Lee", email: "pat@newco.example", phone: "0113 000 0001", types: [{ type: "Admin" as const, primary: true }] };
    expect((await client.createContact("new-1", contact)).id).toBe("ct-1");
    expect(posted[1]).toEqual({ url: "https://api.pax8.com/v1/companies/new-1/contacts", body: contact });
  });
});

describe("Pax8 sync, matching, licence check and costs (demo adapter)", () => {
  let dental: string;
  let freight: string;
  let ridgeway: string;
  let vets: string;
  const productId: Record<string, string> = {};

  it("mirrors companies, products, subscriptions and invoice lines, auto-links by domain or exact name, and raises licence discrepancies", async () => {
    dental = await createCompany(
      companySchema.parse({
        name: "Harrowgate Dental Practice",
        status: "customer",
        website: "harrowgatedental.co.uk",
      }),
      admin.id,
    );
    freight = await createCompany(
      companySchema.parse({
        name: "Northern Freight Solutions Ltd",
        status: "customer",
        website: "https://www.northernfreight.co.uk",
      }),
      admin.id,
    );
    ridgeway = await createCompany(
      companySchema.parse({
        name: "Ridgeway Architects LLP",
        status: "customer",
        website: "ridgewayarch.com",
      }),
      admin.id,
    );
    vets = await createCompany(
      companySchema.parse({ name: "Calder Valley Vets", status: "prospect" }),
      admin.id,
    );
    for (const [sku, name, unitPrice, unitCost] of [
      ["M365-BP", "Microsoft 365 Business Premium", "18.10", "16.60"],
      ["M365-BS", "Microsoft 365 Business Standard", "10.30", "9.40"],
      ["BK-M365", "Microsoft 365 backup", "3.00", "1.60"],
    ] as const) {
      const [p] = await db
        .insert(products)
        .values({
          sku,
          name,
          category: "microsoft_365",
          pricingModel: "per_user",
          revenueType: "recurring",
          billingFrequency: "monthly",
          unitPrice,
          unitCost,
        })
        .returning({ id: products.id });
      productId[sku] = p.id;
    }
    const mk = (companyId: string, name: string, lines: [string, number][]) =>
      createContract(
        contractSchema.parse({
          companyId,
          name,
          status: "active",
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          billingFrequency: "monthly",
          autoRenew: true,
          noticePeriodDays: 30,
        }),
        lines.map(([sku, quantity]) => ({
          id: null,
          description: {
            "M365-BP": "Microsoft 365 Business Premium",
            "M365-BS": "Microsoft 365 Business Standard",
            "BK-M365": "Microsoft 365 backup",
          }[sku]!,
          revenueType: "recurring" as const,
          pricingModel: "per_user" as const,
          billingFrequency: "monthly" as const,
          quantity,
          unitPrice: sku === "M365-BP" ? 18.1 : sku === "M365-BS" ? 10.3 : 3,
          unitCost: sku === "M365-BP" ? 16.6 : sku === "M365-BS" ? 9.4 : 1.6,
          countsAsManagedDevice: false,
          productId: productId[sku],
          siteId: null,
        })),
        admin.id,
      );
    await mk(dental, "Dental MSA", [
      ["M365-BS", 14],
      ["BK-M365", 14],
    ]);
    await mk(freight, "Freight MSA", [["M365-BP", 32]]);
    await mk(ridgeway, "Ridgeway MSA", [["M365-BS", 18]]);

    expect((await pax8ConnectionSummary()).demo).toBe(true);
    const res = await syncPax8("manual", admin.id);
    expect(res?.status).toBe("success");
    const totals = await pax8Totals();
    expect(totals.companies).toBe(7);
    expect(totals.linked).toBe(3);
    expect(totals.subscriptions).toBe(9);
    expect(totals.licences).toBe(14 + 14 + 34 + 3 + 9 + 16 + 12 + 6 + 5);
    const [pcFreight] = await db
      .select()
      .from(pax8Companies)
      .where(
        eq(
          pax8Companies.pax8Id,
          DEMO_PAX8_COMPANY_IDS["Northern Freight Solutions"],
        ),
      );
    expect(pcFreight).toMatchObject({
      companyId: freight,
      matchSource: "auto",
      matchDomain: "northernfreight.co.uk",
    });
    const [pcVets] = await db
      .select()
      .from(pax8Companies)
      .where(
        eq(
          pax8Companies.pax8Id,
          DEMO_PAX8_COMPANY_IDS["Calder Valley Veterinary Group"],
        ),
      );
    expect(pcVets.companyId).toBeNull();
    const [s1004] = await db
      .select()
      .from(pax8Subscriptions)
      .where(eq(pax8Subscriptions.subscriptionId, "s-1004"));
    expect(s1004).toMatchObject({
      companyId: freight,
      productName: "Microsoft 365 Business Premium",
      quantity: 34,
      status: "Active",
      billingTerm: "Monthly",
      price: "16.6000",
    });
    expect(
      (
        await db
          .select()
          .from(pax8InvoiceItems)
          .where(eq(pax8InvoiceItems.companyId, freight))
      ).length,
    ).toBeGreaterThanOrEqual(4);

    const open = await listDiscrepancies({ status: "open", source: "pax8" });
    expect(open.map((d) => [d.companyId, Number(d.difference)]).sort()).toEqual(
      [
        [freight, 2],
        [ridgeway, -2],
      ].sort(),
    );
    expect(open.every((d) => d.source === "pax8")).toBe(true);
    expect(await listDiscrepancies({ source: "ninjaone" })).toEqual([]);

    // Re-running is idempotent.
    const again = await syncPax8("manual", admin.id);
    expect(again?.counters.created).toBe(0);
    expect(
      (await listDiscrepancies({ status: "open", source: "pax8" })).length,
    ).toBe(2);
  });

  it("company overview matches lines by name, flags unbilled subscriptions and lists Pax8 charges", async () => {
    const o = (await companySubscriptionOverview(freight))!;
    expect(o.pax8Company.name).toBe("Northern Freight Solutions");
    const premium = o.subscriptions.find((s) => s.subscriptionId === "s-1004")!;
    expect(premium.line?.description).toBe("Microsoft 365 Business Premium");
    expect(premium.matchedBy).toBe("name");
    expect(premium.costDiffers).toBe(false);
    expect(premium.marginPerUnitMonthly).toBeCloseTo(1.5, 5);
    const exchange = o.subscriptions.find(
      (s) => s.subscriptionId === "s-1005",
    )!;
    expect(exchange.line).toBeNull();
    expect(o.totals).toMatchObject({
      subscriptions: 2,
      licences: 37,
      unbilled: 1,
    });
    expect(o.totals.monthlyCost).toBeCloseTo(34 * 16.6 + 3 * 3, 5);
    expect(o.charges.length).toBe(3);
    expect(o.discrepancies).toHaveLength(1);
    expect(await companySubscriptionOverview(vets)).toBeNull();
  });

  it("suggests similar names, links and unlinks by hand (remembered across syncs), and refuses a second Pax8 company on one CRM company", async () => {
    const overview = await pax8MappingOverview();
    const vetsRow = overview.items.find(
      (i) => i.name === "Calder Valley Veterinary Group",
    )!;
    expect(vetsRow.suggestions).toEqual([
      { id: vets, name: "Calder Valley Vets", reason: "similar" },
    ]);
    expect(
      overview.items.find((i) => i.name === "Moorland Outdoor Supplies")!
        .suggestions,
    ).toEqual([]);
    expect(overview.companies.some((c) => c.id === freight)).toBe(false);
    await linkPax8Company(vetsRow.id, vets, admin.id);
    expect(
      (
        await db
          .select()
          .from(pax8Subscriptions)
          .where(eq(pax8Subscriptions.subscriptionId, "s-1009"))
      )[0].companyId,
    ).toBe(vets);
    const moorland = overview.items.find(
      (i) => i.name === "Moorland Outdoor Supplies",
    )!;
    await expect(linkPax8Company(moorland.id, vets, admin.id)).rejects.toThrow(
      /already linked/,
    );
    await unlinkPax8Company(vetsRow.id, admin.id);
    await syncPax8("manual", admin.id);
    const [after] = await db
      .select()
      .from(pax8Companies)
      .where(eq(pax8Companies.id, vetsRow.id));
    expect(after).toMatchObject({ companyId: null, matchSource: "manual" });
    expect(
      (
        await db
          .select()
          .from(pax8Subscriptions)
          .where(eq(pax8Subscriptions.subscriptionId, "s-1009"))
      )[0].companyId,
    ).toBeNull();
    // A fresh auto-link pass leaves the manual unlink alone.
    expect((await autoLinkPax8Companies(admin.id)).linked).toBe(0);
  });

  it("a person can choose the billing line (must belong to the company), and the Pax8 price can be copied onto it as the unit cost", async () => {
    const [acronis] = await db
      .select()
      .from(pax8Subscriptions)
      .where(eq(pax8Subscriptions.subscriptionId, "s-1002"));
    expect(acronis.companyId).toBe(dental);
    const before = (await companySubscriptionOverview(dental))!;
    expect(
      before.subscriptions.find((s) => s.id === acronis.id)!.line,
    ).toBeNull();
    expect(before.totals.unbilled).toBe(1);
    const backupLine = before.lines.find(
      (l) => l.description === "Microsoft 365 backup",
    )!;
    const freightLine = (await companySubscriptionOverview(freight))!.lines[0];
    await expect(
      setSubscriptionBillingLine(acronis.id, freightLine.id, admin.id),
    ).rejects.toBeInstanceOf(ActionError);
    await expect(applyPax8Cost(acronis.id, admin.id)).rejects.toThrow(
      /No contract line/,
    );
    await setSubscriptionBillingLine(acronis.id, backupLine.id, admin.id);
    const after = (await companySubscriptionOverview(dental))!;
    const row = after.subscriptions.find((s) => s.id === acronis.id)!;
    expect(row.matchedBy).toBe("manual");
    expect(row.line?.id).toBe(backupLine.id);
    expect(row.costDiffers).toBe(true); // 1.60 in the contract vs 1.55 at Pax8
    expect(after.totals.unbilled).toBe(0);
    expect(after.discrepancies.filter((d) => d.status === "open")).toHaveLength(
      0,
    ); // 14 = 14
    const applied = await applyPax8Cost(acronis.id, admin.id);
    expect(applied).toEqual({
      contractLineId: backupLine.id,
      unitCost: "1.55",
      from: "1.60",
    });
    expect(
      (
        await db
          .select({ unitCost: contractLines.unitCost })
          .from(contractLines)
          .where(eq(contractLines.id, backupLine.id))
      )[0].unitCost,
    ).toBe("1.55");
    expect(
      (await companySubscriptionOverview(dental))!.subscriptions.find(
        (s) => s.id === acronis.id,
      )!.costDiffers,
    ).toBe(false);
    // A Pax8 subscription on an unlinked company cannot be billed.
    const [moor] = await db
      .select()
      .from(pax8Subscriptions)
      .where(eq(pax8Subscriptions.subscriptionId, "s-1010"));
    await expect(
      setSubscriptionBillingLine(moor.id, null, admin.id),
    ).rejects.toThrow(/Link the Pax8 company/);
  });

  it("reviewing a licence discrepancy is worded as a licence event, and the check resolves once counts match", async () => {
    const [disc] = await db
      .select()
      .from(billingDiscrepancies)
      .where(
        and(
          eq(billingDiscrepancies.source, "pax8"),
          eq(billingDiscrepancies.companyId, ridgeway),
        ),
      );
    await reviewDiscrepancy(
      disc.id,
      "accepted",
      "Two leavers, contract amendment pending",
      admin.id,
    );
    const events = await db
      .select({ title: activities.title, source: activities.source })
      .from(activities)
      .where(eq(activities.companyId, ridgeway));
    expect(
      events.some(
        (e) =>
          e.title.startsWith("Licence discrepancy accepted") &&
          e.source === "pax8",
      ),
    ).toBe(true);
    await db
      .update(contractLines)
      .set({ quantity: "16" })
      .where(eq(contractLines.id, disc.contractLineId));
    const r = await runLicenceCheck(admin.id, ridgeway);
    expect(r).toMatchObject({ resolved: 1, open: 0 });
    expect(
      (
        await db
          .select()
          .from(billingDiscrepancies)
          .where(eq(billingDiscrepancies.id, disc.id))
      )[0].status,
    ).toBe("resolved");
  });
  it("auto-create on customer status: off by default; waits for a contact (Pax8 needs one to activate) then creates Active with role-mapped contacts; skips with a timeline note when fields are missing; raises a review item for a look-alike; fires on a prospect turning customer; pushes contacts to an Inactive company", async () => {
    const full = {
      addressLine1: "2 Mill Lane",
      city: "Leeds",
      region: "West Yorkshire",
      postcode: "LS2 2BB",
      country: "GB",
      phone: "0113 496 0999",
    };
    const off = await createCompany(
      companySchema.parse({ name: "Quiet Pax8 Default Ltd", status: "customer", website: "quietpax8.example", ...full }),
      admin.id,
    );
    expect(await companySubscriptionOverview(off)).toBeNull();

    await setConnectionConfig("pax8", { autoCreateCompanies: true }, admin.id);
    try {
      // Full company record but no contact yet: Pax8 would leave it Inactive, so the CRM waits and says so.
      const fresh = await createCompany(
        companySchema.parse({ name: "Auto Pax8 Customer Ltd", status: "customer", website: "autopax8.example", ...full }),
        admin.id,
      );
      expect((await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, fresh))).length).toBe(0);
      expect((await db.select({ title: activities.title }).from(activities).where(eq(activities.companyId, fresh))).some((n) => /Pax8 needs a contact with an e-mail address/.test(n.title))).toBe(true);
      // Saving contacts triggers the creation: billing role → Billing, technical → Technical, primary → Admin, all primaries filled.
      await createContact(contactSchema.parse({ companyId: fresh, firstName: "Billie", lastName: "Books", email: "billie@autopax8.example", roles: ["billing"] }), admin.id);
      expect((await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, fresh))).length).toBe(1);
      const [row] = await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, fresh));
      expect(row).toMatchObject({ name: "Auto Pax8 Customer Ltd", matchDomain: "autopax8.example", externalRef: fresh, city: "Leeds", matchSource: "manual", externalStatus: "active", status: "Active" });
      expect(row.raw?.address).toMatchObject({ street: "2 Mill Lane", stateOrProvince: "West Yorkshire", postalCode: "LS2 2BB", country: "GB" });
      const demo = new DemoPax8Client();
      const pushed = await demo.listContacts(row.pax8Id);
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).toMatchObject({ firstName: "Billie", lastName: "Books", email: "billie@autopax8.example", phone: "0113 496 0999" });
      expect(pushed[0].types!.map((t) => t.type).sort()).toEqual(["Admin", "Billing", "Technical"]);
      expect(pushed[0].types!.every((t) => t.primary)).toBe(true);
      // Idempotent: a retry returns the same Pax8 id, and a sync keeps the row.
      expect(await createPax8CompanyForCompany(fresh, admin.id)).toBe(row.pax8Id);
      await syncPax8("manual", admin.id);
      expect((await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, fresh))).length).toBe(1);

      // Missing required fields: nothing created, the timeline explains, and the manual path refuses with the same list.
      const bare = await createCompany(companySchema.parse({ name: "Bare Pax8 Customer Ltd", status: "customer" }), admin.id);
      expect((await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, bare))).length).toBe(0);
      const notes = await db.select({ title: activities.title }).from(activities).where(eq(activities.companyId, bare));
      expect(notes.some((n) => /Pax8 needs address line 1, city, postcode, phone, website, a contact with an e-mail address/.test(n.title))).toBe(true);
      await expect(createPax8CompanyForCompany(bare, admin.id)).rejects.toThrow(/Missing: address line 1, city, postcode, phone, website, a contact with an e-mail address/);

      // A prospect (with a contact) is left alone until it becomes a customer; two contacts split the roles.
      const prospect = await createCompany(companySchema.parse({ name: "Soon A Pax8 Customer Ltd", website: "soonpax8.example", ...full }), admin.id);
      await createContact(contactSchema.parse({ companyId: prospect, firstName: "Sam", lastName: "Boss", email: "sam@soonpax8.example", phone: "07700 900001", roles: ["decision_maker"], isPrimary: true }), admin.id);
      await createContact(contactSchema.parse({ companyId: prospect, firstName: "Tess", lastName: "Tech", email: "tess@soonpax8.example", roles: ["technical"] }), admin.id);
      expect((await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, prospect))).length).toBe(0);
      await updateCompany(prospect, companySchema.parse({ name: "Soon A Pax8 Customer Ltd", website: "soonpax8.example", status: "customer", ...full }), admin.id);
      const [prow] = await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, prospect));
      expect(prow.status).toBe("Active");
      const pc = await demo.listContacts(prow.pax8Id);
      const sam = pc.find((c) => c.email === "sam@soonpax8.example")!;
      const tess = pc.find((c) => c.email === "tess@soonpax8.example")!;
      expect(sam.phone).toBe("07700 900001");
      expect(sam.types).toEqual(expect.arrayContaining([{ type: "Admin", primary: true }, { type: "Billing", primary: true }]));
      expect(sam.types!.some((t) => t.type === "Technical")).toBe(false);
      expect(tess.types).toEqual([{ type: "Technical", primary: true }]);

      // A company created at Pax8 without contacts is Inactive; pushing the CRM contacts activates it (and a second push adds nothing).
      const inactiveCo = await createCompany(companySchema.parse({ name: "Inactive At Pax8 Ltd", status: "customer", website: "inactivepax8.example", ...full }), admin.id);
      const raw = await demo.createCompany({ name: "Inactive At Pax8 Ltd", address: { street: "1 Road", city: "Leeds", stateOrProvince: "WY", postalCode: "LS1 1AA", country: "GB" }, phone: "0113 000 0000", website: "https://inactivepax8.example", billOnBehalfOfEnabled: false, selfServiceAllowed: false, orderApprovalRequired: false });
      expect(raw.status).toBe("Inactive");
      await db.insert(pax8Companies).values({ pax8Id: raw.id, name: raw.name, normalizedName: "inactive at pax8", website: raw.website, matchDomain: "inactivepax8.example", status: raw.status, companyId: inactiveCo, matchSource: "manual", externalStatus: "active", raw: raw as Record<string, unknown>, fetchedAt: new Date() });
      // Saving a contact runs the hook, which notices the Inactive link and pushes.
      await createContact(contactSchema.parse({ companyId: inactiveCo, firstName: "Ivy", lastName: "Owner", email: "ivy@inactivepax8.example", roles: ["billing", "technical", "decision_maker"] }), admin.id);
      expect((await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, inactiveCo)))[0].status).toBe("Active");
      expect(await pushPax8Contacts(inactiveCo, admin.id)).toMatchObject({ added: 0, status: "Active" });
      expect(await demo.listContacts(raw.id)).toHaveLength(1);

      // Pax8 already has a similar company (unlinked demo row): review item, nothing created.
      const dupe = await createCompany(companySchema.parse({ name: "Moorland Outdoor Supplies Ltd", status: "customer", website: "moorland-outdoor.example", ...full }), admin.id);
      expect((await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, dupe))).length).toBe(0);
      const review = (await listOpenConflicts("pax8")).find((c) => c.entityType === "company" && c.localId === dupe);
      expect(review).toMatchObject({ kind: "ambiguous_match", externalId: DEMO_PAX8_COMPANY_IDS["Moorland Outdoor Supplies"] });
    } finally {
      await setConnectionConfig("pax8", { autoCreateCompanies: false }, admin.id);
    }
  });
});
