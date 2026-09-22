import { asc, isNull } from "drizzle-orm";
import { db } from "@/db";
import { companies, sites } from "@/db/schema";
import { requirePermission } from "@/lib/session";
import { listCustomFieldDefs } from "@/services/settings";
import { createContactAction } from "@/actions/contacts";
import { PageHeader, Card } from "@/components/ui/page";
import { ContactForm } from "@/components/contact-form";

export const metadata = { title: "New contact" };

export default async function NewContactPage({ searchParams }: { searchParams: Promise<{ companyId?: string }> }) {
  await requirePermission("contact.write");
  const { companyId } = await searchParams;
  const [companyRows, siteRows, defs] = await Promise.all([
    db.select({ id: companies.id, name: companies.name }).from(companies).where(isNull(companies.archivedAt)).orderBy(asc(companies.name)),
    companyId ? db.select({ id: sites.id, name: sites.name, companyId: sites.companyId }).from(sites).where(isNull(sites.archivedAt)) : Promise.resolve([]),
    listCustomFieldDefs("contact"),
  ]);
  const returnTo = companyId ? `/companies/${companyId}` : undefined;
  return (
    <>
      <PageHeader title="New contact" breadcrumbs={[{ label: "Contacts", href: "/contacts" }, { label: "New" }]} />
      <Card className="max-w-3xl">
        <ContactForm
          action={createContactAction}
          initial={{ companyId }}
          companies={companyRows}
          sites={siteRows.filter((s) => s.companyId === companyId)}
          customFieldDefs={defs}
          cancelHref={returnTo ?? "/contacts"}
          returnTo={returnTo}
        />
      </Card>
    </>
  );
}
