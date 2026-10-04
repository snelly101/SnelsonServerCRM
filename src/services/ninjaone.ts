import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { billingDiscrepancies, companies, contractLines, contracts, ninjaDevices, ninjaLocations, ninjaOrganizations, sites, user } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { logger } from "@/lib/logger";
import { getAppSettings } from "@/lib/settings";
import { normalizeCompanyName } from "@/lib/utils";
import { companySchema } from "@/lib/validation";
import { createCompany, findDuplicateCompanies } from "./companies";
import { getNinjaOneClient, type NinjaConfig, type NinjaCredentials } from "@/connectors/ninjaone";
import { LiveNinjaOneClient, NINJA_SCOPES, ninjaTime } from "@/connectors/ninjaone/live";
import type { NinjaDeviceRaw, NinjaRegion } from "@/connectors/ninjaone/types";
import { createLink, getConnection, getLink, listLinks, raiseConflict, removeLink, runOutbound, runSync, setConnectionConfig, setCredentials, updateConnection } from "./integrations";
import { NON_BILLABLE_STATES } from "./coverage-lookup";

/** SQL fragment: the device has no coverage row marking it free or internal. */
const notMarkedNonBillable = sql`not exists (select 1 from service_coverage sc where sc.source = 'ninja_device' and sc.source_row_id = ${ninjaDevices.id} and sc.state in (${sql.join(NON_BILLABLE_STATES.map((x) => sql`${x}`), sql`, `)}))`;

