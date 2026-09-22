import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { billingDiscrepancies, companies, contractLines, contracts, ninjaDevices, ninjaLocations, ninjaOrganizations, sites } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { getAppSettings } from "@/lib/settings";
import { normalizeCompanyName } from "@/lib/utils";
import { getNinjaOneClient, type NinjaConfig, type NinjaCredentials } from "@/connectors/ninjaone";
import { LiveNinjaOneClient, ninjaTime } from "@/connectors/ninjaone/live";
import type { NinjaDeviceRaw, NinjaRegion } from "@/connectors/ninjaone/types";
import { createLink, getConnection, getLink, listLinks, raiseConflict, removeLink, runSync, setConnectionConfig, setCredentials, updateConnection } from "./integrations";

// ---------------------------------------------------------------------------
// Connection (credentials entered in the UI, verified before storage)
// ---------------------------------------------------------------------------
export async function connectNinjaOne(input: { clientId: string; clientSecret: string; region: NinjaRegion }, actorUserId: string) {
  const client = new LiveNinjaOneClient(input, null, async () => {});
  const test = await client.testConnection();
  if (!test.ok) throw new ActionError(`Could not verify the credentials: ${test.error}`);
  await setCredentials("ninjaone", { clientId: input.clientId, clientSecret: input.clientSecret, region: input.region }, actorUserId, { status: "connected", externalAccountName: `${input.region.toUpperCase()} instance (${test.organisationCount}+ organisations)`, externalAccountId: input.clientId, lastTestedAt: new Date(), lastError: null, consecutiveFailures: 0, pausedUntil: null });
  return test;
}

export async function testNinjaOne(actorUserId: string) {
  const resolved = await getNinjaOneClient();
  if (!resolved) throw new ActionError("NinjaOne is not configured.");
  const test = await resolved.client.testConnection();
  if (resolved.mode === "live") await updateConnection("ninjaone", test.ok ? { status: "connected", lastTestedAt: new Date(), lastError: null } : { status: "error", lastTestedAt: new Date(), lastError: test.error });
  await audit({ actorUserId, action: "integration.test", entityType: "integration", entityId: "ninjaone", details: { ok: test.ok, mode: resolved.mode } });
  return { ...test, mode: resolved.mode };
}

export async function ninjaConnectionSummary() {
  const conn = await getConnection("ninjaone");
  const resolved = await getNinjaOneClient();
  const creds = resolved?.mode === "live" ? await (await import("./integrations")).getCredentials<NinjaCredentials>("ninjaone") : null;
  return { ...conn, credentialsEnc: undefined, config: (conn.config ?? {}) as NinjaConfig, effectiveConfig: resolved?.config ?? null, mode: resolved?.mode ?? null, configured: Boolean(resolved), demo: resolved?.mode === "demo", region: creds?.region ?? "eu", clientIdMasked: creds?.clientId ? `••••${creds.clientId.slice(-4)}` : null };
}

