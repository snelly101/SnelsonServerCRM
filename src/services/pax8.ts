import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  billingDiscrepancies,
  companies,
  contacts,
  contractLines,
  contracts,
  pax8Companies,
  pax8InvoiceItems,
  pax8Invoices,
  pax8Products,
  pax8Subscriptions,
  products,
  user,
  xeroContacts,
  xeroInvoices,
} from "@/db/schema";
import { getXeroClient } from "@/connectors/xero";
import { upsertInvoice as upsertXeroInvoice } from "./xero";
import {
  matchPax8Bills,
  reconcileState,
  type ReconcileState,
} from "@/lib/pax8-reconcile";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { logger } from "@/lib/logger";
import { normalizeCompanyName } from "@/lib/utils";
import {
  DEFAULT_PAX8_CONFIG,
  getPax8Client,
  type Pax8Config,
  type Pax8Credentials,
} from "@/connectors/pax8";
import { LivePax8Client } from "@/connectors/pax8/live";
import {
  commitmentOf,
  pax8Date,
  pax8Number,
  pax8Time,
  termMonths,
  type Pax8ContactCreate,
  type Pax8ContactType,
  type Pax8InvoiceItemRaw,
  type Pax8Client,
  type Pax8InvoiceRaw,
} from "@/connectors/pax8/types";
import { registrableDomain } from "@/connectors/twentyi/types";
import {
  getConnection,
  raiseConflict,
  runOutbound,
  runSync,
  setConnectionConfig,
  setCredentials,
  updateConnection,
} from "./integrations";
import { listDiscrepancies } from "./ninjaone";
import { coverageFor, isNonBillable } from "./coverage-lookup";

export type Pax8Subscription = typeof pax8Subscriptions.$inferSelect;
export type Pax8Company = typeof pax8Companies.$inferSelect;

/** Subscription statuses that Pax8 bills the partner for (and that a customer therefore has). */
export const BILLED_STATUSES = ["Active", "Activated", "PendingCancel"];
const LINE_MONTHS: Record<string, number | null> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
  one_off: null,
};

// ---------------------------------------------------------------------------
// Connection (client id/secret entered in the UI, verified before storage)
// ---------------------------------------------------------------------------
export async function connectPax8(
  input: { clientId: string; clientSecret: string },
  actorUserId: string,
) {
  const client = new LivePax8Client(
    { clientId: input.clientId, clientSecret: input.clientSecret },
    null,
    async () => undefined,
  );
  const test = await client.testConnection();
  if (!test.ok)
    throw new ActionError(
      `Could not verify the Pax8 credentials: ${test.error}`,
    );
  await setCredentials(
    "pax8",
    {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    } satisfies Pax8Credentials,
    actorUserId,
    {
      status: "connected",
      externalAccountName: `Pax8 partner (${test.companyCount} companies)`,
      externalAccountId: input.clientId.slice(0, 8),
      lastTestedAt: new Date(),
      lastError: null,
      consecutiveFailures: 0,
      pausedUntil: null,
    },
  );
  return test;
}

export async function testPax8(actorUserId: string) {
  const resolved = await getPax8Client();
  if (!resolved) throw new ActionError("Pax8 is not configured.");
  const t = await resolved.client.testConnection();
  if (resolved.mode === "live")
    await updateConnection("pax8", {
      lastTestedAt: new Date(),
      lastError: t.ok ? null : t.error,
      status: t.ok
        ? "connected"
        : /401|403/.test(t.ok ? "" : t.error)
          ? "expired"
          : "error",
    });
  await audit({
    actorUserId,
    action: "integration.test",
    entityType: "integration",
    entityId: "pax8",
    details: { ok: t.ok },
  });
  return t;
}

export async function pax8ConnectionSummary() {
  const conn = await getConnection("pax8");
  const resolved = await getPax8Client();
  return {
    ...conn,
    credentialsEnc: undefined,
    config: (conn.config ?? {}) as Pax8Config,
    effectiveConfig: resolved?.config ?? DEFAULT_PAX8_CONFIG,
    mode: resolved?.mode ?? null,
    configured: Boolean(resolved),
    demo: resolved?.mode === "demo",
    keyPresent: conn.mode === "live" && Boolean(conn.credentialsEnc),
  };
}

export async function savePax8Config(input: Pax8Config, actorUserId: string) {
  await setConnectionConfig("pax8", input, actorUserId);
}

// ---------------------------------------------------------------------------
// Sync (read-only): companies, products, subscriptions, recent invoices; then
// auto-match companies and run the licence check.
// ---------------------------------------------------------------------------
export async function syncPax8(
  trigger: "schedule" | "manual",
  actorUserId?: string | null,
) {
  const resolved = await getPax8Client();
  if (!resolved) return null;
  const { client, config } = resolved;
  return runSync(
    "pax8",
    "pax8.sync",
    trigger,
    async ({ counters, fail }) => {
      const now = new Date();
      const tally = (r: "created" | "updated" | "unchanged") => {
        if (r === "created") counters.created++;
        else if (r === "updated") counters.updated++;
        else counters.skipped++;
      };

      // Companies
      const seenCompanies = new Set<string>();
      const remote = await client.listCompanies();
      for (const c of remote) {
        counters.fetched++;
        seenCompanies.add(c.id);
        try {
          tally(
            await upsertCompany(
              {
                pax8Id: c.id,
                name: c.name,
                normalizedName: normalizeCompanyName(c.name),
                website: c.website ?? null,
                matchDomain: registrableDomain(c.website),
                phone: c.phone ?? null,
                city: c.address?.city ?? null,
                country: c.address?.country ?? null,
                externalRef: c.externalId ?? null,
                status: c.status ?? null,
                raw: c as Record<string, unknown>,
              },
              now,
            ),
          );
        } catch (err) {
          await fail(
            `Company ${c.name}: ${err instanceof Error ? err.message : String(err)}`,
            { externalId: c.id },
          );
        }
      }
      if (remote.length)
        await db
          .update(pax8Companies)
          .set({ externalStatus: "deleted", updatedAt: now })
          .where(
            and(
              eq(pax8Companies.externalStatus, "active"),
              notInArray(pax8Companies.pax8Id, [...seenCompanies]),
            ),
          );

      // Products (catalogue entries referenced by subscriptions)
      const productById = new Map<
        string,
        {
          name: string;
          vendorName: string | null;
          sku: string | null;
          vendorSku: string | null;
        }
      >();
      let productList: Awaited<ReturnType<typeof client.listProducts>> = [];
      try {
        productList = await client.listProducts();
      } catch (err) {
        await fail(
          `Products unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const p of productList) {
        counters.fetched++;
        productById.set(p.id, {
          name: p.name,
          vendorName: p.vendorName ?? null,
          sku: p.sku ?? null,
          vendorSku: p.vendorSku ?? null,
        });
        try {
          const [existing] = await db
            .select({
              id: pax8Products.id,
              name: pax8Products.name,
              sku: pax8Products.sku,
            })
            .from(pax8Products)
            .where(eq(pax8Products.productId, p.id))
            .limit(1);
          const v = {
            productId: p.id,
            name: p.name,
            vendorName: p.vendorName ?? null,
            sku: p.sku ?? null,
            vendorSku: p.vendorSku ?? null,
            shortDescription: p.shortDescription ?? null,
            raw: p as Record<string, unknown>,
          };
          if (!existing) {
            await db.insert(pax8Products).values({ ...v, fetchedAt: now });
            tally("created");
          } else if (existing.name !== v.name || existing.sku !== v.sku) {
            await db
              .update(pax8Products)
              .set({ ...v, fetchedAt: now, updatedAt: now })
              .where(eq(pax8Products.id, existing.id));
            tally("updated");
          } else {
            await db
              .update(pax8Products)
              .set({ fetchedAt: now })
              .where(eq(pax8Products.id, existing.id));
            tally("unchanged");
          }
        } catch (err) {
          await fail(
            `Product ${p.name}: ${err instanceof Error ? err.message : String(err)}`,
            { externalId: p.id },
          );
        }
      }
      // Products already mirrored but not in this run's listing still resolve names.
      if (productById.size === 0)
        for (const p of await db.select().from(pax8Products))
          productById.set(p.productId, {
            name: p.name,
            vendorName: p.vendorName,
            sku: p.sku,
            vendorSku: p.vendorSku,
          });

      // Subscriptions
      const linkByPax8 = new Map(
        (
          await db
            .select({
              pax8Id: pax8Companies.pax8Id,
              companyId: pax8Companies.companyId,
            })
            .from(pax8Companies)
        ).map((r) => [r.pax8Id, r.companyId]),
      );
      const seenSubs = new Set<string>();
      let subs: Awaited<ReturnType<typeof client.listSubscriptions>> = [];
      try {
        subs = await client.listSubscriptions();
      } catch (err) {
        await fail(
          `Subscriptions unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const s of subs) {
        counters.fetched++;
        seenSubs.add(s.id);
        try {
          const product = productById.get(s.productId);
          const commitment = commitmentOf(s.commitmentTerm);
          tally(
            await upsertSubscription(
              {
                subscriptionId: s.id,
                pax8CompanyId: s.companyId,
                companyId: linkByPax8.get(s.companyId) ?? null,
                productId: s.productId,
                productName:
                  product?.name ??
                  String(
                    (s as Record<string, unknown>).productName ?? s.productId,
                  ),
                vendorName: product?.vendorName ?? null,
                sku: product?.sku ?? null,
                vendorSku: product?.vendorSku ?? null,
                quantity: Math.max(0, Math.round(pax8Number(s.quantity) ?? 0)),
                status: s.status ?? "Unknown",
                price:
                  pax8Number(s.price) === null
                    ? null
                    : String(pax8Number(s.price)),
                currency: s.currency ?? null,
                billingTerm: s.billingTerm ?? null,
                commitmentTerm: commitment.term,
                commitmentEndsOn: commitment.endsOn,
                startDate: pax8Date(s.startDate),
                endDate: pax8Date(s.endDate),
                billingStart: pax8Date(s.billingStart),
                createdExternal: pax8Time(s.createdDate),
                raw: s as Record<string, unknown>,
              },
              now,
            ),
          );
        } catch (err) {
          await fail(
            `Subscription ${s.id}: ${err instanceof Error ? err.message : String(err)}`,
            { externalId: s.id },
          );
        }
      }
      if (subs.length)
        await db
          .update(pax8Subscriptions)
          .set({ externalStatus: "deleted", updatedAt: now })
          .where(
            and(
              eq(pax8Subscriptions.externalStatus, "active"),
              notInArray(pax8Subscriptions.subscriptionId, [...seenSubs]),
            ),
          );

      // Recent partner invoices → per-customer charge lines (best effort).
      let invoiceCount = 0;
      let itemCount = 0;
      try {
        const invoices = await client.listInvoices(config.invoiceCount);
        for (const inv of invoices) {
          const r = await mirrorPax8Invoice(client, inv, linkByPax8, now);
          if (!r.ok) {
            await fail(`Invoice ${inv.id} items: ${r.error}`, { externalId: inv.id });
            continue;
          }
          invoiceCount++;
          itemCount += r.items;
          counters.fetched += r.items;
        }
      } catch (err) {
        await fail(
          `Invoices unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Xero purchase bills for the Pax8 supplier, then match them to the invoices above.
      let billNote = "";
      try {
        const bills = await syncPax8SupplierBills(config.xeroSupplierContactId);
        if (bills !== null) {
          const rec = await reconcilePax8Invoices();
          billNote = `; ${bills} Xero bills, ${rec.matched} invoices matched`;
        }
      } catch (err) {
        await fail(
          `Xero bills unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const auto = config.autoLink
        ? await autoLinkPax8Companies(actorUserId ?? null)
        : { linked: 0 };
      const check = await runLicenceCheck(actorUserId ?? null);
      return `${seenCompanies.size} companies, ${seenSubs.size} subscriptions, ${itemCount} charge lines on ${invoiceCount} invoices${billNote}${resolved.mode === "demo" ? " (DEMO data)" : ""}; ${auto.linked} auto-linked; ${check.open} open licence discrepancies`;
    },
    actorUserId,
  );
}

type CompanyUpsert = Omit<
  typeof pax8Companies.$inferInsert,
  | "id"
  | "companyId"
  | "matchSource"
  | "externalStatus"
  | "fetchedAt"
  | "createdAt"
  | "updatedAt"
>;
async function upsertCompany(
  v: CompanyUpsert,
  now: Date,
): Promise<"created" | "updated" | "unchanged"> {
  const [existing] = await db
    .select()
    .from(pax8Companies)
    .where(eq(pax8Companies.pax8Id, v.pax8Id))
    .limit(1);
  if (!existing) {
    await db
      .insert(pax8Companies)
      .values({ ...v, externalStatus: "active", fetchedAt: now });
    return "created";
  }
  const changed =
    existing.name !== v.name ||
    existing.website !== (v.website ?? null) ||
    existing.status !== (v.status ?? null) ||
    existing.phone !== (v.phone ?? null) ||
    existing.externalStatus !== "active";
  await db
    .update(pax8Companies)
    .set(
      changed
        ? { ...v, externalStatus: "active", fetchedAt: now, updatedAt: now }
        : { fetchedAt: now },
    )
    .where(eq(pax8Companies.id, existing.id));
  return changed ? "updated" : "unchanged";
}

type SubscriptionUpsert = Omit<
  typeof pax8Subscriptions.$inferInsert,
  | "id"
  | "contractLineId"
  | "externalStatus"
  | "fetchedAt"
  | "createdAt"
  | "updatedAt"
>;
async function upsertSubscription(
  v: SubscriptionUpsert,
  now: Date,
): Promise<"created" | "updated" | "unchanged"> {
  const [existing] = await db
    .select()
    .from(pax8Subscriptions)
    .where(eq(pax8Subscriptions.subscriptionId, v.subscriptionId))
    .limit(1);
  if (!existing) {
    await db
      .insert(pax8Subscriptions)
      .values({ ...v, externalStatus: "active", fetchedAt: now });
    return "created";
  }
  const changed =
    existing.quantity !== v.quantity ||
    existing.status !== v.status ||
    existing.price !== (v.price ?? null) ||
    existing.billingTerm !== (v.billingTerm ?? null) ||
    existing.commitmentEndsOn !== (v.commitmentEndsOn ?? null) ||
    existing.endDate !== (v.endDate ?? null) ||
    existing.productName !== v.productName ||
    existing.companyId !== (v.companyId ?? null) ||
    existing.externalStatus !== "active";
  await db
    .update(pax8Subscriptions)
    .set(
      changed
        ? { ...v, externalStatus: "active", fetchedAt: now, updatedAt: now }
        : { fetchedAt: now },
    )
    .where(eq(pax8Subscriptions.id, existing.id));
  return changed ? "updated" : "unchanged";
}

// ---------------------------------------------------------------------------
// Matching Pax8 companies to CRM companies: exact registrable domain (website
// or contact email domain) or exact normalised name. Never overrides a manual
// choice; an ambiguous match is a suggestion only.
// ---------------------------------------------------------------------------
async function companyIndex() {
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      normalizedName: companies.normalizedName,
      domain: companies.domain,
    })
    .from(companies)
    .where(isNull(companies.archivedAt))
    .orderBy(asc(companies.name));
  const byDomain = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  const add = (
    map: Map<string, Set<string>>,
    key: string | null,
    id: string,
  ) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(id);
  };
  for (const r of rows) {
    add(byDomain, registrableDomain(r.domain), r.id);
    add(byName, r.normalizedName, r.id);
  }
  const contactRows = await db
    .select({ companyId: contacts.companyId, email: contacts.normalizedEmail })
    .from(contacts)
    .where(
      and(
        isNull(contacts.archivedAt),
        sql`${contacts.normalizedEmail} is not null`,
      ),
    );
  for (const c of contactRows)
    if (c.companyId && c.email?.includes("@"))
      add(byDomain, registrableDomain(c.email.split("@")[1]), c.companyId);
  const linked = new Set(
    (
      await db
        .select({ companyId: pax8Companies.companyId })
        .from(pax8Companies)
        .where(sql`${pax8Companies.companyId} is not null`)
    ).map((r) => r.companyId!),
  );
  return { rows, byDomain, byName, linked };
}

