import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { bpProposals, companies, contacts, contracts, opportunities } from "@/db/schema";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { getAppSettings } from "@/lib/settings";
import { getBetterProposalsClient } from "@/connectors/betterproposals";
import type { BpProposal } from "@/connectors/betterproposals/types";
import { createLink, getLink, getLinkByExternal, raiseConflict, recordInboundEvent, runOutbound, runSync, setConnectionConfig, setCredentials, updateConnection, getConnection, markEventProcessed } from "./integrations";
import { markWon } from "./opportunities";
import { draftContractFromOpportunity } from "./contracts";
import { findDuplicateCompanies } from "./companies";
import { fullName, normalizeCompanyName } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------
export async function connectBetterProposals(apiToken: string, actorUserId: string) {
  const { LiveBetterProposalsClient } = await import("@/connectors/betterproposals");
  const client = new LiveBetterProposalsClient(apiToken);
  const test = await client.testConnection();
  if (!test.ok) throw new ActionError(`Could not verify the token: ${test.error}`);
  await setCredentials("betterproposals", { apiToken }, actorUserId, { status: "connected", externalAccountName: test.accountName, externalAccountId: test.accountId, lastTestedAt: new Date(), lastError: null, consecutiveFailures: 0, pausedUntil: null });
  await setConnectionConfig("betterproposals", { taxLabel: test.taxLabel, taxAmount: test.taxAmount }, actorUserId);
  return test;
}

export async function testBetterProposals(actorUserId: string) {
  const resolved = await getBetterProposalsClient();
  if (!resolved) throw new ActionError("Better Proposals is not configured.");
  const test = await resolved.client.testConnection();
  if (resolved.mode === "live") {
    await updateConnection("betterproposals", test.ok ? { status: "connected", externalAccountName: test.accountName, externalAccountId: test.accountId, lastTestedAt: new Date(), lastError: null } : { status: "error", lastTestedAt: new Date(), lastError: test.error });
  }
  await audit({ actorUserId, action: "integration.test", entityType: "integration", entityId: "betterproposals", details: { ok: test.ok, mode: resolved.mode } });
  return { ...test, mode: resolved.mode };
}

export async function listBpTemplates() {
  const resolved = await getBetterProposalsClient();
  if (!resolved) return { mode: null, templates: [] as { id: string; name: string; description: string | null; isDefault: boolean }[] };
  return { mode: resolved.mode, templates: await resolved.client.listTemplates() };
}

export async function listBpMergeTags() {
  const resolved = await getBetterProposalsClient();
  if (!resolved) return [];
  return resolved.client.listMergeTags();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export async function listProposals(p: { q?: string; status?: string; companyId?: string; opportunityId?: string; unlinked?: boolean; page?: number; pageSize?: number }) {
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 25, 200);
  const conds = [
    p.q ? sql`(${bpProposals.subjectLine} ilike ${"%" + p.q + "%"} or ${bpProposals.externalCompanyName} ilike ${"%" + p.q + "%"} or ${companies.name} ilike ${"%" + p.q + "%"})` : undefined,
    p.status && p.status !== "all" ? eq(bpProposals.status, p.status as "draft") : undefined,
    p.companyId ? eq(bpProposals.companyId, p.companyId) : undefined,
    p.opportunityId ? eq(bpProposals.opportunityId, p.opportunityId) : undefined,
    p.unlinked ? isNull(bpProposals.companyId) : undefined,
  ].filter(Boolean);
  const where = conds.length ? and(...(conds as [ReturnType<typeof eq>])) : undefined;
  const base = () => db.select({ proposal: bpProposals, companyName: companies.name, opportunityTitle: opportunities.title }).from(bpProposals).leftJoin(companies, eq(companies.id, bpProposals.companyId)).leftJoin(opportunities, eq(opportunities.id, bpProposals.opportunityId));
  const [rows, [{ total }]] = await Promise.all([
    base().where(where).orderBy(desc(sql`coalesce(${bpProposals.signedAt}, ${bpProposals.sentAt}, ${bpProposals.createdAtExternal}, ${bpProposals.fetchedAt})`)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(bpProposals).leftJoin(companies, eq(companies.id, bpProposals.companyId)).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.proposal, companyName: r.companyName, opportunityTitle: r.opportunityTitle })), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function proposalsForOpportunity(opportunityId: string) {
  return db.select().from(bpProposals).where(eq(bpProposals.opportunityId, opportunityId)).orderBy(desc(bpProposals.fetchedAt));
}

export async function proposalCounts() {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      sent: sql<number>`count(*) filter (where status in ('sent','opened'))`.mapWith(Number),
      signed: sql<number>`count(*) filter (where status in ('signed','paid'))`.mapWith(Number),
      unlinked: sql<number>`count(*) filter (where company_id is null)`.mapWith(Number),
    })
    .from(bpProposals);
  return row;
}