// ---------------------------------------------------------------------------
// Connection (credentials entered in the UI, verified before storage)
// ---------------------------------------------------------------------------
export async function connectNinjaOne(input: { clientId: string; clientSecret: string; region: NinjaRegion; management?: boolean }, actorUserId: string) {
  // The scope set is fixed at connect time: Management is only requested when asked for, and the token request fails if the API client was not granted it.
  const scopes = input.management ? NINJA_SCOPES.management : NINJA_SCOPES.readOnly;
  const client = new LiveNinjaOneClient({ ...input, scopes }, null, async () => {});
  const test = await client.testConnection();
  if (!test.ok) throw new ActionError(`Could not verify the credentials: ${test.error}${input.management ? " (if the error mentions scope, grant the Management scope to the API client in NinjaOne or untick the option)" : ""}`);
  await setCredentials("ninjaone", { clientId: input.clientId, clientSecret: input.clientSecret, region: input.region, scopes }, actorUserId, { status: "connected", externalAccountName: `${input.region.toUpperCase()} instance (${test.organisationCount}+ organisations)`, externalAccountId: input.clientId, lastTestedAt: new Date(), lastError: null, consecutiveFailures: 0, pausedUntil: null });
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
  return { ...conn, credentialsEnc: undefined, config: (conn.config ?? {}) as NinjaConfig, effectiveConfig: resolved?.config ?? null, mode: resolved?.mode ?? null, configured: Boolean(resolved), demo: resolved?.mode === "demo", region: creds?.region ?? "eu", managementScope: (creds?.scopes ?? NINJA_SCOPES.readOnly).split(" ").includes("management"), clientIdMasked: creds?.clientId ? `••••${creds.clientId.slice(-4)}` : null };
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
  const coverage = rows.length ? await (await import("./coverage-lookup")).coverageFor("ninja_device", { rowIds: rows.map((r) => r.d.id) }) : new Map();
  return { rows: rows.map((r) => ({ ...r.d, orgName: r.orgName, locationName: r.locationName, companyName: r.companyName, siteName: r.siteName, freshness: deviceFreshness(r.d.fetchedAt), active: Boolean(r.d.lastContact && r.d.lastContact >= activeCutoff), coverage: ((c) => (c ? { state: c.state, reason: c.reason, reviewOn: c.reviewOn } : null))(coverage.get(r.d.id)) })), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), activeCutoff };
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
      billable: sql<number>`count(*) filter (where last_contact >= ${cutoff} and node_class in ${classes.length ? sql`(${sql.join(classes.map((c) => sql`${c}`), sql`, `)})` : sql`('__none__')`} and (approval_status = 'APPROVED' or approval_status is null) and ${notMarkedNonBillable})`.mapWith(Number),
      nonBillable: sql<number>`count(*) filter (where exists (select 1 from service_coverage sc where sc.source = 'ninja_device' and sc.source_row_id = ninja_devices.id))`.mapWith(Number),
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
  // Lines of one contract that share a scope (whole organisation, or the same site) describe one pool of devices,
  // so they are compared together: contracted = the sum of their quantities, one review item on the first line.
  const groups = new Map<string, { contract: (typeof lines)[number]["contract"]; lines: (typeof lines)[number]["line"][] }>();
  for (const { line, contract } of lines) {
    const key = `${contract.id}:${line.siteId ?? "org"}`;
    const g = groups.get(key) ?? { contract, lines: [] };
    g.lines.push(line);
    groups.set(key, g);
  }
  for (const { contract, lines: groupLines } of groups.values()) {
    const line = groupLines[0];
    const link = await getLink("ninjaone", "company", contract.companyId);
    if (!link) continue; // observed count unavailable: nothing to compare
    const scope = [eq(ninjaDevices.companyId, contract.companyId), eq(ninjaDevices.externalStatus, "active"), sql`${ninjaDevices.lastContact} >= ${cutoff}`, classes.length ? inArray(ninjaDevices.nodeClass, classes) : sql`false`, notMarkedNonBillable];
    if (approvedOnly) scope.push(or(eq(ninjaDevices.approvalStatus, "APPROVED"), isNull(ninjaDevices.approvalStatus))!);
    if (line.siteId) {
      const siteLink = await getLink("ninjaone", "site", line.siteId);
      if (!siteLink) continue; // site not mapped: can't scope, skip rather than guess
      scope.push(eq(ninjaDevices.siteId, line.siteId));
    }
    const [{ observed }] = await db.select({ observed: sql<number>`count(*)`.mapWith(Number) }).from(ninjaDevices).where(and(...scope));
    const contracted = groupLines.reduce((a, l) => a + Number(l.quantity), 0);
    const description = groupLines.map((l) => l.description).join(" + ");
    const diff = observed - contracted;
    const [existing] = await db.select().from(billingDiscrepancies).where(and(eq(billingDiscrepancies.source, "ninjaone"), eq(billingDiscrepancies.contractLineId, line.id), inArray(billingDiscrepancies.status, ["open", "accepted"]))).orderBy(desc(billingDiscrepancies.detectedAt)).limit(1);
    // Items left on the other lines of the group from before they were compared together are closed.
    if (groupLines.length > 1) await db.update(billingDiscrepancies).set({ status: "resolved", note: "Now compared together with the other lines of this contract", updatedAt: now }).where(and(eq(billingDiscrepancies.source, "ninjaone"), inArray(billingDiscrepancies.contractLineId, groupLines.slice(1).map((l) => l.id)), inArray(billingDiscrepancies.status, ["open", "accepted"])));
    const basis = { activeDays: settings.deviceActiveDays, billableNodeClasses: classes, approvedOnly, siteScoped: Boolean(line.siteId), lineIds: groupLines.map((l) => l.id), checkedAt: now.toISOString() };
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
      await db.update(billingDiscrepancies).set({ observedQty: observed, contractedQty: String(contracted), difference: String(diff), lineDescription: description, lastSeenAt: now, basis, status: existing.status === "accepted" && changed && Math.abs(diff) > Math.abs(Number(existing.difference)) ? "open" : existing.status, updatedAt: now }).where(eq(billingDiscrepancies.id, existing.id));
      if (existing.status === "open") open++;
    } else {
      await db.insert(billingDiscrepancies).values({ companyId: contract.companyId, contractId: contract.id, contractLineId: line.id, siteId: line.siteId, lineDescription: description, contractedQty: String(contracted), observedQty: observed, difference: String(diff), unitPrice: line.unitPrice, basis });
      await logActivity({ type: "device", companyId: contract.companyId, entityType: "contract", entityId: contract.id, title: `Device count discrepancy: ${description} contracted ${contracted}, observed ${observed} (${diff > 0 ? "+" : ""}${diff})`, actorUserId, source: "ninjaone" });
      open++;
    }
  }
  return { open, resolved: resolvedCount, checked: lines.length };
}