export type Pax8Suggestion = {
  id: string;
  name: string;
  reason: "domain" | "name" | "similar";
};

function suggestionsFor(
  pc: { matchDomain: string | null; normalizedName: string; name: string },
  index: Awaited<ReturnType<typeof companyIndex>>,
): Pax8Suggestion[] {
  const nameOf = new Map(index.rows.map((r) => [r.id, r.name]));
  const out: Pax8Suggestion[] = [];
  for (const id of (pc.matchDomain && index.byDomain.get(pc.matchDomain)) || [])
    out.push({ id, name: nameOf.get(id) ?? id, reason: "domain" });
  for (const id of index.byName.get(pc.normalizedName) ?? [])
    if (!out.some((s) => s.id === id))
      out.push({ id, name: nameOf.get(id) ?? id, reason: "name" });
  const stem = pc.normalizedName.replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (stem.length >= 6)
    for (const r of index.rows)
      if (
        !out.some((s) => s.id === r.id) &&
        (r.normalizedName.replace(/[^a-z0-9]/g, "").startsWith(stem) ||
          stem.startsWith(
            r.normalizedName.replace(/[^a-z0-9]/g, "").slice(0, 8),
          ))
      )
        out.push({ id: r.id, name: r.name, reason: "similar" });
  return out.slice(0, 3);
}

/** Links unlinked Pax8 companies whose domain or exact name matches exactly one unlinked CRM company. */
export async function autoLinkPax8Companies(actorUserId: string | null) {
  const index = await companyIndex();
  const candidates = await db
    .select()
    .from(pax8Companies)
    .where(
      and(
        isNull(pax8Companies.companyId),
        isNull(pax8Companies.matchSource),
        eq(pax8Companies.externalStatus, "active"),
      ),
    );
  let linked = 0;
  for (const pc of candidates) {
    const byDomain = pc.matchDomain
      ? index.byDomain.get(pc.matchDomain)
      : undefined;
    const byName = index.byName.get(pc.normalizedName);
    const ids =
      byDomain?.size === 1 ? byDomain : byName?.size === 1 ? byName : null;
    if (!ids) continue;
    const companyId = [...ids][0];
    if (index.linked.has(companyId)) continue; // one Pax8 company per CRM company
    await applyLink(pc, companyId, "auto");
    index.linked.add(companyId);
    await logActivity({
      type: "sync",
      companyId,
      entityType: "pax8_company",
      entityId: pc.id,
      title: `Pax8 company "${pc.name}" linked automatically (${byDomain?.size === 1 ? "domain" : "name"} match)`,
      actorUserId,
      source: "pax8",
    });
    linked++;
  }
  return { linked };
}

async function applyLink(
  pc: Pax8Company,
  companyId: string | null,
  matchSource: "manual" | "auto",
) {
  const now = new Date();
  await db
    .update(pax8Companies)
    .set({ companyId, matchSource, updatedAt: now })
    .where(eq(pax8Companies.id, pc.id));
  await db
    .update(pax8Subscriptions)
    .set({
      companyId,
      contractLineId:
        companyId && companyId === pc.companyId ? undefined : null,
      updatedAt: now,
    })
    .where(eq(pax8Subscriptions.pax8CompanyId, pc.pax8Id));
  await db
    .update(pax8InvoiceItems)
    .set({ companyId, updatedAt: now })
    .where(eq(pax8InvoiceItems.pax8CompanyId, pc.pax8Id));
}

export async function linkPax8Company(
  pax8CompanyRowId: string,
  companyId: string,
  actorUserId: string,
) {
  const [pc] = await db
    .select()
    .from(pax8Companies)
    .where(eq(pax8Companies.id, pax8CompanyRowId))
    .limit(1);
  if (!pc) throw new ActionError("Pax8 company not found. Run a sync first.");
  const [co] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!co) throw new ActionError("Company not found.");
  const [taken] = await db
    .select({ name: pax8Companies.name })
    .from(pax8Companies)
    .where(
      and(
        eq(pax8Companies.companyId, companyId),
        sql`${pax8Companies.id} <> ${pc.id}`,
      ),
    )
    .limit(1);
  if (taken)
    throw new ActionError(
      `${co.name} is already linked to Pax8 company "${taken.name}". Unlink that first.`,
    );
  await applyLink(pc, companyId, "manual");
  await audit({
    actorUserId,
    action: "pax8.link",
    entityType: "company",
    entityId: companyId,
    details: { pax8Id: pc.pax8Id, name: pc.name },
  });
  await logActivity({
    type: "sync",
    companyId,
    entityType: "pax8_company",
    entityId: pc.id,
    title: `Linked Pax8 company "${pc.name}"`,
    actorUserId,
    source: "pax8",
  });
  await runLicenceCheck(actorUserId, companyId);
}

