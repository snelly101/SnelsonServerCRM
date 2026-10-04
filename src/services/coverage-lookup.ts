import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { serviceCoverage, type CoverageSource, type CoverageState } from "@/db/schema";

/**
 * Read side of service coverage, kept apart from the register so the Pax8,
 * 20i and NinjaOne engines can consult it without a circular import.
 */
export type CoverageRow = typeof serviceCoverage.$inferSelect & { state: CoverageState };

/** Coverage rows for a source, keyed by mirror row id; scoped to a company when given. */
export async function coverageFor(source: CoverageSource, opts: { companyId?: string; rowIds?: string[] } = {}): Promise<Map<string, CoverageRow>> {
  if (opts.rowIds && opts.rowIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(serviceCoverage)
    .where(and(eq(serviceCoverage.source, source), opts.companyId ? eq(serviceCoverage.companyId, opts.companyId) : undefined, opts.rowIds ? inArray(serviceCoverage.sourceRowId, opts.rowIds) : undefined));
  return new Map(rows.map((r) => [r.sourceRowId, r as CoverageRow]));
}

/** States under which a mirrored item is not expected to produce a charge or count of its own. */
export const NON_BILLABLE_STATES: CoverageState[] = ["free", "internal"];
export const isNonBillable = (c: CoverageRow | undefined | null) => Boolean(c && NON_BILLABLE_STATES.includes(c.state));
