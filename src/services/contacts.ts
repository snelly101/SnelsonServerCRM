import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { companies, contacts, sites } from "@/db/schema";
import { audit, diffFields, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { fullName, normalizeEmail } from "@/lib/utils";
import type { ContactInput, SiteInput } from "@/lib/validation";

export type ContactListParams = {
  q?: string;
  companyId?: string;
  role?: string;
  sort?: string;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

export function buildContactWhere(p: ContactListParams): SQL | undefined {
  const conds: (SQL | undefined)[] = [isNull(contacts.archivedAt)];
  if (p.q) {
    const term = `%${p.q}%`;
    conds.push(
      or(
        ilike(sql`${contacts.firstName} || ' ' || ${contacts.lastName}`, term),
        ilike(contacts.email, term),
        ilike(contacts.phone, term),
        ilike(contacts.mobile, term),
        ilike(contacts.jobTitle, term),
        ilike(companies.name, term),
      ),
    );
  }
  if (p.companyId) conds.push(eq(contacts.companyId, p.companyId));
  if (p.role) conds.push(sql`${p.role}::contact_role = any(${contacts.roles})`);
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listContacts(p: ContactListParams) {
  const page = p.page ?? 1;
  const pageSize = Math.min(p.pageSize ?? 25, 200);
  const where = buildContactWhere(p);
  const sortMap = {
    name: sql`${contacts.lastName} || ${contacts.firstName}`,
    company: companies.name,
    email: contacts.email,
    updatedAt: contacts.updatedAt,
  } as const;
  const sortCol = sortMap[(p.sort as keyof typeof sortMap) ?? "name"] ?? sortMap.name;
  const order = p.dir === "desc" ? desc(sortCol) : asc(sortCol);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        phone: contacts.phone,
        mobile: contacts.mobile,
        jobTitle: contacts.jobTitle,
        roles: contacts.roles,
        isPrimary: contacts.isPrimary,
        companyId: contacts.companyId,
        companyName: companies.name,
        updatedAt: contacts.updatedAt,
      })
      .from(contacts)
      .innerJoin(companies, eq(companies.id, contacts.companyId))
      .where(where)
      .orderBy(order, asc(contacts.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(contacts).innerJoin(companies, eq(companies.id, contacts.companyId)).where(where),
  ]);
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getContact(id: string) {
  const [row] = await db
    .select({ contact: contacts, companyName: companies.name, siteName: sites.name })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .leftJoin(sites, eq(sites.id, contacts.siteId))
    .where(eq(contacts.id, id))
    .limit(1);
  return row ? { ...row.contact, companyName: row.companyName, siteName: row.siteName } : null;
}

export async function findDuplicateContacts(email: string | null | undefined, excludeId?: string) {
  const norm = normalizeEmail(email);
  if (!norm) return [];
  const rows = await db
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, companyId: contacts.companyId, companyName: companies.name })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.normalizedEmail, norm), isNull(contacts.archivedAt)));
  return rows.filter((r) => r.id !== excludeId);
}

function toRow(input: ContactInput) {
  return {
    companyId: input.companyId,
    siteId: input.siteId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    normalizedEmail: normalizeEmail(input.email),
    phone: input.phone,
    mobile: input.mobile,
    jobTitle: input.jobTitle,
    roles: input.roles,
    isPrimary: input.isPrimary,
    notes: input.notes,
    customFields: input.customFields,
  };
}

export async function createContact(input: ContactInput, actorUserId: string | null, opts?: { skipDuplicateCheck?: boolean }) {
  if (!opts?.skipDuplicateCheck) {
    const dupes = await findDuplicateContacts(input.email);
    if (dupes.length) {
      throw new ActionError(
        `A contact with that email already exists: ${fullName(dupes[0])} at ${dupes[0].companyName}.`,
        { email: ["Already in use by another contact"] },
      );
    }
  }
  return db.transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.update(contacts).set({ isPrimary: false }).where(eq(contacts.companyId, input.companyId));
    }
    const [row] = await tx.insert(contacts).values(toRow(input)).returning({ id: contacts.id });
    await audit({ actorUserId, action: "contact.create", entityType: "contact", entityId: row.id, details: { name: fullName(input), companyId: input.companyId } }, tx);
    await logActivity({ type: "system", companyId: input.companyId, contactId: row.id, title: `Contact added: ${fullName(input)}`, actorUserId }, tx);
    return row.id;
  });
}

export async function updateContact(id: string, input: ContactInput, actorUserId: string) {
  const [before] = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
  if (!before) throw new ActionError("Contact not found.");
  const dupes = await findDuplicateContacts(input.email, id);
  if (dupes.length) throw new ActionError(`Another contact already uses that email (${fullName(dupes[0])}).`, { email: ["Already in use"] });
  const next = toRow(input);
  const changes = diffFields(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  await db.transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.update(contacts).set({ isPrimary: false }).where(eq(contacts.companyId, input.companyId));
    }
    await tx.update(contacts).set({ ...next, updatedAt: new Date() }).where(eq(contacts.id, id));
    await audit({ actorUserId, action: "contact.update", entityType: "contact", entityId: id, details: { changes } }, tx);
  });
}

export async function archiveContact(id: string, actorUserId: string) {
  const [row] = await db.select({ companyId: contacts.companyId, firstName: contacts.firstName, lastName: contacts.lastName }).from(contacts).where(eq(contacts.id, id)).limit(1);
  if (!row) throw new ActionError("Contact not found.");
  await db.transaction(async (tx) => {
    await tx.update(contacts).set({ archivedAt: new Date(), isPrimary: false, updatedAt: new Date() }).where(eq(contacts.id, id));
    await audit({ actorUserId, action: "contact.archive", entityType: "contact", entityId: id }, tx);
    await logActivity({ type: "system", companyId: row.companyId, title: `Contact archived: ${fullName(row)}`, actorUserId }, tx);
  });
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------
export async function upsertSite(input: SiteInput, actorUserId: string, id?: string) {
  return db.transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.update(sites).set({ isPrimary: false }).where(eq(sites.companyId, input.companyId));
    }
    const values = {
      companyId: input.companyId,
      name: input.name,
      isPrimary: input.isPrimary,
      phone: input.phone,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      city: input.city,
      region: input.region,
      postcode: input.postcode,
      country: input.country,
      notes: input.notes,
    };
    let siteId = id;
    if (id) {
      await tx.update(sites).set({ ...values, updatedAt: new Date() }).where(eq(sites.id, id));
    } else {
      const [row] = await tx.insert(sites).values(values).returning({ id: sites.id });
      siteId = row.id;
    }
    await audit({ actorUserId, action: id ? "site.update" : "site.create", entityType: "site", entityId: siteId, details: { name: input.name } }, tx);
    if (!id) await logActivity({ type: "system", companyId: input.companyId, title: `Site added: ${input.name}`, actorUserId }, tx);
    return siteId!;
  });
}

export async function archiveSite(id: string, actorUserId: string) {
  await db.transaction(async (tx) => {
    await tx.update(sites).set({ archivedAt: new Date(), isPrimary: false, updatedAt: new Date() }).where(eq(sites.id, id));
    await audit({ actorUserId, action: "site.archive", entityType: "site", entityId: id }, tx);
  });
}