// ---------------------------------------------------------------------------
// Create: a Pax8 company for a CRM company (the integration's one write)
// ---------------------------------------------------------------------------
/** Pax8 companies in the mirror that look like this CRM company: same registrable domain, same normalised name, or a shared name stem. */
async function likelyPax8Matches(co: { name: string; domain: string | null }) {
  const norm = normalizeCompanyName(co.name);
  const domain = registrableDomain(co.domain);
  const rows = await db
    .select({
      id: pax8Companies.id,
      pax8Id: pax8Companies.pax8Id,
      name: pax8Companies.name,
      normalizedName: pax8Companies.normalizedName,
      matchDomain: pax8Companies.matchDomain,
      companyId: pax8Companies.companyId,
    })
    .from(pax8Companies)
    .where(eq(pax8Companies.externalStatus, "active"));
  const stem = norm.replace(/[^a-z0-9]/g, "").slice(0, 12);
  return rows
    .map((r) => {
      const rs = r.normalizedName.replace(/[^a-z0-9]/g, "");
      const reason: "domain" | "name" | "similar" | null =
        domain && r.matchDomain === domain
          ? "domain"
          : r.normalizedName === norm
            ? "name"
            : stem.length >= 6 &&
                (rs.startsWith(stem) || stem.startsWith(rs.slice(0, 8)))
              ? "similar"
              : null;
      return { ...r, reason };
    })
    .filter((r): r is typeof r & { reason: "domain" | "name" | "similar" } => r.reason !== null)
    .sort((a, b) => ["domain", "name", "similar"].indexOf(a.reason) - ["domain", "name", "similar"].indexOf(b.reason));
}

/** Pax8 insists on a full address, phone and website. Returns the labels of whatever is missing. */
export function pax8MissingFields(co: {
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  phone: string | null;
  website: string | null;
}) {
  const missing: string[] = [];
  if (!co.addressLine1?.trim()) missing.push("address line 1");
  if (!co.city?.trim()) missing.push("city");
  if (!co.postcode?.trim()) missing.push("postcode");
  if (!co.country?.trim()) missing.push("country");
  if (!co.phone?.trim()) missing.push("phone");
  if (!co.website?.trim()) missing.push("website");
  return missing;
}

/**
 * CRM contacts shaped for Pax8. Pax8 needs a first name, last name, e-mail and
 * phone on every contact (the company phone fills a missing one) and a
 * **primary** contact for each of Admin, Billing and Technical before it
 * treats the company as Active. CRM roles map onto those types; whatever is
 * still missing falls back to the primary (or first) contact.
 */
export async function pax8ContactsFor(companyId: string, companyPhone: string | null): Promise<Pax8ContactCreate[]> {
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.companyId, companyId), isNull(contacts.archivedAt), sql`${contacts.email} is not null and ${contacts.email} <> ''`))
    .orderBy(desc(contacts.isPrimary), asc(contacts.createdAt));
  const eligible = rows.filter((c) => (c.phone ?? c.mobile ?? companyPhone)?.trim());
  if (!eligible.length) return [];
  const assigned: Record<Pax8ContactType["type"], string | null> = { Admin: null, Billing: null, Technical: null };
  const typesOf = new Map<string, Pax8ContactType["type"][]>();
  for (const c of eligible) {
    const t: Pax8ContactType["type"][] = [];
    if (c.roles.includes("billing")) t.push("Billing");
    if (c.roles.includes("technical")) t.push("Technical");
    if (c.roles.includes("decision_maker") || c.roles.includes("primary") || c.isPrimary) t.push("Admin");
    typesOf.set(c.id, t);
    for (const type of t) assigned[type] ??= c.id;
  }
  // Every type needs a primary: unfilled ones go to the first eligible contact (primary contacts sort first).
  for (const type of Object.keys(assigned) as Pax8ContactType["type"][]) {
    if (!assigned[type]) {
      assigned[type] = eligible[0].id;
      typesOf.get(eligible[0].id)!.push(type);
    }
  }
  return eligible.map((c) => ({
    firstName: c.firstName.trim(),
    lastName: (c.lastName || c.firstName).trim(),
    email: c.email!.trim(),
    phone: (c.phone ?? c.mobile ?? companyPhone)!.trim(),
    types: [...new Set(typesOf.get(c.id))].map((type) => ({ type, primary: assigned[type] === c.id })),
  }));
}

/**
 * Creates the company at Pax8 from the CRM record (billing address, phone,
 * website; the CRM id as Pax8's external id) together with its contacts, so it
 * is Active straight away, then mirrors and links it.
 * Idempotent per company through the outbound ledger; after a timeout a retry
 * reconciles by external id or exact name. Refuses when the company is already
 * linked, a Pax8 company looks like it, or required fields are missing.
 */
export async function createPax8CompanyForCompany(
  companyId: string,
  actorUserId: string,
) {
  const resolved = await getPax8Client();
  if (!resolved) throw new ActionError("Pax8 is not configured.");
  const [co] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!co) throw new ActionError("Company not found.");
  const [linked] = await db
    .select({ pax8Id: pax8Companies.pax8Id })
    .from(pax8Companies)
    .where(eq(pax8Companies.companyId, companyId))
    .limit(1);
  if (linked) return linked.pax8Id;
  const matches = await likelyPax8Matches(co);
  if (matches.length)
    throw new ActionError(
      `Pax8 already has "${matches[0].name}", which looks like this company (${matches[0].reason}). Link it from the Pax8 mapping table instead.`,
    );
  const missing = pax8MissingFields(co);
  const pax8Contacts = await pax8ContactsFor(companyId, co.phone);
  if (!pax8Contacts.length) missing.push("a contact with an e-mail address");
  if (missing.length)
    throw new ActionError(
      `Pax8 needs a full address, phone, website and at least one contact with an e-mail address. Missing: ${missing.join(", ")}. Fill them in on the company, then try again.`,
    );
  const website = /^https?:\/\//i.test(co.website!.trim())
    ? co.website!.trim()
    : `https://${co.website!.trim()}`;
  const body = {
    name: co.name,
    address: {
      street: co.addressLine1!.trim(),
      street2: co.addressLine2?.trim() || undefined,
      city: co.city!.trim(),
      stateOrProvince: co.region?.trim() || co.city!.trim(),
      postalCode: co.postcode!.trim(),
      country: co.country!.trim().toUpperCase(),
    },
    phone: co.phone!.trim(),
    website,
    externalId: companyId,
    billOnBehalfOfEnabled: false,
    selfServiceAllowed: false,
    orderApprovalRequired: false,
    contacts: pax8Contacts,
  };
  const { result } = await runOutbound(
    "pax8",
    `pax8:company:${companyId}`,
    "company.create",
    actorUserId,
    {
      requestSummary: { name: co.name },
      perform: async () => {
        const c = await resolved.client.createCompany(body);
        return { externalId: c.id, summary: { id: c.id, name: c.name }, raw: c };
      },
      reconcile: async () => {
        const all = await resolved.client.listCompanies();
        const hit =
          all.find((c) => c.externalId === companyId) ??
          all.find(
            (c) => c.name.trim().toLowerCase() === co.name.trim().toLowerCase(),
          );
        return hit
          ? { externalId: hit.id, summary: { id: hit.id, name: hit.name }, raw: hit }
          : null;
      },
    },
  );
  const now = new Date();
  const raw = result.raw ?? {
    id: result.externalId,
    name: co.name,
    website,
    phone: body.phone,
    address: body.address,
    externalId: companyId,
    status: "Active",
  };
  await db
    .insert(pax8Companies)
    .values({
      pax8Id: raw.id,
      name: raw.name,
      normalizedName: normalizeCompanyName(raw.name),
      website: raw.website ?? null,
      matchDomain: registrableDomain(raw.website),
      phone: raw.phone ?? null,
      city: raw.address?.city ?? null,
      country: raw.address?.country ?? null,
      externalRef: raw.externalId ?? null,
      status: raw.status ?? "Active",
      raw: raw as Record<string, unknown>,
      companyId,
      matchSource: "manual",
      externalStatus: "active",
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: pax8Companies.pax8Id,
      set: { companyId, matchSource: "manual", externalStatus: "active", fetchedAt: now, updatedAt: now },
    });
  await audit({
    actorUserId,
    action: "pax8.company.create",
    entityType: "company",
    entityId: companyId,
    details: { pax8Id: raw.id, name: raw.name },
  });
  await logActivity({
    type: "sync",
    companyId,
    title: `Created Pax8 company "${raw.name}" with ${pax8Contacts.length} contact${pax8Contacts.length === 1 ? "" : "s"}`,
    actorUserId,
    source: "pax8",
  });
  return raw.id;
}

/**
 * Adds the CRM contacts to an already-linked Pax8 company (one that was
 * created without contacts and is therefore Inactive and hidden in the Pax8
 * portal). Contacts Pax8 already holds (same e-mail) are skipped; each new one
 * goes through the outbound ledger. The mirror's status is refreshed from Pax8.
 */
