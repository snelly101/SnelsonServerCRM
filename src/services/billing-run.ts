import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { companies, contractLines, contracts, type InvoiceDraftLine } from "@/db/schema";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { billingPeriodFor, PERIOD_MONTHS, type BillingPeriod } from "@/lib/billing";
import { getLink } from "./integrations";
import { prepareInvoiceDraft } from "./xero";
import { lineChangesFor } from "./contracts";
import { buildLinesForItems, coveringDraft, draftLineEntries, isRecurring, planItems, type PlannedItem } from "./billing-coverage";
import { inArray } from "drizzle-orm";

/**
 * Billing run: one draft invoice per active contract carrying every line
 * period that is due and not yet invoiced (see `./billing-coverage`): the
 * current period of each recurring line under its schedule (the contract's
 * periods, or the line's own cycle), plus, for contracts with a billing
 * commencement date, earlier periods that no draft covers, flagged as missed.
 * Billed in advance; one-off contracts are not included. A line period that
 * already has a draft (any status but cancelled) is skipped, which makes the
 * run safe to repeat.
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
  /** The contract's own period containing the run date (what a plain monthly/quarterly/annual contract bills). */
  period: BillingPeriod | null;
  /** Everything the draft would carry: each line's period, with earlier uncovered periods marked missed. */
  items: PlannedItem[];
  missedCount: number;
  /** Net amount the draft would carry. */
  net: number;
  /** The lines the draft would carry (same maths as preparation). */
  lines: InvoiceDraftLine[];
  /** The most recent comparable draft before this period (the one ending the day before, else the latest earlier one). */
  previous: { draftId: string; status: string; periodStart: string; periodEnd: string; net: number; lines: InvoiceDraftLine[] } | null;
  lineCount: number;
  xeroLinked: boolean;
  /** A draft that already covers the current period, if any. */
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
  const [lines, history, entriesByContract] = await Promise.all([db.select().from(contractLines).where(inArray(contractLines.contractId, ids)).orderBy(contractLines.sortOrder), lineChangesFor(ids), draftLineEntries(ids)]);
  const out: BillingRunRow[] = [];
  for (const r of rows) {
    const c = r.contract;
    const cl = lines.filter((l) => l.contractId === c.id);
    const recurring = cl.filter(isRecurring);
    const entries = entriesByContract.get(c.id) ?? [];
    const period = billingPeriodFor(c.startDate, c.billingFrequency, asOf, c.endDate, c.billingDay);
    const items = period ? planItems(c, cl, entries, asOf) : [];
    // Same maths as the draft itself, so the preview shows pro-rated amounts, catch-ups and credits.
    const built = items.length ? await buildLinesForItems(c, cl, items, entries, "", "", history) : [];
    const net = Math.round(built.reduce((a, l) => a + l.quantity * l.unitAmount, 0) * 100) / 100;
    const covering = period ? coveringDraft(entries, recurring.map((l) => l.id), period) : null;
    // Previous comparable draft: the one whose period ends the day before this one starts, else the latest that started earlier.
    let previous: BillingRunRow["previous"] = null;
    if (period) {
      const byDraft = new Map<string, { status: string; periodStart: string; periodEnd: string; lines: InvoiceDraftLine[] }>();
      for (const e of entries) {
        if (!e.periodStart || !e.periodEnd || e.periodStart >= period.periodStart) continue;
        const d = byDraft.get(e.draftId) ?? { status: e.status, periodStart: e.periodStart, periodEnd: e.periodEnd, lines: [] };
        d.lines.push(e.line);
        byDraft.set(e.draftId, d);
      }
      const dayBefore = new Date(Date.parse(period.periodStart) - 86400000).toISOString().slice(0, 10);
      const candidates = [...byDraft.entries()].sort((a, b) => b[1].periodStart.localeCompare(a[1].periodStart));
      const pick = candidates.find(([, d]) => d.periodEnd === dayBefore) ?? candidates[0];
      if (pick) previous = { draftId: pick[0], ...pick[1], net: Math.round(pick[1].lines.reduce((a, l) => a + l.quantity * l.unitAmount, 0) * 100) / 100 };
    }
    const existing = covering ? { id: covering.draftId, reference: covering.draftId, status: covering.status } : null;
    const xeroLinked = Boolean(await getLink("xero", "company", c.companyId));
    const skipReason = !PERIOD_MONTHS[c.billingFrequency]
      ? "one-off contract: nothing recurs"
      : !period
        ? c.startDate > asOf
          ? `starts ${c.startDate}`
          : `ended ${c.endDate}`
        : !recurring.length
          ? "no recurring lines"
          : !items.length
            ? existing
              ? `already drafted (${existing.status})`
              : "nothing due: every line period is invoiced"
            : null;
    out.push({ contractId: c.id, contractName: c.name, companyId: c.companyId, companyName: r.companyName, billingFrequency: c.billingFrequency, period, items, missedCount: items.filter((i) => i.missed).length, net, lines: built, previous, lineCount: recurring.length, xeroLinked, existingDraft: existing, skipReason });
  }
  // Draft references for the "already drafted" links.
  const draftIds = out.map((o) => o.existingDraft?.id).filter((x): x is string => Boolean(x));
  if (draftIds.length) {
    const { invoiceDrafts } = await import("@/db/schema");
    const refs = await db.select({ id: invoiceDrafts.id, reference: invoiceDrafts.reference }).from(invoiceDrafts).where(inArray(invoiceDrafts.id, draftIds));
    const byId = new Map(refs.map((d) => [d.id, d.reference]));
    for (const o of out) if (o.existingDraft) { o.existingDraft.reference = byId.get(o.existingDraft.id) ?? o.existingDraft.id; if (o.skipReason?.startsWith("already drafted")) o.skipReason = `already drafted (${o.existingDraft.reference}, ${o.existingDraft.status})`; }
  }
  return out;
}