// ---------------------------------------------------------------------------
// Sync (read-only): organisations, locations, devices, health
// ---------------------------------------------------------------------------
export async function syncNinjaOne(trigger: "schedule" | "manual", actorUserId?: string | null) {
  const resolved = await getNinjaOneClient();
  if (!resolved) return null;
  const { client } = resolved;
  return runSync(
    "ninjaone",
    "ninjaone.sync",
    trigger,
    async ({ counters, fail }) => {
      const now = new Date();
      // Organisations + locations
      const seenOrgs = new Set<string>();
      let after = 0;
      for (let page = 0; page < 200; page++) {
        const batch = await client.listOrganizations(after, 200);
        if (!batch.length) break;
        for (const o of batch) {
          seenOrgs.add(String(o.id));
          const norm = normalizeCompanyName(o.name);
          const [existing] = await db.select({ id: ninjaOrganizations.id }).from(ninjaOrganizations).where(eq(ninjaOrganizations.orgId, String(o.id))).limit(1);
          const values = { orgId: String(o.id), name: o.name, normalizedName: norm, description: o.description ?? null, nodeApprovalMode: o.nodeApprovalMode ?? null, externalStatus: "active", raw: o as Record<string, unknown>, fetchedAt: now, updatedAt: now };
          if (existing) await db.update(ninjaOrganizations).set(values).where(eq(ninjaOrganizations.id, existing.id));
          else {
            await db.insert(ninjaOrganizations).values(values);
            counters.created++;
          }
          try {
            const locs = await client.listLocations(o.id);
            for (const l of locs) {
              await db
                .insert(ninjaLocations)
                .values({ locationId: String(l.id), orgId: String(o.id), name: l.name, address: l.address ?? null, externalStatus: "active", raw: l as Record<string, unknown>, fetchedAt: now })
                .onConflictDoUpdate({ target: ninjaLocations.locationId, set: { name: l.name, address: l.address ?? null, externalStatus: "active", raw: l as Record<string, unknown>, fetchedAt: now, updatedAt: now } });
            }
          } catch (err) {
            await fail(`Locations for organisation ${o.name}: ${err instanceof Error ? err.message : String(err)}`, { externalId: String(o.id) });
          }
        }
        after = batch[batch.length - 1].id;
        if (batch.length < 200) break;
      }
      // Organisations that disappeared keep their rows and links but are marked deleted.
      if (seenOrgs.size) {
        const gone = await db.update(ninjaOrganizations).set({ externalStatus: "deleted", updatedAt: now }).where(and(notInArray(ninjaOrganizations.orgId, [...seenOrgs]), eq(ninjaOrganizations.externalStatus, "active"))).returning({ orgId: ninjaOrganizations.orgId, name: ninjaOrganizations.name });
        for (const g of gone) {
          const link = await db.select().from(db._.fullSchema.externalLinks).where(and(eq(db._.fullSchema.externalLinks.provider, "ninjaone"), eq(db._.fullSchema.externalLinks.entityType, "company"), eq(db._.fullSchema.externalLinks.externalId, g.orgId))).limit(1);
          if (link[0]) {
            await db.update(db._.fullSchema.externalLinks).set({ externalStatus: "deleted", updatedAt: now }).where(eq(db._.fullSchema.externalLinks.id, link[0].id));
            await raiseConflict({ provider: "ninjaone", entityType: "company", localId: link[0].localId, externalId: g.orgId, kind: "external_deleted", message: `NinjaOne organisation "${g.name}" no longer exists but is linked to a CRM company. Unlink or re-map it.` });
          }
        }
      }

      // Devices
      const orgLinks = await listLinks("ninjaone", "company");
      const locLinks = await listLinks("ninjaone", "site");
      const companyByOrg = new Map(orgLinks.map((l) => [l.externalId, l.localId]));
      const siteByLoc = new Map(locLinks.map((l) => [l.externalId, l.localId]));
      const seenDevices = new Set<string>();
      after = 0;
      for (let page = 0; page < 500; page++) {
        const batch = await client.listDevicesDetailed(after, 500);
        if (!batch.length) break;
        for (const d of batch) {
          counters.fetched++;
          seenDevices.add(String(d.id));
          try {
            const r = await upsertDevice(d, companyByOrg, siteByLoc, now);
            if (r === "created") counters.created++;
            else if (r === "updated") counters.updated++;
            else counters.skipped++;
          } catch (err) {
            await fail(err instanceof Error ? err.message : String(err), { externalId: String(d.id) });
          }
        }
        after = batch[batch.length - 1].id;
        if (batch.length < 500) break;
      }
      if (seenDevices.size) {
        await db.update(ninjaDevices).set({ externalStatus: "deleted", updatedAt: now }).where(and(notInArray(ninjaDevices.deviceId, [...seenDevices]), eq(ninjaDevices.externalStatus, "active")));
      }

      // Health (best effort: not every plan/role exposes it)
      try {
        let cursor: string | undefined;
        for (let page = 0; page < 200; page++) {
          const { results, nextCursor } = await client.deviceHealth(cursor, 500);
          for (const h of results) {
            await db
              .update(ninjaDevices)
              .set({ healthStatus: h.healthStatus ?? null, pendingOsPatches: h.pendingOSPatchesCount ?? null, failedOsPatches: h.failedOSPatchesCount ?? null, activeThreats: h.activeThreatsCount ?? null, avStatus: h.avInstallStatus ?? null, alertCount: h.alertCount ?? null, healthFetchedAt: now })
              .where(eq(ninjaDevices.deviceId, String(h.deviceId)));
          }
          if (!nextCursor) break;
          cursor = nextCursor;
        }
      } catch (err) {
        await fail(`Device health unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }

      const disc = await runDiscrepancyCheck(null);
      return `${seenOrgs.size} organisations, ${seenDevices.size} devices${resolved.mode === "demo" ? " (DEMO data)" : ""}; ${disc.open} open discrepancies`;
    },
    actorUserId,
  );
}

async function upsertDevice(d: NinjaDeviceRaw, companyByOrg: Map<string, string>, siteByLoc: Map<string, string>, now: Date): Promise<"created" | "updated" | "unchanged"> {
  const [existing] = await db.select({ id: ninjaDevices.id, lastContact: ninjaDevices.lastContact, lastUpdate: ninjaDevices.lastUpdate, companyId: ninjaDevices.companyId, siteId: ninjaDevices.siteId, externalStatus: ninjaDevices.externalStatus }).from(ninjaDevices).where(eq(ninjaDevices.deviceId, String(d.id))).limit(1);
  const lastContact = ninjaTime(d.lastContact);
  const lastUpdate = ninjaTime(d.lastUpdate);
  const values = {
    deviceId: String(d.id),
    orgId: String(d.organizationId),
    locationId: d.locationId ? String(d.locationId) : null,
    companyId: companyByOrg.get(String(d.organizationId)) ?? null,
    siteId: d.locationId ? (siteByLoc.get(String(d.locationId)) ?? null) : null,
    nodeClass: d.nodeClass,
    displayName: d.displayName ?? d.systemName ?? null,
    systemName: d.systemName ?? null,
    dnsName: d.dnsName ?? null,
    approvalStatus: d.approvalStatus ?? null,
    offline: d.offline ?? null,
    lastContact,
    lastUpdate,
    createdExternal: ninjaTime(d.created),
    osName: d.os?.name ?? null,
    osManufacturer: d.os?.manufacturer ?? null,
    osBuild: d.os?.buildNumber ?? null,
    needsReboot: d.os?.needsReboot ?? null,
    ipAddresses: d.ipAddresses ?? null,
    publicIp: d.publicIP ?? null,
    externalStatus: "active",
    raw: d as Record<string, unknown>,
    fetchedAt: now,
    updatedAt: now,
  };
  if (!existing) {
    await db.insert(ninjaDevices).values(values);
    return "created";
  }
  const changed = existing.lastContact?.getTime() !== lastContact?.getTime() || existing.lastUpdate?.getTime() !== lastUpdate?.getTime() || existing.companyId !== values.companyId || existing.siteId !== values.siteId || existing.externalStatus !== "active";
  await db.update(ninjaDevices).set(changed ? values : { fetchedAt: now }).where(eq(ninjaDevices.id, existing.id));
  return changed ? "updated" : "unchanged";
}

// ---------------------------------------------------------------------------
// Mapping: organisations ↔ companies, locations ↔ sites
// ---------------------------------------------------------------------------
export async function ninjaMappingOverview() {
  const [orgs, locs, orgLinks, siteLinks, companyRows, siteRows] = await Promise.all([
    db.select().from(ninjaOrganizations).orderBy(asc(ninjaOrganizations.name)),
    db.select().from(ninjaLocations).orderBy(asc(ninjaLocations.name)),
    listLinks("ninjaone", "company"),
    listLinks("ninjaone", "site"),
    db.select({ id: companies.id, name: companies.name, normalizedName: companies.normalizedName, status: companies.status }).from(companies).where(isNull(companies.archivedAt)).orderBy(asc(companies.name)),
    db.select({ id: sites.id, name: sites.name, companyId: sites.companyId }).from(sites).where(isNull(sites.archivedAt)),
  ]);
  const linkByOrg = new Map(orgLinks.map((l) => [l.externalId, l]));
  const linkByLoc = new Map(siteLinks.map((l) => [l.externalId, l]));
  const linkedCompanyIds = new Set(orgLinks.map((l) => l.localId));
  const counts = await db.select({ orgId: ninjaDevices.orgId, n: sql<number>`count(*)`.mapWith(Number) }).from(ninjaDevices).where(eq(ninjaDevices.externalStatus, "active")).groupBy(ninjaDevices.orgId);
  const countByOrg = new Map(counts.map((c) => [c.orgId, c.n]));
  const rows = orgs.map((o) => {
    const link = linkByOrg.get(o.orgId) ?? null;
    const suggestions = link
      ? []
      : companyRows
          .filter((c) => !linkedCompanyIds.has(c.id))
          .map((c) => ({ id: c.id, name: c.name, score: c.normalizedName === o.normalizedName ? 2 : c.normalizedName.includes(o.normalizedName) || o.normalizedName.includes(c.normalizedName) ? 1 : 0 }))
          .filter((c) => c.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
    const companyId = link?.localId ?? null;
    const orgLocations = locs.filter((l) => l.orgId === o.orgId).map((l) => ({ ...l, link: linkByLoc.get(l.locationId) ?? null, siteOptions: companyId ? siteRows.filter((s) => s.companyId === companyId) : [] }));
    return { ...o, link, suggestions, deviceCount: countByOrg.get(o.orgId) ?? 0, locations: orgLocations };
  });
  return { organisations: rows, companies: companyRows, linkedCount: orgLinks.length };
}

export async function linkOrganization(orgId: string, companyId: string, actorUserId: string) {
  const [o] = await db.select().from(ninjaOrganizations).where(eq(ninjaOrganizations.orgId, orgId)).limit(1);
  if (!o) throw new ActionError("Organisation not found in the mirror. Run a sync first.");
  await createLink({ provider: "ninjaone", entityType: "company", localId: companyId, externalId: orgId, externalName: o.name, externalType: "organization", source: "manual" }, actorUserId);
  await db.update(ninjaDevices).set({ companyId }).where(eq(ninjaDevices.orgId, orgId));
  await logActivity({ type: "device", companyId, title: `Linked to NinjaOne organisation "${o.name}"`, actorUserId, source: "ninjaone" });
  await runDiscrepancyCheck(actorUserId, companyId);
}

export async function unlinkOrganization(companyId: string, actorUserId: string) {
  const link = await getLink("ninjaone", "company", companyId);
  if (!link) return;
  await removeLink(link.id, actorUserId);
  await db.update(ninjaDevices).set({ companyId: null, siteId: null }).where(eq(ninjaDevices.orgId, link.externalId));
  const siteLinks = await listLinks("ninjaone", "site");
  const siteIds = (await db.select({ id: sites.id }).from(sites).where(eq(sites.companyId, companyId))).map((s) => s.id);
  for (const sl of siteLinks) if (siteIds.includes(sl.localId)) await removeLink(sl.id, actorUserId);
  await db.update(billingDiscrepancies).set({ status: "dismissed", note: "Organisation unlinked", updatedAt: new Date() }).where(and(eq(billingDiscrepancies.companyId, companyId), eq(billingDiscrepancies.status, "open")));
}

export async function linkLocation(locationId: string, siteId: string, actorUserId: string) {
  const [l] = await db.select().from(ninjaLocations).where(eq(ninjaLocations.locationId, locationId)).limit(1);
  if (!l) throw new ActionError("Location not found in the mirror.");
  const [s] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!s) throw new ActionError("Site not found.");
  const orgLink = await getLink("ninjaone", "company", s.companyId);
  if (!orgLink || orgLink.externalId !== l.orgId) throw new ActionError("Link the site's company to this location's organisation first.");
  await createLink({ provider: "ninjaone", entityType: "site", localId: siteId, externalId: locationId, externalName: l.name, externalType: "location", source: "manual" }, actorUserId);
  await db.update(ninjaDevices).set({ siteId }).where(eq(ninjaDevices.locationId, locationId));
  await runDiscrepancyCheck(actorUserId, s.companyId);
}

export async function unlinkLocation(siteId: string, actorUserId: string) {
  const link = await getLink("ninjaone", "site", siteId);
  if (!link) return;
  await removeLink(link.id, actorUserId);
  await db.update(ninjaDevices).set({ siteId: null }).where(eq(ninjaDevices.locationId, link.externalId));
}

// ---------------------------------------------------------------------------
// Device queries
// ---------------------------------------------------------------------------
export type DeviceFreshness = "live" | "cached" | "stale" | "unavailable";

export function deviceFreshness(fetchedAt: Date | null | undefined, pollMinutes = 60): DeviceFreshness {
  if (!fetchedAt) return "unavailable";
  const age = Date.now() - fetchedAt.getTime();
  if (age < 5 * 60_000) return "live";
  if (age < 3 * pollMinutes * 60_000) return "cached";
  return "stale";
}

export async function listDevices(p: { q?: string; companyId?: string; orgId?: string; nodeClass?: string; status?: "online" | "offline" | "inactive" | "deleted"; health?: string; page?: number; pageSize?: number }) {
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 50, 500);
  const settings = await getAppSettings();
  const activeCutoff = new Date(Date.now() - settings.deviceActiveDays * 86400000);
  const conds = [
    p.status === "deleted" ? eq(ninjaDevices.externalStatus, "deleted") : eq(ninjaDevices.externalStatus, "active"),
    p.q ? or(sql`${ninjaDevices.displayName} ilike ${"%" + p.q + "%"}`, sql`${ninjaDevices.systemName} ilike ${"%" + p.q + "%"}`, sql`${ninjaDevices.dnsName} ilike ${"%" + p.q + "%"}`, sql`${ninjaOrganizations.name} ilike ${"%" + p.q + "%"}`) : undefined,
    p.companyId ? eq(ninjaDevices.companyId, p.companyId) : undefined,
    p.orgId ? eq(ninjaDevices.orgId, p.orgId) : undefined,
    p.nodeClass ? eq(ninjaDevices.nodeClass, p.nodeClass) : undefined,
    p.status === "online" ? eq(ninjaDevices.offline, false) : p.status === "offline" ? and(eq(ninjaDevices.offline, true), sql`${ninjaDevices.lastContact} >= ${activeCutoff}`) : p.status === "inactive" ? or(isNull(ninjaDevices.lastContact), sql`${ninjaDevices.lastContact} < ${activeCutoff}`) : undefined,
    p.health ? eq(ninjaDevices.healthStatus, p.health) : undefined,
  ].filter(Boolean);
  const where = and(...(conds as [ReturnType<typeof eq>]));
  const base = () => db.select({ d: ninjaDevices, orgName: ninjaOrganizations.name, locationName: ninjaLocations.name, companyName: companies.name, siteName: sites.name }).from(ninjaDevices).leftJoin(ninjaOrganizations, eq(ninjaOrganizations.orgId, ninjaDevices.orgId)).leftJoin(ninjaLocations, eq(ninjaLocations.locationId, ninjaDevices.locationId)).leftJoin(companies, eq(companies.id, ninjaDevices.companyId)).leftJoin(sites, eq(sites.id, ninjaDevices.siteId));
  const [rows, [{ total }]] = await Promise.all([
    base().where(where).orderBy(asc(ninjaOrganizations.name), asc(ninjaDevices.displayName)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(ninjaDevices).leftJoin(ninjaOrganizations, eq(ninjaOrganizations.orgId, ninjaDevices.orgId)).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.d, orgName: r.orgName, locationName: r.locationName, companyName: r.companyName, siteName: r.siteName, freshness: deviceFreshness(r.d.fetchedAt), active: Boolean(r.d.lastContact && r.d.lastContact >= activeCutoff) })), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), activeCutoff };
}

export async function deviceTotals(companyId?: string) {
  const settings = await getAppSettings();
  const resolved = await getNinjaOneClient();
  const classes = resolved?.config.billableNodeClasses ?? [];
  const cutoff = new Date(Date.now() - settings.deviceActiveDays * 86400000);
  const [row] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      active: sql<number>`count(*) filter (where last_contact >= ${cutoff})`.mapWith(Number),
      online: sql<number>`count(*) filter (where offline = false)`.mapWith(Number),
      billable: sql<number>`count(*) filter (where last_contact >= ${cutoff} and node_class in ${classes.length ? sql`(${sql.join(classes.map((c) => sql`${c}`), sql`, `)})` : sql`('__none__')`} and (approval_status = 'APPROVED' or approval_status is null))`.mapWith(Number),
      servers: sql<number>`count(*) filter (where node_class like '%SERVER%' and last_contact >= ${cutoff})`.mapWith(Number),
      workstations: sql<number>`count(*) filter (where node_class in ('WINDOWS_WORKSTATION','MAC','LINUX_WORKSTATION') and last_contact >= ${cutoff})`.mapWith(Number),
      needsAttention: sql<number>`count(*) filter (where health_status is not null and health_status <> 'HEALTHY' and last_contact >= ${cutoff})`.mapWith(Number),
      unmapped: sql<number>`count(*) filter (where company_id is null)`.mapWith(Number),
      lastFetched: sql<Date | null>`max(fetched_at)`,
    })
    .from(ninjaDevices)
    .where(companyId ? and(eq(ninjaDevices.externalStatus, "active"), eq(ninjaDevices.companyId, companyId)) : eq(ninjaDevices.externalStatus, "active"));
  return { ...row, activeDays: settings.deviceActiveDays, freshness: deviceFreshness(row.lastFetched ? new Date(row.lastFetched) : null) };
}

// ---------------------------------------------------------------------------
// Discrepancy engine: contracted (per-device lines) vs observed active devices
// ---------------------------------------------------------------------------
export async function runDiscrepancyCheck(actorUserId: string | null, companyId?: string) {
  const settings = await getAppSettings();
  const resolved = await getNinjaOneClient();
  const classes = resolved?.config.billableNodeClasses ?? [];
  const approvedOnly = resolved?.config.approvedOnly ?? true;
  const cutoff = new Date(Date.now() - settings.deviceActiveDays * 86400000);
  const lines = await db
    .select({ line: contractLines, contract: contracts })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(eq(contractLines.countsAsManagedDevice, true), eq(contracts.status, "active"), isNull(contracts.archivedAt), companyId ? eq(contracts.companyId, companyId) : undefined));
  let open = 0;
  let resolvedCount = 0;
  const now = new Date();
  for (const { line, contract } of lines) {
    const link = await getLink("ninjaone", "company", contract.companyId);
    if (!link) continue; // observed count unavailable: nothing to compare
    const scope = [eq(ninjaDevices.companyId, contract.companyId), eq(ninjaDevices.externalStatus, "active"), sql`${ninjaDevices.lastContact} >= ${cutoff}`, classes.length ? inArray(ninjaDevices.nodeClass, classes) : sql`false`];
    if (approvedOnly) scope.push(or(eq(ninjaDevices.approvalStatus, "APPROVED"), isNull(ninjaDevices.approvalStatus))!);
    if (line.siteId) {
      const siteLink = await getLink("ninjaone", "site", line.siteId);
      if (!siteLink) continue; // site not mapped: can't scope, skip rather than guess
      scope.push(eq(ninjaDevices.siteId, line.siteId));
    }
    const [{ observed }] = await db.select({ observed: sql<number>`count(*)`.mapWith(Number) }).from(ninjaDevices).where(and(...scope));
    const contracted = Number(line.quantity);
    const diff = observed - contracted;
    const [existing] = await db.select().from(billingDiscrepancies).where(and(eq(billingDiscrepancies.contractLineId, line.id), inArray(billingDiscrepancies.status, ["open", "accepted"]))).orderBy(desc(billingDiscrepancies.detectedAt)).limit(1);
    const basis = { activeDays: settings.deviceActiveDays, billableNodeClasses: classes, approvedOnly, siteScoped: Boolean(line.siteId), checkedAt: now.toISOString() };
    if (diff === 0) {
      if (existing) {
        await db.update(billingDiscrepancies).set({ status: "resolved", observedQty: observed, difference: "0", note: "Counts now match", lastSeenAt: now, updatedAt: now }).where(eq(billingDiscrepancies.id, existing.id));
        resolvedCount++;
      }
      continue;
    }
    if (existing) {
      // Same or changed difference: keep the review item current; an accepted one re-opens if the gap grows.
      const changed = existing.observedQty !== observed;
      await db.update(billingDiscrepancies).set({ observedQty: observed, contractedQty: String(contracted), difference: String(diff), lastSeenAt: now, basis, status: existing.status === "accepted" && changed && Math.abs(diff) > Math.abs(Number(existing.difference)) ? "open" : existing.status, updatedAt: now }).where(eq(billingDiscrepancies.id, existing.id));
      if (existing.status === "open") open++;
    } else {
      await db.insert(billingDiscrepancies).values({ companyId: contract.companyId, contractId: contract.id, contractLineId: line.id, siteId: line.siteId, lineDescription: line.description, contractedQty: String(contracted), observedQty: observed, difference: String(diff), unitPrice: line.unitPrice, basis });
      await logActivity({ type: "device", companyId: contract.companyId, entityType: "contract", entityId: contract.id, title: `Device count discrepancy: ${line.description} contracted ${contracted}, observed ${observed} (${diff > 0 ? "+" : ""}${diff})`, actorUserId, source: "ninjaone" });
      open++;
    }
  }
  return { open, resolved: resolvedCount, checked: lines.length };
}

export async function listDiscrepancies(p: { status?: string; companyId?: string }) {
  return db
    .select({ d: billingDiscrepancies, companyName: companies.name, contractName: contracts.name, siteName: sites.name, reviewedBy: db._.fullSchema.user.name })
    .from(billingDiscrepancies)
    .innerJoin(companies, eq(companies.id, billingDiscrepancies.companyId))
    .innerJoin(contracts, eq(contracts.id, billingDiscrepancies.contractId))
    .leftJoin(sites, eq(sites.id, billingDiscrepancies.siteId))
    .leftJoin(db._.fullSchema.user, eq(db._.fullSchema.user.id, billingDiscrepancies.reviewedByUserId))
    .where(and(p.status && p.status !== "all" ? eq(billingDiscrepancies.status, p.status as "open") : undefined, p.companyId ? eq(billingDiscrepancies.companyId, p.companyId) : undefined))
    .orderBy(sql`case when ${billingDiscrepancies.status} = 'open' then 0 else 1 end`, desc(billingDiscrepancies.lastSeenAt))
    .then((rows) => rows.map((r) => ({ ...r.d, companyName: r.companyName, contractName: r.contractName, siteName: r.siteName, reviewedBy: r.reviewedBy })));
}

export async function reviewDiscrepancy(id: string, status: "accepted" | "dismissed", note: string | null, actorUserId: string) {
  const [d] = await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, id)).limit(1);
  if (!d) throw new ActionError("Discrepancy not found.");
  await db.update(billingDiscrepancies).set({ status, note, reviewedByUserId: actorUserId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(billingDiscrepancies.id, id));
  await audit({ actorUserId, action: `discrepancy.${status}`, entityType: "billing_discrepancy", entityId: id, details: { contractLineId: d.contractLineId, contracted: d.contractedQty, observed: d.observedQty, note } });
  await logActivity({ type: "device", companyId: d.companyId, entityType: "contract", entityId: d.contractId, title: `Device discrepancy ${status}: ${d.lineDescription} (contracted ${d.contractedQty}, observed ${d.observedQty})`, body: note, actorUserId, source: "ninjaone" });
}

export async function saveNinjaConfig(input: { billableNodeClasses: string[]; approvedOnly: boolean }, actorUserId: string) {
  await setConnectionConfig("ninjaone", input, actorUserId);
  await runDiscrepancyCheck(actorUserId);
}

export async function companyDeviceOverview(companyId: string) {
  const link = await getLink("ninjaone", "company", companyId);
  if (!link) return null;
  const [org] = await db.select().from(ninjaOrganizations).where(eq(ninjaOrganizations.orgId, link.externalId)).limit(1);
  const [totals, devices, discrepancies] = await Promise.all([deviceTotals(companyId), listDevices({ companyId, pageSize: 500 }), listDiscrepancies({ companyId })]);
  const resolved = await getNinjaOneClient();
  return { link, org: org ?? null, totals, devices: devices.rows, activeCutoff: devices.activeCutoff, discrepancies, consoleUrl: resolved?.client.consoleUrl("organization", link.externalId) ?? null, mode: resolved?.mode ?? null };
}
