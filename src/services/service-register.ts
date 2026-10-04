import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, contractLines, contracts, hostingItems, ninjaDevices, pax8Subscriptions, serviceCoverage, user, coverageSourceValues, coverageStateValues, type CoverageSource, type CoverageState } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { getAppSettings } from "@/lib/settings";
import { getNinjaOneClient } from "@/connectors/ninjaone";
import { BILLED_STATUSES, matchLine, matchableLines, monthlyUnitCost, type MatchableLine } from "./pax8";
import { coverageFor, isNonBillable, type CoverageRow } from "./coverage-lookup";

/**
 * The service register: every service supplied to a customer according to
 * the integrations (Pax8 subscriptions, 20i packages and domains, NinjaOne
 * managed devices), each with an explicit commercial state:
 *
 *   charged      its own contract line bills it (the mirror's billing line, or a Pax8 SKU / name match)
 *   bundle       included in another contract line (counts toward that line)
 *   commitment   covered by a minimum-commitment line
 *   free         intentionally not charged, with a reason and a review date
 *   internal     the MSP's own or otherwise non-billable
 *   investigate  flagged for a decision, with a note
 *   unmapped     nobody has said: the only state that means "possibly missed revenue"
 *
 * The first and last are derived; the rest are rows in `service_coverage`.
 */
import { SERVICE_STATE_LABELS, type ServiceState } from "@/lib/service-coverage";
export { SERVICE_STATE_LABELS, type ServiceState };

export type RegisterRow = {
  key: string;
  source: CoverageSource;
  rowId: string;
  companyId: string;
  companyName: string | null;
  /** Short kind label: "Microsoft 365 licence", "Hosting package", "Domain", "Managed devices", "Device". */
  kind: string;
  name: string;
  detail: string | null;
  quantity: number | null;
  /** Partner cost per month where known (Pax8). */
  monthlyCost: number | null;
  renewsOn: string | null;
  state: ServiceState;
  line: { id: string; description: string; contractName: string } | null;
  reason: string | null;
  reviewOn: string | null;
  reviewOverdue: boolean;
  setByName: string | null;
  href: string;
};

type LineRef = { id: string; description: string; contractName: string };

const today = () => new Date().toISOString().slice(0, 10);

function withCoverage(base: { state: ServiceState; line: LineRef | null }, cov: CoverageRow | undefined, lineById: Map<string, LineRef>, setBy: Map<string, string | null>): Pick<RegisterRow, "state" | "line" | "reason" | "reviewOn" | "reviewOverdue" | "setByName"> {
  if (!cov) return { ...base, reason: null, reviewOn: null, reviewOverdue: false, setByName: null };
  const line = cov.contractLineId ? (lineById.get(cov.contractLineId) ?? null) : null;
  return { state: cov.state, line: line ?? (cov.state === "bundle" || cov.state === "commitment" ? null : base.line), reason: cov.reason, reviewOn: cov.reviewOn, reviewOverdue: Boolean(cov.reviewOn && cov.reviewOn < today()), setByName: cov.setByUserId ? (setBy.get(cov.setByUserId) ?? null) : null };
}

async function lineRefsFor(companyIds: string[]) {
  if (!companyIds.length) return new Map<string, LineRef>();
  const rows = await db
    .select({ id: contractLines.id, description: contractLines.description, contractName: contracts.name })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(inArray(contracts.companyId, companyIds), isNull(contracts.archivedAt)));
  return new Map(rows.map((r) => [r.id, r]));
}

