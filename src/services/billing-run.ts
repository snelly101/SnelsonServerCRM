import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { differenceInCalendarDays, parseISO, subDays } from "date-fns";
import { db } from "@/db";
import { companies, contractLines, contracts, invoiceDrafts } from "@/db/schema";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { billingPeriodFor, buildContractInvoiceLines, PERIOD_MONTHS, type BillingPeriod, type PreviousInvoice } from "@/lib/billing";
import { getLink } from "./integrations";
import { prepareInvoiceDraft } from "./xero";
import { lineChangesFor } from "./contracts";

/**
 * Billing run: one draft invoice per active contract for the **current**
 * billing period, in advance. Periods are anchored to the contract start date,
 * or to its billing day of the month when set (see `@/lib/billing`); monthly,
 * quarterly and annual contracts are included, one-off ones are not. Only the
 * period that contains the run date is proposed: older gaps are history and
 * stay a manual *Prepare invoice* on the contract, so a contract imported
 * mid-life is never back-billed by accident. A period that already has a draft
 * (any status but cancelled) is skipped, which makes the run safe to repeat.
 */
export type { BillingPeriod };

/** Period anchored to the start date (no billing day). Kept for callers and tests that predate billing days. */
export function currentBillingPeriod(startDate: string, frequency: string, asOf: string, endDate?: string | null): { periodStart: string; periodEnd: string } | null {
  const p = billingPeriodFor(startDate, frequency, asOf, endDate, null);
  return p ? { periodStart: p.periodStart, periodEnd: p.periodEnd } : null;
}

export type BillingRunRow = {
  contractId: string;
  contractName: string;
  companyId: string;
  companyName: string;
  billingFrequency: string;
  period: BillingPeriod | null;
  /** Net amount the draft would carry (recurring lines × months in the period). */
  net: number;
  lineCount: number;
  xeroLinked: boolean;
  /** Reference of the draft that already covers this period, if any. */
  existingDraft: { id: string; reference: string; status: string } | null;
  /** Why the row cannot be included; null when it is ready. */
  skipReason: string | null;
};

export async function previewBillingRun(asOf: string): Promise<BillingRunRow[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new ActionError("Run date must be YYYY-MM-DD.");
  const rows = await db
    .select({ contract: contracts, companyName: companies.name })
    .from(contracts)
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .where(and(eq(contracts.status, "active"), isNull(contracts.archivedAt), isNull(companies.archivedAt)))
    .orderBy(companies.name, contracts.name);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.contract.id);
  const lines = await db.select().from(contractLines).where(inArray(contractLines.contractId, ids));
  const history = await lineChangesFor(ids);
  const drafts = await db
    .select({ id: invoiceDrafts.id, contractId: invoiceDrafts.contractId, periodStart: invoiceDrafts.periodStart, periodEnd: invoiceDrafts.periodEnd, lines: invoiceDrafts.lines, reference: invoiceDrafts.reference, status: invoiceDrafts.status, createdAt: invoiceDrafts.createdAt })
    .from(invoiceDrafts)
    .where(and(inArray(invoiceDrafts.contractId, ids), ne(invoiceDrafts.status, "cancelled")));
  const out: BillingRunRow[] = [];
  for (const r of rows) {
    const c = r.contract;
    const recurring = lines.filter((l) => l.contractId === c.id && l.revenueType === "recurring" && l.billingFrequency !== "one_off").map((l) => ({ ...l, changes: history.get(l.id) ?? [] }));
    const period = billingPeriodFor(c.startDate, c.billingFrequency, asOf, c.endDate, c.billingDay);
    const months = PERIOD_MONTHS[c.billingFrequency] ?? 0;
    // Same maths as the draft itself, so the preview shows pro-rated amounts and catch-up lines.
    let previous: PreviousInvoice | null = null;
    if (period) {
      const dayBefore = subDays(parseISO(period.periodStart), 1).toISOString().slice(0, 10);
      const prev = drafts.filter((d) => d.contractId === c.id && d.periodEnd === dayBefore && d.periodStart).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if (prev?.periodStart && prev.periodEnd) previous = { period: { periodStart: prev.periodStart, periodEnd: prev.periodEnd, fullDays: Math.max(1, differenceInCalendarDays(parseISO(prev.periodEnd), parseISO(prev.periodStart)) + 1) }, lines: prev.lines };
    }
    const net = period ? Math.round(buildContractInvoiceLines({ lines: recurring, period, months, previous, accountCode: "", taxType: "" }).reduce((a, l) => a + l.quantity * l.unitAmount, 0) * 100) / 100 : 0;
    const existing = period ? drafts.find((d) => d.contractId === c.id && d.periodStart === period.periodStart) ?? null : null;
    const xeroLinked = Boolean(await getLink("xero", "company", c.companyId));
    const skipReason = !PERIOD_MONTHS[c.billingFrequency]
      ? "one-off contract: nothing recurs"
      : !period
        ? parseISO(c.startDate) > parseISO(asOf)
          ? `starts ${c.startDate}`
          : `ended ${c.endDate}`
        : !recurring.length
          ? "no recurring lines"
          : existing
            ? `already drafted (${existing.reference}, ${existing.status})`
            : null;
    out.push({ contractId: c.id, contractName: c.name, companyId: c.companyId, companyName: r.companyName, billingFrequency: c.billingFrequency, period, net, lineCount: recurring.length, xeroLinked, existingDraft: existing ? { id: existing.id, reference: existing.reference, status: existing.status } : null, skipReason });
  }
  return out;
}

/**
 * Creates the drafts for the chosen contracts. Each one is re-checked against
 * the current preview immediately before creation, so a draft prepared in the
 * meantime (or a second click) never produces a duplicate.
 */
export async function runBillingRun(asOf: string, contractIds: string[], actorUserId: string) {
  const preview = await previewBillingRun(asOf);
  const chosen = new Set(contractIds);
  const created: { draftId: string; contractId: string; contractName: string; companyName: string; net: number }[] = [];
  const skipped: { contractId: string; contractName: string; reason: string }[] = [];
  for (const row of preview) {
    if (!chosen.has(row.contractId)) continue;
    if (row.skipReason || !row.period) {
      skipped.push({ contractId: row.contractId, contractName: row.contractName, reason: row.skipReason ?? "no period" });
      continue;
    }
    const draftId = await prepareInvoiceDraft({ companyId: row.companyId, contractId: row.contractId, periodStart: row.period.periodStart, periodEnd: row.period.periodEnd }, actorUserId);
    created.push({ draftId, contractId: row.contractId, contractName: row.contractName, companyName: row.companyName, net: row.net });
  }
  const unknown = contractIds.filter((id) => !preview.some((p) => p.contractId === id));
  for (const id of unknown) skipped.push({ contractId: id, contractName: id, reason: "not an active contract" });
  await audit({ actorUserId, action: "billing.run", entityType: "invoice_draft", entityId: asOf, details: { asOf, requested: contractIds.length, created: created.length, skipped: skipped.length, drafts: created.map((c) => c.draftId) } });
  return { asOf, created, skipped };
}