export async function listDiscrepancies(p: { status?: string; companyId?: string; source?: "ninjaone" | "pax8" }) {
  return db
    .select({ d: billingDiscrepancies, companyName: companies.name, contractName: contracts.name, siteName: sites.name, reviewedBy: db._.fullSchema.user.name })
    .from(billingDiscrepancies)
    .innerJoin(companies, eq(companies.id, billingDiscrepancies.companyId))
    .innerJoin(contracts, eq(contracts.id, billingDiscrepancies.contractId))
    .leftJoin(sites, eq(sites.id, billingDiscrepancies.siteId))
    .leftJoin(db._.fullSchema.user, eq(db._.fullSchema.user.id, billingDiscrepancies.reviewedByUserId))
    .where(and(p.status && p.status !== "all" ? eq(billingDiscrepancies.status, p.status as "open") : undefined, p.companyId ? eq(billingDiscrepancies.companyId, p.companyId) : undefined, p.source ? eq(billingDiscrepancies.source, p.source) : undefined))
    .orderBy(sql`case when ${billingDiscrepancies.status} = 'open' then 0 else 1 end`, desc(billingDiscrepancies.lastSeenAt))
    .then((rows) => rows.map((r) => ({ ...r.d, companyName: r.companyName, contractName: r.contractName, siteName: r.siteName, reviewedBy: r.reviewedBy })));
}