export async function pushPax8Contacts(companyId: string, actorUserId: string) {
  const resolved = await getPax8Client();
  if (!resolved) throw new ActionError("Pax8 is not configured.");
  const [pc] = await db.select().from(pax8Companies).where(eq(pax8Companies.companyId, companyId)).limit(1);
  if (!pc) throw new ActionError("This company is not linked to a Pax8 company.");
  const [co] = await db.select({ phone: companies.phone }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const wanted = await pax8ContactsFor(companyId, co?.phone ?? null);
  if (!wanted.length) throw new ActionError("Pax8 needs at least one contact with an e-mail address (and a phone, or a company phone). Add one, then try again.");
  const existing = new Set((await resolved.client.listContacts(pc.pax8Id)).map((c) => c.email.trim().toLowerCase()));
  let added = 0;
  for (const c of wanted) {
    if (existing.has(c.email.toLowerCase())) continue;
    await runOutbound("pax8", `pax8:contact:${pc.pax8Id}:${c.email.toLowerCase()}`, "contact.create", actorUserId, {
      requestSummary: { company: pc.name, email: c.email, types: c.types },
      perform: async () => {
        const created = await resolved.client.createContact(pc.pax8Id, c);
        return { externalId: created.id, summary: { email: created.email } };
      },
      reconcile: async () => {
        const hit = (await resolved.client.listContacts(pc.pax8Id)).find((x) => x.email.trim().toLowerCase() === c.email.toLowerCase());
        return hit ? { externalId: hit.id, summary: { email: hit.email } } : null;
      },
    });
    added++;
  }
  // Pax8 flips the company to Active once every type has a primary; read it back.
  const now = new Date();
  const fresh = (await resolved.client.listCompanies()).find((c) => c.id === pc.pax8Id);
  if (fresh) await db.update(pax8Companies).set({ status: fresh.status ?? pc.status, raw: fresh as Record<string, unknown>, fetchedAt: now, updatedAt: now }).where(eq(pax8Companies.id, pc.id));
  await audit({ actorUserId, action: "pax8.contacts.push", entityType: "company", entityId: companyId, details: { pax8Id: pc.pax8Id, added, status: fresh?.status ?? null } });
  await logActivity({ type: "sync", companyId, title: `Pushed ${added} contact${added === 1 ? "" : "s"} to Pax8 company "${pc.name}"${fresh?.status ? ` (now ${fresh.status})` : ""}`, actorUserId, source: "pax8" });
  return { added, status: fresh?.status ?? null };
}

/**
 * Post-commit hook for "a company became a customer". Never throws: the
 * company change that triggered it has already been committed. Does nothing
 * unless the Pax8 setting is on.
 */
export async function ensurePax8CompanyForCustomer(
  companyId: string,
  actorUserId: string | null,
  reason: string,
): Promise<{ action: "created" | "review" | "skipped" | "failed"; detail?: string }> {
  try {
    const resolved = await getPax8Client();
    if (!resolved) return { action: "skipped", detail: "Pax8 not configured" };
    if (!resolved.config.autoCreateCompanies)
      return { action: "skipped", detail: "auto-create off" };
    const [co] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!co || co.archivedAt || co.status !== "customer")
      return { action: "skipped", detail: "not an active customer" };
    const [linked] = await db
      .select({ id: pax8Companies.id, status: pax8Companies.status })
      .from(pax8Companies)
      .where(eq(pax8Companies.companyId, companyId))
      .limit(1);
    if (linked) {
      // Created earlier without contacts (Inactive at Pax8): add them as soon as the CRM has one.
      if (linked.status && linked.status.toLowerCase() !== "active" && (await pax8ContactsFor(companyId, co.phone)).length) {
        const actor = actorUserId ?? (await db.select({ id: user.id }).from(user).where(eq(user.role, "admin")).limit(1))[0]?.id ?? null;
        if (!actor) return { action: "skipped", detail: "no actor" };
        await pushPax8Contacts(companyId, actor);
        return { action: "created", detail: "contacts added" };
      }
      return { action: "skipped", detail: "already linked" };
    }
    const matches = await likelyPax8Matches(co);
    if (matches.length) {
      const m = matches[0];
      await raiseConflict({
        provider: "pax8",
        entityType: "company",
        localId: companyId,
        externalId: m.pax8Id,
        kind: "ambiguous_match",
        message: `"${co.name}" became a customer (${reason}) but Pax8 already has "${m.name}" (matched by ${m.reason}). Link it from the Pax8 page, or create the company there if it really is a different business. Nothing was created automatically.`,
        details: { reason, match: m },
      });
      await logActivity({
        type: "sync",
        companyId,
        title: `Pax8 company not created automatically: "${m.name}" looks like this company; review item raised`,
        actorUserId,
        source: "pax8",
      });
      return { action: "review", detail: m.name };
    }
    const missing = pax8MissingFields(co);
    if (!(await pax8ContactsFor(companyId, co.phone)).length) missing.push("a contact with an e-mail address");
    if (missing.length) {
      await logActivity({
        type: "sync",
        companyId,
        title: `Pax8 company not created automatically: Pax8 needs ${missing.join(", ")}. Fill them in (it runs again when a contact is saved), or use "Create in Pax8" on the Subscriptions tab.`,
        actorUserId,
        source: "pax8",
      });
      return { action: "skipped", detail: `missing ${missing.join(", ")}` };
    }
    const actor =
      actorUserId ??
      (
        await db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.role, "admin"))
          .limit(1)
      )[0]?.id ??
      null;
    if (!actor) return { action: "skipped", detail: "no actor" };
    await createPax8CompanyForCompany(companyId, actor);
    return { action: "created" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, companyId }, "automatic Pax8 company creation failed");
    await logActivity({
      type: "sync",
      companyId,
      title: `Pax8 company could not be created automatically: ${msg}`,
      actorUserId,
      source: "pax8",
    }).catch(() => undefined);
    return { action: "failed", detail: msg };
  }
}

export async function unlinkPax8Company(
  pax8CompanyRowId: string,
  actorUserId: string,
) {
  const [pc] = await db
    .select()
    .from(pax8Companies)
    .where(eq(pax8Companies.id, pax8CompanyRowId))
    .limit(1);
  if (!pc) throw new ActionError("Pax8 company not found.");
  // matchSource stays "manual" with no company so the next sync does not re-link it automatically.
  await applyLink(pc, null, "manual");
  await audit({
    actorUserId,
    action: "pax8.unlink",
    entityType: "company",
    entityId: pc.companyId ?? "none",
    details: { pax8Id: pc.pax8Id, name: pc.name },
  });
  if (pc.companyId)
    await logActivity({
      type: "sync",
      companyId: pc.companyId,
      entityType: "pax8_company",
      entityId: pc.id,
      title: `Unlinked Pax8 company "${pc.name}"`,
      actorUserId,
      source: "pax8",
    });
}

// ---------------------------------------------------------------------------
// Subscriptions ↔ contract lines. A person's explicit choice wins; otherwise
// the CRM product SKU must equal the Pax8 SKU or vendor SKU, or the product
// name (or line description) must equal the Pax8 product name.
// ---------------------------------------------------------------------------
const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export type MatchableLine = {
  id: string;
  contractId: string;
  contractName: string;
  contractStatus: string;
  description: string;
  quantity: string;
  unitPrice: string;
  unitCost: string | null;
  billingFrequency: string;
  pricingModel: string;
  productSku: string | null;
  productName: string | null;
};

export async function matchableLines(
  companyId: string,
  statuses: ("draft" | "active")[] = ["draft", "active"],
): Promise<MatchableLine[]> {
  return db
    .select({
      id: contractLines.id,
      contractId: contracts.id,
      contractName: contracts.name,
      contractStatus: contracts.status,
      description: contractLines.description,
      quantity: contractLines.quantity,
      unitPrice: contractLines.unitPrice,
      unitCost: contractLines.unitCost,
      billingFrequency: contractLines.billingFrequency,
      pricingModel: contractLines.pricingModel,
      productSku: products.sku,
      productName: products.name,
    })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .leftJoin(products, eq(products.id, contractLines.productId))
    .where(
      and(
        eq(contracts.companyId, companyId),
        isNull(contracts.archivedAt),
        inArray(contracts.status, statuses),
      ),
    )
    .orderBy(asc(contracts.name), asc(contractLines.sortOrder));
}

export type LineMatch = {
  line: MatchableLine;
  by: "manual" | "sku" | "name";
} | null;

export function matchLine(
  sub: Pick<
    Pax8Subscription,
    "contractLineId" | "sku" | "vendorSku" | "productName"
  >,
  lines: MatchableLine[],
): LineMatch {
  if (sub.contractLineId) {
    const line = lines.find((l) => l.id === sub.contractLineId);
    if (line) return { line, by: "manual" };
  }
  const skus = new Set([norm(sub.sku), norm(sub.vendorSku)].filter(Boolean));
  const bySku = skus.size
    ? lines.find((l) => l.productSku && skus.has(norm(l.productSku)))
    : undefined;
  if (bySku) return { line: bySku, by: "sku" };
  const name = norm(sub.productName);
  const byName = name
    ? lines.find(
        (l) => norm(l.productName) === name || norm(l.description) === name,
      )
    : undefined;
  return byName ? { line: byName, by: "name" } : null;
}

/** Monthly partner cost per unit, from the per-term price. Null for one-off or unknown terms. */
export function monthlyUnitCost(
  price: string | number | null,
  billingTerm: string | null,
): number | null {
  const p = pax8Number(price);
  const months = termMonths(billingTerm);
  if (p === null || !months) return null;
  return p / months;
}

export async function setSubscriptionBillingLine(
  subscriptionRowId: string,
  contractLineId: string | null,
  actorUserId: string,
) {
  const [s] = await db
    .select()
    .from(pax8Subscriptions)
    .where(eq(pax8Subscriptions.id, subscriptionRowId))
    .limit(1);
  if (!s) throw new ActionError("Subscription not found.");
  if (!s.companyId)
    throw new ActionError(
      "Link the Pax8 company to a CRM company before choosing what bills its subscriptions.",
    );
  if (contractLineId) {
    const lines = await matchableLines(s.companyId);
    if (!lines.some((l) => l.id === contractLineId))
      throw new ActionError(
        "That contract line belongs to a different company.",
      );
  }
  await db
    .update(pax8Subscriptions)
    .set({ contractLineId, updatedAt: new Date() })
    .where(eq(pax8Subscriptions.id, s.id));
  await audit({
    actorUserId,
    action: "pax8.billing_line",
    entityType: "company",
    entityId: s.companyId,
    details: {
      subscriptionId: s.subscriptionId,
      product: s.productName,
      contractLineId,
    },
  });
  await runLicenceCheck(actorUserId, s.companyId);
}

/**
 * Changes the licence count of a subscription at Pax8 from the CRM. The one
 * customer-billable write: gated by the admin setting "allow quantity
 * changes", a confirmation in the UI and contract.write, recorded in the
 * outbound ledger and the audit log with the reason given, noted on the
 * company timeline, then the licence check runs so the contract comparison
 * reflects the new count. Going to zero is a cancellation and stays in the
 * Pax8 portal.
 */
export async function changePax8SubscriptionQuantity(
  subscriptionRowId: string,
  quantity: number,
  reason: string,
  actorUserId: string,
) {
  if (!Number.isInteger(quantity) || quantity < 1)
    throw new ActionError(
      "Quantity must be a whole number of at least 1. To cancel a subscription use the Pax8 portal.",
    );
  const note = reason.trim();
  if (note.length < 3)
    throw new ActionError("Give a short reason for the change (it goes in the audit log).");
  const resolved = await getPax8Client();
  if (!resolved) throw new ActionError("Pax8 is not connected.");
  if (!resolved.config.allowQuantityChanges)
    throw new ActionError(
      "Quantity changes from the CRM are switched off. An administrator can allow them under Integrations → Pax8.",
    );
  const [s] = await db
    .select()
    .from(pax8Subscriptions)
    .where(eq(pax8Subscriptions.id, subscriptionRowId))
    .limit(1);
  if (!s) throw new ActionError("Subscription not found.");
  if (!s.companyId)
    throw new ActionError(
      "Link the Pax8 company to a CRM company before changing its subscriptions.",
    );
  if (s.externalStatus !== "active")
    throw new ActionError("Pax8 no longer has this subscription.");
  if (s.status !== "Active" && s.status !== "Activated")
    throw new ActionError(
      `Only Active subscriptions can be changed from the CRM (this one is ${s.status}).`,
    );
  if (s.quantity === quantity)
    throw new ActionError(`The subscription already has ${quantity} licence${quantity === 1 ? "" : "s"}.`);
  const from = s.quantity;
  // The key carries the mirror's last change time, so a repeated submit of
  // the same change is served from the ledger while a later, different one
  // (or the same count after it moved) is a new request.
  const { result } = await runOutbound(
    "pax8",
    `pax8:sub-qty:${s.subscriptionId}:${quantity}:${s.updatedAt.getTime()}`,
    "subscription.quantity",
    actorUserId,
    {
      requestSummary: { product: s.productName, from, to: quantity, reason: note },
      perform: async () => {
        const updated = await resolved.client.updateSubscription(
          s.subscriptionId,
          { quantity },
        );
        return {
          externalId: updated.id,
          summary: { quantity: pax8Number(updated.quantity) ?? quantity },
        };
      },
    },
  );
  const to = Number(result.summary?.quantity ?? quantity);
  await db
    .update(pax8Subscriptions)
    .set({ quantity: to, updatedAt: new Date() })
    .where(eq(pax8Subscriptions.id, s.id));
  await audit({
    actorUserId,
    action: "pax8.subscription.quantity",
    entityType: "company",
    entityId: s.companyId,
    details: {
      subscriptionId: s.subscriptionId,
      product: s.productName,
      from,
      to,
      reason: note,
    },
  });
  const unitMonthly = monthlyUnitCost(s.price, s.billingTerm);
  const costDelta = unitMonthly === null ? null : (to - from) * unitMonthly;
  await logActivity({
    type: "contract",
    companyId: s.companyId,
    entityType: "pax8_subscription",
    entityId: s.id,
    title: `Pax8 licences for "${s.productName}" changed from ${from} to ${to}${costDelta !== null ? ` (${costDelta >= 0 ? "+" : "−"}${Math.abs(costDelta).toFixed(2)}/month cost)` : ""}: ${note}`,
    actorUserId,
    source: "pax8",
  });
  await runLicenceCheck(actorUserId, s.companyId);
  return { from, to, costDelta };
}

