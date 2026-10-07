import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { contractLines, contracts, integrationConnections, pax8Companies, ninjaOrganizations, hostingItems, externalLinks } from "@/db/schema";
import { getAppSettings } from "@/lib/settings";
import { PERIOD_MONTHS } from "@/lib/billing";
import { PROVIDER_LABELS, type ProviderKey } from "@/lib/billing-model";
import { billingFindings, FINDING_KINDS, type FindingKind } from "./billing-findings";
import { billingWorkspace } from "./billing-workspace";
import { reviewPendingDrafts } from "./draft-review";
import { listDiscrepancies } from "./ninjaone";
import { renewalQueue } from "./renewals";
import { serviceRegisterRows } from "./service-register";
import { matchableLinesFor } from "./service-links";

/**
 * The "needs attention" queue: everything across billing that a person
 * should look at, from every check the system runs, in one list with one
 * vocabulary. Each item says what it is, which customer, how much is at
 * stake where that is known, and links to where it is dealt with. Nothing
 * here changes data; it reads the findings, the review queue, the service
 * register, the drafts, the renewals and the integration mappings.
 */
export type AttentionGroup = "matching" | "quantities" | "prices" | "data" | "drafts" | "invoices" | "renewals" | "supplier";

export type AttentionKind =
  | "unlinked_account"
  | "unmapped_service"
  | "duplicate_service"
  | "count_differs"
  | "quantity_change"
  | "cost_stale"
  | "review_overdue"
  | "stale_data"
  | "xero_unlinked"
  | "draft_failed"
  | "draft_exception"
  | "draft_waiting"
  | "expected_missing"
  | "covered_no_charge"
  | "invoice_differs"
  | "outside_crm_invoice"
  | "supplier_differs"
  | "supplier_no_customer"
  | "renewal_overdue"
  | "renewal_due";

export const ATTENTION_GROUPS: { key: AttentionGroup; label: string }[] = [
  { key: "matching", label: "Matching" },
  { key: "quantities", label: "Quantities" },
  { key: "prices", label: "Prices and costs" },
  { key: "data", label: "Data" },
  { key: "drafts", label: "Drafts" },
  { key: "invoices", label: "Invoices" },
  { key: "renewals", label: "Renewals" },
  { key: "supplier", label: "Supplier bills" },
];

export const ATTENTION_KINDS: Record<AttentionKind, { label: string; group: AttentionGroup; what: string }> = {
  unlinked_account: { label: "Provider account not matched to a customer", group: "matching", what: "Services under it cannot be billed or costed until the account is linked." },
  unmapped_service: { label: "Service not mapped to a charge", group: "matching", what: "Possible missed revenue: choose the line that bills it, or record that it is bundled, covered, free or internal." },
  duplicate_service: { label: "Possible duplicate service", group: "matching", what: "The same supplier product appears more than once for one customer; check nothing is charged twice or supplied twice." },
  count_differs: { label: "Supplied count differs from the agreement", group: "quantities", what: "The line is fixed, so decide: amend the line, reduce at renewal, bundle, accept as an exception or dismiss." },
  quantity_change: { label: "Quantity change to approve", group: "quantities", what: "The line is synced from the integrations; approving records the new quantity from the day it changed and the next invoice pro-rates it." },
  cost_stale: { label: "Supplier cost differs from the recorded cost", group: "prices", what: "The supplier's price changed; margin figures use the supplier price, but the recorded cost on the line is out of date." },
  review_overdue: { label: "Free arrangement past its review date", group: "prices", what: "Decide whether it stays free, is charged, or ends." },
  stale_data: { label: "Integration data is stale", group: "data", what: "The last successful sync is more than three hours old; counts and costs may be out of date." },
  xero_unlinked: { label: "Customer not linked to Xero", group: "drafts", what: "Drafts can be prepared but not approved until the Xero contact is linked." },
  draft_failed: { label: "Draft rejected by Xero", group: "drafts", what: "Fix the error on the draft and approve again." },
  draft_exception: { label: "Draft differs from the previous invoice", group: "drafts", what: "Review the reasons and approve, re-prepare or cancel." },
  draft_waiting: { label: "Draft waiting more than a week", group: "drafts", what: "Approve it, re-prepare it, or cancel it." },
  expected_missing: { label: "Charge due but not drafted", group: "drafts", what: "Run the monthly run, or set Bill from on the contract." },
  covered_no_charge: { label: "Service covered by a line that cannot charge", group: "quantities", what: "The line's contract is not active or its quantity is 0." },
  invoice_differs: { label: "Invoice changed in Xero after approval", group: "invoices", what: "Compare with the approved version and record why." },
  outside_crm_invoice: { label: "Invoice raised outside the CRM", group: "invoices", what: "Fine for ad-hoc work; a recurring one means a contract is missing." },
  supplier_differs: { label: "Supplier charge differs from expectation", group: "supplier", what: "Pax8 invoiced something other than the bill in Xero or the subscription price." },
  supplier_no_customer: { label: "Supplier charge without a customer", group: "supplier", what: "Link the Pax8 company or mark the charge as internal." },
  renewal_overdue: { label: "Renewal decision overdue", group: "renewals", what: "Past the decision deadline; record the customer's decision or prepare an amendment." },
  renewal_due: { label: "Renewal decision due", group: "renewals", what: "Inside the decision lead time." },
};