async function userNames(ids: string[]) {
  if (!ids.length) return new Map<string, string | null>();
  const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Register rows for a set of companies (all customers when empty). */
export async function serviceRegisterRows(companyIds: string[] | null): Promise<RegisterRow[]> {
  const companyRows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(isNull(companies.archivedAt), companyIds ? inArray(companies.id, companyIds) : undefined))
    .orderBy(asc(companies.name));
  if (!companyRows.length) return [];
  const ids = companyRows.map((c) => c.id);
  const nameOf = new Map(companyRows.map((c) => [c.id, c.name]));
  const [subs, hosting, lineRefs, covPax8, covHosting, covNinja, settings, ninja] = await Promise.all([
    db.select().from(pax8Subscriptions).where(and(inArray(pax8Subscriptions.companyId, ids), eq(pax8Subscriptions.externalStatus, "active"), inArray(pax8Subscriptions.status, BILLED_STATUSES))).orderBy(asc(pax8Subscriptions.productName)),
    db.select().from(hostingItems).where(and(inArray(hostingItems.companyId, ids), eq(hostingItems.externalStatus, "active"), inArray(hostingItems.kind, ["package", "domain"]))).orderBy(asc(hostingItems.kind), asc(hostingItems.name)),
    lineRefsFor(ids),
    coverageFor("pax8_subscription"),
    coverageFor("hosting_item"),
    coverageFor("ninja_device"),
    getAppSettings(),
    getNinjaOneClient(),
  ]);
  const setBy = await userNames([...new Set([...covPax8.values(), ...covHosting.values(), ...covNinja.values()].map((c) => c.setByUserId).filter((x): x is string => Boolean(x)))]);
  const out: RegisterRow[] = [];

  // Pax8 subscriptions: matched like the Subscriptions tab, then overridden by coverage.
  const linesByCompany = new Map<string, MatchableLine[]>();
  for (const cid of new Set(subs.map((s) => s.companyId!))) linesByCompany.set(cid, await matchableLines(cid, ["active"]));
  for (const s of subs) {
    const match = matchLine(s, linesByCompany.get(s.companyId!) ?? []);
    const base = { state: (match ? "charged" : "unmapped") as ServiceState, line: match ? { id: match.line.id, description: match.line.description, contractName: match.line.contractName } : null };
    const unit = monthlyUnitCost(s.price, s.billingTerm);
    out.push({ key: `pax8_subscription:${s.id}`, source: "pax8_subscription", rowId: s.id, companyId: s.companyId!, companyName: nameOf.get(s.companyId!) ?? null, kind: s.vendorName ? `${s.vendorName} subscription` : "Subscription", name: s.productName, detail: [s.sku, s.billingTerm].filter(Boolean).join(" · ") || null, quantity: s.quantity, monthlyCost: unit === null ? null : Math.round(unit * s.quantity * 100) / 100, renewsOn: s.commitmentEndsOn, ...withCoverage(base, covPax8.get(s.id), lineRefs, setBy), href: `/companies/${s.companyId}?tab=subscriptions` });
  }

  // 20i packages and domains.
  for (const h of hosting) {
    const line = h.contractLineId ? (lineRefs.get(h.contractLineId) ?? null) : null;
    const base = { state: (line ? "charged" : "unmapped") as ServiceState, line };
    out.push({ key: `hosting_item:${h.id}`, source: "hosting_item", rowId: h.id, companyId: h.companyId!, companyName: nameOf.get(h.companyId!) ?? null, kind: h.kind === "package" ? "Hosting package" : "Domain", name: h.name, detail: h.typeName ?? null, quantity: 1, monthlyCost: null, renewsOn: h.expiresOn, ...withCoverage(base, covHosting.get(h.id), lineRefs, setBy), href: `/companies/${h.companyId}?tab=hosting` });
  }

  // NinjaOne: one summary row per company with billable devices, plus any device that has its own coverage row.
  const classes = ninja?.config.billableNodeClasses ?? [];
  const approvedOnly = ninja?.config.approvedOnly ?? true;
  const cutoff = new Date(Date.now() - settings.deviceActiveDays * 86400000);
  const devices = await db
    .select({ id: ninjaDevices.id, companyId: ninjaDevices.companyId, displayName: ninjaDevices.displayName, systemName: ninjaDevices.systemName, nodeClass: ninjaDevices.nodeClass, lastContact: ninjaDevices.lastContact, approvalStatus: ninjaDevices.approvalStatus })
    .from(ninjaDevices)
    .where(and(inArray(ninjaDevices.companyId, ids), eq(ninjaDevices.externalStatus, "active"), sql`${ninjaDevices.lastContact} >= ${cutoff}`, classes.length ? inArray(ninjaDevices.nodeClass, classes) : sql`false`, approvedOnly ? or(eq(ninjaDevices.approvalStatus, "APPROVED"), isNull(ninjaDevices.approvalStatus)) : undefined));
  const deviceLines = await db
    .select({ id: contractLines.id, description: contractLines.description, contractName: contracts.name, companyId: contracts.companyId })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(inArray(contracts.companyId, ids), eq(contracts.status, "active"), isNull(contracts.archivedAt), eq(contractLines.countsAsManagedDevice, true)));
  const byCompany = new Map<string, typeof devices>();
  for (const d of devices) byCompany.set(d.companyId!, [...(byCompany.get(d.companyId!) ?? []), d]);
  for (const [cid, list] of byCompany) {
    const counted = list.filter((d) => !isNonBillable(covNinja.get(d.id)));
    const lines = deviceLines.filter((l) => l.companyId === cid);
    const line = lines[0] ? { id: lines[0].id, description: lines.map((l) => l.description).join(" + "), contractName: lines[0].contractName } : null;
    out.push({ key: `ninja_summary:${cid}`, source: "ninja_device", rowId: cid, companyId: cid, companyName: nameOf.get(cid) ?? null, kind: "Managed devices", name: `${counted.length} billable device${counted.length === 1 ? "" : "s"} at NinjaOne`, detail: list.length !== counted.length ? `${list.length - counted.length} marked non-billable` : null, quantity: counted.length, monthlyCost: null, renewsOn: null, state: line ? "charged" : "unmapped", line, reason: null, reviewOn: null, reviewOverdue: false, setByName: null, href: `/companies/${cid}?tab=devices` });
    for (const d of list) {
      const cov = covNinja.get(d.id);
      if (!cov) continue;
      out.push({ key: `ninja_device:${d.id}`, source: "ninja_device", rowId: d.id, companyId: cid, companyName: nameOf.get(cid) ?? null, kind: "Device", name: d.displayName ?? d.systemName ?? d.id, detail: d.nodeClass.toLowerCase().replace(/_/g, " "), quantity: 1, monthlyCost: null, renewsOn: null, ...withCoverage({ state: "charged", line }, cov, lineRefs, setBy), href: `/companies/${cid}?tab=devices` });
    }
  }
  return out;
}