export async function reviewDiscrepancy(id: string, status: "accepted" | "dismissed", note: string | null, actorUserId: string) {
  const [d] = await db.select().from(billingDiscrepancies).where(eq(billingDiscrepancies.id, id)).limit(1);
  if (!d) throw new ActionError("Discrepancy not found.");
  await db.update(billingDiscrepancies).set({ status, note, reviewedByUserId: actorUserId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(billingDiscrepancies.id, id));
  await audit({ actorUserId, action: `discrepancy.${status}`, entityType: "billing_discrepancy", entityId: id, details: { contractLineId: d.contractLineId, contracted: d.contractedQty, observed: d.observedQty, note } });
  const licence = d.source === "pax8";
  await logActivity({ type: licence ? "sync" : "device", companyId: d.companyId, entityType: "contract", entityId: d.contractId, title: `${licence ? "Licence" : "Device"} discrepancy ${status}: ${d.lineDescription} (contracted ${d.contractedQty}, observed ${d.observedQty})`, body: note, actorUserId, source: d.source });
}

export async function saveNinjaConfig(input: { billableNodeClasses: string[]; approvedOnly: boolean; autoCreateOrganizations?: boolean }, actorUserId: string) {
  await setConnectionConfig("ninjaone", input, actorUserId);
  await runDiscrepancyCheck(actorUserId);
}

export async function companyDeviceOverview(companyId: string) {
  const link = await getLink("ninjaone", "company", companyId);
  if (!link) return null;
  const [org] = await db.select().from(ninjaOrganizations).where(eq(ninjaOrganizations.orgId, link.externalId)).limit(1);
  const [totals, devices, discrepancies] = await Promise.all([deviceTotals(companyId), listDevices({ companyId, pageSize: 500 }), listDiscrepancies({ companyId, source: "ninjaone" })]);
  const resolved = await getNinjaOneClient();
  return { link, org: org ?? null, totals, devices: devices.rows, activeCutoff: devices.activeCutoff, discrepancies, consoleUrl: resolved?.client.consoleUrl("organization", link.externalId) ?? null, mode: resolved?.mode ?? null };
}

// ---------------------------------------------------------------------------
// Import: create a CRM company from a NinjaOne organisation and link it
// ---------------------------------------------------------------------------
export type NinjaImportResult = { orgId: string; name: string; action: "created" | "linked" | "skipped"; companyId?: string; reason?: string };

export async function importOrganizationAsCompany(orgId: string, actorUserId: string): Promise<NinjaImportResult> {
  const [o] = await db.select().from(ninjaOrganizations).where(eq(ninjaOrganizations.orgId, orgId)).limit(1);
  if (!o) throw new ActionError("Organisation not found in the mirror. Run a sync first.");
  const links = await listLinks("ninjaone", "company");
  if (links.some((l) => l.externalId === orgId)) return { orgId, name: o.name, action: "skipped", reason: "already linked" };
  const linkedLocal = new Set(links.map((l) => l.localId));
  const dupes = (await findDuplicateCompanies({ name: o.name })).filter((d) => d.confidence === "high" || d.reason === "exact_name");
  const free = dupes.find((d) => !linkedLocal.has(d.id));
  if (dupes.length && !free) return { orgId, name: o.name, action: "skipped", reason: `looks like "${dupes[0].name}", which is already linked to another organisation` };
  if (free) {
    await linkOrganization(orgId, free.id, actorUserId);
    return { orgId, name: o.name, action: "linked", companyId: free.id };
  }
  const companyId = await createCompany(companySchema.parse({ name: o.name, status: "customer" }), actorUserId, { skipDuplicateCheck: true });
  await linkOrganization(orgId, companyId, actorUserId);
  await audit({ actorUserId, action: "ninjaone.organization.import", entityType: "company", entityId: companyId, details: { orgId, name: o.name } });
  return { orgId, name: o.name, action: "created", companyId };
}

// ---------------------------------------------------------------------------
// Create: a NinjaOne organisation for a CRM company (the integration's one write)
// ---------------------------------------------------------------------------
/** Organisations in the mirror that look like this company (exact normalised name, or one name containing the other). */
async function likelyNinjaMatches(companyName: string) {
  const norm = normalizeCompanyName(companyName);
  if (!norm) return [];
  const rows = await db.select({ orgId: ninjaOrganizations.orgId, name: ninjaOrganizations.name, normalizedName: ninjaOrganizations.normalizedName }).from(ninjaOrganizations).where(eq(ninjaOrganizations.externalStatus, "active"));
  return rows
    .map((o) => ({ ...o, score: o.normalizedName === norm ? 2 : o.normalizedName.length >= 6 && norm.length >= 6 && (o.normalizedName.includes(norm) || norm.includes(o.normalizedName)) ? 1 : 0 }))
    .filter((o) => o.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Creates the organisation in NinjaOne with one location from the billing
 * address, mirrors it, and links the company. Idempotent per company through
 * the outbound ledger; a retry after a timeout reconciles by exact name.
 * Refuses when the company is already linked or an organisation looks like it.
 */
export async function createNinjaOrganizationForCompany(companyId: string, actorUserId: string) {
  const resolved = await getNinjaOneClient();
  if (!resolved) throw new ActionError("NinjaOne is not configured.");
  if (resolved.mode === "live" && !(resolved.client as LiveNinjaOneClient).canManage) throw new ActionError("The NinjaOne credential has no Management scope. Reconnect with \"Allow the CRM to create organisations\" ticked.");
  const [co] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!co) throw new ActionError("Company not found.");
  const existing = await getLink("ninjaone", "company", companyId);
  if (existing) return existing.externalId;
  const matches = await likelyNinjaMatches(co.name);
  if (matches.length) throw new ActionError(`NinjaOne already has "${matches[0].name}", which looks like this company. Link it from the mapping table instead.`);
  const address = [co.addressLine1, co.addressLine2, co.city, co.postcode, co.country].filter((v): v is string => Boolean(v && v.trim())).join(", ");
  const { result } = await runOutbound(
    "ninjaone",
    `ninjaone:organization:${companyId}`,
    "organization.create",
    actorUserId,
    {
      requestSummary: { name: co.name },
      perform: async () => {
        const org = await resolved.client.createOrganization({ name: co.name, locations: [{ name: "Main Office", address: address || undefined }] });
        return { externalId: String(org.id), summary: { id: org.id, name: org.name }, raw: org };
      },
      reconcile: async () => {
        for (let after = 0, page = 0; page < 200; page++) {
          const batch = await resolved.client.listOrganizations(after, 200);
          const hit = batch.find((o) => o.name.trim().toLowerCase() === co.name.trim().toLowerCase());
          if (hit) return { externalId: String(hit.id), summary: { id: hit.id, name: hit.name }, raw: hit };
          if (batch.length < 200) break;
          after = batch[batch.length - 1].id;
        }
        return null;
      },
    },
  );
  const orgId = result.externalId;
  const now = new Date();
  const raw = result.raw ?? { id: Number(orgId), name: co.name };
  await db
    .insert(ninjaOrganizations)
    .values({ orgId, name: raw.name, normalizedName: normalizeCompanyName(raw.name), description: raw.description ?? null, nodeApprovalMode: raw.nodeApprovalMode ?? null, externalStatus: "active", raw: raw as Record<string, unknown>, fetchedAt: now, updatedAt: now })
    .onConflictDoNothing();
  try {
    for (const l of await resolved.client.listLocations(Number(orgId))) {
      await db.insert(ninjaLocations).values({ locationId: String(l.id), orgId, name: l.name, address: l.address ?? null, externalStatus: "active", raw: l as Record<string, unknown>, fetchedAt: now }).onConflictDoNothing();
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), orgId }, "could not mirror locations of the new NinjaOne organisation; the hourly sync will");
  }
  if (!(await getLink("ninjaone", "company", companyId))) {
    await createLink({ provider: "ninjaone", entityType: "company", localId: companyId, externalId: orgId, externalName: raw.name, externalType: "organization", source: "created_by_crm" }, actorUserId);
  }
  await logActivity({ type: "device", companyId, title: `Created NinjaOne organisation "${raw.name}"`, actorUserId, source: "ninjaone" });
  await audit({ actorUserId, action: "ninjaone.organization.create", entityType: "company", entityId: companyId, details: { orgId, name: raw.name } });
  return orgId;
}

