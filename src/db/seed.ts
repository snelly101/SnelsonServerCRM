import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import * as schema from "./schema";
import { normalizeCompanyName, extractDomain, normalizeEmail } from "@/lib/utils";
import { seedSales } from "./seed-sales";

/**
 * Seeds a development database with staff users and realistic sample
 * customers. Safe to re-run: it skips anything that already exists.
 *
 *   npm run db:seed
 *
 * Default sign-in (development only): admin@example.com / Admin12345!
 */
export const SEED_USERS = [
  { email: "admin@example.com", name: "Alex Admin", role: "admin" as const },
  { email: "sales@example.com", name: "Sam Seller", role: "sales" as const },
  { email: "am@example.com", name: "Amira Manager", role: "account_manager" as const },
  { email: "finance@example.com", name: "Fin Ledger", role: "finance" as const },
  { email: "tech@example.com", name: "Terry Tech", role: "technician" as const },
  { email: "readonly@example.com", name: "Robin Reader", role: "read_only" as const },
];
export const SEED_PASSWORD = "Admin12345!";

const COMPANIES = [
  { name: "Harrowgate Dental Practice", status: "customer", industry: "Healthcare", website: "harrowgatedental.co.uk", city: "Harrogate", postcode: "HG1 2AB", companyNumber: "08123456" },
  { name: "Northern Freight Solutions Ltd", status: "customer", industry: "Logistics", website: "northernfreight.co.uk", city: "Leeds", postcode: "LS10 1AA", companyNumber: "09234567" },
  { name: "Bramley & Sons Accountants", status: "customer", industry: "Professional services", website: "bramleyaccountants.co.uk", city: "Bradford", postcode: "BD1 4EF" },
  { name: "Ridgeway Architects LLP", status: "customer", industry: "Architecture", website: "ridgewayarch.com", city: "York", postcode: "YO1 7HU" },
  { name: "Greenfield Primary Academy", status: "customer", industry: "Education", website: "greenfieldacademy.org.uk", city: "Wakefield", postcode: "WF1 3PQ" },
  { name: "Pennine Precision Engineering", status: "prospect", industry: "Manufacturing", website: "pennineprecision.co.uk", city: "Huddersfield", postcode: "HD1 5RT" },
  { name: "The Old Mill Hotel", status: "prospect", industry: "Hospitality", website: "oldmillhotel.co.uk", city: "Skipton", postcode: "BD23 1AA" },
  { name: "Calder Valley Vets", status: "prospect", industry: "Veterinary", website: "caldervalleyvets.co.uk", city: "Halifax", postcode: "HX1 2BB" },
  { name: "Aire Property Management", status: "prospect", industry: "Property", website: "aireproperty.co.uk", city: "Leeds", postcode: "LS1 4DE" },
  { name: "Sheffield Steel Fabrications", status: "former", industry: "Manufacturing", website: "sheffsteelfab.co.uk", city: "Sheffield", postcode: "S1 2GH" },
] as const;

const CONTACTS: Record<string, { first: string; last: string; title: string; roles: ("decision_maker" | "technical" | "billing" | "primary" | "other")[]; primary?: boolean }[]> = {
  "Harrowgate Dental Practice": [
    { first: "Priya", last: "Sharma", title: "Practice Manager", roles: ["decision_maker", "billing"], primary: true },
    { first: "Tom", last: "Reeves", title: "Principal Dentist", roles: ["decision_maker"] },
  ],
  "Northern Freight Solutions Ltd": [
    { first: "Gary", last: "Holmes", title: "Operations Director", roles: ["decision_maker"], primary: true },
    { first: "Lucy", last: "Barnes", title: "Finance Manager", roles: ["billing"] },
    { first: "Dev", last: "Patel", title: "IT Coordinator", roles: ["technical"] },
  ],
  "Bramley & Sons Accountants": [{ first: "Helen", last: "Bramley", title: "Managing Partner", roles: ["decision_maker", "billing"], primary: true }],
  "Ridgeway Architects LLP": [
    { first: "Marcus", last: "Ridgeway", title: "Partner", roles: ["decision_maker"], primary: true },
    { first: "Chloe", last: "Wang", title: "Office Manager", roles: ["billing", "technical"] },
  ],
  "Greenfield Primary Academy": [
    { first: "Sarah", last: "Okafor", title: "Headteacher", roles: ["decision_maker"], primary: true },
    { first: "James", last: "Kelly", title: "Business Manager", roles: ["billing"] },
  ],
  "Pennine Precision Engineering": [{ first: "Ian", last: "Crowther", title: "Managing Director", roles: ["decision_maker"], primary: true }],
  "The Old Mill Hotel": [{ first: "Rebecca", last: "Lister", title: "General Manager", roles: ["decision_maker"], primary: true }],
  "Calder Valley Vets": [{ first: "Anna", last: "Fletcher", title: "Practice Owner", roles: ["decision_maker", "billing"], primary: true }],
  "Aire Property Management": [{ first: "Omar", last: "Hussain", title: "Director", roles: ["decision_maker"], primary: true }],
  "Sheffield Steel Fabrications": [{ first: "Paul", last: "Bright", title: "Owner", roles: ["decision_maker"] }],
};