export type RegisterSummary = Record<ServiceState, number> & { total: number; reviewOverdue: number };

export function summariseRegister(rows: RegisterRow[]): RegisterSummary {
  const s: RegisterSummary = { charged: 0, bundle: 0, commitment: 0, free: 0, internal: 0, investigate: 0, unmapped: 0, total: rows.length, reviewOverdue: 0 };
  for (const r of rows) {
    s[r.state]++;
    if (r.reviewOverdue) s.reviewOverdue++;
  }
  return s;
}

export async function companyServiceRegister(companyId: string) {
  const rows = await serviceRegisterRows([companyId]);
  return { rows, summary: summariseRegister(rows), lines: await matchableLines(companyId, ["draft", "active"]) };
}

export async function serviceRegister(p: { state?: string; companyId?: string; q?: string }) {
  let rows = await serviceRegisterRows(p.companyId ? [p.companyId] : null);
  const summary = summariseRegister(rows);
  if (p.state && p.state !== "all") rows = p.state === "review" ? rows.filter((r) => r.reviewOverdue) : rows.filter((r) => r.state === p.state);
  if (p.q) {
    const q = p.q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (r.companyName ?? "").toLowerCase().includes(q) || (r.detail ?? "").toLowerCase().includes(q));
  }
  const customers = await db.select({ id: companies.id, name: companies.name }).from(companies).where(and(isNull(companies.archivedAt), eq(companies.status, "customer"))).orderBy(asc(companies.name));
  return { rows: rows.slice(0, 500), truncated: rows.length > 500, summary, customers };
}