/** Copies the Pax8 partner cost onto the contract line that bills the subscription, converted to the line's billing period. Audited; price is never touched. */
export async function applyPax8Cost(
  subscriptionRowId: string,
  actorUserId: string,
) {
  const [s] = await db
    .select()
    .from(pax8Subscriptions)
    .where(eq(pax8Subscriptions.id, subscriptionRowId))
    .limit(1);
  if (!s || !s.companyId)
    throw new ActionError("Subscription not found or not linked to a company.");
  const match = matchLine(s, await matchableLines(s.companyId));
  if (!match)
    throw new ActionError(
      "No contract line bills this subscription yet. Choose one first.",
    );
  const monthly = monthlyUnitCost(s.price, s.billingTerm);
  const months = LINE_MONTHS[match.line.billingFrequency] ?? null;
  if (monthly === null || !months)
    throw new ActionError(
      "This subscription has no recurring per-unit price to apply.",
    );
  const unitCost = (Math.round(monthly * months * 100) / 100).toFixed(2);
  await db
    .update(contractLines)
    .set({ unitCost, updatedAt: new Date() })
    .where(eq(contractLines.id, match.line.id));
  await audit({
    actorUserId,
    action: "contract.line.cost",
    entityType: "contract",
    entityId: match.line.contractId,
    details: {
      contractLineId: match.line.id,
      from: match.line.unitCost,
      to: unitCost,
      source: "pax8",
      subscriptionId: s.subscriptionId,
    },
  });
  await logActivity({
    type: "contract",
    companyId: s.companyId,
    entityType: "contract",
    entityId: match.line.contractId,
    title: `Unit cost of "${match.line.description}" set to ${unitCost} from Pax8 (${s.productName})`,
    actorUserId,
    source: "pax8",
  });
  return { contractLineId: match.line.id, unitCost, from: match.line.unitCost };
}

