import { desc, and, eq } from "drizzle-orm";
import { db } from "@/db";
import { invoiceDrafts } from "@/db/schema";
import { getAppSettings } from "@/lib/settings";
import { billingWorkspace, type WorkspaceRow } from "./billing-workspace";
import { reviewPendingDrafts, type DraftReviewRow } from "./draft-review";
import { listDiscrepancies } from "./ninjaone";
import { renewalQueue, type RenewalRow } from "./renewals";
import { serviceRegisterRows, summariseRegister } from "./service-register";

/**
 * One customer's billing picture for the company page's Billing tab, built
 * from the same services the Billing area uses so the two always agree:
 * what the next run proposes for each agreement, drafts waiting, open count
 * discrepancies, services without coverage, renewals, and the "what to do
 * next" list narrowed to this customer.
 */
export type CompanyNextAction = { label: string; detail: string; href: string; tone: "red" | "amber" | "slate" };

export async function companyBilling(companyId: string, asOf = new Date().toISOString().slice(0, 10)) {
  const settings = await getAppSettings();
  const c = settings.currency;
  const [workspace, drafts, open, accepted, renewals, register, issued] = await Promise.all([
    billingWorkspace(asOf, c),
    reviewPendingDrafts(c),
    listDiscrepancies({ companyId, status: "open" }),
    listDiscrepancies({ companyId, status: "accepted" }),
    renewalQueue(asOf),
    serviceRegisterRows([companyId]),
    db.select({ id: invoiceDrafts.id, reference: invoiceDrafts.reference, description: invoiceDrafts.description, subTotal: invoiceDrafts.subTotal, currencyCode: invoiceDrafts.currencyCode, xeroInvoiceNumber: invoiceDrafts.xeroInvoiceNumber, createdInXeroAt: invoiceDrafts.createdInXeroAt, periodStart: invoiceDrafts.periodStart, periodEnd: invoiceDrafts.periodEnd }).from(invoiceDrafts).where(and(eq(invoiceDrafts.companyId, companyId), eq(invoiceDrafts.status, "created"))).orderBy(desc(invoiceDrafts.createdInXeroAt)).limit(12),
  ]);
  const rows: WorkspaceRow[] = workspace.rows.filter((r) => r.companyId === companyId);
  const pending: DraftReviewRow[] = drafts.filter((d) => d.companyId === companyId);
  const myRenewals: RenewalRow[] = renewals.filter((r) => r.companyId === companyId);
  const summary = summariseRegister(register);
  const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: c }).format(n);

  const next: CompanyNextAction[] = [];
  const blocked = rows.filter((r) => r.status === "blocked");
  if (blocked.length) next.push({ label: "Link this customer to its Xero contact", detail: "Drafts can be prepared but not approved until then.", href: "/integrations/xero", tone: "red" });
  const failed = pending.filter((d) => d.status === "failed");
  if (failed.length) next.push({ label: `Fix ${failed.length} failed approval${failed.length === 1 ? "" : "s"}`, detail: failed[0].lastError ?? "Xero did not accept the draft.", href: `/billing/drafts/${failed[0].id}`, tone: "red" });
  const overdueRenewals = myRenewals.filter((r) => r.status === "overdue");
  if (overdueRenewals.length) next.push({ label: `Renewal decision overdue for ${overdueRenewals.map((r) => r.contractName).join(", ")}`, detail: `Decision was due ${overdueRenewals[0].decideBy}; record the customer's decision or prepare an amendment.`, href: `/contracts/${overdueRenewals[0].contractId}`, tone: "red" });
  const ready = rows.filter((r) => r.status === "ready");
  const review = rows.filter((r) => r.status === "review");
  if (ready.length) next.push({ label: `Prepare ${ready.length} ready agreement${ready.length === 1 ? "" : "s"}`, detail: `${money(ready.reduce((a, r) => a + r.net, 0))} due this run, same as last time.`, href: "/billing/run?step=prepare", tone: "amber" });
  if (review.length) next.push({ label: `Review ${review.length} agreement${review.length === 1 ? "" : "s"} before preparing`, detail: review.flatMap((r) => r.attention).slice(0, 3).join("; "), href: "/billing/run?step=prepare", tone: "amber" });
  const unchanged = pending.filter((d) => d.verdict === "unchanged");
  if (unchanged.length) next.push({ label: `Approve ${unchanged.length} unchanged draft${unchanged.length === 1 ? "" : "s"}`, detail: unchanged.map((d) => d.reference).join(", "), href: "/billing/run?step=approve", tone: "amber" });
  const exceptions = pending.filter((d) => d.verdict !== "unchanged" && d.status !== "failed");
  if (exceptions.length) next.push({ label: `Review ${exceptions.length} draft exception${exceptions.length === 1 ? "" : "s"}`, detail: exceptions.flatMap((d) => d.flags).slice(0, 3).join("; "), href: `/billing/drafts/${exceptions[0].id}`, tone: "amber" });
  if (open.length) next.push({ label: `Resolve ${open.length} count discrepanc${open.length === 1 ? "y" : "ies"}`, detail: open.map((d) => `${d.lineDescription}: contracted ${Number(d.contractedQty)}, observed ${d.observedQty}`).join("; "), href: `/companies/${companyId}?tab=billing#discrepancies`, tone: "amber" });
  if (summary.unmapped) next.push({ label: `Decide ${summary.unmapped} unmapped service${summary.unmapped === 1 ? "" : "s"}`, detail: "Possibly missed revenue until mapped to a line, bundled, free or internal.", href: `/companies/${companyId}?tab=services`, tone: "amber" });
  const due = myRenewals.filter((r) => r.status === "due");
  if (due.length) next.push({ label: `Renewal decision due for ${due.map((r) => r.contractName).join(", ")}`, detail: due.flatMap((r) => r.mismatches).slice(0, 2).join("; ") || `Decide by ${due[0].decideBy}.`, href: `/contracts/${due[0].contractId}`, tone: "amber" });
  if (!next.length) next.push({ label: "Nothing waiting for this customer", detail: "Every due agreement is drafted or approved, no discrepancy or unmapped service is open.", href: "/billing", tone: "slate" });

  return { asOf, currency: c, rows, pending, issued, open, accepted, renewals: myRenewals, services: summary, next };
}
