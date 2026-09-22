import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sites } from "@/db/schema";
import { requirePermission } from "@/lib/session";
import { getContact } from "@/services/contacts";
import { listCustomFieldDefs } from "@/services/settings";
import { updateContactAction } from "@/actions/contacts";
import { PageHeader, Card } from "@/components/ui/page";
import { ContactForm } from "@/components/contact-form";
import { fullName } from "@/lib/utils";

export const metadata = { title: "Edit contact" };

export default async function EditContactPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("contact.write");
  const { id } = await params;
  const contact = await getContact(id);
  if (!contact) notFound();
  const [siteRows, defs] = await Promise.all([
    db.select({ id: sites.id, name: sites.name, companyId: sites.companyId }).from(sites).where(and(eq(sites.companyId, contact.companyId), isNull(sites.archivedAt))),
    listCustomFieldDefs("contact"),
  ]);
  return (
    <>
      <PageHeader title={`Edit ${fullName(contact)}`} breadcrumbs={[{ label: "Contacts", href: "/contacts" }, { label: fullName(contact), href: `/contacts/${id}` }, { label: "Edit" }]} />
      <Card className="max-w-3xl">
        <ContactForm
          action={updateContactAction.bind(null, id)}
          initial={contact}
          companies={[{ id: contact.companyId, name: contact.companyName }]}
          sites={siteRows}
          customFieldDefs={defs}
          cancelHref={`/contacts/${id}`}
        />
      </Card>
    </>
  );
}
