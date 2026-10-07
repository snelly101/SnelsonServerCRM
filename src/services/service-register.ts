import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { companies, user } from "@/db/schema";
import { BILLING_ADAPTERS, PROVIDER_OF_SOURCE } from "./billing-adapters";
import { linksFor, matchableLinesFor, resolveService, setServiceLink, clearServiceLink, type ServiceLink } from "./service-links";
import { PROVIDER_LABELS, SERVICE_STATE_LABELS, type MatchableLine, type ProviderKey, type ServiceState, type SuppliedService } from "@/lib/billing-model";
import type { LinkRole, MatchSource, ServiceSource } from "@/db/schema";

/**
 * The service register: every service the integrations supply to a customer
 * (through the billing adapters), each with its commercial state:
 *
 *   charged      a contract line bills it (chosen by a person, or matched by SKU / name / the per-device rule)
 *   bundle       included in another contract line (counts toward that line)
 *   commitment   covered by a minimum-commitment line
 *   free         intentionally not charged, with a reason and a review date
 *   internal     the MSP's own or otherwise non-billable
 *   investigate  flagged for a decision, with a note
 *   unmapped     nobody has said and no rule matches: the only state that means "possibly missed revenue"
 */
export { SERVICE_STATE_LABELS, type ServiceState };

export type RegisterRow = SuppliedService & {
  companyName: string | null;
  providerLabel: string;
  state: ServiceState;
  line: { id: string; description: string; contractName: string; contractId: string } | null;
  /** How the line was arrived at: chosen by a person, matched by SKU or name, or the per-device rule. */
  matchedBy: MatchSource | "rule" | null;
  reason: string | null;
  reviewOn: string | null;
  reviewOverdue: boolean;
  setByName: string | null;
  linkedAt: Date | null;
};

type LineRef = RegisterRow["line"];

const today = () => new Date().toISOString().slice(0, 10);

export type RegisterContext = { services: SuppliedService[]; links: Map<string, ServiceLink>; lines: Map<string, MatchableLine[]> };

/** The raw inputs for a set of companies, shared by the register and the quantity checks so both resolve services the same way. */
export async function registerContext(companyIds: string[] | null, providers?: ProviderKey[]): Promise<RegisterContext> {
  const adapters = providers ? BILLING_ADAPTERS.filter((a) => providers.includes(a.provider)) : BILLING_ADAPTERS;
  const services = (await Promise.all(adapters.map((a) => a.services(companyIds)))).flat();
  const ids = companyIds ?? [...new Set(services.map((s) => s.companyId))];
  const [links, lines] = await Promise.all([linksFor({ companyIds: ids }), matchableLinesFor(ids, ["draft", "active", "expired", "cancelled"])]);
  return { services, links, lines };
}

export const autoMatcher = (source: ServiceSource) => BILLING_ADAPTERS.find((a) => a.provider === PROVIDER_OF_SOURCE[source])!.autoMatch;

/** Register rows for a set of companies (all customers when null). */
export async function serviceRegisterRows(companyIds: string[] | null, providers?: ProviderKey[]): Promise<RegisterRow[]> {
  const companyRows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(isNull(companies.archivedAt), companyIds ? inArray(companies.id, companyIds) : undefined))
    .orderBy(asc(companies.name));
  if (!companyRows.length) return [];
  const nameOf = new Map(companyRows.map((c) => [c.id, c.name]));
  const ctx = await registerContext(companyRows.map((c) => c.id), providers);
  const lineRef = new Map<string, LineRef>();
  for (const list of ctx.lines.values()) for (const l of list) lineRef.set(l.id, { id: l.id, description: l.description, contractName: l.contractName, contractId: l.contractId });
  const setBy = await userNames([...new Set([...ctx.links.values()].map((l) => l.setByUserId).filter((x): x is string => Boolean(x)))]);
  const out: RegisterRow[] = [];
  const row = (s: SuppliedService, link: ServiceLink | undefined, lines: MatchableLine[]): RegisterRow => {
    const r = resolveService(s, link, lines, autoMatcher(s.source));
    return {
      ...s,
      companyName: nameOf.get(s.companyId) ?? null,
      providerLabel: PROVIDER_LABELS[s.provider],
      state: r.state,
      line: r.lineId ? (lineRef.get(r.lineId) ?? null) : null,
      matchedBy: r.by,
      reason: link?.reason ?? null,
      reviewOn: link?.reviewOn ?? null,
      reviewOverdue: Boolean(link?.reviewOn && link.reviewOn < today()),
      setByName: link?.setByUserId ? (setBy.get(link.setByUserId) ?? null) : null,
      linkedAt: link?.updatedAt ?? null,
    };
  };
  const order = new Map(companyRows.map((c, i) => [c.id, i]));
  const services = [...ctx.services].sort((a, b) => (order.get(a.companyId) ?? 0) - (order.get(b.companyId) ?? 0) || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  for (const s of services) {
    const lines = ctx.lines.get(s.companyId) ?? [];
    if (!s.pool) {
      out.push(row(s, ctx.links.get(s.key), lines));
      continue;
    }
    // A pool (managed devices): members with their own link leave the pool's count and are listed on their own.
    const members = s.members ?? [];
    const own = members.filter((m) => ctx.links.has(`${s.source}:${m.id}`));
    const counted = members.length - own.length;
    out.push(row({ ...s, quantity: counted, name: `${counted} billable device${counted === 1 ? "" : "s"} at NinjaOne`, detail: own.length ? `${own.length} marked separately` : s.detail }, undefined, lines));
    for (const m of own) {
      const link = ctx.links.get(`${s.source}:${m.id}`)!;
      out.push(row({ ...s, key: `${s.source}:${m.id}`, rowId: m.id, kind: "Device", name: m.name, detail: m.detail, quantity: 1, pool: false, members: undefined }, link, lines));
    }
  }
  return out;
}