/**
 * Creates the drafts for the chosen contracts. Each one is re-checked against
 * the current preview immediately before creation, so a draft prepared in the
 * meantime (or a second click) never produces a duplicate.
 */
export async function runBillingRun(asOf: string, contractIds: string[], actorUserId: string, opts: { consolidate?: boolean } = {}) {
  const preview = await previewBillingRun(asOf);
  const chosen = new Set(contractIds);
  const created: { draftId: string; contractId: string; contractName: string; companyName: string; net: number; missed: number; consolidated: number }[] = [];
  const skipped: { contractId: string; contractName: string; reason: string }[] = [];
  const due: BillingRunRow[] = [];
  for (const row of preview) {
    if (!chosen.has(row.contractId)) continue;
    if (row.skipReason || !row.items.length) {
      skipped.push({ contractId: row.contractId, contractName: row.contractName, reason: row.skipReason ?? "nothing due" });
      continue;
    }
    due.push(row);
  }
  // One draft per customer when asked and several agreements are due for the same company (same currency and terms apply: one settings currency, one Xero contact).
  const groups = new Map<string, BillingRunRow[]>();
  for (const row of due) groups.set(opts.consolidate ? row.companyId : row.contractId, [...(groups.get(opts.consolidate ? row.companyId : row.contractId) ?? []), row]);
  for (const rows of groups.values()) {
    if (rows.length === 1) {
      const row = rows[0];
      const draftId = await prepareInvoiceDraft({ companyId: row.companyId, contractId: row.contractId, items: row.items }, actorUserId);
      created.push({ draftId, contractId: row.contractId, contractName: row.contractName, companyName: row.companyName, net: row.net, missed: row.missedCount, consolidated: 0 });
      continue;
    }
    const draftId = await prepareInvoiceDraft({ companyId: rows[0].companyId, contracts: rows.map((r) => ({ contractId: r.contractId, items: r.items })) }, actorUserId);
    created.push({ draftId, contractId: rows[0].contractId, contractName: rows.map((r) => r.contractName).join(" + "), companyName: rows[0].companyName, net: Math.round(rows.reduce((a, r) => a + r.net, 0) * 100) / 100, missed: rows.reduce((a, r) => a + r.missedCount, 0), consolidated: rows.length });
  }
  const unknown = contractIds.filter((id) => !preview.some((p) => p.contractId === id));
  for (const id of unknown) skipped.push({ contractId: id, contractName: id, reason: "not an active contract" });
  await audit({ actorUserId, action: "billing.run", entityType: "invoice_draft", entityId: asOf, details: { asOf, requested: contractIds.length, created: created.length, skipped: skipped.length, consolidate: Boolean(opts.consolidate), drafts: created.map((c) => c.draftId) } });
  return { asOf, created, skipped };
}
