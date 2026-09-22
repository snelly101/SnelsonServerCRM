import { describe, expect, it, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bpProposals, companies, contracts, onboardings, opportunities, outboundRequests } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema, contactSchema } from "@/lib/validation";
import { createContact } from "@/services/contacts";
import { createOpportunity, listStages } from "@/services/opportunities";
import { opportunitySchema } from "@/lib/validation-sales";
import { createLink, getCredentials, getLink, recordInboundEvent, runOutbound, runSync, setCredentials, getConnection, OutboundInFlightError, listSyncRuns } from "@/services/integrations";
import { createProposalForOpportunity, processAcceptance, syncProposals } from "@/services/proposals";
import { demoAdvance, demoReset } from "@/connectors/betterproposals/demo";
import { LiveBetterProposalsClient, normaliseProposal } from "@/connectors/betterproposals/live";
import { HttpClient, HttpError, parseRetryAfter } from "@/lib/integrations/http";
import { ActionError } from "@/lib/action-result";
import { makeUser } from "./helpers";

let actor: { id: string };
let companyId: string;
let contactId: string;
let leadStageId: string;

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  actor = await makeUser("admin", "integration tester");
  companyId = await createCompany(companySchema.parse({ name: "Proposal Test Ltd", website: "proposaltest.example" }), actor.id);
  contactId = await createContact(contactSchema.parse({ companyId, firstName: "Pat", lastName: "Signer", email: "pat@proposaltest.example", roles: ["decision_maker"] }), actor.id);
  leadStageId = (await listStages()).find((s) => s.name === "Lead")!.id;
});

