import { and, asc, desc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, contacts, contractLines, contracts, hostingItems, xeroInvoices } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { DEFAULT_TWENTYI_CONFIG, getTwentyIClient, type TwentyIConfig, type TwentyICredentials } from "@/connectors/twentyi";
import { LiveTwentyIClient } from "@/connectors/twentyi/live";
import { registrableDomain, twentyIDate, twentyITime, type TwentyIDomainRaw, type TwentyIMailboxRaw } from "@/connectors/twentyi/types";
import { getConnection, runSync, setConnectionConfig, setCredentials, updateConnection } from "./integrations";
import { createTask } from "./tasks";

export type HostingItem = typeof hostingItems.$inferSelect;
export type HostingKind = HostingItem["kind"];
export const HOSTING_KIND_LABELS: Record<HostingKind, string> = { package: "Hosting package", domain: "Domain", mailbox: "Mailbox", ssl: "SSL certificate" };

// ---------------------------------------------------------------------------
// Connection (API key entered in the UI, verified before storage)
// ---------------------------------------------------------------------------
/**
 * 20i documents the bearer token as the base64 of the general API key. Some
 * keys are handed out already encoded, so a failed base64 attempt is retried
 * with the raw key and whichever worked is remembered alongside the key.
 */
export async function connectTwentyI(input: { apiKey: string }, actorUserId: string) {
  let tokenMode: "base64" | "raw" = "base64";
  let test = await new LiveTwentyIClient({ apiKey: input.apiKey, tokenMode }).testConnection();
  if (!test.ok && /401|403/.test(test.error)) {
    tokenMode = "raw";
    const retry = await new LiveTwentyIClient({ apiKey: input.apiKey, tokenMode }).testConnection();
    if (retry.ok) test = retry;
  }
  if (!test.ok) throw new ActionError(`Could not verify the API key: ${test.error}`);
  await setCredentials("twentyi", { apiKey: input.apiKey, tokenMode } satisfies TwentyICredentials, actorUserId, { status: "connected", externalAccountName: `Reseller ${test.resellerId} (${test.packageCount} packages)`, externalAccountId: test.resellerId, lastTestedAt: new Date(), lastError: null, consecutiveFailures: 0, pausedUntil: null });
  return test;
}

export async function testTwentyI(actorUserId: string) {
  const resolved = await getTwentyIClient();
  if (!resolved) throw new ActionError("20i is not configured.");
  const t = await resolved.client.testConnection();
  if (resolved.mode === "live") await updateConnection("twentyi", { lastTestedAt: new Date(), lastError: t.ok ? null : t.error, status: t.ok ? "connected" : /401|403/.test(t.ok ? "" : t.error) ? "expired" : "error" });
  await audit({ actorUserId, action: "integration.test", entityType: "integration", entityId: "twentyi", details: { ok: t.ok } });
  return t;
}

export async function twentyIConnectionSummary() {
  const conn = await getConnection("twentyi");
  const resolved = await getTwentyIClient();
  return { ...conn, credentialsEnc: undefined, config: (conn.config ?? {}) as TwentyIConfig, effectiveConfig: resolved?.config ?? DEFAULT_TWENTYI_CONFIG, mode: resolved?.mode ?? null, configured: Boolean(resolved), demo: resolved?.mode === "demo", keyPresent: conn.mode === "live" && Boolean(conn.credentialsEnc) };
}

export async function saveTwentyIConfig(input: TwentyIConfig, actorUserId: string) {
  await setConnectionConfig("twentyi", input, actorUserId);
}

