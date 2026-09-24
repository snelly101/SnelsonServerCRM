import { requirePermission } from "@/lib/session";
import { listCategories, listTeams } from "@/services/helpdesk";
import { listOwners } from "@/services/companies";
import { companyOptions, contactOptions } from "@/services/lookups";
import { listCustomFieldDefs } from "@/services/settings";
import { PageHeader, Card } from "@/components/ui/page";
import { param } from "@/lib/utils";
import { NewTicketForm } from "./new-form";

export const metadata = { title: "New ticket" };

export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("helpdesk.agent");
  const sp = await searchParams;
  const [contacts, companies, agents, teams, categories, defs] =
    await Promise.all([
      contactOptions(),
      companyOptions(),
      listOwners(),
      listTeams(),
      listCategories(),
      listCustomFieldDefs("ticket"),
    ]);
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Helpdesk", href: "/helpdesk" },
          { label: "Tickets", href: "/helpdesk/tickets" },
          { label: "New" },
        ]}
        title="New ticket"
        description="Log something reported by phone, in person or on behalf of a customer. E-mailed requests create tickets on their own."
      />
      <Card className="max-w-4xl">
        <NewTicketForm
          contacts={contacts}
          companies={companies}
          agents={agents}
          teams={teams
            .filter((t) => t.active)
            .map((t) => ({ id: t.id, name: t.name }))}
          categories={categories
            .filter((c) => c.active)
            .map((c) => ({
              id: c.id,
              name: c.name,
              children: c.children
                .filter((s) => s.active)
                .map((s) => ({ id: s.id, name: s.name })),
            }))}
          customFields={defs.map((d) => ({
            key: d.key,
            label: d.label,
            type: d.type,
            options: d.options,
            required: d.required,
          }))}
          defaults={{
            companyId: param(sp, "companyId"),
            contactId: param(sp, "contactId"),
          }}
        />
      </Card>
    </>
  );
}