export type AttentionItem = {
  kind: AttentionKind;
  severity: "red" | "amber" | "slate";
  companyId: string | null;
  companyName: string | null;
  title: string;
  detail: string | null;
  amount: number | null;
  currency: string | null;
  href: string;
  provider: ProviderKey | null;
};

const FINDING_TO_KIND: Record<FindingKind, AttentionKind> = {
  unmapped_service: "unmapped_service",
  review_overdue: "review_overdue",
  covered_no_charge: "covered_no_charge",
  expected_missing: "expected_missing",
  draft_waiting: "draft_waiting",
  invoice_differs: "invoice_differs",
  supplier_differs: "supplier_differs",
  supplier_no_customer: "supplier_no_customer",
  outside_crm_invoice: "outside_crm_invoice",
};

const STALE_MS = 3 * 3600_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function attentionQueue(opts: { asOf?: string } = {}) {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const settings = await getAppSettings();
  const currency = settings.currency;
  const [findings, open, drafts, renewals, workspace, register, connections, pax8Unlinked, ninjaOrgs, ninjaLinks, hostingUnlinked] = await Promise.all([
    billingFindings({ asOf }),
    listDiscrepancies({ status: "open" }),
    reviewPendingDrafts(currency),
    renewalQueue(asOf),
    billingWorkspace(asOf, currency),
    serviceRegisterRows(null),
    db.select().from(integrationConnections),
    db.select({ id: pax8Companies.id, name: pax8Companies.name, pax8Id: pax8Companies.pax8Id }).from(pax8Companies).where(and(isNull(pax8Companies.companyId), eq(pax8Companies.externalStatus, "active"))),
    db.select({ orgId: ninjaOrganizations.orgId, name: ninjaOrganizations.name }).from(ninjaOrganizations).where(eq(ninjaOrganizations.externalStatus, "active")),
    db.select({ externalId: externalLinks.externalId }).from(externalLinks).where(and(eq(externalLinks.provider, "ninjaone"), eq(externalLinks.entityType, "company"))),
    db.select({ id: hostingItems.id, name: hostingItems.name, kind: hostingItems.kind }).from(hostingItems).where(and(isNull(hostingItems.companyId), eq(hostingItems.externalStatus, "active"), inArray(hostingItems.kind, ["package", "domain"]))),
  ]);
  const items: AttentionItem[] = [];

  // Findings already carry severity and a link; they keep their kind under the shared vocabulary.
  for (const f of findings.findings) items.push({ kind: FINDING_TO_KIND[f.kind], severity: f.severity, companyId: f.companyId, companyName: f.companyName, title: f.title, detail: f.detail, amount: f.amount, currency: f.currency ?? (f.amount !== null ? currency : null), href: f.href, provider: f.kind === "unmapped_service" ? (register.find((r) => r.href === f.href && r.name === f.title.split(" (")[0])?.provider ?? null) : f.kind.startsWith("supplier") ? "pax8" : null });

  // Count differences: a proposed change on a synced line, an exception to decide on a fixed line.
  const lineIds = [...new Set(open.map((d) => d.contractLineId))];
  const rules = lineIds.length ? await db.select({ id: contractLines.id, quantityRule: contractLines.quantityRule }).from(contractLines).where(inArray(contractLines.id, lineIds)) : [];
  const ruleOf = new Map(rules.map((r) => [r.id, r.quantityRule]));
  for (const d of open) {
    const diff = Number(d.difference);
    const synced = ruleOf.get(d.contractLineId) === "synced";
    const perPeriod = d.unitPrice ? round2(Math.abs(diff) * Number(d.unitPrice)) : null;
    items.push({ kind: synced ? "quantity_change" : "count_differs", severity: "amber", companyId: d.companyId, companyName: d.companyName, title: `${d.lineDescription}: agreed ${Number(d.contractedQty)}, ${PROVIDER_LABELS[d.source as ProviderKey] ?? d.source} supplies ${d.observedQty} (${diff > 0 ? "+" : ""}${diff})`, detail: diff > 0 ? `≈ ${perPeriod === null ? "?" : perPeriod} per period unbilled` : `≈ ${perPeriod === null ? "?" : perPeriod} per period over-billed`, amount: perPeriod, currency, href: `/companies/${d.companyId}?tab=billing`, provider: d.source as ProviderKey });
  }

  // Supplier cost differs from the recorded cost (per charged line, from the register's live costs).
  const companyIds = [...new Set(register.map((r) => r.companyId))];
  const lines = await matchableLinesFor(companyIds, ["active"]);
  const costByLine = new Map<string, { observed: number; cost: number; priced: number; total: number; companyId: string }>();
  for (const r of register) {
    if (!r.line || (r.state !== "charged" && r.state !== "bundle") || r.pool) continue;
    const cur = costByLine.get(r.line.id) ?? { observed: 0, cost: 0, priced: 0, total: 0, companyId: r.companyId };
    cur.observed += r.quantity;
    cur.total++;
    if (r.monthlyCost !== null) {
      cur.cost += r.monthlyCost;
      cur.priced++;
    }
    costByLine.set(r.line.id, cur);
  }
  for (const [lineId, c] of costByLine) {
    if (!c.priced || c.priced !== c.total || !c.observed) continue;
    const line = (lines.get(c.companyId) ?? []).find((l) => l.id === lineId);
    if (!line) continue;
    const months = PERIOD_MONTHS[line.billingFrequency] ?? 1;
    const supplier = c.cost / c.observed;
    const recorded = line.unitCost === null ? null : Number(line.unitCost) / months;
    if (recorded !== null && Math.abs(supplier - recorded) <= 0.01) continue;
    const name = register.find((r) => r.companyId === c.companyId)?.companyName ?? null;
    items.push({ kind: "cost_stale", severity: "amber", companyId: c.companyId, companyName: name, title: `${line.description} (${line.contractName}): supplier ${round2(supplier * months)} per unit, recorded ${recorded === null ? "nothing" : round2(recorded * months)}`, detail: `${round2(c.cost)} per month supplier cost for ${c.observed} units`, amount: round2((supplier - (recorded ?? 0)) * Number(line.quantity)), currency, href: `/companies/${c.companyId}?tab=billing`, provider: "pax8" });
  }

  // Possible duplicates: the same supplier product more than once for one customer.
  const seen = new Map<string, typeof register>();
  for (const r of register) {
    if (r.pool || r.state === "internal") continue;
    const key = `${r.companyId}:${r.provider}:${(r.supplierProduct ?? r.name).toLowerCase()}`;
    seen.set(key, [...(seen.get(key) ?? []), r]);
  }
  for (const group of seen.values()) {
    if (group.length < 2) continue;
    const r = group[0];
    items.push({ kind: "duplicate_service", severity: "amber", companyId: r.companyId, companyName: r.companyName, title: `${r.name} appears ${group.length} times at ${r.providerLabel}`, detail: group.map((g) => `${g.quantity} × ${g.state}`).join(", "), amount: group.reduce((a, g) => a + (g.monthlyCost ?? 0), 0) || null, currency, href: r.href, provider: r.provider });
  }

  // Provider accounts not matched to a customer.
  for (const p of pax8Unlinked) items.push({ kind: "unlinked_account", severity: "amber", companyId: null, companyName: null, title: `Pax8 company "${p.name}"`, detail: "Link it to a CRM company on Integrations → Pax8", amount: null, currency: null, href: "/integrations/pax8", provider: "pax8" });
  const linkedOrgs = new Set(ninjaLinks.map((l) => l.externalId));
  for (const o of ninjaOrgs) if (!linkedOrgs.has(o.orgId)) items.push({ kind: "unlinked_account", severity: "amber", companyId: null, companyName: null, title: `NinjaOne organisation "${o.name}"`, detail: "Link it to a CRM company on Integrations → NinjaOne", amount: null, currency: null, href: "/integrations/ninjaone", provider: "ninjaone" });
  for (const h of hostingUnlinked) items.push({ kind: "unlinked_account", severity: "amber", companyId: null, companyName: null, title: `20i ${h.kind} "${h.name}"`, detail: "Link it to a CRM company on Integrations → 20i", amount: null, currency: null, href: "/integrations/twentyi", provider: "twentyi" });

  // Stale integration data.
  for (const c of connections) {
    if (!["pax8", "ninjaone", "twentyi"].includes(c.provider) || c.status !== "connected") continue;
    const last = c.lastSuccessfulSyncAt ?? null;
    if (last && Date.now() - last.getTime() <= STALE_MS) continue;
    items.push({ kind: "stale_data", severity: "amber", companyId: null, companyName: null, title: `${PROVIDER_LABELS[c.provider as ProviderKey]} last synced ${last ? last.toISOString().slice(0, 16).replace("T", " ") : "never"}`, detail: "Run a sync from the integration page", amount: null, currency: null, href: `/integrations/${c.provider}`, provider: c.provider as ProviderKey });
  }

  // Drafts and Xero links from the run and the review.
  for (const r of workspace.rows) if (r.status === "blocked") items.push({ kind: "xero_unlinked", severity: "red", companyId: r.companyId, companyName: r.companyName, title: `${r.companyName}: ${r.contractName}`, detail: r.blockers.join("; "), amount: r.net, currency, href: "/integrations/xero", provider: null });
  for (const d of drafts) {
    if (d.status === "failed") items.push({ kind: "draft_failed", severity: "red", companyId: d.companyId, companyName: d.companyName, title: d.reference, detail: d.lastError ?? null, amount: Number(d.subTotal), currency: d.currencyCode, href: `/billing/drafts/${d.id}`, provider: null });
    else if (d.verdict !== "unchanged") items.push({ kind: "draft_exception", severity: "amber", companyId: d.companyId, companyName: d.companyName, title: d.reference, detail: d.flags.slice(0, 3).join("; "), amount: Number(d.subTotal), currency: d.currencyCode, href: `/billing/drafts/${d.id}`, provider: null });
  }
  for (const r of renewals) {
    if (r.status === "overdue") items.push({ kind: "renewal_overdue", severity: "red", companyId: r.companyId, companyName: r.companyName, title: `${r.contractName}: decision was due ${r.decideBy}`, detail: r.mismatches[0] ?? null, amount: r.exposureTotal || null, currency, href: `/contracts/${r.contractId}`, provider: null });
    else if (r.status === "due") items.push({ kind: "renewal_due", severity: "amber", companyId: r.companyId, companyName: r.companyName, title: `${r.contractName}: decide by ${r.decideBy}`, detail: r.mismatches[0] ?? null, amount: r.exposureTotal || null, currency, href: `/contracts/${r.contractId}`, provider: null });
  }

  const order: Record<AttentionItem["severity"], number> = { red: 0, amber: 1, slate: 2 };
  const groupOrder = ATTENTION_GROUPS.map((g) => g.key);
  items.sort((a, b) => order[a.severity] - order[b.severity] || groupOrder.indexOf(ATTENTION_KINDS[a.kind].group) - groupOrder.indexOf(ATTENTION_KINDS[b.kind].group) || (a.companyName ?? "~").localeCompare(b.companyName ?? "~"));
  const counts = Object.fromEntries(Object.keys(ATTENTION_KINDS).map((k) => [k, items.filter((i) => i.kind === k).length])) as Record<AttentionKind, number>;
  const groups = Object.fromEntries(ATTENTION_GROUPS.map((g) => [g.key, items.filter((i) => ATTENTION_KINDS[i.kind].group === g.key).length])) as Record<AttentionGroup, number>;
  return { asOf, currency, items, counts, groups, red: items.filter((i) => i.severity === "red").length, actionable: items.filter((i) => i.severity !== "slate").length, workspace: workspace.summary, drafts: { total: drafts.length, unchanged: drafts.filter((d) => d.verdict === "unchanged").length } };
}

void FINDING_KINDS;
void contracts;
void sql;