// ---------------------------------------------------------------------------
// Sync (read-only): packages, domains, mailboxes; then auto-match to companies
// ---------------------------------------------------------------------------
export async function syncTwentyI(trigger: "schedule" | "manual", actorUserId?: string | null) {
  const resolved = await getTwentyIClient();
  if (!resolved) return null;
  const { client, config } = resolved;
  return runSync(
    "twentyi",
    "twentyi.sync",
    trigger,
    async ({ counters, fail }) => {
      const now = new Date();
      const seen: Record<HostingKind, Set<string>> = { package: new Set(), domain: new Set(), mailbox: new Set(), ssl: new Set() };

      // Packages
      const packages = await client.listPackages();
      const packageByName = new Map<string, string>();
      for (const p of packages) {
        counters.fetched++;
        const pid = String(p.id);
        seen.package.add(pid);
        for (const n of [p.name, ...(p.names ?? [])]) if (n) packageByName.set(n.toLowerCase(), pid);
        try {
          let usage: { diskUsedBytes: number | null; diskLimitBytes: number | null } | null = null;
          try {
            usage = await client.packageUsage(p.id);
          } catch (err) {
            await fail(`Usage for package ${p.name}: ${err instanceof Error ? err.message : String(err)}`, { externalId: pid });
          }
          const r = await upsertItem(
            {
              kind: "package",
              externalId: pid,
              name: p.name,
              matchDomain: registrableDomain(p.name),
              parentExternalId: null,
              typeName: p.packageTypeName ?? null,
              enabled: typeof p.enabled === "boolean" ? p.enabled : null,
              expiresOn: null,
              createdExternal: twentyITime(p.created),
              details: { names: p.names ?? [p.name], stackUsers: p.stackUsers ?? [], labels: p.packageLabels ?? [], typeRef: p.typeRef ?? null },
              diskUsedBytes: usage?.diskUsedBytes === null || usage?.diskUsedBytes === undefined ? null : Math.round(usage.diskUsedBytes),
              diskLimitBytes: usage?.diskLimitBytes === null || usage?.diskLimitBytes === undefined ? null : Math.round(usage.diskLimitBytes),
              raw: p as Record<string, unknown>,
            },
            now,
          );
          if (r === "created") counters.created++;
          else if (r === "updated") counters.updated++;
          else counters.skipped++;
        } catch (err) {
          await fail(`Package ${p.name}: ${err instanceof Error ? err.message : String(err)}`, { externalId: pid });
        }
      }

      // Domains (registrations)
      let domains: TwentyIDomainRaw[] = [];
      try {
        domains = await client.listDomains();
      } catch (err) {
        await fail(`Domains unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const d of domains) {
        counters.fetched++;
        const did = String(d.id);
        seen.domain.add(did);
        try {
          const r = await upsertItem(
            {
              kind: "domain",
              externalId: did,
              name: d.name,
              matchDomain: registrableDomain(d.name),
              parentExternalId: packageByName.get(d.name.toLowerCase()) ?? null,
              typeName: d.name.split(".").slice(1).join(".") || null,
              enabled: null,
              expiresOn: twentyIDate(d.expiryDate),
              createdExternal: null,
              details: { deadDate: twentyIDate(d.deadDate), closeToAnniversary: d.closeToAnniversary ?? null, hasPrivacy: d.hasPrivacy ?? null, registrantIsVerified: d.registrantIsVerified ?? null },
              diskUsedBytes: null,
              diskLimitBytes: null,
              raw: d as Record<string, unknown>,
            },
            now,
          );
          if (r === "created") counters.created++;
          else if (r === "updated") counters.updated++;
          else counters.skipped++;
        } catch (err) {
          await fail(`Domain ${d.name}: ${err instanceof Error ? err.message : String(err)}`, { externalId: did });
        }
      }

      // Mailboxes: one call per package name (www.* skipped). Best effort per package.
      if (config.syncMailboxes) {
        for (const p of packages) {
          if (p.enabled === false) continue;
          const names = [...new Set([p.name, ...(p.names ?? [])].filter((n) => n && !n.startsWith("www.")))];
          for (const domain of names) {
            let boxes: TwentyIMailboxRaw[] = [];
            try {
              boxes = await client.listMailboxes(p.id, domain);
            } catch (err) {
              await fail(`Mailboxes for ${domain}: ${err instanceof Error ? err.message : String(err)}`, { externalId: String(p.id) });
              continue;
            }
            for (const m of boxes) {
              counters.fetched++;
              const address = `${m.local}@${m.domain || domain}`.toLowerCase();
              const mid = `${p.id}:${address}`;
              seen.mailbox.add(mid);
              try {
                const r = await upsertItem(
                  { kind: "mailbox", externalId: mid, name: address, matchDomain: registrableDomain(m.domain || domain), parentExternalId: String(p.id), typeName: "mailbox", enabled: null, expiresOn: null, createdExternal: null, details: { forUser: m.forUser ?? null, mailboxId: m.id ?? null }, diskUsedBytes: null, diskLimitBytes: null, raw: m as Record<string, unknown> },
                  now,
                );
                if (r === "created") counters.created++;
                else if (r === "updated") counters.updated++;
                else counters.skipped++;
              } catch (err) {
                await fail(`Mailbox ${address}: ${err instanceof Error ? err.message : String(err)}`, { externalId: mid });
              }
            }
          }
        }
      }

      // Anything not seen this run is marked deleted (kept, with its links).
      for (const kind of ["package", "domain", "mailbox"] as const) {
        if (kind === "domain" && domains.length === 0) continue; // the endpoint failed: don't mark everything deleted
        if (kind === "mailbox" && !config.syncMailboxes) continue;
        const ids = [...seen[kind]];
        await db
          .update(hostingItems)
          .set({ externalStatus: "deleted", updatedAt: now })
          .where(and(eq(hostingItems.kind, kind), eq(hostingItems.externalStatus, "active"), ids.length ? notInArray(hostingItems.externalId, ids) : sql`true`));
      }

      const auto = config.autoLink ? await autoLinkHostingItems(actorUserId ?? null) : { linked: 0, inherited: 0 };
      return `${seen.package.size} packages, ${seen.domain.size} domains, ${seen.mailbox.size} mailboxes${resolved.mode === "demo" ? " (DEMO data)" : ""}; ${auto.linked} auto-linked`;
    },
    actorUserId,
  );
}

type UpsertInput = Omit<typeof hostingItems.$inferInsert, "id" | "companyId" | "matchSource" | "contractLineId" | "externalStatus" | "fetchedAt" | "createdAt" | "updatedAt">;

async function upsertItem(v: UpsertInput, now: Date): Promise<"created" | "updated" | "unchanged"> {
  const [existing] = await db.select().from(hostingItems).where(and(eq(hostingItems.kind, v.kind), eq(hostingItems.externalId, v.externalId))).limit(1);
  if (!existing) {
    await db.insert(hostingItems).values({ ...v, externalStatus: "active", fetchedAt: now });
    return "created";
  }
  const changed =
    existing.name !== v.name ||
    existing.typeName !== (v.typeName ?? null) ||
    existing.enabled !== (v.enabled ?? null) ||
    existing.expiresOn !== (v.expiresOn ?? null) ||
    existing.parentExternalId !== (v.parentExternalId ?? null) ||
    existing.diskUsedBytes !== (v.diskUsedBytes ?? null) ||
    existing.externalStatus !== "active" ||
    JSON.stringify(existing.details ?? null) !== JSON.stringify(v.details ?? null);
  await db
    .update(hostingItems)
    .set(changed ? { ...v, externalStatus: "active", fetchedAt: now, updatedAt: now } : { fetchedAt: now })
    .where(eq(hostingItems.id, existing.id));
  return changed ? "updated" : "unchanged";
}

// ---------------------------------------------------------------------------
// Matching: registrable domain of a package/domain ↔ company domain or a
// contact's email domain. Exact matches only; never overrides a manual choice.
// ---------------------------------------------------------------------------
async function companyDomainIndex() {
  const rows = await db.select({ id: companies.id, domain: companies.domain }).from(companies).where(and(isNull(companies.archivedAt), sql`${companies.domain} is not null`));
  const byDomain = new Map<string, Set<string>>();
  const add = (domain: string | null, id: string) => {
    const d = registrableDomain(domain);
    if (!d) return;
    if (!byDomain.has(d)) byDomain.set(d, new Set());
    byDomain.get(d)!.add(id);
  };
  for (const r of rows) add(r.domain, r.id);
  const contactRows = await db.select({ companyId: contacts.companyId, email: contacts.normalizedEmail }).from(contacts).where(and(isNull(contacts.archivedAt), sql`${contacts.normalizedEmail} is not null`));
  for (const c of contactRows) if (c.companyId && c.email?.includes("@")) add(c.email.split("@")[1], c.companyId);
  return byDomain;
}

/** Links unlinked packages/domains whose registrable domain matches exactly one company; mailboxes inherit their package's company. */
export async function autoLinkHostingItems(actorUserId: string | null) {
  const index = await companyDomainIndex();
  const candidates = await db.select().from(hostingItems).where(and(inArray(hostingItems.kind, ["package", "domain"]), isNull(hostingItems.companyId), isNull(hostingItems.matchSource), eq(hostingItems.externalStatus, "active")));
  let linked = 0;
  for (const item of candidates) {
    const ids = item.matchDomain ? index.get(item.matchDomain) : undefined;
    if (!ids || ids.size !== 1) continue;
    const companyId = [...ids][0];
    await db.update(hostingItems).set({ companyId, matchSource: "auto", updatedAt: new Date() }).where(eq(hostingItems.id, item.id));
    await logActivity({ type: "sync", companyId, entityType: "hosting_item", entityId: item.id, title: `20i ${HOSTING_KIND_LABELS[item.kind].toLowerCase()} "${item.name}" linked automatically (domain match)`, actorUserId, source: "twentyi" });
    linked++;
  }
  const inherited = await inheritPackageLinks();
  return { linked, inherited };
}

/** Mailboxes (and certificates) follow the company of the package they belong to unless someone set them by hand. */
async function inheritPackageLinks() {
  const res = await db.execute(sql`
    update hosting_items c
       set company_id = p.company_id, match_source = 'inherited', updated_at = now()
      from hosting_items p
     where p.kind = 'package' and c.kind in ('mailbox','ssl') and c.parent_external_id = p.external_id
       and (c.match_source is null or c.match_source = 'inherited')
       and c.company_id is distinct from p.company_id`);
  return Number((res as unknown as { rowCount?: number }).rowCount ?? 0);
}

export async function linkHostingItem(itemId: string, companyId: string, actorUserId: string) {
  const [item] = await db.select().from(hostingItems).where(eq(hostingItems.id, itemId)).limit(1);
  if (!item) throw new ActionError("Hosting item not found. Run a sync first.");
  const [co] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!co) throw new ActionError("Company not found.");
  await db.update(hostingItems).set({ companyId, matchSource: "manual", contractLineId: item.companyId === companyId ? item.contractLineId : null, updatedAt: new Date() }).where(eq(hostingItems.id, itemId));
  if (item.kind === "package") {
    await db.update(hostingItems).set({ companyId, matchSource: "inherited", updatedAt: new Date() }).where(and(eq(hostingItems.parentExternalId, item.externalId), inArray(hostingItems.kind, ["mailbox", "ssl"]), or(isNull(hostingItems.matchSource), eq(hostingItems.matchSource, "inherited"))!));
  }
  await audit({ actorUserId, action: "hosting.link", entityType: "company", entityId: companyId, details: { itemId, kind: item.kind, name: item.name } });
  await logActivity({ type: "sync", companyId, entityType: "hosting_item", entityId: itemId, title: `Linked 20i ${HOSTING_KIND_LABELS[item.kind].toLowerCase()} "${item.name}"`, actorUserId, source: "twentyi" });
}

export async function unlinkHostingItem(itemId: string, actorUserId: string) {
  const [item] = await db.select().from(hostingItems).where(eq(hostingItems.id, itemId)).limit(1);
  if (!item) throw new ActionError("Hosting item not found.");
  // matchSource stays "manual" with no company so the next sync does not re-link it automatically.
  await db.update(hostingItems).set({ companyId: null, matchSource: "manual", contractLineId: null, updatedAt: new Date() }).where(eq(hostingItems.id, itemId));
  if (item.kind === "package") {
    await db.update(hostingItems).set({ companyId: null, contractLineId: null, updatedAt: new Date() }).where(and(eq(hostingItems.parentExternalId, item.externalId), inArray(hostingItems.kind, ["mailbox", "ssl"]), or(isNull(hostingItems.matchSource), eq(hostingItems.matchSource, "inherited"))!));
  }
  await audit({ actorUserId, action: "hosting.unlink", entityType: "company", entityId: item.companyId ?? "none", details: { itemId, kind: item.kind, name: item.name } });
  if (item.companyId) await logActivity({ type: "sync", companyId: item.companyId, entityType: "hosting_item", entityId: itemId, title: `Unlinked 20i ${HOSTING_KIND_LABELS[item.kind].toLowerCase()} "${item.name}"`, actorUserId, source: "twentyi" });
}

/** Ties an item to the contract line that bills it. The line must belong to a contract of the item's company. */
export async function setHostingBillingLine(itemId: string, contractLineId: string | null, actorUserId: string) {
  const [item] = await db.select().from(hostingItems).where(eq(hostingItems.id, itemId)).limit(1);
  if (!item) throw new ActionError("Hosting item not found.");
  if (!item.companyId) throw new ActionError("Link the item to a company before choosing what bills it.");
  if (contractLineId) {
    const [line] = await db.select({ id: contractLines.id, companyId: contracts.companyId, description: contractLines.description }).from(contractLines).innerJoin(contracts, eq(contracts.id, contractLines.contractId)).where(eq(contractLines.id, contractLineId)).limit(1);
    if (!line || line.companyId !== item.companyId) throw new ActionError("That contract line belongs to a different company.");
  }
  await db.update(hostingItems).set({ contractLineId, updatedAt: new Date() }).where(eq(hostingItems.id, itemId));
  await audit({ actorUserId, action: "hosting.billing_line", entityType: "company", entityId: item.companyId, details: { itemId, name: item.name, contractLineId } });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export type HostingFreshness = "live" | "cached" | "stale" | "unavailable";
export function hostingFreshness(fetchedAt: Date | null | undefined, pollMinutes = 60): HostingFreshness {
  if (!fetchedAt) return "unavailable";
  const age = Date.now() - fetchedAt.getTime();
  if (age < 5 * 60_000) return "live";
  if (age < 3 * pollMinutes * 60_000) return "cached";
  return "stale";
}

export async function hostingTotals(companyId?: string) {
  const scope = companyId ? and(eq(hostingItems.externalStatus, "active"), eq(hostingItems.companyId, companyId)) : eq(hostingItems.externalStatus, "active");
  const [row] = await db
    .select({
      packages: sql<number>`count(*) filter (where kind = 'package')`.mapWith(Number),
      domains: sql<number>`count(*) filter (where kind = 'domain')`.mapWith(Number),
      mailboxes: sql<number>`count(*) filter (where kind = 'mailbox')`.mapWith(Number),
      expiring30: sql<number>`count(*) filter (where expires_on is not null and expires_on <= current_date + 30)`.mapWith(Number),
      expired: sql<number>`count(*) filter (where expires_on is not null and expires_on < current_date)`.mapWith(Number),
      unlinked: sql<number>`count(*) filter (where company_id is null and kind in ('package','domain'))`.mapWith(Number),
      unbilled: sql<number>`count(*) filter (where company_id is not null and contract_line_id is null and kind in ('package','domain'))`.mapWith(Number),
      lastFetched: sql<Date | null>`max(fetched_at)`,
    })
    .from(hostingItems)
    .where(scope);
  return { ...row, freshness: hostingFreshness(row.lastFetched ? new Date(row.lastFetched) : null) };
}

export type HostingSuggestion = { id: string; name: string; reason: "domain" | "name" };

/** Everything mirrored, top-level items first, with company suggestions for unlinked ones. */
export async function hostingMappingOverview() {
  const [items, companyRows, index] = await Promise.all([
    db.select().from(hostingItems).orderBy(asc(hostingItems.kind), asc(hostingItems.name)),
    db.select({ id: companies.id, name: companies.name, normalizedName: companies.normalizedName, domain: companies.domain }).from(companies).where(isNull(companies.archivedAt)).orderBy(asc(companies.name)),
    companyDomainIndex(),
  ]);
  const companyName = new Map(companyRows.map((c) => [c.id, c.name]));
  const childrenByParent = new Map<string, HostingItem[]>();
  for (const i of items) if (i.parentExternalId && (i.kind === "mailbox" || i.kind === "ssl")) childrenByParent.set(i.parentExternalId, [...(childrenByParent.get(i.parentExternalId) ?? []), i]);
  const top = items
    .filter((i) => i.kind === "package" || i.kind === "domain")
    .map((i) => {
      const suggestions: HostingSuggestion[] = [];
      if (!i.companyId) {
        const byDomain = i.matchDomain ? index.get(i.matchDomain) : undefined;
        for (const id of byDomain ?? []) suggestions.push({ id, name: companyName.get(id) ?? id, reason: "domain" });
        const stem = (i.matchDomain ?? i.name).split(".")[0].replace(/[^a-z0-9]/g, "");
        if (stem.length >= 5) for (const c of companyRows) if (!suggestions.some((s) => s.id === c.id) && c.normalizedName.replace(/[^a-z0-9]/g, "").includes(stem)) suggestions.push({ id: c.id, name: c.name, reason: "name" });
      }
      return { ...i, companyName: i.companyId ? (companyName.get(i.companyId) ?? null) : null, suggestions: suggestions.slice(0, 3), children: childrenByParent.get(i.externalId) ?? [], freshness: hostingFreshness(i.fetchedAt) };
    });
  return { items: top, companies: companyRows.map((c) => ({ id: c.id, name: c.name })), linkedCount: top.filter((i) => i.companyId).length };
}

export type HostingInvoiceMatch = { invoiceId: string; invoiceNumber: string | null; status: string; date: string | null; dueDate: string | null; total: string | null; amountDue: string | null; currencyCode: string | null; onlineInvoiceUrl: string | null; mentions: string[] };

/**
 * Hosting for one company: packages with their mailboxes and domains, loose
 * domains, what bills each item, and the mirrored Xero invoices whose line
 * descriptions mention any of the company's hosting names.
 */
export async function companyHostingOverview(companyId: string) {
  const items = await db.select().from(hostingItems).where(eq(hostingItems.companyId, companyId)).orderBy(asc(hostingItems.kind), asc(hostingItems.name));
  if (items.length === 0) return null;
  const resolved = await getTwentyIClient();
  const lineRows = await db
    .select({ id: contractLines.id, description: contractLines.description, contractId: contracts.id, contractName: contracts.name, contractStatus: contracts.status, quantity: contractLines.quantity, unitPrice: contractLines.unitPrice, billingFrequency: contractLines.billingFrequency })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(eq(contracts.companyId, companyId), isNull(contracts.archivedAt), inArray(contracts.status, ["draft", "active"])))
    .orderBy(asc(contracts.name), asc(contractLines.sortOrder));
  const lineById = new Map(lineRows.map((l) => [l.id, l]));
  const decorate = (i: HostingItem) => ({ ...i, billingLine: i.contractLineId ? (lineById.get(i.contractLineId) ?? null) : null, freshness: hostingFreshness(i.fetchedAt), consoleUrl: i.kind === "package" || i.kind === "domain" ? (resolved?.client.consoleUrl(i.kind, i.externalId) ?? null) : null });
  const packages = items.filter((i) => i.kind === "package").map((p) => ({ ...decorate(p), mailboxes: items.filter((m) => m.kind === "mailbox" && m.parentExternalId === p.externalId).map(decorate), domains: items.filter((d) => d.kind === "domain" && d.parentExternalId === p.externalId).map(decorate) }));
  const attachedDomainIds = new Set(packages.flatMap((p) => p.domains.map((d) => d.id)));
  const looseDomains = items.filter((i) => i.kind === "domain" && !attachedDomainIds.has(i.id)).map(decorate);
  const orphanMailboxes = items.filter((i) => i.kind === "mailbox" && !packages.some((p) => p.externalId === i.parentExternalId)).map(decorate);
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const expiring = items.filter((i) => i.externalStatus === "active" && i.expiresOn && i.expiresOn <= soon).map((i) => ({ ...i, expired: i.expiresOn! < today }));

  // Invoices that mention a hosting name in a line description.
  const names = [...new Set(items.filter((i) => i.kind !== "mailbox").map((i) => i.name.toLowerCase()))];
  const invoiceRows = names.length
    ? await db
        .select({ invoiceId: xeroInvoices.invoiceId, invoiceNumber: xeroInvoices.invoiceNumber, status: xeroInvoices.status, date: xeroInvoices.date, dueDate: xeroInvoices.dueDate, total: xeroInvoices.total, amountDue: xeroInvoices.amountDue, currencyCode: xeroInvoices.currencyCode, onlineInvoiceUrl: xeroInvoices.onlineInvoiceUrl, lineItems: xeroInvoices.lineItems, reference: xeroInvoices.reference })
        .from(xeroInvoices)
        .where(and(eq(xeroInvoices.companyId, companyId), eq(xeroInvoices.type, "ACCREC")))
        .orderBy(desc(xeroInvoices.date))
        .limit(200)
    : [];
  const invoices: HostingInvoiceMatch[] = [];
  for (const inv of invoiceRows) {
    const text = `${inv.reference ?? ""} ${JSON.stringify(inv.lineItems ?? [])}`.toLowerCase();
    const mentions = names.filter((n) => text.includes(n));
    if (mentions.length) invoices.push({ invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, status: inv.status, date: inv.date, dueDate: inv.dueDate, total: inv.total, amountDue: inv.amountDue, currencyCode: inv.currencyCode, onlineInvoiceUrl: inv.onlineInvoiceUrl, mentions });
  }
  return { packages, looseDomains, orphanMailboxes, expiring, lines: lineRows, invoices: invoices.slice(0, 25), totals: await hostingTotals(companyId), mode: resolved?.mode ?? null };
}

// ---------------------------------------------------------------------------
// Reminders: a task per domain / certificate expiring within the window
// ---------------------------------------------------------------------------
export async function generateHostingReminders() {
  const resolved = await getTwentyIClient();
  const days = resolved?.config.expiryReminderDays ?? DEFAULT_TWENTYI_CONFIG.expiryReminderDays;
  const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const rows = await db
    .select({ id: hostingItems.id, kind: hostingItems.kind, name: hostingItems.name, expiresOn: hostingItems.expiresOn, companyId: hostingItems.companyId, companyName: companies.name, owner: companies.ownerUserId })
    .from(hostingItems)
    .leftJoin(companies, eq(companies.id, hostingItems.companyId))
    .where(and(eq(hostingItems.externalStatus, "active"), inArray(hostingItems.kind, ["domain", "ssl"]), sql`${hostingItems.expiresOn} is not null`, lte(hostingItems.expiresOn, horizon)));
  let created = 0;
  for (const r of rows) {
    if (!r.expiresOn) continue;
    const expired = r.expiresOn < new Date().toISOString().slice(0, 10);
    const what = r.kind === "ssl" ? "SSL certificate" : "Domain";
    const id = await createTask(
      {
        title: `${what} ${expired ? "expired" : "expires"} ${r.expiresOn}: ${r.name}${r.companyName ? ` (${r.companyName})` : " (no company linked)"}`,
        description: r.companyId ? "Check the customer's Hosting tab: confirm the renewal is billed on their contract, then renew it in My20i. The CRM never renews anything itself." : "This 20i item is not linked to a company yet. Link it on Integrations → 20i Hosting, then confirm who is billed before renewing in My20i.",
        priority: expired ? "urgent" : "high",
        dueDate: expired ? new Date().toISOString().slice(0, 10) : r.expiresOn,
        ownerUserId: r.owner ?? null,
        companyId: r.companyId ?? null,
        opportunityId: null,
        contractId: null,
        onboardingId: null,
      },
      null,
      `hosting-expiry:${r.id}:${r.expiresOn}`,
    );
    if (id) created++;
  }
  return { created, checked: rows.length };
}