// ---------------------------------------------------------------------------
// Create a proposal for an opportunity (idempotent per opportunity + version)
// ---------------------------------------------------------------------------
export async function createProposalForOpportunity(
  input: { opportunityId: string; templateId?: string; contactIds: string[]; mergeTags: Record<string, string>; version?: number },
  actorUserId: string,
) {
  const resolved = await getBetterProposalsClient();
  if (!resolved) throw new ActionError("Better Proposals is not configured. Connect it on the Integrations page.");
  const [opp] = await db.select({ opp: opportunities, company: companies }).from(opportunities).innerJoin(companies, eq(companies.id, opportunities.companyId)).where(eq(opportunities.id, input.opportunityId)).limit(1);
  if (!opp) throw new ActionError("Opportunity not found.");
  if (opp.opp.status !== "open") throw new ActionError("Only open opportunities can have proposals created.");
  const people = input.contactIds.length ? await db.select().from(contacts).where(sql`${contacts.id} in ${input.contactIds}`) : [];
  if (people.length === 0) throw new ActionError("Choose at least one contact to receive the proposal.", { contactIds: ["Required"] });
  const missingEmail = people.filter((c) => !c.email);
  if (missingEmail.length) throw new ActionError(`${fullName(missingEmail[0])} has no email address. Add one before creating the proposal.`);
  const settings = await getAppSettings();

  // Resolve the Better Proposals company: existing link, else create there and link.
  const companyLink = await getLink("betterproposals", "company", opp.company.id);
  let bpCompanyRef = companyLink?.externalId;
  if (!bpCompanyRef) {
    const { result } = await runOutbound("betterproposals", `bp:company:${opp.company.id}`, "company.create", actorUserId, {
      requestSummary: { name: opp.company.name },
      perform: async () => {
        const created = await resolved.client.createCompany(opp.company.name);
        return { externalId: created.id, summary: { name: created.name } };
      },
      reconcile: async () => {
        // Look for an existing BP company with the same normalised name before creating a second one.
        for (let page = 1; page <= 10; page++) {
          const list = await resolved.client.listCompanies(page, 50);
          const hit = list.find((c) => normalizeCompanyName(c.name) === normalizeCompanyName(opp.company.name));
          if (hit) return { externalId: hit.id, summary: { name: hit.name, reconciled: true } };
          if (list.length < 50) break;
        }
        return null;
      },
    });
    bpCompanyRef = result.externalId;
    await createLink({ provider: "betterproposals", entityType: "company", localId: opp.company.id, externalId: bpCompanyRef, externalName: opp.company.name, source: "created_by_crm" }, actorUserId);
  }

  const version = input.version ?? 1;
  const key = `bp:proposal:${input.opportunityId}:${version}`;
  const templateId = input.templateId ?? resolved.config.defaultTemplateId;
  const mergeTags = Object.entries(input.mergeTags).filter(([, v]) => v !== "").map(([tag, value]) => ({ tag, value }));
  const { result, reused } = await runOutbound("betterproposals", key, "proposal.create", actorUserId, {
    requestSummary: { opportunityId: input.opportunityId, templateId, contacts: people.map((c) => c.email), mergeTags: mergeTags.map((m) => m.tag) },
    perform: async () => {
      const created = await resolved.client.createProposal({
        company: bpCompanyRef!,
        templateId,
        currency: settings.currency,
        contacts: people.map((c, i) => ({ firstName: c.firstName, surname: c.lastName || "-", email: c.email!, signature: i === 0 })),
        mergeTags,
      });
      return { externalId: created.externalId, summary: { viewUrl: created.viewUrl } };
    },
  });

  // Mirror + link
  const fetched = (await resolved.client.getProposal(result.externalId)) ?? null;
  const now = new Date();
  await db
    .insert(bpProposals)
    .values({
      externalId: result.externalId,
      companyId: opp.company.id,
      opportunityId: input.opportunityId,
      contactId: people[0].id,
      subjectLine: fetched?.subjectLine ?? opp.opp.title,
      externalCompanyName: fetched?.companyName ?? opp.company.name,
      externalCompanyId: bpCompanyRef,
      templateId: templateId ?? null,
      status: fetched?.status ?? "draft",
      currencyCode: fetched?.currencyCode ?? settings.currency,
      viewUrl: fetched?.viewUrl ?? (result.summary?.viewUrl as string | undefined) ?? null,
      previewUrl: fetched?.previewUrl ?? null,
      createdAtExternal: fetched?.createdAt ?? now,
      raw: fetched?.raw ?? {},
      fetchedAt: now,
    })
    .onConflictDoUpdate({ target: bpProposals.externalId, set: { opportunityId: input.opportunityId, companyId: opp.company.id, fetchedAt: now } });
  await createLink({ provider: "betterproposals", entityType: "opportunity", localId: input.opportunityId, externalId: result.externalId, externalName: fetched?.subjectLine ?? opp.opp.title, externalUrl: fetched?.viewUrl ?? undefined, source: "created_by_crm" }, actorUserId).catch(() => undefined);
  if (!reused) {
    await audit({ actorUserId, action: "proposal.create", entityType: "opportunity", entityId: input.opportunityId, details: { externalId: result.externalId, templateId, mode: resolved.mode } });
    await logActivity({ type: "proposal", companyId: opp.company.id, entityType: "opportunity", entityId: input.opportunityId, title: `Proposal created in Better Proposals${resolved.mode === "demo" ? " (DEMO)" : ""}: ${fetched?.subjectLine ?? opp.opp.title}`, actorUserId, source: "betterproposals" });
  }
  return { externalId: result.externalId, viewUrl: fetched?.viewUrl ?? null, reused, mode: resolved.mode };
}

