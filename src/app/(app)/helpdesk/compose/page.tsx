import { requirePermission } from "@/lib/session";
import { companyOptions } from "@/services/lookups";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { asc, isNull } from "drizzle-orm";
import { getDefaultMailbox, mailboxIsLive } from "@/services/mailbox";
import { PageHeader, Card, EmptyState } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { param } from "@/lib/utils";
import { ComposeForm } from "./compose-form";

export const metadata = { title: "New e-mail" };

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("helpdesk.agent");
  const sp = await searchParams;
  const mailbox = await getDefaultMailbox();
  const enabled = Boolean(
    mailbox && (mailboxIsLive(mailbox) || process.env.DEMO_MODE === "true"),
  );
  const [companies, contactRows] = await Promise.all([
    companyOptions(),
    db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        companyId: contacts.companyId,
        email: contacts.email,
      })
      .from(contacts)
      .where(isNull(contacts.archivedAt))
      .orderBy(asc(contacts.lastName)),
  ]);
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Helpdesk", href: "/helpdesk" },
          { label: "New e-mail" },
        ]}
        title="New e-mail"
        description={`Send from ${mailbox?.address ?? "the support mailbox"} and track the conversation as a ticket. The reference goes in the subject so replies come back to it.`}
      />
      {!enabled ? (
        <EmptyState
          title="No support mailbox connected"
          description="Connect the Microsoft 365 mailbox under Helpdesk → Administration → Support mailbox to send e-mail from the CRM."
          action={
            <ButtonLink href="/helpdesk/admin/mailbox" variant="secondary">
              Mailbox settings
            </ButtonLink>
          }
        />
      ) : (
        <Card className="max-w-4xl">
          {mailbox && !mailboxIsLive(mailbox) && (
            <Alert tone="warn" className="mb-3">
              Demo mailbox: nothing is actually sent.
            </Alert>
          )}
          <ComposeForm
            companies={companies}
            contacts={contactRows.map((c) => ({
              id: c.id,
              name: `${c.firstName} ${c.lastName}`.trim(),
              companyId: c.companyId,
              email: c.email,
            }))}
            defaults={{
              companyId: param(sp, "companyId"),
              contactId: param(sp, "contactId"),
              to: param(sp, "to"),
            }}
            signature={mailbox?.signature ?? null}
          />
        </Card>
      )}
    </>
  );
}