// ---------------------------------------------------------------------------
// Licence check: contracted quantity on the matched line vs licences held at
// Pax8. Writes billing_discrepancies rows with source = pax8 for review.
// ---------------------------------------------------------------------------
export async function runLicenceCheck(
  actorUserId: string | null,
  companyId?: string,
) {
  const subs = await db
    .select()
    .from(pax8Subscriptions)
    .where(
      and(
        eq(pax8Subscriptions.externalStatus, "active"),
        inArray(pax8Subscriptions.status, BILLED_STATUSES),
        sql`${pax8Subscriptions.companyId} is not null`,
        companyId ? eq(pax8Subscriptions.companyId, companyId) : undefined,
      ),
    );
  const byCompany = new Map<string, Pax8Subscription[]>();
  for (const s of subs)
    byCompany.set(s.companyId!, [...(byCompany.get(s.companyId!) ?? []), s]);
  let open = 0;
  let resolvedCount = 0;
  let checked = 0;
  const now = new Date();
  for (const [cid, list] of byCompany) {
    const lines = await matchableLines(cid, ["active"]);
    const coverage = await coverageFor("pax8_subscription", { companyId: cid });
    const observedByLine = new Map<
      string,
      { line: MatchableLine; observed: number; subscriptionIds: string[] }
    >();
    for (const s of list) {
      // Explicit coverage first: a bundled subscription counts toward its bundle line; free, internal and commitment-covered ones count toward nothing.
      const cov = coverage.get(s.id);
      if (cov && (isNonBillable(cov) || cov.state === "commitment")) continue;
      const m = cov?.state === "bundle" && cov.contractLineId ? ((l) => (l ? { line: l, by: "manual" as const } : null))(lines.find((l) => l.id === cov.contractLineId)) : matchLine(s, lines);
      if (!m) continue;
      const cur = observedByLine.get(m.line.id) ?? {
        line: m.line,
        observed: 0,
        subscriptionIds: [],
      };
      cur.observed += s.quantity;
      cur.subscriptionIds.push(s.subscriptionId);
      observedByLine.set(m.line.id, cur);
    }
    for (const { line, observed, subscriptionIds } of observedByLine.values()) {
      checked++;
      const contracted = Number(line.quantity);
      const diff = observed - contracted;
      const [existing] = await db
        .select()
        .from(billingDiscrepancies)
        .where(
          and(
            eq(billingDiscrepancies.source, "pax8"),
            eq(billingDiscrepancies.contractLineId, line.id),
            inArray(billingDiscrepancies.status, ["open", "accepted"]),
          ),
        )
        .orderBy(desc(billingDiscrepancies.detectedAt))
        .limit(1);
      const basis = {
        source: "pax8",
        subscriptionIds,
        statuses: BILLED_STATUSES,
        checkedAt: now.toISOString(),
      };
      if (diff === 0) {
        if (existing) {
          await db
            .update(billingDiscrepancies)
            .set({
              status: "resolved",
              observedQty: observed,
              difference: "0",
              note: "Counts now match",
              lastSeenAt: now,
              updatedAt: now,
            })
            .where(eq(billingDiscrepancies.id, existing.id));
          resolvedCount++;
        }
        continue;
      }
      if (existing) {
        const changed = existing.observedQty !== observed;
        await db
          .update(billingDiscrepancies)
          .set({
            observedQty: observed,
            contractedQty: String(contracted),
            difference: String(diff),
            lastSeenAt: now,
            basis,
            status:
              existing.status === "accepted" &&
              changed &&
              Math.abs(diff) > Math.abs(Number(existing.difference))
                ? "open"
                : existing.status,
            updatedAt: now,
          })
          .where(eq(billingDiscrepancies.id, existing.id));
        if (existing.status === "open") open++;
      } else {
        await db
          .insert(billingDiscrepancies)
          .values({
            source: "pax8",
            companyId: cid,
            contractId: line.contractId,
            contractLineId: line.id,
            siteId: null,
            lineDescription: line.description,
            contractedQty: String(contracted),
            observedQty: observed,
            difference: String(diff),
            unitPrice: line.unitPrice,
            basis,
          });
        await logActivity({
          type: "sync",
          companyId: cid,
          entityType: "contract",
          entityId: line.contractId,
          title: `Licence count discrepancy: ${line.description} contracted ${contracted}, Pax8 has ${observed} (${diff > 0 ? "+" : ""}${diff})`,
          actorUserId,
          source: "pax8",
        });
        open++;
      }
    }
  }
  return { open, resolved: resolvedCount, checked };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export type Pax8Freshness = "live" | "cached" | "stale" | "unavailable";
export function pax8Freshness(
  fetchedAt: Date | null | undefined,
  pollMinutes = 60,
): Pax8Freshness {
  if (!fetchedAt) return "unavailable";
  const age = Date.now() - fetchedAt.getTime();
  if (age < 5 * 60_000) return "live";
  if (age < 3 * pollMinutes * 60_000) return "cached";
  return "stale";
}


/** Mirrors one Pax8 invoice and its charge lines (used by the routine sync and the historical import). */
export async function mirrorPax8Invoice(
  client: Pax8Client,
  inv: Pax8InvoiceRaw,
  linkByPax8: Map<string, string | null>,
  now: Date,
): Promise<{ ok: true; items: number } | { ok: false; error: string }> {
  let items: Pax8InvoiceItemRaw[] = [];
  try {
    items = await client.listInvoiceItems(inv.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const money = (v: unknown) => (pax8Number(v) === null ? null : String(Math.round(pax8Number(v)! * 100) / 100));
  const itemsTotal = items.reduce((a, it) => a + (pax8Number(it.total) ?? 0), 0);
  const invValues = {
    pax8InvoiceId: inv.id,
    status: inv.status ?? null,
    invoiceDate: pax8Date(inv.invoiceDate),
    dueDate: pax8Date(inv.dueDate),
    total: money(inv.total),
    balance: money(inv.balance),
    itemsTotal: String(Math.round(itemsTotal * 100) / 100),
    currency: inv.currency ?? null,
    partnerName: inv.partnerName ?? null,
    externalId: inv.externalId ?? null,
    raw: inv as Record<string, unknown>,
  };
  await db
    .insert(pax8Invoices)
    .values({ ...invValues, fetchedAt: now })
    .onConflictDoUpdate({ target: pax8Invoices.pax8InvoiceId, set: { ...invValues, fetchedAt: now, updatedAt: now } });
  for (const it of items) {
    const v = {
      itemId: it.id,
      invoiceId: inv.id,
      invoiceDate: pax8Date(inv.invoiceDate),
      invoiceStatus: inv.status ?? null,
      pax8CompanyId: it.companyId ?? null,
      companyId: it.companyId ? (linkByPax8.get(it.companyId) ?? null) : null,
      productId: it.productId ?? null,
      sku: it.sku ?? null,
      description: it.description ?? null,
      quantity: pax8Number(it.quantity) === null ? null : String(pax8Number(it.quantity)),
      unitPrice: pax8Number(it.unitPrice) === null ? null : String(pax8Number(it.unitPrice)),
      total: pax8Number(it.total) === null ? null : String(pax8Number(it.total)),
      currency: it.currency ?? inv.currency ?? null,
      startPeriod: pax8Date(it.startPeriod),
      endPeriod: pax8Date(it.endPeriod),
      chargeType: it.chargeType ?? it.type ?? null,
      raw: it as Record<string, unknown>,
    };
    await db
      .insert(pax8InvoiceItems)
      .values({ ...v, fetchedAt: now })
      .onConflictDoUpdate({ target: pax8InvoiceItems.itemId, set: { ...v, fetchedAt: now, updatedAt: now } });
  }
  return { ok: true, items: items.length };
}

/** Links Pax8 company id → CRM company id, from the mirrored companies. */
async function pax8CompanyLinks() {
  const rows = await db.select({ pax8Id: pax8Companies.pax8Id, companyId: pax8Companies.companyId }).from(pax8Companies).where(sql`${pax8Companies.companyId} is not null`);
  return new Map(rows.map((r) => [r.pax8Id, r.companyId!]));
}

/**
 * Historical import: every Pax8 invoice dated on or after `fromDate`, with its
 * charge lines, added to the mirror without touching what is already there
 * (same upsert as the sync, so nothing is duplicated and hand matches on
 * existing invoices survive). Then the supplier's bills are matched again.
 */
export async function importPax8InvoicesSince(fromDate: string, actorUserId: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) throw new ActionError("Enter the date as YYYY-MM-DD.");
  const resolved = await getPax8Client();
  if (!resolved) throw new ActionError("Pax8 is not connected.");
  const before = new Set((await db.select({ id: pax8Invoices.pax8InvoiceId }).from(pax8Invoices)).map((r) => r.id));
  const links = await pax8CompanyLinks();
  const now = new Date();
  const invoices = await resolved.client.listInvoicesSince(fromDate);
  let added = 0;
  let refreshed = 0;
  let items = 0;
  const failures: string[] = [];
  for (const inv of invoices) {
    const r = await mirrorPax8Invoice(resolved.client, inv, links, now);
    if (!r.ok) {
      failures.push(`${inv.id}: ${r.error}`);
      continue;
    }
    items += r.items;
    if (before.has(inv.id)) refreshed++;
    else added++;
  }
  const rec = await reconcilePax8Invoices();
  await audit({ actorUserId, action: "pax8.invoices.import", entityType: "integration", entityId: "pax8", details: { fromDate, found: invoices.length, added, refreshed, items, failures: failures.length, matched: rec.matched } });
  return { fromDate, found: invoices.length, added, refreshed, items, failures, matched: rec.matched };
}

// ---------------------------------------------------------------------------
// Pax8 invoices vs Xero bills. The Pax8 supplier is a Xero contact chosen on
// the Pax8 page; its ACCPAY bills are mirrored into xero_invoices (type
// ACCPAY, never shown among sales invoices) and matched to the mirrored
// Pax8 invoices by reference, then by unique total within ten days. People
// can match or unmatch by hand; a hand decision is never overridden.
// ---------------------------------------------------------------------------
const BILL_DEAD = ["VOIDED", "DELETED"] as const;

/** Mirrors every purchase bill of the supplier contact. Returns the count, or null when no supplier is set or Xero is not available. */
export async function syncPax8SupplierBills(
  supplierContactId: string | null | undefined,
): Promise<number | null> {
  if (!supplierContactId) return null;
  const xero = await getXeroClient();
  if (!xero) return null;
  let count = 0;
  for (let page = 1; page <= 20; page++) {
    const batch = await xero.client.listInvoices({
      page,
      contactIds: [supplierContactId],
    });
    for (const inv of batch) {
      if (inv.Type !== "ACCPAY") continue;
      await upsertXeroInvoice(inv);
      count++;
    }
    if (batch.length < 100) break;
  }
  return count;
}

async function supplierBills(supplierContactId: string) {
  return db
    .select({
      invoiceId: xeroInvoices.invoiceId,
      invoiceNumber: xeroInvoices.invoiceNumber,
      reference: xeroInvoices.reference,
      status: xeroInvoices.status,
      date: xeroInvoices.date,
      dueDate: xeroInvoices.dueDate,
      total: xeroInvoices.total,
      amountDue: xeroInvoices.amountDue,
      currencyCode: xeroInvoices.currencyCode,
    })
    .from(xeroInvoices)
    .where(
      and(
        eq(xeroInvoices.type, "ACCPAY"),
        eq(xeroInvoices.contactId, supplierContactId),
        notInArray(xeroInvoices.status, [...BILL_DEAD]),
      ),
    )
    .orderBy(desc(xeroInvoices.date));
}

async function pax8SupplierId() {
  const conn = await getConnection("pax8");
  return ((conn.config ?? {}) as Pax8Config).xeroSupplierContactId ?? null;
}

/** Auto-matches unmatched Pax8 invoices to the supplier's bills; hand decisions (match_source = manual) are left alone. */
export async function reconcilePax8Invoices() {
  const supplier = await pax8SupplierId();
  if (!supplier) return { matched: 0 };
  const invoices = await db
    .select()
    .from(pax8Invoices)
    .where(isNull(pax8Invoices.xeroInvoiceId));
  const candidates = invoices.filter((i) => i.matchSource !== "manual");
  const taken = new Set(
    (
      await db
        .select({ x: pax8Invoices.xeroInvoiceId })
        .from(pax8Invoices)
        .where(sql`${pax8Invoices.xeroInvoiceId} is not null`)
    ).map((r) => r.x!),
  );
  const bills = (await supplierBills(supplier)).filter(
    (b) => !taken.has(b.invoiceId),
  );
  const matches = matchPax8Bills(
    candidates.map((i) => ({
      id: i.id,
      pax8InvoiceId: i.pax8InvoiceId,
      externalId: i.externalId,
      total: pax8Number(i.total),
      invoiceDate: i.invoiceDate,
    })),
    bills.map((b) => ({
      invoiceId: b.invoiceId,
      invoiceNumber: b.invoiceNumber,
      reference: b.reference,
      total: pax8Number(b.total),
      date: b.date,
    })),
  );
  for (const [rowId, m] of matches)
    await db
      .update(pax8Invoices)
      .set({ xeroInvoiceId: m.billId, matchSource: m.basis, updatedAt: new Date() })
      .where(eq(pax8Invoices.id, rowId));
  return { matched: matches.size };
}

/** Chooses the Xero contact that is the Pax8 supplier, re-mirrors its bills and re-runs the matcher. Auto matches from a previous supplier are dropped; hand matches are kept. */
export async function setPax8Supplier(
  contactId: string | null,
  actorUserId: string,
) {
  if (contactId) {
    const [c] = await db
      .select({ id: xeroContacts.contactId, name: xeroContacts.name })
      .from(xeroContacts)
      .where(eq(xeroContacts.contactId, contactId))
      .limit(1);
    if (!c) throw new ActionError("That Xero contact is not in the mirror. Sync Xero first.");
  }
  await setConnectionConfig("pax8", { xeroSupplierContactId: contactId }, actorUserId);
  await db
    .update(pax8Invoices)
    .set({ xeroInvoiceId: null, matchSource: null, updatedAt: new Date() })
    .where(inArray(pax8Invoices.matchSource, ["auto", "reference", "amount"]));
  if (!contactId) return { bills: 0, matched: 0 };
  const bills = (await syncPax8SupplierBills(contactId)) ?? 0;
  const rec = await reconcilePax8Invoices();
  return { bills, matched: rec.matched };
}

/** A person matches a Pax8 invoice to a bill, or clears the match (remembered, so the matcher leaves it alone). */
export async function matchPax8Invoice(
  pax8InvoiceRowId: string,
  xeroInvoiceId: string | null,
  actorUserId: string,
) {
  const [inv] = await db
    .select()
    .from(pax8Invoices)
    .where(eq(pax8Invoices.id, pax8InvoiceRowId))
    .limit(1);
  if (!inv) throw new ActionError("Pax8 invoice not found.");
  if (xeroInvoiceId) {
    const supplier = await pax8SupplierId();
    if (!supplier) throw new ActionError("Choose the Pax8 supplier contact first.");
    const bill = (await supplierBills(supplier)).find((b) => b.invoiceId === xeroInvoiceId);
    if (!bill) throw new ActionError("That bill is not one of the Pax8 supplier's bills.");
    const [other] = await db
      .select({ id: pax8Invoices.id, pax8InvoiceId: pax8Invoices.pax8InvoiceId })
      .from(pax8Invoices)
      .where(and(eq(pax8Invoices.xeroInvoiceId, xeroInvoiceId), sql`${pax8Invoices.id} <> ${inv.id}`))
      .limit(1);
    if (other)
      throw new ActionError(`That bill is already matched to Pax8 invoice ${other.pax8InvoiceId}. Unmatch it there first.`);
  }
  await db
    .update(pax8Invoices)
    .set({ xeroInvoiceId, matchSource: "manual", updatedAt: new Date() })
    .where(eq(pax8Invoices.id, inv.id));
  await audit({
    actorUserId,
    action: "pax8.invoice.match",
    entityType: "integration",
    entityId: "pax8",
    details: { pax8InvoiceId: inv.pax8InvoiceId, xeroInvoiceId, previous: inv.xeroInvoiceId },
  });
}

export type Pax8ReconciliationRow = {
  id: string;
  pax8InvoiceId: string;
  allocation: AllocationSummary | null;
  status: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  total: number | null;
  itemsTotal: number | null;
  currency: string | null;
  matchSource: string | null;
  bill: {
    invoiceId: string;
    invoiceNumber: string | null;
    reference: string | null;
    status: string;
    date: string | null;
    total: number | null;
    amountDue: number | null;
  } | null;
  difference: number | null;
  state: ReconcileState;
};

/** Everything the Pax8 page needs for the invoices-vs-bills card. */
export async function pax8InvoiceReconciliation() {
  const supplierId = await pax8SupplierId();
  const suppliers = await db
    .select({ contactId: xeroContacts.contactId, name: xeroContacts.name })
    .from(xeroContacts)
    .where(and(eq(xeroContacts.isSupplier, true), sql`coalesce(${xeroContacts.contactStatus}, 'ACTIVE') <> 'ARCHIVED'`))
    .orderBy(asc(xeroContacts.name));
  const supplier = supplierId
    ? ((await db.select({ contactId: xeroContacts.contactId, name: xeroContacts.name }).from(xeroContacts).where(eq(xeroContacts.contactId, supplierId)).limit(1))[0] ?? { contactId: supplierId, name: supplierId })
    : null;
  const invoices = await db.select().from(pax8Invoices).orderBy(desc(pax8Invoices.invoiceDate), desc(pax8Invoices.pax8InvoiceId));
  const bills = supplierId ? await supplierBills(supplierId) : [];
  const byId = new Map(bills.map((b) => [b.invoiceId, b]));
  const usedBills = new Set<string>();
  const allocations = await pax8AllocationSummaries(invoices.map((i) => ({ pax8InvoiceId: i.pax8InvoiceId, xeroInvoiceId: i.xeroInvoiceId })));
  const rows: Pax8ReconciliationRow[] = invoices.map((i) => {
    const b = i.xeroInvoiceId ? (byId.get(i.xeroInvoiceId) ?? null) : null;
    if (b) usedBills.add(b.invoiceId);
    const total = pax8Number(i.total);
    const bill = b
      ? { invoiceId: b.invoiceId, invoiceNumber: b.invoiceNumber, reference: b.reference, status: b.status, date: b.date, total: pax8Number(b.total), amountDue: pax8Number(b.amountDue) }
      : null;
    return {
      id: i.id,
      pax8InvoiceId: i.pax8InvoiceId,
      allocation: allocations.get(i.pax8InvoiceId) ?? null,
      status: i.status,
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      total,
      itemsTotal: pax8Number(i.itemsTotal),
      currency: i.currency,
      matchSource: i.matchSource,
      bill,
      difference: bill && total !== null && bill.total !== null ? Math.round((bill.total - total) * 100) / 100 : null,
      state: reconcileState(total, bill),
    };
  });
  const oldestPax8 = invoices.reduce<string | null>((a, i) => (i.invoiceDate && (!a || i.invoiceDate < a) ? i.invoiceDate : a), null);
  const newestPax8 = invoices.reduce<string | null>((a, i) => (i.invoiceDate && (!a || i.invoiceDate > a) ? i.invoiceDate : a), null);
  const lastFetched = invoices.reduce<Date | null>((a, i) => (!a || i.fetchedAt > a ? i.fetchedAt : a), null);
  const toBill = (b: (typeof bills)[number]) => ({ invoiceId: b.invoiceId, invoiceNumber: b.invoiceNumber, reference: b.reference, status: b.status, date: b.date, total: pax8Number(b.total), amountDue: pax8Number(b.amountDue), currencyCode: b.currencyCode });
  // Bills nobody matched, within the window the Pax8 mirror covers; older ones are "outside imported history", not a finding, until an import brings their invoices in.
  const unmatchedBills = bills.filter((b) => !usedBills.has(b.invoiceId) && (!oldestPax8 || !b.date || b.date >= oldestPax8)).map(toBill);
  const olderBills = bills.filter((b) => !usedBills.has(b.invoiceId) && oldestPax8 && b.date && b.date < oldestPax8).map(toBill);
  const freeBills = bills
    .filter((b) => !usedBills.has(b.invoiceId))
    .map((b) => ({ invoiceId: b.invoiceId, label: `${b.invoiceNumber ?? b.invoiceId}${b.reference ? ` · ${b.reference}` : ""} · ${b.date ?? "no date"} · ${b.total ?? "?"}` }));
  return {
    supplier,
    suppliers,
    rows,
    unmatchedBills,
    olderBills,
    freeBills,
    /** What the mirror holds: the stretch of Pax8 invoices imported and when they were last fetched. */
    coverage: { oldest: oldestPax8, newest: newestPax8, count: invoices.length, lastFetched },
    totals: {
      invoices: rows.length,
      matched: rows.filter((r) => r.state === "matched").length,
      differs: rows.filter((r) => r.state === "amount_differs").length,
      noBill: rows.filter((r) => r.state === "no_bill").length,
      extraBills: unmatchedBills.length,
      olderBills: olderBills.length,
      unallocated: rows.reduce((a, r) => a + (r.allocation?.unallocated ?? 0), 0),
      chargeFindings: rows.reduce((a, r) => a + (r.allocation ? r.allocation.findings.no_customer + r.allocation.findings.no_subscription + r.allocation.findings.price_differs : 0), 0),
    },
    xeroConfigured: Boolean(await getXeroClient()),
  };
}


// ---------------------------------------------------------------------------
// Charge-level allocation: each Pax8 invoice line → CRM customer → mirrored
// subscription, with the findings the brief asks for (supplier charge
// without a customer, charge for no known subscription, price or quantity
// differing from the subscription). Compared with the matched Xero bill's
// lines only when that bill has line detail; a one-line bill is reported as
// total-matched, never as reconciled line by line.
// ---------------------------------------------------------------------------
export type AllocationFinding = "ok" | "no_customer" | "no_subscription" | "price_differs" | "quantity_differs";
export const ALLOCATION_FINDING_LABELS: Record<AllocationFinding, string> = {
  ok: "allocated",
  no_customer: "no customer",
  no_subscription: "no matching subscription",
  price_differs: "price differs from subscription",
  quantity_differs: "quantity differs from subscription",
};

export type AllocatedItem = {
  itemId: string;
  description: string | null;
  sku: string | null;
  chargeType: string | null;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
  currency: string | null;
  startPeriod: string | null;
  endPeriod: string | null;
  pax8CompanyId: string | null;
  pax8CompanyName: string | null;
  companyId: string | null;
  companyName: string | null;
  subscription: { id: string; subscriptionId: string; productName: string; quantity: number; price: number | null; billingTerm: string | null; status: string } | null;
  finding: AllocationFinding;
};

export type AllocationSummary = {
  items: number;
  total: number;
  allocated: number;
  unallocated: number;
  findings: Record<Exclude<AllocationFinding, "ok">, number>;
  /** Against the matched Xero bill: null when no bill, "summary" when the bill has no usable line detail. */
  billLines: { kind: "summary" } | { kind: "lines"; matched: number; total: number } | null;
};

function allocateItems(items: (typeof pax8InvoiceItems.$inferSelect)[], subs: (typeof pax8Subscriptions.$inferSelect)[], pax8Names: Map<string, string>, companyNames: Map<string, string>): AllocatedItem[] {
  const byKey = new Map<string, (typeof subs)[number][]>();
  for (const sub of subs) byKey.set(`${sub.pax8CompanyId}:${sub.productId}`, [...(byKey.get(`${sub.pax8CompanyId}:${sub.productId}`) ?? []), sub]);
  return items.map((it) => {
    const candidates = it.pax8CompanyId && it.productId ? (byKey.get(`${it.pax8CompanyId}:${it.productId}`) ?? []) : [];
    // Prefer an active subscription; otherwise any (a cancelled one still explains a final charge).
    const sub = candidates.find((c) => c.externalStatus === "active" && BILLED_STATUSES.includes(c.status)) ?? candidates[0] ?? null;
    const qty = pax8Number(it.quantity);
    const unit = pax8Number(it.unitPrice);
    let finding: AllocationFinding = "ok";
    if (!it.companyId) finding = "no_customer";
    else if (!sub) finding = "no_subscription";
    else if (unit !== null && pax8Number(sub.price) !== null && Math.abs(unit - pax8Number(sub.price)!) > 0.005) finding = "price_differs";
    else if (qty !== null && qty !== sub.quantity) finding = "quantity_differs";
    return {
      itemId: it.itemId,
      description: it.description,
      sku: it.sku,
      chargeType: it.chargeType,
      quantity: qty,
      unitPrice: unit,
      total: pax8Number(it.total),
      currency: it.currency,
      startPeriod: it.startPeriod,
      endPeriod: it.endPeriod,
      pax8CompanyId: it.pax8CompanyId,
      pax8CompanyName: it.pax8CompanyId ? (pax8Names.get(it.pax8CompanyId) ?? null) : null,
      companyId: it.companyId,
      companyName: it.companyId ? (companyNames.get(it.companyId) ?? null) : null,
      subscription: sub ? { id: sub.id, subscriptionId: sub.subscriptionId, productName: sub.productName, quantity: sub.quantity, price: pax8Number(sub.price), billingTerm: sub.billingTerm, status: sub.status } : null,
      finding,
    };
  });
}

function compareBillLines(items: AllocatedItem[], lineItems: Record<string, unknown>[] | null | undefined): AllocationSummary["billLines"] {
  if (!lineItems) return null;
  const amounts = lineItems.map((l) => pax8Number((l.LineAmount as number | string | null | undefined) ?? null)).filter((n): n is number => n !== null);
  if (amounts.length <= 1) return { kind: "summary" };
  const pool = items.map((i) => i.total).filter((n): n is number => n !== null);
  let matched = 0;
  for (const a of amounts) {
    const idx = pool.findIndex((t) => Math.abs(t - a) < 0.005);
    if (idx >= 0) {
      matched++;
      pool.splice(idx, 1);
    }
  }
  return { kind: "lines", matched, total: amounts.length };
}

function summariseAllocation(items: AllocatedItem[], billLines: AllocationSummary["billLines"]): AllocationSummary {
  const sum = (xs: AllocatedItem[]) => Math.round(xs.reduce((a, i) => a + (i.total ?? 0), 0) * 100) / 100;
  const un = items.filter((i) => i.finding === "no_customer" || i.finding === "no_subscription");
  return {
    items: items.length,
    total: sum(items),
    allocated: sum(items.filter((i) => !un.includes(i))),
    unallocated: sum(un),
    findings: {
      no_customer: items.filter((i) => i.finding === "no_customer").length,
      no_subscription: items.filter((i) => i.finding === "no_subscription").length,
      price_differs: items.filter((i) => i.finding === "price_differs").length,
      quantity_differs: items.filter((i) => i.finding === "quantity_differs").length,
    },
    billLines,
  };
}

async function allocationContext(invoiceIds: string[]) {
  const items = invoiceIds.length ? await db.select().from(pax8InvoiceItems).where(inArray(pax8InvoiceItems.invoiceId, invoiceIds)).orderBy(asc(pax8InvoiceItems.invoiceDate), asc(pax8InvoiceItems.description)) : [];
  const pax8CompanyIds = [...new Set(items.map((i) => i.pax8CompanyId).filter((x): x is string => Boolean(x)))];
  const [subs, pcs] = await Promise.all([
    pax8CompanyIds.length ? db.select().from(pax8Subscriptions).where(inArray(pax8Subscriptions.pax8CompanyId, pax8CompanyIds)) : Promise.resolve([] as (typeof pax8Subscriptions.$inferSelect)[]),
    pax8CompanyIds.length ? db.select({ pax8Id: pax8Companies.pax8Id, name: pax8Companies.name }).from(pax8Companies).where(inArray(pax8Companies.pax8Id, pax8CompanyIds)) : Promise.resolve([] as { pax8Id: string; name: string }[]),
  ]);
  const companyIds = [...new Set(items.map((i) => i.companyId).filter((x): x is string => Boolean(x)))];
  const cos = companyIds.length ? await db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds)) : [];
  return { items, subs, pax8Names: new Map(pcs.map((p) => [p.pax8Id, p.name])), companyNames: new Map(cos.map((c) => [c.id, c.name])) };
}