/** Link an existing Better Proposals proposal (already mirrored) to an opportunity. */
export async function linkProposalToOpportunity(externalId: string, opportunityId: string, actorUserId: string) {
  const [p] = await db.select().from(bpProposals).where(eq(bpProposals.externalId, externalId)).limit(1);
  if (!p) throw new ActionError("Proposal not found. Run a sync first.");
  const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId)).limit(1);
  if (!opp) throw new ActionError("Opportunity not found.");
  await db.transaction(async (tx) => {
    await tx.update(bpProposals).set({ opportunityId, companyId: opp.companyId, updatedAt: new Date() }).where(eq(bpProposals.id, p.id));
    await createLink({ provider: "betterproposals", entityType: "opportunity", localId: opportunityId, externalId, externalName: p.subjectLine ?? undefined, externalUrl: p.viewUrl ?? undefined, source: "manual" }, actorUserId, tx);
    await audit({ actorUserId, action: "proposal.link", entityType: "opportunity", entityId: opportunityId, details: { externalId } }, tx);
    await logActivity({ type: "proposal", companyId: opp.companyId, entityType: "opportunity", entityId: opportunityId, title: `Proposal linked: ${p.subjectLine ?? externalId}`, actorUserId, source: "betterproposals" }, tx);
  });
  // If it is already signed, run acceptance now.
  if (p.status === "signed" || p.status === "paid") await processAcceptance(externalId, null);
}

export async function linkProposalToCompany(externalId: string, companyId: string, actorUserId: string) {
  await db.update(bpProposals).set({ companyId, updatedAt: new Date() }).where(eq(bpProposals.externalId, externalId));
  await audit({ actorUserId, action: "proposal.link_company", entityType: "company", entityId: companyId, details: { externalId } });
}