/**
 * Post-commit hook for "a company became a customer". Never throws: the
 * company change that triggered it has already been committed. Does nothing
 * unless the NinjaOne setting is on.
 */
export async function ensureNinjaOrganizationForCustomer(companyId: string, actorUserId: string | null, reason: string): Promise<{ action: "created" | "review" | "skipped" | "failed"; detail?: string }> {
  try {
    const resolved = await getNinjaOneClient();
    if (!resolved) return { action: "skipped", detail: "NinjaOne not configured" };
    if (!resolved.config.autoCreateOrganizations) return { action: "skipped", detail: "auto-create off" };
    const [co] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!co || co.archivedAt || co.status !== "customer") return { action: "skipped", detail: "not an active customer" };
    if (await getLink("ninjaone", "company", companyId)) return { action: "skipped", detail: "already linked" };
    if (resolved.mode === "live" && !(resolved.client as LiveNinjaOneClient).canManage) {
      await logActivity({ type: "sync", companyId, title: "NinjaOne organisation not created automatically: the credential has no Management scope (reconnect NinjaOne with it ticked)", actorUserId, source: "ninjaone" });
      return { action: "skipped", detail: "no management scope" };
    }
    const matches = await likelyNinjaMatches(co.name);
    if (matches.length) {
      const m = matches[0];
      await raiseConflict({
        provider: "ninjaone",
        entityType: "company",
        localId: companyId,
        externalId: m.orgId,
        kind: "ambiguous_match",
        message: `"${co.name}" became a customer (${reason}) but NinjaOne already has "${m.name}". Link it from the NinjaOne page, or create the organisation there if it really is a different business. Nothing was created automatically.`,
        details: { reason, match: m },
      });
      await logActivity({ type: "sync", companyId, title: `NinjaOne organisation not created automatically: "${m.name}" looks like this company; review item raised`, actorUserId, source: "ninjaone" });
      return { action: "review", detail: m.name };
    }
    const actor = actorUserId ?? (await db.select({ id: user.id }).from(user).where(eq(user.role, "admin")).limit(1))[0]?.id ?? null;
    if (!actor) return { action: "skipped", detail: "no actor" };
    await createNinjaOrganizationForCompany(companyId, actor);
    return { action: "created" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, companyId }, "automatic NinjaOne organisation creation failed");
    await logActivity({ type: "sync", companyId, title: `NinjaOne organisation could not be created automatically: ${msg}`, actorUserId, source: "ninjaone" }).catch(() => undefined);
    return { action: "failed", detail: msg };
  }
}

export async function importAllOrganizations(actorUserId: string) {
  const orgs = await db.select({ orgId: ninjaOrganizations.orgId }).from(ninjaOrganizations).where(eq(ninjaOrganizations.externalStatus, "active")).orderBy(asc(ninjaOrganizations.name));
  const results: NinjaImportResult[] = [];
  for (const o of orgs) results.push(await importOrganizationAsCompany(o.orgId, actorUserId));
  return { created: results.filter((r) => r.action === "created").length, linked: results.filter((r) => r.action === "linked").length, skipped: results.filter((r) => r.action === "skipped"), results };
}