/** Full charge-level view of one Pax8 invoice: every line allocated, the matched bill and its lines. */
export async function pax8InvoiceAllocation(pax8InvoiceId: string) {
  const [inv] = await db.select().from(pax8Invoices).where(eq(pax8Invoices.pax8InvoiceId, pax8InvoiceId)).limit(1);
  if (!inv) return null;
  const ctx = await allocationContext([pax8InvoiceId]);
  const items = allocateItems(ctx.items, ctx.subs, ctx.pax8Names, ctx.companyNames);
  const bill = inv.xeroInvoiceId ? ((await db.select().from(xeroInvoices).where(eq(xeroInvoices.invoiceId, inv.xeroInvoiceId)).limit(1))[0] ?? null) : null;
  const billLines = compareBillLines(items, bill?.lineItems);
  const byCustomer = new Map<string, { companyId: string | null; name: string; items: AllocatedItem[]; total: number }>();
  for (const it of items) {
    const key = it.companyId ?? `pax8:${it.pax8CompanyId ?? "none"}`;
    const g = byCustomer.get(key) ?? { companyId: it.companyId, name: it.companyName ?? it.pax8CompanyName ?? "No customer", items: [], total: 0 };
    g.items.push(it);
    g.total = Math.round((g.total + (it.total ?? 0)) * 100) / 100;
    byCustomer.set(key, g);
  }
  return {
    invoice: { ...inv, total: pax8Number(inv.total), itemsTotal: pax8Number(inv.itemsTotal) },
    summary: summariseAllocation(items, billLines),
    customers: [...byCustomer.values()].sort((a, b) => (a.companyId ? 0 : 1) - (b.companyId ? 0 : 1) || a.name.localeCompare(b.name)),
    bill: bill ? { invoiceId: bill.invoiceId, invoiceNumber: bill.invoiceNumber, reference: bill.reference, status: bill.status, date: bill.date, subTotal: pax8Number(bill.subTotal), total: pax8Number(bill.total), lineItems: (bill.lineItems ?? []).map((l) => ({ description: String(l.Description ?? ""), quantity: pax8Number((l.Quantity as number | null | undefined) ?? null), unitAmount: pax8Number((l.UnitAmount as number | null | undefined) ?? null), lineAmount: pax8Number((l.LineAmount as number | null | undefined) ?? null) })) } : null,
  };
}

