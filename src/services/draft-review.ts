import { and, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { invoiceDrafts, type InvoiceDraftLine } from "@/db/schema";
import { audit } from "@/lib/audit";
import { getLink } from "./integrations";
import { approveAndCreateInvoice, listInvoiceDrafts } from "./xero";
import { explainDifference } from "./billing-workspace";

/**
 * Review of the drafts awaiting approval, so the unchanged ones can be
 * approved together and the exceptions get a look one by one.
 *
 * A draft is **unchanged** when it was built from a contract, the company is
 * linked to a Xero contact, the contract has not changed since it was
 * prepared (not stale), it is still a plain draft (not failed, not being
 * approved) and its lines match the previous comparable draft for that
 * contract line for line: same contract lines, same quantities, same unit
 * prices, no pro-rata, increase, decrease or catch-up lines. Anything else
 * is an **exception** with the reasons listed.
 */
export type DraftVerdict = "unchanged" | "exception";

export type DraftReviewRow = Awaited<ReturnType<typeof listInvoiceDrafts>>[number] & {
  verdict: DraftVerdict;
  xeroLinked: boolean;
  previous: { draftId: string; reference: string; periodStart: string; periodEnd: string; net: number } | null;
  delta: number | null;
  /** Why the amount differs from the previous comparable draft (from the lines). */
  reasons: string[];
  /** Why it is an exception (empty when unchanged). */
  flags: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const netOf = (lines: InvoiceDraftLine[]) => round2(lines.reduce((a, l) => a + l.quantity * l.unitAmount, 0));
const UNCHANGED = "Same lines and quantities as the previous invoice";

/** The previous comparable draft for each contract-sourced draft: the one ending the day before its period, else the latest earlier one. */
/** The agreements a draft was built from: one contract, or the set behind a consolidated customer draft. */
const sourceKey = (d: { contractId: string | null; contractIds: string[] | null }) => (d.contractId ? d.contractId : d.contractIds?.length ? [...d.contractIds].sort().join("+") : null);

async function previousDrafts(rows: { id: string; companyId: string; contractId: string | null; contractIds: string[] | null; periodStart: string | null }[]) {
  const companyIds = [...new Set(rows.filter((r) => sourceKey(r)).map((r) => r.companyId))];
  if (!companyIds.length) return new Map<string, { draftId: string; reference: string; periodStart: string; periodEnd: string; lines: InvoiceDraftLine[] }>();
  const all = await db
    .select({ id: invoiceDrafts.id, contractId: invoiceDrafts.contractId, contractIds: invoiceDrafts.contractIds, reference: invoiceDrafts.reference, periodStart: invoiceDrafts.periodStart, periodEnd: invoiceDrafts.periodEnd, lines: invoiceDrafts.lines })
    .from(invoiceDrafts)
    .where(and(inArray(invoiceDrafts.companyId, companyIds), ne(invoiceDrafts.status, "cancelled")));
  const out = new Map<string, { draftId: string; reference: string; periodStart: string; periodEnd: string; lines: InvoiceDraftLine[] }>();
  for (const r of rows) {
    const key = sourceKey(r);
    if (!key || !r.periodStart) continue;
    const dayBefore = new Date(Date.parse(r.periodStart) - 86400000).toISOString().slice(0, 10);
    const candidates = all
      .filter((d) => sourceKey(d) === key && d.id !== r.id && d.periodStart && d.periodEnd && d.periodStart < r.periodStart!)
      .sort((a, b) => b.periodStart!.localeCompare(a.periodStart!));
    const pick = candidates.find((d) => d.periodEnd === dayBefore) ?? candidates[0];
    if (pick) out.set(r.id, { draftId: pick.id, reference: pick.reference, periodStart: pick.periodStart!, periodEnd: pick.periodEnd!, lines: pick.lines });
  }
  return out;
}

export async function reviewPendingDrafts(currency: string): Promise<DraftReviewRow[]> {
  const all = await listInvoiceDrafts("all");
  const pending = all.filter((d) => d.status === "draft" || d.status === "failed" || d.status === "approved");
  const [previous, links] = await Promise.all([previousDrafts(pending), Promise.all([...new Set(pending.map((d) => d.companyId))].map(async (id) => [id, Boolean(await getLink("xero", "company", id))] as const))]);
  const linked = new Map(links);
  return pending.map((d) => {
    const flags: string[] = [];
    const xeroLinked = linked.get(d.companyId) ?? false;
    const prev = previous.get(d.id) ?? null;
    const fromContracts = Boolean(d.contractId || d.contractIds?.length);
    if (!fromContracts) flags.push(d.opportunityId ? "Prepared from a proposal, not a contract" : "Hand-prepared draft");
    if (!xeroLinked) flags.push("Company not linked to a Xero contact");
    if (d.status === "failed") flags.push(`Last approval failed${d.lastError ? `: ${d.lastError}` : ""}`);
    if (d.status === "approved") flags.push("Approval in progress");
    if (d.stale) flags.push("Contract changed after this draft was prepared");
    if (!d.lines.length) flags.push("No lines");
    const reasons = fromContracts ? explainDifference(d.lines, prev?.lines ?? null, currency, { missed: 0, ownCycleDue: [] }) : [];
    if (fromContracts && !prev) flags.push(d.contractIds?.length ? "First consolidated invoice for these agreements" : "First invoice from the CRM for this contract");
    const prevNet = prev ? netOf(prev.lines) : null;
    const delta = prevNet === null ? null : round2(Number(d.subTotal) - prevNet);
    const differs = Boolean(prev) && (reasons.some((r) => r !== UNCHANGED) || (delta !== null && Math.abs(delta) >= 0.01));
    if (differs) flags.push("Amount or lines differ from the previous invoice");
    return {
      ...d,
      verdict: flags.length ? "exception" : "unchanged",
      xeroLinked,
      previous: prev ? { draftId: prev.draftId, reference: prev.reference, periodStart: prev.periodStart, periodEnd: prev.periodEnd, net: prevNet! } : null,
      delta,
      reasons,
      flags,
    };
  });
}

export type BatchApprovalResult = {
  approved: { id: string; reference: string; companyName: string; invoiceId: string }[];
  skipped: { id: string; reference: string; companyName: string; reason: string }[];
};

/**
 * Approves the given drafts one after another, but only those that still
 * review as unchanged at the moment of approval: a draft that became stale
 * or differs by the time the button is pressed is skipped with the reason,
 * never approved blind. Each approval goes through the normal single-draft
 * path (claim, outbound ledger, Xero draft), so a failure on one draft never
 * affects the others.
 */
export async function approveUnchangedDrafts(ids: string[], actorUserId: string | null, currency: string): Promise<BatchApprovalResult> {
  const wanted = new Set(ids);
  const reviewed = new Map((await reviewPendingDrafts(currency)).filter((d) => wanted.has(d.id)).map((d) => [d.id, d]));
  const out: BatchApprovalResult = { approved: [], skipped: [] };
  for (const id of ids) {
    const d = reviewed.get(id);
    if (!d) {
      out.skipped.push({ id, reference: id.slice(0, 8), companyName: "", reason: "No longer awaiting approval" });
      continue;
    }
    if (d.verdict !== "unchanged") {
      out.skipped.push({ id: d.id, reference: d.reference, companyName: d.companyName, reason: d.flags.join("; ") });
      continue;
    }
    try {
      const r = await approveAndCreateInvoice(d.id, actorUserId);
      out.approved.push({ id: d.id, reference: d.reference, companyName: d.companyName, invoiceId: r.invoiceId });
    } catch (err) {
      out.skipped.push({ id: d.id, reference: d.reference, companyName: d.companyName, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  await audit({ actorUserId, action: "invoice.approve.batch", entityType: "invoice_draft", entityId: null, details: { requested: ids.length, approved: out.approved.length, skipped: out.skipped.length, references: out.approved.map((a) => a.reference) } });
  return out;
}