// ---------------------------------------------------------------------------
// Polling sync
// ---------------------------------------------------------------------------
export async function syncProposals(trigger: "schedule" | "manual", actorUserId?: string | null) {
  const resolved = await getBetterProposalsClient();
  if (!resolved) return null;
  return runSync(
    "betterproposals",
    "proposals.poll",
    trigger,
    async ({ counters, fail }) => {
      // Pull all proposals page by page; the list endpoints already carry status and dates.
      const seen = new Map<string, BpProposal>();
      for (let page = 1; page <= 200; page++) {
        const batch = await resolved.client.listProposals("all", page, 50);
        for (const p of batch) seen.set(p.externalId, p);
        if (batch.length < 50) break;
      }
      // The "all" list may omit signed/opened details; overlay the status-specific lists.
      for (const filter of ["opened", "signed", "paid"] as const) {
        for (let page = 1; page <= 50; page++) {
          const batch = await resolved.client.listProposals(filter, page, 50);
          for (const p of batch) seen.set(p.externalId, mergeProposal(seen.get(p.externalId), p));
          if (batch.length < 50) break;
        }
      }
      counters.fetched = seen.size;
      const accepted: string[] = [];
      for (const p of seen.values()) {
        try {
          const outcome = await upsertMirror(p);
          if (outcome === "created") counters.created++;
          else if (outcome === "updated") counters.updated++;
          else counters.skipped++;
          if (p.status === "signed" || p.status === "paid") accepted.push(p.externalId);
        } catch (err) {
          await fail(err instanceof Error ? err.message : String(err), { externalId: p.externalId });
        }
      }
      for (const id of accepted) {
        try {
          await processAcceptance(id, null);
        } catch (err) {
          await fail(`Acceptance handling failed: ${err instanceof Error ? err.message : String(err)}`, { externalId: id });
        }
      }
      return `${seen.size} proposals checked${resolved.mode === "demo" ? " (DEMO data)" : ""}`;
    },
    actorUserId,
  );
}

function mergeProposal(a: BpProposal | undefined, b: BpProposal): BpProposal {
  if (!a) return b;
  const rank = { draft: 0, unknown: 0, sent: 1, opened: 2, signed: 3, paid: 4 };
  return {
    ...a,
    ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null && v !== undefined)),
    status: rank[b.status] >= rank[a.status] ? b.status : a.status,
    raw: { ...a.raw, ...b.raw },
  } as BpProposal;
}

/** Writes the mirror row, records status transitions as inbound events, posts timeline entries. */
async function upsertMirror(p: BpProposal): Promise<"created" | "updated" | "unchanged"> {
  const [existing] = await db.select().from(bpProposals).where(eq(bpProposals.externalId, p.externalId)).limit(1);
  const now = new Date();
  // Resolve company/opportunity: keep existing links; else use CRM ids the proposal carries; else match by BP company link.
  let companyId = existing?.companyId ?? null;
  let opportunityId = existing?.opportunityId ?? null;
  if (!opportunityId) {
    const oppLink = await getLinkByExternal("betterproposals", "opportunity", p.externalId);
    if (oppLink) opportunityId = oppLink.localId;
    else if (p.opportunityCrmId) {
      const [o] = await db.select({ id: opportunities.id, companyId: opportunities.companyId }).from(opportunities).where(eq(opportunities.id, p.opportunityCrmId)).limit(1);
      if (o) {
        opportunityId = o.id;
        companyId ??= o.companyId;
      }
    }
  }
  if (!companyId && opportunityId) {
    const [o] = await db.select({ companyId: opportunities.companyId }).from(opportunities).where(eq(opportunities.id, opportunityId)).limit(1);
    companyId = o?.companyId ?? null;
  }
  if (!companyId && p.companyCrmId) {
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, p.companyCrmId)).limit(1);
    companyId = c?.id ?? null;
  }
  if (!companyId && p.raw.CompanyID) {
    const link = await getLinkByExternal("betterproposals", "company", String(p.raw.CompanyID));
    if (link) companyId = link.localId;
  }
  if (!companyId && p.companyName) {
    // Suggest, never auto-link on name alone: a single exact normalised-name match becomes a conflict for review.
    const dupes = await findDuplicateCompanies({ name: p.companyName });
    const exact = dupes.filter((d) => d.reason === "exact_name");
    if (exact.length >= 1) {
      await raiseConflict({ provider: "betterproposals", entityType: "company", externalId: p.externalId, kind: "unmapped", message: `Proposal "${p.subjectLine ?? p.externalId}" for "${p.companyName}" looks like ${exact.map((d) => d.name).join(" / ")} but is not linked. Link it from the Proposals page.`, details: { candidates: exact.map((d) => d.id) } });
    }
  }

  const values = {
    externalId: p.externalId,
    companyId,
    opportunityId,
    subjectLine: p.subjectLine,
    externalCompanyName: p.companyName,
    externalCompanyId: p.raw.CompanyID ? String(p.raw.CompanyID) : (existing?.externalCompanyId ?? null),
    status: p.status,
    currencyCode: p.currencyCode,
    oneOffTotal: p.oneOffTotal === null ? null : String(p.oneOffTotal),
    monthlyTotal: p.monthlyTotal === null ? null : String(p.monthlyTotal),
    quarterlyTotal: p.quarterlyTotal === null ? null : String(p.quarterlyTotal),
    annualTotal: p.annualTotal === null ? null : String(p.annualTotal),
    viewUrl: p.viewUrl,
    previewUrl: p.previewUrl,
    createdAtExternal: p.createdAt,
    sentAt: p.sentAt,
    openedAt: p.openedAt,
    signedAt: p.signedAt,
    signedBy: p.signedBy,
    paidAt: p.paidAt,
    raw: p.raw,
    fetchedAt: now,
    updatedAt: now,
  };
  if (!existing) {
    await db.insert(bpProposals).values(values);
    if (companyId) await logActivity({ type: "proposal", companyId, entityType: "opportunity", entityId: opportunityId, title: `Proposal ${p.status}: ${p.subjectLine ?? p.externalId}`, source: "betterproposals" });
    return "created";
  }
  const changed = existing.status !== p.status || String(existing.signedAt?.getTime() ?? "") !== String(p.signedAt?.getTime() ?? "") || existing.companyId !== companyId || existing.opportunityId !== opportunityId || existing.monthlyTotal !== values.monthlyTotal || existing.oneOffTotal !== values.oneOffTotal;
  await db.update(bpProposals).set(changed ? values : { fetchedAt: now, raw: p.raw }).where(eq(bpProposals.id, existing.id));
  if (existing.status !== p.status) {
    // Status transition = one inbound event, processed once.
    const eventId = `proposal:${p.externalId}:${p.status}`;
    const evId = await recordInboundEvent("betterproposals", eventId, `proposal.${p.status}`, { from: existing.status, to: p.status }, p.externalId);
    if (evId) {
      if (companyId) await logActivity({ type: "proposal", companyId, entityType: "opportunity", entityId: opportunityId, title: `Proposal ${p.status}${p.status === "signed" && p.signedBy ? ` by ${p.signedBy}` : ""}: ${p.subjectLine ?? p.externalId}`, source: "betterproposals" });
      await markEventProcessed(evId);
    }
  }
  return changed ? "updated" : "unchanged";
}