async function userNames(ids: string[]) {
  if (!ids.length) return new Map<string, string | null>();
  const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export type RegisterSummary = Record<ServiceState, number> & { total: number; reviewOverdue: number; monthlyCost: number; unknownCost: number };

export function summariseRegister(rows: RegisterRow[]): RegisterSummary {
  const s: RegisterSummary = { charged: 0, bundle: 0, commitment: 0, free: 0, internal: 0, investigate: 0, unmapped: 0, total: rows.length, reviewOverdue: 0, monthlyCost: 0, unknownCost: 0 };
  for (const r of rows) {
    s[r.state]++;
    if (r.reviewOverdue) s.reviewOverdue++;
    if (r.monthlyCost !== null) s.monthlyCost = Math.round((s.monthlyCost + r.monthlyCost) * 100) / 100;
    else if (!r.costKnown && !r.pool) s.unknownCost++;
  }
  return s;
}

export async function companyServiceRegister(companyId: string) {
  const rows = await serviceRegisterRows([companyId]);
  const lines = (await matchableLinesFor([companyId], ["draft", "active"])).get(companyId) ?? [];
  return { rows, summary: summariseRegister(rows), lines };
}

export async function serviceRegister(p: { state?: string; companyId?: string; provider?: string; q?: string }) {
  let rows = await serviceRegisterRows(p.companyId ? [p.companyId] : null);
  const summary = summariseRegister(rows);
  if (p.provider && p.provider !== "all") rows = rows.filter((r) => r.provider === p.provider);
  if (p.state && p.state !== "all") rows = p.state === "review" ? rows.filter((r) => r.reviewOverdue) : rows.filter((r) => r.state === p.state);
  if (p.q) {
    const q = p.q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q) || (r.companyName ?? "").toLowerCase().includes(q) || (r.detail ?? "").toLowerCase().includes(q) || (r.supplierProduct ?? "").toLowerCase().includes(q));
  }
  const customers = await db.select({ id: companies.id, name: companies.name }).from(companies).where(and(isNull(companies.archivedAt), eq(companies.status, "customer"))).orderBy(asc(companies.name));
  return { rows: rows.slice(0, 500), truncated: rows.length > 500, summary, customers };
}

// Writes kept under their register-era names so existing callers compile; the work is done by service-links.
export async function setServiceCoverage(input: { source: ServiceSource; sourceRowId: string; state: LinkRole; contractLineId?: string | null; reason?: string | null; reviewOn?: string | null }, actorUserId: string) {
  const r = await setServiceLink({ source: input.source, sourceRowId: input.sourceRowId, role: input.state, contractLineId: input.contractLineId, reason: input.reason, reviewOn: input.reviewOn }, actorUserId);
  return { companyId: r.companyId };
}
export async function clearServiceCoverage(source: ServiceSource, sourceRowId: string, actorUserId: string) {
  await clearServiceLink(source, sourceRowId, actorUserId);
}
export { overdueLinkReviews as overdueCoverageReviews } from "./service-links";
