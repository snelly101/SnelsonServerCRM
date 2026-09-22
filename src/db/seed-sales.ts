import { eq, asc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * Phase 2 sample data: service catalogue, opportunities, contracts and tasks.
 * Called from seed.ts after companies exist. Idempotent: skips when products exist.
 */
export async function seedSales(db: NodePgDatabase<typeof schema>, userIds: Record<string, string>) {
  const existing = await db.select({ id: schema.products.id }).from(schema.products).limit(1);
  if (existing.length) return;

  const products = await db
    .insert(schema.products)
    .values([
      { sku: "MIT-USER", name: "Managed IT (per user)", category: "managed_it", pricingModel: "per_user", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "45.00", unitCost: "18.00", description: "Helpdesk, patching, monitoring and account management per user" },
      { sku: "MIT-DEV", name: "Managed device (RMM + patching)", category: "managed_it", pricingModel: "per_device", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "12.00", unitCost: "4.50", countsAsManagedDevice: true, description: "Endpoint monitoring, patching and remote support per device" },
      { sku: "M365-BP", name: "Microsoft 365 Business Premium", category: "microsoft_365", pricingModel: "per_user", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "18.10", unitCost: "16.60" },
      { sku: "M365-BS", name: "Microsoft 365 Business Standard", category: "microsoft_365", pricingModel: "per_user", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "10.30", unitCost: "9.40" },
      { sku: "SEC-EDR", name: "Managed EDR", category: "security", pricingModel: "per_device", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "6.50", unitCost: "3.20", countsAsManagedDevice: true },
      { sku: "SEC-SAT", name: "Security awareness training", category: "security", pricingModel: "per_user", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "2.50", unitCost: "1.10" },
      { sku: "BK-M365", name: "Microsoft 365 backup", category: "backup", pricingModel: "per_user", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "3.00", unitCost: "1.60" },
      { sku: "BK-SRV", name: "Server backup & DR", category: "backup", pricingModel: "fixed", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "120.00", unitCost: "55.00" },
      { sku: "NET-FW", name: "Managed firewall", category: "networking", pricingModel: "fixed", revenueType: "recurring", billingFrequency: "monthly", unitPrice: "65.00", unitCost: "30.00" },
      { sku: "HW-LAPTOP", name: "Business laptop (14\")", category: "hardware", pricingModel: "one_off", revenueType: "hardware", billingFrequency: "one_off", unitPrice: "899.00", unitCost: "760.00" },
      { sku: "HW-FW", name: "Firewall appliance", category: "hardware", pricingModel: "one_off", revenueType: "hardware", billingFrequency: "one_off", unitPrice: "650.00", unitCost: "520.00" },
      { sku: "CON-DAY", name: "Consultancy day", category: "consultancy", pricingModel: "one_off", revenueType: "one_off_project", billingFrequency: "one_off", unitPrice: "750.00", unitCost: null },
      { sku: "PRJ-ONB", name: "Onboarding project", category: "consultancy", pricingModel: "one_off", revenueType: "one_off_project", billingFrequency: "one_off", unitPrice: "1500.00", unitCost: "600.00" },
    ])
    .returning();
  const P = Object.fromEntries(products.map((p) => [p.sku!, p]));

  const stages = await db.select().from(schema.pipelineStages).orderBy(asc(schema.pipelineStages.sortOrder));
  const stage = (name: string) => stages.find((s) => s.name === name)!;
  const companies = await db.select({ id: schema.companies.id, name: schema.companies.name, status: schema.companies.status, ownerUserId: schema.companies.ownerUserId }).from(schema.companies);
  const byName = Object.fromEntries(companies.map((c) => [c.name, c]));
  const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  const line = (sku: string, quantity: number, over: Partial<typeof schema.opportunityLines.$inferInsert> = {}) => ({
    productId: P[sku].id,
    description: P[sku].name,
    revenueType: P[sku].revenueType,
    pricingModel: P[sku].pricingModel,
    billingFrequency: P[sku].billingFrequency,
    quantity: String(quantity),
    unitPrice: P[sku].unitPrice,
    unitCost: P[sku].unitCost,
    ...over,
  });

  // Opportunities
  const opps: { company: string; title: string; stage: string; close: number; source: string; next?: string; lines: ReturnType<typeof line>[]; status?: "won" | "lost"; lostReason?: string }[] = [
    { company: "Pennine Precision Engineering", title: "Managed IT for 40 users + EDR", stage: "Proposal", close: 21, source: "Referral", next: "Send proposal", lines: [line("MIT-USER", 40), line("MIT-DEV", 48), line("SEC-EDR", 48), line("PRJ-ONB", 1)] },
    { company: "The Old Mill Hotel", title: "Wi-Fi refresh and managed firewall", stage: "Discovery", close: 45, source: "Website", next: "Site survey", lines: [line("NET-FW", 1), line("HW-FW", 1), line("CON-DAY", 2)] },
    { company: "Calder Valley Vets", title: "M365 migration and backup", stage: "Negotiation", close: 10, source: "Event", next: "Agree start date", lines: [line("M365-BP", 12), line("BK-M365", 12), line("PRJ-ONB", 1)] },
    { company: "Aire Property Management", title: "Managed IT for 8 users", stage: "Lead", close: 60, source: "Cold outreach", lines: [line("MIT-USER", 8), line("MIT-DEV", 10)] },
    { company: "Northern Freight Solutions Ltd", title: "Laptop refresh (15 devices)", stage: "Proposal", close: 14, source: "Account review", next: "Confirm spec", lines: [line("HW-LAPTOP", 15), line("CON-DAY", 1)] },
    { company: "Greenfield Primary Academy", title: "Security awareness training", stage: "Won", close: -20, source: "Account review", lines: [line("SEC-SAT", 60)], status: "won" },
    { company: "Sheffield Steel Fabrications", title: "Managed IT renewal", stage: "Lost", close: -40, source: "Renewal", lines: [line("MIT-USER", 25)], status: "lost", lostReason: "Moved to in-house IT after acquisition" },
  ];
  for (const o of opps) {
    const c = byName[o.company];
    if (!c) continue;
    const st = stage(o.stage);
    const [row] = await db
      .insert(schema.opportunities)
      .values({
        companyId: c.id,
        title: o.title,
        stageId: st.id,
        status: o.status ?? "open",
        ownerUserId: c.ownerUserId ?? userIds["sales@example.com"],
        expectedCloseDate: day(o.close),
        probability: st.probability,
        leadSource: o.source,
        nextAction: o.next ?? null,
        nextActionDate: o.next ? day(3) : null,
        lostReason: o.lostReason ?? null,
        wonAt: o.status === "won" ? new Date(Date.now() + o.close * 86400000) : null,
        lostAt: o.status === "lost" ? new Date(Date.now() + o.close * 86400000) : null,
        createdByUserId: userIds["admin@example.com"],
      })
      .returning({ id: schema.opportunities.id });
    await db.insert(schema.opportunityLines).values(o.lines.map((l, i) => ({ ...l, opportunityId: row.id, sortOrder: i })));
    await db.insert(schema.activities).values({ type: "system", companyId: c.id, entityType: "opportunity", entityId: row.id, title: `Opportunity created: ${o.title}`, actorUserId: userIds["admin@example.com"] });
    if (!o.status) {
      await db.insert(schema.tasks).values({ title: o.next ?? `Follow up: ${o.title}`, priority: o.close < 15 ? "high" : "normal", dueDate: day(o.close < 15 ? -2 : 5), ownerUserId: c.ownerUserId, companyId: c.id, opportunityId: row.id, createdByUserId: userIds["admin@example.com"] });
    }
  }

  // Contracts for customers
  const contractsSeed: { company: string; name: string; start: number; end: number; review: number; lines: (ReturnType<typeof line> & { countsAsManagedDevice?: boolean })[] }[] = [
    { company: "Harrowgate Dental Practice", name: "Managed IT Agreement", start: -300, end: 65, review: 20, lines: [line("MIT-USER", 14), { ...line("MIT-DEV", 18), countsAsManagedDevice: true }, line("M365-BS", 14), line("BK-M365", 14)] },
    { company: "Northern Freight Solutions Ltd", name: "Managed IT & Security Agreement", start: -120, end: 245, review: 60, lines: [line("MIT-USER", 32), { ...line("MIT-DEV", 40), countsAsManagedDevice: true }, { ...line("SEC-EDR", 40), countsAsManagedDevice: true }, line("M365-BP", 32), line("BK-SRV", 1), line("NET-FW", 2)] },
    { company: "Bramley & Sons Accountants", name: "Managed IT Agreement", start: -400, end: -35, review: 10, lines: [line("MIT-USER", 9), { ...line("MIT-DEV", 11), countsAsManagedDevice: true }, line("M365-BP", 9)] },
    { company: "Ridgeway Architects LLP", name: "Managed IT Agreement", start: -200, end: 165, review: 90, lines: [line("MIT-USER", 18), { ...line("MIT-DEV", 24), countsAsManagedDevice: true }, line("M365-BS", 18), line("BK-SRV", 1)] },
    { company: "Greenfield Primary Academy", name: "Managed IT & Safeguarding Agreement", start: -90, end: 275, review: 45, lines: [line("MIT-USER", 60), { ...line("MIT-DEV", 85), countsAsManagedDevice: true }, line("SEC-SAT", 60), line("NET-FW", 1)] },
  ];
  for (const c of contractsSeed) {
    const company = byName[c.company];
    if (!company) continue;
    const [row] = await db
      .insert(schema.contracts)
      .values({ companyId: company.id, name: c.name, reference: `MSA-${String(1000 + Math.floor(Math.random() * 9000))}`, status: "active", startDate: day(c.start), endDate: day(c.end), renewalDate: day(c.end), noticePeriodDays: 90, autoRenew: true, billingFrequency: "monthly", nextReviewDate: day(c.review), reviewIntervalMonths: 6, ownerUserId: company.ownerUserId ?? userIds["am@example.com"] })
      .returning({ id: schema.contracts.id });
    await db.insert(schema.contractLines).values(c.lines.map((l, i) => ({ ...l, contractId: row.id, countsAsManagedDevice: Boolean(l.countsAsManagedDevice), sortOrder: i })));
    await db.insert(schema.activities).values({ type: "contract", companyId: company.id, entityType: "contract", entityId: row.id, title: `Contract created: ${c.name}`, actorUserId: userIds["admin@example.com"] });
  }

  // A few standalone tasks
  const dental = byName["Harrowgate Dental Practice"];
  if (dental) {
    await db.insert(schema.tasks).values([
      { title: "Chase signed DPA", priority: "normal", dueDate: day(-3), ownerUserId: userIds["am@example.com"], companyId: dental.id, createdByUserId: userIds["admin@example.com"] },
      { title: "Book quarterly review", priority: "low", dueDate: day(12), ownerUserId: userIds["am@example.com"], companyId: dental.id, createdByUserId: userIds["admin@example.com"] },
    ]);
  }
  await db.insert(schema.tasks).values({ title: "Update service catalogue prices for new financial year", priority: "normal", dueDate: day(20), ownerUserId: userIds["finance@example.com"], createdByUserId: userIds["admin@example.com"] });
  void eq;
}
