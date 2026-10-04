import { and, desc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, contractLines, contracts, hostingItems, invoiceDrafts, pax8Subscriptions, serviceCoverage, xeroInvoices } from "@/db/schema";
import { previewBillingRun } from "./billing-run";
import { serviceRegisterRows } from "./service-register";
import { createdDraftsChangedInXero, listInvoiceDrafts } from "./xero";
import { pax8InvoiceReconciliation } from "./pax8";

/**
 * Billing findings: the brief's table of things that need a decision, read
 * from the register, the coverage planner, the drafts, the Xero mirror and
 * the Pax8 reconciliation together, each with the interpretation it asks for
 * and a link to where it is resolved. Nothing here changes data.
 */
export type FindingKind =
  | "unmapped_service"
  | "review_overdue"
  | "covered_no_charge"
  | "expected_missing"
  | "draft_waiting"
  | "invoice_differs"
  | "supplier_differs"
  | "supplier_no_customer"
  | "outside_crm_invoice";

export const FINDING_KINDS: { kind: FindingKind; label: string; interpretation: string }[] = [
  { kind: "unmapped_service", label: "Service without commercial coverage", interpretation: "Potential missed revenue: nobody has said how this is charged." },
  { kind: "review_overdue", label: "Free arrangement past its review date", interpretation: "Decide whether it stays free, is charged, or ends." },
  { kind: "covered_no_charge", label: "Covered service without an expected charge", interpretation: "The line that is supposed to pay for it is on a contract that is not active, or has quantity 0. Agreement or calculation needs investigation." },
  { kind: "expected_missing", label: "Expected charge not yet drafted", interpretation: "A line period is due and no draft carries it. Run the billing run, or set Bill from on the contract." },
  { kind: "draft_waiting", label: "Draft waiting more than a week", interpretation: "Billing workflow: approve it, re-prepare it, or cancel it." },
  { kind: "invoice_differs", label: "Customer invoice differs from what was approved", interpretation: "Changed, voided or deleted in Xero after approval. Adjustment or error needs an explanation." },
  { kind: "supplier_differs", label: "Supplier charge differs from expectation", interpretation: "Pax8 invoiced something other than the bill in Xero or the subscription price. Purchasing discrepancy." },
  { kind: "supplier_no_customer", label: "Supplier charge without a customer", interpretation: "Cost that cannot be allocated: link the Pax8 company or mark the charge as internal." },
  { kind: "outside_crm_invoice", label: "Customer invoice raised outside the CRM", interpretation: "Informational: a sales invoice in Xero that no CRM draft produced. Fine for ad-hoc work; a recurring one means a contract is missing." },
];

