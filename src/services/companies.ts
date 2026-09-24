import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, count, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { activities, companies, companyTags, contacts, sites, tags, user } from "@/db/schema";
import { audit, diffFields, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { extractDomain, normalizeCompanyName } from "@/lib/utils";
import type { CompanyInput } from "@/lib/validation";

export type CompanyListParams = {
  q?: string;
  status?: string;
  ownerUserId?: string;
  tagId?: string;
  industry?: string;
  includeArchived?: boolean;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

const SORTABLE = {
  name: companies.name,
  status: companies.status,
  industry: companies.industry,
  createdAt: companies.createdAt,
  updatedAt: companies.updatedAt,
} as const;

export function buildCompanyWhere(p: CompanyListParams): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  if (!p.includeArchived) conds.push(isNull(companies.archivedAt));
  if (p.q) {
    const term = `%${p.q}%`;
    conds.push(
      or(
        ilike(companies.name, term),
        ilike(companies.domain, term),
        ilike(companies.email, term),
        ilike(companies.city, term),
        ilike(companies.postcode, term),
        ilike(companies.companyNumber, term),
      ),
    );
  }
  if (p.status && p.status !== "all") conds.push(eq(companies.status, p.status as (typeof companies.status.enumValues)[number]));
  if (p.ownerUserId) conds.push(eq(companies.ownerUserId, p.ownerUserId));
  if (p.industry) conds.push(eq(companies.industry, p.industry));
  if (p.tagId) {
    conds.push(
      sql`exists (select 1 from company_tags ct where ct.company_id = companies.id and ct.tag_id = ${p.tagId})`,
    );
  }
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listCompanies(p: CompanyListParams) {
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 25, 200);
  const where = buildCompanyWhere(p);
  const sortCol = SORTABLE[(p.sort as keyof typeof SORTABLE) ?? "name"] ?? companies.name;
  const order = p.dir === "desc" ? desc(sortCol) : asc(sortCol);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: companies.id,
        name: companies.name,
        status: companies.status,
        industry: companies.industry,
        website: companies.website,
        domain: companies.domain,
        city: companies.city,
        ownerUserId: companies.ownerUserId,
        ownerName: user.name,
        archivedAt: companies.archivedAt,
        updatedAt: companies.updatedAt,
        contactCount: sql<number>`(select count(*) from contacts c where c.company_id = companies.id and c.archived_at is null)`.mapWith(Number),
      })
      .from(companies)
      .leftJoin(user, eq(user.id, companies.ownerUserId))
      .where(where)
      .orderBy(order, asc(companies.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(companies).where(where),
  ]);

  const ids = rows.map((r) => r.id);
  const tagRows = ids.length
    ? await db
        .select({ companyId: companyTags.companyId, id: tags.id, name: tags.name, color: tags.color })
        .from(companyTags)
        .innerJoin(tags, eq(tags.id, companyTags.tagId))
        .where(inArray(companyTags.companyId, ids))
    : [];
  const tagsByCompany = new Map<string, { id: string; name: string; color: string }[]>();
  for (const t of tagRows) {
    const list = tagsByCompany.get(t.companyId) ?? [];
    list.push({ id: t.id, name: t.name, color: t.color });
    tagsByCompany.set(t.companyId, list);
  }

  return {
    rows: rows.map((r) => ({ ...r, tags: tagsByCompany.get(r.id) ?? [] })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getCompany(id: string) {
  const [row] = await db
    .select({ company: companies, ownerName: user.name })
    .from(companies)
    .leftJoin(user, eq(user.id, companies.ownerUserId))
    .where(eq(companies.id, id))
    .limit(1);
  if (!row) return null;
  const [tagRows, siteRows, contactRows] = await Promise.all([
    db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(companyTags)
      .innerJoin(tags, eq(tags.id, companyTags.tagId))
      .where(eq(companyTags.companyId, id)),
    db.select().from(sites).where(and(eq(sites.companyId, id), isNull(sites.archivedAt))).orderBy(desc(sites.isPrimary), asc(sites.name)),
    db
      .select()
      .from(contacts)
      .where(and(eq(contacts.companyId, id), isNull(contacts.archivedAt)))
      .orderBy(desc(contacts.isPrimary), asc(contacts.lastName), asc(contacts.firstName)),
  ]);
  return { ...row.company, ownerName: row.ownerName, tags: tagRows, sites: siteRows, contacts: contactRows };
}

export async function getCompanyTimeline(companyId: string, limit = 50) {
  return db
    .select({
      id: activities.id,
      at: activities.at,
      type: activities.type,
      title: activities.title,
      body: activities.body,
      source: activities.source,
      entityType: activities.entityType,
      entityId: activities.entityId,
      actorName: user.name,
      contactId: activities.contactId,
    })
    .from(activities)
    .leftJoin(user, eq(user.id, activities.actorUserId))
    .where(eq(activities.companyId, companyId))
    .orderBy(desc(activities.at))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Duplicate detection. Never merges automatically; returns candidates with a
// reason so a person can decide. Name alone is only ever a "possible" match.
// ---------------------------------------------------------------------------
export type DuplicateCandidate = {
  id: string;
  name: string;
  status: string;
  reason: "company_number" | "vat_number" | "domain" | "exact_name" | "similar_name";
  confidence: "high" | "medium" | "low";
};

export async function findDuplicateCompanies(
  input: { name: string; website?: string | null; email?: string | null; companyNumber?: string | null; vatNumber?: string | null },
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  const normalized = normalizeCompanyName(input.name);
  const domain = extractDomain(input.website) ?? extractDomain(input.email);
  const out = new Map<string, DuplicateCandidate>();
  const base = excludeId ? ne(companies.id, excludeId) : undefined;
  const add = (rows: { id: string; name: string; status: string }[], reason: DuplicateCandidate["reason"], confidence: DuplicateCandidate["confidence"]) => {
    for (const r of rows) if (!out.has(r.id)) out.set(r.id, { ...r, reason, confidence });
  };
  const sel = { id: companies.id, name: companies.name, status: companies.status };

  if (input.companyNumber) {
    add(await db.select(sel).from(companies).where(and(base, eq(companies.companyNumber, input.companyNumber.trim()))), "company_number", "high");
  }
  if (input.vatNumber) {
    add(await db.select(sel).from(companies).where(and(base, eq(companies.vatNumber, input.vatNumber.trim()))), "vat_number", "high");
  }
  if (domain) {
    add(await db.select(sel).from(companies).where(and(base, eq(companies.domain, domain))), "domain", "high");
  }
  if (normalized) {
    add(await db.select(sel).from(companies).where(and(base, eq(companies.normalizedName, normalized))), "exact_name", "medium");
    add(
      await db
        .select(sel)
        .from(companies)
        .where(and(base, sql`similarity(${companies.normalizedName}, ${normalized}) > 0.6`))
        .limit(5),
      "similar_name",
      "low",
    );
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
function toRow(input: CompanyInput, actorUserId: string | null) {
  return {
    name: input.name,
    normalizedName: normalizeCompanyName(input.name),
    status: input.status,
    website: input.website,
    domain: extractDomain(input.website) ?? extractDomain(input.email),
    industry: input.industry,
    phone: input.phone,
    email: input.email,
    companyNumber: input.companyNumber,
    vatNumber: input.vatNumber,
    ownerUserId: input.ownerUserId ?? actorUserId,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    city: input.city,
    region: input.region,
    postcode: input.postcode,
    country: input.country,
    notes: null,
    customFields: input.customFields,
  };
}

async function syncTags(tx: Tx, companyId: string, tagIds: string[]) {
  await tx.delete(companyTags).where(eq(companyTags.companyId, companyId));
  if (tagIds.length) await tx.insert(companyTags).values(tagIds.map((tagId) => ({ companyId, tagId })));
}

export async function createCompany(input: CompanyInput, actorUserId: string | null, opts?: { skipDuplicateCheck?: boolean }) {
  if (!opts?.skipDuplicateCheck) {
    const dupes = (await findDuplicateCompanies(input)).filter((d) => d.confidence === "high");
    if (dupes.length) {
      throw new ActionError(
        `This looks like a duplicate of "${dupes[0].name}" (matching ${dupes[0].reason.replace("_", " ")}). Open that record or confirm you want to create it anyway.`,
        { _duplicates: dupes.map((d) => d.id) },
      );
    }
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(companies)
      .values({ ...toRow(input, actorUserId), createdByUserId: actorUserId })
      .returning({ id: companies.id });
    await syncTags(tx, row.id, input.tagIds);
    await audit({ actorUserId, action: "company.create", entityType: "company", entityId: row.id, details: { name: input.name, status: input.status } }, tx);
    await logActivity({ type: "system", companyId: row.id, title: `Company created as ${input.status}`, actorUserId }, tx);
    // Free-text notes (CSV import) become a pinned note rather than the legacy column.
    if (input.notes?.trim()) {
      const { createNote } = await import("./notes");
      await createNote(row.id, { title: "Internal notes", body: input.notes.trim(), pinned: true }, actorUserId, tx);
    }
    return row.id;
  });
}

export async function updateCompany(id: string, input: CompanyInput, actorUserId: string) {
  const [before] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  if (!before) throw new ActionError("Company not found.");
  const next = toRow(input, before.ownerUserId);
  const changes = diffFields(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  await db.transaction(async (tx) => {
    await tx.update(companies).set({ ...next, updatedAt: new Date() }).where(eq(companies.id, id));
    await syncTags(tx, id, input.tagIds);
    await audit({ actorUserId, action: "company.update", entityType: "company", entityId: id, details: { changes } }, tx);
    if (changes.status) {
      await logActivity(
        { type: "system", companyId: id, title: `Status changed from ${changes.status.from} to ${changes.status.to}`, actorUserId },
        tx,
      );
    }
  });
}

export async function archiveCompany(id: string, actorUserId: string, restore = false) {
  await db.transaction(async (tx) => {
    await tx.update(companies).set({ archivedAt: restore ? null : new Date(), updatedAt: new Date() }).where(eq(companies.id, id));
    await audit({ actorUserId, action: restore ? "company.restore" : "company.archive", entityType: "company", entityId: id }, tx);
    await logActivity({ type: "system", companyId: id, title: restore ? "Company restored" : "Company archived", actorUserId }, tx);
  });
}

export async function listIndustries() {
  const rows = await db
    .selectDistinct({ industry: companies.industry })
    .from(companies)
    .where(sql`${companies.industry} is not null and ${companies.industry} <> ''`)
    .orderBy(asc(companies.industry));
  return rows.map((r) => r.industry!).filter(Boolean);
}

export async function listTags() {
  return db.select().from(tags).orderBy(asc(tags.name));
}

export async function listOwners() {
  return db.select({ id: user.id, name: user.name }).from(user).where(eq(user.active, true)).orderBy(asc(user.name));
}
