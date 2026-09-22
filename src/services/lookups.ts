import { asc, eq, isNull, and } from "drizzle-orm";
import { db } from "@/db";
import { companies, contacts, sites } from "@/db/schema";
import { listProducts } from "./catalogue";
import type { ProductOption } from "@/components/lines-editor";

/** Small lookups shared by forms. */
export async function companyOptions() {
  return db.select({ id: companies.id, name: companies.name }).from(companies).where(isNull(companies.archivedAt)).orderBy(asc(companies.name));
}

export async function contactOptions(companyId?: string) {
  const rows = await db
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, companyId: contacts.companyId })
    .from(contacts)
    .where(companyId ? and(eq(contacts.companyId, companyId), isNull(contacts.archivedAt)) : isNull(contacts.archivedAt))
    .orderBy(asc(contacts.lastName));
  return rows.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`.trim(), companyId: c.companyId }));
}

export async function siteOptions(companyId: string) {
  return db.select({ id: sites.id, name: sites.name }).from(sites).where(and(eq(sites.companyId, companyId), isNull(sites.archivedAt))).orderBy(asc(sites.name));
}

export async function productOptions(): Promise<ProductOption[]> {
  const rows = await listProducts();
  return rows.map((p) => ({ id: p.id, name: p.name, pricingModel: p.pricingModel, revenueType: p.revenueType, billingFrequency: p.billingFrequency, unitPrice: p.unitPrice, unitCost: p.unitCost, countsAsManagedDevice: p.countsAsManagedDevice }));
}
