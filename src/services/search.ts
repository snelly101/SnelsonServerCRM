import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, contacts } from "@/db/schema";

export type SearchHit = {
  type: "company" | "contact";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

/**
 * Global search across companies and contacts. Later phases add
 * opportunities, proposals, invoices and devices to the same result shape.
 */
export async function globalSearch(q: string, limit = 8): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;

  const [companyRows, contactRows] = await Promise.all([
    db
      .select({ id: companies.id, name: companies.name, status: companies.status, city: companies.city })
      .from(companies)
      .where(
        and(
          isNull(companies.archivedAt),
          or(ilike(companies.name, like), ilike(companies.domain, like), ilike(companies.postcode, like), ilike(companies.companyNumber, like)),
        ),
      )
      .orderBy(desc(sql`similarity(${companies.name}, ${term})`))
      .limit(limit),
    db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        companyName: companies.name,
      })
      .from(contacts)
      .innerJoin(companies, eq(companies.id, contacts.companyId))
      .where(
        and(
          isNull(contacts.archivedAt),
          or(ilike(sql`${contacts.firstName} || ' ' || ${contacts.lastName}`, like), ilike(contacts.email, like), ilike(contacts.phone, like), ilike(contacts.mobile, like)),
        ),
      )
      .limit(limit),
  ]);

  return [
    ...companyRows.map<SearchHit>((c) => ({
      type: "company",
      id: c.id,
      title: c.name,
      subtitle: [c.status, c.city].filter(Boolean).join(" · "),
      href: `/companies/${c.id}`,
    })),
    ...contactRows.map<SearchHit>((c) => ({
      type: "contact",
      id: c.id,
      title: `${c.firstName} ${c.lastName}`.trim(),
      subtitle: [c.companyName, c.email].filter(Boolean).join(" · "),
      href: `/contacts/${c.id}`,
    })),
  ];
}