export async function seed(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema });
  try {
    // Settings
    await db
      .insert(schema.appSettings)
      .values({ id: 1, companyName: "Snelson Server" })
      .onConflictDoUpdate({ target: schema.appSettings.id, set: { companyName: "Snelson Server" } });

    // Users
    const userIds: Record<string, string> = {};
    const passwordHash = await hashPassword(SEED_PASSWORD);
    for (const u of SEED_USERS) {
      const [existing] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, u.email)).limit(1);
      if (existing) {
        userIds[u.email] = existing.id;
        continue;
      }
      const id = randomUUID();
      await db.insert(schema.user).values({ id, email: u.email, name: u.name, role: u.role, emailVerified: true, active: true });
      await db.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: passwordHash });
      userIds[u.email] = id;
    }

    // Tags
    const tagNames: [string, string][] = [
      ["Key account", "purple"],
      ["Microsoft 365", "blue"],
      ["Cyber Essentials", "green"],
      ["Renewal due", "amber"],
    ];
    const tagIds: Record<string, string> = {};
    for (const [name, color] of tagNames) {
      const [row] = await db.insert(schema.tags).values({ name, color }).onConflictDoNothing().returning({ id: schema.tags.id });
      if (row) tagIds[name] = row.id;
      else {
        const all = await db.select().from(schema.tags);
        tagIds[name] = all.find((t) => t.name === name)!.id;
      }
    }

    // Custom fields
    await db
      .insert(schema.customFieldDefs)
      .values([
        { entity: "company", key: "employees", label: "Approx. employees", type: "number", sortOrder: 1 },
        { entity: "company", key: "current_it_provider", label: "Current IT provider", type: "text", sortOrder: 2 },
        { entity: "company", key: "cyber_essentials", label: "Cyber Essentials level", type: "select", options: ["None", "Cyber Essentials", "Cyber Essentials Plus"], sortOrder: 3 },
        { entity: "contact", key: "preferred_contact", label: "Preferred contact method", type: "select", options: ["Email", "Phone", "Teams"], sortOrder: 1 },
      ])
      .onConflictDoNothing();

    // Companies, sites, contacts
    const owners = [userIds["sales@example.com"], userIds["am@example.com"]];
    let i = 0;
    for (const c of COMPANIES) {
      const normalizedName = normalizeCompanyName(c.name);
      const [existing] = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.normalizedName, normalizedName)).limit(1);
      if (existing) continue;
      const ownerUserId = c.status === "customer" ? owners[1] : owners[0];
      const [company] = await db
        .insert(schema.companies)
        .values({
          name: c.name,
          normalizedName,
          status: c.status,
          industry: c.industry,
          website: c.website,
          domain: extractDomain(c.website),
          city: c.city,
          postcode: c.postcode,
          country: "GB",
          companyNumber: "companyNumber" in c ? c.companyNumber : null,
          email: `info@${c.website}`,
          phone: `0113 ${String(4960000 + i * 137).slice(0, 3)} ${String(4960000 + i * 137).slice(3)}`,
          addressLine1: `${10 + i * 7} ${["High Street", "Mill Lane", "Station Road", "Church Street", "Market Place"][i % 5]}`,
          ownerUserId,
          createdByUserId: userIds["admin@example.com"],
          customFields: { employees: 8 + i * 11, cyber_essentials: i % 3 === 0 ? "Cyber Essentials" : "None" },
        })
        .returning({ id: schema.companies.id });
      i++;

      const tagsFor: string[] = [];
      if (c.status === "customer") tagsFor.push(tagIds["Microsoft 365"]);
      if (i % 3 === 0) tagsFor.push(tagIds["Key account"]);
      if (i % 4 === 0) tagsFor.push(tagIds["Cyber Essentials"]);
      if (tagsFor.length) await db.insert(schema.companyTags).values(tagsFor.map((tagId) => ({ companyId: company.id, tagId })));

      const [site] = await db
        .insert(schema.sites)
        .values({ companyId: company.id, name: "Head office", isPrimary: true, addressLine1: `${10 + i * 7} High Street`, city: c.city, postcode: c.postcode, country: "GB" })
        .returning({ id: schema.sites.id });
      if (c.status === "customer" && i % 2 === 0) {
        await db.insert(schema.sites).values({ companyId: company.id, name: "Branch office", city: "Leeds", postcode: "LS2 7EY", country: "GB" });
      }

      for (const p of CONTACTS[c.name] ?? []) {
        const email = `${p.first.toLowerCase()}.${p.last.toLowerCase()}@${c.website}`;
        await db.insert(schema.contacts).values({
          companyId: company.id,
          siteId: site.id,
          firstName: p.first,
          lastName: p.last,
          jobTitle: p.title,
          email,
          normalizedEmail: normalizeEmail(email),
          phone: `01423 ${String(500000 + i * 913).slice(0, 6)}`,
          roles: p.roles,
          isPrimary: Boolean(p.primary),
          customFields: { preferred_contact: "Email" },
        });
      }

      await db.insert(schema.activities).values([
        { type: "system", companyId: company.id, title: `Company created as ${c.status}`, actorUserId: userIds["admin@example.com"] },
        ...(c.status === "customer"
          ? [{ type: "meeting" as const, companyId: company.id, title: "Quarterly account review", body: "Discussed backup coverage and upcoming laptop refresh.", actorUserId: ownerUserId, at: new Date(Date.now() - (i + 3) * 86400000) }]
          : [{ type: "call" as const, companyId: company.id, title: "Discovery call", body: "Currently with an incumbent provider; contract ends in a few months.", actorUserId: ownerUserId, at: new Date(Date.now() - (i + 1) * 86400000) }]),
      ]);
    }
    await seedSales(db, userIds);
    const { seedHelpdesk } = await import("./seed-helpdesk");
    await seedHelpdesk(db, userIds);
    if (process.env.DEMO_MODE === "true") {
      // Mirror the demo Better Proposals data so the Proposals page has content.
      const { syncProposals } = await import("@/services/proposals");
      await syncProposals("manual", userIds["admin@example.com"]).catch((err) => console.warn("demo proposal sync skipped:", err));
      // Mirror demo Xero data and link the obvious customers so Finance has content.
      const { syncXero, linkCompanyToXeroContact } = await import("@/services/xero");
      const { setConnectionConfig } = await import("@/services/integrations");
      await syncXero("manual", userIds["admin@example.com"]).catch((err) => console.warn("demo xero sync skipped:", err));
      await setConnectionConfig("xero", { defaultAccountCode: "201", hardwareAccountCode: "202", defaultTaxType: "OUTPUT2", dueDays: 30 }, userIds["admin@example.com"]);
      const links: [string, string][] = [["Harrowgate Dental Practice", "demo-c-1"], ["Northern Freight Solutions Ltd", "demo-c-2"], ["Ridgeway Architects LLP", "demo-c-3"], ["Greenfield Primary Academy", "demo-c-4"]];
      for (const [name, contactId] of links) {
        const [co] = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.name, name)).limit(1);
        if (co) await linkCompanyToXeroContact(co.id, contactId, userIds["admin@example.com"]).catch(() => undefined);
      }
      // Mirror demo NinjaOne data and link organisations/locations so device counts and discrepancies have content.
      const { syncNinjaOne, linkOrganization, linkLocation } = await import("@/services/ninjaone");
      await syncNinjaOne("manual", userIds["admin@example.com"]).catch((err) => console.warn("demo ninjaone sync skipped:", err));
      const orgLinks: [string, string, [string, string][]][] = [
        ["Harrowgate Dental Practice", "101", [["1011", "Head office"]]],
        ["Northern Freight Solutions Ltd", "102", [["1021", "Head office"], ["1022", "Branch office"]]],
        ["Ridgeway Architects LLP", "103", [["1031", "Head office"]]],
        ["Greenfield Primary Academy", "104", [["1041", "Head office"]]],
        ["Bramley & Sons Accountants", "105", [["1051", "Head office"]]],
      ];
      for (const [name, orgId, locs] of orgLinks) {
        const [co] = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.name, name)).limit(1);
        if (!co) continue;
        await linkOrganization(orgId, co.id, userIds["admin@example.com"]).catch((err) => console.warn("demo ninjaone link skipped:", err));
        for (const [locationId, siteName] of locs) {
          const [site] = await db.select({ id: schema.sites.id }).from(schema.sites).where(and(eq(schema.sites.companyId, co.id), eq(schema.sites.name, siteName))).limit(1);
          if (site) await linkLocation(locationId, site.id, userIds["admin@example.com"]).catch((err) => console.warn("demo ninjaone location link skipped:", err));
        }
      }
      // Mirror demo 20i hosting; exact domain matches link themselves to the seed companies.
      const { syncTwentyI } = await import("@/services/twentyi");
      await syncTwentyI("manual", userIds["admin@example.com"]).catch((err) => console.warn("demo 20i sync skipped:", err));
      // Mirror demo Pax8 subscriptions; domain and exact-name matches link themselves and the licence check runs.
      const { syncPax8 } = await import("@/services/pax8");
      await syncPax8("manual", userIds["admin@example.com"]).catch((err) => console.warn("demo pax8 sync skipped:", err));
    }
    await db.insert(schema.auditLog).values({ actorType: "system", action: "seed.run", entityType: "database", details: { users: SEED_USERS.length, companies: COMPANIES.length } });
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed()
    .then(() => {
      console.log(`Seeded. Sign in as admin@example.com / ${SEED_PASSWORD}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
