import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, Archive } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getContact } from "@/services/contacts";
import { listCustomFieldDefs } from "@/services/settings";
import { getAppSettings } from "@/lib/settings";
import { archiveContactAction } from "@/actions/contacts";
import { PageHeader, Card, DescriptionList } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge, ROLE_LABELS_CONTACT } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { CustomFieldsDisplay } from "@/components/custom-fields";
import { Alert } from "@/components/ui/alert";
import { fmtDate } from "@/lib/format";
import { fullName } from "@/lib/utils";
import { listTickets } from "@/services/helpdesk";
import { TicketTable } from "@/components/helpdesk/ticket-table";

export default async function ContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await requirePermission("contact.read");
  const { id } = await params;
  const [contact, defs, settings, contactTickets] = await Promise.all([
    getContact(id),
    listCustomFieldDefs("contact"),
    getAppSettings(),
    can(me.role, "helpdesk.read")
      ? listTickets({ contactId: id, view: "all", pageSize: 25 })
      : Promise.resolve(null),
  ]);
  if (!contact) notFound();
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Contacts", href: "/contacts" },
          { label: fullName(contact) },
        ]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {fullName(contact)}
            {contact.isPrimary && <Badge tone="green">primary</Badge>}
            {contact.roles.map((r) => (
              <Badge key={r}>{ROLE_LABELS_CONTACT[r]}</Badge>
            ))}
          </span>
        }
        description={
          <>
            {contact.jobTitle && <>{contact.jobTitle} at </>}
            <Link
              href={`/companies/${contact.companyId}`}
              className="text-brand-700 hover:underline"
            >
              {contact.companyName}
            </Link>
          </>
        }
        actions={
          can(me.role, "contact.write") && (
            <>
              <ButtonLink href={`/contacts/${id}/edit`} variant="secondary">
                <Pencil className="h-4 w-4" /> Edit
              </ButtonLink>
              {can(me.role, "contact.delete") && !contact.archivedAt && (
                <ConfirmButton
                  variant="danger-outline"
                  action={archiveContactAction.bind(
                    null,
                    id,
                    contact.companyId,
                  )}
                  title={`Archive ${fullName(contact)}?`}
                  description="The contact is hidden from lists but kept for history."
                  confirmLabel="Archive"
                >
                  <Archive className="h-4 w-4" /> Archive
                </ConfirmButton>
              )}
            </>
          )
        }
      />
      {contact.archivedAt && (
        <Alert tone="warn" className="mb-4">
          This contact was archived on {fmtDate(contact.archivedAt, settings)}.
        </Alert>
      )}
      <Card title="Details" className="max-w-3xl">
        <DescriptionList
          items={[
            {
              label: "Email",
              value: contact.email ? (
                <a href={`mailto:${contact.email}`} className="hover:underline">
                  {contact.email}
                </a>
              ) : null,
            },
            { label: "Phone", value: contact.phone },
            { label: "Mobile", value: contact.mobile },
            { label: "Site", value: contact.siteName },
            { label: "Created", value: fmtDate(contact.createdAt, settings) },
            { label: "Updated", value: fmtDate(contact.updatedAt, settings) },
          ]}
        />
        {defs.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <CustomFieldsDisplay defs={defs} values={contact.customFields} />
          </div>
        )}
        {contact.notes && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Notes
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
              {contact.notes}
            </p>
          </div>
        )}
      </Card>
      {contactTickets && (
        <Card
          title={`Helpdesk tickets (${contactTickets.total})`}
          padded={false}
          className="mt-4 max-w-5xl"
          actions={
            can(me.role, "helpdesk.agent") ? (
              <span className="flex gap-2">
                <ButtonLink
                  href={`/helpdesk/compose?companyId=${contact.companyId}&contactId=${id}`}
                  size="sm"
                  variant="secondary"
                >
                  E-mail
                </ButtonLink>
                <ButtonLink
                  href={`/helpdesk/tickets/new?companyId=${contact.companyId}&contactId=${id}`}
                  size="sm"
                  variant="secondary"
                >
                  New ticket
                </ButtonLink>
              </span>
            ) : undefined
          }
        >
          <TicketTable
            rows={contactTickets.rows}
            canManage={false}
            columns={[
              "reference",
              "subject",
              "status",
              "priority",
              "assignee",
              "updated",
            ]}
            agents={[]}
            teams={[]}
          />
        </Card>
      )}
    </>
  );
}