describe("http client", () => {
  it("retries on 429 honouring Retry-After and succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const http = new HttpClient({ name: "t", baseUrl: "https://example.test", fetchImpl, maxAttempts: 5 });
    const res = await http.get<{ ok: boolean }>("/x");
    expect(res.data.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("does not retry 4xx client errors and exposes the body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "error", message: "Invalid token" }), { status: 401 })) as unknown as typeof fetch;
    const http = new HttpClient({ name: "t", baseUrl: "https://example.test", fetchImpl, maxAttempts: 5 });
    await expect(http.get("/x")).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts on 5xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const http = new HttpClient({ name: "t", baseUrl: "https://example.test", fetchImpl, maxAttempts: 3 });
    await expect(http.get("/x")).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(0);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("Better Proposals live client (against a fake API)", () => {
  it("sends the Bptoken header, form-encodes proposal creation and normalises responses", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      seen.push({ url: u, headers: Object.fromEntries(Object.entries(init?.headers ?? {})), body: String(init?.body ?? "") });
      if (u.endsWith("/settings")) return new Response(JSON.stringify({ status: "success", data: { ID: "1", AccountID: "51075", TaxLabel: "VAT", TaxAmount: "20.00" } }));
      if (u.endsWith("/settings/brand")) return new Response(JSON.stringify({ status: "success", data: { ID: "4", CompanyName: "Snelson Server", TaxLabel: "VAT", TaxAmount: "20.00" } }));
      if (u.includes("/proposal/create")) return new Response(JSON.stringify({ status: "success", data: { ID: "219014", ProposalView: "https://betterproposals.io/2/proposals/view?id=219014" } }));
      if (u.includes("/proposal/signed")) return new Response(JSON.stringify({ status: "success", data: [{ ID: "219008", SubjectLine: "Signed one", DateSigned: "2026-06-09 11:59:46", SignedSignature: "John Smith", MonthlyTotal: "250.00", ProposalView: "https://x/1" }] }));
      if (u.includes("/proposal/219014")) return new Response(JSON.stringify({ status: "success", data: { ID: "219014", SubjectLine: "New one", DateCreated: "2026-06-13 07:40:08", Signed: "0" } }));
      return new Response(JSON.stringify({ status: "error", message: "Not found" }), { status: 404 });
    }) as unknown as typeof fetch;
    const client = new LiveBetterProposalsClient("secret-token", fetchImpl);
    const test = await client.testConnection();
    expect(test).toMatchObject({ ok: true, accountName: "Snelson Server", accountId: "51075", taxLabel: "VAT" });
    expect(seen[0].headers.Bptoken).toBe("secret-token");

    const created = await client.createProposal({ company: "255", templateId: "244", currency: "GBP", contacts: [{ firstName: "Pat", surname: "Signer", email: "pat@x.example", signature: true }], mergeTags: [{ tag: "term", value: "12 months" }] });
    expect(created.externalId).toBe("219014");
    const createCall = seen.find((s) => s.url.includes("/proposal/create"))!;
    expect(createCall.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(createCall.body);
    expect(params.get("Company")).toBe("255");
    expect(params.get("Template")).toBe("244");
    expect(params.get("Currency")).toBe("gbp");
    expect(params.get("Contacts[0][Email]")).toBe("pat@x.example");
    expect(params.get("Contacts[0][Signature]")).toBe("1");
    expect(JSON.parse(params.get("MergeTags")!)).toEqual([{ tag: "term", value: "12 months" }]);

    const signed = await client.listProposals("signed", 1);
    expect(signed[0]).toMatchObject({ externalId: "219008", status: "signed", signedBy: "John Smith", monthlyTotal: 250 });
    expect(signed[0].signedAt?.toISOString()).toBe("2026-06-09T11:59:46.000Z");
    expect(await client.getProposal("nope")).toBeNull();
  });

  it("normalises status from the vendor's string flags", () => {
    expect(normaliseProposal({ ID: "1" }).status).toBe("draft");
    expect(normaliseProposal({ ID: "1", DateSent: "2026-01-01 10:00:00" }).status).toBe("sent");
    expect(normaliseProposal({ ID: "1", DateSent: "2026-01-01 10:00:00", ProposalOpened: "2026-01-02 10:00:00" }).status).toBe("opened");
    expect(normaliseProposal({ ID: "1", Signed: "1" }).status).toBe("signed");
    expect(normaliseProposal({ ID: "1", Paid: "1", DatePaid: "2026-01-03 10:00:00" }).status).toBe("paid");
    expect(normaliseProposal({ ID: "1", DateSigned: "0000-00-00 00:00:00" }).signedAt).toBeNull();
  });
});

describe("integration framework", () => {
  it("stores credentials encrypted and reads them back", async () => {
    await setCredentials("ninjaone", { clientId: "abc", clientSecret: "s3cret" }, actor.id);
    const conn = await getConnection("ninjaone");
    expect(conn.credentialsEnc).not.toContain("s3cret");
    expect(await getCredentials("ninjaone")).toEqual({ clientId: "abc", clientSecret: "s3cret" });
  });

  it("refuses to link one external record to two local records, or one local to two external", async () => {
    const other = await createCompany(companySchema.parse({ name: "Other Ltd", website: "otherltd.example" }), actor.id);
    await createLink({ provider: "xero", entityType: "company", localId: companyId, externalId: "xero-1", externalName: "Proposal Test Ltd" }, actor.id);
    await expect(createLink({ provider: "xero", entityType: "company", localId: other, externalId: "xero-1" }, actor.id)).rejects.toThrow(/already linked/);
    await expect(createLink({ provider: "xero", entityType: "company", localId: companyId, externalId: "xero-2" }, actor.id)).rejects.toThrow(/already linked/);
    expect((await getLink("xero", "company", companyId))?.externalId).toBe("xero-1");
  });

  it("de-duplicates inbound events", async () => {
    const a = await recordInboundEvent("xero", "evt-1", "INVOICE.UPDATE", { x: 1 });
    const b = await recordInboundEvent("xero", "evt-1", "INVOICE.UPDATE", { x: 1 });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it("outbound: performs once, reuses the result on retry, reconciles after failure, blocks concurrent in-flight", async () => {
    let performed = 0;
    const perform = async () => {
      performed++;
      return { externalId: `ext-${performed}` };
    };
    const first = await runOutbound("xero", "test:key:1", "invoice.create", actor.id, { perform });
    const second = await runOutbound("xero", "test:key:1", "invoice.create", actor.id, { perform });
    expect(first).toMatchObject({ result: { externalId: "ext-1" }, reused: false });
    expect(second).toMatchObject({ result: { externalId: "ext-1" }, reused: true });
    expect(performed).toBe(1);

    // Failure then retry: reconcile finds the record at the provider, so perform is not called again.
    await expect(runOutbound("xero", "test:key:2", "invoice.create", actor.id, { perform: async () => { throw new Error("network"); } })).rejects.toThrow("network");
    const [failed] = await db.select().from(outboundRequests).where(eq(outboundRequests.idempotencyKey, "test:key:2"));
    expect(failed.status).toBe("failed");
    let performedAgain = 0;
    const retried = await runOutbound("xero", "test:key:2", "invoice.create", actor.id, { perform: async () => { performedAgain++; return { externalId: "should-not" }; }, reconcile: async () => ({ externalId: "found-at-provider" }) });
    expect(retried.result.externalId).toBe("found-at-provider");
    expect(performedAgain).toBe(0);

    // In-flight rows block a second caller.
    await db.update(outboundRequests).set({ status: "in_flight", updatedAt: new Date() }).where(eq(outboundRequests.idempotencyKey, "test:key:2"));
    await expect(runOutbound("xero", "test:key:2", "invoice.create", actor.id, { perform })).rejects.toBeInstanceOf(OutboundInFlightError);
  });

  it("runSync records runs, counts errors as partial, and opens the circuit breaker after repeated failures", async () => {
    const ok = await runSync("ninjaone", "test.sync", "manual", async ({ counters, fail }) => {
      counters.fetched = 3;
      await fail("one bad row", { externalId: "d-1" });
      return "done";
    }, actor.id);
    expect(ok?.status).toBe("partial");
    for (let i = 0; i < 3; i++) await runSync("ninjaone", "test.sync", "manual", async () => { throw new Error("HTTP 500"); });
    const conn = await getConnection("ninjaone");
    expect(conn.status).toBe("error");
    expect(conn.consecutiveFailures).toBe(3);
    expect(conn.pausedUntil && conn.pausedUntil > new Date()).toBe(true);
    const skipped = await runSync("ninjaone", "test.sync", "schedule", async () => "should not run");
    expect(skipped).toBeNull();
    const runs = await listSyncRuns("ninjaone");
    expect(runs.length).toBeGreaterThanOrEqual(4);
  });
});

describe("Better Proposals workflow (demo adapter)", () => {
  it("creates a proposal once per opportunity version, links company and opportunity, and does not duplicate on retry", async () => {
    demoReset();
    const oppId = await createOpportunity(opportunitySchema.parse({ companyId, title: "Proposal deal", stageId: leadStageId }), [], actor.id);
    const first = await createProposalForOpportunity({ opportunityId: oppId, contactIds: [contactId], mergeTags: { contract_term: "36 months" } }, actor.id);
    const again = await createProposalForOpportunity({ opportunityId: oppId, contactIds: [contactId], mergeTags: {} }, actor.id);
    expect(first.mode).toBe("demo");
    expect(again.externalId).toBe(first.externalId);
    expect(again.reused).toBe(true);
    expect((await getLink("betterproposals", "company", companyId))?.externalId).toBeTruthy();
    expect((await getLink("betterproposals", "opportunity", oppId))?.externalId).toBe(first.externalId);
    const mirrored = await db.select().from(bpProposals).where(eq(bpProposals.externalId, first.externalId));
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].opportunityId).toBe(oppId);

    // A second version creates a new proposal.
    const v2 = await createProposalForOpportunity({ opportunityId: oppId, contactIds: [contactId], mergeTags: {}, version: 2 }, actor.id);
    expect(v2.externalId).not.toBe(first.externalId);
  });

  it("refuses contacts without email and closed opportunities", async () => {
    const noEmail = await createContact(contactSchema.parse({ companyId, firstName: "No", lastName: "Email" }), actor.id);
    const oppId = await createOpportunity(opportunitySchema.parse({ companyId, title: "Bad deal", stageId: leadStageId }), [], actor.id);
    await expect(createProposalForOpportunity({ opportunityId: oppId, contactIds: [noEmail], mergeTags: {} }, actor.id)).rejects.toThrow(/no email/);
    await expect(createProposalForOpportunity({ opportunityId: oppId, contactIds: [], mergeTags: {} }, actor.id)).rejects.toThrow(ActionError);
  });

  it("polling detects signature and runs acceptance exactly once: won, onboarding, contract stamped", async () => {
    const oppId = await createOpportunity(
      opportunitySchema.parse({ companyId, title: "Sign me", stageId: leadStageId }),
      [{ id: null, productId: null, description: "Managed IT", revenueType: "recurring", pricingModel: "per_user", billingFrequency: "monthly", quantity: 5, unitPrice: 40, unitCost: 15 }],
      actor.id,
    );
    const created = await createProposalForOpportunity({ opportunityId: oppId, contactIds: [contactId], mergeTags: {} }, actor.id);
    let sync = await syncProposals("manual", actor.id);
    expect(sync?.status).toBe("success");
    let [opp] = await db.select().from(opportunities).where(eq(opportunities.id, oppId));
    expect(opp.status).toBe("open");

    demoAdvance(created.externalId, "opened");
    await syncProposals("manual", actor.id);
    let [p] = await db.select().from(bpProposals).where(eq(bpProposals.externalId, created.externalId));
    expect(p.status).toBe("opened");
    expect(p.openedAt).toBeTruthy();

    demoAdvance(created.externalId, "signed", "Pat Signer");
    sync = await syncProposals("manual", actor.id);
    expect(sync?.status).toBe("success");
    [p] = await db.select().from(bpProposals).where(eq(bpProposals.externalId, created.externalId));
    expect(p.status).toBe("signed");
    expect(p.acceptanceProcessedAt).toBeTruthy();
    [opp] = await db.select().from(opportunities).where(eq(opportunities.id, oppId));
    expect(opp.status).toBe("won");
    const obs = await db.select().from(onboardings).where(eq(onboardings.sourceKey, `proposal:${created.externalId}`));
    expect(obs).toHaveLength(1);
    const cs = await db.select().from(contracts).where(eq(contracts.opportunityId, oppId));
    expect(cs).toHaveLength(1);
    expect(cs[0].externalProposalId).toBe(created.externalId);
    const [company] = await db.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
    expect(company.status).toBe("customer");

    // Polling again (and paid) changes nothing.
    demoAdvance(created.externalId, "paid");
    await syncProposals("manual", actor.id);
    expect(await processAcceptance(created.externalId, null)).toMatchObject({ already: true });
    expect(await db.select().from(onboardings).where(eq(onboardings.sourceKey, `proposal:${created.externalId}`))).toHaveLength(1);
    expect(await db.select().from(contracts).where(eq(contracts.opportunityId, oppId))).toHaveLength(1);
  });

  it("a signed proposal that is not linked raises a conflict instead of guessing", async () => {
    const { listOpenConflicts } = await import("@/services/integrations");
    // Demo seed includes an already-signed proposal for a company that does not exist here.
    await syncProposals("manual", actor.id);
    const conflicts = await listOpenConflicts("betterproposals");
    expect(conflicts.some((c) => /not linked to an opportunity/.test(c.message))).toBe(true);
  });
});