/** Allocation summaries for many invoices at once (the reconciliation table). */
export async function pax8AllocationSummaries(invoices: { pax8InvoiceId: string; xeroInvoiceId: string | null }[]) {
  const ctx = await allocationContext(invoices.map((i) => i.pax8InvoiceId));
  const billIds = invoices.map((i) => i.xeroInvoiceId).filter((x): x is string => Boolean(x));
  const bills = billIds.length ? await db.select({ invoiceId: xeroInvoices.invoiceId, lineItems: xeroInvoices.lineItems }).from(xeroInvoices).where(inArray(xeroInvoices.invoiceId, billIds)) : [];
  const billLinesById = new Map(bills.map((b) => [b.invoiceId, b.lineItems]));
  const out = new Map<string, AllocationSummary>();
  for (const inv of invoices) {
    const items = allocateItems(ctx.items.filter((i) => i.invoiceId === inv.pax8InvoiceId), ctx.subs, ctx.pax8Names, ctx.companyNames);
    out.set(inv.pax8InvoiceId, summariseAllocation(items, inv.xeroInvoiceId ? compareBillLines(items, billLinesById.get(inv.xeroInvoiceId)) : null));
  }
  return out;
}

export async function pax8Totals(companyId?: string) {
  const billed = sql`status in (${sql.join(
    BILLED_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  )})`;
  const [subs] = await db
    .select({
      subscriptions:
        sql<number>`count(*) filter (where external_status = 'active' and ${billed})`.mapWith(
          Number,
        ),
      licences:
        sql<number>`coalesce(sum(quantity) filter (where external_status = 'active' and ${billed}), 0)`.mapWith(
          Number,
        ),
      monthlyCost:
        sql<number>`coalesce(sum(case when external_status = 'active' and ${billed} and price is not null then quantity * price / case lower(coalesce(billing_term, '')) when 'monthly' then 1 when 'annual' then 12 when '2-year' then 24 when '3-year' then 36 else null end else 0 end), 0)`.mapWith(
          Number,
        ),
      unlinkedSubscriptions:
        sql<number>`count(*) filter (where external_status = 'active' and ${billed} and company_id is null)`.mapWith(
          Number,
        ),
      lastFetched: sql<Date | null>`max(fetched_at)`,
    })
    .from(pax8Subscriptions)
    .where(companyId ? eq(pax8Subscriptions.companyId, companyId) : undefined);
  const [cos] = await db
    .select({
      companies:
        sql<number>`count(*) filter (where external_status = 'active')`.mapWith(
          Number,
        ),
      linked:
        sql<number>`count(*) filter (where external_status = 'active' and company_id is not null)`.mapWith(
          Number,
        ),
    })
    .from(pax8Companies)
    .where(companyId ? eq(pax8Companies.companyId, companyId) : undefined);
  const [disc] = await db
    .select({
      open: sql<number>`count(*) filter (where status = 'open')`.mapWith(
        Number,
      ),
    })
    .from(billingDiscrepancies)
    .where(
      and(
        eq(billingDiscrepancies.source, "pax8"),
        companyId ? eq(billingDiscrepancies.companyId, companyId) : undefined,
      ),
    );
  return {
    ...subs,
    ...cos,
    openDiscrepancies: disc.open,
    freshness: pax8Freshness(
      subs.lastFetched ? new Date(subs.lastFetched) : null,
    ),
  };
}

/** Every mirrored Pax8 company with its CRM link, suggestions for unlinked ones, and subscription counts. */
export async function pax8MappingOverview() {
  const [rows, index, subs] = await Promise.all([
    db.select().from(pax8Companies).orderBy(asc(pax8Companies.name)),
    companyIndex(),
    db
      .select({
        pax8CompanyId: pax8Subscriptions.pax8CompanyId,
        subscriptions: sql<number>`count(*)`.mapWith(Number),
        licences: sql<number>`coalesce(sum(quantity), 0)`.mapWith(Number),
      })
      .from(pax8Subscriptions)
      .where(
        and(
          eq(pax8Subscriptions.externalStatus, "active"),
          inArray(pax8Subscriptions.status, BILLED_STATUSES),
        ),
      )
      .groupBy(pax8Subscriptions.pax8CompanyId),
  ]);
  const nameOf = new Map(index.rows.map((r) => [r.id, r.name]));
  const counts = new Map(subs.map((s) => [s.pax8CompanyId, s]));
  const items = rows.map((pc) => ({
    ...pc,
    companyName: pc.companyId ? (nameOf.get(pc.companyId) ?? null) : null,
    suggestions: pc.companyId
      ? []
      : suggestionsFor(pc, index).filter((s) => !index.linked.has(s.id)),
    subscriptions: counts.get(pc.pax8Id)?.subscriptions ?? 0,
    licences: counts.get(pc.pax8Id)?.licences ?? 0,
    freshness: pax8Freshness(pc.fetchedAt),
  }));
  return {
    items,
    companies: index.rows
      .filter((r) => !index.linked.has(r.id))
      .map((c) => ({ id: c.id, name: c.name })),
    linkedCount: items.filter((i) => i.companyId).length,
  };
}

/**
 * Subscriptions for one company with the line that bills each (and how it
 * was matched), unit cost vs the line's cost and price, open licence
 * discrepancies, and what Pax8 charged for this customer on recent invoices.
 */
export async function companySubscriptionOverview(companyId: string) {
  const [pc] = await db
    .select()
    .from(pax8Companies)
    .where(eq(pax8Companies.companyId, companyId))
    .limit(1);
  if (!pc) return null;
  const [resolved, subs, lines, discrepancies, charges] = await Promise.all([
    getPax8Client(),
    db
      .select()
      .from(pax8Subscriptions)
      .where(eq(pax8Subscriptions.companyId, companyId))
      .orderBy(
        asc(pax8Subscriptions.status),
        asc(pax8Subscriptions.productName),
      ),
    matchableLines(companyId),
    listDiscrepancies({ companyId, source: "pax8" }),
    db
      .select({
        invoiceId: pax8InvoiceItems.invoiceId,
        invoiceDate: pax8InvoiceItems.invoiceDate,
        invoiceStatus: pax8InvoiceItems.invoiceStatus,
        currency: pax8InvoiceItems.currency,
        total: sql<number>`coalesce(sum(total), 0)`.mapWith(Number),
        items: sql<number>`count(*)`.mapWith(Number),
      })
      .from(pax8InvoiceItems)
      .where(eq(pax8InvoiceItems.companyId, companyId))
      .groupBy(
        pax8InvoiceItems.invoiceId,
        pax8InvoiceItems.invoiceDate,
        pax8InvoiceItems.invoiceStatus,
        pax8InvoiceItems.currency,
      )
      .orderBy(desc(pax8InvoiceItems.invoiceDate))
      .limit(6),
  ]);
  const coverage = await coverageFor("pax8_subscription", { companyId });
  const subscriptions = subs.map((s) => {
    const cov = coverage.get(s.id) ?? null;
    const match = cov?.state === "bundle" && cov.contractLineId ? ((l) => (l ? { line: l, by: "manual" as const } : null))(lines.find((l) => l.id === cov.contractLineId)) : matchLine(s, lines);
    const monthly = monthlyUnitCost(s.price, s.billingTerm);
    const lineMonths = match ? LINE_MONTHS[match.line.billingFrequency] : null;
    const lineMonthlyCost =
      match && match.line.unitCost !== null && lineMonths
        ? Number(match.line.unitCost) / lineMonths
        : null;
    const lineMonthlyPrice =
      match && lineMonths ? Number(match.line.unitPrice) / lineMonths : null;
    return {
      ...s,
      billed:
        s.externalStatus === "active" && BILLED_STATUSES.includes(s.status),
      line: match?.line ?? null,
      matchedBy: match?.by ?? null,
      /** Explicit commercial state from the service register, if any (bundle, commitment, free, internal, investigate). */
      coverage: cov ? { state: cov.state, reason: cov.reason, reviewOn: cov.reviewOn } : null,
      monthlyUnitCost: monthly,
      lineMonthlyCost,
      lineMonthlyPrice,
      /** Positive when the CRM's recorded cost is stale versus Pax8 (differs by more than a penny per month). */
      costDiffers:
        monthly !== null && lineMonthlyCost !== null
          ? Math.abs(monthly - lineMonthlyCost) > 0.01
          : monthly !== null && match !== null && lineMonthlyCost === null,
      marginPerUnitMonthly:
        monthly !== null && lineMonthlyPrice !== null
          ? lineMonthlyPrice - monthly
          : null,
      freshness: pax8Freshness(s.fetchedAt),
      consoleUrl:
        resolved?.client.consoleUrl("subscription", s.subscriptionId) ?? null,
    };
  });
  const active = subscriptions.filter((s) => s.billed);
  return {
    pax8Company: {
      ...pc,
      consoleUrl: resolved?.client.consoleUrl("company", pc.pax8Id) ?? null,
    },
    subscriptions,
    lines,
    discrepancies,
    charges,
    totals: {
      subscriptions: active.length,
      licences: active.reduce((a, s) => a + s.quantity, 0),
      monthlyCost: active.reduce(
        (a, s) => a + (s.monthlyUnitCost ?? 0) * s.quantity,
        0,
      ),
      unbilled: active.filter((s) => !s.line && !s.coverage).length,
      costStale: active.filter((s) => s.costDiffers).length,
      lastFetched: subs.reduce<Date | null>(
        (a, s) => (!a || s.fetchedAt > a ? s.fetchedAt : a),
        null,
      ),
    },
    mode: resolved?.mode ?? null,
    quantityChanges: resolved?.config.allowQuantityChanges ?? false,
  };
}