/**
 * Acceptance workflow, run at most once per proposal:
 * mark the linked opportunity won, create onboarding (keyed by proposal id),
 * draft a contract, and stamp the contract with the proposal id.
 */
export async function processAcceptance(externalId: string, actorUserId: string | null) {
  const result = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(bpProposals).where(eq(bpProposals.externalId, externalId)).for("update");
    if (!p) return null;
    if (p.acceptanceProcessedAt) return { already: true as const, opportunityId: p.opportunityId };
    if (!(p.status === "signed" || p.status === "paid")) return null;
    if (!p.opportunityId) {
      await raiseConflict({ provider: "betterproposals", entityType: "opportunity", externalId, kind: "unmapped", message: `Signed proposal "${p.subjectLine ?? externalId}" is not linked to an opportunity, so it could not be marked won. Link it from the Proposals page.` });
      return null;
    }
    const { onboardingId, alreadyWon } = await markWon(p.opportunityId, actorUserId, { createOnboarding: true, onboardingSourceKey: `proposal:${externalId}`, source: "betterproposals" }, tx);
    const contractId = await draftContractFromOpportunity(p.opportunityId, actorUserId, tx);
    await tx.update(contracts).set({ externalProposalId: externalId, updatedAt: new Date() }).where(and(eq(contracts.id, contractId), isNull(contracts.externalProposalId)));
    await tx.update(bpProposals).set({ acceptanceProcessedAt: new Date(), updatedAt: new Date() }).where(eq(bpProposals.id, p.id));
    await audit({ actorUserId, actorType: actorUserId ? "user" : "system", action: "proposal.accepted", entityType: "opportunity", entityId: p.opportunityId, details: { externalId, onboardingId, contractId, alreadyWon } }, tx);
    await logActivity({ type: "proposal", companyId: p.companyId, entityType: "opportunity", entityId: p.opportunityId, title: `Proposal accepted${p.signedBy ? ` by ${p.signedBy}` : ""} — opportunity won, onboarding started, contract drafted`, source: "betterproposals" }, tx);
    return { already: false as const, opportunityId: p.opportunityId, onboardingId, contractId };
  });
  return result;
}

export async function bpConnectionSummary() {
  const conn = await getConnection("betterproposals");
  const resolved = await getBetterProposalsClient();
  return { ...conn, credentialsEnc: undefined, mode: resolved?.mode ?? (conn.mode as "live" | "demo"), configured: Boolean(resolved), demo: resolved?.mode === "demo" };
}