/** Records (or replaces) the commercial state of a mirrored service. */
export async function setServiceCoverage(input: { source: CoverageSource; sourceRowId: string; state: CoverageState; contractLineId?: string | null; reason?: string | null; reviewOn?: string | null }, actorUserId: string) {
  if (!coverageSourceValues.includes(input.source)) throw new ActionError("Unknown service source.");
  if (!coverageStateValues.includes(input.state)) throw new ActionError("Unknown coverage state.");
  const companyId = await companyOfRow(input.source, input.sourceRowId);
  if (!companyId) throw new ActionError("That service is not linked to a company; link it first.");
  const reason = input.reason?.trim() || null;
  const reviewOn = input.reviewOn || null;
  let contractLineId = input.contractLineId || null;
  if (input.state === "bundle" || input.state === "commitment") {
    if (input.state === "bundle" && !contractLineId) throw new ActionError("Choose the contract line the bundle is included in.");
    if (contractLineId) {
      const [line] = await db.select({ id: contractLines.id, companyId: contracts.companyId }).from(contractLines).innerJoin(contracts, eq(contracts.id, contractLines.contractId)).where(eq(contractLines.id, contractLineId)).limit(1);
      if (!line || line.companyId !== companyId) throw new ActionError("That contract line belongs to a different company.");
    }
  } else contractLineId = null;
  if ((input.state === "free" || input.state === "internal" || input.state === "investigate") && !reason) throw new ActionError("Give a reason; it is what the next person reads.");
  if (input.state === "free" && !reviewOn) throw new ActionError("Set a review date for anything given away free, so it is looked at again.");
  const values = { source: input.source, sourceRowId: input.sourceRowId, companyId, state: input.state, contractLineId, reason, reviewOn: input.state === "free" ? reviewOn : reviewOn, setByUserId: actorUserId, updatedAt: new Date() };
  await db.insert(serviceCoverage).values(values).onConflictDoUpdate({ target: [serviceCoverage.source, serviceCoverage.sourceRowId], set: values });
  const name = await nameOfRow(input.source, input.sourceRowId);
  await audit({ actorUserId, action: "service.coverage.set", entityType: "company", entityId: companyId, details: { source: input.source, sourceRowId: input.sourceRowId, name, state: input.state, contractLineId, reason, reviewOn } });
  await logActivity({ type: "contract", companyId, entityType: input.source, entityId: input.sourceRowId, title: `${name}: ${SERVICE_STATE_LABELS[input.state].toLowerCase()}${reason ? ` (${reason})` : ""}`, actorUserId });
  return { companyId };
}

/** Removes an explicit state; the service reads as charged or unmapped again from its billing line. */
export async function clearServiceCoverage(source: CoverageSource, sourceRowId: string, actorUserId: string) {
  const [existing] = await db.select().from(serviceCoverage).where(and(eq(serviceCoverage.source, source), eq(serviceCoverage.sourceRowId, sourceRowId))).limit(1);
  if (!existing) return;
  await db.delete(serviceCoverage).where(eq(serviceCoverage.id, existing.id));
  await audit({ actorUserId, action: "service.coverage.clear", entityType: "company", entityId: existing.companyId, details: { source, sourceRowId, was: existing.state } });
}

async function companyOfRow(source: CoverageSource, rowId: string): Promise<string | null> {
  if (source === "pax8_subscription") return (await db.select({ c: pax8Subscriptions.companyId }).from(pax8Subscriptions).where(eq(pax8Subscriptions.id, rowId)).limit(1))[0]?.c ?? null;
  if (source === "hosting_item") return (await db.select({ c: hostingItems.companyId }).from(hostingItems).where(eq(hostingItems.id, rowId)).limit(1))[0]?.c ?? null;
  return (await db.select({ c: ninjaDevices.companyId }).from(ninjaDevices).where(eq(ninjaDevices.id, rowId)).limit(1))[0]?.c ?? null;
}

async function nameOfRow(source: CoverageSource, rowId: string): Promise<string> {
  if (source === "pax8_subscription") return (await db.select({ n: pax8Subscriptions.productName }).from(pax8Subscriptions).where(eq(pax8Subscriptions.id, rowId)).limit(1))[0]?.n ?? "subscription";
  if (source === "hosting_item") return (await db.select({ n: hostingItems.name }).from(hostingItems).where(eq(hostingItems.id, rowId)).limit(1))[0]?.n ?? "hosting item";
  const [d] = await db.select({ a: ninjaDevices.displayName, b: ninjaDevices.systemName }).from(ninjaDevices).where(eq(ninjaDevices.id, rowId)).limit(1);
  return d?.a ?? d?.b ?? "device";
}

/** Coverage rows whose review date has passed, oldest first (for the register's attention list). */
export async function overdueCoverageReviews(limit = 50) {
  return db.select({ c: serviceCoverage, companyName: companies.name }).from(serviceCoverage).innerJoin(companies, eq(companies.id, serviceCoverage.companyId)).where(sql`${serviceCoverage.reviewOn} < current_date`).orderBy(asc(serviceCoverage.reviewOn), desc(serviceCoverage.updatedAt)).limit(limit);
}