export type Finding = {
  kind: FindingKind;
  severity: "red" | "amber" | "slate";
  companyId: string | null;
  companyName: string | null;
  title: string;
  detail: string | null;
  amount: number | null;
  currency: string | null;
  href: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function billingFindings(opts: { asOf?: string; staleDays?: number } = {}) {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const staleDays = opts.staleDays ?? 7;
  const findings: Finding[] = [];

  // 1 & 2. Register: unmapped services and overdue free reviews.
  const register = await serviceRegisterRows(null);
  for (const r of register) {
    if (r.state === "unmapped" && !r.key.startsWith("ninja_summary:"))
      findings.push({ kind: "unmapped_service", severity: "amber", companyId: r.companyId, companyName: r.companyName, title: `${r.name} (${r.kind})`, detail: r.quantity && r.quantity > 1 ? `${r.quantity} units` : null, amount: r.monthlyCost, currency: null, href: r.href });
    if (r.state === "unmapped" && r.key.startsWith("ninja_summary:"))
      findings.push({ kind: "unmapped_service", severity: "amber", companyId: r.companyId, companyName: r.companyName, title: r.name, detail: "no per-device line is compared with NinjaOne for this customer", amount: null, currency: null, href: r.href });
    if (r.reviewOverdue) findings.push({ kind: "review_overdue", severity: "amber", companyId: r.companyId, companyName: r.companyName, title: `${r.name} free since review date ${r.reviewOn}`, detail: r.reason, amount: r.monthlyCost, currency: null, href: r.href });
  }

  // 3. Covered by a line that cannot charge: contract not active, or quantity 0.
  const coveringLines = await db
    .select({ lineId: contractLines.id, description: contractLines.description, quantity: contractLines.quantity, contractId: contracts.id, contractName: contracts.name, contractStatus: contracts.status, companyId: contracts.companyId, companyName: companies.name })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .where(
      and(
        isNull(contracts.archivedAt),
        or(ne(contracts.status, "active"), sql`${contractLines.quantity} = 0`),
        or(
          sql`exists (select 1 from pax8_subscriptions ps where ps.contract_line_id = ${contractLines.id} and ps.external_status = 'active')`,
          sql`exists (select 1 from hosting_items hi where hi.contract_line_id = ${contractLines.id} and hi.external_status = 'active')`,
          sql`exists (select 1 from service_coverage sc where sc.contract_line_id = ${contractLines.id})`,
        ),
      ),
    );
  for (const l of coveringLines)
    findings.push({ kind: "covered_no_charge", severity: "red", companyId: l.companyId, companyName: l.companyName, title: `${l.description} on ${l.contractName}`, detail: l.contractStatus !== "active" ? `contract is ${l.contractStatus}` : "line quantity is 0", amount: null, currency: null, href: `/contracts/${l.contractId}` });

  // 4. Expected charges not yet drafted (what the billing run would propose today).
  const run = await previewBillingRun(asOf);
  for (const r of run) {
    if (r.skipReason || !r.items.length) continue;
    findings.push({ kind: "expected_missing", severity: r.missedCount ? "red" : "amber", companyId: r.companyId, companyName: r.companyName, title: `${r.contractName}: ${r.items.length} line period${r.items.length === 1 ? "" : "s"} due${r.missedCount ? `, ${r.missedCount} missed` : ""}`, detail: r.period ? `${r.period.periodStart} to ${r.period.periodEnd}` : null, amount: r.net, currency: null, href: `/billing/run?asOf=${asOf}` });
  }

  // 5. Drafts waiting too long.
  const drafts = await listInvoiceDrafts("all");
  const cutoff = Date.now() - staleDays * 86400000;
  for (const d of drafts) {
    if (!["draft", "failed", "approved"].includes(d.status) || d.createdAt.getTime() > cutoff) continue;
    const days = Math.floor((Date.now() - d.createdAt.getTime()) / 86400000);
    findings.push({ kind: "draft_waiting", severity: d.status === "failed" ? "red" : "amber", companyId: d.companyId, companyName: d.companyName, title: `${d.reference} ${d.status} for ${days} days${d.stale ? ", stale" : ""}`, detail: d.lastError ?? d.description, amount: Number(d.subTotal), currency: d.currencyCode, href: `/billing/drafts/${d.id}` });
  }

  // 6. Customer invoices changed in Xero after approval.
  for (const c of await createdDraftsChangedInXero(100))
    findings.push({ kind: "invoice_differs", severity: c.diff!.status === "VOIDED" || c.diff!.status === "DELETED" ? "red" : "amber", companyId: c.companyId, companyName: c.companyName, title: `${c.reference} (${c.xeroInvoiceNumber ?? "Xero"}) ${c.diff!.status === "VOIDED" || c.diff!.status === "DELETED" ? c.diff!.status.toLowerCase() : "amount changed"}`, detail: c.diff!.xeroSubTotal === null ? null : `approved ${c.diff!.approvedSubTotal.toFixed(2)}, Xero ${c.diff!.xeroSubTotal.toFixed(2)}`, amount: c.diff!.difference, currency: c.currencyCode, href: `/billing/drafts/${c.id}` });

  // 7 & 8. Supplier side from the Pax8 reconciliation.
  const recon = await pax8InvoiceReconciliation();
  for (const r of recon.rows) {
    if (r.state === "amount_differs") findings.push({ kind: "supplier_differs", severity: "amber", companyId: null, companyName: null, title: `Pax8 invoice ${r.pax8InvoiceId} vs bill ${r.bill?.invoiceNumber ?? r.bill?.invoiceId}`, detail: "invoice total and Xero bill total differ", amount: r.difference, currency: r.currency, href: `/integrations/pax8/invoices/${encodeURIComponent(r.pax8InvoiceId)}` });
    if (r.state === "no_bill" && r.status?.toLowerCase() !== "unpaid") findings.push({ kind: "supplier_differs", severity: "amber", companyId: null, companyName: null, title: `Pax8 invoice ${r.pax8InvoiceId} has no bill in Xero`, detail: r.status, amount: r.total, currency: r.currency, href: `/integrations/pax8` });
    if (r.allocation && r.allocation.findings.price_differs > 0) findings.push({ kind: "supplier_differs", severity: "amber", companyId: null, companyName: null, title: `Pax8 invoice ${r.pax8InvoiceId}: ${r.allocation.findings.price_differs} charge${r.allocation.findings.price_differs === 1 ? "" : "s"} priced differently from the subscription`, detail: null, amount: null, currency: r.currency, href: `/integrations/pax8/invoices/${encodeURIComponent(r.pax8InvoiceId)}` });
    if (r.allocation && r.allocation.unallocated > 0) findings.push({ kind: "supplier_no_customer", severity: "amber", companyId: null, companyName: null, title: `Pax8 invoice ${r.pax8InvoiceId}: ${r.allocation.findings.no_customer + r.allocation.findings.no_subscription} charge${r.allocation.findings.no_customer + r.allocation.findings.no_subscription === 1 ? "" : "s"} not allocated to a customer`, detail: r.allocation.findings.no_customer ? "Pax8 company not linked to a CRM company" : "no mirrored subscription explains the charge", amount: r.allocation.unallocated, currency: r.currency, href: `/integrations/pax8/invoices/${encodeURIComponent(r.pax8InvoiceId)}` });
  }
  for (const b of recon.unmatchedBills) findings.push({ kind: "supplier_differs", severity: "amber", companyId: null, companyName: null, title: `Xero bill ${b.invoiceNumber ?? b.invoiceId} has no Pax8 invoice`, detail: b.reference, amount: b.total, currency: b.currencyCode, href: `/integrations/pax8` });

  // 9. Sales invoices in Xero for linked companies that no CRM draft produced (last 90 days).
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const outside = await db
    .select({ invoiceId: xeroInvoices.invoiceId, number: xeroInvoices.invoiceNumber, reference: xeroInvoices.reference, date: xeroInvoices.date, total: xeroInvoices.total, currency: xeroInvoices.currencyCode, companyId: xeroInvoices.companyId, companyName: companies.name, url: xeroInvoices.onlineInvoiceUrl })
    .from(xeroInvoices)
    .innerJoin(companies, eq(companies.id, xeroInvoices.companyId))
    .where(and(eq(xeroInvoices.type, "ACCREC"), gte(xeroInvoices.date, since), notInArray(xeroInvoices.status, ["DRAFT", "VOIDED", "DELETED"]), or(isNull(xeroInvoices.reference), sql`${xeroInvoices.reference} not like 'CRM-%'`)))
    .orderBy(desc(xeroInvoices.date))
    .limit(100);
  for (const i of outside) findings.push({ kind: "outside_crm_invoice", severity: "slate", companyId: i.companyId, companyName: i.companyName, title: `${i.number ?? i.invoiceId}${i.reference ? ` · ${i.reference}` : ""}`, detail: i.date, amount: i.total === null ? null : round2(Number(i.total)), currency: i.currency, href: `/companies/${i.companyId}?tab=invoices` });

  const counts = Object.fromEntries(FINDING_KINDS.map((k) => [k.kind, findings.filter((f) => f.kind === k.kind).length])) as Record<FindingKind, number>;
  const order: Record<Finding["severity"], number> = { red: 0, amber: 1, slate: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || FINDING_KINDS.findIndex((k) => k.kind === a.kind) - FINDING_KINDS.findIndex((k) => k.kind === b.kind) || (a.companyName ?? "").localeCompare(b.companyName ?? ""));
  return { asOf, findings, counts, total: findings.length, actionable: findings.filter((f) => f.severity !== "slate").length };
}

/** Unused-import guard for schema tables referenced only in SQL fragments. */
void pax8Subscriptions;
void hostingItems;
void serviceCoverage;
void invoiceDrafts;
void inArray;
