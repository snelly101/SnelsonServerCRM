import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { addMonths, format, parseISO, subDays } from "date-fns";
import { db } from "@/db";
import { companies, contractLines, contracts, invoiceDrafts } from "@/db/schema";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { monthlyValue } from "@/lib/money";
import { getLink } from "./integrations";
import { prepareInvoiceDraft } from "./xero";

/**
 * Billing run: one draft invoice per active contract for the **current**
 * billing period, in advance. Periods are anchored to the contract start date
 * (a contract starting on the 15th bills 15th to 14th); monthly, quarterly and
 * annual contracts are included, one-off ones are not. Only the period that
 * contains the run date is proposed: older gaps are history and stay a manual
 * *Prepare invoice* on the contract, so a contract imported mid-life is never
 * back-billed by accident. A period that already has a draft (any status but
 * cancelled) is skipped, which makes the run safe to repeat.
 */
export type BillingPeriod = { periodStart: string; periodEnd: string };

const MONTHS: Record<string, number | undefined> = { monthly: 1, quarterly: 3, annual: 12 };
const iso = (d: Date) => format(d, "yyyy-MM-dd");

/** The billing period of `frequency` anchored to `startDate` that contains `asOf`, or null when the contract has not started or has ended. */
export function currentBillingPeriod(startDate: string, frequency: string, asOf: string, endDate?: string | null): BillingPeriod | null {
  const months = MONTHS[frequency];
  if (!months) return null;
  const start = parseISO(startDate);
  const on = parseISO(asOf);
  if (on < start) return null;
  if (endDate && parseISO(endDate) < on) return null;
  // Count whole periods from the anchor, adding months to the anchor itself so a 31st keeps clamping correctly.
  for (let n = 0; n < 1200; n++) {
    const ps = addMonths(start, n * months);
    const next = addMonths(start, (n + 1) * months);
    if (on >= ps && on < next) {
      const pe = subDays(next, 1);
      return { periodStart: iso(ps), periodEnd: endDate && parseISO(endDate) < pe ? endDate : iso(pe) };
    }
  }
  return null;
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
  const drafts = await db
    .select({ id: invoiceDrafts.id, contractId: invoiceDrafts.contractId, periodStart: invoiceDrafts.periodStart, reference: invoiceDrafts.reference, status: invoiceDrafts.status })
    .from(invoiceDrafts)
    .where(and(inArray(invoiceDrafts.contractId, ids), ne(invoiceDrafts.status, "cancelled")));
  const out: BillingRunRow[] = [];
  for (const r of rows) {
    const c = r.contract;
    const recurring = lines.filter((l) => l.contractId === c.id && l.revenueType === "recurring" && l.billingFrequency !== "one_off");
    const period = currentBillingPeriod(c.startDate, c.billingFrequency, asOf, c.endDate);
    const months = MONTHS[c.billingFrequency] ?? 0;
    const net = Math.round(recurring.reduce((a, l) => a + monthlyValue({ quantity: l.quantity, unitPrice: l.unitPrice, revenueType: l.revenueType, billingFrequency: l.billingFrequency }), 0) * months * 100) / 100;
    const existing = period ? drafts.find((d) => d.contractId === c.id && d.periodStart === period.periodStart) ?? null : null;
    const xeroLinked = Boolean(await getLink("xero", "company", c.companyId));
    const skipReason = !MONTHS[c.billingFrequency]
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
