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
  pax8Products,
  pax8Subscriptions,
  products,
} from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
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
  type Pax8InvoiceItemRaw,
} from "@/connectors/pax8/types";
import { registrableDomain } from "@/connectors/twentyi/types";
import {
  getConnection,
  runSync,
  setConnectionConfig,
  setCredentials,
  updateConnection,
} from "./integrations";
import { listDiscrepancies } from "./ninjaone";

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
          let items: Pax8InvoiceItemRaw[] = [];
          try {
            items = await client.listInvoiceItems(inv.id);
          } catch (err) {
            await fail(
              `Invoice ${inv.id} items: ${err instanceof Error ? err.message : String(err)}`,
              { externalId: inv.id },
            );
            continue;
          }
          invoiceCount++;
          for (const it of items) {
            counters.fetched++;
            itemCount++;
            const v = {
              itemId: it.id,
              invoiceId: inv.id,
              invoiceDate: pax8Date(inv.invoiceDate),
              invoiceStatus: inv.status ?? null,
              pax8CompanyId: it.companyId ?? null,
              companyId: it.companyId
                ? (linkByPax8.get(it.companyId) ?? null)
                : null,
              productId: it.productId ?? null,
              sku: it.sku ?? null,
              description: it.description ?? null,
              quantity:
                pax8Number(it.quantity) === null
                  ? null
                  : String(pax8Number(it.quantity)),
              unitPrice:
                pax8Number(it.unitPrice) === null
                  ? null
                  : String(pax8Number(it.unitPrice)),
              total:
                pax8Number(it.total) === null
                  ? null
                  : String(pax8Number(it.total)),
              currency: it.currency ?? inv.currency ?? null,
              startPeriod: pax8Date(it.startPeriod),
              endPeriod: pax8Date(it.endPeriod),
              chargeType: it.chargeType ?? it.type ?? null,
              raw: it as Record<string, unknown>,
            };
            await db
              .insert(pax8InvoiceItems)
              .values({ ...v, fetchedAt: now })
              .onConflictDoUpdate({
                target: pax8InvoiceItems.itemId,
                set: { ...v, fetchedAt: now, updatedAt: now },
              });
          }
        }
      } catch (err) {
        await fail(
          `Invoices unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const auto = config.autoLink
        ? await autoLinkPax8Companies(actorUserId ?? null)
        : { linked: 0 };
      const check = await runLicenceCheck(actorUserId ?? null);
      return `${seenCompanies.size} companies, ${seenSubs.size} subscriptions, ${itemCount} charge lines on ${invoiceCount} invoices${resolved.mode === "demo" ? " (DEMO data)" : ""}; ${auto.linked} auto-linked; ${check.open} open licence discrepancies`;
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
    const observedByLine = new Map<
      string,
      { line: MatchableLine; observed: number; subscriptionIds: string[] }
    >();
    for (const s of list) {
      const m = matchLine(s, lines);
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
  const subscriptions = subs.map((s) => {
    const match = matchLine(s, lines);
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
      unbilled: active.filter((s) => !s.line).length,
      costStale: active.filter((s) => s.costDiffers).length,
      lastFetched: subs.reduce<Date | null>(
        (a, s) => (!a || s.fetchedAt > a ? s.fetchedAt : a),
        null,
      ),
    },
    mode: resolved?.mode ?? null,
  };
}
