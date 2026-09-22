import Papa from "papaparse";
import { z } from "zod";
import { db } from "@/db";
import { companies, contacts, user } from "@/db/schema";
import { asc, eq, isNull } from "drizzle-orm";
import { companySchema, contactSchema } from "@/lib/validation";
import { createCompany, findDuplicateCompanies } from "./companies";
import { createContact, findDuplicateContacts } from "./contacts";
import { audit } from "@/lib/audit";
import { normalizeCompanyName } from "@/lib/utils";

export const COMPANY_CSV_COLUMNS = [
  "name",
  "status",
  "website",
  "industry",
  "phone",
  "email",
  "companyNumber",
  "vatNumber",
  "addressLine1",
  "addressLine2",
  "city",
  "region",
  "postcode",
  "country",
  "notes",
] as const;

export const CONTACT_CSV_COLUMNS = [
  "companyName",
  "firstName",
  "lastName",
  "email",
  "phone",
  "mobile",
  "jobTitle",
  "roles", // semicolon separated: decision_maker;billing
  "notes",
] as const;

export type ImportRowResult = {
  row: number;
  status: "created" | "skipped" | "error";
  message: string;
};

export type ImportSummary = {
  created: number;
  skipped: number;
  errors: number;
  results: ImportRowResult[];
};

const MAX_ROWS = 5000;

function parseCsv(text: string) {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  if (parsed.errors.length && parsed.data.length === 0) {
    throw new Error(`Could not read the CSV: ${parsed.errors[0]?.message}`);
  }
  if (parsed.data.length > MAX_ROWS) throw new Error(`Too many rows. The limit is ${MAX_ROWS} per import.`);
  return parsed.data;
}

/**
 * Imports companies. Duplicates (by company number, VAT number, domain or
 * exact normalised name) are skipped and reported, never merged.
 */
export async function importCompaniesCsv(text: string, actorUserId: string): Promise<ImportSummary> {
  const rows = parseCsv(text);
  const summary: ImportSummary = { created: 0, skipped: 0, errors: 0, results: [] };
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNum = i + 2; // header is row 1
    const parsed = companySchema.safeParse({
      name: raw.name ?? raw.Name ?? raw.company ?? raw.Company,
      status: (raw.status || "prospect").toLowerCase(),
      website: raw.website,
      industry: raw.industry,
      phone: raw.phone,
      email: raw.email,
      companyNumber: raw.companyNumber ?? raw["company number"],
      vatNumber: raw.vatNumber ?? raw["vat number"],
      addressLine1: raw.addressLine1 ?? raw.address1 ?? raw.address,
      addressLine2: raw.addressLine2 ?? raw.address2,
      city: raw.city ?? raw.town,
      region: raw.region ?? raw.county,
      postcode: raw.postcode,
      country: raw.country,
      notes: raw.notes,
    });
    if (!parsed.success) {
      summary.errors++;
      summary.results.push({ row: rowNum, status: "error", message: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ") });
      continue;
    }
    const dupes = (await findDuplicateCompanies(parsed.data)).filter((d) => d.confidence !== "low");
    if (dupes.length) {
      summary.skipped++;
      summary.results.push({ row: rowNum, status: "skipped", message: `Possible duplicate of "${dupes[0].name}" (${dupes[0].reason.replace("_", " ")})` });
      continue;
    }
    try {
      await createCompany(parsed.data, actorUserId, { skipDuplicateCheck: true });
      summary.created++;
      summary.results.push({ row: rowNum, status: "created", message: parsed.data.name });
    } catch (err) {
      summary.errors++;
      summary.results.push({ row: rowNum, status: "error", message: err instanceof Error ? err.message : "Unknown error" });
    }
  }
  await audit({ actorUserId, action: "company.import", entityType: "company", details: { created: summary.created, skipped: summary.skipped, errors: summary.errors } });
  return summary;
}

export async function importContactsCsv(text: string, actorUserId: string): Promise<ImportSummary> {
  const rows = parseCsv(text);
  const summary: ImportSummary = { created: 0, skipped: 0, errors: 0, results: [] };
  const companyRows = await db.select({ id: companies.id, normalizedName: companies.normalizedName }).from(companies).where(isNull(companies.archivedAt));
  const byName = new Map(companyRows.map((c) => [c.normalizedName, c.id]));

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNum = i + 2;
    const companyName = raw.companyName ?? raw.company ?? raw.Company ?? "";
    const companyId = byName.get(normalizeCompanyName(companyName));
    if (!companyId) {
      summary.errors++;
      summary.results.push({ row: rowNum, status: "error", message: `Company "${companyName}" not found. Import companies first.` });
      continue;
    }
    const roles = (raw.roles ?? "")
      .split(/[;|,]/)
      .map((r) => r.trim().toLowerCase().replace(/\s+/g, "_"))
      .filter(Boolean);
    const parsed = contactSchema.safeParse({
      companyId,
      firstName: raw.firstName ?? raw["first name"],
      lastName: raw.lastName ?? raw["last name"],
      email: raw.email,
      phone: raw.phone,
      mobile: raw.mobile,
      jobTitle: raw.jobTitle ?? raw.title,
      roles,
      notes: raw.notes,
    });
    if (!parsed.success) {
      summary.errors++;
      summary.results.push({ row: rowNum, status: "error", message: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ") });
      continue;
    }
    const dupes = await findDuplicateContacts(parsed.data.email);
    if (dupes.length) {
      summary.skipped++;
      summary.results.push({ row: rowNum, status: "skipped", message: `Email already belongs to ${dupes[0].firstName} ${dupes[0].lastName} at ${dupes[0].companyName}` });
      continue;
    }
    try {
      await createContact(parsed.data, actorUserId, { skipDuplicateCheck: true });
      summary.created++;
      summary.results.push({ row: rowNum, status: "created", message: `${parsed.data.firstName} ${parsed.data.lastName}` });
    } catch (err) {
      summary.errors++;
      summary.results.push({ row: rowNum, status: "error", message: err instanceof Error ? err.message : "Unknown error" });
    }
  }
  await audit({ actorUserId, action: "contact.import", entityType: "contact", details: { created: summary.created, skipped: summary.skipped, errors: summary.errors } });
  return summary;
}

export async function exportCompaniesCsv(): Promise<string> {
  const rows = await db
    .select({
      name: companies.name,
      status: companies.status,
      website: companies.website,
      industry: companies.industry,
      phone: companies.phone,
      email: companies.email,
      companyNumber: companies.companyNumber,
      vatNumber: companies.vatNumber,
      addressLine1: companies.addressLine1,
      addressLine2: companies.addressLine2,
      city: companies.city,
      region: companies.region,
      postcode: companies.postcode,
      country: companies.country,
      owner: user.name,
      createdAt: companies.createdAt,
    })
    .from(companies)
    .leftJoin(user, eq(user.id, companies.ownerUserId))
    .where(isNull(companies.archivedAt))
    .orderBy(asc(companies.name));
  return Papa.unparse(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
}

export async function exportContactsCsv(): Promise<string> {
  const rows = await db
    .select({
      companyName: companies.name,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      mobile: contacts.mobile,
      jobTitle: contacts.jobTitle,
      roles: contacts.roles,
      isPrimary: contacts.isPrimary,
    })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(isNull(contacts.archivedAt))
    .orderBy(asc(companies.name), asc(contacts.lastName));
  return Papa.unparse(rows.map((r) => ({ ...r, roles: r.roles.join(";") })));
}

export const csvUploadSchema = z.object({ text: z.string().min(1, "The file is empty").max(5_000_000) });
